/**
 * Per-IP queue fairness tests for routes/videoTools.ts (Task: stop one heavy
 * user from filling the whole queue for everyone else).
 *
 * Covered:
 *   1. One IP cannot hold more than MAX_QUEUED_PER_IP waiting slots — extra
 *      submissions get a clear "you already have N jobs waiting" 429.
 *   2. A second IP can still queue jobs while the first IP is capped.
 *   3. Load test: two simulated users submitting bursts interleave — every
 *      accepted job from BOTH users finishes; neither is starved.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import express from "express";
import * as http from "http";
import os from "os";
import path from "path";

// Module-level env reads — set BEFORE videoTools is imported.
vi.hoisted(() => {
  process.env.MAX_CONCURRENT_JOBS = "1";
  process.env.MAX_QUEUED_PER_IP = "3";
});

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
      await wait(150);
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
  SERVE_DIR: path.join(os.tmpdir(), "per-ip-cap-test-serve"),
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

import videoToolsRouter, { getJobQueueStats } from "../routes/videoTools.js";

let server: http.Server;
let baseUrl: string;

let urlCounter = 0;
function freshUrl(): string {
  return `https://www.youtube.com/watch?v=fair${String(urlCounter++).padStart(7, "0")}`;
}

/** POST /video/clip spoofing the client IP via X-Forwarded-For (trust proxy). */
async function postAs(ip: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${baseUrl}/video/clip`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Forwarded-For": ip },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function getJob(jobId: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${baseUrl}/video/job/${jobId}`);
  return (await res.json()) as Record<string, unknown>;
}

beforeEach(async () => {
  const app = express();
  app.set("trust proxy", 1); // same as production app.ts — req.ip honors X-Forwarded-For
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

async function drainQueue(timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const s = getJobQueueStats();
    if (s.active === 0 && s.queued === 0) return;
    await sleep(200);
  }
  throw new Error("queue did not drain in time");
}

describe("per-IP queue fairness (MAX_CONCURRENT_JOBS=1, MAX_QUEUED_PER_IP=3)", () => {
  it("caps one IP at 3 waiting slots with a clear 429, while another IP can still queue", async () => {
    const heavy = "203.0.113.10";
    const light = "198.51.100.20";

    // Heavy user: 1 job takes the slot, next 3 queue, remaining are capped.
    const results: { status: number; body: Record<string, unknown> }[] = [];
    for (let i = 0; i < 6; i++) {
      results.push(await postAs(heavy, { url: freshUrl(), clipCount: 1, clipDuration: 10, async: true }));
    }
    const accepted = results.filter((r) => r.status === 202);
    const rejected = results.filter((r) => r.status === 429);
    expect(accepted).toHaveLength(4); // 1 active + 3 queued
    expect(rejected).toHaveLength(2);
    for (const r of rejected) {
      expect(String(r.body.error)).toMatch(/already have 3 jobs waiting/i);
    }

    // Light user is NOT locked out despite the heavy user's burst.
    const ok = await postAs(light, { url: freshUrl(), clipCount: 1, clipDuration: 10, async: true });
    expect(ok.status).toBe(202);

    await drainQueue();
  }, 40_000);

  it("load test: two users' bursts interleave — all accepted jobs from both finish", async () => {
    const userA = "203.0.113.77";
    const userB = "198.51.100.88";

    const jobsA: string[] = [];
    const jobsB: string[] = [];
    // Interleaved bursts: each user keeps submitting; capped submissions retry later.
    for (let round = 0; round < 4; round++) {
      const [ra, rb] = await Promise.all([
        postAs(userA, { url: freshUrl(), clipCount: 1, clipDuration: 10, async: true }),
        postAs(userB, { url: freshUrl(), clipCount: 1, clipDuration: 10, async: true }),
      ]);
      if (ra.status === 202) jobsA.push(ra.body.jobId as string);
      if (rb.status === 202) jobsB.push(rb.body.jobId as string);
      await sleep(50);
    }

    // Both users got jobs accepted — neither starved the other out entirely.
    expect(jobsA.length).toBeGreaterThanOrEqual(2);
    expect(jobsB.length).toBeGreaterThanOrEqual(2);

    // Every accepted job from BOTH users reaches "done".
    const all = [...jobsA, ...jobsB];
    const deadline = Date.now() + 30_000;
    let finals: Record<string, unknown>[] = [];
    while (Date.now() < deadline) {
      finals = await Promise.all(all.map(getJob));
      if (finals.every((r) => r.status === "done" || r.status === "error")) break;
      await sleep(200);
    }
    expect(finals.map((r) => r.status)).toEqual(all.map(() => "done"));

    await drainQueue();
  }, 60_000);
});
