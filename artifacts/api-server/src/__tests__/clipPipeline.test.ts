/**
 * Unit tests for the clip pipeline in routes/videoTools.ts, with yt-dlp and
 * ffmpeg fully mocked (no network, no real binaries).
 *
 * Covered:
 *   1. Fast path — duration probe + per-clip section downloads succeed:
 *      no full-video download happens, clips are indexed/stored correctly.
 *   2. Fallback — probe failure or section-download failure → the full
 *      download path runs (yt-dlp full download + ffprobe duration).
 *   3. Temp cleanup — /video/clip, /video/trim, /video/crop-vertical and
 *      /video/extract-audio remove their scratch dirs on success AND failure.
 *   4. Disk guard — low free space → 503 before the queue, and a clean error
 *      when space vanishes after the queue wait.
 *   5. pickSpreadTimestamps edge cases (margins, clamping, short videos).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import express from "express";
import * as http from "http";
import fs from "fs";
import os from "os";
import path from "path";

// ── Shared mock state (hoisted so the child_process factory can see it) ──────
const h = vi.hoisted(() => ({
  /** Per-test behaviour flags for the fake yt-dlp / ffmpeg dispatcher. */
  opts: {
    duration: 600,
    failProbe: false,
    failSections: false,
    failFfmpeg: false,
  },
  execFileCalls: [] as Array<{ file: string; args: string[] }>,
  execCalls: [] as string[],
}));

// ── child_process mock — promisify-aware exec/execFile fakes ─────────────────
vi.mock("child_process", async () => {
  const { promisify } = await import("util");
  const nodeFs = await import("fs");

  const execFile: ((...a: unknown[]) => never) & Record<symbol, unknown> = (() => {
    throw new Error("callback-style execFile not expected in tests");
  }) as never;
  execFile[promisify.custom] = async (file: string, args: string[]) => {
    h.execFileCalls.push({ file, args });
    const argStr = args.join(" ");
    const outIdx = args.indexOf("-o");

    // yt-dlp metadata probe (--dump-json --skip-download)
    if (argStr.includes("--dump-json") && argStr.includes("--skip-download")) {
      if (h.opts.failProbe) throw new Error("ERROR: probe failed (mock)");
      return { stdout: JSON.stringify({ duration: h.opts.duration, is_live: false }), stderr: "" };
    }
    // yt-dlp subtitle fetch — resolve but write no .vtt → spread strategy
    if (argStr.includes("--write-auto-subs") || argStr.includes("--write-subs")) {
      return { stdout: "", stderr: "" };
    }
    // ffmpeg volumedetect (audio-energy measurement) — return parseable stats
    if (argStr.includes("volumedetect")) {
      return { stdout: "", stderr: "[Parsed_volumedetect_0] mean_volume: -20.0 dB\n[Parsed_volumedetect_0] max_volume: -5.0 dB\n" };
    }
    // yt-dlp audio-only probe section (audio-energy scoring)
    if (argStr.includes("bestaudio[ext=m4a]/bestaudio/best")) {
      if (h.opts.failSections) throw new Error("ERROR: fragment not found (mock)");
      nodeFs.writeFileSync(args[outIdx + 1], Buffer.alloc(5_000, 5));
      return { stdout: "", stderr: "" };
    }
    // yt-dlp section download
    if (argStr.includes("--download-sections")) {
      if (h.opts.failSections) throw new Error("ERROR: fragment not found (mock)");
      nodeFs.writeFileSync(args[outIdx + 1], Buffer.alloc(20_000, 1));
      return { stdout: "", stderr: "" };
    }
    // yt-dlp full download (has -o + merge flag, no sections)
    if (outIdx !== -1 && argStr.includes("--merge-output-format")) {
      nodeFs.writeFileSync(args[outIdx + 1], Buffer.alloc(50_000, 2));
      return { stdout: "", stderr: "" };
    }
    // ffprobe duration probe (full-download path) — now execFile-based
    if (argStr.includes("-show_format")) {
      return { stdout: JSON.stringify({ format: { duration: String(h.opts.duration) } }), stderr: "" };
    }
    // everything else = ffmpeg (clip encode / thumbnail) — output is last arg
    if (h.opts.failFfmpeg) throw new Error("ffmpeg exploded (mock)");
    nodeFs.writeFileSync(args[args.length - 1], Buffer.alloc(15_000, 3));
    return { stdout: "", stderr: "" };
  };

  const exec: ((...a: unknown[]) => never) & Record<symbol, unknown> = (() => {
    throw new Error("callback-style exec not expected in tests");
  }) as never;
  exec[promisify.custom] = async (cmd: string) => {
    h.execCalls.push(cmd);
    // ffprobe duration probe on the full-download path
    if (cmd.includes("-show_format")) {
      return { stdout: JSON.stringify({ format: { duration: String(h.opts.duration) } }), stderr: "" };
    }
    // ffmpeg via shell (extract-audio) — output is the last quoted path
    if (h.opts.failFfmpeg) throw new Error("ffmpeg exploded (mock)");
    const m = cmd.match(/"([^"]+)"\s*$/);
    if (m) nodeFs.writeFileSync(m[1], Buffer.alloc(12_000, 4));
    return { stdout: "", stderr: "" };
  };

  const execSync = () => "";
  return { exec, execFile, execSync, default: { exec, execFile, execSync } };
});

// ── fileStore mock — no Object Storage, no disk cache side effects ───────────
const storedFiles: Array<{ filePath: string; name: string; mimeType: string }> = [];
vi.mock("../lib/fileStore", () => ({
  SERVE_DIR: path.join(os.tmpdir(), "clip-pipeline-test-serve"),
  STORAGE_SIZE_CAP_BYTES: 10 * 1024 ** 3,
  getStorageClient: () => ({ list: async () => ({ ok: false, value: [] }) }),
  storeFile: vi.fn(async (filePath: string, name: string, mimeType: string) => {
    // The source scratch file must still exist at store time.
    if (!fs.existsSync(filePath)) throw new Error(`storeFile: missing ${filePath}`);
    storedFiles.push({ filePath, name, mimeType });
    return `stored-${storedFiles.length}`;
  }),
  resolveFile: vi.fn(async () => null),
  checkStorageHealth: vi.fn(async () => ({ ok: true })),
  getStorageCircuitState: vi.fn(() => "CLOSED"),
  setBucketBytes: vi.fn(),
  initBucketCounter: vi.fn(async () => undefined),
  probeStorageIfOpen: vi.fn(async () => undefined),
}));

vi.mock("../lib/cookieStore", () => ({ getCookieArgs: () => [] }));
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

import videoToolsRouter, { composeYoutubeBlockedError, deriveGlobalEncodeParallel, deriveMaxConcurrentJobs, isQualityDowngrade, makeFairLimiter, ytdlpFormatLadder } from "../routes/videoTools.js";

// ── Test server ───────────────────────────────────────────────────────────────
let server: http.Server;
let baseUrl: string;

async function post(route: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${baseUrl}${route}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

/** All viralai-* scratch dirs in this worker's scratch root (per-pid under vitest). */
const SCRATCH_ROOT = path.join(os.tmpdir(), `viralai-scratch-${process.pid}`);
function scratchDirs(): string[] {
  if (!fs.existsSync(SCRATCH_ROOT)) return [];
  return fs.readdirSync(SCRATCH_ROOT).filter((d) => d.startsWith("viralai-"));
}

const TMP_PREFIXES = ["viralai-clip-", "viralai-trim-", "viralai-vert-", "viralai-audio-", "viralai-hlt-", "viralai-dl-", "viralai-aprobe-"];
function newScratchDirs(before: string[]): string[] {
  return scratchDirs().filter((d) => !before.includes(d) && TMP_PREFIXES.some((p) => d.startsWith(p)));
}

/** Full yt-dlp downloads = merge flag present, but no --download-sections. */
function fullDownloadCalls() {
  return h.execFileCalls.filter(
    (c) => c.args.includes("--merge-output-format") && !c.args.includes("--download-sections"),
  );
}
/** Clip section downloads only — excludes audio-energy probe downloads. */
function sectionDownloadCalls() {
  return h.execFileCalls.filter(
    (c) => c.args.includes("--download-sections") && !c.args.includes("bestaudio[ext=m4a]/bestaudio/best"),
  );
}
/** Audio-only probe section downloads (audio-energy scoring). */
function audioProbeCalls() {
  return h.execFileCalls.filter((c) => c.args.includes("bestaudio[ext=m4a]/bestaudio/best"));
}

describe("yt-dlp quality ladder", () => {
  it("keeps 720p/1080p WebM video eligible instead of filtering by MP4 extension", () => {
    expect(ytdlpFormatLadder(1080)).toEqual([
      "bestvideo[height<=1080]+bestaudio/bestvideo[width<=1080]+bestaudio/best[height<=1080]/best[width<=1080]",
      "bestvideo[height<=720]+bestaudio/bestvideo[width<=720]+bestaudio/best[height<=720]/best[width<=720]",
      "bestvideo[height<=480]+bestaudio/bestvideo[width<=480]+bestaudio/best[height<=480]/best[width<=480]",
    ]);
    expect(ytdlpFormatLadder(720)).toEqual([
      "bestvideo[height<=720]+bestaudio/bestvideo[width<=720]+bestaudio/best[height<=720]/best[width<=720]",
      "bestvideo[height<=480]+bestaudio/bestvideo[width<=480]+bestaudio/best[height<=480]/best[width<=480]",
    ]);
    expect(ytdlpFormatLadder(1080).some((format) => format.includes("[ext="))).toBe(false);
  });

  it("keeps HD portrait/Shorts eligible: every rung has a width-constrained alternative", () => {
    // A 720x1280 Short has height 1280 — [height<=720] alone would exclude its
    // HD formats and the ladder would find nothing (or worse, a 360p stream).
    for (const fmt of [...ytdlpFormatLadder(1080), ...ytdlpFormatLadder(720)]) {
      expect(fmt).toMatch(/bestvideo\[width<=\d+\]\+bestaudio/);
    }
  });

  it("never leaves an unconstrained /best tail by default (the silent 360p leak)", () => {
    for (const fmt of [...ytdlpFormatLadder(1080), ...ytdlpFormatLadder(720)]) {
      expect(fmt.endsWith("/best")).toBe(false);
    }
  });

  it("keeps the unconstrained tail for generic platforms that omit heights", () => {
    for (const fmt of ytdlpFormatLadder(1080, { anyFinalFallback: true })) {
      expect(fmt.endsWith("/best")).toBe(true);
    }
  });
});

describe("machine-size-aware concurrency (settings scale with the server)", () => {
  it("scales encode slots with cores and RAM, capped at 8", () => {
    expect(deriveGlobalEncodeParallel(4, 16)).toBe(3);   // Hostinger KVM4
    expect(deriveGlobalEncodeParallel(16, 64)).toBe(8);  // big box → cap
    expect(deriveGlobalEncodeParallel(2, 2)).toBe(1);    // tiny box → floor
    expect(deriveGlobalEncodeParallel(8, 4)).toBe(2);    // RAM-starved: RAM wins
  });
  it("lets many jobs stay active (network stages overlap), capped at 16", () => {
    expect(deriveMaxConcurrentJobs(4, 16)).toBe(8);      // KVM4: 8 active jobs
    expect(deriveMaxConcurrentJobs(16, 64)).toBe(16);    // big box → cap
    expect(deriveMaxConcurrentJobs(2, 2)).toBe(1);       // tiny box → floor
  });
});

describe("fair encode scheduler (no user waits behind another job's whole batch)", () => {
  it("round-robins slots across jobs instead of draining one job first", async () => {
    const limit = makeFairLimiter(1);
    const started: string[] = [];
    const mk = (label: string) => () => { started.push(label); return Promise.resolve(); };
    await Promise.all([
      limit("jobA", mk("A1")), limit("jobA", mk("A2")), limit("jobA", mk("A3")),
      limit("jobB", mk("B1")), limit("jobC", mk("C1")),
    ]);
    // A1 starts instantly; afterwards every waiting job gets a turn per
    // rotation (A2 queued before B/C arrived) instead of A draining fully.
    expect(started).toEqual(["A1", "A2", "B1", "C1", "A3"]);
  });
  it("never exceeds the slot cap and keeps going after a rejection", async () => {
    const limit = makeFairLimiter(2);
    let running = 0; let peak = 0;
    const mk = (fail = false) => async () => {
      running++; peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 5));
      running--;
      if (fail) throw new Error("boom");
    };
    const results = await Promise.allSettled([
      limit("a", mk()), limit("a", mk(true)), limit("b", mk()),
      limit("c", mk()), limit("b", mk(true)), limit("d", mk()),
    ]);
    expect(peak).toBeLessThanOrEqual(2);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(2);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(4);
  });
  it("releases the slot when fn throws synchronously (fast path and queued)", async () => {
    const limit = makeFairLimiter(1);
    const boom = (() => { throw new Error("sync-boom"); }) as unknown as () => Promise<void>;
    // Fast path: thrower starts immediately.
    await expect(limit("a", boom)).rejects.toThrow("sync-boom");
    // Queued path: thrower fires from dispatch() after the running task ends.
    let release!: () => void;
    const first = limit("a", () => new Promise<void>((r) => { release = r; }));
    await Promise.resolve(); // fn starts on a microtask now — let it assign `release`
    const queuedBoom = limit("b", boom);
    release();
    await first;
    await expect(queuedBoom).rejects.toThrow("sync-boom");
    // Slot must be free again — a later task still runs to completion.
    await expect(limit("c", () => Promise.resolve("ok"))).resolves.toBe("ok");
  });
});

describe("isQualityDowngrade (no silent 360p for HD requests)", () => {
  it("rejects 360p/480p files for 720p and 1080p requests", () => {
    expect(isQualityDowngrade(1080, 360)).toBe(true);
    expect(isQualityDowngrade(1080, 480)).toBe(true);
    expect(isQualityDowngrade(720, 360)).toBe(true);
    expect(isQualityDowngrade(720, 480)).toBe(true);
  });
  it("accepts usable HD sources while rejecting bot-limited SD fallbacks", () => {
    expect(isQualityDowngrade(1080, 1080)).toBe(false);
    expect(isQualityDowngrade(720, 720)).toBe(false);
    expect(isQualityDowngrade(1080, 720)).toBe(false); // 720p remains usable HD
    expect(isQualityDowngrade(1080, 480)).toBe(true);
    expect(isQualityDowngrade(1080, 648)).toBe(false); // 10% tolerance boundary
    expect(isQualityDowngrade(720, 648)).toBe(false);  // 10% tolerance boundary
  });
  it("never flags a failed probe (null) as a downgrade", () => {
    expect(isQualityDowngrade(1080, null)).toBe(false);
    expect(isQualityDowngrade(720, null)).toBe(false);
  });
});

let urlCounter = 0;
/** Unique URL per test so the result cache / in-flight dedupe never interferes. */
function freshUrl(): string {
  return `https://www.youtube.com/watch?v=test${String(urlCounter++).padStart(7, "0")}`;
}

beforeEach(async () => {
  h.opts.duration = 600;
  h.opts.failProbe = false;
  h.opts.failSections = false;
  h.opts.failFfmpeg = false;
  h.execFileCalls.length = 0;
  h.execCalls.length = 0;
  storedFiles.length = 0;

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

// ── 1. Fast path ──────────────────────────────────────────────────────────────

describe("POST /video/clip — fast path (section downloads)", () => {
  it("downloads only sections, never the full video, and indexes clips", async () => {
    const before = scratchDirs();
    const { status, body } = await post("/video/clip", { url: freshUrl(), clipCount: 3, clipDuration: 20 });

    expect(status).toBe(200);
    const clips = body.clips as Array<Record<string, unknown>>;
    expect(clips).toHaveLength(3);

    // One section download per clip; zero full downloads
    expect(sectionDownloadCalls()).toHaveLength(3);
    expect(fullDownloadCalls()).toHaveLength(0);
    // ffprobe (full-download duration probe) never ran
    expect(h.execCalls.filter((c) => c.includes("-show_format"))).toHaveLength(0);

    // Clips were persisted via storeFile and indexed correctly
    expect(storedFiles.filter((f) => f.mimeType === "video/mp4")).toHaveLength(3);
    clips.forEach((c, i) => {
      // storeFile call order is nondeterministic (async fs between clips) —
      // each clip just needs SOME stored id; index-order is guaranteed by Promise.all.
      expect(c.id).toMatch(/^stored-\d+$/);
      expect(c.name).toBe(`clip_${i + 1}.mp4`);
      expect(c.label).toBe(`Clip ${i + 1}`);
      expect(typeof c.startTime).toBe("string");
      expect(typeof c.duration).toBe("string");
      expect(c.size as number).toBeGreaterThan(0);
    });
    expect(body.totalDuration).toBe("10:00"); // 600 s

    // Scratch dir cleaned up on success
    expect(newScratchDirs(before)).toEqual([]);
  });

  it("uses audio-only probes for highlight scoring when no transcript exists", async () => {
    await post("/video/clip", { url: freshUrl(), clipCount: 2, clipDuration: 30 });
    // No transcript in the mock → audio-energy probing kicks in
    expect(audioProbeCalls().length).toBeGreaterThanOrEqual(2);
    // Probes are short audio sections, never full downloads
    for (const call of audioProbeCalls()) {
      const spec = call.args[call.args.indexOf("--download-sections") + 1];
      const m = spec.match(/^\*(\d+)-(\d+)$/)!;
      expect(Number(m[2]) - Number(m[1])).toBeLessThanOrEqual(22);
    }
    expect(fullDownloadCalls()).toHaveLength(0);
  });

  it("section downloads request the picked timestamp ranges", async () => {
    await post("/video/clip", { url: freshUrl(), clipCount: 2, clipDuration: 30 });
    for (const call of sectionDownloadCalls()) {
      const spec = call.args[call.args.indexOf("--download-sections") + 1];
      const m = spec.match(/^\*(\d+)-(\d+)$/);
      expect(m).not.toBeNull();
      const [start, end] = [Number(m![1]), Number(m![2])];
      expect(start).toBeGreaterThanOrEqual(0);
      expect(end).toBeLessThanOrEqual(600 + 1);
      expect(end - start).toBeGreaterThanOrEqual(30);
    }
  });
});

// ── 2. Fallback paths ─────────────────────────────────────────────────────────

describe("POST /video/clip — full-download fallback", () => {
  it("falls back to full download when the metadata probe fails", async () => {
    h.opts.failProbe = true;
    const before = scratchDirs();

    const { status, body } = await post("/video/clip", { url: freshUrl(), clipCount: 2, clipDuration: 20 });

    expect(status).toBe(200);
    expect((body.clips as unknown[]).length).toBe(2);
    // No sections were attempted; exactly one full download ran
    expect(sectionDownloadCalls()).toHaveLength(0);
    expect(fullDownloadCalls().length).toBeGreaterThanOrEqual(1);
    // Duration was recomputed via ffprobe on the downloaded file
    // ffprobe now runs via execFile (args array), not shell exec
    expect(h.execFileCalls.filter((c) => c.args.includes("-show_format"))).toHaveLength(1);
    expect(body.totalDuration).toBe("10:00");
    expect(newScratchDirs(before)).toEqual([]);
  });

  it("falls back to full download when section downloads fail, recomputing timestamps", async () => {
    h.opts.failSections = true;
    const before = scratchDirs();

    const { status, body } = await post("/video/clip", { url: freshUrl(), clipCount: 2, clipDuration: 20 });

    expect(status).toBe(200);
    expect((body.clips as unknown[]).length).toBe(2);
    // Sections were attempted first, then the full download path ran
    expect(sectionDownloadCalls().length).toBeGreaterThanOrEqual(1);
    expect(fullDownloadCalls().length).toBeGreaterThanOrEqual(1);
    // ffprobe re-derived the duration for the recomputed timestamps
    // ffprobe now runs via execFile (args array), not shell exec
    expect(h.execFileCalls.filter((c) => c.args.includes("-show_format"))).toHaveLength(1);
    expect(newScratchDirs(before)).toEqual([]);
  });
});

// ── 3. Temp cleanup on success and failure ───────────────────────────────────

describe("temp dir cleanup", () => {
  it("/video/clip cleans its scratch dir on ffmpeg failure", async () => {
    h.opts.failFfmpeg = true;
    const before = scratchDirs();

    const { status, body } = await post("/video/clip", { url: freshUrl(), clipCount: 2 });

    expect(status).toBe(500);
    expect(String(body.error)).toMatch(/ffmpeg exploded/);
    expect(newScratchDirs(before)).toEqual([]);
  });

  it("/video/trim cleans up on success and failure", async () => {
    const before = scratchDirs();
    const ok = await post("/video/trim", { url: freshUrl(), startTime: "0", endTime: "10" });
    expect(ok.status).toBe(200);
    expect(ok.body.id).toMatch(/^stored-/);
    expect(newScratchDirs(before)).toEqual([]);

    h.opts.failFfmpeg = true;
    const fail = await post("/video/trim", { url: freshUrl(), startTime: "0", endTime: "10" });
    expect(fail.status).toBe(500);
    expect(newScratchDirs(before)).toEqual([]);
  });

  it("/video/crop-vertical cleans up on success and failure", async () => {
    const before = scratchDirs();
    const ok = await post("/video/crop-vertical", { url: freshUrl() });
    expect(ok.status).toBe(200);
    expect(ok.body.name).toBe("vertical_9x16.mp4");
    expect(newScratchDirs(before)).toEqual([]);

    h.opts.failFfmpeg = true;
    const fail = await post("/video/crop-vertical", { url: freshUrl() });
    expect(fail.status).toBe(500);
    expect(newScratchDirs(before)).toEqual([]);
  });

  it("/video/extract-audio cleans up on success and failure", async () => {
    const before = scratchDirs();
    const ok = await post("/video/extract-audio", { url: freshUrl() });
    expect(ok.status).toBe(200);
    expect(ok.body.name).toBe("audio.mp3");
    expect(newScratchDirs(before)).toEqual([]);

    h.opts.failFfmpeg = true;
    const fail = await post("/video/extract-audio", { url: freshUrl() });
    expect(fail.status).toBe(500);
    expect(newScratchDirs(before)).toEqual([]);
  });
});

// ── 4. Disk guard ─────────────────────────────────────────────────────────────

describe("POST /video/clip — disk guard", () => {
  const LOW = { bavail: 10, bsize: 4096 } as unknown as fs.StatsFs;      // ~40 KB free
  const HIGH = { bavail: 10 * 1024 ** 2, bsize: 4096 } as unknown as fs.StatsFs; // ~40 GB free

  it("returns 503 before queueing when free space is below the floor", async () => {
    vi.spyOn(fs, "statfsSync").mockReturnValue(LOW);

    const { status, body } = await post("/video/clip", { url: freshUrl() });

    expect(status).toBe(503);
    expect(String(body.error)).toMatch(/storage is temporarily full/i);
    // The job never started — no yt-dlp calls at all
    expect(h.execFileCalls).toHaveLength(0);
  });

  it("fails cleanly when space vanishes after the queue wait", async () => {
    // First check (pre-queue) passes, re-check inside the job sees low space.
    vi.spyOn(fs, "statfsSync")
      .mockReturnValueOnce(HIGH)
      .mockReturnValue(LOW);

    const { status, body } = await post("/video/clip", { url: freshUrl() });

    expect(status).toBe(500);
    expect(String(body.error)).toMatch(/storage is temporarily full/i);
    // The pipeline never ran (no downloads attempted)
    expect(h.execFileCalls).toHaveLength(0);
  });

  it("proceeds normally when free space is plentiful", async () => {
    vi.spyOn(fs, "statfsSync").mockReturnValue(HIGH);
    const { status } = await post("/video/clip", { url: freshUrl(), clipCount: 1 });
    expect(status).toBe(200);
  });
});

// ── 5. pickSpreadTimestamps edge cases (pure logic) ───────────────────────────

import { pickSpreadTimestamps, introOutroMargin } from "../lib/highlightPicker";

describe("pickSpreadTimestamps — edge cases", () => {
  it("applies no intro/outro margin to videos of 240 s or less", () => {
    expect(introOutroMargin(240)).toBe(0);
    const out = pickSpreadTimestamps(240, 30, 3);
    expect(out).toHaveLength(3);
    for (const t of out) {
      expect(t).toBeGreaterThanOrEqual(0);
      expect(t).toBeLessThanOrEqual(240 - 30);
    }
  });

  it("caps the margin at 5 minutes for very long videos", () => {
    expect(introOutroMargin(10 * 3600)).toBe(300);
  });

  it("clamps the clip count when the video only fits fewer clips", () => {
    // 100 s video, 30 s clips → three butt-joined clips fit (0/30/60) even if 5 asked
    const out = pickSpreadTimestamps(100, 30, 5);
    expect(out).toHaveLength(3);
    const sorted = [...out].sort((a, b) => a - b);
    for (let i = 1; i < sorted.length; i++) {
      expect(sorted[i] - sorted[i - 1]).toBeGreaterThanOrEqual(30);
    }
    for (const t of sorted) expect(t + 30).toBeLessThanOrEqual(100);
  });

  it("returns [0] when the video is shorter than one clip", () => {
    expect(pickSpreadTimestamps(15, 30, 4)).toEqual([0]);
  });

  it("keeps picks non-overlapping and in ascending order", () => {
    for (let run = 0; run < 20; run++) {
      const out = pickSpreadTimestamps(3600, 30, 5);
      for (let i = 1; i < out.length; i++) {
        expect(out[i]).toBeGreaterThan(out[i - 1]);
      }
    }
  });
});

describe("composeYoutubeBlockedError — engine reason beats cookie advice", () => {
  const base = { lowqP: 360, maxHeight: 1080, hadCookies: false, botBlocked: false };

  it("leads with the engine's failure reason when one is on record", () => {
    const msg = composeYoutubeBlockedError({
      ...base,
      engine: { kind: "timeout", note: "the download engine was still converting it when we stopped waiting" },
    });
    expect(msg).toContain("360p");
    expect(msg).toContain("still converting");
    expect(msg).toMatch(/try again in a few minutes/i);
    expect(msg).not.toMatch(/cookies/i);
  });

  it("tells the admin exactly what to fix for quota / auth / missing key", () => {
    expect(
      composeYoutubeBlockedError({ ...base, engine: { kind: "quota", note: "the download engine hit its rate/quota limit" } }),
    ).toMatch(/quota/i);
    expect(
      composeYoutubeBlockedError({ ...base, engine: { kind: "auth", note: "the download engine rejected this server's API key" } }),
    ).toContain("ZYLA_API_KEY");
    expect(
      composeYoutubeBlockedError({
        ...base,
        engine: { kind: "not_configured", note: "the download engine is not set up on this server (ZYLA_API_KEY missing)" },
      }),
    ).toContain("ZYLA_API_KEY");
  });

  it("falls back to the cookie guidance only when the engine did not fail", () => {
    const msg = composeYoutubeBlockedError({ ...base, engine: null });
    expect(msg).toContain("YouTube Cookies panel");
    const bot = composeYoutubeBlockedError({ lowqP: null, maxHeight: 720, hadCookies: true, botBlocked: true, engine: null });
    expect(bot).toMatch(/cookies appear to have expired/i);
  });

  it("bot-block + engine reason merges both facts", () => {
    const msg = composeYoutubeBlockedError({
      lowqP: null, maxHeight: 1080, hadCookies: false, botBlocked: true,
      engine: { kind: "engine_failed", note: "the download engine reported an error for this video" },
    });
    expect(msg).toContain("confirm you are not a bot");
    expect(msg).toContain("download engine");
  });
});
