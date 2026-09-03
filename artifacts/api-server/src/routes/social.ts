/**
 * Social routes — Post for Me (postforme.dev) provider.
 *
 * Connect: per-platform OAuth links (multiple accounts per platform are
 * first-class — PFM auto-imports every account the login can access, all
 * tagged with our external_id). The OAuth redirect ALWAYS comes back to
 * /api/social/postforme/callback (success AND failure) with
 * `provider, projectId, isSuccess, accountIds, failedAccountIds, error`.
 *
 * Posting: ownership is enforced server-side on EVERY post/disconnect —
 * requested account ids must exist in social_connections for the CURRENT
 * user (403 otherwise; frontend input is never trusted).
 *
 * Bulk scheduler: rows are enqueued locally, then a small drain loop hands
 * each one to PFM with `scheduled_at` — PFM stores the media (fetched from
 * the user's public Drive/Dropbox URL by THEIR servers) and publishes it at
 * the right moment. No posting cron on our side.
 *
 * Webhook: POST /api/webhooks/postforme — verified via the shared secret
 * header, acked instantly (<1s), processed async and idempotently.
 */

import { Router, type IRouter } from "express";
import { randomUUID } from "node:crypto";
import { requireUser } from "../middlewares/sessionAuth";
import { requireDb } from "../lib/db";
import { chargePostRow, needsPostCharge, sweepPostCreditRefunds } from "../lib/postCredits";
import { isDropboxFolderPath, dropboxLastSegment, DROPBOX_VIDEO_EXT } from "../lib/dropboxLink";
import {
  isPfmConfigured, PFM_PLATFORMS, type PfmPlatform,
  createAuthUrl, syncUserAccounts, getUserConnections, upsertConnection,
  verifyAccountOwnership, disconnectAccount, getPfmAccount, userIdFromExternalId,
  autoPostClips, getClipPostStatuses, friendlyPfmError, titleFromCaption,
  createPfmPost, deletePfmPost, refreshAggregateRows, isDefiniteReject, findPfmPostByExternalId,
  getWebhookSecrets, processWebhookEvent, getPublicAppBase,
  PfmApiError, retryYouTubeRateLimitedClipPosts,
} from "../lib/postforme";
import { resolveFile } from "../lib/fileStore";
import { createShareToken } from "../lib/clipShareToken";
import { createGDriveRelayToken } from "../lib/gdriveRelayToken";
import { createIgRelayToken } from "../lib/igRelayToken";
import { createTikTokRelayToken } from "../lib/tiktokRelayToken";
import {
  ensurePaddedVertical, createPaddedMediaToken, needsCompatibilityTranscode, type PadInput,
} from "../lib/verticalPad";
import { urlResolvesPublic } from "../lib/ssrfGuard";
import { extractGDriveId, resolveGDriveConfirmUrl } from "./videoTools";
import { igFreshVideoUrl } from "./instagram";
import { ttFreshVideoUrl } from "./tiktok";
import { enforceCaptionRequirements, normalizeCampaignRequirements, type CampaignRequirements } from "../lib/campaignRequirements";

const router: IRouter = Router();

/** Prefer requirement metadata saved with the clip. Request metadata only
 * bridges the short gap before a newly-finished clip's history row commits. */
async function campaignRequirementsForClip(
  userId: string,
  clipId: string,
  requestMetadata: unknown,
): Promise<CampaignRequirements | null> {
  const fallback = normalizeCampaignRequirements(requestMetadata);
  try {
    const { rows } = await requireDb().query<{ clips: unknown }>(
      `SELECT clips FROM clip_jobs
       WHERE user_id = $1 AND clips @> $2::jsonb
       ORDER BY created_at DESC LIMIT 1`,
      [userId, JSON.stringify([{ id: clipId }])],
    );
    const clips = Array.isArray(rows[0]?.clips) ? rows[0].clips : [];
    const stored = clips.find((clip) =>
      clip && typeof clip === "object" && (clip as Record<string, unknown>).id === clipId,
    );
    const saved = normalizeCampaignRequirements(
      stored && typeof stored === "object" ? (stored as Record<string, unknown>).campaignRequirements : null,
    );
    return saved ?? fallback;
  } catch {
    return fallback;
  }
}

// ── Source enumeration (no downloads — just URL/HTML parsing) ─────────────────

const VIDEO_EXT = /\.(mp4|mov|m4v|webm|mkv|avi)$/i;
const MAX_SOURCE_LINES = 300;   // pasted lines per request
const MAX_TOTAL_FILES  = 1000;  // videos per batch

export interface SourceFile { name: string; url: string; }

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCharCode(parseInt(n, 16)));
}

/** List video files in a PUBLIC Google Drive folder via the embedded folder
 *  view (no API key needed). Only works for "Anyone with the link" folders. */
async function listGDriveFolder(folderId: string): Promise<SourceFile[]> {
  const res = await fetch(
    `https://drive.google.com/embeddedfolderview?id=${encodeURIComponent(folderId)}`,
    { redirect: "follow", signal: AbortSignal.timeout(30_000) },
  );
  if (!res.ok) {
    throw new Error(`Google Drive folder is not accessible (HTTP ${res.status}). Share it as "Anyone with the link can view".`);
  }
  const html = await res.text();
  const out: SourceFile[] = [];
  const re = /id="entry-([-\w]+)"[\s\S]{0,2000}?flip-entry-title">([^<]+)</g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null && out.length < MAX_TOTAL_FILES) {
    const name = decodeEntities(m[2].trim());
    if (!VIDEO_EXT.test(name)) continue;
    out.push({ name, url: `https://drive.google.com/file/d/${m[1]}/view` });
  }
  return out;
}

/** Convert a Dropbox share link to a direct-download entry.
 *  Folder links need ?preview=<file>; returns null when not convertible. */
export function dropboxDirect(link: string): SourceFile | null {
  const u = new URL(link);
  // Folder shares — EXCEPT when the path continues into a specific file
  // (copying a file's link inside a shared folder appends the file subpath
  // to the folder prefix). Those convert like any other file link below.
  if (isDropboxFolderPath(u.pathname)) {
    const preview = u.searchParams.get("preview");
    if (!preview || !DROPBOX_VIDEO_EXT.test(preview)) return null;
    const dl = new URL(link);
    dl.hostname = "dl.dropboxusercontent.com";
    dl.pathname = dl.pathname.replace(/\/$/, "") + "/" + encodeURIComponent(preview);
    dl.searchParams.delete("preview");
    dl.searchParams.delete("dl");
    return { name: preview, url: dl.toString() };
  }
  const name = dropboxLastSegment(u.pathname);
  if (!DROPBOX_VIDEO_EXT.test(name)) return null;
  const dl = new URL(link);
  dl.hostname = "dl.dropboxusercontent.com";
  dl.searchParams.delete("dl");
  return { name, url: dl.toString() };
}

const gdriveFolderId = (u: URL): string | null =>
  u.pathname.match(/\/folders\/([-\w]+)/)?.[1] ?? null;

/** Direct video URLs are handed to the posting provider to fetch — refuse
 *  localhost / private-range / internal-looking hosts so we can't be used as
 *  a scheduling hop for URLs that were never meant to be public. */
export function isBlockedHost(host: string): boolean {
  const h = host.toLowerCase();
  if (h === "localhost" || h.endsWith(".local") || h.endsWith(".internal") || !h.includes(".")) return true;
  if (h.includes(":")) return true; // IPv6 literal
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const a = Number(m[1]), b = Number(m[2]);
    return (
      a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }
  return false;
}

/** Expand one pasted line into video entries (a Drive folder may yield many). */
export async function expandSource(line: string): Promise<{ files: SourceFile[]; skipped?: string }> {
  let u: URL;
  try { u = new URL(line); } catch { return { files: [], skipped: "not a valid link" }; }
  if (u.protocol !== "https:" && u.protocol !== "http:") {
    return { files: [], skipped: "not a web link" };
  }
  const h = u.hostname.replace(/^www\./, "");

  if (h === "drive.google.com") {
    const folderId = gdriveFolderId(u);
    if (folderId) {
      const files = await listGDriveFolder(folderId);
      return files.length > 0
        ? { files }
        : { files: [], skipped: "no videos found in this Drive folder (is it public?)" };
    }
    const fileId = extractGDriveId(line);
    if (fileId) return { files: [{ name: "", url: line }] };
    return { files: [], skipped: "unrecognized Google Drive link" };
  }

  if (h === "dropbox.com" || h.endsWith(".dropbox.com")) {
    const d = dropboxDirect(line);
    if (d) return { files: [d] };
    return { files: [], skipped: "Dropbox folder links need per-file links (open folder → Share → Copy link on each video, or add ?preview=file.mp4)" };
  }

  if (h === "dl.dropboxusercontent.com" || VIDEO_EXT.test(u.pathname)) {
    if (h !== "dl.dropboxusercontent.com") {
      // Literal + DNS check: a public-looking hostname that resolves to a
      // private/loopback/metadata address is refused (fail closed).
      if (isBlockedHost(u.hostname) || !(await urlResolvesPublic(line))) {
        return { files: [], skipped: "private/internal hosts are not allowed" };
      }
    }
    const name = decodeURIComponent(u.pathname.split("/").pop() ?? "video.mp4");
    return { files: [{ name, url: line }] };
  }

  return { files: [], skipped: "not a supported video link (Drive/Dropbox/direct .mp4)" };
}

// ── Posting-slot math (IANA timezone, no deps) ────────────────────────────────

/** Interpret `dateStr` (YYYY-MM-DD) + `timeStr` (HH:MM) as wall-clock time in
 *  `timeZone` and return the UTC instant. Two-pass offset probe handles DST. */
export function zonedTimeToUtc(dateStr: string, timeStr: string, timeZone: string): Date {
  const [y, mo, d] = dateStr.split("-").map(Number);
  const [hh, mm] = timeStr.split(":").map(Number);
  const wallUtc = Date.UTC(y, mo - 1, d, hh, mm, 0);
  const offsetAt = (t: number): number => {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone, hour12: false,
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    }).formatToParts(new Date(t));
    const p: Record<string, string> = {};
    for (const part of parts) p[part.type] = part.value;
    const asUtc = Date.UTC(
      Number(p.year), Number(p.month) - 1, Number(p.day),
      p.hour === "24" ? 0 : Number(p.hour), Number(p.minute), Number(p.second),
    );
    return asUtc - t;
  };
  let ts = wallUtc - offsetAt(wallUtc);
  ts = wallUtc - offsetAt(ts); // second pass for DST boundaries
  return new Date(ts);
}

export function addDaysStr(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** True only for real calendar dates — "2025-99-99" normalizes in JS Date and
 *  would silently schedule at an unintended moment. */
export function isRealDate(s: string): boolean {
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return false;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  if (y < 2020 || y > 2100) return false;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

/** One slot per video: day by day from startDate, at each time-of-day.
 *  Slots already in the past (or <5 min out) are skipped. */
export function computeSlots(count: number, startDate: string, times: string[], timeZone: string): Date[] {
  const sorted = [...times].sort();
  const minStart = Date.now() + 5 * 60_000;
  const slots: Date[] = [];
  for (let day = 0; slots.length < count && day < 3650; day++) {
    const dayStr = addDaysStr(startDate, day);
    for (const t of sorted) {
      if (slots.length >= count) break;
      const at = zonedTimeToUtc(dayStr, t, timeZone);
      if (at.getTime() < minStart) continue;
      slots.push(at);
    }
  }
  return slots;
}

export function prettyName(fileName: string): string {
  return fileName
    .replace(/\.[a-z0-9]+$/i, "")
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 150);
}

// ── Connect / accounts ────────────────────────────────────────────────────────

const CONNECTABLE = new Set<string>(PFM_PLATFORMS);

// Platforms with two login variants: PFM needs an explicit connection_type
// when both provider apps are enabled in its dashboard. Users pick the
// Instagram variant in the UI; for X we default to OAuth 2.0.
const CONNECTION_TYPES: Record<string, { allowed: string[]; fallback: string }> = {
  instagram: { allowed: ["instagram", "facebook"], fallback: "instagram" },
  x: { allowed: ["oauth1", "oauth2"], fallback: "oauth2" },
};

// POST /social/connect { platform, connectionType? } → fresh single-use OAuth URL
router.post("/social/connect", requireUser, async (req, res): Promise<void> => {
  if (!isPfmConfigured()) { res.status(503).json({ error: "Social posting is not configured yet — check back soon." }); return; }
  const body = (req.body ?? {}) as { platform?: string; connectionType?: string };
  const platform = String(body.platform ?? "").toLowerCase();
  if (!CONNECTABLE.has(platform)) {
    res.status(400).json({ error: `Unknown platform "${platform}". Supported: ${PFM_PLATFORMS.join(", ")}` });
    return;
  }
  const ctSpec = CONNECTION_TYPES[platform];
  const requestedType = String(body.connectionType ?? "").toLowerCase();
  const connectionType = ctSpec
    ? (ctSpec.allowed.includes(requestedType) ? requestedType : ctSpec.fallback)
    : undefined;
  try {
    const appBase = getPublicAppBase(req);
    const redirectUrl = `${appBase}/api/social/postforme/callback`;
    const url = await createAuthUrl(req.currentUser!.id, platform as PfmPlatform, redirectUrl, connectionType);
    res.json({ url });
  } catch (err) {
    req.log.error({ err: (err as Error).message }, "[social] connect auth-url failed");
    // Bluesky: PFM currently returns an empty URL (app-password platform,
    // no OAuth page) — tell the truth instead of a generic provider error.
    if (/did not return a connect URL/i.test((err as Error).message ?? "")) {
      res.status(409).json({
        error: platform === "bluesky"
          ? "Bluesky sign-in isn't available yet — the posting provider doesn't offer a login link for it."
          : "The posting provider didn't return a login link — try again shortly.",
      });
      return;
    }
    res.status(err instanceof PfmApiError && err.status === 404 ? 409 : 502).json({ error: friendlyPfmError(err) });
  }
});

// GET /social/postforme/callback — PFM redirects here after EVERY OAuth
// attempt (success and failure) with:
//   provider, projectId, isSuccess, accountIds, failedAccountIds, error
router.get("/social/postforme/callback", async (req, res): Promise<void> => {
  const q = req.query as Record<string, string | string[] | undefined>;
  const one = (k: string): string => {
    const v = q[k];
    return Array.isArray(v) ? String(v[0] ?? "") : String(v ?? "");
  };
  const isSuccess = /^true$/i.test(one("isSuccess"));
  const accountIds = one("accountIds").split(",").map((s) => s.trim()).filter(Boolean);
  const errText = one("error");

  // Import the freshly connected accounts. Session cookie survives the
  // top-level OAuth navigation (SameSite=Lax), but we ALSO resolve accounts
  // by id → external_id so the import works even without a session.
  try {
    const sessionUserId = req.currentUser?.id ?? null;
    if (sessionUserId) {
      await syncUserAccounts(sessionUserId);
    } else {
      for (const id of accountIds.slice(0, 20)) {
        const acc = await getPfmAccount(id).catch(() => null);
        const userId = userIdFromExternalId(acc?.external_id);
        if (acc && userId) await upsertConnection(userId, acc);
      }
    }
  } catch (err) {
    req.log.warn({ err: (err as Error).message }, "[social] callback account sync failed");
  }

  // Land back on the Social page (same origin serves the SPA in prod; the
  // dev proxy forwards /api and the SPA lives on the same dev domain).
  if (isSuccess && accountIds.length > 0) {
    res.redirect(`/social?connected=1&added=${accountIds.length}`);
  } else if (isSuccess) {
    res.redirect(`/social?connected=1`);
  } else {
    res.redirect(`/social?error=${encodeURIComponent((errText || "Connection failed or was cancelled").slice(0, 180))}`);
  }
});

// GET /social/accounts — live-synced list, grouped client-side by platform
router.get("/social/accounts", requireUser, async (req, res): Promise<void> => {
  const userId = req.currentUser!.id;
  try {
    if (isPfmConfigured()) {
      await syncUserAccounts(userId).catch((err: Error) => {
        req.log.warn({ err: err.message }, "[social] account sync failed — serving local mirror");
      });
    }
    const accounts = (await getUserConnections(userId)).map((c) => ({
      id: c.pfmAccountId,
      platform: c.platform,
      username: c.username,
      displayName: c.displayName,
      profileImage: c.profileImage,
      status: c.status,
      autopostEnabled: c.autopostEnabled,
    }));
    res.json({ accounts });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// PATCH /social/accounts/:id { autopostEnabled } — per-account auto-post toggle
router.patch("/social/accounts/:id", requireUser, async (req, res): Promise<void> => {
  const { autopostEnabled } = req.body as { autopostEnabled?: boolean };
  if (typeof autopostEnabled !== "boolean") { res.status(400).json({ error: "autopostEnabled must be boolean" }); return; }
  try {
    const upd = await requireDb().query(
      `UPDATE social_connections SET autopost_enabled=$3, updated_at=NOW()
       WHERE user_id=$1 AND pfm_account_id=$2`,
      [req.currentUser!.id, String(req.params.id), autopostEnabled],
    );
    if ((upd.rowCount ?? 0) === 0) { res.status(404).json({ error: "That account isn't connected to your profile." }); return; }
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: (err as Error).message }); }
});

// POST /social/disconnect { accountId }
router.post("/social/disconnect", requireUser, async (req, res): Promise<void> => {
  const accountId = String((req.body as { accountId?: string })?.accountId ?? "");
  if (!accountId) { res.status(400).json({ error: "accountId required" }); return; }
  const userId = req.currentUser!.id;
  try {
    const { owned } = await verifyAccountOwnership(userId, [accountId]);
    const mine = owned.length > 0 || (await getUserConnections(userId)).some((c) => c.pfmAccountId === accountId);
    if (!mine) { res.status(403).json({ error: "That account isn't connected to your profile." }); return; }
    await disconnectAccount(userId, accountId);
    res.json({ ok: true });
  } catch (err) {
    req.log.error({ err: (err as Error).message }, "[social] disconnect failed");
    res.status(502).json({ error: friendlyPfmError(err) });
  }
});

// GET /social/status — connection + auto-post summary for the header/UI
router.get("/social/status", requireUser, async (req, res): Promise<void> => {
  const userId = req.currentUser!.id;
  const prefRow = await requireDb().query<{ auto_post_enabled: boolean }>(
    `SELECT auto_post_enabled FROM social_user_prefs WHERE user_id = $1`, [userId],
  ).then((r) => r.rows[0]).catch(() => null);
  const autoPostEnabled = prefRow?.auto_post_enabled ?? true;
  try {
    const accounts = await getUserConnections(userId);
    const connected = accounts.filter((a) => a.status === "connected");
    res.json({
      configured: isPfmConfigured(),
      hasAccounts: connected.length > 0,
      accountCount: connected.length,
      activeCount: connected.filter((a) => a.autopostEnabled).length,
      autoPostEnabled,
    });
  } catch {
    res.json({ configured: isPfmConfigured(), hasAccounts: false, accountCount: 0, activeCount: 0, autoPostEnabled });
  }
});

// GET /social/prefs · PATCH /social/prefs — master auto-post toggle
router.get("/social/prefs", requireUser, async (req, res): Promise<void> => {
  try {
    const { rows } = await requireDb().query<{ auto_post_enabled: boolean }>(
      `SELECT auto_post_enabled FROM social_user_prefs WHERE user_id = $1`, [req.currentUser!.id],
    );
    res.json({ autoPostEnabled: rows[0]?.auto_post_enabled ?? true });
  } catch (err) {
    req.log.error({ err: (err as Error).message }, "[social] prefs read failed");
    res.status(500).json({ error: "Could not load the auto-post setting — try again." });
  }
});
router.patch("/social/prefs", requireUser, async (req, res): Promise<void> => {
  const { autoPostEnabled } = req.body as { autoPostEnabled?: boolean };
  if (typeof autoPostEnabled !== "boolean") { res.status(400).json({ error: "autoPostEnabled must be boolean" }); return; }
  try {
    await requireDb().query(
      `INSERT INTO social_user_prefs (user_id, auto_post_enabled, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (user_id) DO UPDATE SET auto_post_enabled = $2, updated_at = NOW()`,
      [req.currentUser!.id, autoPostEnabled],
    );
    res.json({ ok: true });
  } catch (err) {
    req.log.error({ err: (err as Error).message }, "[social] prefs save failed");
    res.status(500).json({ error: "Could not save the auto-post setting — try again." });
  }
});

// ── Publishing ────────────────────────────────────────────────────────────────

// POST /social/posts — publish ONE clip to selected accounts right now.
// Ownership enforced: any foreign/unknown account id → 403, nothing posted.
router.post("/social/posts", requireUser, async (req, res): Promise<void> => {
  const userId = req.currentUser!.id;
  const { clipId, caption, label, accountIds, force, youtubeTitle, captionRequirements } = req.body as {
    clipId?: string; caption?: string; label?: string;
    accountIds?: string[]; force?: boolean; youtubeTitle?: string; captionRequirements?: unknown;
  };
  if (!clipId) { res.status(400).json({ error: "clipId required" }); return; }
  if (!isPfmConfigured()) { res.status(503).json({ error: "Social posting is not configured." }); return; }
  try {
    let targetIds: string[] | undefined;
    if (Array.isArray(accountIds) && accountIds.length > 0) {
      const ids = accountIds.filter((x): x is string => typeof x === "string" && x.length > 0).slice(0, 50);
      const { owned, foreign } = await verifyAccountOwnership(userId, ids);
      if (foreign.length > 0) {
        res.status(403).json({ error: "One or more selected accounts don't belong to your profile — refresh and try again." });
        return;
      }
      if (owned.length === 0) {
        res.status(400).json({ error: "None of the selected accounts are connected — connect them on the Social page first." });
        return;
      }
      targetIds = owned.map((o) => o.pfmAccountId);
    }
    const requirements = await campaignRequirementsForClip(userId, clipId, captionRequirements);
    const safeCaption = requirements
      ? enforceCaptionRequirements(String(caption ?? label ?? "Clip"), requirements)
      : (caption ?? label ?? "Clip");
    const appBase = getPublicAppBase(req);
    const results = await autoPostClips(
      [{
        label: label ?? "Clip",
        caption: safeCaption,
        fileId: clipId,
        youtubeTitle: typeof youtubeTitle === "string" && youtubeTitle.trim() ? youtubeTitle.trim().slice(0, 95) : undefined,
      }],
      userId, appBase,
      req.log as { warn: (...a: unknown[]) => void; info: (...a: unknown[]) => void },
      targetIds,
      force === true ? { force: true } : undefined,
    );
    const r0 = results[0];
    if (!r0 || r0.noAccounts) {
      res.status(400).json({ error: "No social accounts connected — connect them on /social first." });
      return;
    }
    if (r0.fileMissing) {
      res.status(410).json({ error: "This clip's video file is no longer on the server — re-generate the clip, then post." });
      return;
    }
    if (r0.error && r0.postedAccounts.length === 0 && r0.alreadyPosted.length === 0) {
      res.status(502).json({ error: r0.error });
      return;
    }
    res.json({ ok: true, posted: r0.postedAccounts, alreadyPosted: r0.alreadyPosted });
  } catch (err) { res.status(500).json({ error: (err as Error).message }); }
});

// POST /social/posts/schedule — schedule ONE clip for later (PFM publishes).
router.post("/social/posts/schedule", requireUser, async (req, res): Promise<void> => {
  const userId = req.currentUser!.id;
  const { clipId, caption, label, accountIds, scheduledAt, youtubeTitle, captionRequirements } = req.body as {
    clipId?: string; caption?: string; label?: string; youtubeTitle?: string;
    accountIds?: string[]; scheduledAt?: string; captionRequirements?: unknown;
  };
  if (!clipId) { res.status(400).json({ error: "clipId required" }); return; }
  if (!isPfmConfigured()) { res.status(503).json({ error: "Social posting is not configured." }); return; }
  const at = new Date(String(scheduledAt ?? ""));
  if (Number.isNaN(at.getTime())) { res.status(400).json({ error: "scheduledAt must be an ISO datetime" }); return; }
  if (at.getTime() < Date.now() + 2 * 60_000) { res.status(400).json({ error: "Pick a time at least 2 minutes from now." }); return; }
  if (!Array.isArray(accountIds) || accountIds.length === 0) { res.status(400).json({ error: "Select at least one account." }); return; }

  try {
    const ids = accountIds.filter((x): x is string => typeof x === "string" && x.length > 0).slice(0, 50);
    const { owned, foreign } = await verifyAccountOwnership(userId, ids);
    if (foreign.length > 0) { res.status(403).json({ error: "One or more selected accounts don't belong to your profile — refresh and try again." }); return; }
    if (owned.length === 0) { res.status(400).json({ error: "None of the selected accounts are connected." }); return; }

    const resolved = await resolveFile(clipId).catch(() => null);
    if (!resolved) { res.status(410).json({ error: "This clip's video file is no longer on the server — re-generate the clip first." }); return; }
    const requirements = await campaignRequirementsForClip(userId, clipId, captionRequirements);
    const safeCaption = requirements
      ? enforceCaptionRequirements(String(caption ?? label ?? "Clip"), requirements)
      : (caption ?? label ?? "Clip");

    const db = requireDb();
    const ownedIds = owned.map((o) => o.pfmAccountId);
    // Claim markers so the same clip+account can't ALSO be posted now/auto
    const { rows: claimedRows } = await db.query<{ social_account_id: string }>(
      `INSERT INTO clip_account_posts (user_id, clip_id, social_account_id, platform, status)
       SELECT $1, $2, unnest($3::text[]), unnest($4::text[]), 'pending'
       ON CONFLICT (user_id, clip_id, social_account_id) DO NOTHING
       RETURNING social_account_id`,
      [userId, clipId, ownedIds, ownedIds.map((id) => owned.find((o) => o.pfmAccountId === id)?.platform ?? "")],
    );
    const claimed = claimedRows.map((r) => r.social_account_id);
    if (claimed.length === 0) {
      res.status(409).json({ error: "This clip is already posted or scheduled on the selected accounts." });
      return;
    }

    const appBase = getPublicAppBase(req);
    const token = await createShareToken(clipId, userId);
    const mediaUrl = `${appBase}/api/video/clip-share/${token}`;
    const rowId = randomUUID();
    await db.query(
      `UPDATE clip_account_posts SET post_row_id=$4, updated_at=NOW()
       WHERE user_id=$1 AND clip_id=$2 AND social_account_id = ANY($3) AND status='pending'`,
      [userId, clipId, claimed, rowId],
    );
    const platforms = [...new Set(owned.filter((o) => claimed.includes(o.pfmAccountId)).map((o) => o.platform))];
    await db.query(
      `INSERT INTO social_posts (id, user_id, source, clip_id, media_url, file_name, caption, account_ids, platforms, scheduled_at, status)
       VALUES ($1,$2,'clip',$3,$4,$5,$6,$7,$8,$9,'creating')`,
      [rowId, userId, clipId, mediaUrl, (label ?? "Clip").slice(0, 200), safeCaption, claimed, platforms, at],
    );
    // A generated clip consumed cutting credit when created; its provider
    // hand-off independently consumes one uploading credit.
    const charge = await chargePostRow(db, {
      id: rowId, user_id: userId, source: "clip", clip_id: clipId, media_url: mediaUrl,
    });
    if (!("ok" in charge) || !charge.ok) {
      await db.query(`DELETE FROM social_posts WHERE id=$1 AND status='creating'`, [rowId]);
      await db.query(
        `DELETE FROM clip_account_posts WHERE user_id=$1 AND clip_id=$2 AND social_account_id = ANY($3) AND status='pending'`,
        [userId, clipId, claimed],
      );
      if ("available" in charge) {
        res.status(402).json({ error: `This upload needs ${charge.needed} uploading credit but you have ${charge.available}.` });
      } else {
        res.status(409).json({ error: "This post changed while its upload credit was being reserved." });
      }
      return;
    }

    try {
      const post = await createPfmPost({
        caption: safeCaption,
        accountIds: claimed,
        mediaUrl,
        scheduledAt: at,
        externalId: rowId,
        youtubeTitle: platforms.includes("youtube")
          ? ((typeof youtubeTitle === "string" && youtubeTitle.trim() ? youtubeTitle.trim().slice(0, 95) : undefined)
              ?? titleFromCaption(safeCaption) ?? label ?? undefined)
          : undefined,
      });
      await db.query(
        `UPDATE clip_account_posts SET pfm_post_id=$4, status='submitted', updated_at=NOW()
         WHERE user_id=$1 AND clip_id=$2 AND social_account_id = ANY($3)`,
        [userId, clipId, claimed, post.id],
      );
      await db.query(
        `UPDATE social_posts SET pfm_post_id=$2, status='scheduled', updated_at=NOW() WHERE id=$1`,
        [rowId, post.id],
      );
      res.json({ ok: true, scheduled: claimed, scheduledAt: at.toISOString() });
    } catch (err) {
      if (isDefiniteReject(err)) {
        await db.query(
          `DELETE FROM clip_account_posts
           WHERE user_id=$1 AND clip_id=$2 AND social_account_id = ANY($3) AND status='pending' AND pfm_post_id IS NULL`,
          [userId, clipId, claimed],
        ).catch(() => {});
        await db.query(`UPDATE social_posts SET status='failed', error=$2, updated_at=NOW() WHERE id=$1`, [rowId, friendlyPfmError(err)]).catch(() => {});
        res.status(502).json({ error: friendlyPfmError(err) });
        return;
      }
      const found = await findPfmPostByExternalId(rowId).catch(() => null);
      if (found) {
        await db.query(
          `UPDATE clip_account_posts SET pfm_post_id=$4, status='submitted', updated_at=NOW()
           WHERE user_id=$1 AND clip_id=$2 AND social_account_id = ANY($3)`,
          [userId, clipId, claimed, found.id],
        ).catch(() => {});
        await db.query(`UPDATE social_posts SET pfm_post_id=$2, status='scheduled', updated_at=NOW() WHERE id=$1`, [rowId, found.id]).catch(() => {});
        res.json({ ok: true, scheduled: claimed, scheduledAt: at.toISOString() });
        return;
      }
      await db.query(
        `UPDATE clip_account_posts SET status='unknown', updated_at=NOW()
         WHERE user_id=$1 AND clip_id=$2 AND social_account_id = ANY($3) AND status='pending'`,
        [userId, clipId, claimed],
      ).catch(() => {});
      await db.query(`UPDATE social_posts SET status='unknown', error=$2, updated_at=NOW() WHERE id=$1`, [rowId, friendlyPfmError(err)]).catch(() => {});
      res.status(502).json({ error: "Scheduling status is unclear — we'll sort it out automatically, check the calendar in a minute." });
    }
  } catch (err) { res.status(500).json({ error: (err as Error).message }); }
});

// POST /social/clip-status — live per-account status for a set of clips
router.post("/social/clip-status", requireUser, async (req, res): Promise<void> => {
  const { clipIds } = req.body as { clipIds?: unknown };
  if (!Array.isArray(clipIds) || clipIds.length === 0) { res.json({ clips: {} }); return; }
  if (!isPfmConfigured()) { res.json({ clips: {} }); return; }
  const ids = [...new Set(
    clipIds.filter((x): x is string => typeof x === "string" && x.length > 0 && x.length <= 80),
  )].slice(0, 60);
  try {
    const clips = await getClipPostStatuses(req.currentUser!.id, ids);
    res.json({ clips });
  } catch (err) { res.status(500).json({ error: (err as Error).message }); }
});

// ── Bulk scheduler (Drive/Dropbox → PFM scheduled posts) ─────────────────────

export interface SocialPostRow {
  id: string; user_id: string; pfm_post_id: string | null; source: string;
  clip_id: string | null; batch_id: string | null; media_url: string | null;
  file_name: string; caption: string; account_ids: string[]; platforms: string[];
  scheduled_at: string | null; status: string; attempts: number; error: string | null;
  credit_sub_spent: number; credit_topup_spent: number; hold_until: string | null;
  yt_native_publish: boolean; yt_uploaded_at: string | null;
  created_at: string; updated_at: string;
}

// POST /social/schedule — create a batch of scheduled posts
router.post("/social/schedule", requireUser, async (req, res): Promise<void> => {
  const userId = req.currentUser!.id;
  const { sources, accountIds, times, startDate, timezone, caption } = req.body as {
    sources?: string[]; accountIds?: string[]; times?: string[];
    startDate?: string; timezone?: string; caption?: string;
  };

  if (!isPfmConfigured()) { res.status(503).json({ error: "Social posting is not configured." }); return; }
  if (!Array.isArray(sources) || sources.length === 0) { res.status(400).json({ error: "Paste at least one Drive/Dropbox link." }); return; }
  if (sources.length > MAX_SOURCE_LINES) { res.status(400).json({ error: `Too many links — max ${MAX_SOURCE_LINES} lines per batch.` }); return; }
  if (!Array.isArray(accountIds) || accountIds.length === 0) { res.status(400).json({ error: "Select at least one account." }); return; }
  const timesClean = Array.isArray(times) ? [...new Set(times.map((t) => String(t)))] : [];
  if (timesClean.length === 0 || timesClean.length > 12 ||
      timesClean.some((t) => !/^([01]\d|2[0-3]):[0-5]\d$/.test(t))) {
    res.status(400).json({ error: "Times must be 1-12 unique entries in HH:MM (24-hour) format." }); return;
  }
  if (!startDate || !isRealDate(startDate)) { res.status(400).json({ error: "startDate must be a real YYYY-MM-DD date." }); return; }
  const tz = typeof timezone === "string" && timezone ? timezone : "UTC";
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); }
  catch { res.status(400).json({ error: "Invalid timezone." }); return; }

  // Ownership: every selected account must belong to the CURRENT user
  const ids = accountIds.filter((x): x is string => typeof x === "string" && x.length > 0).slice(0, 50);
  const { owned, foreign } = await verifyAccountOwnership(userId, ids);
  if (foreign.length > 0) {
    res.status(403).json({ error: "One or more selected accounts don't belong to your profile — refresh and try again." });
    return;
  }
  if (owned.length === 0) {
    res.status(400).json({ error: "None of the selected accounts are connected — connect them on the Social page first." });
    return;
  }
  const validAccountIds = owned.map((a) => a.pfmAccountId);
  const platforms = [...new Set(owned.map((a) => a.platform))];

  // Expand every pasted line (Drive folders may add many files)
  const files: SourceFile[] = [];
  const skipped: { url: string; reason: string }[] = [];
  const seen = new Set<string>();
  for (const raw of sources) {
    const line = String(raw ?? "").trim();
    if (!line) continue;
    if (files.length >= MAX_TOTAL_FILES) { skipped.push({ url: line, reason: `batch is full (max ${MAX_TOTAL_FILES} videos)` }); continue; }
    try {
      const r = await expandSource(line);
      if (r.skipped) skipped.push({ url: line, reason: r.skipped });
      for (const f of r.files) {
        if (files.length >= MAX_TOTAL_FILES) break;
        if (seen.has(f.url)) continue;
        seen.add(f.url);
        files.push(f);
      }
    } catch (err) {
      skipped.push({ url: line, reason: (err as Error).message });
    }
  }
  if (files.length === 0) {
    res.status(400).json({ error: "No usable videos found in those links.", skipped });
    return;
  }

  const slots = computeSlots(files.length, startDate, timesClean, tz);
  if (slots.length < files.length) { res.status(400).json({ error: "Could not compute posting slots — check the start date." }); return; }

  const batchId = randomUUID();
  const custom = typeof caption === "string" ? caption.trim() : "";
  const rowIds: string[] = [], urls: string[] = [], names: string[] = [], caps: string[] = [], ats: string[] = [];
  files.forEach((f, i) => {
    const name = f.name || `Video ${i + 1}`;
    rowIds.push(randomUUID());
    urls.push(f.url);
    names.push(name);
    caps.push(custom || prettyName(name) || `Video ${i + 1}`);
    ats.push(slots[i].toISOString());
  });

  await requireDb().query(
    `INSERT INTO social_posts
       (id, user_id, source, batch_id, media_url, file_name, caption, account_ids, platforms, scheduled_at, status)
     SELECT unnest($1::text[]), $2, 'schedule', $3, unnest($4::text[]), unnest($5::text[]),
            unnest($6::text[]), $7::text[], $8::text[], unnest($9::timestamptz[]), 'queued'`,
    [rowIds, userId, batchId, urls, names, caps, validAccountIds, platforms, ats],
  );

  req.log.info({ batchId, total: files.length, skipped: skipped.length }, "[scheduler] batch created");
  setTimeout(() => { void drainScheduleQueue(); }, 100).unref();

  res.json({
    ok: true, batchId,
    scheduled: files.length, skipped,
    firstAt: ats[0], lastAt: ats[ats.length - 1],
  });
});

// GET /social/schedule — content calendar (bulk batches + scheduled clips)
router.get("/social/schedule", requireUser, async (req, res): Promise<void> => {
  const db = requireDb();
  const { rows } = await db.query<SocialPostRow & { post_at: string }>(
    `SELECT *, scheduled_at AS post_at FROM social_posts
     WHERE user_id = $1 AND scheduled_at IS NOT NULL
     ORDER BY scheduled_at ASC LIMIT 500`,
    [req.currentUser!.id],
  );

  // Live provider-truth refresh: near-due rows, plus 'posted' rows carrying an
  // error text (a failure result arrived after an optimistic promote).
  // 'processed' alone is NEVER success — per-account results decide.
  await refreshAggregateRows(rows);

  res.json({
    posts: rows.map((r) => ({
      id: r.id, batch_id: r.batch_id ?? r.id, source: r.source,
      file_name: r.file_name, caption: r.caption,
      platforms: r.platforms, account_ids: r.account_ids,
      post_at: r.post_at, status: r.status, error: r.error, created_at: r.created_at,
    })),
  });
});

/** Cancel one row: delete the provider-side post when it exists, then mark
 *  cancelled. Returns an error string (null = cancelled fine). */
export async function cancelRow(row: SocialPostRow): Promise<string | null> {
  const db = requireDb();
  if (row.status === "cancelled") return null;
  if (row.status === "posted" || row.status === "processing") return "already posted";
  if (row.status === "failed" || row.status === "deleted") {
    await db.query(`UPDATE social_posts SET status='cancelled', updated_at=NOW() WHERE id=$1`, [row.id]);
    return null;
  }
  if (row.status === "scheduled" && row.scheduled_at && new Date(row.scheduled_at).getTime() <= Date.now()) {
    return "already posted";
  }
  // Native YouTube scheduling: the video is already uploaded to YouTube
  // (private, with a publish time). Deleting the provider record would NOT
  // remove it from YouTube — a local "cancelled" would be a lie, the video
  // would still go public on time. Be honest instead of pretending.
  if (row.yt_native_publish && row.pfm_post_id) {
    return "already uploaded to YouTube as a scheduled video — open YouTube Studio → Content and delete it there if you don't want it to publish";
  }
  if (row.pfm_post_id) {
    try { await deletePfmPost(row.pfm_post_id); }
    catch (err) {
      return `could not cancel on provider: ${friendlyPfmError(err)}`;
    }
  }
  await db.query(`UPDATE social_posts SET status='cancelled', updated_at=NOW() WHERE id=$1`, [row.id]);
  // Scheduled-clip rows hold idempotency markers — free them so the clip can
  // be posted/scheduled again.
  if (row.source === "clip") {
    await db.query(
      `DELETE FROM clip_account_posts WHERE post_row_id=$1 AND status <> 'posted'`, [row.id],
    ).catch(() => {});
  }
  return null;
}

// DELETE /social/schedule/:id — cancel a single scheduled post
router.delete("/social/schedule/:id", requireUser, async (req, res): Promise<void> => {
  const { rows } = await requireDb().query<SocialPostRow>(
    `SELECT * FROM social_posts WHERE id = $1 AND user_id = $2`,
    [req.params.id, req.currentUser!.id],
  );
  if (rows.length === 0) { res.status(404).json({ error: "Not found" }); return; }
  const err = await cancelRow(rows[0]);
  if (err) { res.status(409).json({ error: err }); return; }
  res.json({ ok: true });
});

// POST /social/schedule/batch/:batchId/cancel — cancel the rest of a batch
router.post("/social/schedule/batch/:batchId/cancel", requireUser, async (req, res): Promise<void> => {
  const { rows } = await requireDb().query<SocialPostRow>(
    `SELECT * FROM social_posts
     WHERE batch_id = $1 AND user_id = $2 AND status IN ('queued','creating','scheduled','failed')`,
    [req.params.batchId, req.currentUser!.id],
  );
  let cancelled = 0, errors = 0;
  for (const row of rows) {
    const err = await cancelRow(row);
    if (err) errors++; else cancelled++;
  }
  res.json({ ok: true, cancelled, errors });
});

// ── Provider-handoff drain (NOT a posting cron — PFM publishes) ───────────────

/** Fresh direct-download URL for the provider to fetch. Drive confirm tokens
 *  are one-time, so this must run at handoff time, not enqueue time. */
export async function resolveDirectUrl(
  sourceUrl: string,
  ownerUserId?: string,
  scheduledAt?: Date | string | null,
): Promise<string> {
  // Auto-Pilot link campaigns store items as "clip:<fileId>" — mint a fresh
  // share token at handoff time (tokens expire; enqueue-time links would rot).
  if (sourceUrl.startsWith("clip:")) {
    if (!ownerUserId) throw new Error("Missing owner for clip media");
    const appBase = getPublicAppBase();
    if (!appBase) throw new Error("Server is missing its public URL (PUBLIC_APP_URL) — cannot hand media to the posting provider.");
    const token = await createShareToken(sourceUrl.slice("clip:".length), ownerUserId);
    return `${appBase}/api/video/clip-share/${token}`;
  }
  // Instagram campaign items are "ig:<username>:<kind>:<mediaId>" — hand the
  // provider OUR relay URL. The relay re-resolves a FRESH CDN URL at publish
  // time: Instagram's signed URLs rot within hours, and the provider may not
  // fetch for days.
  if (sourceUrl.startsWith("ig:")) {
    const m = sourceUrl.match(/^ig:([a-z0-9._]{1,30}):(post|reel):([A-Za-z0-9_-]{5,80})$/i);
    if (!m) throw new Error("Bad Instagram media reference");
    const appBase = getPublicAppBase();
    if (!appBase) throw new Error("Server is missing its public URL (PUBLIC_APP_URL) — cannot hand media to the posting provider.");
    const untilMs = scheduledAt ? new Date(scheduledAt).getTime() - Date.now() : 0;
    const token = createIgRelayToken(
      { username: m[1].toLowerCase(), kind: m[2].toLowerCase() === "reel" ? "reel" : "post", mediaId: m[3] },
      Date.now(),
      untilMs + 7 * 24 * 60 * 60 * 1000,
    );
    return `${appBase}/api/ig/relay/${token}`;
  }
  // TikTok campaign items are "tt:<username>:<videoId>". TikTok media URLs
  // expire quickly, so the provider receives a signed relay instead of the
  // URL captured during detection.
  if (sourceUrl.startsWith("tt:")) {
    const m = sourceUrl.match(/^tt:([a-z0-9._]{1,30}):([A-Za-z0-9_-]{1,120})$/i);
    if (!m) throw new Error("Bad TikTok media reference");
    const appBase = getPublicAppBase();
    if (!appBase) throw new Error("Server is missing its public URL (PUBLIC_APP_URL) — cannot hand media to the posting provider.");
    const untilMs = scheduledAt ? new Date(scheduledAt).getTime() - Date.now() : 0;
    const token = createTikTokRelayToken(
      { username: m[1].toLowerCase(), videoId: m[2] },
      Date.now(),
      untilMs + 7 * 24 * 60 * 60 * 1000,
    );
    return `${appBase}/api/tt/relay/${token}`;
  }
  const u = new URL(sourceUrl);
  const h = u.hostname.replace(/^www\./, "");
  if (h === "drive.google.com") {
    const id = extractGDriveId(sourceUrl);
    if (!id) throw new Error("Could not extract Google Drive file id");
    // The provider's fetcher chokes on Drive's confirm/one-time direct URLs
    // (observed live: every account failed with "All media failed to
    // process"). Hand it OUR relay URL instead — we re-resolve Drive fresh at
    // the moment the provider actually fetches the bytes.
    const appBase = getPublicAppBase();
    if (appBase) {
      // The token must outlive the PUBLISH moment (that's when the provider
      // fetches), not just the handoff — far-future schedules need longer TTLs.
      const untilMs = scheduledAt ? new Date(scheduledAt).getTime() - Date.now() : 0;
      const token = createGDriveRelayToken(id, Date.now(), untilMs + 7 * 24 * 60 * 60 * 1000);
      return `${appBase}/api/video/gdrive-relay/${token}`;
    }
    const confirmed = await resolveGDriveConfirmUrl(id).catch(() => null);
    return confirmed ?? `https://drive.google.com/uc?export=download&confirm=t&id=${id}`;
  }
  // Direct/Dropbox URLs: re-verify at handoff time (DNS may have changed
  // since enqueue — never hand a privately-resolving URL to the provider).
  if (h !== "dl.dropboxusercontent.com" && !(await urlResolvesPublic(sourceUrl))) {
    throw new Error("This video URL no longer resolves to a public host");
  }
  return sourceUrl;
}

/** Padded-9:16 relay URL for a campaign row's media, or null when the video
 *  is already square/vertical, too long for Shorts, or processing failed —
 *  callers fall back to the original URL (an unpadded post beats no post).
 *  Campaign-only: manual scheduled posts may be intentionally landscape
 *  (regular YouTube uploads); campaigns target Shorts/Reels-style feeds. */
async function verticalCampaignMediaUrl(row: SocialPostRow, directUrl: string): Promise<string | null> {
  try {
    const appBase = getPublicAppBase();
    if (!appBase) return null;
    const src = row.media_url ?? "";
    let input: PadInput | null = null;
    if (src.startsWith("clip:")) {
      const f = await resolveFile(src.slice("clip:".length));
      input = f ? { kind: "file", path: f.filePath } : null;
    } else if (src.startsWith("ig:")) {
      // Fetch the fresh CDN URL directly — going through our own public relay
      // route would burn its rate limit and add a pointless network hop.
      const m = src.match(/^ig:([a-z0-9._]{1,30}):(post|reel):([A-Za-z0-9_-]{5,80})$/i);
      const cdn = m
        ? await igFreshVideoUrl(m[1].toLowerCase(), m[2].toLowerCase() === "reel" ? "reel" : "post", m[3])
        : null;
      input = cdn ? { kind: "url", url: cdn } : null;
    } else if (src.startsWith("tt:")) {
      const m = src.match(/^tt:([a-z0-9._]{1,30}):([A-Za-z0-9_-]{1,120})$/i);
      const cdn = m ? await ttFreshVideoUrl(m[1].toLowerCase(), m[2]) : null;
      input = cdn ? { kind: "url", url: cdn } : null;
    } else {
      input = { kind: "url", url: directUrl };
    }
    if (!input) return null;
    // Phone/Drive .mov files are often HEVC/QuickTime. PFM may fetch them
    // successfully yet TikTok rejects the container/codec with the generic
    // "Failed to post to TikTok". Always normalize MOV/M4V to H.264/AAC MP4;
    // landscape videos are padded in the same single encode.
    const forceTranscode = needsCompatibilityTranscode(row.file_name);
    const paddedId = await ensurePaddedVertical(input, src || row.id, { forceTranscode });
    if (!paddedId) return null;
    const untilMs = row.scheduled_at ? new Date(row.scheduled_at).getTime() - Date.now() : 0;
    const token = createPaddedMediaToken(paddedId, Date.now(), untilMs + 7 * 24 * 60 * 60 * 1000);
    return `${appBase}/api/video/padded-relay/${token}`;
  } catch (err) {
    console.warn(`[scheduler] vertical pad skipped for row ${row.id}: ${(err as Error).message}`);
    return null;
  }
}

// Keep in sync with LATE_GRACE_MS in routes/campaigns.ts (the planner-side
// rule). Not imported: campaigns.ts imports from this module — avoid a cycle.
const CAMPAIGN_LATE_GRACE_MS = 30 * 60_000;

/** Native YouTube scheduling decision for one hand-off. Returns the datetime
 *  YouTube itself should publish at, or null to keep provider-side scheduling.
 *  Only campaign rows with a hand-off lead qualify: the lead window exists so
 *  the video sits visibly "Scheduled" in YouTube Studio until the slot — that
 *  only works when EVERY target account is YouTube (other platforms in the
 *  same provider post would publish instantly) and the slot is still ahead.
 *  Pure — exported for tests. */
export function youtubeNativePublishAt(args: {
  source: string;
  platforms: string[];
  scheduledAt: string | Date | null;
  leadMinutes: number | null;
  now?: number;
}): Date | null {
  if (args.source !== "campaign" || args.leadMinutes == null) return null;
  if (args.platforms.length === 0 || !args.platforms.every((p) => p === "youtube")) return null;
  if (!args.scheduledAt) return null;
  const at = new Date(args.scheduledAt);
  if (Number.isNaN(at.getTime())) return null;
  const now = args.now ?? Date.now();
  if (at.getTime() <= now + 2 * 60_000) return null; // too late — publish normally
  return at;
}

// Test-only claim scope: the drain tests run against the shared dev DB, and
// without a scope they would claim (and mutate) real pending rows of other
// users. Production always keeps this null — the predicate is a no-op then.
let claimScopeUserId: string | null = null;
export function __setClaimScopeForTests(userId: string | null): void {
  if (!process.env["VITEST"]) throw new Error("__setClaimScopeForTests is test-only");
  claimScopeUserId = userId;
}

/** Claim the next queued row (lease-based so instance crashes self-heal). */
async function claimNext(): Promise<SocialPostRow | null> {
  const { rows } = await requireDb().query<SocialPostRow>(
    `UPDATE social_posts
     SET status='creating', updated_at=NOW(),
         attempts = CASE WHEN status='creating' THEN attempts + 1 ELSE attempts END
     WHERE id = (
       SELECT id FROM social_posts
       WHERE source IN ('schedule','campaign')
         AND ($1::text IS NULL OR user_id = $1::text)
         -- Campaign "schedule ahead": campaigns with handoff_lead_minutes set
         -- want their posts handed to the platform only N minutes before the
         -- slot — until then the rows wait here, still editable/cancellable.
         -- NULL lead (or no campaign row) = hand off immediately (legacy),
         -- and manual 'schedule' rows never wait.
         AND (source <> 'campaign' OR scheduled_at IS NULL OR NOT EXISTS (
               SELECT 1 FROM social_campaigns sc
               WHERE sc.id = social_posts.batch_id
                 AND sc.handoff_lead_minutes IS NOT NULL
                 AND social_posts.scheduled_at > NOW() + make_interval(mins => sc.handoff_lead_minutes)))
         AND ((status = 'queued' AND (attempts = 0 OR updated_at < NOW() - INTERVAL '2 minutes')
               AND (hold_until IS NULL OR hold_until <= NOW()))
           OR (status = 'creating' AND updated_at < NOW() - INTERVAL '10 minutes' AND attempts < 3))
       ORDER BY scheduled_at
       LIMIT 1
       FOR UPDATE SKIP LOCKED
     )
     RETURNING *`,
    [claimScopeUserId],
  );
  return rows[0] ?? null;
}

async function handOffRow(row: SocialPostRow): Promise<void> {
  const db = requireDb();
  // Hoisted: the ambiguous-create recovery in the catch block must persist
  // the same native-mode flag the create attempt used.
  let ytNativeAt: Date | null = null;
  try {
    // Accounts may have been disconnected since enqueue — re-verify ownership
    const { owned } = await verifyAccountOwnership(row.user_id, row.account_ids);
    if (owned.length === 0) throw new Error("Selected social accounts are no longer connected");
    const ownedIds = owned.map((o) => o.pfmAccountId);

    // Late campaign slots are dead slots — mirrors the planner's grace rule at
    // hand-off. Without this, rows blocked for hours (empty credits, provider
    // outage) would all blast out in one burst the moment the block clears.
    // The campaign keeps planning fresh days; this slot is simply missed.
    if (row.source === "campaign" && row.scheduled_at &&
        Date.now() - new Date(row.scheduled_at).getTime() > CAMPAIGN_LATE_GRACE_MS) {
      await db.query(
        `UPDATE social_posts SET status='failed', error=$2, updated_at=NOW()
         WHERE id=$1 AND status='creating'`,
        [row.id, "Slot time passed before this could post (posting was blocked — e.g. out of credits). Future days are unaffected."],
      );
      return;
    }

    // Posting credits: non-clip media pays per push. Clips paid at generation;
    // Drive/Dropbox/Instagram/link media pays here — otherwise campaigns would
    // post unlimited free videos on any plan. Empty balance → the row waits
    // (hold_until) and resumes automatically after a top-up.
    if (needsPostCharge(row)) {
      const charge = await chargePostRow(db, row);
      if ("lostRace" in charge) return; // cancelled/reclaimed mid-charge — nothing committed
      if (!charge.ok) {
        const scheduledMs = row.scheduled_at ? new Date(row.scheduled_at).getTime() : Date.now();
        const giveUp = Date.now() - scheduledMs > 7 * 24 * 60 * 60_000; // week-old backlog: stop waiting
        await db.query(
          `UPDATE social_posts
           SET status=$2, hold_until=NOW() + INTERVAL '10 minutes', error=$3, updated_at=NOW()
           WHERE id=$1 AND status='creating'`,
          [row.id,
           giveUp ? "failed" : "queued",
           giveUp
             ? `Ran out of credits and the posting time passed over a week ago — this one was dropped. Top up and schedule it again.`
             : `Not enough credits — posting this video needs ${charge.needed} credits, you have ${charge.available}. Top up or subscribe; held posts resume automatically.`],
        );
        return;
      }
    }

    const directUrl = await resolveDirectUrl(row.media_url ?? "", row.user_id, row.scheduled_at);
    // Campaign videos: YouTube files uploads by shape alone — wider-than-tall
    // lands in the long-form feed even at reel length. Pad those onto a
    // blurred 9:16 canvas so campaign posts actually reach the Shorts feed.
    const mediaUrl = row.source === "campaign"
      ? (await verticalCampaignMediaUrl(row, directUrl)) ?? directUrl
      : directUrl;
    // Never schedule in the past — if we're late, post ~2 min from now.
    const postAt = new Date(Math.max(new Date(row.scheduled_at ?? Date.now()).getTime(), Date.now() + 2 * 60_000));
    // Campaigns with a hand-off lead + YouTube-only targets use YouTube's own
    // scheduler: the video uploads NOW (private, publish_at = slot), shows
    // under "Scheduled" in YouTube Studio for the whole lead window, and
    // YouTube itself makes it public exactly on time.
    if (row.source === "campaign" && row.batch_id) {
      const { rows: leadRows } = await db.query<{ handoff_lead_minutes: number | null }>(
        `SELECT handoff_lead_minutes FROM social_campaigns WHERE id=$1`,
        [row.batch_id],
      );
      ytNativeAt = youtubeNativePublishAt({
        source: row.source,
        platforms: owned.map((o) => o.platform),
        scheduledAt: row.scheduled_at,
        leadMinutes: leadRows[0]?.handoff_lead_minutes ?? null,
      });
    }
    const post = await createPfmPost({
      caption: row.caption,
      accountIds: ownedIds,
      mediaUrl,
      scheduledAt: ytNativeAt ? null : postAt,
      externalId: row.id,
      youtubeTitle: owned.some((o) => o.platform === "youtube")
        ? (titleFromCaption(row.caption) || prettyName(row.file_name) || row.file_name)
        : undefined,
      youtubePublishAt: ytNativeAt,
    });

    const upd = await db.query(
      `UPDATE social_posts
       SET status='scheduled', pfm_post_id=$2, account_ids=$3, platforms=$4, yt_native_publish=$5, error=NULL, updated_at=NOW()
       WHERE id = $1 AND status = 'creating'`,
      [row.id, post.id, ownedIds, [...new Set(owned.map((o) => o.platform))], ytNativeAt !== null],
    );
    if ((upd.rowCount ?? 0) === 0) {
      // Row was cancelled (or reclaimed) while we were creating — undo OUR
      // provider post so it can't publish.
      let undone = false;
      for (let i = 0; i < 3 && !undone; i++) {
        try { await deletePfmPost(post.id); undone = true; }
        catch { await new Promise((r) => setTimeout(r, 2_000 * (i + 1))); }
      }
      if (!undone) {
        await db.query(
          `UPDATE social_posts SET error=$2, updated_at=NOW() WHERE id=$1`,
          [row.id, "cancelled, but the provider-side post could not be deleted — it may still publish"],
        ).catch(() => {});
        console.error(`[scheduler] could not undo provider post ${post.id} for row ${row.id}`);
      }
      return;
    }
    console.log(`[scheduler] scheduled "${row.file_name}" for ${row.scheduled_at}`);
  } catch (err) {
    // Ambiguous create? The post may exist — recover it by our external id
    // before burning an attempt.
    if (!isDefiniteReject(err)) {
      const found = await findPfmPostByExternalId(row.id).catch(() => null);
      if (found) {
        await db.query(
          `UPDATE social_posts SET status='scheduled', pfm_post_id=$2, yt_native_publish=$3, error=NULL, updated_at=NOW()
           WHERE id=$1 AND status='creating'`,
          [row.id, found.id, ytNativeAt !== null],
        ).catch(() => {});
        return;
      }
    }
    const msg = friendlyPfmError(err).slice(0, 500);
    const attempts = (row.attempts ?? 0) + 1;
    const failed = attempts >= 3 || isDefiniteReject(err);
    await db.query(
      `UPDATE social_posts
       SET status = $2, attempts = $3, error = $4, updated_at = NOW()
       WHERE id = $1 AND status = 'creating'`,
      [row.id, failed ? "failed" : "queued", attempts, msg],
    ).catch(() => {});
    console.warn(`[scheduler] "${row.file_name}" attempt ${attempts} failed: ${(err as Error).message}`);
  }
}

let drainBusy = false;

/** Requeue recent Drive campaign posts that definitively failed on every
 * account because the old relay looked like a non-seekable octet stream.
 * attempts=0 is the one-time marker: the repaired handoff sets it to 1, so a
 * genuinely bad file cannot loop forever. Explicit all-account failure means
 * no platform received the old post, making this retry duplicate-safe. */
async function requeueDriveMediaCompatibilityFailures(): Promise<void> {
  const result = await requireDb().query(
    `UPDATE social_posts
     SET status='queued', pfm_post_id=NULL, attempts=1, hold_until=NULL,
         error='Retrying with the repaired MP4 media relay…', updated_at=NOW()
     WHERE source='campaign'
       AND status='failed'
       AND attempts=0
       AND scheduled_at > NOW() - INTERVAL '30 minutes'
       AND media_url LIKE 'https://drive.google.com/%'
       AND (
         error ILIKE '%All media failed to process%'
         OR error ILIKE '%Failed to post to TikTok%'
       )`,
  );
  if ((result.rowCount ?? 0) > 0) {
    console.log(`[scheduler] requeued ${result.rowCount} Drive media post(s) after relay compatibility repair`);
  }
}

export async function drainScheduleQueue(): Promise<void> {
  if (drainBusy) return;
  drainBusy = true;
  try {
    if (!isPfmConfigured()) {
      // Hand-offs can't run, but refunds for rows with a definite provider
      // outcome (pfm_post_id known) must not wait for configuration to return.
      await sweepPostCreditRefunds(requireDb()).catch(() => {});
      return;
    }
    await requeueDriveMediaCompatibilityFailures();
    // Up to 40 rows per tick, 4 hand-offs in flight at a time (claimNext is
    // FOR UPDATE SKIP LOCKED — concurrency-safe). Keeps popular posting times
    // (many users, same slot) from backing up, without hammering the provider.
    let budget = 40;
    await Promise.all(
      Array.from({ length: 4 }, async () => {
        while (budget > 0) {
          budget--;                        // reserve before awaiting
          const row = await claimNext();
          if (!row) break;
          await handOffRow(row);
        }
      }),
    );
    // Housekeeping: drop month-old cancelled rows; fail rows that kept
    // getting interrupted mid-handoff (claimNext stops reclaiming at 3).
    await requireDb().query(
      `DELETE FROM social_posts WHERE status='cancelled' AND updated_at < NOW() - INTERVAL '30 days'
         AND credit_sub_spent = 0 AND credit_topup_spent = 0`,
    ).catch(() => {});
    // Native-YT rows whose private upload was confirmed pre-slot flip to
    // 'posted' once the publish time passes: YouTube publishes on its own —
    // no webhook fires at that moment (PFM already reported 'processed').
    await requireDb().query(
      `UPDATE social_posts SET status='posted', updated_at=NOW()
       WHERE status='scheduled' AND yt_native_publish AND yt_uploaded_at IS NOT NULL
         AND scheduled_at <= NOW()`,
    ).catch(() => {});
    await requireDb().query(
      `UPDATE social_posts
       SET status='failed', error='hand-off kept getting interrupted (server restarts?) — cancel and re-add this one', updated_at=NOW()
       WHERE source IN ('schedule','campaign') AND status='creating' AND updated_at < NOW() - INTERVAL '10 minutes' AND attempts >= 3`,
    ).catch(() => {});
    // PFM accepted these clips but YouTube returned a per-account 429 while
    // opening its resumable upload session. The marker is an idempotent
    // distributed lock, so this remains safe across autoscaled instances.
    await retryYouTubeRateLimitedClipPosts(console).catch((err) => {
      console.warn("[scheduler] YouTube rate-limit retry failed:", (err as Error).message);
    });
    // Give back charges stuck on terminal rows — one idempotent place that
    // covers every failure/cancel writer (drain, endpoints, webhook, reconciler).
    // Provider ops let the sweep verify ambiguous rows (no pfm_post_id) by
    // external id before refunding — see sweepPostCreditRefunds.
    await sweepPostCreditRefunds(requireDb(), {
      find: (externalId) => findPfmPostByExternalId(externalId),
      remove: (pfmPostId) => deletePfmPost(pfmPostId),
    }).catch(() => {});
  } catch (err) {
    console.warn("[scheduler] tick failed:", (err as Error).message);
  } finally {
    drainBusy = false;
  }
}

// VITEST (not NODE_ENV) is the reliable test-process signal here — the
// workspace shell exports NODE_ENV=development globally, and a drain loop
// running inside a test process would claim REAL queued rows from the shared
// dev database under test mocks.
if (process.env.NODE_ENV !== "test" && process.env.VITEST === undefined) {
  setInterval(() => { void drainScheduleQueue(); }, 20_000).unref();
  setTimeout(() => { void drainScheduleQueue(); }, 5_000).unref();  // boot: resume pending rows
}

// ── Webhook (POST /webhooks/postforme) ────────────────────────────────────────
// PFM requires a 2xx within ONE second — verify, ack, then process async.
// Every delivery carries the shared secret in Post-For-Me-Webhook-Secret.
router.post("/webhooks/postforme", async (req, res): Promise<void> => {
  const given = String(req.headers["post-for-me-webhook-secret"] ?? "");
  // Bound the ack under PFM's 1s deadline even on a cold cache / slow DB:
  // fail closed (401) on timeout — PFM retries, and by then the cache is warm
  // (it's also primed at boot).
  const secrets = await Promise.race([
    getWebhookSecrets(),
    new Promise<null>((r) => { setTimeout(() => r(null), 700).unref(); }),
  ]);
  if (!secrets || !given || secrets.size === 0 || !secrets.has(given)) {
    res.status(401).json({ error: "invalid webhook secret" });
    return;
  }
  const body = req.body as unknown;
  res.json({ ok: true }); // ack instantly — retries are exponential over 24h
  setImmediate(() => {
    void processWebhookEvent(body, req.log as unknown as Console).catch(() => {});
  });
});

// ── Admin overview ────────────────────────────────────────────────────────────
// GET /admin/social/connections — who has connected what (replaces the old
// per-team view; PFM has no teams, just external_id-tagged accounts).
router.get("/admin/social/connections", requireUser, async (req, res): Promise<void> => {
  if (req.currentUser!.role !== "admin") { res.status(403).json({ error: "Admin only" }); return; }
  try {
    const { rows } = await requireDb().query(
      `SELECT c.user_id, u.username,
              COUNT(*)::int AS account_count,
              ARRAY_AGG(DISTINCT c.platform) AS platforms,
              MIN(c.created_at) AS first_connected
       FROM social_connections c
       LEFT JOIN users u ON u.id = c.user_id
       WHERE c.status = 'connected'
       GROUP BY c.user_id, u.username
       ORDER BY MIN(c.created_at) DESC`,
    );
    res.json({ configured: isPfmConfigured(), users: rows });
  } catch (err) { res.status(500).json({ error: (err as Error).message }); }
});

export default router;
