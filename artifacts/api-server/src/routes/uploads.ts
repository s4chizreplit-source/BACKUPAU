/**
 * Device-upload routes — POST /video/upload/{init,chunk,finish}.
 *
 * The chunk endpoint takes a raw application/octet-stream body (no multipart
 * parser needed) and streams it straight to disk with a hard size cap, so
 * even multi-GB uploads never buffer in memory. The client pipelines parts
 * (next part uploads while the previous one is mirrored); an already-
 * registered part acks idempotently instead of erroring.
 */
import { Router, type Request, type Response } from "express";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { requireUser } from "../middlewares/sessionAuth";
import {
  initUpload,
  registerChunk,
  finishUpload,
  uploadPublicUrl,
  sweepLocalUploads,
  sweepRemoteUploads,
  UploadError,
  UPLOADS_ROOT,
  UPLOAD_CHUNK_BYTES,
  UPLOAD_CHUNK_MAX_BYTES,
  UPLOAD_MAX_BYTES,
} from "../lib/uploadStore";

const router: Router = Router();

function sendUploadError(res: Response, e: unknown): void {
  if (e instanceof UploadError) {
    res.status(e.status).json({ error: e.message });
    return;
  }
  res.status(500).json({ error: "Upload failed on the server — please try again." });
}

/** Stream the raw request body to a file, rejecting past `maxBytes`. */
function streamBodyToFile(req: Request, dest: string, maxBytes: number): Promise<number> {
  return new Promise((resolve, reject) => {
    let received = 0;
    let settled = false;
    const fail = (err: Error & { status?: number }) => {
      if (settled) return;
      settled = true;
      ws.destroy();
      fs.unlink(dest, () => undefined);
      reject(err);
    };
    const ws = fs.createWriteStream(dest);
    req.on("data", (chunk: Buffer) => {
      received += chunk.length;
      if (received > maxBytes) {
        req.unpipe(ws);
        req.resume(); // drain so the socket can still carry our error response
        fail(Object.assign(new Error("Chunk too large."), { status: 413 }));
      }
    });
    req.pipe(ws);
    ws.on("finish", () => {
      if (!settled) {
        settled = true;
        resolve(received);
      }
    });
    ws.on("error", err => fail(Object.assign(err, { status: 500 })));
    req.on("error", err => fail(Object.assign(err, { status: 400 })));
  });
}

// ── POST /video/upload/init ───────────────────────────────────────────────────
router.post("/video/upload/init", requireUser, async (req, res): Promise<void> => {
  try {
    const { name, size, mime } = (req.body ?? {}) as { name?: unknown; size?: unknown; mime?: unknown };
    const meta = await initUpload(req.currentUser!.id, name, size, mime);
    res.json({ uploadId: meta.id, chunkBytes: UPLOAD_CHUNK_BYTES, maxBytes: UPLOAD_MAX_BYTES });
  } catch (e) {
    sendUploadError(res, e);
  }
});

// ── POST /video/upload/chunk?id=…&index=N ─────────────────────────────────────
router.post("/video/upload/chunk", requireUser, async (req, res): Promise<void> => {
  const id = String(req.query.id ?? "");
  const index = Number(req.query.index);
  if (!id || !Number.isInteger(index) || index < 0) {
    res.status(400).json({ error: "Missing upload id or chunk index." });
    return;
  }
  const declared = Number(req.headers["content-length"] ?? 0);
  if (declared > UPLOAD_CHUNK_MAX_BYTES) {
    res.status(413).json({ error: "Chunk too large." });
    return;
  }
  const tmp = path.join(UPLOADS_ROOT, `.part-${crypto.randomBytes(8).toString("hex")}`);
  try {
    const bytes = await streamBodyToFile(req, tmp, UPLOAD_CHUNK_MAX_BYTES);
    const meta = await registerChunk(id, req.currentUser!.id, index, tmp, bytes);
    res.json({ received: meta.receivedBytes, next: meta.nextChunk });
  } catch (e) {
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch { /* ignore */ }
    if (e instanceof UploadError) {
      sendUploadError(res, e);
    } else {
      const err = e as Error & { status?: number };
      res.status(err.status ?? 500).json({ error: err.status === 413 ? "Chunk too large." : "Upload failed — please try again." });
    }
  }
});

// ── POST /video/upload/finish?id=… ────────────────────────────────────────────
router.post("/video/upload/finish", requireUser, async (req, res): Promise<void> => {
  const id = String(req.query.id ?? (req.body as { id?: unknown } | undefined)?.id ?? "");
  if (!id) {
    res.status(400).json({ error: "Missing upload id." });
    return;
  }
  try {
    const meta = await finishUpload(id, req.currentUser!.id);
    res.json({ url: uploadPublicUrl(meta), durationSec: meta.durationSec, name: meta.name });
  } catch (e) {
    sendUploadError(res, e);
  }
});

// ── Sweeps: local hourly; remote every 6h (mirrors the job-record GC) ─────────
setInterval(() => sweepLocalUploads(), 60 * 60 * 1000).unref();
if (!process.env.VITEST) {
  setInterval(() => { void sweepRemoteUploads(); }, 6 * 60 * 60 * 1000).unref();
}

export default router;
