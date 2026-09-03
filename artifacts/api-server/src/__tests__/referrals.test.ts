/**
 * Integration tests — referral program.
 *
 * Runs against the REAL dev database through the full express app, same
 * pattern as authBilling.test.ts. Uses its own email domain so parallel test
 * files never clean up each other's users. Skipped without DATABASE_URL.
 *
 * Flow covered:
 *   referrer signup → lazy unique code from /referral/me (stable across calls)
 *   → friend signup with ?ref code links a referrals row (bogus codes ignored)
 *   → friend's first plan purchase pays the referrer 1000 top-up credits with
 *     a ledger row → a second purchase does NOT double-pay → stats endpoint
 *     reflects joined/rewarded/creditsEarned.
 */
import { describe, it, expect, afterAll } from "vitest";
import request from "supertest";
import crypto from "crypto";

const HAS_DB = !!process.env.DATABASE_URL;

const app = (await import("../app")).default;
const { pool } = await import("../lib/db");
const billing = await import("../lib/billing");

const TEST_DOMAIN = "it-referral.clipai.dev";
const uniq = () => crypto.randomBytes(5).toString("hex");
const email = (tag: string) => `${tag}-${uniq()}@${TEST_DOMAIN}`;
const PASSWORD = "hunter2222!";

afterAll(async () => {
  if (pool) {
    await pool.query(`DELETE FROM users WHERE email LIKE $1`, [`%@${TEST_DOMAIN}`]);
    await pool.end();
  }
});

describe.skipIf(!HAS_DB)("referral program", () => {
  const referrer = request.agent(app);
  const friend = request.agent(app);
  let referrerId = "";
  let friendId = "";
  let code = "";

  it("guest gets a 401 from /referral/me", async () => {
    const r = await request(app).get("/api/referral/me");
    expect(r.status).toBe(401);
  });

  it("referrer signs up and gets a stable unique referral code", async () => {
    const r1 = await referrer.post("/api/auth/signup").send({ email: email("referrer"), password: PASSWORD });
    expect(r1.status).toBe(200);
    referrerId = r1.body.user.id;

    const me = await referrer.get("/api/referral/me");
    expect(me.status).toBe(200);
    code = me.body.code;
    expect(code).toMatch(/^[a-z0-9]{6,32}$/);
    expect(me.body.reward).toBe(billing.REFERRAL_REWARD_CREDITS);
    expect(me.body.stats).toEqual({ joined: 0, rewarded: 0, creditsEarned: 0 });

    // Second call returns the SAME code (lazy mint happens once).
    const me2 = await referrer.get("/api/referral/me");
    expect(me2.body.code).toBe(code);
  });

  it("friend signup with the ref code links a referral row", async () => {
    const r = await friend.post("/api/auth/signup").send({
      email: email("friend"),
      password: PASSWORD,
      ref: code.toUpperCase(), // case-insensitive intake
    });
    expect(r.status).toBe(200);
    friendId = r.body.user.id;

    const row = await pool!.query(
      `SELECT referrer_id, status FROM referrals WHERE referred_id = $1`,
      [friendId],
    );
    expect(row.rows[0]?.referrer_id).toBe(referrerId);
    expect(row.rows[0]?.status).toBe("signed_up");

    const u = await pool!.query(`SELECT referred_by FROM users WHERE id = $1`, [friendId]);
    expect(u.rows[0]?.referred_by).toBe(referrerId);
  });

  it("a bogus ref code never blocks the signup", async () => {
    const r = await request(app).post("/api/auth/signup").send({
      email: email("bogus"),
      password: PASSWORD,
      ref: "zzzz9999notreal",
    });
    expect(r.status).toBe(200);
    const row = await pool!.query(`SELECT 1 FROM referrals WHERE referred_id = $1`, [r.body.user.id]);
    expect(row.rowCount).toBe(0);
  });

  it("friend's first plan purchase pays the referrer exactly once", async () => {
    const before = await pool!.query(
      `SELECT topup_cutting_credits, topup_uploading_credits FROM users WHERE id = $1`,
      [referrerId],
    );

    // Same code path the admin approval and verified UPI confirmation use.
    await billing.grantSubscription(friendId, "100", "monthly", { test: true });

    const after = await pool!.query(
      `SELECT topup_cutting_credits, topup_uploading_credits FROM users WHERE id = $1`,
      [referrerId],
    );
    expect(after.rows[0].topup_cutting_credits - before.rows[0].topup_cutting_credits).toBe(billing.REFERRAL_REWARD_CREDITS);
    expect(after.rows[0].topup_uploading_credits - before.rows[0].topup_uploading_credits).toBe(billing.REFERRAL_REWARD_CREDITS);

    const ref = await pool!.query(
      `SELECT status, reward_credits, rewarded_at FROM referrals WHERE referred_id = $1`,
      [friendId],
    );
    expect(ref.rows[0].status).toBe("rewarded");
    expect(ref.rows[0].reward_credits).toBe(billing.REFERRAL_REWARD_CREDITS);
    expect(ref.rows[0].rewarded_at).not.toBeNull();

    const led = await pool!.query(
      `SELECT delta, bucket FROM credit_ledger WHERE user_id = $1 AND reason = 'referral_reward' ORDER BY bucket`,
      [referrerId],
    );
    expect(led.rows).toEqual([
      { delta: billing.REFERRAL_REWARD_CREDITS, bucket: "topup_cutting" },
      { delta: billing.REFERRAL_REWARD_CREDITS, bucket: "topup_uploading" },
    ]);

    // A second purchase (upgrade/renewal) must NOT pay again.
    await billing.grantSubscription(friendId, "250", "monthly", { test: true });
    const after2 = await pool!.query(
      `SELECT topup_cutting_credits, topup_uploading_credits FROM users WHERE id = $1`,
      [referrerId],
    );
    expect(after2.rows[0]).toEqual(after.rows[0]);
    const led2 = await pool!.query(
      `SELECT 1 FROM credit_ledger WHERE user_id = $1 AND reason = 'referral_reward'`,
      [referrerId],
    );
    expect(led2.rowCount).toBe(2);
  });

  it("stats endpoint reflects the conversion", async () => {
    const me = await referrer.get("/api/referral/me");
    expect(me.status).toBe(200);
    expect(me.body.stats).toEqual({
      joined: 1,
      rewarded: 1,
      creditsEarned: billing.REFERRAL_REWARD_CREDITS,
    });
  });
});
