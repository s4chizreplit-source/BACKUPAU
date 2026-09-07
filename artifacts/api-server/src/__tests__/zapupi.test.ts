import { describe, it, expect, afterAll, afterEach } from "vitest";
import request from "supertest";
import crypto from "crypto";

const HAS_DB = !!process.env.DATABASE_URL;
process.env.ZAPUPI_ZAP_KEY = "test-zap-key-never-real";
const app = (await import("../app")).default;
const { pool } = await import("../lib/db");
const zapupi = await import("../lib/zapupi");
const domain = "upi-dual.clipai.dev";
const email = () => `upi-${crypto.randomBytes(6).toString("hex")}@${domain}`;

function mock(
  status: () => Record<string, unknown> = () => ({ status: "Pending" }),
  onCreate?: (fields: Record<string, string>) => void,
) {
  zapupi.__setZapupiFetchForTests(async (url, init) => {
    const fields = JSON.parse(String(init?.body ?? "{}")) as Record<string, string>;
    if (String(url).includes("create-order")) {
      onCreate?.(fields);
      return new Response(JSON.stringify({ status: "success", payment_url: `https://pay.test/${fields.order_id}` }));
    }
    return new Response(JSON.stringify(status()));
  });
}
async function signup(agent: ReturnType<typeof request.agent>) {
  const r = await agent.post("/api/auth/signup").send({ email: email(), password: "hunter2222!" });
  expect(r.status).toBe(200); return r.body.user;
}
afterEach(() => zapupi.__setZapupiFetchForTests(null));
afterAll(async () => { if (pool) { await pool.query(`DELETE FROM users WHERE email LIKE $1`, [`%@${domain}`]); await pool.end(); } });

describe.skipIf(!HAS_DB)("ZapUPI INR plans and topups", () => {
  it("sends ZapUPI success, failure and timeout callbacks to the production return page", async () => {
    const agent = request.agent(app); await signup(agent);
    let createFields: Record<string, string> = {};
    const previous = process.env.PUBLIC_APP_URL;
    process.env.PUBLIC_APP_URL = "https://autocliper.com";
    try {
      mock(undefined, (fields) => { createFields = fields; });
      const r = await agent.post("/api/pay/upi/order").send({ kind: "plan", plan: "30", interval: "monthly" });
      expect(r.status).toBe(200);
      expect(createFields.success_url).toBe("https://autocliper.com/pay/upi/return");
      expect(createFields.failed_url).toBe("https://autocliper.com/pay/upi/return");
      expect(createFields.timeout_url).toBe("https://autocliper.com/pay/upi/return");
      expect(createFields.redirect_url).toBeUndefined();
    } finally {
      if (previous == null) delete process.env.PUBLIC_APP_URL;
      else process.env.PUBLIC_APP_URL = previous;
    }
  });

  it("creates monthly/yearly plan orders at exact INR amounts", async () => {
    const agent = request.agent(app); await signup(agent); mock();
    for (const [plan, interval, amount] of [["30", "monthly", 199], ["100", "yearly", 4999], ["250", "monthly", 899]] as const) {
      const r = await agent.post("/api/pay/upi/order").send({ kind: "plan", plan, interval });
      expect(r.status).toBe(200); expect(r.body.amountInr).toBe(amount);
    }
  });

  it("grants a verified cutting topup once and validates quantity", async () => {
    const agent = request.agent(app); const user = await signup(agent);
    mock(() => ({ status: "Success", amount: "42", environment: "cashier", txn_id: "c", utr: "u" }));
    const r = await agent.post("/api/pay/upi/order").send({ kind: "topup", creditType: "cutting", quantity: 7 });
    expect(r.status).toBe(200); expect(r.body.amountInr).toBe(42);
    await request(app).post("/api/pay/zapupi/webhook").send({ order_id: r.body.orderId });
    await request(app).post("/api/pay/zapupi/webhook").send({ order_id: r.body.orderId });
    const me = await agent.get("/api/auth/me");
    expect(me.body.user.credits.cutting.topup).toBe(10); // signup 3 + paid 7
    expect(me.body.user.credits.uploading.topup).toBe(3);
    const grants = await pool!.query(`SELECT count(*)::int n FROM credit_ledger WHERE user_id=$1 AND reason='zapupi_topup'`, [user.id]);
    expect(grants.rows[0].n).toBe(1);
    for (const quantity of [0, -1, 1.2, "2"]) {
      const bad = await agent.post("/api/pay/upi/order").send({ kind: "topup", creditType: "cutting", quantity });
      expect(bad.status).toBe(400);
    }
  });

  it("auto-activates plans and topups with ZapUPI's one-paise adjustment, including old reviews", async () => {
    const agent = request.agent(app); const user = await signup(agent);

    mock(() => ({ status: "Success", amount: "199.01", environment: "cashier", txn_id: "plan-txn", utr: "plan-utr" }));
    const plan = await agent.post("/api/pay/upi/order").send({ kind: "plan", plan: "30", interval: "monthly" });
    // Simulate an order quarantined by the older exact-amount verifier.
    await pool!.query(
      `UPDATE upi_orders SET status='review', fail_reason='Paid amount ₹199.01 does not match plan price ₹199'
       WHERE order_id=$1`,
      [plan.body.orderId],
    );
    expect(await zapupi.reconcileRetryableZapupiReviews()).toBeGreaterThanOrEqual(1);
    const recovered = await agent.get(`/api/pay/upi/order/${plan.body.orderId}`);
    expect(recovered.body.order.status).toBe("paid");
    let me = await agent.get("/api/auth/me");
    expect(me.body.user).toMatchObject({
      plan: "30",
      planStatus: "active",
      credits: {
        cutting: { subscription: 30 },
        uploading: { subscription: 30 },
      },
    });

    mock(() => ({ status: "Success", amount: "6.01", environment: "cashier", txn_id: "topup-txn", utr: "topup-utr" }));
    const topup = await agent.post("/api/pay/upi/order").send({ kind: "topup", creditType: "uploading", quantity: 2 });
    await request(app).post("/api/pay/zapupi/webhook").send({ order_id: topup.body.orderId });
    await request(app).post("/api/pay/zapupi/webhook").send({ order_id: topup.body.orderId });
    me = await agent.get("/api/auth/me");
    expect(me.body.user.credits.uploading.topup).toBe(5);
    const grants = await pool!.query(
      `SELECT count(*)::int n FROM credit_ledger WHERE user_id=$1 AND reason='zapupi_topup' AND meta->>'orderId'=$2`,
      [user.id, topup.body.orderId],
    );
    expect(grants.rows[0].n).toBe(1);
  });

  it("grants uploading topups at ₹3 each and quarantines amount mismatch", async () => {
    const agent = request.agent(app); await signup(agent);
    mock(() => ({ status: "Success", amount: "12", environment: "cashier" }));
    const good = await agent.post("/api/pay/upi/order").send({ kind: "topup", creditType: "uploading", quantity: 4 });
    expect(good.body.amountInr).toBe(12);
    await request(app).post("/api/pay/zapupi/webhook").send({ order_id: good.body.orderId });
    await request(app).post("/api/pay/zapupi/webhook").send({ order_id: good.body.orderId });
    let me = await agent.get("/api/auth/me"); expect(me.body.user.credits.uploading.topup).toBe(7);
    mock(() => ({ status: "Success", amount: "1", environment: "cashier" }));
    const bad = await agent.post("/api/pay/upi/order").send({ kind: "plan", plan: "100", interval: "monthly" });
    await request(app).post("/api/pay/zapupi/webhook").send({ order_id: bad.body.orderId });
    const row = await pool!.query(`SELECT status FROM upi_orders WHERE order_id=$1`, [bad.body.orderId]);
    expect(row.rows[0].status).toBe("review");

    mock(() => ({ status: "Success", amount: "198.99", environment: "cashier" }));
    const fractionalUnderpay = await agent.post("/api/pay/upi/order").send({ kind: "plan", plan: "30", interval: "monthly" });
    await request(app).post("/api/pay/zapupi/webhook").send({ order_id: fractionalUnderpay.body.orderId });
    const fractionalRow = await pool!.query(`SELECT status FROM upi_orders WHERE order_id=$1`, [fractionalUnderpay.body.orderId]);
    expect(fractionalRow.rows[0].status).toBe("review");
  });

  it("preserves failed, test-environment, poll and create-rejection protections", async () => {
    const agent = request.agent(app); await signup(agent);
    mock(() => ({ status: "Failed" }));
    let r = await agent.post("/api/pay/upi/order").send({ kind: "plan", plan: "30", interval: "monthly" });
    await request(app).post("/api/pay/zapupi/webhook").send({ order_id: r.body.orderId });
    expect((await pool!.query(`SELECT status FROM upi_orders WHERE order_id=$1`, [r.body.orderId])).rows[0].status).toBe("failed");
    mock(() => ({ status: "Success", amount: "199", environment: "test" }));
    r = await agent.post("/api/pay/upi/order").send({ kind: "plan", plan: "30", interval: "monthly" });
    const old = process.env.NODE_ENV; process.env.NODE_ENV = "production";
    await zapupi.confirmZapupiOrder(r.body.orderId); process.env.NODE_ENV = old;
    expect((await pool!.query(`SELECT status FROM upi_orders WHERE order_id=$1`, [r.body.orderId])).rows[0].status).toBe("review");
    // Return-page polling uses the same confirmation core when a webhook is lost.
    mock(() => ({ status: "Success", amount: "899", environment: "cashier" }));
    r = await agent.post("/api/pay/upi/order").send({ kind: "plan", plan: "250", interval: "monthly" });
    const poll = await agent.get(`/api/pay/upi/order/${r.body.orderId}`);
    expect(poll.body.order.status).toBe("paid");
    zapupi.__setZapupiFetchForTests(async () => new Response(JSON.stringify({ status: "error", message: "no" })));
    expect((await agent.post("/api/pay/upi/order").send({ kind: "plan", plan: "30", interval: "monthly" })).status).toBe(502);
  });
});