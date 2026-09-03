/**
 * Persistent file store with pluggable storage backends.
 *
 * Backend selection (checked in order):
 *   1. S3-compatible object storage — when S3_BUCKET + S3_ACCESS_KEY + S3_SECRET_KEY
 *      are set (works with AWS S3, Cloudflare R2, MinIO, Backblaze B2, etc.)
 *   2. Local filesystem volume — when CLIPS_DIR points to a mounted persistent volume
 *      (e.g. a Railway volume mounted at /data/clips)
 *   3. Replit Object Storage — default when running on Replit
 *   4. Local /tmp — pure ephemeral fallback (dev / no credentials configured)
 *
 * Files are also cached locally in SERVE_DIR so range requests work without
 * re-downloading from remote storage on every request.
 *
 * Object key layout (S3 / Replit Object Storage):
 *   clips/{id}{ext}          — the media file
 *   clips/{id}.meta.json     — JSON sidecar with name/mimeType/ext/expiresMs
 *
 * TTL is 2 hours.
 */

import path from "path";
import os from "os";
import fs from "fs";
import crypto from "crypto";
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
  type GetObjectCommandOutput,
} from "@aws-sdk/client-s3";
import { Readable } from "stream";

export const SERVE_DIR = path.join(os.tmpdir(), "clipai-serve");
try { fs.mkdirSync(SERVE_DIR, { recursive: true }); } catch { /* exists */ }

export interface FileMeta {
  name: string;
  mimeType: string;
  ext: string;
  /** Unix ms after which the file may be deleted; null = permanent (never expires). */
  expiresMs: number | null;
  sizeBytes?: number; // approximate size of the media file, written at upload time
  /** Account that created this file. Absent on legacy files (pre-auth era) —
   *  those fall back to the clip-history ownership lookup at serve time. */
  ownerId?: string;
}

/** True when a meta carries a numeric TTL that has elapsed. Permanent files
 *  (expiresMs === null) never expire; legacy metas always carry a number. */
export function isExpired(meta: Pick<FileMeta, "expiresMs">, now: number = Date.now()): boolean {
  return typeof meta.expiresMs === "number" && now > meta.expiresMs;
}

// Soft ceiling for total bucket usage. Clips are stored permanently, so the
// cleanup cycle only ever evicts LEGACY TTL entries to get back under this cap
// — permanent clips are never auto-deleted (new uploads are refused instead).
// Configurable via STORAGE_SIZE_CAP_GB (default: 100 GB ≈ $2.30/month).
export const STORAGE_SIZE_CAP_BYTES =
  parseFloat(process.env.STORAGE_SIZE_CAP_GB ?? "100") * 1024 ** 3;

// ── Storage adapter interface ──────────────────────────────────────────────────
// All backends expose the same duck-typed interface so the rest of the module
// (circuit breaker, bucket counter, storeFile, resolveFile) is backend-agnostic.

export interface StorageAdapter {
  uploadFromFilename(key: string, filePath: string, opts?: { compress?: boolean }): Promise<{ ok: boolean }>;
  uploadFromText(key: string, text: string): Promise<{ ok: boolean }>;
  downloadAsText(key: string): Promise<{ ok: true; value: string } | { ok: false; value: string }>;
  downloadAsBytes(key: string): Promise<{ ok: true; value: Buffer } | { ok: false; value: Buffer }>;
  downloadToFilename(key: string, destPath: string): Promise<{ ok: boolean }>;
  list(opts?: { prefix?: string; matchGlob?: string }): Promise<{ ok: boolean; value: Array<{ name: string }> }>;
  delete(key: string, opts?: { ignoreNotFound?: boolean }): Promise<{ ok: boolean }>;
}

// ── S3-compatible adapter ──────────────────────────────────────────────────────

function createS3Adapter(): StorageAdapter {
  const bucket = process.env.S3_BUCKET!;
  const clientCfg: ConstructorParameters<typeof S3Client>[0] = {
    region: process.env.S3_REGION ?? "auto",
    credentials: {
      accessKeyId: process.env.S3_ACCESS_KEY!,
      secretAccessKey: process.env.S3_SECRET_KEY!,
    },
  };
  if (process.env.S3_ENDPOINT) {
    clientCfg.endpoint = process.env.S3_ENDPOINT;
    clientCfg.forcePathStyle = true; // required for MinIO / R2 / custom endpoints
  }
  const s3 = new S3Client(clientCfg);

  async function streamToBuffer(stream: Readable | ReadableStream | null | undefined): Promise<Buffer> {
    if (!stream) return Buffer.alloc(0);
    // AWS SDK v3 returns a Node.js Readable in Node environments
    const nodeStream = stream as Readable;
    return new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = [];
      nodeStream.on("data", (chunk: Buffer) => chunks.push(chunk));
      nodeStream.on("end", () => resolve(Buffer.concat(chunks)));
      nodeStream.on("error", reject);
    });
  }

  async function streamToFile(stream: Readable | ReadableStream | null | undefined, destPath: string): Promise<void> {
    if (!stream) throw new Error("empty stream");
    const nodeStream = stream as Readable;
    return new Promise<void>((resolve, reject) => {
      const out = fs.createWriteStream(destPath);
      nodeStream.pipe(out);
      out.on("finish", resolve);
      out.on("error", reject);
      nodeStream.on("error", reject);
    });
  }

  return {
    async uploadFromFilename(key, filePath) {
      try {
        const body = fs.createReadStream(filePath);
        await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body }));
        return { ok: true };
      } catch {
        return { ok: false };
      }
    },
    async uploadFromText(key, text) {
      try {
        await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: text, ContentType: "application/json" }));
        return { ok: true };
      } catch {
        return { ok: false };
      }
    },
    async downloadAsText(key) {
      try {
        const res: GetObjectCommandOutput = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
        const buf = await streamToBuffer(res.Body as Readable);
        return { ok: true, value: buf.toString("utf8") };
      } catch {
        return { ok: false, value: "" };
      }
    },
    async downloadAsBytes(key) {
      try {
        const res: GetObjectCommandOutput = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
        const buf = await streamToBuffer(res.Body as Readable);
        return { ok: true, value: buf };
      } catch {
        return { ok: false, value: Buffer.alloc(0) };
      }
    },
    async downloadToFilename(key, destPath) {
      try {
        const res: GetObjectCommandOutput = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
        fs.mkdirSync(path.dirname(destPath), { recursive: true });
        await streamToFile(res.Body as Readable, destPath);
        return { ok: true };
      } catch {
        return { ok: false };
      }
    },
    async list({ prefix = "" } = {}) {
      try {
        const res = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix }));
        const value = (res.Contents ?? []).map(obj => ({ name: obj.Key ?? "" })).filter(o => o.name);
        return { ok: true, value };
      } catch {
        return { ok: false, value: [] };
      }
    },
    async delete(key, _opts) {
      try {
        await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
        return { ok: true };
      } catch {
        return { ok: false };
      }
    },
  };
}

// ── Local filesystem adapter (CLIPS_DIR volume) ────────────────────────────────

function createLocalFsAdapter(clipsDir: string): StorageAdapter {
  fs.mkdirSync(clipsDir, { recursive: true });

  function keyPath(key: string): string {
    // Replace forward slashes with OS sep; guard against path traversal
    const safe = key.replace(/\.\./g, "").replace(/\//g, path.sep);
    return path.join(clipsDir, safe);
  }

  return {
    async uploadFromFilename(key, filePath) {
      try {
        const dest = keyPath(key);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(filePath, dest);
        return { ok: true };
      } catch {
        return { ok: false };
      }
    },
    async uploadFromText(key, text) {
      try {
        const dest = keyPath(key);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, text, "utf8");
        return { ok: true };
      } catch {
        return { ok: false };
      }
    },
    async downloadAsText(key) {
      try {
        const src = keyPath(key);
        if (!fs.existsSync(src)) return { ok: false, value: "" };
        return { ok: true, value: fs.readFileSync(src, "utf8") };
      } catch {
        return { ok: false, value: "" };
      }
    },
    async downloadAsBytes(key) {
      try {
        const src = keyPath(key);
        if (!fs.existsSync(src)) return { ok: false, value: Buffer.alloc(0) };
        return { ok: true, value: fs.readFileSync(src) };
      } catch {
        return { ok: false, value: Buffer.alloc(0) };
      }
    },
    async downloadToFilename(key, destPath) {
      try {
        const src = keyPath(key);
        if (!fs.existsSync(src)) return { ok: false };
        fs.mkdirSync(path.dirname(destPath), { recursive: true });
        fs.copyFileSync(src, destPath);
        return { ok: true };
      } catch {
        return { ok: false };
      }
    },
    async list({ prefix = "" } = {}) {
      try {
        const prefixDir = path.join(clipsDir, prefix.replace(/\//g, path.sep));
        const baseDir = fs.existsSync(prefixDir) && fs.statSync(prefixDir).isDirectory()
          ? prefixDir
          : path.dirname(prefixDir);
        if (!fs.existsSync(baseDir)) return { ok: true, value: [] };
        const entries = fs.readdirSync(baseDir, { withFileTypes: true });
        const value = entries
          .filter(e => e.isFile())
          .map(e => ({ name: (prefix.endsWith("/") ? prefix : prefix ? prefix + "/" : "") + e.name }))
          .filter(o => o.name.startsWith(prefix));
        return { ok: true, value };
      } catch {
        return { ok: false, value: [] };
      }
    },
    async delete(key, opts) {
      try {
        const target = keyPath(key);
        if (!fs.existsSync(target)) {
          return opts?.ignoreNotFound ? { ok: true } : { ok: false };
        }
        fs.unlinkSync(target);
        return { ok: true };
      } catch {
        return { ok: false };
      }
    },
  };
}

// ── Replit Object Storage adapter (wraps the existing SDK) ────────────────────

function createReplitAdapter(): StorageAdapter {
  // Lazy import to avoid crashing when the package is not available
  // (e.g. on Railway where the Replit sidecar is absent)
  let _client: import("@replit/object-storage").Client | null = null;
  function getClient() {
    if (!_client) {
      const { Client } = require("@replit/object-storage") as typeof import("@replit/object-storage");
      // Pass the bucket ID explicitly when the env var is set so we don't rely
      // on the sidecar's /object-storage/default-bucket response, which returns
      // an empty string until the container is fully restarted after provisioning.
      const bucketId = process.env.DEFAULT_OBJECT_STORAGE_BUCKET_ID || undefined;
      _client = new Client(bucketId ? { bucketId } : undefined);
    }
    return _client!;
  }

  return {
    async uploadFromFilename(key, filePath, opts) {
      return getClient().uploadFromFilename(key, filePath, opts) as Promise<{ ok: boolean }>;
    },
    async uploadFromText(key, text) {
      return getClient().uploadFromText(key, text) as Promise<{ ok: boolean }>;
    },
    async downloadAsText(key) {
      return getClient().downloadAsText(key) as Promise<{ ok: true; value: string } | { ok: false; value: string }>;
    },
    async downloadAsBytes(key) {
      // The Replit SDK returns value as [Buffer] (tuple); unwrap to Buffer.
      const res = await (getClient().downloadAsBytes(key) as unknown as Promise<{ ok: boolean; value: Buffer | [Buffer] }>);
      if (!res.ok) return { ok: false, value: Buffer.alloc(0) };
      const buf = Array.isArray(res.value) ? res.value[0] : res.value;
      return { ok: true, value: buf };
    },
    async downloadToFilename(key, destPath) {
      return getClient().downloadToFilename(key, destPath) as Promise<{ ok: boolean }>;
    },
    async list(opts) {
      return getClient().list(opts) as Promise<{ ok: boolean; value: Array<{ name: string }> }>;
    },
    async delete(key, opts) {
      return getClient().delete(key, opts) as Promise<{ ok: boolean }>;
    },
  };
}

// ── No-op adapter (pure local /tmp fallback, no remote persistence) ────────────

function createNoopAdapter(): StorageAdapter {
  return {
    async uploadFromFilename() { return { ok: false }; },
    async uploadFromText() { return { ok: false }; },
    async downloadAsText() { return { ok: false, value: "" }; },
    async downloadAsBytes() { return { ok: false, value: Buffer.alloc(0) }; },
    async downloadToFilename() { return { ok: false }; },
    async list() { return { ok: true, value: [] }; },
    async delete() { return { ok: false }; },
  };
}

// ── Backend auto-detection ─────────────────────────────────────────────────────

function detectBackend(): { adapter: StorageAdapter; name: string } {
  // Tests inherit REPL_ID from the workspace, but must never touch the real
  // Object Storage sidecar. Tests that need a remote backend inject one through
  // _setStorageClientForTest(), which replaces this no-op adapter.
  if (process.env.VITEST) {
    return { adapter: createNoopAdapter(), name: "noop" };
  }

  // 1. S3-compatible (Railway + any S3/R2/MinIO bucket)
  if (process.env.S3_BUCKET && process.env.S3_ACCESS_KEY && process.env.S3_SECRET_KEY) {
    const name = process.env.S3_ENDPOINT
      ? `S3-compatible (${process.env.S3_ENDPOINT})`
      : "AWS S3";
    console.log(`[storage] Using ${name} backend (bucket: ${process.env.S3_BUCKET})`);
    return { adapter: createS3Adapter(), name };
  }

  // 2. Mounted volume (Railway persistent volume or any local path)
  if (process.env.CLIPS_DIR) {
    console.log(`[storage] Using local-fs backend (CLIPS_DIR: ${process.env.CLIPS_DIR})`);
    return { adapter: createLocalFsAdapter(process.env.CLIPS_DIR), name: "local-fs" };
  }

  // 3. Replit Object Storage (detected by the presence of the Replit sidecar env)
  if (process.env.REPL_ID || process.env.REPLIT_DB_URL) {
    console.log("[storage] Using Replit Object Storage backend");
    return { adapter: createReplitAdapter(), name: "replit" };
  }

  // 4. Pure ephemeral /tmp (no remote persistence — clips survive in-process only)
  console.warn(
    "[storage] No remote storage configured — clips will be lost on restart. " +
    "Set S3_BUCKET/S3_ACCESS_KEY/S3_SECRET_KEY for S3-compatible storage, " +
    "or CLIPS_DIR for a mounted volume.",
  );
  return { adapter: createNoopAdapter(), name: "noop" };
}

// Lazy singleton — avoids crashing at import time when sidecar is unreachable
let _storageAdapter: StorageAdapter | null = null;
let _storageBackendName: string | null = null;

export function getStorageClient(): StorageAdapter {
  if (!_storageAdapter) {
    const detected = detectBackend();
    _storageAdapter = detected.adapter;
    _storageBackendName = detected.name;
  }
  return _storageAdapter;
}

/** True when a real remote backend (not the /tmp-only noop) is configured. */
export function isRemoteStorageConfigured(): boolean {
  getStorageClient(); // force detection
  return _storageBackendName !== "noop";
}

/** FOR TESTING ONLY — inject a mock storage adapter. */
export function _setStorageClientForTest(client: StorageAdapter | null): void {
  _storageAdapter = client;
  _storageBackendName = client ? "test" : null;
}

/**
 * Retry an async operation up to maxAttempts times with exponential backoff.
 * Rethrows the last error if all attempts fail.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  maxAttempts: number,
  baseDelayMs: number,
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt < maxAttempts) {
        await new Promise(r => setTimeout(r, baseDelayMs * Math.pow(2, attempt - 1)));
      }
    }
  }
  throw lastErr;
}

// ── Object Storage upload circuit breaker ─────────────────────────────────────
// States: CLOSED (normal) → OPEN (failing fast) → HALF_OPEN (probing)
// Opens after FAILURE_THRESHOLD consecutive upload failures.
// After COOLDOWN_MS the breaker moves to HALF_OPEN and allows one probe.
// A successful probe resets to CLOSED; a failed probe re-opens the circuit.

const CB_FAILURE_THRESHOLD = 3;   // consecutive failures before opening
const CB_COOLDOWN_MS = 30_000;    // how long to stay open before probing

export type CircuitState = "CLOSED" | "OPEN" | "HALF_OPEN";

export const _cb = {
  state: "CLOSED" as CircuitState,
  consecutiveFailures: 0,
  openedAt: 0,          // timestamp when the circuit opened
};

/** Called after a successful Object Storage upload attempt. */
export function cbSuccess(): void {
  _cb.state = "CLOSED";
  _cb.consecutiveFailures = 0;
}

/** Called after a failed Object Storage upload attempt. */
export function cbFailure(): void {
  _cb.consecutiveFailures++;
  if (_cb.consecutiveFailures >= CB_FAILURE_THRESHOLD) {
    if (_cb.state !== "OPEN") {
      _cb.openedAt = Date.now();
      console.warn(
        `[storage] Circuit breaker OPENED after ${_cb.consecutiveFailures} consecutive upload failures.`,
      );
    }
    _cb.state = "OPEN";
  }
}

/**
 * Returns false when the circuit is CLOSED or HALF_OPEN (call allowed).
 * Returns true when the circuit is OPEN and the cool-down has NOT elapsed.
 * If the cool-down HAS elapsed, transitions to HALF_OPEN and returns false,
 * letting one probe request through.
 */
export function cbIsOpen(): boolean {
  if (_cb.state === "CLOSED") return false;
  if (_cb.state === "HALF_OPEN") return false; // probe already in flight
  // OPEN — check cool-down
  if (Date.now() - _cb.openedAt >= CB_COOLDOWN_MS) {
    _cb.state = "HALF_OPEN";
    console.info("[storage] Circuit breaker HALF_OPEN — probing Object Storage.");
    return false;
  }
  return true; // still open, reject immediately
}

/** Reset circuit breaker — FOR TESTING ONLY. */
export function _resetCircuitBreakerForTest(): void {
  _cb.state = "CLOSED";
  _cb.consecutiveFailures = 0;
  _cb.openedAt = 0;
}

/**
 * Background probe: when the circuit is OPEN and the cool-down has elapsed,
 * run a cheap storage.list() call to verify reachability.
 * On success → cbSuccess() closes the circuit (CLOSED).
 * On failure → cbFailure() re-opens it and resets the cool-down timer.
 *
 * This lets the circuit recover automatically without waiting for a new clip
 * to be processed.  Safe to call on every cleanup tick — exits immediately
 * when the circuit is CLOSED or when the cool-down has not yet elapsed.
 *
 * Exported so unit tests can invoke it directly.
 */
export async function probeStorageIfOpen(): Promise<void> {
  // Nothing to do when the circuit is already healthy
  if (_cb.state === "CLOSED") return;

  // cbIsOpen() handles the OPEN → HALF_OPEN transition when the cool-down
  // has elapsed (returns false) and keeps returning true while still waiting.
  const blocked = cbIsOpen();

  // Cool-down not yet elapsed — nothing to do yet
  if (blocked) return;

  // After cbIsOpen() the state must be HALF_OPEN for us to proceed.
  // (CLOSED is impossible here; we already returned above.)
  if (_cb.state !== "HALF_OPEN") return;

  try {
    const storage = getStorageClient();
    // A lightweight read-only call — empty results are fine; we only care it
    // doesn't throw / return ok:false.
    const result = await storage.list({ prefix: "__probe__" });
    if (!result.ok) throw new Error("list returned ok:false");
    cbSuccess();
    console.info("[storage] Background probe succeeded — circuit breaker CLOSED.");
  } catch (err) {
    cbFailure();
    console.warn(
      "[storage] Background probe failed — circuit breaker re-opened:",
      (err as Error).message,
    );
  }
}

/** Current circuit-breaker snapshot for health/status reporting. */
export function getStorageCircuitState(): {
  state: CircuitState;
  consecutiveFailures: number;
  openedAt: number;
} {
  return { ..._cb };
}

// ── In-process bucket-size counter ───────────────────────────────────────────
// Tracks the total live bytes currently stored in Object Storage.
// Initialised once at startup (initBucketCounter) by listing all live clips.
// Kept current by the cleanup cycle in videoTools.ts (setBucketBytes) and
// incremented/decremented optimistically inside storeFile so every upload is
// checked against remaining headroom before it hits Object Storage.

let _bucketBytes = -1; // -1 = not yet initialised
let _bucketInitPromise: Promise<void> | null = null;

/** Return the current tracked bucket usage in bytes (-1 if not yet initialised). */
export function getBucketBytes(): number { return _bucketBytes; }

/** Overwrite the counter — called by the cleanup cycle after a full scan. */
export function setBucketBytes(n: number): void { _bucketBytes = n; }

/** FOR TESTING ONLY — reset the counter back to uninitialised. */
export function _resetBucketCounterForTest(): void {
  _bucketBytes = -1;
  _bucketInitPromise = null;
}

/**
 * Initialise the bucket counter by listing all live clips from storage.
 * Called once at startup; the cleanup cycle keeps the value current afterwards.
 * Idempotent — subsequent calls while initialisation is in flight await the same
 * promise; calls after it completes return immediately.
 */
export async function initBucketCounter(): Promise<void> {
  if (_bucketBytes >= 0) return; // already initialised
  if (_bucketInitPromise) return _bucketInitPromise;
  _bucketInitPromise = (async () => {
    try {
      const storage = getStorageClient();
      const listResult = await storage.list({ prefix: "clips/", matchGlob: "clips/*.meta.json" });
      // If _bucketBytes was set externally while we were awaiting (e.g. by
      // setBucketBytes from the cleanup cycle), respect that value and skip
      // the overwrite — the external caller has more up-to-date information.
      if (_bucketBytes >= 0) return;
      if (!listResult.ok) { _bucketBytes = 0; return; }
      const now = Date.now();
      let total = 0;
      for (const obj of listResult.value) {
        try {
          const metaResult = await storage.downloadAsText(obj.name);
          if (!metaResult.ok) continue;
          const meta: FileMeta = JSON.parse(metaResult.value);
          if (isExpired(meta, now)) continue; // expired legacy clip; cleanup will delete it
          total += meta.sizeBytes ?? 0;
        } catch { /* skip individual failures */ }
      }
      // Final guard: another async path may have set the counter while we iterated.
      if (_bucketBytes >= 0) return;
      _bucketBytes = total;
      console.log(
        `[storage] Bucket counter initialised: ${(total / (1024 ** 2)).toFixed(1)} MB ` +
        `(cap: ${(STORAGE_SIZE_CAP_BYTES / (1024 ** 3)).toFixed(1)} GB)`,
      );
    } catch (err) {
      // Only set to 0 if no other path has already initialised the counter.
      if (_bucketBytes < 0) {
        console.warn('[storage] initBucketCounter failed, defaulting to 0:', (err as Error).message);
        _bucketBytes = 0;
      }
    }
  })();
  return _bucketInitPromise;
}

// Track in-progress object-storage downloads to avoid duplicate fetches
export const _downloadingFromStorage = new Map<string, Promise<{ filePath: string; meta: FileMeta } | null>>();

/**
 * Copy file into SERVE_DIR, persist to remote storage, return UUID id.
 * Awaiting ensures the object is safely in remote storage before the id
 * is returned, so cold-start resolves never race a still-uploading object.
 */
export async function storeFile(filePath: string, name: string, mimeType: string, ownerId?: string): Promise<string> {
  const id = crypto.randomUUID();
  const ext = path.extname(name) || "";
  const dest = path.join(SERVE_DIR, `${id}${ext}`);

  const fileStat = fs.statSync(filePath);

  // ── Headroom check ────────────────────────────────────────────────────────
  // If the counter is initialised, verify there is enough remaining capacity
  // before uploading.  This closes the window between cleanup cycles where a
  // single large upload could push the bucket over its size cap.
  if (_bucketBytes >= 0 && _bucketBytes + fileStat.size > STORAGE_SIZE_CAP_BYTES) {
    const usedGB  = (_bucketBytes / (1024 ** 3)).toFixed(2);
    const capGB   = (STORAGE_SIZE_CAP_BYTES / (1024 ** 3)).toFixed(1);
    const fileMB  = (fileStat.size / (1024 ** 2)).toFixed(1);
    throw new Error(
      `Storage is full (${usedGB} GB used of ${capGB} GB cap; ` +
      `this clip is ${fileMB} MB). ` +
      `Clips are stored permanently — raise STORAGE_SIZE_CAP_GB to allow more space.`,
    );
  }

  // Optimistically increment before the upload so concurrent storeFile calls
  // also see updated headroom and don't all squeeze through simultaneously.
  if (_bucketBytes >= 0) _bucketBytes += fileStat.size;

  fs.copyFileSync(filePath, dest);

  const meta: FileMeta = {
    name,
    mimeType,
    ext,
    expiresMs: null, // permanent — clips stay downloadable from account history
    sizeBytes: fileStat.size,
    ...(ownerId ? { ownerId } : {}),
  };
  const metaJson = JSON.stringify(meta);
  fs.writeFileSync(path.join(SERVE_DIR, `${id}.meta.json`), metaJson);

  // Upload to remote storage when available — optional, non-fatal.
  // If the circuit is OPEN or the upload fails, clips are still served from
  // local disk for the lifetime of this process. They won't survive a restart,
  // but the request succeeds and the user gets their clips.
  if (!cbIsOpen()) {
    try {
      const storage = getStorageClient();
      await withRetry(
        async () => {
          const [mediaResult, metaResult] = await Promise.all([
            storage.uploadFromFilename(`clips/${id}${ext}`, dest, { compress: false }),
            storage.uploadFromText(`clips/${id}.meta.json`, metaJson),
          ]);
          // Adapters may signal failure via { ok: false } instead of throwing —
          // convert to a thrown error so withRetry retries and the catch block
          // below correctly calls cbFailure / rolls back the counter.
          if (!mediaResult.ok) throw new Error("media upload returned ok:false");
          if (!metaResult.ok) throw new Error("meta upload returned ok:false");
        },
        3,
        500, // 500 ms → 1 s → 2 s
      );
      cbSuccess();
    } catch (err) {
      cbFailure();
      // Roll back the optimistic size increment — not persisted to remote storage.
      if (_bucketBytes >= 0) _bucketBytes -= fileStat.size;
      console.warn(
        '[storage] Remote storage upload failed — clip will be served from local disk only:',
        (err as Error).message,
      );
    }
  } else {
    // Roll back the optimistic size increment — upload skipped.
    if (_bucketBytes >= 0) _bucketBytes -= fileStat.size;
    console.warn('[storage] Circuit breaker open — skipping remote storage upload, serving from local disk.');
  }

  return id;
}

/**
 * Permanently delete a stored file (media + meta, remote and local cache).
 * Used when a user deletes a history entry — clips are permanent now, so no
 * TTL sweeper would ever reclaim the space otherwise.
 *
 * Returns true only when the remote objects are confirmed gone (deleting an
 * already-missing key counts as gone — the call is idempotent). Callers keep
 * the history row on false so the user can retry the delete.
 */
export async function deleteStoredFile(id: string): Promise<boolean> {
  if (!/^[\w-]{8,64}$/.test(id)) return true; // junk id — nothing to reclaim
  let ext = "";
  let sizeBytes = 0;
  // Prefer the local sidecar for ext/size; fall back to the remote one.
  try {
    const localMeta = path.join(SERVE_DIR, `${id}.meta.json`);
    if (fs.existsSync(localMeta)) {
      const meta: FileMeta = JSON.parse(fs.readFileSync(localMeta, "utf8"));
      ext = meta.ext; sizeBytes = meta.sizeBytes ?? 0;
    }
  } catch { /* fall through to remote */ }
  let remoteOk = true;
  try {
    const storage = getStorageClient();
    if (!ext) {
      const metaResult = await storage.downloadAsText(`clips/${id}.meta.json`);
      if (metaResult.ok) {
        try {
          const meta: FileMeta = JSON.parse(metaResult.value);
          ext = meta.ext; sizeBytes = meta.sizeBytes ?? 0;
        } catch { /* malformed — still delete the sidecar below */ }
      }
    }
    const metaDel = await storage.delete(`clips/${id}.meta.json`, { ignoreNotFound: true });
    remoteOk = metaDel.ok;
    if (ext) {
      const mediaDel = await storage.delete(`clips/${id}${ext}`, { ignoreNotFound: true });
      remoteOk = remoteOk && mediaDel.ok;
      // Adjust the optimistic counter only on a CONFIRMED media delete, and
      // never below zero — the 15-min sweep stays the authoritative source.
      if (mediaDel.ok && _bucketBytes >= 0 && sizeBytes > 0) {
        _bucketBytes = Math.max(0, _bucketBytes - sizeBytes);
      }
    }
  } catch {
    remoteOk = false; // remote unavailable — caller should let the user retry
  }
  try { fs.unlinkSync(path.join(SERVE_DIR, `${id}.meta.json`)); } catch { /* ignore */ }
  if (ext) { try { fs.unlinkSync(path.join(SERVE_DIR, `${id}${ext}`)); } catch { /* ignore */ } }
  return remoteOk;
}

/**
 * True when the clip's meta sidecar exists in Object Storage — i.e. the file
 * is durable beyond this instance's local disk. Used by history saves to only
 * advertise permanence for files that actually reached the bucket (a storage
 * outage can leave a clip local-only; those die with the local cache).
 */
export async function isStoredRemotely(id: string): Promise<boolean> {
  if (!/^[\w-]{8,64}$/.test(id)) return false;
  try {
    const r = await getStorageClient().downloadAsText(`clips/${id}.meta.json`);
    return r.ok;
  } catch {
    return false;
  }
}

/**
 * Read ONLY the meta sidecar of a stored file — local first, then remote.
 * Never downloads the media itself, so it's cheap enough to call for many ids
 * (history saves verify ownership of up to 30 clip ids with this).
 */
export async function readFileMeta(id: string): Promise<FileMeta | null> {
  if (!/^[\w-]{8,64}$/.test(id)) return null;
  try {
    const metaPath = path.join(SERVE_DIR, `${id}.meta.json`);
    if (fs.existsSync(metaPath)) {
      const meta: FileMeta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
      return isExpired(meta) ? null : meta;
    }
  } catch { /* unreadable local sidecar — try remote */ }
  try {
    const r = await getStorageClient().downloadAsText(`clips/${id}.meta.json`);
    if (!r.ok) return null;
    const meta: FileMeta = JSON.parse(r.value);
    return isExpired(meta) ? null : meta;
  } catch {
    return null;
  }
}

/**
 * Resolve a stored file.
 * 1. Check local disk cache first (fast, supports range requests).
 * 2. On cache miss, fetch from remote storage and cache locally.
 * Returns null if not found in either location or if the TTL has expired.
 */
export async function resolveFile(id: string): Promise<{ filePath: string; meta: FileMeta } | null> {
  // Sanitize id — must be a UUID-like string (no path traversal)
  if (!/^[\w-]{8,64}$/.test(id)) return null;

  // ── 1. Local disk hit ────────────────────────────────────────────────────
  const metaPath = path.join(SERVE_DIR, `${id}.meta.json`);
  if (fs.existsSync(metaPath)) {
    let meta: FileMeta;
    try { meta = JSON.parse(fs.readFileSync(metaPath, "utf8")); }
    catch { return null; }
    if (isExpired(meta)) {
      try { fs.unlinkSync(metaPath); } catch { /* ignore */ }
      try { fs.unlinkSync(path.join(SERVE_DIR, `${id}${meta.ext}`)); } catch { /* ignore */ }
      return null;
    }
    const filePath = path.join(SERVE_DIR, `${id}${meta.ext}`);
    if (fs.existsSync(filePath)) return { filePath, meta };
  }

  // ── 2. Remote storage fallback (deduplicated) ────────────────────────────
  if (_downloadingFromStorage.has(id)) {
    return _downloadingFromStorage.get(id)!;
  }

  const fetchPromise = (async (): Promise<{ filePath: string; meta: FileMeta } | null> => {
    try {
      const storage = getStorageClient();

      // Fetch meta first — cheap and tells us the ext + expiry
      const metaResult = await storage.downloadAsText(`clips/${id}.meta.json`);
      if (!metaResult.ok) return null;

      let meta: FileMeta;
      try { meta = JSON.parse(metaResult.value); }
      catch { return null; }

      if (isExpired(meta)) return null;

      // Fetch the media file to local disk so we can serve range requests
      const filePath = path.join(SERVE_DIR, `${id}${meta.ext}`);
      const dlResult = await storage.downloadToFilename(`clips/${id}${meta.ext}`, filePath);
      if (!dlResult.ok) return null;

      // Write the meta sidecar so subsequent hits use the fast disk path
      fs.writeFileSync(path.join(SERVE_DIR, `${id}.meta.json`), JSON.stringify(meta));

      return { filePath, meta };
    } catch (err) {
      console.warn('[storage] Remote storage resolve failed:', (err as Error).message);
      return null;
    } finally {
      _downloadingFromStorage.delete(id);
    }
  })();

  _downloadingFromStorage.set(id, fetchPromise);
  return fetchPromise;
}

/**
 * Check whether remote storage is reachable.
 * Used by the health endpoint and the startup probe.
 * Also reports the current circuit-breaker state.
 */
export async function checkStorageHealth(): Promise<{
  ok: boolean;
  error?: string;
  circuit: CircuitState;
  consecutiveFailures: number;
}> {
  const { state: circuit, consecutiveFailures } = getStorageCircuitState();
  try {
    const storage = getStorageClient();
    // list is a lightweight read-only call; empty results are fine — we only care it doesn't throw.
    const result = await storage.list({ prefix: "__health__" });
    if (!result.ok) {
      const detail = (result as { error?: unknown }).error;
      return {
        ok: false,
        error: `list returned not-ok: ${String(detail ?? 'unknown')}`,
        circuit,
        consecutiveFailures,
      };
    }
    return { ok: true, circuit, consecutiveFailures };
  } catch (err) {
    return { ok: false, error: (err as Error).message, circuit, consecutiveFailures };
  }
}
