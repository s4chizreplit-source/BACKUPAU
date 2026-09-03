/**
 * Global job-queue tests for routes/videoTools.ts (Task: job queue so many
 * concurrent users don't crash the server), with yt-dlp/ffmpeg fully mocked.
 *
 * Covered:
 *   1. With MAX_CONCURRENT_JOBS=1, five concurrent async clip jobs serialize:
 *      only one pipeline runs at a time (probe concurrency never exceeds 1).
 *   2. While waiting, job records report status "queued" with distinct FIFO
 *      queuePosition values — surfaced through GET /video/job/:id.
 *   3. getJobQueueStats() reflects active/queued depth (healthz visibility).
 *   4. All five jobs eventually finish "done" — nothing is lost in the queue.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import express from "express";
import * as http from "http";
import os from "os";
import path from "path";

// Force a single processing slot BEFORE videoTools is imported (module-level env read).
vi.hoisted(() => {
  process.env.MAX_CONCURRENT_JOBS = "1";
  // These tests submit many jobs from one IP on purpose — lift the per-IP
  // fairness cap so FIFO behaviour itself is what's under test.
  process.env.MAX_QUEUED_PER_IP = "100";
});

const h = vi.hoisted(() => ({
  probeConcurrent: 0,
  probeMax: 0,
  probeCount: 0,
}));

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

    // yt-dlp metadata probe — the first pipeline step of every job. Slow it
    // down so concurrent jobs WOULD overlap here if the queue didn't serialize.
    if (argStr.includes("--dump-json") && argStr.includes("--skip-download")) {
      h.probeCount++;
      h.probeConcurrent++;
      h.probeMax = Math.max(h.probeMax, h.probeConcurrent);
      await wait(250);
      h.probeConcurrent--;
      return { stdout: JSON.stringify({ duration: 120, is_live: false }), stderr: "" };
    }
    // subtitle fetch — write no .vtt → spread strategy
    if (argStr.includes("--write-auto-subs") || argStr.includes("--write-subs")) {
      return { stdout: "", stderr: "" };
    }
    if (argStr.includes("volumedetect")) {
      return { stdout: "", stderr: "[Parsed_volumedetect_0] mean_volume: -20.0 dB\n[Parsed_volumedetect_0] max_volume: -5.0 dB\n" };
    }
    // yt-dlp section downloads (audio probe + clip sections)
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
    // everything else = ffmpeg (clip encode / thumbnail) — output is last arg
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
  SERVE_DIR: path.join(os.tmpdir(), "job-queue-test-serve"),
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
  return `https://www.youtube.com/watch?v=queue${String(urlCounter++).padStart(6, "0")}`;
}

async function post(route: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${baseUrl}${route}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function getJob(jobId: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${baseUrl}/video/job/${jobId}`);
  return (await res.json()) as Record<string, unknown>;
}

beforeEach(async () => {
  h.probeConcurrent = 0;
  h.probeMax = 0;
  h.probeCount = 0;

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

describe("global job queue (MAX_CONCURRENT_JOBS=1)", () => {
  it("serializes 5 concurrent jobs, reports queue positions, and finishes them all", async () => {
    // Fire 5 concurrent async clip jobs (distinct URLs → no in-flight dedupe)
    const submissions = await Promise.all(
      Array.from({ length: 5 }, () =>
        post("/video/clip", { url: freshUrl(), clipCount: 1, clipDuration: 10, async: true }),
      ),
    );
    const jobIds = submissions.map((s) => {
      expect(s.status).toBe(202);
      return s.body.jobId as string;
    });

    // Give intake a moment: exactly one job should be processing, four queued.
    await sleep(100);
    const stats = getJobQueueStats();
    expect(stats.maxConcurrent).toBe(1);
    expect(stats.active).toBe(1);
    expect(stats.queued).toBe(4);

    // Job records report honest queued statuses with distinct FIFO positions 1..4
    const records = await Promise.all(jobIds.map(getJob));
    const queued = records.filter((r) => r.status === "queued");
    expect(queued).toHaveLength(4);
    const positions = queued.map((r) => r.queuePosition).sort();
    expect(positions).toEqual([1, 2, 3, 4]);
    expect(records.filter((r) => r.status === "processing")).toHaveLength(1);

    // Wait for all 5 to finish — poll until done (each pipeline ≥250ms probe)
    const deadline = Date.now() + 30_000;
    let finals: Record<string, unknown>[] = [];
    while (Date.now() < deadline) {
      finals = await Promise.all(jobIds.map(getJob));
      if (finals.every((r) => r.status === "done" || r.status === "error")) break;
      await sleep(200);
    }
    expect(finals.map((r) => r.status)).toEqual(["done", "done", "done", "done", "done"]);

    // The queue serialized processing: pipelines never overlapped at the probe.
    expect(h.probeCount).toBe(5);
    expect(h.probeMax).toBe(1);

    // Queue fully drained
    const after = getJobQueueStats();
    expect(after.active).toBe(0);
    expect(after.queued).toBe(0);
  }, 40_000);

  it("DELETE /video/job/:id cancels a queued job (frees its spot) but rejects a processing one", async () => {
    // Job A takes the single slot; jobs B and C wait in line.
    const [a, b, c] = await Promise.all(
      Array.from({ length: 3 }, () =>
        post("/video/clip", { url: freshUrl(), clipCount: 1, clipDuration: 10, async: true }),
      ),
    );
    const ids = [a, b, c].map((s) => {
      expect(s.status).toBe(202);
      return s.body.jobId as string;
    });

    await sleep(100);
    const recs = await Promise.all(ids.map(getJob));
    const processingIdx = recs.findIndex((r) => r.status === "processing");
    const queuedIdxs = recs.map((r, i) => (r.status === "queued" ? i : -1)).filter((i) => i !== -1);
    expect(processingIdx).not.toBe(-1);
    expect(queuedIdxs).toHaveLength(2);

    // Cancel the LAST queued job — it leaves the line.
    const victim = ids[queuedIdxs[1]];
    const del = await fetch(`${baseUrl}/video/job/${victim}`, { method: "DELETE" });
    expect(del.status).toBe(200);
    expect(((await del.json()) as { status: string }).status).toBe("cancelled");

    // Terminal cancelled record; queue depth dropped by one.
    expect((await getJob(victim)).status).toBe("cancelled");
    expect(getJobQueueStats().queued).toBe(1);

    // Cancelling again is idempotent.
    const again = await fetch(`${baseUrl}/video/job/${victim}`, { method: "DELETE" });
    expect(again.status).toBe(200);

    // Cancelling the PROCESSING job is rejected.
    const delProc = await fetch(`${baseUrl}/video/job/${ids[processingIdx]}`, { method: "DELETE" });
    expect(delProc.status).toBe(409);

    // The remaining jobs still finish; the cancelled one never ran its pipeline.
    const survivors = ids.filter((id) => id !== victim);
    const deadline = Date.now() + 30_000;
    let finals: Record<string, unknown>[] = [];
    while (Date.now() < deadline) {
      finals = await Promise.all(survivors.map(getJob));
      if (finals.every((r) => r.status === "done" || r.status === "error")) break;
      await sleep(200);
    }
    expect(finals.map((r) => r.status)).toEqual(["done", "done"]);
    expect((await getJob(victim)).status).toBe("cancelled");
    expect(h.probeCount).toBe(2); // cancelled job never reached the pipeline
    expect(getJobQueueStats().active).toBe(0);
    expect(getJobQueueStats().queued).toBe(0);
  }, 40_000);

  it("DELETE /video/job/:id returns 404 for an unknown job", async () => {
    const res = await fetch(`${baseUrl}/video/job/deadbeefdeadbeef`, { method: "DELETE" });
    expect(res.status).toBe(404);
  });

  it("single job on an idle server processes immediately (no queued status)", async () => {
    const { status, body } = await post("/video/clip", {
      url: freshUrl(), clipCount: 1, clipDuration: 10, async: true,
    });
    expect(status).toBe(202);
    const jobId = body.jobId as string;

    await sleep(50);
    const rec = await getJob(jobId);
    expect(rec.status === "processing" || rec.status === "done").toBe(true);

    const deadline = Date.now() + 15_000;
    let final = rec;
    while (Date.now() < deadline && final.status !== "done" && final.status !== "error") {
      await sleep(150);
      final = await getJob(jobId);
    }
    expect(final.status).toBe("done");
  }, 20_000);
});
