/**
 * TikTok public profile/media adapter for Auto-Pilot, powered by Zyla API
 * #12389. TikTok CDN URLs are signed and short-lived, so only stable video ids
 * are persisted by campaigns and URLs are refreshed through the relay.
 */
import { Router, type IRouter, type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import { Readable } from "node:stream";
import { logger } from "../lib/logger";
import { isSafePublicUrl, urlResolvesPublic } from "../lib/ssrfGuard";
import { verifyTikTokRelayToken } from "../lib/tiktokRelayToken";
import { requireUser } from "../middlewares/sessionAuth";

const TT_BASE = "https://zylalabs.com/api/12389/tiktok+public+media+api";
const EP = {
  profile: "23413/get+profile+details",
  media: "23414/get+profile+media+list",
  details: "23415/get+video+details",
} as const;

const CACHE_TTL_MS = 30 * 60 * 1000;
const NEG_CACHE_TTL_MS = 10 * 60 * 1000;
const UPSTREAM_TIMEOUT_MS = 25_000;
const MAX_REDIRECT_HOPS = 3;
const STREAM_WATCHDOG_MS = 10 * 60 * 1000;
const DEEP_MAX_PAGES = 12;
const DEEP_MAX_VIDEOS = 260;
const MAX_CACHE_ENTRIES = 1000;
const UPSTREAM_CONCURRENCY = 8;
const MAX_UPSTREAM_QUEUE = 32;
const UPSTREAM_QUEUE_WAIT_MS = 5_000;

function apiKey(): string | undefined {
  const value = (process.env.ZYLA_TIKTOK_API_KEY ?? "").trim();
  return value || undefined;
}

const USERNAME_RE = /^[a-z0-9](?:[a-z0-9._]{0,29})$/i;

export function parseTikTokUsername(raw: string): string | null {
  const value = (raw ?? "").trim();
  if (!value) return null;
  const bare = value.startsWith("@") ? value.slice(1) : value;
  if (USERNAME_RE.test(bare)) return bare.toLowerCase();
  try {
    const url = new URL(value.includes("://") ? value : `https://${value}`);
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    if (host !== "tiktok.com" && !host.endsWith(".tiktok.com")) return null;
    const segments = url.pathname.split("/").filter(Boolean);
    const segment = segments[0] ?? "";
    // Profile sources are exactly /@username. A pasted /@username/video/id
    // must not silently import the creator's entire profile.
    if (segments.length > 1) return null;
    const username = segment.startsWith("@") ? segment.slice(1) : segment;
    return USERNAME_RE.test(username) ? username.toLowerCase() : null;
  } catch {
    return null;
  }
}

type Upstream = { status: number; json: unknown };
const cache = new Map<string, { expiresAt: number; value: Upstream }>();
const inflight = new Map<string, Promise<Upstream>>();

class AsyncLimiter {
  private active = 0;
  private readonly waiting: Array<{
    resolve: () => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }> = [];

  constructor(
    private readonly limit: number,
    private readonly maxWaiting: number,
    private readonly maxWaitMs: number,
  ) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) {
      if (this.waiting.length >= this.maxWaiting) throw new TikTokAdmissionError();
      await new Promise<void>((resolve, reject) => {
        const entry = {
          resolve,
          reject,
          timer: setTimeout(() => {
            const index = this.waiting.indexOf(entry);
            if (index >= 0) this.waiting.splice(index, 1);
            reject(new TikTokAdmissionError());
          }, this.maxWaitMs),
        };
        entry.timer.unref();
        this.waiting.push(entry);
      });
    }
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      const next = this.waiting.shift();
      if (next) {
        clearTimeout(next.timer);
        next.resolve();
      }
    }
  }
}

class TikTokAdmissionError extends Error {
  constructor() {
    super("TikTok upstream queue is busy");
    this.name = "TikTokAdmissionError";
  }
}

// A process-local guard protects the paid provider and the Node event loop
// during bursts. In-flight deduplication still makes identical requests share
// one slot rather than queueing duplicates.
const upstreamLimiter = new AsyncLimiter(
  UPSTREAM_CONCURRENCY,
  MAX_UPSTREAM_QUEUE,
  UPSTREAM_QUEUE_WAIT_MS,
);

export function __clearTikTokCacheForTests(): void {
  cache.clear();
  inflight.clear();
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}
function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
function num(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^-?\d+(\.\d+)?$/.test(value.trim())) return Number(value);
  return undefined;
}
function bool(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

async function ttGet(path: string, params: Record<string, string>): Promise<Upstream> {
  const key = apiKey();
  if (!key) return { status: 0, json: { message: "no key" } };
  const cacheKey = `${path}?${new URLSearchParams(params).toString()}`;
  const hit = cache.get(cacheKey);
  if (hit && hit.expiresAt > Date.now()) return hit.value;
  const running = inflight.get(cacheKey);
  if (running) return running;
  let promise!: Promise<Upstream>;
  promise = upstreamLimiter.run(async (): Promise<Upstream> => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), UPSTREAM_TIMEOUT_MS);
    try {
      const response = await fetch(`${TT_BASE}/${path}?${new URLSearchParams(params)}`, {
        headers: { authorization: `Bearer ${key}`, accept: "application/json" },
        signal: ctrl.signal,
      });
      const text = await response.text();
      let json: unknown;
      try { json = JSON.parse(text); } catch { json = { message: text.slice(0, 200) }; }
      const value = { status: response.status, json };
      if (response.status === 200 || response.status === 400 || response.status === 404) {
        // Map preserves insertion order, so evicting the oldest entry keeps
        // this cache bounded without adding another dependency.
        if (cache.size >= MAX_CACHE_ENTRIES && !cache.has(cacheKey)) {
          cache.delete(cache.keys().next().value as string);
        }
        cache.set(cacheKey, {
          expiresAt: Date.now() + (response.status === 200 ? CACHE_TTL_MS : NEG_CACHE_TTL_MS),
          value,
        });
      }
      return value;
    } catch (error) {
      return {
        status: 502,
        json: { message: error instanceof Error ? error.name : "upstream request failed" },
      };
    } finally {
      clearTimeout(timer);
    }
  }).catch((error: unknown) => {
    if (error instanceof TikTokAdmissionError) {
      return { status: 429, json: { message: "TikTok upstream queue is busy" } };
    }
    throw error;
  }).finally(() => {
    // Identity guard prevents an older completion from deleting a newer call
    // for the same key after a test reset or future explicit cache invalidation.
    if (inflight.get(cacheKey) === promise) inflight.delete(cacheKey);
  });
  inflight.set(cacheKey, promise);
  return promise;
}

export function tikTokProblemText(status: number): string {
  if (status === 0) return "TikTok sources are not enabled on this server yet (missing API key).";
  if (status === 401 || status === 403) return "The TikTok engine rejected this server's API key (not subscribed) — ask the site admin to update it.";
  if (status === 404) return "TikTok profile or video not found. Check the spelling and try again.";
  if (status === 429) return "The TikTok engine is busy or out of quota — try again in a minute.";
  return "The TikTok engine reported an error. Try again shortly.";
}

function tikTokHttpStatus(status: number): number {
  if (status === 0 || status === 401 || status === 403) return 503;
  if (status === 404) return 404;
  if (status === 429) return 429;
  return 502;
}

export type TikTokProfile = { username: string; secUid: string; displayName?: string; avatarUrl?: string };
export type TikTokVideoItem = {
  id: string; downloadUrl: string; caption?: string; takenAt?: string | number;
};

function findValue(root: unknown, keys: string[], depth = 0): unknown {
  if (depth > 7) return undefined;
  if (Array.isArray(root)) {
    for (const item of root) {
      const found = findValue(item, keys, depth + 1);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  const rec = asRecord(root);
  if (!rec) return undefined;
  for (const key of keys) if (rec[key] !== undefined) return rec[key];
  for (const value of Object.values(rec)) {
    const found = findValue(value, keys, depth + 1);
    if (found !== undefined) return found;
  }
  return undefined;
}

export function normalizeTikTokProfile(root: unknown, username: string): TikTokProfile | null {
  const queue: unknown[] = [root];
  let steps = 0;
  while (queue.length && steps++ < 500) {
    const node = queue.shift();
    if (Array.isArray(node)) { queue.push(...node); continue; }
    const rec = asRecord(node);
    if (!rec) continue;
    const secUid = str(rec.secUid) ?? str(rec.sec_uid) ?? str(rec.secUidValue);
    const foundUsername = str(rec.username) ?? str(asRecord(rec.user)?.username);
    if (secUid && (foundUsername || rec.user || rec.nickname)) {
      const profile: TikTokProfile = { username: (foundUsername ?? username).replace(/^@/, "").toLowerCase(), secUid };
      const display = str(rec.nickname) ?? str(rec.displayName) ?? str(rec.display_name) ?? str(rec.name);
      const avatar = str(rec.avatarLarger) ?? str(rec.avatarUrl) ?? str(rec.avatar_url) ?? str(rec.profilePictureUrl);
      if (display) profile.displayName = display.slice(0, 120);
      if (avatar) profile.avatarUrl = avatar;
      return profile;
    }
    queue.push(...Object.values(rec));
  }
  const secUid = str(findValue(root, ["secUid", "sec_uid"]));
  return secUid ? { username, secUid } : null;
}

const DOWNLOAD_KEYS = [
  "hdPlayUrlList", "hd_play_url_list", "playUrlList", "play_url_list",
  "hdPlayUrl", "hd_play_url", "playUrl", "play_url", "downloadUrl", "download_url",
  "playAddr", "play_addr", "downloadAddr", "download_addr",
];
const CAPTION_KEYS = ["desc", "description", "caption", "title", "text"];
const ID_KEYS = ["id", "videoId", "video_id", "awemeId", "aweme_id", "itemId", "item_id"];
const TIME_KEYS = ["createTime", "create_time", "createdAt", "created_at", "timestamp"];

function firstUrl(value: unknown): string | undefined {
  if (typeof value === "string" && /^https?:\/\//i.test(value)) return value;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = firstUrl(item);
      if (found) return found;
    }
  }
  return undefined;
}

function looksLikePhoto(rec: Record<string, unknown>): boolean {
  const raw = [rec.type, rec.mediaType, rec.media_type, rec.itemType, rec.item_type, rec.postType]
    .map(str).filter(Boolean).join(" ").toUpperCase();
  return raw.includes("PHOTO") || raw.includes("IMAGE") || raw.includes("CAROUSEL");
}

/** Collects video records from both flat and nested Zyla response shapes. */
export function harvestTikTokVideos(root: unknown, out: TikTokVideoItem[] = [], depth = 0): TikTokVideoItem[] {
  if (depth > 9 || out.length >= DEEP_MAX_VIDEOS) return out;
  if (Array.isArray(root)) {
    for (const item of root) harvestTikTokVideos(item, out, depth + 1);
    return out;
  }
  const rec = asRecord(root);
  if (!rec) return out;
  const id = ID_KEYS.map((key) => str(rec[key])).find(Boolean);
  const url = firstUrl(findValue(rec, DOWNLOAD_KEYS));
  if (id && url && !looksLikePhoto(rec)) {
    const item: TikTokVideoItem = { id, downloadUrl: url };
    const caption = CAPTION_KEYS.map((key) => str(rec[key])).find(Boolean);
    const takenAt = TIME_KEYS.map((key) => str(rec[key]) ?? num(rec[key])).find((v) => v !== undefined);
    if (caption) item.caption = caption.slice(0, 300);
    if (takenAt !== undefined) item.takenAt = takenAt;
    if (!out.some((existing) => existing.id === id)) out.push(item);
  }
  for (const value of Object.values(rec)) harvestTikTokVideos(value, out, depth + 1);
  return out;
}

function findPagination(root: unknown): { hasMore: boolean; minCursor?: string; maxCursor?: string } | null {
  const queue: unknown[] = [root];
  let steps = 0;
  while (queue.length && steps++ < 200) {
    const rec = asRecord(queue.shift());
    if (!rec) continue;
    const cursor = (value: unknown): string | undefined => str(value) ?? (num(value) !== undefined ? String(num(value)) : undefined);
    const minCursor = cursor(rec.minCursor) ?? cursor(rec.min_cursor);
    const maxCursor = cursor(rec.maxCursor) ?? cursor(rec.max_cursor);
    const hasMore = bool(rec.hasMore) ?? bool(rec.has_more) ?? bool(rec.hasNextPage) ?? bool(rec.has_next_page);
    if (minCursor !== undefined || maxCursor !== undefined || hasMore !== undefined) {
      return { hasMore: hasMore === true && !!maxCursor, ...(minCursor ? { minCursor } : {}), ...(maxCursor ? { maxCursor } : {}) };
    }
    queue.push(...Object.values(rec));
  }
  return null;
}

export async function resolveTikTokProfile(username: string): Promise<{ ok: true; profile: TikTokProfile } | { ok: false; status: number; error: string }> {
  const up = await ttGet(EP.profile, { username });
  if (up.status !== 200) return { ok: false, status: up.status, error: tikTokProblemText(up.status) };
  const profile = normalizeTikTokProfile(up.json, username);
  return profile ? { ok: true, profile } : { ok: false, status: 404, error: "TikTok profile not found. Check the spelling and try again." };
}

export async function listTikTokProfileVideos(
  username: string,
  opts?: { deep?: boolean },
): Promise<{ ok: true; profile: TikTokProfile; videos: TikTokVideoItem[] } | { ok: false; status: number; error: string }> {
  const resolved = await resolveTikTokProfile(username);
  if (!resolved.ok) return resolved;
  const maxPages = opts?.deep ? DEEP_MAX_PAGES : 1;
  const videos: TikTokVideoItem[] = [];
  let minCursor = "0";
  let maxCursor = "0";
  let firstStatus = 200;
  for (let page = 0; page < maxPages; page++) {
    const up = await ttGet(EP.media, { secUid: resolved.profile.secUid, minCursor, maxCursor });
    if (page === 0) firstStatus = up.status;
    if (up.status !== 200) break;
    const batch = harvestTikTokVideos(up.json);
    videos.push(...batch.filter((item) => !videos.some((existing) => existing.id === item.id)));
    if (videos.length >= DEEP_MAX_VIDEOS) break;
    const pagination = findPagination(up.json);
    if (!pagination?.hasMore || !pagination.maxCursor) break;
    minCursor = pagination.minCursor ?? minCursor;
    maxCursor = pagination.maxCursor;
  }
  if (firstStatus !== 200) return { ok: false, status: firstStatus, error: tikTokProblemText(firstStatus) };
  return { ok: true, profile: resolved.profile, videos: videos.slice(0, DEEP_MAX_VIDEOS) };
}

export async function ttFreshVideoUrl(username: string, videoId: string): Promise<string | null> {
  const detail = await ttGet(EP.details, { idOrUrl: videoId });
  if (detail.status === 200) {
    const item = harvestTikTokVideos(detail.json)[0];
    if (item?.downloadUrl) return item.downloadUrl;
  }
  const listed = await listTikTokProfileVideos(username);
  if (!listed.ok) return null;
  return listed.videos.find((item) => item.id === videoId)?.downloadUrl ?? null;
}

function allowedTikTokMediaHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.+$/, "");
  return host === "tiktokcdn.com" || host.endsWith(".tiktokcdn.com")
    || host === "ibytedtos.com" || host.endsWith(".ibytedtos.com")
    || host === "muscdn.com" || host.endsWith(".muscdn.com");
}
function safeFilename(raw: string | undefined): string {
  const value = (raw ?? "tiktok_media").replace(/[^\w.-]+/g, "_").replace(/^[_.]+|[_.]+$/g, "").slice(0, 80);
  return value || "tiktok_media";
}
async function discardBody(response: globalThis.Response | null): Promise<void> {
  try { await response?.body?.cancel(); } catch { /* already consumed */ }
}

export function pipeTikTokBody(
  webBody: globalThis.ReadableStream,
  res: Response,
): Readable {
  const body = Readable.fromWeb(webBody as import("node:stream/web").ReadableStream);
  // Fetch body errors happen asynchronously, after this function returns and
  // often after headers have been sent. Without this listener Node treats the
  // CDN failure as an unhandled stream error and can terminate the API process.
  body.on("error", () => {
    if (!res.headersSent) res.status(502);
    res.end();
  });
  body.pipe(res);
  return body;
}

async function streamTikTokUrl(res: Response, raw: string, nameBase: string): Promise<void> {
  let parsed: URL;
  try { parsed = new URL(raw); } catch {
    res.status(400).json({ error: "This TikTok video is no longer available.", code: "TT_MEDIA_GONE" });
    return;
  }
  if (parsed.protocol !== "https:" || !allowedTikTokMediaHost(parsed.hostname) || !isSafePublicUrl(raw) || !(await urlResolvesPublic(raw))) {
    res.status(400).json({ error: "Only TikTok media links are allowed.", code: "TT_MEDIA_HOST_NOT_ALLOWED" });
    return;
  }
  const ctrl = new AbortController();
  const watchdog = setTimeout(() => ctrl.abort(), STREAM_WATCHDOG_MS);
  res.on("close", () => { clearTimeout(watchdog); ctrl.abort(); });
  try {
    let current = raw;
    let upstream: globalThis.Response | null = null;
    for (let hop = 0; hop <= MAX_REDIRECT_HOPS; hop++) {
      const response = await fetch(current, { redirect: "manual", signal: ctrl.signal, headers: { accept: "*/*" } });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location) { upstream = response; break; }
        const next = new URL(location, current);
        await discardBody(response);
        if (next.protocol !== "https:" || !allowedTikTokMediaHost(next.hostname)
          || !isSafePublicUrl(next.toString()) || !(await urlResolvesPublic(next.toString()))) {
          res.status(400).json({ error: "Only TikTok media links are allowed.", code: "TT_MEDIA_HOST_NOT_ALLOWED" });
          return;
        }
        current = next.toString();
      } else {
        upstream = response;
        break;
      }
    }
    if (!upstream || !upstream.ok || !upstream.body) {
      await discardBody(upstream);
      res.status(404).json({ error: "This TikTok video is no longer available.", code: "TT_MEDIA_GONE" });
      return;
    }
    const contentType = upstream.headers.get("content-type") ?? "video/mp4";
    const length = upstream.headers.get("content-length");
    res.setHeader("Content-Type", contentType);
    if (length && /^\d+$/.test(length)) res.setHeader("Content-Length", length);
    res.setHeader("Content-Disposition", `attachment; filename="${safeFilename(nameBase)}${contentType.includes("mp4") ? ".mp4" : ""}"`);
    res.setHeader("X-Content-Type-Options", "nosniff");
    pipeTikTokBody(upstream.body as globalThis.ReadableStream, res);
    await new Promise<void>((resolve) => { res.on("finish", resolve); res.on("close", resolve); });
  } catch {
    if (!res.headersSent) res.status(502).json({ error: "This TikTok video is no longer available.", code: "TT_MEDIA_GONE" });
    else res.end();
  } finally {
    clearTimeout(watchdog);
  }
}

const lookupLimiter = rateLimit({ windowMs: 60_000, limit: 15, standardHeaders: true, legacyHeaders: false });
const relayLimiter = rateLimit({ windowMs: 60_000, limit: 60, standardHeaders: true, legacyHeaders: false });
const router: IRouter = Router();

router.get("/tt/profile", requireUser, lookupLimiter, async (req: Request, res: Response) => {
  const username = parseTikTokUsername(typeof req.query.username === "string" ? req.query.username : "");
  if (!username) { res.status(400).json({ error: "Enter a valid TikTok username or profile link.", code: "BAD_USERNAME" }); return; }
  const result = await resolveTikTokProfile(username);
  if (!result.ok) { res.status(tikTokHttpStatus(result.status)).json({ error: result.error, code: result.status === 429 ? "TT_RATE_LIMITED" : result.status === 0 ? "TT_NOT_CONFIGURED" : "TT_NOT_FOUND" }); return; }
  res.json({ profile: result.profile });
});

router.get("/tt/media", requireUser, lookupLimiter, async (req: Request, res: Response) => {
  const username = parseTikTokUsername(typeof req.query.username === "string" ? req.query.username : "");
  if (!username) { res.status(400).json({ error: "Enter a valid TikTok username first.", code: "BAD_USERNAME" }); return; }
  const result = await listTikTokProfileVideos(username);
  if (!result.ok) { res.status(tikTokHttpStatus(result.status)).json({ error: result.error, code: result.status === 429 ? "TT_RATE_LIMITED" : "TT_ENGINE_ERROR" }); return; }
  res.json({ username, count: result.videos.length, items: result.videos });
});

router.get("/tt/relay/:token", relayLimiter, async (req: Request, res: Response) => {
  const ref = verifyTikTokRelayToken(String(req.params.token ?? ""));
  if (!ref) { res.status(403).json({ error: "This media link is invalid or has expired.", code: "RELAY_TOKEN_INVALID" }); return; }
  const url = await ttFreshVideoUrl(ref.username, ref.videoId).catch(() => null);
  if (!url) { res.status(404).json({ error: "This TikTok video is no longer available.", code: "TT_MEDIA_GONE" }); return; }
  await streamTikTokUrl(res, url, `tiktok_${ref.username}_${ref.videoId}`);
});

export default router;