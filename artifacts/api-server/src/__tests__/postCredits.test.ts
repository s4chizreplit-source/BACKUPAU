import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "crypto";
import { needsPostCharge, chargePostRow, sweepPostCreditRefunds } from "../lib/postCredits";
import { CREDITS_PER_POST } from "../lib/billing";
import { pool } from "../lib/db";

const HAS_DB = !!process.env.DATABASE_URL;
const domain = "post-dual.clipai.dev";
const id = `post-${crypto.randomBytes(6).toString("hex")}`;
const email = `${id}@${domain}`;
const row = `row-${crypto.randomBytes(6).toString("hex")}`;

describe("dual uploading charge decisions", () => {
  it("charges every provider handoff, including generated clips", () => {
    expect(needsPostCharge({ id: "a", user_id: "u", source: "clip", clip_id: "clip1", media_url: "https://x" })).toBe(true);
    expect(needsPostCharge({ id: "b", user_id: "u", source: "campaign", clip_id: null, media_url: "clip:clip1" })).toBe(true);
    expect(needsPostCharge({ id: "c", user_id: "u", source: "schedule", clip_id: null, media_url: "https://x", credit_uploading_spent: 1 } as never)).toBe(true);
    expect(needsPostCharge({ id: "d", user_id: "u", source: "clip", clip_id: "clip1", media_url: "https://x", credit_topup_spent: 1 })).toBe(false);
  });
});

describe.skipIf(!HAS_DB)("dual uploading reservations", () => {
  beforeAll(async () => {
    await pool!.query(`ALTER TABLE social_posts ADD COLUMN IF NOT EXISTS credit_legacy_spent INT NOT NULL DEFAULT 0`);
    await pool!.query(
      `INSERT INTO users (id,email,plan_status,subscription_uploading_credits)
       VALUES ($1,$2,'active',2)`, [id, email],
    );
    await pool!.query(
      `INSERT INTO social_posts (id,user_id,source,clip_id,media_url,file_name,status)
       VALUES ($1,$2,'clip','generated-clip','https://cdn.test/clip.mp4','clip.mp4','creating')`, [row, id],
    );
  });
  afterAll(async () => {
    if (pool) { await pool.query(`DELETE FROM users WHERE email LIKE $1`, [`%@${domain}`]); await pool.end(); }
  });

  it("generated clips charge exactly one uploading credit, never cutting credit", async () => {
    expect(await chargePostRow(pool!, { id: row, user_id: id, source: "clip", clip_id: "generated-clip", media_url: "https://cdn.test/clip.mp4" }))
      .toEqual({ ok: true });
    const user = await pool!.query(`SELECT subscription_cutting_credits,subscription_uploading_credits FROM users WHERE id=$1`, [id]);
    expect(user.rows[0]).toEqual({ subscription_cutting_credits: 0, subscription_uploading_credits: 1 });
    const marker = await pool!.query(`SELECT credit_sub_spent,credit_topup_spent,credit_legacy_spent FROM social_posts WHERE id=$1`, [row]);
    expect(marker.rows[0]).toEqual({ credit_sub_spent: 1, credit_topup_spent: 0, credit_legacy_spent: 0 });
  });

  it("does not double charge and refunds uploading bucket after terminal failure", async () => {
    expect(await chargePostRow(pool!, { id: row, user_id: id, source: "clip", clip_id: "generated-clip", media_url: "https://cdn.test/clip.mp4" }))
      .toEqual({ lostRace: true });
    await pool!.query(`UPDATE social_posts SET status='failed',pfm_post_id='known' WHERE id=$1`, [row]);
    await sweepPostCreditRefunds(pool!);
    const user = await pool!.query(`SELECT subscription_uploading_credits FROM users WHERE id=$1`, [id]);
    expect(user.rows[0].subscription_uploading_credits).toBe(2);
    const ledger = await pool!.query(`SELECT delta,bucket FROM credit_ledger WHERE user_id=$1 ORDER BY id`, [id]);
    expect(ledger.rows).toEqual([
      { delta: -CREDITS_PER_POST, bucket: "subscription_uploading" },
      { delta: CREDITS_PER_POST, bucket: "subscription_uploading" },
    ]);
  });
});