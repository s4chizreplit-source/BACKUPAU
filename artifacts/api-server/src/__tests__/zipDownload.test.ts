/**
 * Tests for the ZIP download endpoints:
 *   GET /video/zip?ids=...          — arbitrary clip ids
 *   GET /video/job/:jobId/zip       — all clips of a finished job
 *
 * Covered:
 *   1. Happy path — all ids available → ZIP contains expected entries
 *   2. check=1 pre-flight — JSON summary, no ZIP built
 *   3. All ids expired / not found → 404
 *   4. Partial availability — some ids expired → ZIP has only available clips
 *   5. Duplicate clip names — de-duplicated inside the archive
 *   6. Invalid ids (fail the regex) — treated as missing
 *   7. No ids provided → 400
 *   8. /video/job/:jobId/zip — job not found → 404
 *   9. /video/job/:jobId/zip — job not yet done → 404
 *  10. /video/job/:jobId/zip — happy path → ZIP contains job clips
 *  11. /video/job/:jobId/zip — check=1 pre-flight
 *  12. /video/job/:jobId/zip — job with no clips → 404
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import express from "express";
import * as http from "http";
import fs from "fs";
import os from "os";
import path from "path";
import AdmZip from "adm-zip";

// ── Hoisted constants (accessible inside vi.mock factories) ───────────────────
// vi.hoisted runs before any imports, so we must use require() here.
const h = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const nodePath = require("path") as typeof import("path");
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const nodeOs = require("os") as typeof import("os");
  return {
    serveDir: nodePath.join(nodeOs.tmpdir(), "zip-test-serve"),
    // Typed as unknown here; cast to the concrete signature below (vi.fn generics
    // are not available inside vi.hoisted because type imports aren't resolved yet).
    resolveFile: vi.fn() as unknown as import("vitest").MockInstance<
      (id: string) => Promise<{ filePath: string; meta: { name: string; mimeType: string; ext: string; expiresMs: number; sizeBytes?: number } } | null>
    >,
  };
});

// ── child_process mock (videoTools.ts requires it at module level) ────────────
vi.mock("child_process", async () => {
  const { promisify } = await import("util");

  const execFile: ((...a: unknown[]) => never) & Record<symbol, unknown> = (() => {
    throw new Error("execFile not expected in zip tests");
  }) as never;
  execFile[promisify.custom] = async () => ({ stdout: "", stderr: "" });

  const exec: ((...a: unknown[]) => never) & Record<symbol, unknown> = (() => {
    throw new Error("exec not expected in zip tests");
  }) as never;
  exec[promisify.custom] = async () => ({ stdout: "", stderr: "" });

  const execSync = () => "";
  return { exec, execFile, execSync, default: { exec, execFile, execSync } };
});

// ── fileStore mock — resolveFile is controllable per-test ─────────────────────
vi.mock("../lib/fileStore", () => ({
  SERVE_DIR: h.serveDir,
  STORAGE_SIZE_CAP_BYTES: 10 * 1024 ** 3,
  getStorageClient: () => ({ list: async () => ({ ok: false, value: [] }) }),
  storeFile: vi.fn(async () => "stored-1"),
  resolveFile: h.resolveFile,
  checkStorageHealth: vi.fn(async () => ({ ok: true })),
  getStorageCircuitState: vi.fn(() => "CLOSED"),
  setBucketBytes: vi.fn(),
  initBucketCounter: vi.fn(async () => undefined),
  probeStorageIfOpen: vi.fn(async () => undefined),
}));

vi.mock("../lib/cookieStore", () => ({
  getCookieArgs: () => [],
  reportCookieBotBlock: vi.fn(),
  reportCookieSuccess: vi.fn(),
}));
vi.mock("../lib/ssrfGuard", () => ({ isSafePublicUrl: (u: string) => u.startsWith("http") }));
// Video routes now require a signed-in user and reserve credits before work;
// stub both so these pipeline tests run without a database. The stub user is
// an ADMIN: file/zip routes now enforce per-user ownership, and these tests
// exercise archive mechanics, not authorization (fileAuth.test.ts covers that).
vi.mock("../middlewares/sessionAuth", () => ({
  requireUser: (req: { currentUser?: unknown }, _res: unknown, next: () => void) => {
    req.currentUser = { id: "usr_test", role: "admin", email: "test@clipai.dev" };
    next();
  },
}));
vi.mock("../lib/billing", () => ({
  reserveCredits: async (_userId: string, count: number) => ({ ok: true as const, fromSub: 0, fromTopup: count }),
  refundCredits: async () => {},
  CREDITS_PER_CLIP: 50,
}));
vi.mock("../lib/kick", () => ({
  KickBlockedError: class extends Error {},
  curlHttpStatus: vi.fn(async () => 200),
  resolveKickFallbackSource: vi.fn(async () => { throw new Error("not used"); }),
  resolveKickLiveSrc: vi.fn(async () => { throw new Error("not used"); }),
}));

import videoToolsRouter from "../routes/videoTools.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

const JOBS_DIR = path.join(os.tmpdir(), `clipai-jobs-test-${process.pid}`);
fs.mkdirSync(JOBS_DIR, { recursive: true });

let server: http.Server;
let baseUrl: string;

let _idCounter = 0;
/** Unique id that passes the /^[\w-]{8,64}$/ guard in the route. */
function freshId(): string {
  return `test-clip-${String(++_idCounter).padStart(10, "0")}`;
}

type ResolveResult = { filePath: string; meta: { name: string; mimeType: string; ext: string; expiresMs: number; sizeBytes?: number } };

/** Write a dummy clip file and return a resolveFile result for it. */
function makeClip(name: string, ext = ".mp4"): { id: string; result: ResolveResult } {
  const id = freshId();
  const filePath = path.join(h.serveDir, `${id}${ext}`);
  fs.writeFileSync(filePath, `fake-video-bytes-for-${name}`);
  return {
    id,
    result: {
      filePath,
      meta: {
        name,
        mimeType: "video/mp4",
        ext,
        expiresMs: Date.now() + 2 * 60 * 60 * 1000,
        sizeBytes: 22 + name.length,
      },
    },
  };
}

/** Write a done job record to JOBS_DIR and return the jobId. */
function writeJob(clipIds: string[], clipNames: string[], status = "done"): string {
  const jobId = `job-${freshId()}`;
  const clips = clipIds.map((id, i) => ({
    id,
    name: clipNames[i] ?? `clip_${i + 1}.mp4`,
    label: `Clip ${i + 1}`,
    startTime: "0:00",
    endTime: "0:30",
    duration: "0:30",
    size: 1000,
    thumbnailDataUrl: "",
    thumbnailId: "",
  }));
  const rec = {
    status,
    createdMs: Date.now(),
    updatedMs: Date.now(),
    url: "https://www.youtube.com/watch?v=test",
    platform: "youtube",
    clips: clipIds.length ? clips : [],
    totalDuration: "10:00",
  };
  fs.writeFileSync(path.join(JOBS_DIR, `${jobId}.json`), JSON.stringify(rec));
  return jobId;
}

async function get(route: string): Promise<Response> {
  return fetch(`${baseUrl}${route}`);
}

/** Collect response body as a Buffer. */
async function bodyBuffer(res: Response): Promise<Buffer> {
  return Buffer.from(await res.arrayBuffer());
}

/** Parse a ZIP buffer and return the list of entry names. */
function zipEntryNames(buf: Buffer): string[] {
  const zip = new AdmZip(buf);
  return zip.getEntries().map(e => e.entryName);
}

beforeEach(async () => {
  h.resolveFile.mockReset();
  // Ensure the serve dir exists — it may be wiped between test-runner workers.
  fs.mkdirSync(h.serveDir, { recursive: true });

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { log: object }).log = { info() {}, warn() {}, error() {} };
    next();
  });
  app.use(videoToolsRouter);
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterEach(async () => {
  vi.restoreAllMocks();
  await new Promise<void>((resolve, reject) => server.close(e => (e ? reject(e) : resolve())));
});

// ── /video/zip ────────────────────────────────────────────────────────────────

describe("GET /video/zip", () => {
  it("1. happy path — returns a ZIP containing all requested clips", async () => {
    const c1 = makeClip("highlight_1.mp4");
    const c2 = makeClip("highlight_2.mp4");

    h.resolveFile.mockImplementation(async (id) => {
      if (id === c1.id) return c1.result;
      if (id === c2.id) return c2.result;
      return null;
    });

    const res = await get(`/video/zip?ids=${c1.id},${c2.id}`);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/zip");
    expect(res.headers.get("content-disposition")).toContain("clips.zip");
    // Availability headers — must match exactly when nothing is missing
    expect(res.headers.get("x-zip-available")).toBe("2");
    expect(res.headers.get("x-zip-requested")).toBe("2");

    const buf = await bodyBuffer(res);
    const entries = zipEntryNames(buf);
    expect(entries).toContain("highlight_1.mp4");
    expect(entries).toContain("highlight_2.mp4");
    expect(entries).toHaveLength(2);
  });

  it("2. check=1 — returns JSON summary without building a ZIP", async () => {
    const c1 = makeClip("clip_a.mp4");
    const c2 = makeClip("clip_b.mp4");

    h.resolveFile.mockImplementation(async (id) => {
      if (id === c1.id) return c1.result;
      if (id === c2.id) return c2.result;
      return null;
    });

    const res = await get(`/video/zip?ids=${c1.id},${c2.id}&check=1`);
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.available).toBe(2);
    expect(body.requested).toBe(2);
    // Must NOT be a ZIP
    expect(res.headers.get("content-type")).not.toContain("application/zip");
  });

  it("3. all ids expired — returns 404 with an error message", async () => {
    h.resolveFile.mockResolvedValue(null);

    const res = await get(`/video/zip?ids=${freshId()},${freshId()}`);
    expect(res.status).toBe(404);
    const body = await res.json() as Record<string, unknown>;
    expect(typeof body.error).toBe("string");
    expect((body.error as string).toLowerCase()).toMatch(/expired|not found/);
  });

  it("4. partial availability — ZIP signals missing clips via response headers", async () => {
    const c1 = makeClip("available.mp4");
    const expiredId = freshId();

    h.resolveFile.mockImplementation(async (id) => {
      if (id === c1.id) return c1.result;
      return null; // expiredId → missing
    });

    const res = await get(`/video/zip?ids=${c1.id},${expiredId}`);
    expect(res.status).toBe(200);

    // Non-silent partial: headers expose that fewer clips than requested are present
    expect(res.headers.get("x-zip-available")).toBe("1");
    expect(res.headers.get("x-zip-requested")).toBe("2");

    const buf = await bodyBuffer(res);
    const entries = zipEntryNames(buf);
    expect(entries).toContain("available.mp4");
    expect(entries).toHaveLength(1);
  });

  it("5. duplicate clip names — de-duplicated inside the archive", async () => {
    const c1 = makeClip("clip.mp4");
    const c2 = makeClip("clip.mp4"); // same name, different id

    h.resolveFile.mockImplementation(async (id) => {
      if (id === c1.id) return c1.result;
      if (id === c2.id) return c2.result;
      return null;
    });

    const res = await get(`/video/zip?ids=${c1.id},${c2.id}`);
    expect(res.status).toBe(200);

    const buf = await bodyBuffer(res);
    const entries = zipEntryNames(buf);
    expect(entries).toHaveLength(2);
    // First keeps original name; second gets a numeric suffix
    expect(entries).toContain("clip.mp4");
    expect(entries).toContain("clip (2).mp4");
    // No collisions
    expect(new Set(entries).size).toBe(entries.length);
  });

  it("6. invalid ids all filtered out → 400 (no valid ids provided)", async () => {
    // All ids fail the /^[\w-]{8,64}$/ guard: too short, spaces, exclamation.
    // The route receives an empty ids array → "No clip ids provided" → 400.
    const res = await get(`/video/zip?ids=ab,has space,!bad`);
    expect(res.status).toBe(400);
  });

  it("7. no ids at all → 400", async () => {
    const res = await get(`/video/zip?ids=`);
    expect(res.status).toBe(400);
  });

  it("check=1 with partial availability — reports correct counts", async () => {
    const c1 = makeClip("ok.mp4");
    const expiredId = freshId();

    h.resolveFile.mockImplementation(async (id) => {
      if (id === c1.id) return c1.result;
      return null;
    });

    const res = await get(`/video/zip?ids=${c1.id},${expiredId}&check=1`);
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.available).toBe(1);
    expect(body.requested).toBe(2);
  });
});

// ── /video/job/:jobId/zip ─────────────────────────────────────────────────────

describe("GET /video/job/:jobId/zip", () => {
  it("8. job not found → 404", async () => {
    const res = await get(`/video/job/${freshId()}/zip`);
    expect(res.status).toBe(404);
    const body = await res.json() as Record<string, unknown>;
    expect(typeof body.error).toBe("string");
  });

  it("9. job still processing → 404", async () => {
    const jobId = writeJob([], [], "processing");
    const res = await get(`/video/job/${jobId}/zip`);
    expect(res.status).toBe(404);
  });

  it("10. happy path — done job → ZIP with all clips", async () => {
    const c1 = makeClip("job_clip_1.mp4");
    const c2 = makeClip("job_clip_2.mp4");

    h.resolveFile.mockImplementation(async (id) => {
      if (id === c1.id) return c1.result;
      if (id === c2.id) return c2.result;
      return null;
    });

    const jobId = writeJob([c1.id, c2.id], ["job_clip_1.mp4", "job_clip_2.mp4"]);

    const res = await get(`/video/job/${jobId}/zip`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/zip");
    expect(res.headers.get("x-zip-available")).toBe("2");
    expect(res.headers.get("x-zip-requested")).toBe("2");

    const buf = await bodyBuffer(res);
    const entries = zipEntryNames(buf);
    expect(entries).toContain("job_clip_1.mp4");
    expect(entries).toContain("job_clip_2.mp4");
    expect(entries).toHaveLength(2);
  });

  it("11. check=1 on a done job — returns JSON summary", async () => {
    const c1 = makeClip("job_c1.mp4");

    h.resolveFile.mockImplementation(async (id) => {
      if (id === c1.id) return c1.result;
      return null;
    });

    const jobId = writeJob([c1.id], ["job_c1.mp4"]);

    const res = await get(`/video/job/${jobId}/zip?check=1`);
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.available).toBe(1);
    expect(body.requested).toBe(1);
  });

  it("12. done job with no clips → 404", async () => {
    const jobId = writeJob([], []);
    const res = await get(`/video/job/${jobId}/zip`);
    expect(res.status).toBe(404);
  });
});
