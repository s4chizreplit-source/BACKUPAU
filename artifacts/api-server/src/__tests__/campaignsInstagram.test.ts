/**
 * Instagram source for Auto-Pilot campaigns — integration tests.
 *
 * The Zyla Instagram engine is mocked via a global fetch stub — these tests
 * must NEVER hit the paid API (real keys may be exported in the dev env; the
 * stub throws on any unexpected zylalabs call). DB-backed cases run against
 * the real dev database through the full express app (like
 * campaignRetryClip.test.ts) and are skipped without DATABASE_URL.
 *
 * Covered:
 *   - igRelayToken: roundtrip (dotted usernames), expiry, tamper, garbage
 *   - igItemsToFiles/igFileName: oldest-first ordering + caption naming
 *   - detect: explicit instagram kind, auto-detect from a profile link,
 *     videos-only counting, 30-min list cache (no double billing)
 *   - create: items land oldest-first as ig:<user>:<kind>:<id>, canonical
 *     source_url, invalid usernames rejected
 *   - materializer rescan: a NEW reel discovered later jumps the queue
 *     (negative sort_order, posted at the next slot before the backlog)
 *   - pagination: deep detect/create follows nextCursor across pages and
 *     stores shortcode refs; the daily rescan stays page-1-only; deep items
 *     resolve at publish time via details-by-shortcode-URL
 *   - backlog limit: only the newest N existing videos post (older ones are
 *     stored but held back), while rescan-discovered NEW uploads still post
 *   - PATCH: profile change blocked, other edits still fine
 *   - /ig/relay/:token: streams fresh CDN bytes (no auth cookie — token IS
 *     the auth), 403 on invalid/expired, 404 when media is gone
 */
import { describe, it, expect, afterAll, vi } from "vitest";
import request from "supertest";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";

// Skip real DNS in the SSRF re-check — the literal host allowlist is what we
// exercise here. isSafePublicUrl stays real.
vi.mock("../lib/ssrfGuard", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../lib/ssrfGuard")>();
  return { ...mod, urlResolvesPublic: vi.fn(async () => true) };
});

// Campaign create + materialize need PFM "configured" and account ownership —
// both are provider round-trips in production. Everything else stays real.
vi.mock("../lib/postforme", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../lib/postforme")>();
  return {
    ...mod,
    isPfmConfigured: () => true,
    verifyAccountOwnership: async (_userId: string, ids: string[]) => ({
      owned: ids.map((id) => ({
        pfmAccountId: id,
        platform: id.startsWith("acc-tt-") ? "tiktok" : "youtube",
      })),
      foreign: [] as string[],
    }),
  };
});

// Fake keys BEFORE any request: setup.ts deletes ZYLA_API_KEY but the dev env
// may still export ZYLA_IG_API_KEY — never let a real key near a real call.
process.env["ZYLA_API_KEY"] = "zyla-test-key";
process.env["ZYLA_IG_API_KEY"] = "zyla-ig-test-key";
process.env["ZYLA_TIKTOK_API_KEY"] = "zyla-tiktok-test-key";
process.env["SESSION_SECRET"] ||= "test-session-secret";
process.env["PUBLIC_APP_URL"] = "https://autocliper-test.example";

// ── Zyla + CDN fetch stub ─────────────────────────────────────────────────────
// Endpoint ids: posts 23417, reels 23418, post-details 23420, reel-details 23421.
type ZylaReply = { status: number; body: unknown };
const zylaRoutes = new Map<string, ZylaReply>(); // "<epId>:<param>" → reply
let zylaCalls = 0;
const cdnFiles = new Map<string, Buffer>();      // pathname → bytes

function zylaKeyOf(url: string): string | null {
  const m = url.match(/\/api\/\d+\/[^/]*\/(\d+)\//);
  if (!m) return null;
  const qs = new URL(url).searchParams;
  const param = qs.get("username") ?? qs.get("idOrUrl") ?? qs.get("secUid");
  if (!param) return null;
  const cursor = qs.get("nextCursor");
  return `${m[1]}:${param}${cursor ? `:c=${cursor}` : ""}`;
}

vi.stubGlobal("fetch", vi.fn(async (input: string | URL): Promise<Response> => {
  const url = String(input);
  if (url.includes("zylalabs.com")) {
    zylaCalls++;
    const key = zylaKeyOf(url);
    const reply = key ? zylaRoutes.get(key) : undefined;
    if (!reply) throw new Error(`unexpected zyla call in test: ${url}`);
    return {
      ok: reply.status >= 200 && reply.status < 300,
      status: reply.status,
      text: async () => JSON.stringify(reply.body),
    } as unknown as Response;
  }
  if (/cdninstagram\.com|fbcdn\.net/.test(url)) {
    const bytes = cdnFiles.get(new URL(url).pathname);
    if (!bytes) {
      return { ok: false, status: 404, headers: new Headers(), body: null } as unknown as Response;
    }
    return {
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "video/mp4", "content-length": String(bytes.length) }),
      body: new ReadableStream({
        start(c) { c.enqueue(new Uint8Array(bytes)); c.close(); },
      }),
    } as unknown as Response;
  }
  throw new Error(`unexpected fetch in test: ${url}`);
}));

const HAS_DB = !!process.env.DATABASE_URL;

const app = (await import("../app")).default;
const { pool } = await import("../lib/db");
const { materializeOne, igItemsToFiles, igFileName } = await import("../routes/campaigns");
const { createIgRelayToken, verifyIgRelayToken } = await import("../lib/igRelayToken");
const { __clearIgCacheForTests } = await import("../routes/instagram");
const { resolveDirectUrl } = await import("../routes/social");
const { verifyTikTokRelayToken } = await import("../lib/tiktokRelayToken");

const TEST_DOMAIN = "ig-autopilot.clipai.dev";
const uniq = () => crypto.randomBytes(5).toString("hex");
const email = (tag: string) => `${tag}-${uniq()}@${TEST_DOMAIN}`;
const todayUtc = () => new Date().toISOString().slice(0, 10);

const vid = (id: string, caption?: string, takenAt?: number) => ({
  id,
  mediaType: "VIDEO",
  downloadUrl: `https://scontent.cdninstagram.com/v/${id}.mp4`,
  ...(caption ? { caption } : {}),
  ...(takenAt !== undefined ? { taken_at: takenAt } : {}),
});
const photo = (id: string) => ({
  id,
  mediaType: "PHOTO",
  downloadUrl: `https://scontent.cdninstagram.com/p/${id}.jpg`,
});
const setLists = (username: string, reels: unknown[], posts: unknown[]): void => {
  zylaRoutes.set(`23418:${username}`, { status: 200, body: { data: reels } });
  zylaRoutes.set(`23417:${username}`, { status: 200, body: { data: posts } });
};

const campaignIds: string[] = [];

// Clip-link campaigns need a real job record the create route can read for
// its ownership check — same per-worker jobs dir videoTools.ts uses under
// vitest (see campaignRetryClip.test.ts).
const JOBS_DIR = path.join(os.tmpdir(), `clipai-jobs-test-${process.pid}`);
const seededJobs: string[] = [];
function seedJob(id: string, rec: Record<string, unknown>): void {
  fs.mkdirSync(JOBS_DIR, { recursive: true });
  const p = path.join(JOBS_DIR, `${id}.json`);
  fs.writeFileSync(p, JSON.stringify(rec));
  seededJobs.push(p);
}
afterAll(() => {
  for (const p of seededJobs) { try { fs.unlinkSync(p); } catch { /* gone */ } }
});

/** materializeOne skips silently (SKIP LOCKED) if the dev server's own sweep
 *  briefly holds the campaign row — the dev DB is shared. Retry until the
 *  expected day is consumed so the race can't flake the assertions. */
async function materializeDay(cid: string, now: Date, wantDate: string): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await materializeOne(cid, now);
    const { rows } = await pool!.query(
      `SELECT last_planned_date::text AS d FROM social_campaigns WHERE id = $1`, [cid]);
    if (rows[0]?.d === wantDate) return;
    await new Promise((r) => setTimeout(r, 120));
  }
  throw new Error(`campaign ${cid} never planned ${wantDate}`);
}

afterAll(async () => {
  vi.unstubAllGlobals();
  if (pool) {
    if (campaignIds.length > 0) {
      await pool.query(`DELETE FROM social_posts WHERE batch_id = ANY($1)`, [campaignIds]);
      await pool.query(`DELETE FROM social_campaign_items WHERE campaign_id = ANY($1)`, [campaignIds]);
      await pool.query(`DELETE FROM social_campaigns WHERE id = ANY($1)`, [campaignIds]);
    }
    await pool.query(`DELETE FROM users WHERE email LIKE $1`, [`%@${TEST_DOMAIN}`]);
    await pool.end();
  }
});

// ── Pure units (no DB) ────────────────────────────────────────────────────────

describe("igRelayToken", () => {
  it("roundtrips post + reel refs, dotted usernames included", () => {
    for (const ref of [
      { username: "chai.wala_99", kind: "reel" as const, mediaId: "3967266982361430113" },
      { username: "abc.r", kind: "post" as const, mediaId: "DAbc-12_x" },
    ]) {
      const token = createIgRelayToken(ref);
      expect(verifyIgRelayToken(token)).toEqual(ref);
    }
  });

  it("rejects expired tokens (ttl clamps to 30 days min)", () => {
    const ref = { username: "old.timer", kind: "reel" as const, mediaId: "12345" };
    const token = createIgRelayToken(ref, Date.now() - 40 * 24 * 3600 * 1000);
    expect(verifyIgRelayToken(token)).toBeNull();
  });

  it("rejects tampered payloads and garbage", () => {
    const token = createIgRelayToken({ username: "tamper.me", kind: "post", mediaId: "99999" });
    const parts = token.split("~");
    parts[2] = "88888"; // different media id, original signature
    expect(verifyIgRelayToken(parts.join("~"))).toBeNull();
    expect(verifyIgRelayToken(token.slice(0, -4) + "AAAA")).toBeNull();
    expect(verifyIgRelayToken("not-a-token")).toBeNull();
    expect(verifyIgRelayToken("")).toBeNull();
  });

  it("refuses to mint tokens for junk refs", () => {
    expect(() => createIgRelayToken({ username: "bad name!", kind: "post", mediaId: "12345" })).toThrow();
    expect(() => createIgRelayToken({ username: "fine", kind: "post", mediaId: "x" })).toThrow();
  });
});

describe("igItemsToFiles / igFileName", () => {
  it("reverses newest-first lists so campaigns post oldest-first", () => {
    const files = igItemsToFiles("creator", [
      { id: "300", kind: "reel", downloadUrl: "https://x/300.mp4" },       // newest
      { id: "200", kind: "post", downloadUrl: "https://x/200.mp4" },
      { id: "100", kind: "reel", downloadUrl: "https://x/100.mp4" },       // oldest
    ]);
    expect(files.map((f) => f.url)).toEqual([
      "ig:creator:reel:100", "ig:creator:post:200", "ig:creator:reel:300",
    ]);
  });

  it("names items from the caption, stripping tags — else a stable fallback", () => {
    expect(igFileName("creator", {
      id: "1", kind: "reel", downloadUrl: "u",
      caption: "Sunset drone shot over Goa #travel #reels @friend",
    })).toBe("Sunset drone shot over Goa");
    expect(igFileName("creator", { id: "987654321", kind: "reel", downloadUrl: "u", caption: "#fyp" }))
      .toBe("@creator reel 654321");
  });
});

// ── DB-backed flows ───────────────────────────────────────────────────────────

describe.skipIf(!HAS_DB)("Instagram Auto-Pilot (DB)", () => {
  const agent = request.agent(app);
  let userId = "";

  it("setup: account", async () => {
    const r = await agent.post("/api/auth/signup").send({ email: email("ig"), password: "hunter2222!" });
    expect(r.status).toBe(200);
    userId = r.body.user.id;
  });

  it("detect counts VIDEOS only and reuses the cached lists", async () => {
    const u = `campdetect${uniq()}`.slice(0, 28);
    setLists(u, [vid("r2", "Fresh reel about chai"), vid("r1")], [photo("ph1"), vid("p1")]);

    const before = zylaCalls;
    const r1 = await agent.post("/api/social/campaigns/detect")
      .send({ source: `@${u}`, sourceKind: "instagram" });
    expect(r1.status).toBe(200);
    expect(r1.body.ig).toBe(true);
    expect(r1.body.username).toBe(u);
    expect(r1.body.count).toBe(3); // 2 reel videos + 1 feed video, photo skipped
    expect(r1.body.names[0]).toBe("Fresh reel about chai");
    expect(zylaCalls - before).toBe(2); // posts + reels, once each

    // Same profile pasted as a URL, no explicit kind → auto-detected, cache hit.
    const r2 = await agent.post("/api/social/campaigns/detect")
      .send({ source: `https://www.instagram.com/${u}/` });
    expect(r2.status).toBe(200);
    expect(r2.body.ig).toBe(true);
    expect(zylaCalls - before).toBe(2); // no new upstream calls

    const bad = await agent.post("/api/social/campaigns/detect")
      .send({ source: "not a profile!!", sourceKind: "instagram" });
    expect(bad.status).toBe(400);
  });

  it("create ingests items oldest-first with canonical source_url", async () => {
    const u = `campcreate${uniq()}`.slice(0, 28);
    setLists(u, [vid("902", "Newest reel"), vid("901", "Older reel")], []);

    const r = await agent.post("/api/social/campaigns").send({
      source: `@${u}`, sourceKind: "instagram",
      accountIds: ["acc-ig-test"], times: ["23:59"], perSlot: 1,
      startDate: todayUtc(), endDate: todayUtc(),
      timezone: "UTC", caption: "", aiCaptions: false, name: "IG repost",
    });
    expect(r.status).toBe(200);
    expect(r.body.detected).toBe(2);
    campaignIds.push(r.body.id);

    const { rows: camp } = await pool!.query(
      `SELECT source_url, source_kind FROM social_campaigns WHERE id = $1`, [r.body.id]);
    expect(camp[0].source_kind).toBe("instagram");
    expect(camp[0].source_url).toBe(`https://www.instagram.com/${u}/`);

    const { rows: items } = await pool!.query(
      `SELECT url, file_name FROM social_campaign_items WHERE campaign_id = $1 ORDER BY sort_order, id`,
      [r.body.id]);
    expect(items.map((i) => i.url)).toEqual([`ig:${u}:reel:901`, `ig:${u}:reel:902`]);
    expect(items[0].file_name).toBe("Older reel");

    // Cleanup any same-day planned rows fast — the dev server's drain shares
    // this database. (kickMaterializer is a no-op under NODE_ENV=test, so
    // there should be none — this is belt and braces.)
    await pool!.query(`DELETE FROM social_posts WHERE batch_id = $1`, [r.body.id]);

    const rejected = await agent.post("/api/social/campaigns").send({
      source: "definitely not instagram", sourceKind: "instagram",
      accountIds: ["acc-ig-test"], times: ["23:59"], perSlot: 1,
      startDate: todayUtc(), endDate: todayUtc(), timezone: "UTC",
    });
    expect(rejected.status).toBe(400);
  });

  it("TikTok runs detect → create → materialize with stable refs and a TikTok destination", async () => {
    const u = `ttcampaign${uniq()}`.slice(0, 28);
    const secUid = `SEC-${u}`;
    zylaRoutes.set(`23413:${u}`, {
      status: 200,
      body: { data: { user: { username: u, secUid } } },
    });
    zylaRoutes.set(`23414:${secUid}`, {
      status: 200,
      body: {
        data: {
          items: [
            { id: "7002", type: "VIDEO", desc: "Newest TikTok video", hdPlayUrlList: ["https://v16.tiktokcdn.com/7002.mp4"] },
            { id: "photo1", type: "PHOTO", desc: "Photo post", playUrlList: ["https://v16.tiktokcdn.com/photo1.mp4"] },
            { id: "7001", type: "VIDEO", desc: "Older TikTok video", playUrlList: ["https://v16.tiktokcdn.com/7001.mp4"] },
          ],
          hasMore: false,
          minCursor: 0,
          maxCursor: 0,
        },
      },
    });

    const detected = await agent.post("/api/social/campaigns/detect")
      .send({ source: `@${u}`, sourceKind: "tiktok" });
    expect(detected.status).toBe(200);
    expect(detected.body.tiktok).toBe(true);
    expect(detected.body.count).toBe(2);

    const materializeNow = new Date(Date.now() + 10 * 60 * 1000);
    const target = new Date(materializeNow.getTime() + 10 * 60 * 1000);
    const campaignDate = target.toISOString().slice(0, 10);
    const campaignTime = `${String(target.getUTCHours()).padStart(2, "0")}:${String(target.getUTCMinutes()).padStart(2, "0")}`;
    const created = await agent.post("/api/social/campaigns").send({
      source: `@${u}`,
      sourceKind: "tiktok",
      accountIds: ["acc-tt-destination"],
      times: [campaignTime],
      startDate: campaignDate,
      endDate: campaignDate,
      timezone: "UTC",
      caption: "",
      aiCaptions: false,
      name: "TikTok repost",
    });
    expect(created.status).toBe(200);
    expect(created.body.detected).toBe(2);
    campaignIds.push(created.body.id);

    const { rows: items } = await pool!.query(
      `SELECT url FROM social_campaign_items WHERE campaign_id = $1 ORDER BY sort_order, id`,
      [created.body.id],
    );
    expect(items.map((item) => item.url)).toEqual([
      `tt:${u}:7001`,
      `tt:${u}:7002`,
    ]);

    await materializeDay(created.body.id, materializeNow, campaignDate);
    const { rows: posts } = await pool!.query(
      `SELECT media_url, platforms FROM social_posts WHERE batch_id = $1 ORDER BY scheduled_at`,
      [created.body.id],
    );
    expect(posts).toHaveLength(1);
    expect(posts[0].media_url).toBe(`tt:${u}:7001`);
    expect(posts[0].platforms).toEqual(["tiktok"]);

    const handoffUrl = await resolveDirectUrl(posts[0].media_url, userId, posts[0].scheduled_at);
    const handoff = new URL(handoffUrl);
    expect(handoff.origin).toBe("https://autocliper-test.example");
    expect(handoff.pathname).toMatch(/^\/api\/tt\/relay\//);
    expect(verifyTikTokRelayToken(handoff.pathname.split("/").pop() ?? "")).toEqual({
      username: u,
      videoId: "7001",
    });

    const listed = await agent.get("/api/social/campaigns");
    expect(listed.status).toBe(200);
    const campaign = listed.body.campaigns.find((row: { id: string }) => row.id === created.body.id);
    expect(campaign?.sourceKind).toBe("tiktok");
    expect(campaign?.state).not.toBe("exhausted");
  });

  it("PATCH blocks profile swaps but allows schedule edits", async () => {
    const cid = campaignIds[0];
    const swap = await agent.patch(`/api/social/campaigns/${cid}`).send({ source: "@someone_else" });
    expect(swap.status).toBe(400);
    expect(String(swap.body.error)).toMatch(/tied to its profile/i);

    const times = await agent.patch(`/api/social/campaigns/${cid}`).send({ times: ["10:00", "18:00"] });
    expect(times.status).toBe(200);

    // Editing times migrates legacy multiplier rows to one-video-per-time.
    await pool!.query(`UPDATE social_campaigns SET per_slot = 3 WHERE id = $1`, [cid]);
    const again = await agent.patch(`/api/social/campaigns/${cid}`).send({ times: ["09:00", "19:00"] });
    expect(again.status).toBe(200);
    const { rows: slot } = await pool!.query(`SELECT per_slot FROM social_campaigns WHERE id = $1`, [cid]);
    expect(slot[0].per_slot).toBe(1);

    // perSlot in the body is ignored — it can never resurrect the multiplier.
    const slotPatch = await agent.patch(`/api/social/campaigns/${cid}`)
      .send({ perSlot: 5, times: ["09:00", "19:00"] });
    expect(slotPatch.status).toBe(200);
    const { rows: slot2 } = await pool!.query(`SELECT per_slot FROM social_campaigns WHERE id = $1`, [cid]);
    expect(slot2[0].per_slot).toBe(1);
  });

  it("create stores per_slot = 1 even when a legacy client sends perSlot > 1", async () => {
    const u = `campslot${uniq()}`.slice(0, 28);
    setLists(u, [vid("921", "Slot one"), vid("922", "Slot two")], []);
    const r = await agent.post("/api/social/campaigns").send({
      source: `@${u}`, sourceKind: "instagram",
      accountIds: ["acc-ig-test"], times: ["23:40", "23:45"], perSlot: 4,
      startDate: todayUtc(), endDate: todayUtc(), timezone: "UTC",
      caption: "", aiCaptions: false, name: "Slot check",
    });
    expect(r.status).toBe(200);
    campaignIds.push(r.body.id);
    const { rows } = await pool!.query(`SELECT per_slot FROM social_campaigns WHERE id = $1`, [r.body.id]);
    expect(rows[0].per_slot).toBe(1);
    await pool!.query(`DELETE FROM social_posts WHERE batch_id = $1`, [r.body.id]);
  });

  it("clip campaigns: every clip needs its own posting time", async () => {
    const jobId = crypto.randomBytes(12).toString("hex");
    seedJob(jobId, {
      status: "processing", userId,
      url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      platform: "shorts", forCampaign: true,
      createdMs: Date.now(), updatedMs: Date.now(),
    });
    const base = {
      source: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      sourceKind: "clip_link", clipJobId: jobId,
      accountIds: ["acc-ig-test"],
      startDate: todayUtc(), endDate: todayUtc(), timezone: "UTC",
      caption: "", aiCaptions: false, name: "Clip pairing",
    };

    // 3 clips but only 2 times → rejected with the pairing error.
    const bad = await agent.post("/api/social/campaigns").send({
      ...base, clipParams: { clipCount: 3, quality: "fast" }, times: ["10:00", "11:00"],
    });
    expect(bad.status).toBe(400);
    expect(String(bad.body.error)).toMatch(/own posting time/i);

    // Missing clip settings → rejected too (no silent 5-clip default).
    const missing = await agent.post("/api/social/campaigns").send({
      ...base, times: ["10:00", "11:00"],
    });
    expect(missing.status).toBe(400);

    // 2 clips + 2 times → accepted; the row stores one video per time.
    const ok = await agent.post("/api/social/campaigns").send({
      ...base, clipParams: { clipCount: 2, quality: "fast" }, times: ["10:00", "11:00"],
    });
    expect(ok.status).toBe(200);
    campaignIds.push(ok.body.id);
    const { rows } = await pool!.query(
      `SELECT per_slot, (clip_params::json->>'clipCount')::int AS cc
         FROM social_campaigns WHERE id = $1`, [ok.body.id]);
    expect(rows[0].per_slot).toBe(1);
    expect(rows[0].cc).toBe(2);

    // The attached job is the source of truth: a job cutting 5 clips can't
    // back a 2-clip campaign, even when clipParams and times agree.
    const jobOff = crypto.randomBytes(12).toString("hex");
    seedJob(jobOff, {
      status: "processing", userId, clipCount: 5,
      url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      platform: "shorts", forCampaign: true,
      createdMs: Date.now(), updatedMs: Date.now(),
    });
    const mismatch = await agent.post("/api/social/campaigns").send({
      ...base, clipJobId: jobOff,
      clipParams: { clipCount: 2, quality: "fast" }, times: ["10:00", "11:00"],
    });
    expect(mismatch.status).toBe(400);
    expect(String(mismatch.body.error)).toMatch(/so they match/i);

    // Editing the schedule keeps the pairing: this campaign posts 2 clips,
    // so exactly 2 times — more or fewer are rejected, 2 fresh ones pass.
    const grow = await agent.patch(`/api/social/campaigns/${ok.body.id}`)
      .send({ times: ["09:00", "12:00", "15:00"] });
    expect(grow.status).toBe(400);
    expect(String(grow.body.error)).toMatch(/keep exactly 2/i);
    const moved = await agent.patch(`/api/social/campaigns/${ok.body.id}`)
      .send({ times: ["09:15", "18:45"] });
    expect(moved.status).toBe(200);

    await pool!.query(`DELETE FROM social_posts WHERE batch_id = $1`, [ok.body.id]);
  });

  it("daily rescan discovers a NEW reel and posts it before the backlog", async () => {
    const u = `camprescan${uniq()}`.slice(0, 28);
    const cid = crypto.randomUUID();
    campaignIds.push(cid);
    await pool!.query(
      `INSERT INTO social_campaigns
         (id, user_id, name, source_url, account_ids, times, per_slot,
          start_date, end_date, timezone, caption, ai_captions, source_kind, enabled, status)
       VALUES ($1,$2,'IG rescan',$3,'{acc-ig-test}','{23:58}',1,$4,'2099-12-31','UTC','',FALSE,'instagram',TRUE,'active')`,
      [cid, userId, `https://www.instagram.com/${u}/`, todayUtc()],
    );
    await pool!.query(
      `INSERT INTO social_campaign_items (campaign_id, url, file_name, sort_order)
       VALUES ($1,$2,'old one',0), ($1,$3,'old two',1)`,
      [cid, `ig:${u}:reel:801`, `ig:${u}:reel:802`],
    );
    // The profile NOW lists a brand-new reel on top of the two known ones.
    setLists(u, [vid("803", "Brand new reel"), vid("802"), vid("801")], []);

    await materializeDay(cid, new Date(), todayUtc());

    const { rows: items } = await pool!.query(
      `SELECT url, sort_order, post_row_id FROM social_campaign_items
       WHERE campaign_id = $1 ORDER BY sort_order, id`, [cid]);
    expect(items.map((i) => i.url)).toEqual([
      `ig:${u}:reel:803`, `ig:${u}:reel:801`, `ig:${u}:reel:802`,
    ]);
    expect(items[0].sort_order).toBeLessThan(0); // jumped the queue

    // Exactly one slot today (per_slot 1 × one time) → the NEW reel got it.
    const { rows: posts } = await pool!.query(
      `SELECT media_url, file_name, status FROM social_posts WHERE batch_id = $1`, [cid]);
    expect(posts).toHaveLength(1);
    expect(posts[0].media_url).toBe(`ig:${u}:reel:803`);
    expect(posts[0].file_name).toBe("Brand new reel");
    expect(items[0].post_row_id).not.toBeNull();
    expect(items[1].post_row_id).toBeNull();

    const { rows: camp } = await pool!.query(
      `SELECT last_planned_date::text AS d, status FROM social_campaigns WHERE id = $1`, [cid]);
    expect(camp[0].d).toBe(todayUtc());
    expect(camp[0].status).toBe("active");

    // Remove queued rows immediately — shared dev DB, see note above.
    await pool!.query(`DELETE FROM social_posts WHERE batch_id = $1`, [cid]);
  });

  it("deep detect paginates via nextCursor, stores shortcode refs, rescan stays shallow", async () => {
    const u = `campdeep${uniq()}`.slice(0, 28);
    // Real engine shape: code/title live on the ITEM, downloadUrl on a nested
    // mediaList child. The harvested media must inherit the shortcode.
    const rich = (num: string, code: string, title: string) => ({
      id: num, code, title,
      mediaList: [{ id: `${num}00`, downloadUrl: `https://scontent.cdninstagram.com/v/${code}.mp4`, mediaType: "VIDEO" }],
    });
    const page = (items: unknown[], nextCursor?: string) => ({
      data: { items, pagination: { hasNextPage: !!nextCursor, ...(nextCursor ? { nextCursor } : {}) } },
    });
    // Posts: two pages. Reels: one page that still CLAIMS more (empty page 2)
    // — deep must stop on the empty page, shallow must never follow at all.
    zylaRoutes.set(`23417:${u}`, { status: 200, body: page([rich("9003", "DCc33", "Third"), rich("9002", "DCc22", "Second")], "CUR22") });
    zylaRoutes.set(`23417:${u}:c=CUR22`, { status: 200, body: page([rich("9001", "DCc11", "First ever")]) });
    zylaRoutes.set(`23418:${u}`, { status: 200, body: page([rich("9010", "DRr11", "Only reel")], "CURXX") });
    zylaRoutes.set(`23418:${u}:c=CURXX`, { status: 200, body: page([]) });

    const before = zylaCalls;
    const det = await agent.post("/api/social/campaigns/detect")
      .send({ source: `@${u}`, sourceKind: "instagram" });
    expect(det.status).toBe(200);
    expect(det.body.count).toBe(4);
    expect(zylaCalls - before).toBe(4); // posts p1+p2, reels p1+empty p2

    const r = await agent.post("/api/social/campaigns").send({
      source: `@${u}`, sourceKind: "instagram",
      accountIds: ["acc-ig-test"], times: ["23:56"], perSlot: 1,
      startDate: todayUtc(),
      // Route enforces MAX_RANGE_DAYS — keep the horizon modest.
      endDate: new Date(Date.now() + 90 * 24 * 3600 * 1000).toISOString().slice(0, 10),
      timezone: "UTC",
      caption: "", aiCaptions: false, name: "IG deep",
    });
    expect(r.status).toBe(200);
    campaignIds.push(r.body.id);
    expect(r.body.detected).toBe(4);
    expect(zylaCalls - before).toBe(4); // created straight from the 30-min cache

    const { rows: items } = await pool!.query(
      `SELECT url, file_name FROM social_campaign_items WHERE campaign_id = $1 ORDER BY sort_order, id`,
      [r.body.id]);
    expect(items.map((i) => i.url)).toEqual([
      `ig:${u}:post:DCc11`, `ig:${u}:post:DCc22`, `ig:${u}:post:DCc33`, `ig:${u}:reel:DRr11`,
    ]);
    expect(items[0].file_name).toBe("First ever"); // title inherited from the item

    // Daily rescan is SHALLOW: page 1 of each list only, cursors ignored.
    __clearIgCacheForTests();
    const beforeRescan = zylaCalls;
    await materializeDay(r.body.id, new Date(), todayUtc());
    expect(zylaCalls - beforeRescan).toBe(2);
    await pool!.query(`DELETE FROM social_posts WHERE batch_id = $1`, [r.body.id]);

    // Publish-time resolution for a DEEP item (absent from page 1): the relay
    // must fall back to details-by-shortcode-URL — numeric ids return junk.
    const bytes = Buffer.from("DEEP-ITEM-BYTES");
    cdnFiles.set("/v/DCc11.mp4", bytes);
    zylaRoutes.set(`23420:https://www.instagram.com/p/DCc11/`, {
      status: 200, body: page([rich("9001", "DCc11", "First ever")]),
    });
    const token = createIgRelayToken({ username: u, kind: "post", mediaId: "DCc11" });
    const ok = await request(app).get(`/api/ig/relay/${token}`);
    expect(ok.status).toBe(200);
    expect(Buffer.from(ok.body).equals(bytes)).toBe(true);
  });

  it("backlog limit posts only the newest N past videos; new uploads still post", async () => {
    const u = `camplimit${uniq()}`.slice(0, 28);
    // Lists are newest-first: posts [303, 302], reels [909] → oldest-first
    // ingestion order is [302, 303, 909]. Limit 2 must hold back 302.
    zylaRoutes.set(`23417:${u}`, { status: 200, body: { data: { items: [vid("303", "Newest post"), vid("302", "Older post")] } } });
    zylaRoutes.set(`23418:${u}`, { status: 200, body: { data: { items: [vid("909", "The reel")] } } });

    const r = await agent.post("/api/social/campaigns").send({
      source: `@${u}`, sourceKind: "instagram", backlogLimit: 2,
      accountIds: ["acc-ig-test"], times: ["23:57", "23:58"], perSlot: 1,
      startDate: todayUtc(),
      endDate: new Date(Date.now() + 60 * 24 * 3600 * 1000).toISOString().slice(0, 10),
      timezone: "UTC", caption: "", aiCaptions: false, name: "IG limited",
    });
    expect(r.status).toBe(200);
    campaignIds.push(r.body.id);
    expect(r.body.detected).toBe(3);
    expect(r.body.queued).toBe(2);

    const tail = (url: string) => url.split(":").pop();
    const { rows: items } = await pool!.query(
      `SELECT url, skipped FROM social_campaign_items WHERE campaign_id = $1 ORDER BY sort_order, id`,
      [r.body.id]);
    expect(items.map((i) => [tail(i.url), i.skipped])).toEqual([
      ["302", true], ["303", false], ["909", false],
    ]);

    // Today's two slots plan ONLY the active pair — the held-back video never posts.
    await materializeDay(r.body.id, new Date(), todayUtc());
    const { rows: day1 } = await pool!.query(
      `SELECT url, post_row_id FROM social_campaign_items WHERE campaign_id = $1`, [r.body.id]);
    expect(day1.filter((x) => x.post_row_id !== null).map((x) => tail(x.url)).sort()).toEqual(["303", "909"]);
    expect(day1.find((x) => tail(x.url) === "302")!.post_row_id).toBeNull();
    await pool!.query(`DELETE FROM social_posts WHERE batch_id = $1`, [r.body.id]);

    // A new upload appears: the rescan front-inserts and posts it the next
    // day — while the held-back oldest video STAYS held even though a second
    // slot was free for it.
    __clearIgCacheForTests();
    zylaRoutes.set(`23417:${u}`, { status: 200, body: { data: { items: [vid("304", "Brand new"), vid("303"), vid("302")] } } });
    const day2 = new Date(Date.now() + 24 * 3600 * 1000);
    await materializeDay(r.body.id, day2, day2.toISOString().slice(0, 10));
    const { rows: d2 } = await pool!.query(
      `SELECT url, skipped, post_row_id FROM social_campaign_items
       WHERE campaign_id = $1 ORDER BY sort_order, id`, [r.body.id]);
    expect(d2.map((i) => tail(i.url))).toEqual(["304", "302", "303", "909"]); // 304 front-inserted
    const rec304 = d2.find((x) => tail(x.url) === "304")!;
    expect(rec304.skipped).toBe(false);
    expect(rec304.post_row_id).not.toBeNull();
    expect(d2.find((x) => tail(x.url) === "302")!.post_row_id).toBeNull();
    await pool!.query(`DELETE FROM social_posts WHERE batch_id = $1`, [r.body.id]);
  });

  it("backlog limit picks the newest N across reels AND feed posts by upload time", async () => {
    const u = `campxstream${uniq()}`.slice(0, 28);
    // Upload times interleave the two lists: the newest pair is feed 510 +
    // reel 509. Without global time ordering, a tail-of-merged-lists pick
    // would hold back the wrong videos.
    zylaRoutes.set(`23417:${u}`, { status: 200, body: { data: { items: [vid("510", "Newest feed", 5000), vid("508", "Old feed", 3000)] } } });
    zylaRoutes.set(`23418:${u}`, { status: 200, body: { data: { items: [vid("509", "Mid reel", 4000), vid("507", "Oldest reel", 2000)] } } });

    const r = await agent.post("/api/social/campaigns").send({
      source: `@${u}`, sourceKind: "instagram", backlogLimit: 2,
      accountIds: ["acc-ig-test"], times: ["23:57"], perSlot: 1,
      startDate: todayUtc(),
      endDate: new Date(Date.now() + 60 * 24 * 3600 * 1000).toISOString().slice(0, 10),
      timezone: "UTC", caption: "", aiCaptions: false, name: "IG xstream",
    });
    expect(r.status).toBe(200);
    campaignIds.push(r.body.id);
    expect(r.body.detected).toBe(4);
    expect(r.body.queued).toBe(2);

    const tail = (url: string) => url.split(":").pop();
    const { rows } = await pool!.query(
      `SELECT url, skipped FROM social_campaign_items WHERE campaign_id = $1 ORDER BY sort_order, id`,
      [r.body.id]);
    expect(rows.map((i) => [tail(i.url), i.skipped])).toEqual([
      ["507", true], ["508", true], ["509", false], ["510", false],
    ]);
  });

  it("relay streams fresh CDN bytes without auth; 403/404 on bad tokens/media", async () => {
    const u = `camprelay${uniq()}`.slice(0, 28);
    const bytes = Buffer.from("MP4-FAKE-BYTES-FOR-RELAY");
    setLists(u, [vid("70701")], []);
    cdnFiles.set("/v/70701.mp4", bytes);

    const token = createIgRelayToken({ username: u, kind: "reel", mediaId: "70701" });
    // No agent — the posting provider has no session cookie. Token IS the auth.
    const ok = await request(app).get(`/api/ig/relay/${token}`);
    expect(ok.status).toBe(200);
    expect(ok.headers["content-type"]).toContain("video/mp4");
    expect(ok.headers["content-disposition"]).toContain("attachment");
    expect(ok.headers["content-disposition"]).toContain(`instagram_${u}_70701`);
    expect(Buffer.from(ok.body).equals(bytes)).toBe(true);

    const bad = await request(app).get("/api/ig/relay/totally-bogus");
    expect(bad.status).toBe(403);

    const expired = createIgRelayToken(
      { username: u, kind: "reel", mediaId: "70701" }, Date.now() - 40 * 24 * 3600 * 1000);
    expect((await request(app).get(`/api/ig/relay/${expired}`)).status).toBe(403);

    // Media vanished: lists empty, details 404 → 404 with a clear code.
    const u2 = `camprelgone${uniq()}`.slice(0, 28);
    setLists(u2, [], []);
    zylaRoutes.set("23421:777777", { status: 404, body: { error: "not found" } });
    const gone = createIgRelayToken({ username: u2, kind: "reel", mediaId: "777777" });
    const r404 = await request(app).get(`/api/ig/relay/${gone}`);
    expect(r404.status).toBe(404);
    expect(r404.body.code).toBe("IG_MEDIA_GONE");
  });

  it("an up-to-date profile never goes 'exhausted' — it keeps watching daily", async () => {
    const u = `campalive${uniq()}`.slice(0, 28);
    const cid = crypto.randomUUID();
    campaignIds.push(cid);
    const day1 = new Date();
    const dayAfter = (n: number) => new Date(day1.getTime() + n * 24 * 3600 * 1000);
    await pool!.query(
      `INSERT INTO social_campaigns
         (id, user_id, name, source_url, account_ids, times, per_slot,
          start_date, end_date, timezone, caption, ai_captions, source_kind, enabled, status)
       VALUES ($1,$2,'IG alive',$3,'{acc-ig-test}','{23:57}',1,$4,'2099-12-31','UTC','',FALSE,'instagram',TRUE,'active')`,
      [cid, userId, `https://www.instagram.com/${u}/`, todayUtc()],
    );
    await pool!.query(
      `INSERT INTO social_campaign_items (campaign_id, url, file_name, sort_order)
       VALUES ($1,$2,'only one',0)`,
      [cid, `ig:${u}:reel:601`],
    );
    setLists(u, [vid("601")], []); // day 1: rescan sees nothing new

    // Day 1 plans the LAST known item — the campaign must stay active
    // (a folder campaign would flip to 'exhausted' here and never rescan).
    await materializeDay(cid, day1, todayUtc());
    let camp = (await pool!.query(
      `SELECT status FROM social_campaigns WHERE id = $1`, [cid])).rows[0];
    expect(camp.status).toBe("active");
    await pool!.query(`DELETE FROM social_posts WHERE batch_id = $1`, [cid]);

    // Day 2: a reel appeared overnight. Clear the 30-min list cache the way
    // real elapsed time would, then materialize "tomorrow" — the new reel
    // must be discovered and get the day's slot.
    setLists(u, [vid("602", "Overnight reel"), vid("601")], []);
    __clearIgCacheForTests();
    await materializeDay(cid, dayAfter(1), dayAfter(1).toISOString().slice(0, 10));
    const { rows: posts } = await pool!.query(
      `SELECT media_url FROM social_posts WHERE batch_id = $1`, [cid]);
    expect(posts.map((p) => p.media_url)).toEqual([`ig:${u}:reel:602`]);
    camp = (await pool!.query(
      `SELECT status FROM social_campaigns WHERE id = $1`, [cid])).rows[0];
    expect(camp.status).toBe("active"); // backlog empty again — still watching
    await pool!.query(`DELETE FROM social_posts WHERE batch_id = $1`, [cid]);

    // Day 3: nothing new — the day is consumed quietly, no posts, still active.
    __clearIgCacheForTests();
    await materializeDay(cid, dayAfter(2), dayAfter(2).toISOString().slice(0, 10));
    camp = (await pool!.query(
      `SELECT status, last_planned_date::text AS d FROM social_campaigns WHERE id = $1`, [cid])).rows[0];
    expect(camp.status).toBe("active");
    expect(camp.d).toBe(dayAfter(2).toISOString().slice(0, 10));
    const n = (await pool!.query(
      `SELECT COUNT(*)::int AS n FROM social_posts WHERE batch_id = $1`, [cid])).rows[0].n;
    expect(n).toBe(0);
  });
});
