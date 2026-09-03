/**
 * ZylaLabs "YouTube Download and Info API" (#11016) — the download engine
 * behind the site's Downloader page.
 *
 * Live-verified contract (July 2026):
 *   START (auth'd, consumes monthly quota — the ONLY call that does):
 *     GET https://zylalabs.com/api/11016/youtube+download+and+info+api/20761/download?url=<YT_URL>&format=<FMT>
 *     Header: authorization: Bearer <ZYLA_API_KEY>
 *     → { success: true, id, image, progress_url }
 *   PROGRESS (no auth, free):
 *     GET <progress_url> → { success:1, progress:0..1000, text, download_url?, title?, duration? }
 *     Done when download_url appears. text matching /error|fail/i ⇒ failure.
 *   download_url 302-redirects to a presigned Cloudflare R2 file (~7 days,
 *   range/resume support, filename via content-disposition).
 *
 * Hard rules:
 *   - ZYLA_API_KEY lives server-side only; never in client code, URLs or logs.
 *   - NEVER pipe file bytes through this server — always redirect the browser
 *     to download_url (zero egress for us).
 *   - Cache url+format → download_url for 6 days; a repeat download must not
 *     start a new Zyla job (every start costs quota).
 *   - Accept ONLY YouTube URLs / 11-char ids. Per-IP rate limiting on starts.
 */
import { Router, type IRouter, type Request, type Response } from "express";
import { randomUUID } from "crypto";
import rateLimit from "express-rate-limit";
import { logger } from "../lib/logger";
import { getCachedMirror, putCachedMirror, deleteCachedMirror } from "../lib/zylaCache";
import { acquireZylaLease, publishZylaLease, releaseZylaLease } from "../lib/durableJobs";

// ── Config ────────────────────────────────────────────────────────────────────
const ZYLA_START_BASE =
  "https://zylalabs.com/api/11016/youtube+download+and+info+api/20761/download";
const FALLBACK_BASE = "https://yt-downloader-rose-six.vercel.app/download";

const FORMATS = new Set(["360", "480", "720", "1080", "1440", "2160", "mp3"]);
const CACHE_TTL_MS = 6 * 24 * 60 * 60 * 1000; // 6 days (links valid ~7)
const JOB_TIMEOUT_MS = Number(process.env["YT_JOB_TIMEOUT_MS"] ?? 240_000);
// A Zyla conversion that outlives a caller's patience is still money already
// spent — a detached finish-watcher keeps polling (free) up to this cap so the
// result lands in the cache and the NEXT attempt is instant + free.
const JOB_WATCH_CAP_MS = Math.max(JOB_TIMEOUT_MS, Number(process.env["YT_JOB_WATCH_CAP_MS"] ?? 20 * 60_000));
const WATCH_POLL_INTERVAL_MS = 5_000;
// Exact timeout text doubles as a marker: a job failed with THIS error is not
// dead — the engine is still converting; longer-budget callers may resurrect it.
const TIMEOUT_ERROR_TEXT = "Timed out preparing this video. Try again or use the backup server.";
const POLL_FETCH_TIMEOUT_MS = 15_000;
// Progress polls are free (only starts consume quota) — poll snappily so a
// finished conversion is picked up within ~2.5s instead of ~4.5s.
const SERVER_POLL_INTERVAL_MS = Number(process.env["YT_POLL_INTERVAL_MS"] ?? 2_500);

function apiKey(): string | undefined {
  return process.env["ZYLA_API_KEY"] || undefined;
}

// ── YouTube URL / id validation ───────────────────────────────────────────────
const ID_RE = /^[A-Za-z0-9_-]{11}$/;

/** Returns the 11-char video id, or null if the input is not YouTube. */
export function parseYouTubeId(raw: string): string | null {
  const input = (raw ?? "").trim();
  if (ID_RE.test(input)) return input;
  let u: URL;
  try {
    u = new URL(/^https?:\/\//i.test(input) ? input : `https://${input}`);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase().replace(/^(www|m|music)\./, "");
  if (host === "youtu.be") {
    const id = u.pathname.split("/")[1] ?? "";
    return ID_RE.test(id) ? id : null;
  }
  if (host !== "youtube.com") return null;
  const v = u.searchParams.get("v");
  if (v && ID_RE.test(v)) return v;
  const m = u.pathname.match(/^\/(?:shorts|live|embed)\/([A-Za-z0-9_-]{11})(?:\/|$)/);
  return m?.[1] ?? null;
}

function watchUrl(videoId: string): string {
  return `https://www.youtube.com/watch?v=${videoId}`;
}

function fallbackUrlFor(videoId: string, format: string): string | undefined {
  if (format === "mp3") return undefined; // backup server has no mp3
  return `${FALLBACK_BASE}?url=${encodeURIComponent(watchUrl(videoId))}&quality=${format}`;
}

// ── Upstream URL trust boundary ───────────────────────────────────────────────
// Zyla hands us progress_url (we fetch it server-side) and download_url (we
// 302 the browser to it). Never trust them blindly: require https and a public
// host so a compromised/misbehaving upstream can't turn us into an SSRF proxy
// or an open redirect into private networks.
function isSafePublicHttps(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== "https:") return false;
  const h = u.hostname.toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal")) return false;
  if (h.startsWith("[")) return false; // no IPv6 literals
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (
      a === 0 || a === 10 || a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a >= 224
    ) return false;
  }
  return true;
}

/** progress_url validation. Zyla does NOT host the progress endpoint on its
 *  own domain — live responses point at third-party infra (observed:
 *  youtube-api-progress-*.up.railway.app), so pinning to zylalabs.com broke
 *  every real start. The URL comes from Zyla's authenticated 200 response;
 *  we enforce the SSRF properties that actually matter (https only, public
 *  host, no private/reserved ranges) and nothing stricter. */
function isZylaProgressUrl(raw: string): boolean {
  return isSafePublicHttps(raw);
}

// ── In-memory state ───────────────────────────────────────────────────────────
interface YtJob {
  jobId: string;
  videoId: string;
  format: string;
  progressUrl: string;
  createdAt: number;
  progress: number; // 0-100
  statusText: string;
  done: boolean;
  failed: boolean;
  error?: string;
  downloadUrl?: string;
  title?: string;
  watcherStarted?: boolean;
  /** Cross-instance lease token. Only its owner may delete the shared lock. */
  durableLeaseToken?: string;
}

const jobs = new Map<string, YtJob>();
const cache = new Map<string, { downloadUrl: string; title?: string; expiresAt: number }>();
const cacheKey = (videoId: string, format: string) => `${videoId}|${format}`;

// In-flight dedupe: concurrent requests for the same video+format share ONE
// paid Zyla start instead of each burning quota (cache only helps after done).
const inflight = new Map<string, Promise<YtJob | StartFailure>>();

// ── Failure notes for the clip pipeline ──────────────────────────────────────
// When the engine can't source a video, the clip job falls back to yt-dlp and
// may end in the "YouTube is limiting this video to 360p" error. That message
// must say WHY the engine bailed (quota? key missing? still converting?) —
// otherwise the admin is sent chasing cookies when the real fix is elsewhere.
export type ZylaFailKind =
  | "not_configured" | "auth" | "quota" | "unreachable"
  | "start_failed" | "engine_failed" | "timeout";

interface StartFailure { startError: string; status: number; kind: ZylaFailKind }

const ZYLA_FAIL_NOTES: Record<ZylaFailKind, string> = {
  not_configured: "the download engine is not set up on this server (ZYLA_API_KEY missing)",
  auth: "the download engine rejected this server's API key",
  quota: "the download engine hit its rate/quota limit",
  unreachable: "the download engine could not be reached",
  start_failed: "the download engine could not start this video",
  engine_failed: "the download engine reported an error for this video",
  timeout: "the download engine was still converting it when we stopped waiting",
};

const ZYLA_FAIL_NOTE_TTL_MS = 15 * 60_000; // covers one full clip-job attempt
const recentZylaFailures = new Map<string, { kind: ZylaFailKind; at: number }>();

function noteZylaFailure(videoId: string, kind: ZylaFailKind): void {
  recentZylaFailures.set(videoId, { kind, at: Date.now() });
}
function clearZylaFailure(videoId: string): void {
  recentZylaFailures.delete(videoId);
}

/** Why the engine last failed for this video (within ~15 min), for error
 *  composition in the clip pipeline. Null when it never failed / succeeded
 *  since / the URL is not YouTube. */
export function getRecentZylaFailureNote(youtubeUrl: string): { kind: ZylaFailKind; note: string } | null {
  const videoId = parseYouTubeId(youtubeUrl);
  if (!videoId) return null;
  const hit = recentZylaFailures.get(videoId);
  if (!hit || Date.now() - hit.at > ZYLA_FAIL_NOTE_TTL_MS) return null;
  return { kind: hit.kind, note: ZYLA_FAIL_NOTES[hit.kind] };
}

/** Returns the active job for videoId+format, starting a new Zyla job only if none is running. */
async function getOrStartJob(videoId: string, format: string): Promise<YtJob | StartFailure> {
  const key = cacheKey(videoId, format);
  for (;;) {
    const existing = inflight.get(key);
    if (!existing) break;
    const j = await existing.catch(() => null);
    if (j && !("startError" in j) && Date.now() - j.createdAt <= JOB_WATCH_CAP_MS) {
      // A timeout-failed job is NOT dead — the engine is still converting and
      // the finish-watcher is polling it. Join it instead of paying for a
      // duplicate start of the same conversion.
      if (!j.failed || j.error === TIMEOUT_ERROR_TEXT) return j;
    }
    // Stale/failed entry — remove it ONLY if it is still this exact entry.
    // If a parallel caller already replaced it with a fresh start, loop and
    // inspect the replacement instead of racing a duplicate paid start.
    if (inflight.get(key) === existing) {
      inflight.delete(key);
      break;
    }
  }
  // PostgreSQL protects the expensive START call across autoscale instances.
  // A sibling either gives us its published progress URL to join, or we wait
  // briefly for that tiny start→publish window instead of buying a duplicate.
  let durableLease;
  for (let attempt = 0; attempt < 5; attempt++) {
    durableLease = await acquireZylaLease(videoId, format);
    if (durableLease.acquired) break;
    if (durableLease.progressUrl && durableLease.upstreamJobId) {
      const joined: YtJob = {
        jobId: durableLease.upstreamJobId,
        videoId,
        format,
        progressUrl: durableLease.progressUrl,
        createdAt: Date.now(),
        progress: 0,
        statusText: "Joining existing conversion…",
        done: false,
        failed: false,
      };
      jobs.set(joined.jobId, joined);
      return joined;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (!durableLease?.acquired) {
    noteZylaFailure(videoId, "unreachable");
    return { startError: "Another server is preparing this video. Please try again in a moment.", status: 503, kind: "unreachable" };
  }
  const leaseToken = durableLease.token!;
  const p = startZylaJob(videoId, format, leaseToken);
  inflight.set(key, p); // set synchronously so parallel callers join this promise
  const job = await p;
  if ("startError" in job && inflight.get(key) === p) {
    inflight.delete(key);
    void releaseZylaLease(videoId, format, leaseToken);
  }
  return job;
}

/** Remove the inflight entry for a job — but only if the entry still belongs
 *  to THAT job. A stale actor (old watcher, old poller) must never delete a
 *  REPLACEMENT start's entry, or a third caller buys a duplicate conversion. */
function releaseInflightFor(job: YtJob): void {
  const key = cacheKey(job.videoId, job.format);
  const cur = inflight.get(key);
  if (!cur) return;
  void cur
    .then((j) => {
      if (!("startError" in j) && j.jobId === job.jobId && inflight.get(key) === cur) {
        inflight.delete(key);
      }
    })
    .catch(() => { /* a rejected entry is cleaned up by its own starter */ });
  if (job.durableLeaseToken) {
    void releaseZylaLease(job.videoId, job.format, job.durableLeaseToken);
  }
}

// Sweep expired cache entries and stale job records so memory stays bounded.
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of cache) if (v.expiresAt <= now) cache.delete(k);
  for (const [k, j] of jobs) if (now - j.createdAt > 60 * 60 * 1000) jobs.delete(k);
  for (const [k, v] of recentZylaFailures) if (now - v.at > ZYLA_FAIL_NOTE_TTL_MS) recentZylaFailures.delete(k);
}, 30 * 60 * 1000).unref();

// ── Zyla calls ────────────────────────────────────────────────────────────────
async function fetchJson(url: string, init?: RequestInit): Promise<{ ok: boolean; status: number; json: Record<string, unknown> }> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), POLL_FETCH_TIMEOUT_MS);
  try {
    const res = await globalThis.fetch(url, { ...init, signal: ctrl.signal });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { ok: res.ok, status: res.status, json };
  } finally {
    clearTimeout(t);
  }
}

/** Starts a Zyla job (consumes quota). Returns the job record or an error. */
async function startZylaJob(videoId: string, format: string, durableLeaseToken?: string): Promise<YtJob | StartFailure> {
  const key = apiKey();
  if (!key) {
    noteZylaFailure(videoId, "not_configured");
    return { startError: "Downloader engine is not configured yet.", status: 503, kind: "not_configured" };
  }

  const url = `${ZYLA_START_BASE}?url=${encodeURIComponent(watchUrl(videoId))}&format=${encodeURIComponent(format)}`;
  let resp;
  try {
    resp = await fetchJson(url, { headers: { authorization: `Bearer ${key}` } });
  } catch {
    noteZylaFailure(videoId, "unreachable");
    return { startError: "Could not reach the download service. Try again in a moment.", status: 502, kind: "unreachable" };
  }
  const progressUrl = typeof resp.json["progress_url"] === "string" ? (resp.json["progress_url"] as string) : "";
  if (!resp.ok || !resp.json["success"] || !progressUrl || !isZylaProgressUrl(progressUrl)) {
    // 401/403 → key or subscription problem; 429 → provider rate/quota.
    const kind: ZylaFailKind =
      resp.status === 401 || resp.status === 403 ? "auth"
      : resp.status === 429 ? "quota"
      : "start_failed";
    const reason =
      kind === "auth"
        ? "Download service rejected our credentials (check the subscription)."
        : kind === "quota"
          ? "Download service rate/quota limit hit. Try again shortly."
          : "Download service could not start this video.";
    noteZylaFailure(videoId, kind);
    logger.warn({ videoId, format, zylaStatus: resp.status }, "[zyla] start failed");
    return { startError: reason, status: 502, kind };
  }

  const job: YtJob = {
    jobId: randomUUID(),
    videoId,
    format,
    progressUrl,
    createdAt: Date.now(),
    progress: 0,
    statusText: "Starting…",
    done: false,
    failed: false,
    ...(durableLeaseToken ? { durableLeaseToken } : {}),
  };
  jobs.set(job.jobId, job);
  if (durableLeaseToken) {
    // Publishing is the hand-off point: other instances can poll the same
    // provider job without performing another paid start.
    await publishZylaLease(videoId, format, durableLeaseToken, progressUrl, job.jobId);
  }
  logger.info({ jobId: job.jobId, videoId, format }, "[zyla] job started");
  return job;
}

/** One poll of Zyla's progress_url; mutates the job in place.
 *  `timeoutMs` is the CALLER's patience budget (public routes keep the short
 *  default; the clip pipeline passes a much longer one). A job another caller
 *  timeout-failed is resurrected here when this caller still has budget. */
async function pollZylaOnce(
  job: YtJob,
  timeoutMs: number = JOB_TIMEOUT_MS,
  callerStartedAt: number = job.createdAt,
): Promise<void> {
  // `timeoutMs` is this caller's patience, not the age of the shared provider
  // job. A later caller must be able to resurrect a warm conversion that an
  // earlier short-budget caller timed out while the finish watcher continued.
  if (job.failed && job.error === TIMEOUT_ERROR_TEXT && Date.now() - callerStartedAt <= timeoutMs) {
    job.failed = false; // engine still converting — a longer-budget caller keeps waiting
    delete job.error;
  }
  if (job.done || job.failed) return;
  if (Date.now() - callerStartedAt > timeoutMs) {
    job.failed = true;
    job.error = TIMEOUT_ERROR_TEXT;
    noteZylaFailure(job.videoId, "timeout");
    // Keep the inflight entry: the conversion is still running on Zyla's side
    // and already paid for. The watcher polls it to completion so retries and
    // other callers reuse it instead of buying a duplicate start.
    startFinishWatcher(job);
    logger.warn({ jobId: job.jobId, timeoutMs }, "[zyla] job timed out — finish-watcher continues in background");
    return;
  }
  let resp;
  try {
    resp = await fetchJson(job.progressUrl);
  } catch {
    // Transient network issue — keep the job alive; timeout is the backstop.
    job.statusText = "Waiting for the download service…";
    return;
  }
  const j = resp.json;
  const downloadUrl = typeof j["download_url"] === "string" ? (j["download_url"] as string) : "";
  const text = typeof j["text"] === "string" ? (j["text"] as string) : "";
  const title = typeof j["title"] === "string" ? (j["title"] as string) : undefined;

  if (downloadUrl) {
    if (!isSafePublicHttps(downloadUrl)) {
      job.failed = true;
      job.error = "The download service returned an unusable link.";
      noteZylaFailure(job.videoId, "engine_failed");
      releaseInflightFor(job);
      logger.warn({ jobId: job.jobId, videoId: job.videoId }, "[zyla] rejected unsafe download_url");
      return;
    }
    job.done = true;
    job.progress = 100;
    job.downloadUrl = downloadUrl;
    if (title) job.title = title;
    job.statusText = "Ready";
    cache.set(cacheKey(job.videoId, job.format), {
      downloadUrl,
      ...(title !== undefined ? { title } : {}),
      expiresAt: Date.now() + CACHE_TTL_MS,
    });
    // Durable copy: restarts and sibling autoscale instances reuse this
    // conversion instead of burning a new paid start (fire-and-forget).
    void putCachedMirror(job.videoId, job.format, downloadUrl, title, Date.now() + CACHE_TTL_MS);
    releaseInflightFor(job);
    clearZylaFailure(job.videoId);
    logger.info({ jobId: job.jobId, videoId: job.videoId, format: job.format }, "[zyla] job done");
    return;
  }
  if (/error|fail/i.test(text)) {
    job.failed = true;
    job.error = "The download service reported an error for this video.";
    noteZylaFailure(job.videoId, "engine_failed");
    releaseInflightFor(job);
    logger.warn({ jobId: job.jobId, videoId: job.videoId }, "[zyla] job reported failure");
    return;
  }
  const raw = Number(j["progress"]);
  if (Number.isFinite(raw)) job.progress = Math.min(99, Math.max(job.progress, Math.round(raw / 10)));
  if (text) job.statusText = text.slice(0, 80);
}

/** Detached poller for a conversion every caller gave up on. The start is
 *  already paid — polling is free — so ride it to completion and write the
 *  caches; the user's retry then succeeds instantly at zero extra quota.
 *  One watcher per job; never throws. */
function startFinishWatcher(job: YtJob): void {
  if (job.watcherStarted) return;
  job.watcherStarted = true;
  void (async () => {
    try {
      while (Date.now() - job.createdAt <= JOB_WATCH_CAP_MS) {
        // unref: an abandoned conversion must not hold a graceful shutdown open.
        await new Promise<void>((r) => {
          const t = setTimeout(r, WATCH_POLL_INTERVAL_MS);
          t.unref?.();
        });
        if (job.done) return; // a resurrected caller observed completion first
        let resp;
        try {
          resp = await fetchJson(job.progressUrl);
        } catch {
          continue; // transient — the cap is the backstop
        }
        const j = resp.json;
        const downloadUrl = typeof j["download_url"] === "string" ? (j["download_url"] as string) : "";
        const text = typeof j["text"] === "string" ? (j["text"] as string) : "";
        const title = typeof j["title"] === "string" ? (j["title"] as string) : undefined;
        if (downloadUrl) {
          if (!isSafePublicHttps(downloadUrl)) {
            logger.warn({ jobId: job.jobId, videoId: job.videoId }, "[zyla] finish-watcher: rejected unsafe download_url");
            return;
          }
          job.done = true;
          job.failed = false;
          delete job.error;
          job.progress = 100;
          job.downloadUrl = downloadUrl;
          if (title) job.title = title;
          job.statusText = "Ready";
          cache.set(cacheKey(job.videoId, job.format), {
            downloadUrl,
            ...(title !== undefined ? { title } : {}),
            expiresAt: Date.now() + CACHE_TTL_MS,
          });
          void putCachedMirror(job.videoId, job.format, downloadUrl, title, Date.now() + CACHE_TTL_MS);
          releaseInflightFor(job);
          clearZylaFailure(job.videoId);
          logger.info({ jobId: job.jobId, videoId: job.videoId, format: job.format }, "[zyla] finish-watcher recovered the conversion — cached for reuse");
          return;
        }
        if (/error|fail/i.test(text)) {
          noteZylaFailure(job.videoId, "engine_failed");
          releaseInflightFor(job);
          logger.warn({ jobId: job.jobId, videoId: job.videoId }, "[zyla] finish-watcher: engine reported failure");
          return;
        }
      }
      releaseInflightFor(job);
      logger.warn({ jobId: job.jobId, videoId: job.videoId }, "[zyla] finish-watcher hit the cap — conversion abandoned");
    } catch { /* watcher must never take the process down */ }
  })();
}

function jobSnapshot(job: YtJob) {
  return {
    jobId: job.jobId,
    progress: job.progress,
    done: job.done,
    failed: job.failed,
    statusText: job.statusText,
    ...(job.downloadUrl ? { downloadUrl: job.downloadUrl } : {}),
    ...(job.title ? { title: job.title } : {}),
    ...(job.error ? { error: job.error } : {}),
    ...(job.failed ? { fallbackUrl: fallbackUrlFor(job.videoId, job.format) } : {}),
  };
}

// ── Server-side resolver for the clip pipeline ───────────────────────────────
/** Cheap liveness probe for a cached direct link — one ranged byte, short
 *  timeout. False on ANY failure: a dead cache entry must never reach ffmpeg
 *  (it would waste the whole probe/section stage discovering the 404). */
async function isUrlAlive(url: string): Promise<boolean> {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 8_000);
    try {
      const res = await fetch(url, { headers: { range: "bytes=0-0" }, signal: ctl.signal });
      try { await res.body?.cancel(); } catch { /* already drained */ }
      // R2 answers 206 for ranged hits; some CDNs reply 200. Anything else is dead.
      return res.status === 206 || res.status === 200;
    } finally {
      clearTimeout(t);
    }
  } catch {
    return false;
  }
}

/** Resolve a YouTube URL to a direct (Zyla R2) media URL for the requested max
 *  height. Blocks until the Zyla job finishes (or times out) and returns null
 *  on ANY failure — callers must fall back to the yt-dlp chain. Shares the
 *  same cache + in-flight dedupe as the public routes, so a clip job, a retry,
 *  and a second user within 6 days all consume ONE paid start. Never throws.
 *  `onProgress` (optional) receives the engine's own conversion % after each
 *  poll — the clip pipeline surfaces it on the job record. */
export async function resolveZylaSource(
  youtubeUrl: string,
  maxHeight: number,
  onProgress?: (pct: number, note: string) => void,
  opts?: { timeoutMs?: number },
): Promise<{ url: string; title?: string } | null> {
  let sourceVideoId: string | null = null;
  try {
    const videoId = parseYouTubeId(youtubeUrl);
    sourceVideoId = videoId;
    if (!videoId) return null;
    if (!apiKey()) {
      noteZylaFailure(videoId, "not_configured");
      return null;
    }
    const format =
      maxHeight <= 360 ? "360" : maxHeight <= 480 ? "480" : maxHeight <= 720 ? "720" : "1080";

    // The clip pipeline passes a budget far above the public default: its jobs
    // are async with progress heartbeats, so waiting out a slow engine
    // conversion beats burning the paid start and falling back to yt-dlp.
    const budgetMs = opts?.timeoutMs ?? JOB_TIMEOUT_MS;
    const startedAt = Date.now();

    type Resolved = { url: string; title?: string };
    /** Resolve ONE format rung: memory cache → durable cache → engine job.
     *  Returns "engine_failed" only for a conversion-level failure (the class
     *  of error that can be format-specific). */
    const attempt = async (fmt: string, budget: number): Promise<Resolved | "engine_failed" | null> => {
      const hit = cache.get(cacheKey(videoId, fmt));
      if (hit && hit.expiresAt > Date.now()) {
        clearZylaFailure(videoId);
        return { url: hit.downloadUrl, ...(hit.title !== undefined ? { title: hit.title } : {}) };
      }

      // Durable cache — a conversion finished by ANY instance (or before a
      // restart) is reused for the link's whole lifetime instead of burning a
      // new paid start + a multi-minute wait. Validate the link still answers
      // before trusting it; mirror links occasionally die early.
      const durable = await getCachedMirror(videoId, fmt);
      if (durable) {
        if (await isUrlAlive(durable.downloadUrl)) {
          cache.set(cacheKey(videoId, fmt), {
            downloadUrl: durable.downloadUrl,
            ...(durable.title !== undefined ? { title: durable.title } : {}),
            expiresAt: durable.expiresAtMs,
          });
          logger.info({ videoId, fmt }, "[zyla] durable cache hit — no engine start needed");
          clearZylaFailure(videoId);
          return { url: durable.downloadUrl, ...(durable.title !== undefined ? { title: durable.title } : {}) };
        }
        // Dead link — remove it, but ONLY if the row still holds this exact URL
        // (a sibling instance may have just written a fresh conversion).
        void deleteCachedMirror(videoId, fmt, durable.downloadUrl);
      }

      const job = await getOrStartJob(videoId, fmt);
      if ("startError" in job) return null;
      const callerStartedAt = Date.now();
      // Immediate poll: catches an already-finished job and resurrects a joined
      // job that a shorter-budget caller timeout-failed.
      await pollZylaOnce(job, budget, callerStartedAt);
      // Terminal for US = done, a REAL engine failure, or a timeout past OUR
      // budget. A shorter-budget public poller timeout-failing the shared job
      // must not kill this resolution — the next pollZylaOnce resurrects it.
      const failedForUs = () =>
        job.failed && !(job.error === TIMEOUT_ERROR_TEXT && Date.now() - job.createdAt <= budget);
      while (!job.done && !failedForUs()) {
        await new Promise((r) => setTimeout(r, SERVER_POLL_INTERVAL_MS));
        await pollZylaOnce(job, budget, callerStartedAt); // sets failed=true past budget — loop always exits
        onProgress?.(job.progress, job.statusText);
      }
      if (job.done && job.downloadUrl) {
        clearZylaFailure(videoId);
        return { url: job.downloadUrl, ...(job.title !== undefined ? { title: job.title } : {}) };
      }
      // Timeout is NOT format-specific (the finish-watcher is still salvaging
      // this conversion) and start-level failures (auth/quota/unreachable)
      // hit every format alike — only a conversion failure invites a retry.
      return job.failed && job.error !== TIMEOUT_ERROR_TEXT ? "engine_failed" : null;
    };

    const first = await attempt(format, budgetMs);
    if (first !== null && first !== "engine_failed") return first;

    // Live-observed (Aug 2026): Zyla's engine can return "download_error" for
    // a video at 1080 while the SAME video converts fine at 720. One rung
    // down beats failing the whole clip job into the bot-blocked yt-dlp chain.
    if (first === "engine_failed" && format === "1080") {
      const remaining = budgetMs - (Date.now() - startedAt);
      if (remaining >= 30_000) {
        logger.info({ videoId }, "[zyla] 1080 conversion failed engine-side — retrying one rung down at 720");
        const second = await attempt("720", remaining);
        if (second !== null && second !== "engine_failed") {
          // Alias the REQUESTED format to the served file so the next 1080
          // request is a cache hit instead of another paid start that would
          // fail the same way. Downstream never trusts this label — the clip
          // pipeline ffprobes the file's real dimensions.
          cache.set(cacheKey(videoId, format), {
            downloadUrl: second.url,
            ...(second.title !== undefined ? { title: second.title } : {}),
            expiresAt: Date.now() + CACHE_TTL_MS,
          });
          void putCachedMirror(videoId, format, second.url, second.title, Date.now() + CACHE_TTL_MS);
          clearZylaFailure(videoId);
          return second;
        }
      }
    }
    return null;
  } catch (err) {
    // Keep the resolver non-throwing for the clip pipeline, but do not turn an
    // unexpected local/cache error into an invisible YouTube cookie failure.
    // Avoid logging the URL itself because direct mirror URLs can be signed.
    logger.warn(
      { videoId: sourceVideoId, errorType: err instanceof Error ? err.name : "unknown" },
      "[zyla] source resolver exited unexpectedly",
    );
    return null; // resolver must never break the clip pipeline
  }
}

// ── Router ────────────────────────────────────────────────────────────────────
const router: IRouter = Router();

// Starts cost paid quota — keep per-IP limits tight but humane.
const startLimiter = rateLimit({
  windowMs: 60_000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many download requests — wait a minute and try again." },
});

// Progress polls run every ~4s per active job; give them their own generous
// budget (they're exempted from the app-wide general limiter so they can't
// starve the clipper routes, and vice versa).
const progressLimiter = rateLimit({
  windowMs: 60_000,
  limit: 90,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many progress checks — slow down a little." },
});

function readParams(req: Request): { url?: string; format?: string } {
  const q = req.query as Record<string, unknown>;
  const b = (req.body ?? {}) as Record<string, unknown>;
  const url = typeof b["url"] === "string" ? (b["url"] as string) : typeof q["url"] === "string" ? (q["url"] as string) : undefined;
  const format = typeof b["format"] === "string" ? (b["format"] as string) : typeof q["format"] === "string" ? (q["format"] as string) : undefined;
  return { ...(url !== undefined ? { url } : {}), ...(format !== undefined ? { format } : {}) };
}

function validate(req: Request, res: Response): { videoId: string; format: string } | null {
  const { url, format } = readParams(req);
  const videoId = url ? parseYouTubeId(url) : null;
  if (!videoId) {
    res.status(400).json({ error: "Only YouTube links or video ids are supported here.", code: "UNSUPPORTED_URL" });
    return null;
  }
  if (!format || !FORMATS.has(format)) {
    res.status(400).json({ error: "format must be one of 360, 480, 720, 1080, 1440, 2160, mp3.", code: "BAD_FORMAT" });
    return null;
  }
  return { videoId, format };
}

async function handleStart(req: Request, res: Response): Promise<void> {
  const v = validate(req, res);
  if (!v) return;

  // Cache hit → no new Zyla job (starts cost quota; downloads are free).
  const hit = cache.get(cacheKey(v.videoId, v.format));
  if (hit && hit.expiresAt > Date.now()) {
    res.json({
      jobId: "cached",
      progress: 100,
      done: true,
      failed: false,
      statusText: "Ready",
      downloadUrl: hit.downloadUrl,
      ...(hit.title ? { title: hit.title } : {}),
      cached: true,
    });
    return;
  }

  const job = await getOrStartJob(v.videoId, v.format);
  if ("startError" in job) {
    res.status(job.status).json({ error: job.startError, code: job.status === 503 ? "NOT_CONFIGURED" : "ENGINE_ERROR" });
    return;
  }
  res.json(jobSnapshot(job));
}

router.get("/yt/start", startLimiter, handleStart);
router.post("/yt/start", startLimiter, handleStart);

router.get("/yt/progress", progressLimiter, async (req: Request, res: Response) => {
  const jobId = typeof req.query["jobId"] === "string" ? (req.query["jobId"] as string) : "";
  const job = jobs.get(jobId);
  if (!job) {
    res.status(404).json({ error: "Unknown or expired download job. Start it again.", code: "JOB_NOT_FOUND" });
    return;
  }
  await pollZylaOnce(job);
  res.json(jobSnapshot(job));
});

// Convenience: start + poll server-side, then send the browser to the file.
router.get("/yt/download", startLimiter, async (req: Request, res: Response) => {
  const v = validate(req, res);
  if (!v) return;

  const hit = cache.get(cacheKey(v.videoId, v.format));
  if (hit && hit.expiresAt > Date.now()) {
    res.redirect(302, hit.downloadUrl);
    return;
  }

  const job = await getOrStartJob(v.videoId, v.format);
  if ("startError" in job) {
    const fb = fallbackUrlFor(v.videoId, v.format);
    if (fb) { res.redirect(302, fb); return; }
    res.status(job.status).json({ error: job.startError });
    return;
  }

  while (!job.done && !job.failed) {
    await new Promise(r => setTimeout(r, SERVER_POLL_INTERVAL_MS));
    if (res.writableEnded || req.destroyed) return; // client gave up
    await pollZylaOnce(job);
  }
  if (job.done && job.downloadUrl) {
    res.redirect(302, job.downloadUrl);
    return;
  }
  const fb = fallbackUrlFor(v.videoId, v.format);
  if (fb) { res.redirect(302, fb); return; }
  res.status(502).json({ error: job.error ?? "Download failed." });
});

export default router;
