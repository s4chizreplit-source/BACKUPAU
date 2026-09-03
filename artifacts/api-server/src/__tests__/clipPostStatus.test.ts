/**
 * Live post-status sync with Post for Me.
 *
 * Users saw "Post to social" do nothing: posts they deleted on the platform
 * left dead posted-markers behind, so every retry was skipped as "already
 * posted" — and the UI showed a fake instant "Posted!". The fix mirrors the
 * provider's real state per account:
 *   - fetchPostState      → single source of truth (gone / status / results)
 *   - getClipPostStatuses → what the UI polls; self-heals dead markers
 *   - stale-aged rows that already recorded their post id are NEVER swept
 *     (the duplicate-post race guard)
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import crypto from "crypto";
import request from "supertest";

const HAS_DB = !!process.env.DATABASE_URL;
// The PFM client refuses to run without a key; tests stub global fetch, so a
// dummy key never reaches the network. Never overwrite a real key.
if (!process.env.POSTFORME_API_KEY) process.env.POSTFORME_API_KEY = "test-key-never-used";
const {
  fetchPostState,
  getClipPostStatuses,
  _clearPostStateCache,
} = await import("../lib/postforme");
const { pool } = await import("../lib/db");
const app = (await import("../app")).default;

afterAll(async () => {
  await pool?.end();
});

// ── fetch stubbing helper ─────────────────────────────────────────────────────

/** Stub global fetch for Post for Me calls; returns a restore function. */
function stubPfmFetch(handler: (url: string) => { status: number; body: unknown } | Error) {
  _clearPostStateCache();
  const mock = vi.fn(async (input: unknown) => {
    const url = String(input);
    const r = handler(url);
    if (r instanceof Error) throw r;
    return new Response(JSON.stringify(r.body), {
      status: r.status,
      headers: { "Content-Type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", mock);
  return () => { vi.unstubAllGlobals(); _clearPostStateCache(); };
}

/** Provider post + results responses for one post id. */
const postBody = (id: string, status: string) => ({ id, status });
const resultsBody = (accountId: string, success: boolean, error?: string) => ({
  data: [{ id: `res-${accountId}`, post_id: "x", social_account_id: accountId, success, error }],
  meta: {},
});

describe("fetchPostState", () => {
  it("404 → gone; 5xx → null (ambiguous, never guesses)", async () => {
    let restore = stubPfmFetch(() => ({ status: 404, body: { message: "not found" } }));
    try {
      const st = await fetchPostState("p-404");
      expect(st?.gone).toBe(true);
    } finally { restore(); }
    restore = stubPfmFetch(() => ({ status: 503, body: { message: "down" } }));
    try { expect(await fetchPostState("p-503")).toBeNull(); } finally { restore(); }
  });

  it("fetches results only once the post reaches processing/processed", async () => {
    const calls: string[] = [];
    const restore = stubPfmFetch((url) => {
      calls.push(url);
      if (url.includes("/social-post-results")) return { status: 200, body: resultsBody("acc-1", true) };
      return { status: 200, body: postBody("p-sched", "scheduled") };
    });
    try {
      const st = await fetchPostState("p-sched");
      expect(st?.status).toBe("scheduled");
      expect(st?.results).toEqual([]);
      expect(calls.some((u) => u.includes("/social-post-results"))).toBe(false);
    } finally { restore(); }
  });
});

// ── DB-backed status + self-healing ───────────────────────────────────────────

describe.skipIf(!HAS_DB)("getClipPostStatuses (real DB)", () => {
  const userId = `usr_statustest_${crypto.randomBytes(4).toString("hex")}`;
  const clipId = (n: string) => `status-test-${n}-${userId.slice(-4)}`;
  const ACC = `pfm-acc-${userId.slice(-4)}`;

  beforeAll(async () => {
    await pool!.query(`INSERT INTO users (id, email) VALUES ($1, $2)`, [
      userId, `${userId}@it-test.clipai.dev`,
    ]);
    // Connection row so statuses carry the username
    await pool!.query(
      `INSERT INTO social_connections (user_id, pfm_account_id, platform, username) VALUES ($1, $2, 'tiktok', 'clip_tester')`,
      [userId, ACC],
    );
  });

  afterAll(async () => {
    await pool?.query(`DELETE FROM users WHERE id = $1`, [userId]); // FK cascades markers
  });

  const insertMarker = (clip: string, status: string, postId: string | null, ageMinutes = 0, account = ACC) =>
    pool!.query(
      `INSERT INTO clip_account_posts (user_id, clip_id, social_account_id, platform, status, pfm_post_id, posted_at, updated_at)
       VALUES ($1, $2, $3, 'tiktok', $4, $5,
               now() - ($6 || ' minutes')::interval, now() - ($6 || ' minutes')::interval)`,
      [userId, clip, account, status, postId, String(ageMinutes)],
    );
  const markerRows = (clip: string) =>
    pool!.query<{ social_account_id: string; status: string }>(
      `SELECT social_account_id, status FROM clip_account_posts WHERE user_id = $1 AND clip_id = $2`,
      [userId, clip],
    );

  it("fresh 'pending' (no post id) → processing; row kept; username joined", async () => {
    const c = clipId("fresh");
    await insertMarker(c, "pending", null, 1);
    const out = await getClipPostStatuses(userId, [c]);
    expect(out[c]).toEqual([{
      accountId: ACC, platform: "tiktok", username: "clip_tester", status: "processing",
    }]);
    expect((await markerRows(c)).rows.length).toBe(1);
  });

  it("stale 'pending' (crashed push) → reported deleted, row removed, re-claimable", async () => {
    const c = clipId("stale");
    await insertMarker(c, "pending", null, 20);
    const out = await getClipPostStatuses(userId, [c]);
    expect(out[c]?.[0]?.status).toBe("deleted");
    expect((await markerRows(c)).rows.length).toBe(0);
  });

  it("legacy 'posted' row without a post id → posted (kept, force-only unlock)", async () => {
    const c = clipId("legacy");
    await insertMarker(c, "posted", null, 60);
    const out = await getClipPostStatuses(userId, [c]);
    expect(out[c]?.[0]).toMatchObject({ accountId: ACC, status: "posted" });
    expect((await markerRows(c)).rows.length).toBe(1);
  });

  it("'submitted' whose account result says success → posted + row promoted", async () => {
    const c = clipId("live");
    await insertMarker(c, "submitted", "pfm-live-1", 2);
    const restore = stubPfmFetch((url) =>
      url.includes("/social-post-results")
        ? { status: 200, body: resultsBody(ACC, true) }
        : { status: 200, body: postBody("pfm-live-1", "processed") });
    try {
      const out = await getClipPostStatuses(userId, [c]);
      expect(out[c]?.[0]?.status).toBe("posted");
    } finally { restore(); }
    expect((await markerRows(c)).rows[0]?.status).toBe("posted");
  });

  it("provider post deleted → reported deleted, marker freed", async () => {
    const c = clipId("gonepost");
    await insertMarker(c, "posted", "pfm-gone-1", 2);
    const restore = stubPfmFetch(() => ({ status: 404, body: { message: "not found" } }));
    try {
      const out = await getClipPostStatuses(userId, [c]);
      expect(out[c]?.[0]?.status).toBe("deleted");
    } finally { restore(); }
    expect((await markerRows(c)).rows.length).toBe(0); // next post goes out first tap
  });

  it("account result failed → real error surfaced, marker freed for retry", async () => {
    const c = clipId("failed");
    await insertMarker(c, "submitted", "pfm-err-1", 2);
    const restore = stubPfmFetch((url) =>
      url.includes("/social-post-results")
        ? { status: 200, body: resultsBody(ACC, false, "video too long for TikTok") }
        : { status: 200, body: postBody("pfm-err-1", "processed") });
    try {
      const out = await getClipPostStatuses(userId, [c]);
      expect(out[c]?.[0]?.status).toBe("error");
      expect(out[c]?.[0]?.error).toContain("too long");
    } finally { restore(); }
    expect((await markerRows(c)).rows.length).toBe(0);
  });

  it("stored 'error' marker → surfaced once with the saved reason, then freed", async () => {
    const c = clipId("stored-err");
    await insertMarker(c, "error", "pfm-old-err", 5);
    await pool!.query(
      `UPDATE clip_account_posts SET error='Instagram rejected the aspect ratio' WHERE user_id=$1 AND clip_id=$2`,
      [userId, c],
    );
    const out = await getClipPostStatuses(userId, [c]);
    expect(out[c]?.[0]).toMatchObject({ status: "error", error: expect.stringContaining("aspect ratio") });
    expect((await markerRows(c)).rows.length).toBe(0);
    // Second poll: nothing left to report
    const again = await getClipPostStatuses(userId, [c]);
    expect(again[c]).toBeUndefined();
  });

  it("provider unreachable → last known state reported, rows untouched", async () => {
    const c = clipId("unreach");
    await insertMarker(c, "posted", "pfm-unreach-1", 2);
    const restore = stubPfmFetch(() => new TypeError("fetch failed"));
    try {
      const out = await getClipPostStatuses(userId, [c]);
      expect(out[c]?.[0]?.status).toBe("posted"); // never flips state on ambiguity
    } finally { restore(); }
    expect((await markerRows(c)).rows.length).toBe(1);
  });

  it("a stale-AGED row that already recorded its post id is NEVER swept (duplicate-post race guard)", async () => {
    const c = clipId("race");
    // The dangerous interleave: a claim sat past the stale window, but the
    // push then landed and saved the provider post id. Sweeping it would free
    // the marker while the post is live → duplicate public post.
    await insertMarker(c, "submitted", "pfm-race-1", 20);
    const restore = stubPfmFetch(() => ({ status: 200, body: postBody("pfm-race-1", "scheduled") }));
    try {
      const out = await getClipPostStatuses(userId, [c]);
      expect(out[c]?.[0]?.status).toBe("scheduled"); // held by the provider, not publishing
    } finally { restore(); }
    expect((await markerRows(c)).rows.length).toBe(1);
  });

  it("delayed post ('scheduled' at the provider) → reported scheduled, marker kept", async () => {
    const c = clipId("sched");
    await insertMarker(c, "submitted", "pfm-sched-1", 2);
    const restore = stubPfmFetch(() => ({ status: 200, body: postBody("pfm-sched-1", "scheduled") }));
    try {
      const out = await getClipPostStatuses(userId, [c]);
      expect(out[c]?.[0]?.status).toBe("scheduled");
    } finally { restore(); }
    expect((await markerRows(c)).rows.length).toBe(1); // still claimed — no duplicate tap-through
  });

  it("provider unreachable + delayed post not yet due → stays scheduled (never fake publishing)", async () => {
    const c = clipId("sched-outage");
    await insertMarker(c, "submitted", "pfm-sched-out-1", 2);
    const rowId = crypto.randomUUID();
    await pool!.query(
      `INSERT INTO social_posts (id, user_id, source, clip_id, media_url, file_name, caption, account_ids, platforms, scheduled_at, status)
       VALUES ($1,$2,'clip',$3,'clip:x','Clip','Clip',$4,$5, now() + interval '30 minutes', 'scheduled')`,
      [rowId, userId, c, [ACC], ["tiktok"]],
    );
    await pool!.query(
      `UPDATE clip_account_posts SET post_row_id=$3 WHERE user_id=$1 AND clip_id=$2`,
      [userId, c, rowId],
    );
    const restore = stubPfmFetch(() => new TypeError("fetch failed"));
    try {
      const out = await getClipPostStatuses(userId, [c]);
      expect(out[c]?.[0]?.status).toBe("scheduled"); // outage must not regress it to "processing"
    } finally { restore(); }
    expect((await markerRows(c)).rows.length).toBe(1);
  });

  it("post processed but this account's result is missing → stays processing (never fake posted)", async () => {
    // Regression (Aug 2026 live incident): the old 15-min "optimistic settle"
    // marked posts that had FAILED on every account as posted. Zero evidence
    // must never promote — no matter how old the marker is.
    const c = clipId("no-result");
    await insertMarker(c, "submitted", "pfm-nores-1", 2); // fresh
    let restore = stubPfmFetch((url) =>
      url.includes("/social-post-results")
        ? { status: 200, body: { data: [], meta: {} } }
        : { status: 200, body: postBody("pfm-nores-1", "processed") });
    try {
      const out = await getClipPostStatuses(userId, [c]);
      expect(out[c]?.[0]?.status).toBe("processing"); // results may still land
    } finally { restore(); }

    await pool!.query(
      `UPDATE clip_account_posts SET posted_at = now() - interval '20 minutes' WHERE user_id=$1 AND clip_id=$2`,
      [userId, c],
    );
    restore = stubPfmFetch((url) =>
      url.includes("/social-post-results")
        ? { status: 200, body: { data: [], meta: {} } }
        : { status: 200, body: postBody("pfm-nores-1", "processed") });
    try {
      const out = await getClipPostStatuses(userId, [c]);
      expect(out[c]?.[0]?.status).toBe("processing"); // still no evidence
    } finally { restore(); }
    // Marker untouched — a later real result decides posted vs error.
    expect((await markerRows(c)).rows[0]?.status).toBe("submitted");
  });
});

// ── Route: POST /api/social/clip-status ───────────────────────────────────────

describe.skipIf(!HAS_DB)("clip-status route", () => {
  const email = `statusprobe-${crypto.randomBytes(4).toString("hex")}@it-test.clipai.dev`;
  const agent = request.agent(app);

  beforeAll(async () => {
    const r = await agent
      .post("/api/auth/signup")
      .send({ email, password: "Test12345!x", name: "Status Probe" });
    expect([200, 201]).toContain(r.status);
  });

  afterAll(async () => {
    await pool?.query(`DELETE FROM users WHERE email = $1`, [email]);
  });

  it("requires auth", async () => {
    const r = await request(app).post("/api/social/clip-status").send({ clipIds: ["x"] });
    expect(r.status).toBe(401);
  });

  it("empty / malformed ids → empty map (never an error)", async () => {
    for (const body of [{}, { clipIds: [] }, { clipIds: "nope" }]) {
      const r = await agent.post("/api/social/clip-status").send(body);
      expect(r.status).toBe(200);
      expect(r.body.clips).toEqual({});
    }
  });

  it("ids the user never posted → empty map", async () => {
    const r = await agent.post("/api/social/clip-status").send({ clipIds: ["never-posted-1"] });
    expect(r.status).toBe(200);
    expect(r.body.clips).toEqual({});
  });
});
