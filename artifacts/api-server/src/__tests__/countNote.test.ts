/**
 * countNote consistency tests for routes/videoTools.ts.
 *
 * When a video can't hold the requested clip count, the API must say so via
 * `countNote` — on the synchronous response, the async job response, AND the
 * async cache-hit path (regression: the cached settleJob() used to drop it,
 * so polling clients saw fewer clips with no explanation).
 *
 * Mocked pipeline reports a 120s video → four 30s clips fit (butt-joined).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import express from "express";
import * as http from "http";
import os from "os";
import path from "path";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── child_process mock — promisify-aware exec/execFile fakes ─────────────────
vi.mock("child_process", async () => {
  const { promisify } = await import("util");
  const nodeFs = await import("fs");
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

  const execFile: ((...a: unknown[]) => never) & Record<symbol, unknown> = (() => {
    throw new Error("callback-style execFile not expected in tests");
  }) as never;
  execFile[promisify.custom] = async (file: string, args: string[]) => {
    const argStr = args.join(" ");
    const outIdx = args.indexOf("-o");
    if (argStr.includes("--dump-json") && argStr.includes("--skip-download")) {
      await wait(50);
      return { stdout: JSON.stringify({ duration: 120, is_live: false }), stderr: "" };
    }
    if (argStr.includes("--write-auto-subs") || argStr.includes("--write-subs")) {
      return { stdout: "", stderr: "" };
    }
    if (argStr.includes("volumedetect")) {
      return { stdout: "", stderr: "[Parsed_volumedetect_0] mean_volume: -20.0 dB\n[Parsed_volumedetect_0] max_volume: -5.0 dB\n" };
    }
    if (argStr.includes("--download-sections")) {
      nodeFs.writeFileSync(args[outIdx + 1], Buffer.alloc(20_000, 1));
      return { stdout: "", stderr: "" };
    }
    if (outIdx !== -1 && argStr.includes("--merge-output-format")) {
      nodeFs.writeFileSync(args[outIdx + 1], Buffer.alloc(50_000, 2));
      return { stdout: "", stderr: "" };
    }
    if (argStr.includes("-show_format")) {
      return { stdout: JSON.stringify({ format: { duration: "120" } }), stderr: "" };
    }
    nodeFs.writeFileSync(args[args.length - 1], Buffer.alloc(15_000, 3));
    return { stdout: "", stderr: "" };
  };

  const exec: ((...a: unknown[]) => never) & Record<symbol, unknown> = (() => {
    throw new Error("callback-style exec not expected in tests");
  }) as never;
  exec[promisify.custom] = async (cmd: string) => {
    if (cmd.includes("-show_format")) {
      return { stdout: JSON.stringify({ format: { duration: "120" } }), stderr: "" };
    }
    const nodeFs = await import("fs");
    const m = cmd.match(/"([^"]+)"\s*$/);
    if (m) nodeFs.writeFileSync(m[1], Buffer.alloc(12_000, 4));
    return { stdout: "", stderr: "" };
  };

  const execSync = () => "";
  return { exec, execFile, execSync, default: { exec, execFile, execSync } };
});

// ── fileStore mock — no Object Storage, no disk cache side effects ───────────
vi.mock("../lib/fileStore", () => ({
  SERVE_DIR: path.join(os.tmpdir(), "count-note-test-serve"),
  STORAGE_SIZE_CAP_BYTES: 10 * 1024 ** 3,
  getStorageClient: () => ({
    list: async () => ({ ok: false, value: [] }),
    uploadFromText: async () => ({ ok: true }),
    downloadAsText: async () => ({ ok: false }),
    delete: async () => ({ ok: true }),
  }),
  storeFile: vi.fn(async () => `stored-${Math.random().toString(36).slice(2)}`),
  resolveFile: vi.fn(async () => null),
  checkStorageHealth: vi.fn(async () => ({ ok: true })),
  getStorageCircuitState: vi.fn(() => "CLOSED"),
  setBucketBytes: vi.fn(),
  initBucketCounter: vi.fn(async () => undefined),
  probeStorageIfOpen: vi.fn(async () => undefined),
}));

vi.mock("../lib/cookieStore", () => ({
  getCookieArgs: () => [],
  reportCookieBotBlock: () => {},
  reportCookieSuccess: () => {},
}));
vi.mock("../lib/ssrfGuard", () => ({ isSafePublicUrl: (u: string) => u.startsWith("http") }));
// Video routes now require a signed-in user and reserve credits before work;
// stub both so these pipeline tests run without a database.
vi.mock("../middlewares/sessionAuth", () => ({
  requireUser: (req: { currentUser?: unknown }, _res: unknown, next: () => void) => {
    req.currentUser = { id: "usr_test", role: "user", email: "test@clipai.dev" };
    next();
  },
}));
vi.mock("../lib/billing", () => ({
  reserveCredits: async (_userId: string, count: number) => ({ ok: true as const, fromSub: 0, fromTopup: count }),
  refundCredits: async () => {},
  CREDITS_PER_CLIP: 50,
}));

import videoToolsRouter from "../routes/videoTools.js";

let server: http.Server;
let baseUrl: string;

let urlCounter = 0;
function freshUrl(): string {
  return `https://www.youtube.com/watch?v=note${String(urlCounter++).padStart(7, "0")}`;
}

async function postClip(body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${baseUrl}/video/clip`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function pollDone(jobId: string, timeoutMs = 30_000): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await fetch(`${baseUrl}/video/job/${jobId}`);
    const j = (await res.json()) as Record<string, unknown>;
    if (j.status === "done") return j;
    if (j.status === "error") throw new Error(`job errored: ${j.error}`);
    await sleep(150);
  }
  throw new Error("job did not finish in time");
}

beforeEach(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { log: object }).log = { info() {}, warn() {}, error() {} };
    next();
  });
  app.use(videoToolsRouter);
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const addr = server.address() as { port: number };
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterEach(async () => {
  vi.restoreAllMocks();
  await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
});

describe("countNote on short videos", () => {
  it("sync response explains when fewer clips fit than requested", async () => {
    const { status, body } = await postClip({ url: freshUrl(), clipDuration: 30, clipCount: 10 });
    expect(status).toBe(200);
    const clips = body.clips as unknown[];
    expect(clips).toHaveLength(4); // 120s video, butt-joined 30s clips
    expect(body.countNote).toMatch(/only fits 4 non-overlapping 30s clips/);
    expect(body.countNote).toMatch(/asked for 10/);
  }, 40_000);

  it("omits the note when the requested count fits", async () => {
    const { status, body } = await postClip({ url: freshUrl(), clipDuration: 30, clipCount: 2 });
    expect(status).toBe(200);
    expect((body.clips as unknown[]).length).toBe(2);
    expect(body.countNote).toBeUndefined();
  }, 40_000);

  it("async job carries the note, including on the cache-hit path", async () => {
    const url = freshUrl();

    // First async run — fresh processing.
    const first = await postClip({ url, clipDuration: 30, clipCount: 10, async: true });
    expect(first.status).toBe(202);
    const firstJob = await pollDone(first.body.jobId as string);
    expect((firstJob.clips as unknown[]).length).toBe(4);
    expect(firstJob.countNote).toMatch(/only fits 4/);

    // Second async run — served from the 2h result cache (regression: the
    // cached settleJob() used to drop countNote for polling clients).
    const second = await postClip({ url, clipDuration: 30, clipCount: 10, async: true });
    expect(second.status).toBe(202);
    const secondJob = await pollDone(second.body.jobId as string);
    expect((secondJob.clips as unknown[]).length).toBe(4);
    expect(secondJob.countNote).toMatch(/only fits 4/);
    expect(secondJob.countNote).toBe(firstJob.countNote);
  }, 60_000);
});
