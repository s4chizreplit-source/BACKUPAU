/**
 * Device-upload store — lets users clip a video file from their own device.
 *
 * Flow: init (validate + register) → chunk×N (in-order 8MB parts) → finish
 * (assemble + ffprobe-validate + mirror). The clip pipeline then references
 * the upload as `upload://<id>/<encodedName>`. The client pipelines parts —
 * part N+1 uploads while part N is still being mirrored — so replays of an
 * already-registered part (lost ack, pipelined duplicate) ack idempotently.
 *
 * Multi-instance safety (autoscale): every chunk AND the meta record are
 * mirrored to Object Storage as they arrive, so any instance can continue an
 * upload or run the clip job. When storage is unavailable (dev without a
 * bucket) everything degrades to local-only, which is fine on one instance.
 *
 * Chunked transport exists because a single multi-GB request would die at
 * proxy body-size/time limits — each 8MB part is its own fast request.
 */
import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";
import { execFile } from "child_process";
import { promisify } from "util";
import { getStorageClient, isRemoteStorageConfigured } from "./fileStore";

const execFileAsync = promisify(execFile);

// Same binary-resolution convention as the clip pipeline: explicit env wins,
// otherwise the system PATH (Nix in dev, /usr/local/bin on Railway).
const FFPROBE = process.env.FFPROBE_PATH || "ffprobe";

// Under vitest each worker gets an isolated root so parallel test files never
// sweep each other's uploads (same pattern as the scratch/jobs dirs).
export const UPLOADS_ROOT = path.join(
  os.tmpdir(),
  process.env.VITEST ? `clipai-uploads-${process.pid}` : "clipai-uploads",
);
try { fs.mkdirSync(UPLOADS_ROOT, { recursive: true }); } catch { /* exists */ }

export const UPLOAD_MAX_BYTES = Math.floor(parseFloat(process.env.UPLOAD_MAX_GB ?? "2") * 1024 ** 3);
/** Chunk size the client should use (must fit under the per-request cap). */
export const UPLOAD_CHUNK_BYTES = 8 * 1024 * 1024;
/** Hard server-side cap per chunk request (client hint + slack). */
export const UPLOAD_CHUNK_MAX_BYTES = 8 * 1024 * 1024 + 64 * 1024;
export const UPLOAD_TTL_MS = 6 * 60 * 60 * 1000; // re-runs allowed for 6h
const MIN_FREE_DISK_BYTES = Number(process.env.MIN_FREE_DISK_BYTES || 1024 ** 3);

const ALLOWED_EXTS = new Set([".mp4", ".mov", ".m4v", ".mkv", ".webm", ".avi"]);

export interface UploadMeta {
  id: string;
  userId: string;
  /** Original filename (basename only, length-capped). */
  name: string;
  ext: string;
  size: number;
  mime: string;
  /** Next expected chunk index — chunks must arrive strictly in order. */
  nextChunk: number;
  receivedBytes: number;
  ready: boolean;
  durationSec: number;
  createdMs: number;
}

/** Error with an HTTP status the routes layer can forward verbatim. */
export class UploadError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "UploadError";
    this.status = status;
  }
}

const metas = new Map<string, UploadMeta>();

const dirFor = (id: string) => path.join(UPLOADS_ROOT, id);
const chunkPath = (id: string, n: number) => path.join(dirFor(id), `chunk_${n}`);
const sourcePath = (meta: UploadMeta) => path.join(dirFor(meta.id), `source${meta.ext}`);
const metaPath = (id: string) => path.join(dirFor(id), "meta.json");
const rKey = (id: string, rel: string) => `uploads/${id}/${rel}`;

// ── Remote mirroring (ordered per upload, tolerant of storage outages) ───────
async function remoteUploadWithRetry(fn: () => Promise<{ ok: boolean }>): Promise<boolean> {
  // Local-only development (and the default test adapter) has no remote
  // backend to retry. Return immediately rather than adding seconds of
  // backoff to every upload part.
  if (!isRemoteStorageConfigured()) return false;
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fn();
      if (r.ok) return true;
    } catch { /* treat like ok:false */ }
    await new Promise(res => setTimeout(res, 300 * 3 ** i));
  }
  return false; // local-only mode — single-instance deployments still work
}

/**
 * Whether a failed mirror write must fail the request (503) instead of
 * degrading to local-only. Default: strict whenever a real remote backend is
 * configured — on autoscale, an un-mirrored chunk strands the upload when the
 * next request lands on another instance. UPLOAD_REQUIRE_MIRROR=0/1 overrides.
 */
function mirrorRequired(): boolean {
  const env = (process.env.UPLOAD_REQUIRE_MIRROR ?? "").toLowerCase();
  if (env === "1" || env === "true") return true;
  if (env === "0" || env === "false") return false;
  return isRemoteStorageConfigured();
}

// Per-upload critical section: chunk/finish state transitions for the same
// upload id run strictly one at a time, so concurrent duplicate requests fail
// deterministically instead of corrupting counters or racing the assembler.
const uploadLocks = new Map<string, Promise<unknown>>();
function withUploadLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const prev = uploadLocks.get(id) ?? Promise.resolve();
  const run = prev.then(fn, fn); // a previous failure never blocks the queue
  uploadLocks.set(id, run);
  const cleanup = () => { if (uploadLocks.get(id) === run) uploadLocks.delete(id); };
  run.then(cleanup, cleanup);
  return run;
}

/**
 * Re-read the meta record straight from Object Storage, adopting it only if
 * it is AHEAD of what this instance knows (another instance took chunks or
 * finished the upload). Ordered mirror writes make "ahead" well-defined.
 */
async function refreshMetaFromRemote(id: string): Promise<UploadMeta | null> {
  try {
    const r = await getStorageClient().downloadAsText(rKey(id, "meta.json"));
    if (!r.ok) return null;
    const remote = JSON.parse(r.value) as UploadMeta;
    const local = metas.get(id);
    if (!local || remote.nextChunk > local.nextChunk || (remote.ready && !local.ready)) {
      try { fs.mkdirSync(dirFor(id), { recursive: true }); } catch { /* exists */ }
      metas.set(id, remote);
      persistMetaLocal(remote);
      return remote;
    }
    return local;
  } catch {
    return null;
  }
}

const metaMirrorChain = new Map<string, Promise<unknown>>();
function mirrorMeta(meta: UploadMeta): Promise<boolean> {
  const json = JSON.stringify(meta);
  const doUpload = async () => {
    // Monotonic guard: never regress remote meta another instance already
    // advanced. GET-then-PUT isn't atomic, but a concurrent equal write is
    // byte-identical and an ahead remote is left untouched, so the only
    // regression path (slow stale writer overwriting newer state) is closed.
    try {
      const cur = await getStorageClient().downloadAsText(rKey(meta.id, "meta.json"));
      if (cur.ok) {
        const remote = JSON.parse(cur.value) as UploadMeta;
        if (remote.nextChunk > meta.nextChunk || (remote.ready && !meta.ready)) {
          return true; // durable state is already ahead — nothing new to claim
        }
      }
    } catch { /* unreadable remote — attempt the write anyway */ }
    return remoteUploadWithRetry(() => getStorageClient().uploadFromText(rKey(meta.id, "meta.json"), json));
  };
  const prev = metaMirrorChain.get(meta.id) ?? Promise.resolve();
  const next: Promise<boolean> = prev.then(doUpload, doUpload);
  metaMirrorChain.set(meta.id, next);
  void next.catch(() => undefined).finally(() => {
    if (metaMirrorChain.get(meta.id) === next) metaMirrorChain.delete(meta.id);
  });
  return next;
}

function persistMetaLocal(meta: UploadMeta): void {
  try { fs.writeFileSync(metaPath(meta.id), JSON.stringify(meta)); } catch { /* disk hiccup — map still has it */ }
}

function removeUploadDir(id: string): void {
  metas.delete(id);
  try { fs.rmSync(dirFor(id), { recursive: true, force: true }); } catch { /* ignore */ }
}

function freeDiskBytes(): number {
  try {
    const s = fs.statfsSync(os.tmpdir());
    return s.bavail * s.bsize;
  } catch {
    return Number.MAX_SAFE_INTEGER; // can't measure — don't block uploads on it
  }
}

/** Load a meta record: memory → local disk → Object Storage (other instance). */
export async function loadUploadMeta(id: string): Promise<UploadMeta | null> {
  if (!/^[a-z0-9]{8,64}$/i.test(id)) return null;
  const inMem = metas.get(id);
  if (inMem) return inMem;
  try {
    const m = JSON.parse(fs.readFileSync(metaPath(id), "utf8")) as UploadMeta;
    metas.set(id, m);
    return m;
  } catch { /* not on this instance's disk */ }
  try {
    const r = await getStorageClient().downloadAsText(rKey(id, "meta.json"));
    if (r.ok) {
      const m = JSON.parse(r.value) as UploadMeta;
      try { fs.mkdirSync(dirFor(id), { recursive: true }); } catch { /* exists */ }
      persistMetaLocal(m);
      metas.set(id, m);
      return m;
    }
  } catch { /* storage unavailable */ }
  return null;
}

// ── init ──────────────────────────────────────────────────────────────────────
export async function initUpload(
  userId: string,
  nameRaw: unknown,
  sizeRaw: unknown,
  mimeRaw: unknown,
): Promise<UploadMeta> {
  const name = path.basename(String(nameRaw ?? "")).slice(0, 120).trim();
  if (!name) throw new UploadError(400, "Missing file name.");
  const ext = path.extname(name).toLowerCase();
  if (!ALLOWED_EXTS.has(ext)) {
    throw new UploadError(415, "Only video files are supported: MP4, MOV, M4V, MKV, WEBM or AVI.");
  }
  const mime = String(mimeRaw ?? "");
  if (mime && !mime.startsWith("video/") && mime !== "application/octet-stream") {
    throw new UploadError(415, "That file doesn't look like a video.");
  }
  const size = Number(sizeRaw);
  if (!Number.isFinite(size) || size <= 0) throw new UploadError(400, "Missing or invalid file size.");
  if (size > UPLOAD_MAX_BYTES) {
    const gb = (UPLOAD_MAX_BYTES / 1024 ** 3).toFixed(0);
    throw new UploadError(413, `This file is ${(size / 1024 ** 3).toFixed(1)} GB — the upload limit is ${gb} GB.`);
  }
  if (freeDiskBytes() - size < MIN_FREE_DISK_BYTES) {
    throw new UploadError(507, "Server storage is nearly full right now — please try again in a few minutes.");
  }

  // One in-flight upload per user: starting a new one discards any unfinished
  // previous one, so abandoned uploads can't pile up on disk.
  for (const m of metas.values()) {
    if (m.userId === userId && !m.ready) removeUploadDir(m.id);
  }

  const meta: UploadMeta = {
    id: Date.now().toString(36) + crypto.randomBytes(8).toString("hex"),
    userId,
    name,
    ext,
    size,
    mime,
    nextChunk: 0,
    receivedBytes: 0,
    ready: false,
    durationSec: 0,
    createdMs: Date.now(),
  };
  fs.mkdirSync(dirFor(meta.id), { recursive: true });
  metas.set(meta.id, meta);
  persistMetaLocal(meta);
  const mirrored = await mirrorMeta(meta); // awaited so a follow-up chunk on another instance can find it
  if (!mirrored && mirrorRequired()) {
    removeUploadDir(meta.id);
    throw new UploadError(503, "Could not reach storage to start the upload — please try again.");
  }
  return meta;
}

// ── chunk ─────────────────────────────────────────────────────────────────────
/**
 * Register one received chunk (already streamed to `tmpFile` by the route).
 * Chunks must arrive strictly in order; the mirror write is awaited so the
 * client's next chunk can safely land on a different instance.
 */
export async function registerChunk(
  id: string,
  userId: string,
  index: number,
  tmpFile: string,
  bytes: number,
): Promise<UploadMeta> {
  return withUploadLock(id, () => registerChunkLocked(id, userId, index, tmpFile, bytes));
}

async function registerChunkLocked(
  id: string,
  userId: string,
  index: number,
  tmpFile: string,
  bytes: number,
): Promise<UploadMeta> {
  let meta = await loadUploadMeta(id);
  try {
    if (!meta) throw new UploadError(404, "Upload not found — it may have expired. Please start again.");
    if (meta.userId !== userId) throw new UploadError(403, "This upload belongs to a different account.");
    if (!Number.isInteger(index) || index < 0) {
      throw new UploadError(409, `Out-of-order chunk — expected part ${meta.nextChunk}.`);
    }
    const strict = mirrorRequired();
    if (strict || index !== meta.nextChunk || meta.ready) {
      // Another instance may have taken earlier chunks — and under pipelining
      // it can have done so even when `index` matches our local expectation
      // (our copy is simply stale). Whenever the mirror is authoritative,
      // consult it BEFORE deciding replay vs fresh write, so a replay can
      // never masquerade as a fresh registration and regress shared state.
      // The client's pipelining hides this small GET behind the next part's
      // body upload.
      meta = (await refreshMetaFromRemote(id)) ?? meta;
    }
    // A part we already registered (client retry after a lost ack, or a
    // pipelined duplicate) acks idempotently — its bytes are already durable
    // locally/in the mirror, so re-writing could only corrupt good state.
    if (index < meta.nextChunk) return meta;
    if (meta.ready) throw new UploadError(409, "This upload is already complete.");
    if (index !== meta.nextChunk) {
      throw new UploadError(409, `Out-of-order chunk — expected part ${meta.nextChunk}.`);
    }
    if (bytes <= 0) throw new UploadError(400, "Empty chunk.");
    if (meta.receivedBytes + bytes > meta.size + 64 * 1024) {
      removeUploadDir(id);
      throw new UploadError(413, "Upload is larger than the declared file size — please start again.");
    }

    try { fs.mkdirSync(dirFor(id), { recursive: true }); } catch { /* exists */ }
    fs.renameSync(tmpFile, chunkPath(id, index));

    // Mirror the chunk BEFORE acking — the next chunk may hit another instance.
    const chunkMirrored = await remoteUploadWithRetry(() =>
      getStorageClient().uploadFromFilename(rKey(id, `chunk_${index}`), chunkPath(id, index)),
    );
    if (!chunkMirrored && strict) {
      try { fs.unlinkSync(chunkPath(id, index)); } catch { /* ignore */ }
      throw new UploadError(503, "Could not save this part to storage — please try again.");
    }

    // Advance the meta only once the mirror chain has accepted it, so remote
    // state never claims a chunk that isn't durably there.
    const advanced: UploadMeta = { ...meta, nextChunk: index + 1, receivedBytes: meta.receivedBytes + bytes };
    const metaMirrored = await mirrorMeta(advanced);
    if (!metaMirrored && strict) {
      try { fs.unlinkSync(chunkPath(id, index)); } catch { /* ignore */ }
      void getStorageClient().delete(rKey(id, `chunk_${index}`), { ignoreNotFound: true }).catch(() => undefined);
      throw new UploadError(503, "Could not save upload progress to storage — please try again.");
    }
    Object.assign(meta, advanced);
    persistMetaLocal(meta);
    return meta;
  } finally {
    // Whatever happened, never leave the temp part behind.
    try { if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile); } catch { /* ignore */ }
  }
}

// ── finish ────────────────────────────────────────────────────────────────────
export async function finishUpload(id: string, userId: string): Promise<UploadMeta> {
  return withUploadLock(id, () => finishUploadLocked(id, userId));
}

async function finishUploadLocked(id: string, userId: string): Promise<UploadMeta> {
  let meta = await loadUploadMeta(id);
  if (!meta) throw new UploadError(404, "Upload not found — it may have expired. Please start again.");
  if (meta.userId !== userId) throw new UploadError(403, "This upload belongs to a different account.");
  if (meta.ready) return meta; // idempotent — double-finish is harmless
  if (meta.receivedBytes !== meta.size) {
    // This instance may have missed later chunks that landed elsewhere.
    meta = (await refreshMetaFromRemote(id)) ?? meta;
    if (meta.ready) return meta;
  }
  if (meta.receivedBytes !== meta.size) {
    throw new UploadError(400, `Upload incomplete — received ${meta.receivedBytes} of ${meta.size} bytes. Please try again.`);
  }

  // Assemble chunks (local first, Object Storage for parts another instance took).
  const src = sourcePath(meta);
  const ws = fs.createWriteStream(src);
  try {
    for (let n = 0; n < meta.nextChunk; n++) {
      const p = chunkPath(id, n);
      if (!fs.existsSync(p)) {
        const r = await getStorageClient().downloadToFilename(rKey(id, `chunk_${n}`), p).catch(() => ({ ok: false }));
        if (!r.ok) throw new UploadError(409, "Part of this upload went missing — please upload the file again.");
      }
      await new Promise<void>((resolve, reject) => {
        const rs = fs.createReadStream(p);
        rs.pipe(ws, { end: false });
        rs.on("end", resolve);
        rs.on("error", reject);
        ws.on("error", reject);
      });
    }
    await new Promise<void>((resolve, reject) => ws.end((err?: Error | null) => (err ? reject(err) : resolve())));
  } catch (e) {
    ws.destroy();
    try { fs.unlinkSync(src); } catch { /* ignore */ }
    throw e;
  }

  // Validate it's a real, playable video (also gives us the duration).
  let durationSec = 0;
  let hasVideoStream = false;
  try {
    const { stdout } = await execFileAsync(
      FFPROBE,
      ["-v", "quiet", "-print_format", "json", "-show_format", "-show_streams", src],
      { timeout: 30_000 },
    );
    const probe = JSON.parse(stdout) as {
      format?: { duration?: string };
      streams?: Array<{ codec_type?: string }>;
    };
    durationSec = Math.floor(parseFloat(probe.format?.duration ?? "0"));
    hasVideoStream = (probe.streams ?? []).some(s => s.codec_type === "video");
  } catch { /* unreadable — handled below */ }
  if (!hasVideoStream || !Number.isFinite(durationSec) || durationSec < 3) {
    removeUploadDir(id);
    void getStorageClient().delete(rKey(id, "meta.json"), { ignoreNotFound: true }).catch(() => undefined);
    throw new UploadError(422, "That file doesn't look like a playable video (it needs at least a few seconds of footage). Try an MP4, MOV or WEBM export.");
  }

  // Mirror the assembled source so the clip job can run on any instance.
  const strict = mirrorRequired();
  const srcMirrored = await remoteUploadWithRetry(() =>
    getStorageClient().uploadFromFilename(rKey(id, `source${meta.ext}`), src),
  );
  if (!srcMirrored && strict) {
    throw new UploadError(503, "Could not save the video to storage — please try finishing again.");
  }

  const done: UploadMeta = { ...meta, ready: true, durationSec };
  const metaMirrored = await mirrorMeta(done);
  if (!metaMirrored && strict) {
    throw new UploadError(503, "Could not save upload state to storage — please try finishing again.");
  }
  Object.assign(meta, done);
  persistMetaLocal(meta);

  // Chunks are no longer needed — the assembled source is the artifact.
  for (let n = 0; n < meta.nextChunk; n++) {
    try { fs.unlinkSync(chunkPath(id, n)); } catch { /* ignore */ }
    void getStorageClient().delete(rKey(id, `chunk_${n}`), { ignoreNotFound: true }).catch(() => undefined);
  }
  return meta;
}

// ── Consumption by the clip pipeline ─────────────────────────────────────────
export function uploadPublicUrl(meta: UploadMeta): string {
  return `upload://${meta.id}/${encodeURIComponent(meta.name)}`;
}

export function parseUploadUrl(u: string): { id: string } | null {
  const m = /^upload:\/\/([a-z0-9]{8,64})\/.+$/i.exec(u);
  return m ? { id: m[1] } : null;
}

/** Resolve + authorize an upload for a clip job. Throws UploadError on any problem. */
export async function resolveUploadForJob(id: string, userId: string): Promise<UploadMeta> {
  let meta = await loadUploadMeta(id);
  if (!meta) throw new UploadError(410, "This uploaded video has expired — please upload it again.");
  if (meta.userId !== userId) throw new UploadError(403, "This upload belongs to a different account.");
  if (!meta.ready) {
    // Another instance may have finished it — trust the mirror before failing.
    meta = (await refreshMetaFromRemote(id)) ?? meta;
  }
  if (!meta.ready) throw new UploadError(409, "This upload didn't finish — please upload the file again.");
  return meta;
}

/** Put the uploaded source video at `destPath` (hardlink/copy local, else fetch from storage). */
export async function materializeUploadSource(meta: UploadMeta, destPath: string): Promise<void> {
  const src = sourcePath(meta);
  if (fs.existsSync(src)) {
    try { fs.linkSync(src, destPath); }        // same tmpfs — free
    catch { fs.copyFileSync(src, destPath); }  // cross-device fallback
    return;
  }
  const r = await getStorageClient().downloadToFilename(rKey(meta.id, `source${meta.ext}`), destPath).catch(() => ({ ok: false }));
  if (!r.ok) throw new UploadError(410, "This uploaded video has expired — please upload it again.");
}

// ── Sweeps ────────────────────────────────────────────────────────────────────
/** Remove local upload dirs older than the TTL (crashed/abandoned/expired). */
export function sweepLocalUploads(): void {
  try {
    for (const entry of fs.readdirSync(UPLOADS_ROOT)) {
      const dir = path.join(UPLOADS_ROOT, entry);
      try {
        const meta = metas.get(entry)
          ?? (JSON.parse(fs.readFileSync(path.join(dir, "meta.json"), "utf8")) as UploadMeta);
        if (Date.now() - meta.createdMs > UPLOAD_TTL_MS) removeUploadDir(entry);
      } catch {
        // No readable meta — judge by directory mtime.
        try {
          if (Date.now() - fs.statSync(dir).mtimeMs > UPLOAD_TTL_MS) {
            fs.rmSync(dir, { recursive: true, force: true });
          }
        } catch { /* ignore */ }
      }
    }
  } catch { /* uploads root missing — nothing to sweep */ }
}

/** GC mirrored uploads in Object Storage past the TTL (same pattern as job GC). */
export async function sweepRemoteUploads(): Promise<void> {
  try {
    const cl = getStorageClient();
    const ls = await cl.list({ prefix: "uploads/" });
    if (!ls.ok) return;
    const byId = new Map<string, string[]>();
    for (const { name } of ls.value) {
      const m = /^uploads\/([^/]+)\//.exec(name);
      if (!m) continue;
      const arr = byId.get(m[1]) ?? [];
      arr.push(name);
      byId.set(m[1], arr);
    }
    for (const [id, keys] of byId) {
      try {
        const r = await cl.downloadAsText(rKey(id, "meta.json"));
        if (r.ok) {
          const rec = JSON.parse(r.value) as Partial<UploadMeta>;
          if (Date.now() - (rec.createdMs ?? 0) <= UPLOAD_TTL_MS) continue;
        }
        // Expired (or meta unreadable — orphan parts): delete everything under the id.
        for (const key of keys) await cl.delete(key, { ignoreNotFound: true });
      } catch { /* skip this id — retry next sweep */ }
    }
  } catch { /* storage unreachable — retry next sweep */ }
}

/** Test hook — wipe in-memory state (parallel test isolation). */
export function _resetUploadsForTest(): void {
  metas.clear();
  uploadLocks.clear();
  metaMirrorChain.clear();
}
