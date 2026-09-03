import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import supertest from "supertest";
import { PassThrough } from "node:stream";

process.env.ZYLA_TIKTOK_API_KEY = "tiktok-test-key";
process.env.SESSION_SECRET ||= "test-session-secret";

const {
  __clearTikTokCacheForTests,
  harvestTikTokVideos,
  listTikTokProfileVideos,
  parseTikTokUsername,
  resolveTikTokProfile,
  ttFreshVideoUrl,
  pipeTikTokBody,
} = await import("../routes/tiktok");
const { createTikTokRelayToken, verifyTikTokRelayToken } = await import("../lib/tiktokRelayToken");

const response = (status: number, body: unknown) => ({
  status,
  ok: status >= 200 && status < 300,
  text: async () => JSON.stringify(body),
});

beforeEach(() => {
  __clearTikTokCacheForTests();
  process.env.ZYLA_TIKTOK_API_KEY = "tiktok-test-key";
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("TikTok profile source", () => {
  it("parses handles and profile URLs, but rejects video/non-TikTok links", () => {
    expect(parseTikTokUsername("@Creator.Name")).toBe("creator.name");
    expect(parseTikTokUsername("https://www.tiktok.com/@Creator.Name?lang=en")).toBe("creator.name");
    expect(parseTikTokUsername("https://www.tiktok.com/@creator/video/123")).toBeNull();
    expect(parseTikTokUsername("https://example.com/@creator")).toBeNull();
    expect(parseTikTokUsername("bad name")).toBeNull();
  });

  it("normalizes video arrays and filters photo posts", () => {
    const videos = harvestTikTokVideos({
      data: {
        items: [
          { id: "300", type: "VIDEO", desc: "New clip", hdPlayUrlList: ["https://v16.tiktokcdn.com/300.mp4"] },
          { id: "200", type: "PHOTO", desc: "Photo", playUrlList: ["https://v16.tiktokcdn.com/200.mp4"] },
          { videoId: "100", mediaType: "VIDEO", video: { playUrlList: ["https://v19.tiktokcdn.com/100.mp4"] } },
        ],
      },
    });
    expect(videos.map((video) => video.id)).toEqual(["300", "100"]);
    expect(videos[1]?.downloadUrl).toContain("/100.mp4");
  });

  it("resolves secUid, follows maxCursor history, and caches paid calls", async () => {
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = new URL(String(input));
      if (url.pathname.includes("/23413/")) {
        return response(200, { data: { user: { username: "creator", secUid: "SEC-123" } } });
      }
      if (url.pathname.includes("/23414/")) {
        expect(url.searchParams.get("secUid")).toBe("SEC-123");
        const cursor = url.searchParams.get("maxCursor");
        return cursor === "0"
          ? response(200, { data: { items: [{ id: "2", type: "VIDEO", playUrlList: ["https://v16.tiktokcdn.com/2.mp4"] }], hasMore: true, minCursor: 0, maxCursor: 50 } })
          : response(200, { data: { items: [{ id: "1", type: "VIDEO", playUrlList: ["https://v16.tiktokcdn.com/1.mp4"] }], hasMore: false, minCursor: 0, maxCursor: 100 } });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const first = await listTikTokProfileVideos("creator", { deep: true });
    expect(first.ok && first.videos.map((video) => video.id)).toEqual(["2", "1"]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const again = await listTikTokProfileVideos("creator", { deep: true });
    expect(again.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("refreshes one stable video id through the details endpoint", async () => {
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = new URL(String(input));
      expect(url.pathname).toContain("/23415/");
      expect(url.searchParams.get("idOrUrl")).toBe("99123");
      return response(200, {
        data: { id: "99123", type: "VIDEO", hdPlayUrlList: ["https://v16.tiktokcdn.com/fresh.mp4"] },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(ttFreshVideoUrl("creator", "99123")).resolves.toContain("fresh.mp4");
  });

  it("limits concurrent upstream calls during a burst of different profiles", async () => {
    let active = 0;
    let peak = 0;
    const fetchMock = vi.fn(async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
      return response(200, { data: { user: { username: "creator", secUid: "SEC-123" } } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const results = await Promise.all(
      Array.from({ length: 24 }, (_, index) => resolveTikTokProfile(`creator${index}`)),
    );
    expect(results.every((result) => result.ok)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(24);
    expect(peak).toBeLessThanOrEqual(8);
  });

  it("deduplicates simultaneous callers for the same paid lookup", async () => {
    const fetchMock = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return response(200, { data: { user: { username: "same", secUid: "SEC-SAME" } } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const results = await Promise.all(
      Array.from({ length: 30 }, () => resolveTikTokProfile("same")),
    );
    expect(results.every((result) => result.ok)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects excess queued work instead of retaining an unbounded burst", async () => {
    let active = 0;
    let peak = 0;
    const fetchMock = vi.fn(async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 25));
      active--;
      return response(200, { data: { user: { username: "burst", secUid: "SEC-BURST" } } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const results = await Promise.all(
      Array.from({ length: 60 }, (_, index) => resolveTikTokProfile(`burst${index}`)),
    );
    expect(results.filter((result) => !result.ok && result.status === 429).length).toBeGreaterThanOrEqual(20);
    expect(peak).toBeLessThanOrEqual(8);
  });

  it("releases limiter slots after upstream failures", async () => {
    let calls = 0;
    const fetchMock = vi.fn(async () => {
      const call = calls++;
      await new Promise((resolve) => setTimeout(resolve, 5));
      if (call < 8) throw new Error("upstream unavailable");
      return response(200, { data: { user: { username: "recovered", secUid: "SEC-OK" } } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const results = await Promise.all(
      Array.from({ length: 16 }, (_, index) => resolveTikTokProfile(`failure${index}`)),
    );
    expect(results.filter((result) => result.ok)).toHaveLength(8);
    expect(results.filter((result) => !result.ok && result.status === 502)).toHaveLength(8);
    expect(fetchMock).toHaveBeenCalledTimes(16);
  });

  it("evicts old cached lookups instead of growing forever", async () => {
    const fetchMock = vi.fn(async (input: string | URL) => {
      const username = new URL(String(input)).searchParams.get("username") ?? "unknown";
      return response(200, { data: { user: { username, secUid: `SEC-${username}` } } });
    });
    vi.stubGlobal("fetch", fetchMock);
    for (let index = 0; index <= 1000; index++) {
      expect((await resolveTikTokProfile(`cached${index}`)).ok).toBe(true);
    }
    expect(fetchMock).toHaveBeenCalledTimes(1001);
    await resolveTikTokProfile("cached0");
    expect(fetchMock).toHaveBeenCalledTimes(1002);
    await resolveTikTokProfile("cached1000");
    expect(fetchMock).toHaveBeenCalledTimes(1002);
  });
});

describe("TikTok relay token", () => {
  it("roundtrips, expires, and rejects tampering", () => {
    const token = createTikTokRelayToken({ username: "creator.name", videoId: "75200199123" });
    expect(verifyTikTokRelayToken(token)).toEqual({ username: "creator.name", videoId: "75200199123" });
    expect(verifyTikTokRelayToken(token.replace("75200199123", "75200199124"))).toBeNull();
    const expired = createTikTokRelayToken(
      { username: "creator", videoId: "75200199123" },
      Date.now() - 40 * 24 * 60 * 60 * 1000,
    );
    expect(verifyTikTokRelayToken(expired)).toBeNull();
  });

  it("handles a CDN body error after streaming has started", async () => {
    const destination = new PassThrough();
    Object.assign(destination, { headersSent: true });
    const end = vi.spyOn(destination, "end");
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        queueMicrotask(() => controller.error(new Error("CDN disconnected")));
      },
    });
    pipeTikTokBody(body, destination as never);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(end).toHaveBeenCalled();
    destination.destroy();
  });
});

describe("TikTok paid lookup routes", () => {
  it("do not let anonymous requests spend upstream quota", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { default: router } = await import("../routes/tiktok");
    const app = express();
    app.use("/api", router);
    expect((await supertest(app).get("/api/tt/profile?username=creator")).status).toBe(401);
    expect((await supertest(app).get("/api/tt/media?username=creator")).status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});