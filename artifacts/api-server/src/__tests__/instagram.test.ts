/**
 * Tests for the Instagram profile/media routes (/api/ig/*).
 *
 * The Zyla Instagram engine is mocked via a global fetch stub — these tests
 * must NEVER hit the paid API. Covers:
 *   1. Username/URL parsing + validation (no upstream call on bad input)
 *   2. Profile normalisation across wrapper/naming variants
 *   3. Response caching (repeat lookup = one upstream call) and the rule
 *      that key-rejection (401/403) is never cached
 *   4. Key resolution: ZYLA_IG_API_KEY preferred, ZYLA_API_KEY fallback,
 *      missing key → 503 without spending quota
 *   5. Media harvesting from messy/nested engine responses
 *   6. /ig/resolve link classification (reel vs post vs profile)
 *   7. Download/view streaming proxy: Meta-CDN allowlist, redirect
 *      re-validation, attachment vs inline, expired-link mapping
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import express, { type Express } from "express";
import supertest from "supertest";

// Skip real DNS in the SSRF re-check — the literal host allowlist is what we
// exercise here. isSafePublicUrl stays real.
vi.mock("../lib/ssrfGuard", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../lib/ssrfGuard")>();
  return { ...mod, urlResolvesPublic: vi.fn(async () => true) };
});

const TEST_KEY = "zyla-ig-test-key-123";

type FetchMock = ReturnType<typeof vi.fn>;

/** Zyla-style JSON body — igGet reads text() then JSON.parses it. */
function textResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  };
}

async function makeApp(): Promise<{ app: Express; fetchMock: FetchMock }> {
  vi.resetModules(); // fresh module-level cache + limiters per test
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  const { default: router } = await import("../routes/instagram");
  const app = express();
  app.use("/api", router);
  return { app, fetchMock };
}

beforeEach(() => {
  process.env["ZYLA_API_KEY"] = TEST_KEY;
  delete process.env["ZYLA_IG_API_KEY"];
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env["ZYLA_API_KEY"];
  delete process.env["ZYLA_IG_API_KEY"];
});

// ── Parsing units ─────────────────────────────────────────────────────────────

describe("parseIgUsername / classifyIgUrl", () => {
  it("accepts usernames, @handles and profile URLs", async () => {
    const { parseIgUsername } = await import("../routes/instagram");
    expect(parseIgUsername("natgeo")).toBe("natgeo");
    expect(parseIgUsername("@NatGeo")).toBe("natgeo");
    expect(parseIgUsername("https://www.instagram.com/natgeo/")).toBe("natgeo");
    expect(parseIgUsername("instagram.com/natgeo?hl=en")).toBe("natgeo");
    expect(parseIgUsername("chai.wala_99")).toBe("chai.wala_99");
  });

  it("rejects non-profiles and garbage", async () => {
    const { parseIgUsername } = await import("../routes/instagram");
    expect(parseIgUsername("https://instagram.com/p/DAbc123/")).toBeNull();
    expect(parseIgUsername("https://evil.com/natgeo")).toBeNull();
    expect(parseIgUsername("bad name!")).toBeNull();
    expect(parseIgUsername("a".repeat(31))).toBeNull();
    expect(parseIgUsername("")).toBeNull();
  });

  it("classifies reel/post/profile links", async () => {
    const { classifyIgUrl } = await import("../routes/instagram");
    expect(classifyIgUrl("https://www.instagram.com/reel/DAbc123/?igsh=x")).toEqual({
      type: "reel",
      url: "https://www.instagram.com/reel/DAbc123/",
    });
    expect(classifyIgUrl("https://instagram.com/p/DXyz789")).toEqual({
      type: "post",
      url: "https://www.instagram.com/p/DXyz789/",
    });
    expect(classifyIgUrl("https://www.instagram.com/natgeo")).toEqual({ type: "profile", username: "natgeo" });
    expect(classifyIgUrl("https://evil.com/reel/DAbc123/")).toBeNull();
  });
});

// ── /ig/profile ───────────────────────────────────────────────────────────────

describe("/api/ig/profile", () => {
  it("rejects bad usernames without spending quota", async () => {
    const { app, fetchMock } = await makeApp();
    const r = await supertest(app).get("/api/ig/profile?username=???");
    expect(r.status).toBe(400);
    expect(r.body.code).toBe("BAD_USERNAME");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("normalises a wrapped snake_case engine response", async () => {
    const { app, fetchMock } = await makeApp();
    fetchMock.mockResolvedValueOnce(
      textResponse(200, {
        success: true,
        data: {
          user: {
            username: "NatGeo",
            full_name: "National Geographic",
            biography: "Experience the world.",
            follower_count: "283000000",
            following_count: 130,
            media_count: 30500,
            profile_pic_url_hd: "https://scontent.cdninstagram.com/avatar.jpg",
            is_private: false,
            is_verified: true,
          },
        },
      }),
    );
    const r = await supertest(app).get("/api/ig/profile?username=@NatGeo");
    expect(r.status).toBe(200);
    expect(r.body.profile).toMatchObject({
      username: "natgeo",
      fullName: "National Geographic",
      followers: 283000000,
      following: 130,
      totalPosts: 30500,
      isPrivate: false,
      isVerified: true,
    });
    // Bearer key goes upstream, to the profile endpoint
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("23416/get+profile+details");
    expect(String(url)).toContain("username=natgeo");
    expect(init.headers.authorization).toBe(`Bearer ${TEST_KEY}`);
  });

  it("caches successful lookups — repeat lookup makes no second paid call", async () => {
    const { app, fetchMock } = await makeApp();
    fetchMock.mockResolvedValue(textResponse(200, { username: "natgeo", followers: 5 }));
    await supertest(app).get("/api/ig/profile?username=natgeo");
    const r2 = await supertest(app).get("/api/ig/profile?username=natgeo");
    expect(r2.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("maps key rejection to 503 IG_NOT_SUBSCRIBED and does NOT cache it", async () => {
    const { app, fetchMock } = await makeApp();
    fetchMock.mockResolvedValue(
      textResponse(401, { success: false, message: "You are not authorized to access this API." }),
    );
    const r1 = await supertest(app).get("/api/ig/profile?username=natgeo");
    expect(r1.status).toBe(503);
    expect(r1.body.code).toBe("IG_NOT_SUBSCRIBED");
    await supertest(app).get("/api/ig/profile?username=natgeo");
    expect(fetchMock).toHaveBeenCalledTimes(2); // retried — a fixed key must work immediately
  });

  it("returns 503 IG_NOT_CONFIGURED when no key exists (no upstream call)", async () => {
    delete process.env["ZYLA_API_KEY"];
    const { app, fetchMock } = await makeApp();
    const r = await supertest(app).get("/api/ig/profile?username=natgeo");
    expect(r.status).toBe(503);
    expect(r.body.code).toBe("IG_NOT_CONFIGURED");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("prefers ZYLA_IG_API_KEY over ZYLA_API_KEY", async () => {
    process.env["ZYLA_IG_API_KEY"] = "dedicated-ig-key";
    const { app, fetchMock } = await makeApp();
    fetchMock.mockResolvedValueOnce(textResponse(200, { username: "natgeo" }));
    await supertest(app).get("/api/ig/profile?username=natgeo");
    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers.authorization).toBe("Bearer dedicated-ig-key");
  });
});

// ── /ig/media ─────────────────────────────────────────────────────────────────

describe("/api/ig/media", () => {
  it("harvests media items from a messy nested response", async () => {
    const { app, fetchMock } = await makeApp();
    fetchMock.mockResolvedValueOnce(
      textResponse(200, {
        data: {
          username: "natgeo",
          totalMedia: 3,
          mediaList: [
            {
              downloadUrl: "https://scontent.cdninstagram.com/v1.mp4",
              mediaType: "VIDEO",
              thumbnailUrl: "https://scontent.cdninstagram.com/t1.jpg",
              caption: "A lion at dawn",
            },
            { downloadUrl: "https://scontent.cdninstagram.com/p1.jpg", mediaType: "PHOTO" },
            {
              // carousel-style nesting + snake_case + no explicit type
              items: [{ video_url: "https://scontent.cdninstagram.com/v2.mp4", taken_at: 1723456789 }],
            },
            // duplicate must be deduped
            { downloadUrl: "https://scontent.cdninstagram.com/p1.jpg", mediaType: "PHOTO" },
          ],
        },
      }),
    );
    const r = await supertest(app).get("/api/ig/media?username=natgeo&kind=posts");
    expect(r.status).toBe(200);
    expect(r.body.kind).toBe("posts");
    expect(r.body.count).toBe(3);
    const urls = r.body.items.map((m: { downloadUrl: string }) => m.downloadUrl);
    expect(urls).toEqual([
      "https://scontent.cdninstagram.com/v1.mp4",
      "https://scontent.cdninstagram.com/p1.jpg",
      "https://scontent.cdninstagram.com/v2.mp4",
    ]);
    expect(r.body.items[0]).toMatchObject({ mediaType: "VIDEO", thumbnailUrl: "https://scontent.cdninstagram.com/t1.jpg", caption: "A lion at dawn" });
    expect(r.body.items[2].mediaType).toBe("VIDEO"); // inferred from .mp4
    const [url] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("23417/get+profile+posts+list");
  });

  it("routes kinds to their endpoints and rejects unknown kinds", async () => {
    const { app, fetchMock } = await makeApp();
    fetchMock.mockResolvedValue(textResponse(200, { mediaList: [] }));
    await supertest(app).get("/api/ig/media?username=natgeo&kind=reels");
    expect(String(fetchMock.mock.calls[0][0])).toContain("23418/get+profile+reels+list");
    await supertest(app).get("/api/ig/media?username=natgeo&kind=stories");
    expect(String(fetchMock.mock.calls[1][0])).toContain("23423/get+all+24h+stories");

    const bad = await supertest(app).get("/api/ig/media?username=natgeo&kind=likes");
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe("BAD_KIND");
  });
});

// ── /ig/resolve ───────────────────────────────────────────────────────────────

describe("/api/ig/resolve", () => {
  it("resolves a reel link via the reel-details endpoint", async () => {
    const { app, fetchMock } = await makeApp();
    fetchMock.mockResolvedValueOnce(
      textResponse(200, { downloadUrl: "https://scontent.cdninstagram.com/reel.mp4", mediaType: "VIDEO" }),
    );
    const r = await supertest(app).get(
      `/api/ig/resolve?url=${encodeURIComponent("https://www.instagram.com/reel/DAbc123/?igsh=zz")}`,
    );
    expect(r.status).toBe(200);
    expect(r.body.type).toBe("media");
    expect(r.body.items[0].downloadUrl).toContain("reel.mp4");
    const [url] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("23421/get+reel+details");
    expect(String(url)).toContain(encodeURIComponent("https://www.instagram.com/reel/DAbc123/"));
  });

  it("short-circuits profile links without calling the engine", async () => {
    const { app, fetchMock } = await makeApp();
    const r = await supertest(app).get(
      `/api/ig/resolve?url=${encodeURIComponent("https://instagram.com/natgeo")}`,
    );
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ type: "profile", username: "natgeo" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects non-Instagram links", async () => {
    const { app, fetchMock } = await makeApp();
    const r = await supertest(app).get(`/api/ig/resolve?url=${encodeURIComponent("https://evil.com/reel/x")}`);
    expect(r.status).toBe(400);
    expect(r.body.code).toBe("BAD_IG_URL");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ── /ig/download + /ig/view streaming proxy ──────────────────────────────────

describe("/api/ig/download and /api/ig/view", () => {
  it("refuses non-Meta hosts and plain http without fetching", async () => {
    const { app, fetchMock } = await makeApp();
    const r1 = await supertest(app).get(`/api/ig/download?u=${encodeURIComponent("https://evil.com/x.mp4")}`);
    expect(r1.status).toBe(400);
    expect(r1.body.code).toBe("MEDIA_HOST_NOT_ALLOWED");
    const r2 = await supertest(app).get(
      `/api/ig/download?u=${encodeURIComponent("http://scontent.cdninstagram.com/x.mp4")}`,
    );
    expect(r2.status).toBe(400);
    // suffix trick: cdninstagram.com.evil.com must NOT pass
    const r3 = await supertest(app).get(
      `/api/ig/download?u=${encodeURIComponent("https://scontent.cdninstagram.com.evil.com/x.mp4")}`,
    );
    expect(r3.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("streams an allowlisted file as attachment with a safe filename", async () => {
    const { app, fetchMock } = await makeApp();
    fetchMock.mockResolvedValueOnce(
      new Response(Buffer.from("VIDEOBYTES"), {
        status: 200,
        headers: { "content-type": "video/mp4", "content-length": "10" },
      }),
    );
    const r = await supertest(app)
      .get(`/api/ig/download?u=${encodeURIComponent("https://scontent.cdninstagram.com/v.mp4")}&name=natgeo posts 1`)
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => cb(null, Buffer.concat(chunks)));
      });
    expect(r.status).toBe(200);
    expect(r.headers["content-disposition"]).toBe('attachment; filename="natgeo_posts_1.mp4"');
    expect(r.headers["content-type"]).toContain("video/mp4");
    expect((r.body as Buffer).toString()).toBe("VIDEOBYTES");
  });

  it("serves /ig/view inline with caching for thumbnails", async () => {
    const { app, fetchMock } = await makeApp();
    fetchMock.mockResolvedValueOnce(
      new Response(Buffer.from("JPEG"), { status: 200, headers: { "content-type": "image/jpeg" } }),
    );
    const r = await supertest(app).get(`/api/ig/view?u=${encodeURIComponent("https://scontent.cdninstagram.com/t.jpg")}`);
    expect(r.status).toBe(200);
    expect(r.headers["content-disposition"]).toBe("inline");
    expect(r.headers["cache-control"]).toContain("max-age=1800");
  });

  it("refuses to render non-media content types inline via /ig/view", async () => {
    const { app, fetchMock } = await makeApp();
    fetchMock.mockResolvedValueOnce(
      new Response("<script>alert(1)</script>", { status: 200, headers: { "content-type": "text/html" } }),
    );
    const r = await supertest(app).get(`/api/ig/view?u=${encodeURIComponent("https://scontent.cdninstagram.com/x")}`);
    expect(r.status).toBe(415);
    expect(r.body.code).toBe("UNSUPPORTED_MEDIA_TYPE");

    // SVG can carry script — also blocked inline
    fetchMock.mockResolvedValueOnce(
      new Response("<svg/>", { status: 200, headers: { "content-type": "image/svg+xml" } }),
    );
    const r2 = await supertest(app).get(`/api/ig/view?u=${encodeURIComponent("https://scontent.cdninstagram.com/y")}`);
    expect(r2.status).toBe(415);
  });

  it("blocks redirects that hop off the Meta CDN allowlist", async () => {
    const { app, fetchMock } = await makeApp();
    fetchMock.mockResolvedValueOnce(
      new Response(null, { status: 302, headers: { location: "https://evil.com/steal" } }),
    );
    const r = await supertest(app).get(
      `/api/ig/download?u=${encodeURIComponent("https://scontent.cdninstagram.com/v.mp4")}`,
    );
    expect(r.status).toBe(400);
    expect(r.body.code).toBe("MEDIA_HOST_NOT_ALLOWED");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("maps upstream failures to a clear expired-link error", async () => {
    const { app, fetchMock } = await makeApp();
    fetchMock.mockResolvedValueOnce(new Response("gone", { status: 403 }));
    const r = await supertest(app).get(
      `/api/ig/download?u=${encodeURIComponent("https://scontent.cdninstagram.com/v.mp4")}`,
    );
    expect(r.status).toBe(502);
    expect(r.body.code).toBe("MEDIA_LINK_EXPIRED");
  });
});
