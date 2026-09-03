/**
 * Instagram public-profile viewer + downloader, powered by ZylaLabs
 * "Instagram Profile And Media Data API" (#12390).
 *
 * Endpoints used (all GET, Bearer auth, EVERY call consumes paid quota):
 *   23416 get+profile+details?username=        → profile stats/bio/avatar
 *   23417 get+profile+posts+list?username=     → recent posts w/ downloadUrl
 *   23418 get+profile+reels+list?username=     → recent reels w/ downloadUrl
 *         (both lists page by ~12 items — &nextCursor=<data.pagination.nextCursor>)
 *   23423 get+all+24h+stories+of+an+user?username=  → active stories
 *   23420 get+post+details?idOrUrl=            → single post by pasted link
 *   23421 get+reel+details?idOrUrl=            → single reel by pasted link
 *
 * Hard rules:
 *   - Key lives server-side only: ZYLA_IG_API_KEY (falls back to ZYLA_API_KEY —
 *     the Instagram API may be bought on a different Zyla account than the
 *     YouTube one). Never in client code, URLs, or logs.
 *   - Every upstream call costs quota → 30-min response cache + in-flight
 *     dedupe; negative results cached briefly too (bad usernames also bill).
 *   - Media bytes are streamed through /ig/download|/ig/view ONLY from Meta
 *     CDN hosts (*.cdninstagram.com / *.fbcdn.net, https, public DNS) —
 *     strict allowlist so this never becomes an open proxy. Redirects are
 *     re-validated hop by hop.
 *   - Upstream media URLs are signed + expiring → downloads can 4xx after a
 *     while; surface a clear "refresh and retry" error, never a corrupt file.
 */
import { Router, type IRouter, type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import { Readable } from "node:stream";
import { logger } from "../lib/logger";
import { isSafePublicUrl, urlResolvesPublic } from "../lib/ssrfGuard";
import { verifyIgRelayToken } from "../lib/igRelayToken";

const IG_BASE = "https://zylalabs.com/api/12390/instagram+profile+and+media+data+api";

const EP = {
  profile: "23416/get+profile+details",
  posts: "23417/get+profile+posts+list",
  reels: "23418/get+profile+reels+list",
  postDetails: "23420/get+post+details",
  reelDetails: "23421/get+reel+details",
  stories: "23423/get+all+24h+stories+of+an+user",
} as const;

const CACHE_TTL_MS = 30 * 60 * 1000;      // signed CDN URLs stay valid well past this
const NEG_CACHE_TTL_MS = 10 * 60 * 1000;  // not-found/private also bill quota
const UPSTREAM_TIMEOUT_MS = 25_000;
const STREAM_WATCHDOG_MS = 10 * 60 * 1000;
const MAX_REDIRECT_HOPS = 3;

function apiKey(): string | undefined {
  const k = (process.env["ZYLA_IG_API_KEY"] ?? process.env["ZYLA_API_KEY"] ?? "").trim();
  return k.length > 0 ? k : undefined;
}

// ── Input parsing ─────────────────────────────────────────────────────────────

const USERNAME_RE = /^[a-z0-9](?:[a-z0-9._]{0,29})$/i;

/** Accepts "natgeo", "@natgeo", "instagram.com/natgeo[/...]" → "natgeo". */
export function parseIgUsername(raw: string): string | null {
  const s = (raw ?? "").trim();
  if (!s) return null;
  const at = s.startsWith("@") ? s.slice(1) : s;
  if (USERNAME_RE.test(at)) return at.toLowerCase();
  try {
    const u = new URL(at.includes("://") ? at : `https://${at}`);
    const host = u.hostname.toLowerCase().replace(/^www\./, "");
    if (host !== "instagram.com" && !host.endsWith(".instagram.com")) return null;
    const seg = u.pathname.split("/").filter(Boolean);
    if (seg.length === 0) return null;
    // Not a profile path: /p/…, /reel/…, /reels/…, /stories/…, /explore/…
    if (["p", "reel", "reels", "tv", "stories", "explore", "accounts"].includes(seg[0].toLowerCase())) return null;
    return USERNAME_RE.test(seg[0]) ? seg[0].toLowerCase() : null;
  } catch {
    return null;
  }
}

/** Classifies a pasted instagram.com link: reel/post/profile. */
export function classifyIgUrl(raw: string): { type: "reel" | "post"; url: string } | { type: "profile"; username: string } | null {
  const s = (raw ?? "").trim();
  if (!s) return null;
  try {
    const u = new URL(s.includes("://") ? s : `https://${s}`);
    const host = u.hostname.toLowerCase().replace(/^www\./, "");
    if (host !== "instagram.com" && !host.endsWith(".instagram.com")) return null;
    const seg = u.pathname.split("/").filter(Boolean);
    if (seg.length >= 2 && ["reel", "reels", "tv"].includes(seg[0].toLowerCase())) {
      return { type: "reel", url: `https://www.instagram.com/${seg[0]}/${seg[1]}/` };
    }
    if (seg.length >= 2 && seg[0].toLowerCase() === "p") {
      return { type: "post", url: `https://www.instagram.com/p/${seg[1]}/` };
    }
    const username = parseIgUsername(s);
    return username ? { type: "profile", username } : null;
  } catch {
    return null;
  }
}

// ── Upstream fetch with cache + in-flight dedupe ─────────────────────────────

type Upstream = { status: number; json: unknown };
const cache = new Map<string, { expiresAt: number; value: Upstream }>();
const inflight = new Map<string, Promise<Upstream>>();

/** Test hook: drop cached engine responses, the way real elapsed time would.
 *  Lets "next day" rescan tests refetch without waiting out the 30-min TTL. */
export function __clearIgCacheForTests(): void {
  cache.clear();
  inflight.clear();
}

function cacheSweep(): void {
  const now = Date.now();
  for (const [k, v] of cache) if (v.expiresAt <= now) cache.delete(k);
}
setInterval(cacheSweep, 5 * 60 * 1000).unref();

async function igGet(path: string, params: Record<string, string>): Promise<Upstream> {
  const key = apiKey();
  if (!key) return { status: 0, json: { message: "no key" } };

  const cacheKey = `${path}?${new URLSearchParams(params).toString()}`;
  const hit = cache.get(cacheKey);
  if (hit && hit.expiresAt > Date.now()) return hit.value;

  const running = inflight.get(cacheKey);
  if (running) return running;

  const p = (async (): Promise<Upstream> => {
    const url = `${IG_BASE}/${path}?${new URLSearchParams(params).toString()}`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), UPSTREAM_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        headers: { authorization: `Bearer ${key}`, accept: "application/json" },
        signal: ctrl.signal,
      });
      let json: unknown;
      const text = await res.text();
      try { json = JSON.parse(text); } catch { json = { message: text.slice(0, 200) }; }
      const value: Upstream = { status: res.status, json };
      const ttl = res.status === 200 ? CACHE_TTL_MS : NEG_CACHE_TTL_MS;
      // 401/403 (key not subscribed) and 5xx are NOT cached — the admin may fix
      // the key or the engine may recover at any moment.
      if (res.status === 200 || res.status === 404 || res.status === 400) {
        cache.set(cacheKey, { expiresAt: Date.now() + ttl, value });
      }
      return value;
    } finally {
      clearTimeout(timer);
      inflight.delete(cacheKey);
    }
  })();
  inflight.set(cacheKey, p);
  return p;
}

/** Maps upstream failures to clean client responses. Returns null when OK. */
function upstreamProblem(res: Response, up: Upstream): boolean {
  if (up.status === 0) {
    res.status(503).json({
      error: "Instagram downloads are not enabled on this server yet (missing API key).",
      code: "IG_NOT_CONFIGURED",
    });
    return true;
  }
  if (up.status === 200) return false;
  const msg = typeof (up.json as { message?: unknown })?.message === "string"
    ? ((up.json as { message: string }).message).slice(0, 160)
    : "";
  if (up.status === 401 || up.status === 403) {
    logger.warn({ status: up.status }, "instagram engine rejected API key");
    res.status(503).json({
      error: "The Instagram engine rejected this server's API key (not subscribed). Ask the site admin to update the Instagram API key.",
      code: "IG_NOT_SUBSCRIBED",
    });
    return true;
  }
  if (up.status === 404) {
    res.status(404).json({ error: "Profile or post not found. Check the spelling and try again.", code: "IG_NOT_FOUND" });
    return true;
  }
  if (up.status === 429) {
    res.status(429).json({ error: "The Instagram engine is busy or out of quota — try again in a minute.", code: "IG_RATE_LIMITED" });
    return true;
  }
  logger.warn({ status: up.status, msg }, "instagram engine error");
  res.status(502).json({ error: "The Instagram engine reported an error. Try again shortly.", code: "IG_ENGINE_ERROR" });
  return true;
}

// ── Response normalisation (defensive: engine wraps/renames freely) ──────────

export type IgMedia = {
  downloadUrl: string;
  mediaType: "VIDEO" | "PHOTO" | "UNKNOWN";
  thumbnailUrl?: string;
  caption?: string;
  id?: string;
  /** Instagram shortcode — the ONLY id the details endpoints resolve for
   *  any-age media (as instagram.com/<p|reel>/<code>/; bare numeric ids
   *  return an empty body — verified live). */
  code?: string;
  takenAt?: string | number;
};

function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim().length > 0 ? v : undefined;
}

function num(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && /^\d+$/.test(v)) return Number(v);
  return undefined;
}

const DOWNLOAD_KEYS = ["downloadUrl", "download_url", "videoUrl", "video_url", "mediaUrl", "media_url"];
const THUMB_KEYS = ["thumbnailUrl", "thumbnail_url", "displayUrl", "display_url", "coverUrl", "cover_url", "previewUrl", "preview_url", "imageUrl", "image_url"];

/** Walks arbitrary JSON, collecting anything that looks like a media item.
 *  List items carry code/title/taken_at on the ITEM object while the
 *  downloadUrl sits on a nested mediaList child — `ctx` inherits those down
 *  so every harvested media knows its shortcode, caption and upload time. */
export function harvestMedia(
  node: unknown,
  out: IgMedia[] = [],
  depth = 0,
  ctx?: { code?: string; caption?: string; takenAt?: string | number },
): IgMedia[] {
  if (depth > 8 || out.length >= 200) return out;
  if (Array.isArray(node)) {
    for (const item of node) harvestMedia(item, out, depth + 1, ctx);
    return out;
  }
  const rec = asRecord(node);
  if (!rec) return out;

  const ownCaption = str(rec["caption"]) ?? str(asRecord(rec["caption"])?.["text"]) ?? str(rec["title"]) ?? str(rec["text"]);
  const ownCode = str(rec["shortcode"]) ?? str(rec["code"]);
  const ownTakenAt = str(rec["takenAt"]) ?? str(rec["taken_at"]) ?? num(rec["takenAt"]) ?? num(rec["taken_at"]) ?? num(rec["timestamp"]);
  const childCtx = { code: ownCode ?? ctx?.code, caption: ownCaption ?? ctx?.caption, takenAt: ownTakenAt ?? ctx?.takenAt };

  let downloadUrl: string | undefined;
  for (const k of DOWNLOAD_KEYS) { downloadUrl = str(rec[k]); if (downloadUrl) break; }
  if (downloadUrl) {
    let thumbnailUrl: string | undefined;
    for (const k of THUMB_KEYS) { thumbnailUrl = str(rec[k]); if (thumbnailUrl) break; }
    const typeRaw = (str(rec["mediaType"]) ?? str(rec["media_type"]) ?? str(rec["type"]) ?? "").toUpperCase();
    const mediaType: IgMedia["mediaType"] =
      typeRaw.includes("VIDEO") || typeRaw.includes("REEL") || typeRaw.includes("CLIP") ? "VIDEO"
      : typeRaw.includes("PHOTO") || typeRaw.includes("IMAGE") || typeRaw.includes("CAROUSEL") ? "PHOTO"
      : /\.mp4($|\?)/i.test(downloadUrl) ? "VIDEO"
      : /\.(jpe?g|png|webp|heic)($|\?)/i.test(downloadUrl) ? "PHOTO"
      : "UNKNOWN";
    const item: IgMedia = { downloadUrl, mediaType };
    if (thumbnailUrl && thumbnailUrl !== downloadUrl) item.thumbnailUrl = thumbnailUrl;
    const caption = ownCaption ?? ctx?.caption;
    if (caption) item.caption = caption.slice(0, 300);
    const id = str(rec["id"]) ?? str(rec["pk"]) ?? ownCode;
    if (id) item.id = id;
    const code = ownCode ?? ctx?.code;
    if (code) item.code = code;
    const takenAt = ownTakenAt ?? ctx?.takenAt;
    if (takenAt !== undefined) item.takenAt = takenAt;
    if (!out.some((m) => m.downloadUrl === downloadUrl)) out.push(item);
    // A post object can still nest carousel children — keep walking.
  }
  for (const v of Object.values(rec)) harvestMedia(v, out, depth + 1, childCtx);
  return out;
}

/** Locates the engine's pagination block ({ hasNextPage, nextCursor } —
 *  snake_case variants tolerated) anywhere shallow in a list response. */
function findPagination(node: unknown, depth = 0): { hasNext: boolean; cursor?: string } | null {
  if (depth > 4) return null;
  const rec = asRecord(node);
  if (!rec) return null;
  const pag = asRecord(rec["pagination"]);
  if (pag) {
    const cursor = str(pag["nextCursor"]) ?? str(pag["next_cursor"]) ?? str(pag["endCursor"]) ?? str(pag["end_cursor"]);
    const hasNext = pag["hasNextPage"] === true || pag["has_next_page"] === true
      || pag["hasMore"] === true || pag["has_more"] === true;
    return { hasNext: hasNext && !!cursor, ...(cursor ? { cursor } : {}) };
  }
  for (const v of Object.values(rec)) {
    const found = findPagination(v, depth + 1);
    if (found) return found;
  }
  return null;
}

export type IgProfile = {
  username: string;
  fullName?: string;
  biography?: string;
  followers?: number;
  following?: number;
  totalPosts?: number;
  profilePictureUrl?: string;
  isPrivate?: boolean;
  isVerified?: boolean;
};

/** BFS for the first object that carries a username + profile-ish fields. */
export function normalizeProfile(root: unknown): IgProfile | null {
  const queue: unknown[] = [root];
  let steps = 0;
  while (queue.length > 0 && steps < 500) {
    steps++;
    const node = queue.shift();
    if (Array.isArray(node)) { queue.push(...node); continue; }
    const rec = asRecord(node);
    if (!rec) continue;
    const username = str(rec["username"]);
    if (username && USERNAME_RE.test(username)) {
      const profile: IgProfile = { username: username.toLowerCase() };
      const fullName = str(rec["fullName"]) ?? str(rec["full_name"]) ?? str(rec["name"]);
      if (fullName) profile.fullName = fullName.slice(0, 120);
      const bio = str(rec["biography"]) ?? str(rec["bio"]) ?? str(rec["description"]);
      if (bio) profile.biography = bio.slice(0, 500);
      const followers = num(rec["followers"]) ?? num(rec["followersCount"]) ?? num(rec["follower_count"]) ?? num(rec["followerCount"]);
      if (followers !== undefined) profile.followers = followers;
      const following = num(rec["following"]) ?? num(rec["followingCount"]) ?? num(rec["following_count"]) ?? num(rec["followingCount"]);
      if (following !== undefined) profile.following = following;
      const totalPosts = num(rec["totalPosts"]) ?? num(rec["postsCount"]) ?? num(rec["mediaCount"]) ?? num(rec["media_count"]) ?? num(rec["posts"]);
      if (totalPosts !== undefined) profile.totalPosts = totalPosts;
      const avatar = str(rec["profilePictureUrl"]) ?? str(rec["profilePicUrl"]) ?? str(rec["profile_pic_url_hd"]) ?? str(rec["profile_pic_url"]) ?? str(rec["avatarUrl"]);
      if (avatar) profile.profilePictureUrl = avatar;
      const isPrivate = rec["isPrivateAccount"] ?? rec["isPrivate"] ?? rec["is_private"] ?? rec["private"];
      if (typeof isPrivate === "boolean") profile.isPrivate = isPrivate;
      const isVerified = rec["isVerified"] ?? rec["is_verified"] ?? rec["verified"];
      if (typeof isVerified === "boolean") profile.isVerified = isVerified;
      return profile;
    }
    queue.push(...Object.values(rec));
  }
  return null;
}

// ── Media streaming proxy (download / thumbnail view) ────────────────────────

function isAllowedMediaHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.+$/, "");
  return (
    h === "cdninstagram.com" || h.endsWith(".cdninstagram.com") ||
    h === "fbcdn.net" || h.endsWith(".fbcdn.net")
  );
}

function safeFilename(raw: string | undefined, fallback: string): string {
  const cleaned = (raw ?? "").replace(/[^\w.-]+/g, "_").replace(/^[_.]+|[_.]+$/g, "").slice(0, 80);
  return cleaned.length > 0 ? cleaned : fallback;
}

function extFromContentType(ct: string): string {
  if (ct.includes("video/mp4")) return ".mp4";
  if (ct.includes("image/jpeg")) return ".jpg";
  if (ct.includes("image/png")) return ".png";
  if (ct.includes("image/webp")) return ".webp";
  if (ct.includes("video/")) return ".mp4";
  if (ct.includes("image/")) return ".jpg";
  return "";
}

/** Drains/cancels a fetch body we will not pipe — otherwise the socket leaks. */
async function discardBody(r: globalThis.Response | null): Promise<void> {
  try { await r?.body?.cancel(); } catch { /* already consumed/closed */ }
}

async function streamCdnMedia(req: Request, res: Response, disposition: "attachment" | "inline"): Promise<void> {
  const nameBase = typeof req.query["name"] === "string" ? (req.query["name"] as string) : undefined;
  const raw = typeof req.query["u"] === "string" ? (req.query["u"] as string) : "";
  await streamAllowlistedUrl(res, raw, { disposition, nameBase });
}

/** Validates + streams an allowlisted Meta-CDN URL to `res`. Shared by the
 *  user-facing download/view routes and the campaign posting relay. */
async function streamAllowlistedUrl(
  res: Response,
  raw: string,
  opts: { disposition: "attachment" | "inline"; nameBase?: string },
): Promise<void> {
  const { disposition } = opts;
  if (!raw || raw.length > 4096) {
    res.status(400).json({ error: "Missing or invalid media link.", code: "BAD_MEDIA_URL" });
    return;
  }
  let parsed: URL;
  try { parsed = new URL(raw); } catch {
    res.status(400).json({ error: "Missing or invalid media link.", code: "BAD_MEDIA_URL" });
    return;
  }
  if (parsed.protocol !== "https:" || !isAllowedMediaHost(parsed.hostname) || !isSafePublicUrl(raw)) {
    res.status(400).json({ error: "Only Instagram media links can be downloaded here.", code: "MEDIA_HOST_NOT_ALLOWED" });
    return;
  }
  if (!(await urlResolvesPublic(raw))) {
    res.status(400).json({ error: "Only Instagram media links can be downloaded here.", code: "MEDIA_HOST_NOT_ALLOWED" });
    return;
  }

  const ctrl = new AbortController();
  const watchdog = setTimeout(() => ctrl.abort(), STREAM_WATCHDOG_MS);
  res.on("close", () => { clearTimeout(watchdog); ctrl.abort(); });

  try {
    // Manual redirect walk — every hop must stay on the Meta CDN allowlist.
    let current = raw;
    let upstream: globalThis.Response | null = null;
    for (let hop = 0; hop <= MAX_REDIRECT_HOPS; hop++) {
      const r = await fetch(current, {
        redirect: "manual",
        signal: ctrl.signal,
        headers: { "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)", accept: "*/*" },
      });
      if (r.status >= 300 && r.status < 400) {
        const loc = r.headers.get("location");
        if (!loc) { upstream = r; break; }
        const next = new URL(loc, current);
        await discardBody(r);
        if (next.protocol !== "https:" || !isAllowedMediaHost(next.hostname) || !(await urlResolvesPublic(next.toString()))) {
          res.status(400).json({ error: "Only Instagram media links can be downloaded here.", code: "MEDIA_HOST_NOT_ALLOWED" });
          return;
        }
        current = next.toString();
        continue;
      }
      upstream = r;
      break;
    }

    if (!upstream || !upstream.ok || !upstream.body) {
      await discardBody(upstream);
      res.status(502).json({
        error: "This media link has expired. Search the profile again to get a fresh one.",
        code: "MEDIA_LINK_EXPIRED",
      });
      return;
    }

    const ct = upstream.headers.get("content-type") ?? "application/octet-stream";

    // Inline mode renders under OUR origin — only passive media may be shown
    // inline. HTML/SVG/anything scriptable must never execute from here.
    if (disposition === "inline") {
      const mime = (ct.split(";")[0] ?? "").trim().toLowerCase();
      const inlineOk = (mime.startsWith("image/") && mime !== "image/svg+xml") || mime.startsWith("video/");
      if (!inlineOk) {
        await discardBody(upstream);
        res.status(415).json({ error: "This link is not an image or video.", code: "UNSUPPORTED_MEDIA_TYPE" });
        return;
      }
    }
    const len = upstream.headers.get("content-length");
    res.setHeader("Content-Type", ct);
    if (len && /^\d+$/.test(len)) res.setHeader("Content-Length", len);
    res.setHeader("X-Content-Type-Options", "nosniff");
    if (disposition === "inline") {
      res.setHeader("Cache-Control", "public, max-age=1800");
      res.setHeader("Content-Disposition", "inline");
    } else {
      const base = safeFilename(opts.nameBase, "instagram_media");
      const ext = extFromContentType(ct);
      const filename = base.toLowerCase().endsWith(ext) || ext === "" ? base : `${base}${ext}`;
      res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    }

    const body = Readable.fromWeb(upstream.body as import("node:stream/web").ReadableStream);
    body.on("error", () => { if (!res.headersSent) res.status(502); res.end(); });
    body.pipe(res);
    await new Promise<void>((resolve) => { res.on("finish", resolve); res.on("close", resolve); });
  } catch {
    if (!res.headersSent) {
      res.status(502).json({
        error: "This media link has expired. Search the profile again to get a fresh one.",
        code: "MEDIA_LINK_EXPIRED",
      });
    } else {
      res.end();
    }
  } finally {
    clearTimeout(watchdog);
  }
}

// ── Router ────────────────────────────────────────────────────────────────────

// Lookups hit the PAID engine (when uncached) — keep them tight.
const igLookupLimiter = rateLimit({
  windowMs: 60_000,
  limit: 15,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many Instagram lookups — wait a minute and try again." },
});

// Thumbnails render in bursts (a grid mounts 12-30 images at once).
const igMediaLimiter = rateLimit({
  windowMs: 60_000,
  limit: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many media requests — please wait a moment." },
});

const router: IRouter = Router();

router.get("/ig/profile", igLookupLimiter, async (req: Request, res: Response) => {
  const username = parseIgUsername(typeof req.query["username"] === "string" ? (req.query["username"] as string) : "");
  if (!username) {
    res.status(400).json({ error: "Enter a valid Instagram username (letters, numbers, dots, underscores).", code: "BAD_USERNAME" });
    return;
  }
  const up = await igGet(EP.profile, { username });
  if (upstreamProblem(res, up)) return;
  const profile = normalizeProfile(up.json);
  if (!profile) {
    logger.warn({ username }, "instagram profile response had no recognizable profile");
    res.status(404).json({ error: "Profile not found. Check the username and try again.", code: "IG_NOT_FOUND" });
    return;
  }
  res.json({ profile });
});

const MEDIA_KINDS: Record<string, string> = { posts: EP.posts, reels: EP.reels, stories: EP.stories };

router.get("/ig/media", igLookupLimiter, async (req: Request, res: Response) => {
  const username = parseIgUsername(typeof req.query["username"] === "string" ? (req.query["username"] as string) : "");
  const kind = typeof req.query["kind"] === "string" ? (req.query["kind"] as string) : "posts";
  if (!username) {
    res.status(400).json({ error: "Enter a valid Instagram username first.", code: "BAD_USERNAME" });
    return;
  }
  const ep = MEDIA_KINDS[kind];
  if (!ep) {
    res.status(400).json({ error: "kind must be one of posts, reels, stories.", code: "BAD_KIND" });
    return;
  }
  const up = await igGet(ep, { username });
  if (upstreamProblem(res, up)) return;
  const items = harvestMedia(up.json);
  res.json({ kind, count: items.length, items });
});

router.get("/ig/resolve", igLookupLimiter, async (req: Request, res: Response) => {
  const raw = typeof req.query["url"] === "string" ? (req.query["url"] as string) : "";
  const classified = classifyIgUrl(raw);
  if (!classified) {
    res.status(400).json({ error: "Paste an Instagram post/reel link or a profile link.", code: "BAD_IG_URL" });
    return;
  }
  if (classified.type === "profile") {
    res.json({ type: "profile", username: classified.username });
    return;
  }
  const ep = classified.type === "reel" ? EP.reelDetails : EP.postDetails;
  const up = await igGet(ep, { idOrUrl: classified.url });
  if (upstreamProblem(res, up)) return;
  const items = harvestMedia(up.json);
  if (items.length === 0) {
    res.status(404).json({ error: "Could not read media from this link. It may be private or removed.", code: "IG_NOT_FOUND" });
    return;
  }
  res.json({ type: "media", kind: classified.type, count: items.length, items });
});

router.get("/ig/download", igMediaLimiter, (req: Request, res: Response) => {
  void streamCdnMedia(req, res, "attachment");
});

router.get("/ig/view", igMediaLimiter, (req: Request, res: Response) => {
  void streamCdnMedia(req, res, "inline");
});

// ── Auto-Pilot integration (server-side helpers + posting relay) ──────────────

/** Human text for an upstream problem — server-side callers (campaigns)
 *  surface this instead of the HTTP mapping in upstreamProblem(). */
export function igProblemText(status: number): string {
  if (status === 0) return "Instagram source is not enabled on this server yet (missing API key).";
  if (status === 401 || status === 403) return "The Instagram engine rejected this server's API key (not subscribed) — ask the site admin to update it.";
  if (status === 404) return "Profile not found. Check the spelling and try again.";
  if (status === 429) return "The Instagram engine is busy or out of quota — try again in a minute.";
  return "The Instagram engine reported an error. Try again shortly.";
}

export type IgVideoItem = { id: string; kind: "post" | "reel"; downloadUrl: string; caption?: string; takenAt?: string | number };

/** Every currently-listed VIDEO of a public profile (reels + feed videos),
 *  newest-first per Instagram's own listing order. Photos are skipped —
 *  campaign destinations (YouTube etc.) need video files.
 *
 *  The engine pages by ~12 items via nextCursor. `deep` follows the cursors
 *  (campaign detect/create — the recent backlog matters, capped so a 10k-post
 *  profile can't burn quota); the default single page serves the daily
 *  rescan, where anything NEW sits on top anyway. Every page rides the same
 *  30-minute igGet cache, so detect → create moments later is free. */
const DEEP_MAX_PAGES_PER_LIST = 12;  // ≈144 newest posts + ≈144 newest reels
const DEEP_MAX_VIDEOS = 260;         // hard cap across both lists

/** Normalises a provider upload timestamp (epoch seconds, epoch ms, numeric
 *  string, or ISO date) to epoch ms; null when absent or unparseable. */
export function igTakenAtMs(v: string | number | undefined): number | null {
  if (v === undefined) return null;
  const n = typeof v === "number" ? v : /^\d+(\.\d+)?$/.test(v.trim()) ? Number(v.trim()) : NaN;
  if (Number.isFinite(n) && n > 0) return n < 1e12 ? n * 1000 : n;
  if (typeof v === "string") {
    const t = Date.parse(v);
    if (Number.isFinite(t)) return t;
  }
  return null;
}

export async function igListProfileVideos(
  username: string,
  opts?: { deep?: boolean },
): Promise<{ ok: true; videos: IgVideoItem[] } | { ok: false; status: number; error: string }> {
  const maxPages = opts?.deep ? DEEP_MAX_PAGES_PER_LIST : 1;

  // Pages chain through nextCursor (sequential per list); lists in parallel.
  const fetchList = async (ep: string): Promise<{ first: Upstream; medias: IgMedia[] }> => {
    let first: Upstream = { status: 0, json: null };
    const medias: IgMedia[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < maxPages; page++) {
      const up = await igGet(ep, cursor ? { username, nextCursor: cursor } : { username });
      if (page === 0) first = up;
      if (up.status !== 200) break;            // keep earlier pages on a mid-run hiccup
      const batch = harvestMedia(up.json);
      if (batch.length === 0) break;
      medias.push(...batch);
      if (medias.length >= DEEP_MAX_VIDEOS) break;
      const pag = findPagination(up.json);
      if (!pag?.hasNext || !pag.cursor) break;
      cursor = pag.cursor;
    }
    return { first, medias };
  };

  const [reels, posts] = await Promise.all([fetchList(EP.reels), fetchList(EP.posts)]);
  if (reels.first.status !== 200 && posts.first.status !== 200) {
    const rs = reels.first.status, ps = posts.first.status;
    const st = rs === 0 || ps === 0 ? 0
      : (rs === 401 || rs === 403) ? rs
      : (ps === 401 || ps === 403) ? ps
      : rs !== 200 ? rs : ps;
    return { ok: false, status: st, error: igProblemText(st) };
  }
  const videos: IgVideoItem[] = [];
  const seen = new Set<string>();
  const take = (medias: IgMedia[], kind: "post" | "reel"): void => {
    for (const m of medias) {
      // Shortcode preferred as the durable ref id: details endpoints resolve
      // ANY-age media via instagram.com/<p|reel>/<code>/, while numeric ids
      // only match while the media still sits on a list's first pages.
      const id = m.code ?? m.id;
      if (m.mediaType !== "VIDEO" || !id || seen.has(id)) continue;
      seen.add(id);
      videos.push({
        id, kind, downloadUrl: m.downloadUrl,
        ...(m.caption ? { caption: m.caption } : {}),
        ...(m.takenAt !== undefined ? { takenAt: m.takenAt } : {}),
      });
    }
  };
  take(reels.medias, "reel");
  take(posts.medias, "post");
  // Reels and feed posts arrive as two SEPARATE newest-first lists — merged
  // as-is they are not one timeline, which would corrupt "newest N"
  // backlog-limit picks and oldest-first posting across the streams. When
  // every item carries a parseable upload time, sort newest-first globally;
  // otherwise keep list order (deterministic fallback for engine responses
  // that drop timestamps).
  const stamps = videos.map((v) => igTakenAtMs(v.takenAt));
  if (videos.length > 1 && stamps.every((t) => t !== null)) {
    const order = new Map(videos.map((v, i) => [v, stamps[i] as number]));
    videos.sort((a, b) => order.get(b)! - order.get(a)!);
  }
  return { ok: true, videos: videos.slice(0, DEEP_MAX_VIDEOS) };
}

/** Fresh CDN URL for one pinned media — the profile lists first (cached,
 *  covers recent items), then a targeted details call for older ones. */
export async function igFreshVideoUrl(username: string, kind: "post" | "reel", mediaId: string): Promise<string | null> {
  const fromList = (up: Upstream): string | null => {
    if (up.status !== 200) return null;
    const m = harvestMedia(up.json).find((x) => (x.code === mediaId || x.id === mediaId) && x.mediaType === "VIDEO");
    return m?.downloadUrl ?? null;
  };
  let url = fromList(await igGet(kind === "reel" ? EP.reels : EP.posts, { username }));
  if (url) return url;
  // Details endpoints only resolve by instagram.com URL — a bare numeric id
  // returns an empty body (verified live). Refs store the shortcode; legacy
  // numeric refs still get the list checks above/below.
  const idOrUrl = /^\d+$/.test(mediaId)
    ? mediaId
    : `https://www.instagram.com/${kind === "reel" ? "reel" : "p"}/${mediaId}/`;
  const det = await igGet(kind === "reel" ? EP.reelDetails : EP.postDetails, { idOrUrl });
  if (det.status === 200) {
    const all = harvestMedia(det.json);
    const m = all.find((x) => x.mediaType === "VIDEO") ?? all[0];
    if (m?.downloadUrl) return m.downloadUrl;
  }
  // Cross-list fallback: some feed videos surface under the other list.
  url = fromList(await igGet(kind === "reel" ? EP.posts : EP.reels, { username }));
  return url;
}

// The posting provider fetches campaign media here at publish time. The token
// is HMAC-signed + self-expiring (no auth cookie — the provider is external),
// and the CDN URL is re-resolved fresh on EVERY fetch because Instagram's
// signed URLs rot within hours. Streaming reuses the strict Meta-CDN
// allowlist, so even a poisoned upstream response can't turn this into an
// open proxy.
const igRelayLimiter = rateLimit({
  windowMs: 60_000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many relay requests — slow down." },
});

router.get("/ig/relay/:token", igRelayLimiter, async (req: Request, res: Response) => {
  const ref = verifyIgRelayToken(String(req.params["token"] ?? ""));
  if (!ref) {
    res.status(403).json({ error: "This media link is invalid or has expired.", code: "RELAY_TOKEN_INVALID" });
    return;
  }
  const url = await igFreshVideoUrl(ref.username, ref.kind, ref.mediaId).catch(() => null);
  if (!url) {
    logger.warn({ username: ref.username, mediaId: ref.mediaId }, "ig relay could not resolve media");
    res.status(404).json({ error: "This Instagram video is no longer available.", code: "IG_MEDIA_GONE" });
    return;
  }
  await streamAllowlistedUrl(res, url, {
    disposition: "attachment",
    nameBase: `instagram_${ref.username}_${ref.mediaId}`,
  });
});

export default router;
