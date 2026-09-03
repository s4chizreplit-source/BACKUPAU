/**
 * Kick fallback-source resolution, extracted from routes/videoTools.ts so the
 * selection logic is unit-testable with a mocked API function.
 *
 * Kick's Cloudflare blocks Node's fetch by TLS fingerprint (HTTP 403), so the
 * real API caller shells out to curl (see kickApiJson in videoTools.ts). All
 * functions here take that caller as an injected dependency (`KickApiJson`).
 */

export interface KickVideoEntry {
  source?: string;
  is_live?: boolean;
  start_time?: string;
  video?: { uuid?: string; source?: string };
}

/** The injected API caller. Returns parsed JSON, null on soft failure
 *  (timeout, bad JSON), or throws KickBlockedError on an HTTP-level block. */
export type KickApiJson = (apiUrl: string) => Promise<unknown | null>;

/** Thrown when Kick's API answers with a non-2xx status — i.e. Kick is
 *  actively refusing our request (bot blocking), not a transient failure. */
export class KickBlockedError extends Error {
  readonly status: number;
  constructor(status: number, apiUrl: string) {
    super(`Kick API blocked the request (HTTP ${status}) for ${apiUrl}`);
    this.name = "KickBlockedError";
    this.status = status;
  }
}

/** User-facing message when Kick is blocking our server's API requests. */
export const KICK_BLOCKED_MESSAGE =
  "Kick is currently blocking requests from our server, so this video can't be fetched right now. This is usually temporary — please try again in a few minutes.";

/** User-facing message when the video simply couldn't be resolved. */
export const KICK_NOT_FOUND_MESSAGE =
  "Could not download this Kick video. It may be deleted or private — or Kick briefly blocked our server. Please try again in a minute.";

/** Extract the HTTP status from a curl --fail error message, or null when the
 *  failure wasn't an HTTP error (timeout, DNS, etc.).
 *  curl -sS --fail prints: `curl: (22) The requested URL returned error: 403` */
export function curlHttpStatus(message: string): number | null {
  const m = message.match(/returned error:\s*(\d{3})/i);
  return m ? Number(m[1]) : null;
}

/** Parse a kick.com URL into its VOD uuid (if any) and channel slug (if any).
 *  kick.com/video/{uuid} links carry no channel slug. */
export function parseKickUrl(videoUrl: string): { uuid: string | null; channel: string | null } {
  const uuid = videoUrl.match(/\/videos?\/([0-9a-f][0-9a-f-]{20,})/i)?.[1]?.toLowerCase() ?? null;
  const chan = videoUrl.match(/kick\.com\/([^/?#]+)/i)?.[1];
  const channel = chan && !["video", "videos"].includes(chan.toLowerCase()) ? chan : null;
  return { uuid, channel };
}

/** Kick's newer /{channel}/videos/{uuid} links carry a UUIDv7 whose embedded
 *  48-bit timestamp equals the VOD's start time — but the public APIs (v1
 *  video, channel videos list) still key everything by the legacy v4 uuid and
 *  404 on the v7 id. Milliseconds since epoch from a v7 uuid, or null. */
export function uuidV7TimeMs(uuid: string): number | null {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(uuid)) return null;
  const ms = parseInt(uuid.replace(/-/g, "").slice(0, 12), 16);
  return Number.isFinite(ms) ? ms : null;
}

/** Kick timestamps arrive as "2026-08-09 22:27:40" (UTC, no zone marker) or
 *  ISO 8601. Epoch ms, or null when absent/unparseable. */
export function parseKickTimeMs(s: string | undefined): number | null {
  if (!s) return null;
  const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s) ? `${s.replace(" ", "T")}Z` : s;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

/** Resolve a UUIDv7 link against the channel videos list by TIMESTAMP: the
 *  entry whose start_time is nearest the uuid's embedded time (≤10 min — in
 *  practice they match to the second). Ids minted mid-session fall back to
 *  the live entry. Undefined for v4 uuids or when nothing plausibly fits. */
export function matchEntryByV7Time(videos: unknown, uuid: string): KickVideoEntry | undefined {
  const v7ms = uuidV7TimeMs(uuid);
  if (v7ms === null) return undefined;
  const list = Array.isArray(videos) ? (videos as KickVideoEntry[]) : [];
  let best: KickVideoEntry | undefined;
  let bestDiff = Infinity;
  for (const e of list) {
    const st = parseKickTimeMs(e.start_time);
    if (st === null) continue;
    const diff = Math.abs(v7ms - st);
    if (diff < bestDiff) { best = e; bestDiff = diff; }
  }
  if (best && bestDiff <= 10 * 60_000) return best;
  const live = list.find((v) => v.is_live);
  const liveStart = live ? parseKickTimeMs(live.start_time) : null;
  if (live && liveStart !== null && v7ms >= liveStart - 60_000) return live;
  return undefined;
}

/** Pick the m3u8 source from a channel videos list for the DOWNLOAD path:
 *  prefer the exact VOD from the URL (legacy v4 uuid), then a UUIDv7
 *  timestamp match; for bare channel links, the live entry. */
export function pickDownloadSource(videos: unknown, uuid: string | null): string {
  const list = Array.isArray(videos) ? (videos as KickVideoEntry[]) : [];
  const match =
    (uuid ? list.find((v) => v.video?.uuid?.toLowerCase() === uuid) : undefined) ??
    (uuid ? matchEntryByV7Time(list, uuid) : list.find((v) => v.is_live));
  return match?.source || match?.video?.source || "";
}

/** Pick the m3u8 source from a channel videos list for the LIVE path:
 *  only `is_live` entries qualify (matched to the URL's uuid exactly, by
 *  UUIDv7 timestamp, or unconditionally for bare channel links). */
export function pickLiveSource(videos: unknown, uuid: string | null): string {
  const list = Array.isArray(videos) ? (videos as KickVideoEntry[]) : [];
  const v7Match = uuid ? matchEntryByV7Time(list, uuid) : undefined;
  const liveEntry =
    list.find((v) => v.is_live && (!uuid || v.video?.uuid?.toLowerCase() === uuid)) ??
    (v7Match?.is_live ? v7Match : undefined);
  return liveEntry?.source || liveEntry?.video?.source || "";
}

/**
 * Resolve the fallback m3u8 source for a Kick URL when yt-dlp has failed.
 * Tries the direct video API (uuid links), then the channel videos list.
 * Throws a user-readable error: KICK_BLOCKED_MESSAGE when every attempt was
 * actively blocked by Kick, otherwise KICK_NOT_FOUND_MESSAGE.
 */
export async function resolveKickFallbackSource(videoUrl: string, api: KickApiJson): Promise<string> {
  const { uuid, channel } = parseKickUrl(videoUrl);
  let blocked = false;
  let attempted = false;

  // Direct video lookup — covers kick.com/video/{uuid} links with no channel slug.
  if (uuid) {
    attempted = true;
    try {
      const v = (await api(`https://kick.com/api/v1/video/${uuid}`)) as { source?: string } | null;
      if (v?.source) return v.source;
    } catch (e) {
      if (e instanceof KickBlockedError) blocked = true;
      else throw e;
    }
  }

  // Channel videos list — matches a uuid VOD or, for bare channel links, the live entry.
  if (channel) {
    attempted = true;
    try {
      const videos = await api(`https://kick.com/api/v2/channels/${channel}/videos?page=1&limit=20`);
      const src = pickDownloadSource(videos, uuid);
      if (src) return src;
      if (videos !== null) blocked = false; // got a real answer — video genuinely missing
    } catch (e) {
      if (e instanceof KickBlockedError) blocked = true;
      else throw e;
    }
  }

  void attempted;
  throw new Error(blocked ? KICK_BLOCKED_MESSAGE : KICK_NOT_FOUND_MESSAGE);
}

/**
 * Resolve the in-progress live recording's m3u8 for a Kick URL, or null when
 * no live source can be found. Blocked responses also yield null — the live
 * path is best-effort and the caller falls through to its normal handling.
 */
export async function resolveKickLiveSrc(videoUrl: string, api: KickApiJson): Promise<string | null> {
  const { uuid, channel } = parseKickUrl(videoUrl);
  let src = "";
  if (channel) {
    try {
      const videos = await api(`https://kick.com/api/v2/channels/${channel}/videos?page=1&limit=20`);
      src = pickLiveSource(videos, uuid);
    } catch (e) {
      if (!(e instanceof KickBlockedError)) throw e;
    }
  }
  // kick.com/video/{uuid} links carry no channel slug — try the direct video API
  if (!src && uuid) {
    try {
      const v = (await api(`https://kick.com/api/v1/video/${uuid}`)) as { source?: string } | null;
      src = v?.source ?? "";
    } catch (e) {
      if (!(e instanceof KickBlockedError)) throw e;
    }
  }
  return src || null;
}

/**
 * Strict allowlist for a BROWSER-resolved Kick media source ("kickSrc" hint).
 * Kick's Cloudflare often bot-blocks datacenter IPs while the user's own
 * browser is never challenged — so the UI resolves the VOD's IVS m3u8 itself
 * and sends it along with the job. That makes the value user-controlled input:
 * only Kick's own IVS VOD host may pass, so the hint can never be abused to
 * point the server's downloader at arbitrary URLs (SSRF).
 */
export function isValidKickIvsSrc(raw: unknown): raw is string {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 2048) return false;
  let u: URL;
  try { u = new URL(raw); } catch { return false; }
  return (
    u.protocol === "https:" &&
    u.hostname === "stream.kick.com" &&
    u.port === "" &&
    u.username === "" &&
    u.password === "" &&
    u.pathname.toLowerCase().endsWith(".m3u8")
  );
}
