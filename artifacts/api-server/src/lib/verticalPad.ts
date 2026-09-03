/**
 * Campaign media → vertical (9:16) for Shorts-first feeds.
 *
 * YouTube files an upload as a Short purely from the file itself: duration
 * ≤ 3 minutes AND at least as tall as wide. There is NO API flag — a 960x720
 * reel repost lands in the long-form feed no matter how it is submitted
 * (observed live: every wider-than-tall campaign video was filed long-form).
 * So at handoff we pad wider-than-tall campaign videos onto a blurred
 * 1080x1920 canvas — the standard repost look — store the processed file in
 * object storage, and hand the posting provider a signed relay URL to it.
 *
 * Never throws out of ensurePaddedVertical: any failure returns null and the
 * caller falls back to the original media URL (an unpadded post beats no
 * post). Processing is keyed by a deterministic hash of the media ref, so
 * retries and other instances reuse the same processed object instead of
 * re-encoding.
 */
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { Readable, Transform } from "stream";
import { pipeline } from "stream/promises";

import { logger } from "./logger";
import { urlResolvesPublic } from "./ssrfGuard";
import {
  getStorageClient, isRemoteStorageConfigured, withRetry,
  cbIsOpen, cbSuccess, cbFailure,
} from "./fileStore";

const execFileAsync = promisify(execFile);

const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";
const FFPROBE = process.env.FFPROBE_PATH || "ffprobe";

/** YouTube's Shorts duration ceiling — padding a longer video can't make it a
 *  Short, and vertical long-form looks broken on desktop, so we skip those. */
export const MAX_SHORT_SEC = 180;

const MAX_SRC_BYTES = 300 * 1024 * 1024;  // campaign media is normally a few MB
const FETCH_TIMEOUT_MS = 3 * 60 * 1000;
const ENCODE_TIMEOUT_MS = 4 * 60 * 1000;

export type PadInput = { kind: "file"; path: string } | { kind: "url"; url: string };

/** Pad only when the video is wider than tall (landscape/4:3 — the shapes
 *  YouTube files as long-form). Square and vertical already qualify as
 *  Shorts, so they pass through untouched. Unknown duration is treated as
 *  too long — better an honest long-form post than padding a 10-minute video. */
export function needsVerticalPad(width: number, height: number, durationSec: number): boolean {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return false;
  if (!Number.isFinite(durationSec) || durationSec <= 0 || durationSec > MAX_SHORT_SEC) return false;
  return width > height;
}

/** QuickTime/phone exports frequently use a MOV/M4V container or HEVC codec
 * that TikTok rejects after a successful download. Normalize these sources to
 * H.264/AAC MP4 before provider handoff. */
export function needsCompatibilityTranscode(fileName: string): boolean {
  return /\.(mov|m4v)$/i.test(fileName.trim());
}

/** Blurred-canvas 9:16: background = source scaled to COVER 1080x1920 then
 *  blurred; foreground = source scaled to fit the width, centered. */
export function buildVerticalPadFilter(): string {
  return [
    "split=2[bg][fg]",
    "[bg]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=20:2[bgb]",
    "[fg]scale=1080:-2[fgs]",
    "[bgb][fgs]overlay=(W-w)/2:(H-h)/2,setsar=1,format=yuv420p",
  ].join(";");
}

// ── Signed relay tokens (stateless, mirrors gdriveRelayToken) ─────────────────

const DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_TTL_MS = 400 * 24 * 60 * 60 * 1000;
const PAD_ID_RE = /^[a-f0-9]{24,64}$/;

const secret = (): string => {
  const s = (process.env.SESSION_SECRET ?? "").trim();
  if (!s) throw new Error("SESSION_SECRET is not configured");
  return s;
};

const sign = (payload: string): string =>
  crypto.createHmac("sha256", secret()).update(`padded.${payload}`).digest("base64url");

export function createPaddedMediaToken(paddedId: string, now = Date.now(), ttlMs = DEFAULT_TTL_MS): string {
  if (!PAD_ID_RE.test(paddedId)) throw new Error("Invalid padded media id");
  const ttl = Math.min(Math.max(ttlMs, DEFAULT_TTL_MS), MAX_TTL_MS);
  const payload = `${paddedId}.${now + ttl}`;
  return `${payload}.${sign(payload)}`;
}

/** Returns the padded media id, or null when invalid, expired, or tampered. */
export function verifyPaddedMediaToken(token: string, now = Date.now()): string | null {
  const m = token.match(/^([a-f0-9]{24,64})\.(\d{10,16})\.([A-Za-z0-9_-]{20,100})$/);
  if (!m) return null;
  const [, id, expStr, sig] = m;
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || exp < now) return null;
  const expect = sign(`${id}.${exp}`);
  const a = Buffer.from(sig), b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return id;
}

// ── Processing ─────────────────────────────────────────────────────────────────

const storageKey = (id: string): string => `padded/${id}.mp4`;
const localPath = (id: string): string => path.join(os.tmpdir(), `padded-${id}.mp4`);

async function probeVideo(filePath: string): Promise<{ width: number; height: number; durationSec: number } | null> {
  try {
    const { stdout } = await execFileAsync(FFPROBE, [
      "-v", "error", "-select_streams", "v:0",
      "-show_entries", "stream=width,height", "-show_entries", "format=duration",
      "-of", "json", filePath,
    ], { timeout: 60_000, maxBuffer: 4 * 1024 * 1024 });
    const j = JSON.parse(stdout) as { streams?: Array<{ width?: number; height?: number }>; format?: { duration?: string } };
    const s = j.streams?.[0];
    return {
      width: Number(s?.width ?? 0),
      height: Number(s?.height ?? 0),
      durationSec: Number(j.format?.duration ?? NaN),
    };
  } catch {
    return null;
  }
}

const MAX_REDIRECTS = 3;

/** Server-side fetch of (possibly user-influenced) media URLs. Redirects are
 *  followed MANUALLY and every hop is DNS-validated — a public URL that
 *  redirects to internal/metadata infrastructure is the classic SSRF bypass,
 *  so `redirect: "follow"` is never acceptable here. */
async function fetchToFile(url: string, destPath: string): Promise<void> {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (!(await urlResolvesPublic(current))) {
      throw new Error("source URL does not resolve to a public host");
    }
    const r = await fetch(current, { redirect: "manual", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (r.status >= 300 && r.status < 400) {
      const loc = r.headers.get("location");
      await r.body?.cancel().catch(() => {});
      if (!loc) throw new Error(`redirect without location (${r.status})`);
      current = new URL(loc, current).toString();
      continue;
    }
    if (!r.ok || !r.body) throw new Error(`source fetch failed (${r.status})`);
    let bytes = 0;
    const guard = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        bytes += chunk.length;
        if (bytes > MAX_SRC_BYTES) cb(new Error("source too large to pad"));
        else cb(null, chunk);
      },
    });
    await pipeline(
      Readable.fromWeb(r.body as unknown as import("stream/web").ReadableStream),
      guard,
      fs.createWriteStream(destPath),
    );
    return;
  }
  throw new Error("too many redirects");
}

async function encodeCompatible(srcPath: string, outPath: string, padVertical: boolean): Promise<void> {
  const tmpOut = `${outPath}.tmp.mp4`;
  try {
    await execFileAsync(FFMPEG, [
      "-y", "-i", srcPath,
      "-vf", padVertical
        ? buildVerticalPadFilter()
        : "scale=trunc(iw/2)*2:trunc(ih/2)*2,setsar=1,format=yuv420p",
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "22",
      "-c:a", "aac", "-b:a", "128k",
      "-movflags", "+faststart",
      tmpOut,
    ], { timeout: ENCODE_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 });
    const st = fs.statSync(tmpOut);
    if (st.size <= 0) throw new Error("empty encode output");
    fs.renameSync(tmpOut, outPath);
  } finally {
    fs.rmSync(tmpOut, { force: true });
  }
}

// Dedupe concurrent requests for the same media (e.g. two due rows sharing a ref).
const inflight = new Map<string, Promise<string | null>>();

/**
 * Ensure a padded 9:16 rendition of `input` exists, keyed by `seed` (the
 * durable media ref — "ig:user:reel:CODE", "clip:<id>", or a URL).
 * Returns the prepared-media id when vertical padding or a forced compatibility
 * transcode was needed; otherwise null. Processing/persistence failures also
 * return null so the caller can retain its existing fallback behavior.
 */
export async function ensurePaddedVertical(
  input: PadInput,
  seed: string,
  opts: { forceTranscode?: boolean } = {},
): Promise<string | null> {
  const forceTranscode = opts.forceTranscode === true;
  const id = crypto.createHash("sha256")
    .update(`padv2|compat=${forceTranscode ? "1" : "0"}|${seed}`)
    .digest("hex")
    .slice(0, 32);
  const running = inflight.get(id);
  if (running) return running;
  const p = doEnsure(input, id, forceTranscode).catch((err) => {
    logger.warn({ err: (err as Error).message, seed: seed.slice(0, 120) }, "[verticalPad] processing failed — using original media");
    return null;
  }).finally(() => inflight.delete(id));
  inflight.set(id, p);
  return p;
}

async function doEnsure(input: PadInput, id: string, forceTranscode: boolean): Promise<string | null> {
  const out = localPath(id);
  const remote = isRemoteStorageConfigured();
  if (fs.existsSync(out) && fs.statSync(out).size > 0) {
    void touchPaddedMeta(id); // keep the sweeper away from renditions still in use
    return id;
  }
  if (remote && !cbIsOpen()) {
    // Another instance (or an earlier boot) may have already processed it.
    const listed = await getStorageClient().list({ prefix: storageKey(id) }).catch(() => ({ ok: false as const, value: [] as Array<{ name: string }> }));
    if (listed.ok && listed.value.some((o) => o.name.endsWith(storageKey(id)))) {
      void touchPaddedMeta(id);
      return id;
    }
  }

  let srcTemp: string | null = null;
  try {
    let srcPath: string;
    if (input.kind === "file") {
      srcPath = input.path; // owned by fileStore — never delete
    } else {
      srcTemp = path.join(os.tmpdir(), `padsrc-${id}`);
      await fetchToFile(input.url, srcTemp);
      srcPath = srcTemp;
    }
    const probe = await probeVideo(srcPath);
    if (!probe) return null;
    const padVertical = needsVerticalPad(probe.width, probe.height, probe.durationSec);
    if (!padVertical && !forceTranscode) return null;

    await encodeCompatible(srcPath, out, padVertical);

    if (remote) {
      // On autoscale the provider may fetch from ANOTHER instance — the object
      // must be in remote storage before we hand out a relay URL. Local-only is
      // fine without remote storage (single dev instance).
      if (cbIsOpen()) throw new Error("storage circuit open — cannot persist padded video");
      try {
        await withRetry(async () => {
          const up = await getStorageClient().uploadFromFilename(storageKey(id), out, { compress: false });
          if (!up.ok) throw new Error("padded upload returned ok:false");
        }, 3, 500);
        cbSuccess();
      } catch (err) {
        cbFailure();
        throw err;
      }
      await touchPaddedMeta(id); // best effort — the sweeper heals missing meta
    }
    logger.info(
      { id, width: probe.width, height: probe.height, padded: padVertical, transcoded: forceTranscode },
      padVertical
        ? "[verticalPad] prepared campaign video as compatible 9:16 MP4"
        : "[verticalPad] transcoded campaign video to compatible MP4",
    );
    return id;
  } finally {
    if (srcTemp) fs.rmSync(srcTemp, { force: true });
  }
}

// Dedupe concurrent cold-cache downloads so a second request can never observe
// a half-written file (download goes to a temp name, then atomic rename).
const downloading = new Map<string, Promise<string | null>>();

/** Local file path for a padded rendition — downloads from remote storage
 *  when this instance hasn't got it cached. Null when unavailable. */
export async function resolvePaddedFile(paddedId: string): Promise<string | null> {
  if (!PAD_ID_RE.test(paddedId)) return null;
  const out = localPath(paddedId);
  try {
    if (fs.existsSync(out) && fs.statSync(out).size > 0) return out;
  } catch { /* fall through to download */ }
  const running = downloading.get(paddedId);
  if (running) return running;
  const p = (async (): Promise<string | null> => {
    const tmp = `${out}.dl-${crypto.randomBytes(4).toString("hex")}.tmp`;
    try {
      if (!isRemoteStorageConfigured() || cbIsOpen()) return null;
      const dl = await getStorageClient().downloadToFilename(storageKey(paddedId), tmp);
      if (!dl.ok || !fs.existsSync(tmp) || fs.statSync(tmp).size <= 0) return null;
      fs.renameSync(tmp, out); // atomic within the same tmpdir
      return out;
    } catch {
      return null;
    } finally {
      fs.rmSync(tmp, { force: true });
      downloading.delete(paddedId);
    }
  })();
  downloading.set(paddedId, p);
  return p;
}

// ── Retention ──────────────────────────────────────────────────────────────────
// Padded renditions are derived data (deterministically re-creatable from the
// source ref), so they get a simple lifecycle: swept once untouched for 45
// days. Every handoff reuse refreshes the meta sidecar, so anything a live
// campaign still references stays. Worst-case race (sweep vs. concurrent
// touch) is benign: the next handoff just re-encodes under the same key.

export const PADDED_RETENTION_MS = 45 * 24 * 60 * 60 * 1000;

const metaKey = (id: string): string => `padded/${id}.json`;

/** Expired = last touch older than the retention window. Unparseable or
 *  missing touch data is NOT expired — the sweeper heals it instead (never
 *  delete media just because a tiny meta upload failed). */
export function isPaddedMetaExpired(meta: unknown, now: number): boolean {
  const t = (meta as { touchedMs?: unknown } | null)?.touchedMs;
  if (typeof t !== "number" || !Number.isFinite(t)) return false;
  return t + PADDED_RETENTION_MS < now;
}

async function touchPaddedMeta(id: string): Promise<void> {
  try {
    if (!isRemoteStorageConfigured() || cbIsOpen()) return;
    await getStorageClient().uploadFromText(metaKey(id), JSON.stringify({ touchedMs: Date.now() }));
  } catch { /* best effort — sweep heals missing meta */ }
}

/** Delete padded renditions untouched for PADDED_RETENTION_MS, heal missing or
 *  corrupt meta sidecars, and drop orphaned sidecars. Never throws. */
export async function sweepExpiredPaddedMedia(): Promise<void> {
  try {
    if (!isRemoteStorageConfigured() || cbIsOpen()) return;
    const storage = getStorageClient();
    const listed = await storage.list({ prefix: "padded/" });
    if (!listed.ok) return;
    const names = listed.value.map((o) => o.name);
    const mp4Ids = new Set<string>();
    const jsonIds = new Set<string>();
    for (const n of names) {
      let m = n.match(/padded\/([a-f0-9]{24,64})\.mp4$/);
      if (m) mp4Ids.add(m[1]);
      m = n.match(/padded\/([a-f0-9]{24,64})\.json$/);
      if (m) jsonIds.add(m[1]);
    }
    const now = Date.now();
    let deleted = 0;
    for (const id of mp4Ids) {
      if (!jsonIds.has(id)) {
        await touchPaddedMeta(id); // meta upload raced/failed — start the clock now
        continue;
      }
      const metaTxt = await storage.downloadAsText(metaKey(id));
      if (!metaTxt.ok) continue;
      let meta: unknown = null;
      try { meta = JSON.parse(metaTxt.value); } catch { /* corrupt — heal below */ }
      if (!isPaddedMetaExpired(meta, now)) {
        const t = (meta as { touchedMs?: unknown } | null)?.touchedMs;
        if (typeof t !== "number" || !Number.isFinite(t)) await touchPaddedMeta(id);
        continue;
      }
      await storage.delete(storageKey(id), { ignoreNotFound: true });
      await storage.delete(metaKey(id), { ignoreNotFound: true });
      fs.rmSync(localPath(id), { force: true });
      deleted++;
    }
    for (const id of jsonIds) {
      if (!mp4Ids.has(id)) await storage.delete(metaKey(id), { ignoreNotFound: true });
    }
    if (deleted > 0) logger.info({ deleted }, "[verticalPad] swept expired padded renditions");
  } catch (err) {
    logger.warn({ err: (err as Error).message }, "[verticalPad] padded sweep failed");
  }
}
