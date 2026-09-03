/**
 * Post for Me webhook endpoint + event processing, and route-level ownership.
 *
 *  - Deliveries are verified against the shared secret stored when the
 *    webhook was registered; anything else is a 401 (never processed).
 *  - Event processing is idempotent: PFM retries ~8 times over 24h, so a
 *    result event applied twice must land in the same final state, and a
 *    'success=false' retry must never demote an already-posted marker.
 *  - POST /api/social/posts rejects account ids that don't belong to the
 *    session user (403) — frontend input is never trusted.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "crypto";
import request from "supertest";

const HAS_DB = !!process.env.DATABASE_URL;
if (!process.env.POSTFORME_API_KEY) process.env.POSTFORME_API_KEY = "test-key-never-used";
const { processWebhookEvent, _clearWebhookSecretsCache } = await import("../lib/postforme");
const { pool } = await import("../lib/db");
const app = (await import("../app")).default;

const SECRET = `whsec-test-${crypto.randomBytes(8).toString("hex")}`;
const HOOK_URL = `https://test.invalid/hooks/${crypto.randomBytes(4).toString("hex")}`;

afterAll(async () => {
  await pool?.end();
});

describe.skipIf(!HAS_DB)("webhook secret verification", () => {
  beforeAll(async () => {
    await pool!.query(
      `INSERT INTO pfm_webhooks (url, webhook_id, secret) VALUES ($1, 'wh-test', $2)
       ON CONFLICT (url) DO UPDATE SET secret = $2`,
      [HOOK_URL, SECRET],
    );
    _clearWebhookSecretsCache();
  });

  afterAll(async () => {
    await pool?.query(`DELETE FROM pfm_webhooks WHERE url = $1`, [HOOK_URL]);
    _clearWebhookSecretsCache();
  });

  it("missing secret header → 401", async () => {
    const r = await request(app)
      .post("/api/webhooks/postforme")
      .send({ type: "social.post.updated", data: { id: "p1", status: "processed" } });
    expect(r.status).toBe(401);
  });

  it("wrong secret → 401", async () => {
    const r = await request(app)
      .post("/api/webhooks/postforme")
      .set("Post-For-Me-Webhook-Secret", "whsec-wrong")
      .send({ type: "social.post.updated", data: { id: "p1", status: "processed" } });
    expect(r.status).toBe(401);
  });

  it("correct secret → immediate 200 ack", async () => {
    const r = await request(app)
      .post("/api/webhooks/postforme")
      .set("Post-For-Me-Webhook-Secret", SECRET)
      .send({ type: "social.post.updated", data: { id: "p-nonexistent", status: "processed" } });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
  });
});

describe.skipIf(!HAS_DB)("webhook event processing (idempotent)", () => {
  const userId = `usr_whtest_${crypto.randomBytes(4).toString("hex")}`;
  const ACC = `pfm-acc-wh-${userId.slice(-4)}`;
  const POST_ID = `pfm-post-wh-${userId.slice(-4)}`;
  const clipId = `wh-clip-${userId.slice(-4)}`;

  beforeAll(async () => {
    // Test databases are long-lived and can predate this schema self-heal.
    await pool!.query(
      `ALTER TABLE clip_account_posts
         ADD COLUMN IF NOT EXISTS retry_at TIMESTAMPTZ,
         ADD COLUMN IF NOT EXISTS retry_count INT NOT NULL DEFAULT 0`,
    );
    await pool!.query(`INSERT INTO users (id, email) VALUES ($1, $2)`, [
      userId, `${userId}@it-test.clipai.dev`,
    ]);
    await pool!.query(
      `INSERT INTO clip_account_posts (user_id, clip_id, social_account_id, platform, status, pfm_post_id)
       VALUES ($1, $2, $3, 'tiktok', 'submitted', $4)`,
      [userId, clipId, ACC, POST_ID],
    );
  });

  afterAll(async () => {
    await pool?.query(`DELETE FROM users WHERE id = $1`, [userId]); // cascades markers
  });

  const marker = async () =>
    (await pool!.query<{ status: string; error: string | null; retry_at: string | null; retry_count: number }>(
      `SELECT status, error, retry_at, retry_count FROM clip_account_posts WHERE user_id=$1 AND clip_id=$2`,
      [userId, clipId],
    )).rows[0];

  it("result success promotes the marker; replaying the delivery is a no-op", async () => {
    const evt = {
      type: "social.post.result.created",
      data: { post_id: POST_ID, social_account_id: ACC, success: true },
    };
    await processWebhookEvent(evt);
    expect((await marker()).status).toBe("posted");
    await processWebhookEvent(evt); // PFM retry
    expect((await marker()).status).toBe("posted");
  });

  it("a late 'success=false' retry never demotes an already-posted marker", async () => {
    await processWebhookEvent({
      type: "social.post.result.created",
      data: { post_id: POST_ID, social_account_id: ACC, success: false, error: "late duplicate delivery" },
    });
    expect((await marker()).status).toBe("posted");
  });

  it("result failure on an in-flight marker records the platform's error", async () => {
    await pool!.query(
      `UPDATE clip_account_posts SET status='submitted', error=NULL WHERE user_id=$1 AND clip_id=$2`,
      [userId, clipId],
    );
    await processWebhookEvent({
      type: "social.post.result.created",
      data: { post_id: POST_ID, social_account_id: ACC, success: false, error: "TikTok rejected the video" },
    });
    const m = await marker();
    expect(m.status).toBe("error");
    expect(m.error).toContain("TikTok rejected");
  });

  it("queues a bounded delayed retry for a YouTube upload-session 429", async () => {
    await pool!.query(
      `UPDATE clip_account_posts
       SET platform='youtube', status='submitted', error=NULL, retry_at=NULL, retry_count=0
       WHERE user_id=$1 AND clip_id=$2`,
      [userId, clipId],
    );
    await processWebhookEvent({
      type: "social.post.result.created",
      data: {
        post_id: POST_ID,
        social_account_id: ACC,
        success: false,
        error: "Failed to start YouTube resumable upload session: 429 Too Many Requests",
      },
    });
    const m = await marker();
    expect(m.status).toBe("retry_wait");
    expect(m.retry_at).toBeTruthy();
    expect(m.retry_count).toBe(1);
  });

  it("stops queueing after the two allowed YouTube 429 retries", async () => {
    // Simulate each prior delayed retry reaching PFM and receiving the same
    // explicit failed result. The marker is intentionally reused, so its
    // retry_count cannot reset between attempts.
    for (const expectedCount of [2, 2]) {
      await pool!.query(
        `UPDATE clip_account_posts
         SET status='submitted', retry_at=NULL
         WHERE user_id=$1 AND clip_id=$2`,
        [userId, clipId],
      );
      await processWebhookEvent({
        type: "social.post.result.created",
        data: {
          post_id: POST_ID,
          social_account_id: ACC,
          success: false,
          error: "Failed to start YouTube resumable upload session: 429 Too Many Requests",
        },
      });
      const m = await marker();
      expect(m.retry_count).toBe(expectedCount);
      if (expectedCount === 2 && m.status === "retry_wait") {
        // First loop: the second allowed retry is queued. The next loop must
        // reach the terminal error branch because retry_count stays at two.
        continue;
      }
      expect(m.status).toBe("error");
    }
    const terminal = await marker();
    expect(terminal.status).toBe("error");
    expect(terminal.retry_count).toBe(2);
  });

  it("post.deleted frees non-posted markers so a repost works first tap", async () => {
    await processWebhookEvent({ type: "social.post.deleted", data: { id: POST_ID, status: "deleted" } });
    expect(await marker()).toBeUndefined();
  });
});

// ── Route-level ownership: never post to someone else's account ──────────────

describe.skipIf(!HAS_DB)("POST /api/social/posts ownership", () => {
  const email = `ownprobe-${crypto.randomBytes(4).toString("hex")}@it-test.clipai.dev`;
  const agent = request.agent(app);

  beforeAll(async () => {
    const r = await agent
      .post("/api/auth/signup")
      .send({ email, password: "Test12345!x", name: "Ownership Probe" });
    expect([200, 201]).toContain(r.status);
  });

  afterAll(async () => {
    await pool?.query(`DELETE FROM users WHERE email = $1`, [email]);
  });

  it("requires auth", async () => {
    const r = await request(app).post("/api/social/posts").send({ clipId: "x", accountIds: ["a"] });
    expect(r.status).toBe(401);
  });

  it("foreign / unknown account ids → 403, nothing posted", async () => {
    const r = await agent
      .post("/api/social/posts")
      .send({ clipId: "some-clip", accountIds: ["someone-elses-account-id"] });
    expect(r.status).toBe(403);
  });
});
