import { describe, it, expect, afterAll } from "vitest";
import request from "supertest";
import crypto from "crypto";

const HAS_DB = !!process.env.DATABASE_URL;
const app = (await import("../app")).default;
const { pool } = await import("../lib/db");
const billing = await import("../lib/billing");
const domain = "it-dual-billing.clipai.dev";
const email = () => `billing-${crypto.randomBytes(6).toString("hex")}@${domain}`;
const password = "hunter2222!";

afterAll(async () => {
  if (pool) {
    await pool.query(`DELETE FROM users WHERE email LIKE $1`, [`%@${domain}`]);
    await pool.end();
  }
});

describe.skipIf(!HAS_DB)("dual INR accounts and billing", () => {
  const agent = request.agent(app);
  let userId = "";

  const signup = async () => {
    const res = await agent.post("/api/auth/signup").send({ email: email(), password, name: "Dual Test" });
    expect(res.status).toBe(200);
    userId = res.body.user.id;
    return res.body.user;
  };

  it("catalog exposes exactly the three INR plans and no USD/Whop purchase data", async () => {
    const r = await request(app).get("/api/billing/catalog");
    expect(r.status).toBe(200);
    expect(r.body.plans.map((p: { id: string }) => p.id)).toEqual(["30", "100", "250"]);
    expect(r.body.plans.map((p: { priceMonthlyInr: number; priceYearlyInr: number }) => [p.priceMonthlyInr, p.priceYearlyInr]))
      .toEqual([[199, 1999], [499, 4999], [899, 9999]]);
    expect(JSON.stringify(r.body)).not.toMatch(/whop|usd/i);
  });

  it("signup grants exactly three cutting and three uploading trial credits", async () => {
    const u = await signup();
    expect(u.credits).toMatchObject({
      cutting: { subscription: 0, topup: 3, legacy: 0, total: 3 },
      uploading: { subscription: 0, topup: 3, legacy: 0, total: 3 },
    });
  });

  it("subscription requests accept all INR plan IDs and both intervals", async () => {
    for (const [plan, interval] of [["30", "monthly"], ["100", "yearly"], ["250", "monthly"]] as const) {
      const r = await agent.post("/api/billing/subscribe").send({ plan, interval });
      expect(r.status).toBe(200);
      expect(r.body.request.plan).toBe(plan);
      expect(r.body.request.plan_interval).toBe(interval);
    }
    const bad = await agent.post("/api/billing/subscribe").send({ plan: "starter", interval: "monthly" });
    expect(bad.status).toBe(400);
    const oldTopup = await agent.post("/api/billing/topup").send({ packId: "boost2500" });
    expect(oldTopup.status).toBe(410);
  });

  it("expiry retains balances but freezes them; renewal unlocks and adds its allowance", async () => {
    await billing.grantSubscription(userId, "30", "monthly", { test: true });
    let me = await agent.get("/api/auth/me");
    expect(me.body.user.credits.cutting).toMatchObject({ subscription: 30, topup: 3, total: 33 });
    expect(me.body.user.credits.uploading).toMatchObject({ subscription: 30, topup: 3, total: 33 });

    await pool!.query(`UPDATE users SET paid_until=NOW()-INTERVAL '1 day' WHERE id=$1`, [userId]);
    const expired = await billing.refreshPlanState(userId);
    expect(expired?.plan_status).toBe("expired");
    expect(expired?.subscription_cutting_credits).toBe(30);
    expect(expired?.subscription_uploading_credits).toBe(30);
    const frozen = await billing.reserveCredits(userId, 1);
    expect(frozen).toMatchObject({ ok: false, available: 0 });

    await billing.grantSubscription(userId, "100", "monthly", { test: "renew" });
    const unlocked = await billing.reserveCredits(userId, 1);
    expect(unlocked).toMatchObject({ ok: true });
    me = await agent.get("/api/auth/me");
    expect(me.body.user.plan).toBe("100");
    // Old retained 30 + newly granted 100, less one just spent.
    expect(me.body.user.credits.cutting.subscription).toBe(129);
  });

  it("reactivated shared legacy value can fund both cutting and uploading", async () => {
    await pool!.query(
      `UPDATE users SET plan='30', plan_status='active', paid_until=NOW() + INTERVAL '1 day',
       free_trial=FALSE, subscription_cutting_credits=0, subscription_uploading_credits=0,
       topup_cutting_credits=0, topup_uploading_credits=0, legacy_topup_credits=2
       WHERE id=$1`,
      [userId],
    );
    const cutting = await billing.reserveCredits(userId, 1, { test: "legacy-cutting" });
    expect(cutting).toMatchObject({ ok: true, fromLegacy: 1 });
    const uploading = await billing.withTx(pool!, client =>
      billing.reserveUploadingCreditsTx(client, userId, 1, "post_reserve", { test: "legacy-uploading" }),
    );
    expect(uploading).toMatchObject({ ok: true, fromLegacy: 1 });
  });
});