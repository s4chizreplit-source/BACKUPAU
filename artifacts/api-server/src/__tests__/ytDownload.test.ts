/**
 * Tests for the ZylaLabs downloader engine routes (/api/yt/*).
 *
 * Zyla's HTTP API is mocked via a global fetch stub. Covers:
 *   1. URL/format validation (YouTube-only, whitelist formats)
 *   2. start → progress → done happy path (progress 0..1000 → 0..100%)
 *   3. Cache: repeat start for the same url+format must NOT call Zyla again
 *   4. Failure text (/error|fail/i) → failed + fallback URL (video only)
 *   5. Job timeout after 240s → failed
 *   6. Missing ZYLA_API_KEY → 503, and the key never leaks into responses
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import express, { type Express } from "express";
import supertest from "supertest";

// The durable mirror cache hits the real dev DB — mock it out so unit runs
// never write fixture rows into `zyla_cache` (and never depend on a DB).
vi.mock("../lib/zylaCache", () => ({
  getCachedMirror: vi.fn(async () => null),
  putCachedMirror: vi.fn(async () => {}),
  deleteCachedMirror: vi.fn(async () => {}),
}));

const TEST_KEY = "zyla-test-key-123";

type FetchMock = ReturnType<typeof vi.fn>;

function jsonResponse(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

async function makeApp(): Promise<{ app: Express; fetchMock: FetchMock }> {
  vi.resetModules();
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  const { default: router } = await import("../routes/ytDownload");
  const app = express();
  app.use(express.json());
  app.use("/api", router);
  return { app, fetchMock };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-07-31T10:00:00Z"));
  process.env["ZYLA_API_KEY"] = TEST_KEY;
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env["ZYLA_API_KEY"];
});

describe("validation", () => {
  it("rejects non-YouTube URLs and bad formats", async () => {
    const { app, fetchMock } = await makeApp();
    const r1 = await supertest(app).post("/api/yt/start").send({ url: "https://vimeo.com/12345", format: "1080" });
    expect(r1.status).toBe(400);
    expect(r1.body.code).toBe("UNSUPPORTED_URL");

    const r2 = await supertest(app).post("/api/yt/start").send({ url: "https://youtu.be/LXb3EKWsInQ", format: "8k" });
    expect(r2.status).toBe(400);
    expect(r2.body.code).toBe("BAD_FORMAT");

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("accepts watch/shorts/youtu.be/bare-id forms", async () => {
    const { default: mod } = await import("../routes/ytDownload");
    void mod;
    const { parseYouTubeId } = await import("../routes/ytDownload");
    expect(parseYouTubeId("LXb3EKWsInQ")).toBe("LXb3EKWsInQ");
    expect(parseYouTubeId("https://www.youtube.com/watch?v=LXb3EKWsInQ&t=5s")).toBe("LXb3EKWsInQ");
    expect(parseYouTubeId("https://youtu.be/LXb3EKWsInQ?si=abc")).toBe("LXb3EKWsInQ");
    expect(parseYouTubeId("https://youtube.com/shorts/LXb3EKWsInQ")).toBe("LXb3EKWsInQ");
    expect(parseYouTubeId("https://m.youtube.com/watch?v=LXb3EKWsInQ")).toBe("LXb3EKWsInQ");
    expect(parseYouTubeId("https://evil.com/watch?v=LXb3EKWsInQ")).toBeNull();
    expect(parseYouTubeId("not a url")).toBeNull();
  });
});

describe("start → progress → done, with cache", () => {
  it("runs the happy path and serves repeats from cache without a second Zyla start", async () => {
    const { app, fetchMock } = await makeApp();

    // 1) start
    fetchMock.mockResolvedValueOnce(jsonResponse(200, {
      success: true, id: "z1", image: "x", progress_url: "https://zylalabs.com/progress/z1",
    }));
    const start = await supertest(app).post("/api/yt/start").send({ url: "https://youtu.be/LXb3EKWsInQ", format: "2160" });
    expect(start.status).toBe(200);
    expect(start.body.done).toBe(false);
    const jobId = start.body.jobId as string;

    // Auth header went to Zyla — and only to Zyla
    const [startUrl, startInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(startUrl).toContain("zylalabs.com");
    expect(startUrl).toContain("format=2160");
    expect((startInit.headers as Record<string, string>).authorization).toBe(`Bearer ${TEST_KEY}`);

    // 2) mid progress: 0..1000 scale → percent
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { success: 1, progress: 430, text: "Downloading video" }));
    const mid = await supertest(app).get(`/api/yt/progress?jobId=${jobId}`);
    expect(mid.body.progress).toBe(43);
    expect(mid.body.done).toBe(false);

    // 3) done: download_url appears
    fetchMock.mockResolvedValueOnce(jsonResponse(200, {
      success: 1, progress: 1000, text: "Finished", download_url: "https://r2.example/file.mp4", title: "Costa Rica 4K",
    }));
    const done = await supertest(app).get(`/api/yt/progress?jobId=${jobId}`);
    expect(done.body.done).toBe(true);
    expect(done.body.progress).toBe(100);
    expect(done.body.downloadUrl).toBe("https://r2.example/file.mp4");
    expect(done.body.title).toBe("Costa Rica 4K");

    // 4) repeat start (same url+format) → cache, NO new Zyla call
    const callsBefore = fetchMock.mock.calls.length;
    const again = await supertest(app).post("/api/yt/start").send({ url: "https://www.youtube.com/watch?v=LXb3EKWsInQ", format: "2160" });
    expect(again.status).toBe(200);
    expect(again.body.done).toBe(true);
    expect(again.body.cached).toBe(true);
    expect(again.body.downloadUrl).toBe("https://r2.example/file.mp4");
    expect(fetchMock.mock.calls.length).toBe(callsBefore);

    // 5) /yt/download with cached entry → 302 straight to the file
    const dl = await supertest(app).get("/api/yt/download?url=LXb3EKWsInQ&format=2160");
    expect(dl.status).toBe(302);
    expect(dl.headers.location).toBe("https://r2.example/file.mp4");
    expect(fetchMock.mock.calls.length).toBe(callsBefore);

    // The key never appears in anything we sent to the client
    for (const body of [start.body, mid.body, done.body, again.body]) {
      expect(JSON.stringify(body)).not.toContain(TEST_KEY);
    }
  });

  it("cache expires after 6 days", async () => {
    const { app, fetchMock } = await makeApp();
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { success: true, id: "z1", progress_url: "https://zylalabs.com/p/1" }));
    const start = await supertest(app).post("/api/yt/start").send({ url: "LXb3EKWsInQ", format: "720" });
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { success: 1, progress: 1000, download_url: "https://r2.example/a.mp4" }));
    await supertest(app).get(`/api/yt/progress?jobId=${start.body.jobId}`);

    vi.setSystemTime(new Date("2026-08-07T10:00:01Z")); // > 6 days later
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { success: true, id: "z2", progress_url: "https://zylalabs.com/p/2" }));
    const again = await supertest(app).post("/api/yt/start").send({ url: "LXb3EKWsInQ", format: "720" });
    expect(again.body.done).toBe(false); // fresh job, not cache
  });
});

describe("failures", () => {
  it("marks the job failed on /error|fail/i text and offers the backup server for video", async () => {
    const { app, fetchMock } = await makeApp();
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { success: true, id: "z1", progress_url: "https://zylalabs.com/p/1" }));
    const start = await supertest(app).post("/api/yt/start").send({ url: "LXb3EKWsInQ", format: "1080" });

    fetchMock.mockResolvedValueOnce(jsonResponse(200, { success: 1, progress: 200, text: "Conversion FAILED" }));
    const prog = await supertest(app).get(`/api/yt/progress?jobId=${start.body.jobId}`);
    expect(prog.body.failed).toBe(true);
    expect(prog.body.fallbackUrl).toContain("yt-downloader-rose-six.vercel.app");
    expect(prog.body.fallbackUrl).toContain("quality=1080");
  });

  it("mp3 failures get no fallback URL (backup server is video-only)", async () => {
    const { app, fetchMock } = await makeApp();
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { success: true, id: "z1", progress_url: "https://zylalabs.com/p/1" }));
    const start = await supertest(app).post("/api/yt/start").send({ url: "LXb3EKWsInQ", format: "mp3" });
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { success: 1, progress: 10, text: "error: unavailable" }));
    const prog = await supertest(app).get(`/api/yt/progress?jobId=${start.body.jobId}`);
    expect(prog.body.failed).toBe(true);
    expect(prog.body.fallbackUrl).toBeUndefined();
  });

  it("times out a job after 240s", async () => {
    const { app, fetchMock } = await makeApp();
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { success: true, id: "z1", progress_url: "https://zylalabs.com/p/1" }));
    const start = await supertest(app).post("/api/yt/start").send({ url: "LXb3EKWsInQ", format: "480" });

    vi.setSystemTime(new Date("2026-07-31T10:04:01Z")); // 241s later
    const prog = await supertest(app).get(`/api/yt/progress?jobId=${start.body.jobId}`);
    expect(prog.body.failed).toBe(true);
    expect(prog.body.error).toMatch(/timed out/i);
  });

  it("returns 503 NOT_CONFIGURED when the key is missing", async () => {
    delete process.env["ZYLA_API_KEY"];
    const { app, fetchMock } = await makeApp();
    const r = await supertest(app).post("/api/yt/start").send({ url: "LXb3EKWsInQ", format: "1080" });
    expect(r.status).toBe(503);
    expect(r.body.code).toBe("NOT_CONFIGURED");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("surfaces credential problems as a clear engine error", async () => {
    const { app, fetchMock } = await makeApp();
    fetchMock.mockResolvedValueOnce(jsonResponse(401, { success: false, message: "Invalid API key" }));
    const r = await supertest(app).post("/api/yt/start").send({ url: "LXb3EKWsInQ", format: "1080" });
    expect(r.status).toBe(502);
    expect(r.body.error).toMatch(/credentials|subscription/i);
  });
});

describe("security & dedupe", () => {
  it("accepts a progress_url on third-party infra (Zyla really uses *.up.railway.app)", async () => {
    // Regression guard: pinning progress_url to zylalabs.com broke every real
    // start — Zyla's live responses point at Railway-hosted progress servers.
    const { app, fetchMock } = await makeApp();
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { success: true, id: "z1", progress_url: "https://youtube-api-progress-copy-development.up.railway.app/progress/abc" }));
    const r = await supertest(app).post("/api/yt/start").send({ url: "LXb3EKWsInQ", format: "720" });
    expect(r.status).toBe(200);
    expect(r.body.jobId).toBeTruthy();
  });

  it("rejects http:// and private-network progress_url", async () => {
    const { app, fetchMock } = await makeApp();
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { success: true, id: "z1", progress_url: "http://zylalabs.com/p/1" }));
    const r1 = await supertest(app).post("/api/yt/start").send({ url: "LXb3EKWsInQ", format: "720" });
    expect(r1.status).toBe(502);

    fetchMock.mockResolvedValueOnce(jsonResponse(200, { success: true, id: "z2", progress_url: "https://169.254.169.254/p/1" }));
    const r2 = await supertest(app).post("/api/yt/start").send({ url: "LXb3EKWsInQ", format: "480" });
    expect(r2.status).toBe(502);
  });

  it("fails the job instead of caching an unsafe download_url", async () => {
    const { app, fetchMock } = await makeApp();
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { success: true, id: "z1", progress_url: "https://zylalabs.com/p/1" }));
    const start = await supertest(app).post("/api/yt/start").send({ url: "LXb3EKWsInQ", format: "720" });

    fetchMock.mockResolvedValueOnce(jsonResponse(200, { success: 1, progress: 1000, download_url: "https://192.168.1.10/file.mp4" }));
    const prog = await supertest(app).get(`/api/yt/progress?jobId=${start.body.jobId}`);
    expect(prog.body.failed).toBe(true);
    expect(prog.body.downloadUrl).toBeUndefined();

    // Nothing was cached — a repeat start opens a fresh job instead of serving the bad link
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { success: true, id: "z2", progress_url: "https://zylalabs.com/p/2" }));
    const again = await supertest(app).post("/api/yt/start").send({ url: "LXb3EKWsInQ", format: "720" });
    expect(again.body.cached).toBeUndefined();
    expect(again.body.done).toBe(false);
  });

  it("dedupes concurrent starts for the same video+format into one paid Zyla job", async () => {
    vi.useRealTimers(); // this test relies on real async interleaving
    const { app, fetchMock } = await makeApp();
    let release!: (v: unknown) => void;
    const gate = new Promise(r => { release = r; });
    fetchMock.mockImplementationOnce(async () => {
      await gate;
      return jsonResponse(200, { success: true, id: "z1", progress_url: "https://zylalabs.com/p/1" });
    });

    const p1 = supertest(app).post("/api/yt/start").send({ url: "LXb3EKWsInQ", format: "1080" });
    const p2 = supertest(app).post("/api/yt/start").send({ url: "https://youtu.be/LXb3EKWsInQ", format: "1080" });
    await new Promise(r => setTimeout(r, 25)); // let both requests reach the gate
    release(null);
    const [r1, r2] = await Promise.all([p1, p2]);

    expect(r1.body.jobId).toBeTruthy();
    expect(r1.body.jobId).toBe(r2.body.jobId);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("resolveZylaSource (clip-pipeline resolver)", () => {
  async function makeModule() {
    vi.resetModules();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const mod = await import("../routes/ytDownload");
    return { mod, fetchMock };
  }

  it("resolves a YouTube URL to the direct link, mapping height→format", async () => {
    const { mod, fetchMock } = await makeModule();
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { success: true, id: "z1", progress_url: "https://zylalabs.com/p/1" }));
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { success: 1, progress: 1000, download_url: "https://r2.zylalabs.com/f.mp4", title: "T" }));
    const p = mod.resolveZylaSource("https://www.youtube.com/watch?v=LXb3EKWsInQ", 720);
    await vi.advanceTimersByTimeAsync(10_000);
    const r = await p;
    expect(r?.url).toBe("https://r2.zylalabs.com/f.mp4");
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("format=720");
  });

  it("serves repeats from cache without a second paid start", async () => {
    const { mod, fetchMock } = await makeModule();
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { success: true, id: "z1", progress_url: "https://zylalabs.com/p/1" }));
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { success: 1, progress: 1000, download_url: "https://r2.zylalabs.com/f.mp4" }));
    const p = mod.resolveZylaSource("LXb3EKWsInQ", 1080);
    await vi.advanceTimersByTimeAsync(10_000);
    await p;
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("format=1080");

    const again = await mod.resolveZylaSource("https://youtu.be/LXb3EKWsInQ", 1080);
    expect(again?.url).toBe("https://r2.zylalabs.com/f.mp4");
    expect(fetchMock).toHaveBeenCalledTimes(2); // start + one poll — repeat cost nothing
  });

  it("returns null (never throws) for non-YouTube, missing key, and engine failure", async () => {
    const { mod, fetchMock } = await makeModule();
    expect(await mod.resolveZylaSource("https://vimeo.com/1", 720)).toBeNull();

    delete process.env["ZYLA_API_KEY"];
    expect(await mod.resolveZylaSource("LXb3EKWsInQ", 720)).toBeNull();
    process.env["ZYLA_API_KEY"] = TEST_KEY;
    expect(fetchMock).not.toHaveBeenCalled();

    fetchMock.mockResolvedValueOnce(jsonResponse(429, { success: false }));
    expect(await mod.resolveZylaSource("LXb3EKWsInQ", 720)).toBeNull();
  });

  it("records WHY the engine failed so the clip error can say it", async () => {
    const { mod, fetchMock } = await makeModule();

    // Quota (429 on start)
    fetchMock.mockResolvedValueOnce(jsonResponse(429, { success: false }));
    expect(await mod.resolveZylaSource("LXb3EKWsInQ", 1080)).toBeNull();
    expect(mod.getRecentZylaFailureNote("https://youtu.be/LXb3EKWsInQ")?.kind).toBe("quota");

    // Engine-side failure text
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { success: true, id: "z1", progress_url: "https://zylalabs.com/p/1" }));
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { success: 1, progress: 100, text: "Conversion FAILED" }));
    expect(await mod.resolveZylaSource("dQw4w9WgXcQ", 720)).toBeNull();
    expect(mod.getRecentZylaFailureNote("dQw4w9WgXcQ")?.kind).toBe("engine_failed");

    // Key missing
    delete process.env["ZYLA_API_KEY"];
    expect(await mod.resolveZylaSource("aqz-KE-bpKQ", 480)).toBeNull();
    expect(mod.getRecentZylaFailureNote("aqz-KE-bpKQ")?.kind).toBe("not_configured");
    process.env["ZYLA_API_KEY"] = TEST_KEY;

    // Non-YouTube URLs never get a note
    expect(mod.getRecentZylaFailureNote("https://vimeo.com/1")).toBeNull();
  });

  it("timeout: finish-watcher rides the paid start to completion; retry is instant and free", async () => {
    const { mod, fetchMock } = await makeModule();
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { success: true, id: "z1", progress_url: "https://zylalabs.com/p/1" }));
    // Engine keeps converting — no download_url within the caller's budget.
    fetchMock.mockResolvedValue(jsonResponse(200, { success: 1, progress: 500, text: "Converting" }));

    const p = mod.resolveZylaSource("LXb3EKWsInQ", 1080, undefined, { timeoutMs: 10_000 });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await p).toBeNull();
    expect(mod.getRecentZylaFailureNote("LXb3EKWsInQ")?.kind).toBe("timeout");
    const paidStarts = () =>
      fetchMock.mock.calls.filter((c) => String(c[0]).includes("zylalabs.com/api")).length;
    expect(paidStarts()).toBe(1);

    // The engine finishes AFTER everyone gave up — the watcher must catch it.
    fetchMock.mockResolvedValue(jsonResponse(200, {
      success: 1, progress: 1000, download_url: "https://r2.zylalabs.com/late.mp4", title: "Late",
    }));
    await vi.advanceTimersByTimeAsync(6_000); // one watcher tick (5s)

    // Retry: served from cache — no second paid start, failure note cleared.
    const again = await mod.resolveZylaSource("https://youtu.be/LXb3EKWsInQ", 1080);
    expect(again?.url).toBe("https://r2.zylalabs.com/late.mp4");
    expect(paidStarts()).toBe(1);
    expect(mod.getRecentZylaFailureNote("LXb3EKWsInQ")).toBeNull();
  });

  it("a 240s public poller timing out the shared job must not kill a longer-budget clip resolve", async () => {
    const { mod, fetchMock } = await makeModule();
    const app = express();
    app.use(express.json());
    app.use("/api", mod.default);
    const paidStarts = () =>
      fetchMock.mock.calls.filter((c) => String(c[0]).includes("zylalabs.com/api")).length;

    fetchMock.mockResolvedValueOnce(jsonResponse(200, { success: true, id: "z1", progress_url: "https://zylalabs.com/p/1" }));
    fetchMock.mockResolvedValue(jsonResponse(200, { success: 1, progress: 400, text: "Converting" }));

    const p = mod.resolveZylaSource("LXb3EKWsInQ", 1080, undefined, { timeoutMs: 600_000 });
    await vi.advanceTimersByTimeAsync(0); // flush start + immediate poll

    // Public downloader joins the SAME conversion (no second paid start)…
    const start = await supertest(app).post("/api/yt/start").send({ url: "LXb3EKWsInQ", format: "1080" });
    expect(start.body.jobId).toBeTruthy();
    expect(paidStarts()).toBe(1);

    // …and at 240s ITS poll timeout-fails the shared job.
    await vi.advanceTimersByTimeAsync(245_000);
    const prog = await supertest(app).get(`/api/yt/progress?jobId=${start.body.jobId}`);
    expect(prog.body.failed).toBe(true);

    // The clip resolver (600s budget) must shrug that off and finish.
    fetchMock.mockResolvedValue(jsonResponse(200, {
      success: 1, progress: 1000, download_url: "https://r2.zylalabs.com/hd.mp4",
    }));
    await vi.advanceTimersByTimeAsync(10_000);
    const r = await p;
    expect(r?.url).toBe("https://r2.zylalabs.com/hd.mp4");
    expect(paidStarts()).toBe(1);
  });

  it("a clip resolve joins a paste warm-up and receives the mirror when it finishes", async () => {
    const { mod, fetchMock } = await makeModule();
    const paidStarts = () =>
      fetchMock.mock.calls.filter((c) => String(c[0]).includes("zylalabs.com/api")).length;

    // The first caller models POST /video/warm. Its initial poll sees a still
    // converting job, then the clip request arrives before it completes.
    fetchMock.mockResolvedValueOnce(jsonResponse(200, {
      success: true, id: "warm-1", progress_url: "https://zylalabs.com/p/warm-1",
    }));
    fetchMock.mockResolvedValue(jsonResponse(200, { success: 1, progress: 420, text: "Converting" }));
    const warm = mod.resolveZylaSource("LXb3EKWsInQ", 1080, undefined, { timeoutMs: 600_000 });
    await vi.advanceTimersByTimeAsync(0);

    const clip = mod.resolveZylaSource("https://youtu.be/LXb3EKWsInQ", 1080, undefined, { timeoutMs: 90_000 });
    await vi.advanceTimersByTimeAsync(0);
    expect(paidStarts()).toBe(1);

    fetchMock.mockResolvedValue(jsonResponse(200, {
      success: 1, progress: 1000, download_url: "https://r2.zylalabs.com/warmed.mp4",
    }));
    await vi.advanceTimersByTimeAsync(6_000);

    await expect(clip).resolves.toMatchObject({ url: "https://r2.zylalabs.com/warmed.mp4" });
    await expect(warm).resolves.toMatchObject({ url: "https://r2.zylalabs.com/warmed.mp4" });
    expect(paidStarts()).toBe(1);
  });

  it("an expired watcher must not delete a REPLACEMENT start's inflight entry (no triple-paid start)", async () => {
    const { mod, fetchMock } = await makeModule();
    const paidStarts = () =>
      fetchMock.mock.calls.filter((c) => String(c[0]).includes("zylalabs.com/api")).length;

    // Job 1: starts, times out at the caller's 10s budget → watcher keeps polling.
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { success: true, id: "z1", progress_url: "https://zylalabs.com/p/1" }));
    fetchMock.mockResolvedValue(jsonResponse(200, { success: 1, progress: 300, text: "Converting" }));
    const p1 = mod.resolveZylaSource("LXb3EKWsInQ", 1080, undefined, { timeoutMs: 10_000 });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await p1).toBeNull();
    expect(paidStarts()).toBe(1);

    // Cross the 20-min watch cap: the stale job may now be replaced by a
    // fresh paid start (bounded, intended)…
    await vi.advanceTimersByTimeAsync(1_186_000); // → t ≈ 1201s > 20min cap
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { success: true, id: "z2", progress_url: "https://zylalabs.com/p/2" }));
    const p2 = mod.resolveZylaSource("LXb3EKWsInQ", 1080, undefined, { timeoutMs: 240_000 });
    await vi.advanceTimersByTimeAsync(0);
    expect(paidStarts()).toBe(2);

    // …and when the OLD watcher hits its cap right after, it must NOT wipe
    // the replacement's inflight entry.
    await vi.advanceTimersByTimeAsync(2_000); // old watcher wakes at ~1202.5s, exits at cap
    const p3 = mod.resolveZylaSource("https://youtu.be/LXb3EKWsInQ", 1080, undefined, { timeoutMs: 240_000 });
    await vi.advanceTimersByTimeAsync(0);
    expect(paidStarts()).toBe(2); // p3 JOINED job 2 — a third paid start means the entry was clobbered

    fetchMock.mockResolvedValue(jsonResponse(200, {
      success: 1, progress: 1000, download_url: "https://r2.zylalabs.com/v2.mp4",
    }));
    await vi.advanceTimersByTimeAsync(6_000);
    expect((await p2)?.url).toBe("https://r2.zylalabs.com/v2.mp4");
    expect((await p3)?.url).toBe("https://r2.zylalabs.com/v2.mp4");
    expect(paidStarts()).toBe(2);
  });

  it("1080 engine failure retries one rung down at 720 and aliases the cache", async () => {
    const { mod, fetchMock } = await makeModule();
    const paidStarts = () =>
      fetchMock.mock.calls.filter((c) => String(c[0]).includes("zylalabs.com/api")).length;

    // 1080 start → engine says download_error (live-observed shape)
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { success: true, id: "a", progress_url: "https://zylalabs.com/p/a" }));
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { success: 0, progress: 1000, text: "download_error" }));
    // 720 retry → finishes immediately
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { success: true, id: "b", progress_url: "https://zylalabs.com/p/b" }));
    fetchMock.mockResolvedValueOnce(jsonResponse(200, {
      success: 1, progress: 1000, download_url: "https://r2.zylalabs.com/sd.mp4", title: "T",
    }));

    const r = await mod.resolveZylaSource("LXb3EKWsInQ", 1080);
    expect(r?.url).toBe("https://r2.zylalabs.com/sd.mp4");
    expect(paidStarts()).toBe(2);

    // Next 1080 request hits the aliased cache — no third paid start.
    const r2 = await mod.resolveZylaSource("https://youtu.be/LXb3EKWsInQ", 1080);
    expect(r2?.url).toBe("https://r2.zylalabs.com/sd.mp4");
    expect(paidStarts()).toBe(2);
  });

  it("never ladders down on quota or timeout failures", async () => {
    const { mod, fetchMock } = await makeModule();
    const paidStarts = () =>
      fetchMock.mock.calls.filter((c) => String(c[0]).includes("zylalabs.com/api")).length;

    // Quota failure at start: no 720 attempt.
    fetchMock.mockResolvedValueOnce(jsonResponse(429, { success: false }));
    expect(await mod.resolveZylaSource("dQw4w9WgXcQ", 1080)).toBeNull();
    expect(paidStarts()).toBe(1);

    // Timeout: the finish-watcher owns the salvage — no parallel 720 spend.
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { success: true, id: "c", progress_url: "https://zylalabs.com/p/c" }));
    fetchMock.mockResolvedValue(jsonResponse(200, { success: 1, progress: 100, text: "Converting" }));
    const p = mod.resolveZylaSource("aqz-KE-bpKQ", 1080, undefined, { timeoutMs: 8_000 });
    await vi.advanceTimersByTimeAsync(12_000);
    expect(await p).toBeNull();
    expect(paidStarts()).toBe(2);
  });
});
