/**
 * ZapUPI — Indian UPI payment gateway (GPay / PhonePe / Paytm / BHIM).
 *
 * Flow:
 *   1. POST /pay/upi/order (logged in)   → createZapupiOrder() → payment_url,
 *      browser redirects there in the SAME tab.
 *   2. User pays in any UPI app. ZapUPI then (a) POSTs our webhook and
 *      (b) redirects the buyer back to /pay/upi/return?order_id=…
 *   3. BOTH paths funnel into confirmZapupiOrder(orderId) — the single,
 *      idempotent, row-locked confirm core.
 *
 * Security model (their webhook has NO signature):
 *   • The webhook body is UNTRUSTED — we only take the order_id from it.
 *   • Before granting anything we call their order-status API server-side
 *     with our key, and require: status Success + amount matches the plan
 *     price + not a "test" environment event in production.
 *   • Grant happens inside a SELECT … FOR UPDATE transaction on the order
 *     row, transitioning pending → paid exactly once. Duplicate webhooks and
 *     webhook/return-page races can never double-grant.
 *   • Amount mismatches are marked status "review" for an admin — never granted.
 *
 * The ZapUPI key comes from the ZAPUPI_ZAP_KEY secret. It is never logged.
 */
import crypto from "crypto";
import https from "node:https";
import { pool } from "./db";
import { grantSubscriptionTx, grantTopupTx, PLANS, type PlanId, type PlanInterval } from "./billing";
import { logger } from "./logger";

// Fixed UPI prices in INR, as chosen by the founder (monthly plans only in v1).
export const UPI_PLAN_PRICES_INR: Record<PlanId, Record<PlanInterval, number>> = {
  "30": { monthly: 199, yearly: 1999 },
  "100": { monthly: 499, yearly: 4999 },
  "250": { monthly: 899, yearly: 9999 },
};
export const UPI_TOPUP_PRICES_INR = { cutting: 6, uploading: 3 } as const;

const CREATE_ORDER_URL = "https://pay.zapupi.com/api/create-order";
const ORDER_STATUS_URL = "https://pay.zapupi.com/api/order-status";
const HTTP_TIMEOUT_MS = 15_000;
// ZapUPI appends one paise to successful collections as a transaction
// adjustment. Accept only that observed upward adjustment; underpayments and
// larger mismatches still require review.
const MAX_GATEWAY_ADJUSTMENT_PAISE = 1;

export function isZapupiConfigured(): boolean {
  return !!(process.env.ZAPUPI_ZAP_KEY ?? "").trim();
}

function zapKey(): string {
  const k = (process.env.ZAPUPI_ZAP_KEY ?? "").trim();
  if (!k) throw new Error("ZAPUPI_ZAP_KEY is not configured");
  return k;
}

/** Our order ids: acl_<24 hex>. Tight shape so the public webhook can reject junk early. */
export const UPI_ORDER_ID_RE = /^acl_[a-f0-9]{24}$/;

export function newUpiOrderId(): string {
  return `acl_${crypto.randomBytes(12).toString("hex")}`;
}

/** Where ZapUPI should send the buyer + webhook. Prod URL first, dev domain for testing. */
export function appBaseUrl(): string {
  const configured = (process.env.PUBLIC_APP_URL ?? "").trim().replace(/\/$/, "");
  if (configured) return configured;
  if (process.env.NODE_ENV === "production") return "https://autocliper.pro";
  const dev = (process.env.REPLIT_DEV_DOMAIN ?? "").trim();
  if (dev) return `https://${dev}`;
  return "http://localhost:5000";
}

// ── HTTP (mockable in tests — never hit the real gateway from the suite) ─────

type FetchLike = typeof fetch;
let zapupiFetchForTests: FetchLike | null = null;

/** Test hook: replace the HTTP layer. Pass null to restore the real IPv4 HTTPS transport. */
export function __setZapupiFetchForTests(f: FetchLike | null): void {
  zapupiFetchForTests = f;
}

interface HttpReply {
  ok: boolean;
  status: number;
  text: string;
}

/**
 * Node's built-in fetch/Undici can still race AAAA connections after
 * setDefaultResultOrder("ipv4first"). ZapUPI currently has a working IPv4
 * endpoint while the production VM has no usable IPv6 route, so force the
 * socket family for this gateway instead of merely reordering DNS results.
 */
function postJsonIpv4(url: string, body: string): Promise<HttpReply> {
  return new Promise((resolve, reject) => {
    const endpoint = new URL(url);
    const req = https.request({
      protocol: endpoint.protocol,
      hostname: endpoint.hostname,
      port: endpoint.port || 443,
      path: `${endpoint.pathname}${endpoint.search}`,
      method: "POST",
      family: 4,
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > 1_000_000) {
          req.destroy(new Error("ZapUPI response exceeded 1 MB"));
          return;
        }
        chunks.push(chunk);
      });
      res.on("end", () => {
        const status = res.statusCode ?? 0;
        resolve({
          ok: status >= 200 && status < 300,
          status,
          text: Buffer.concat(chunks).toString("utf8"),
        });
      });
    });
    req.setTimeout(HTTP_TIMEOUT_MS, () => {
      const timeout = new Error(`ZapUPI connection timed out after ${HTTP_TIMEOUT_MS} ms`) as Error & { code?: string };
      timeout.code = "ETIMEDOUT";
      req.destroy(timeout);
    });
    req.on("error", reject);
    req.end(body);
  });
}

function safeNetworkErrorDetails(error: unknown): string {
  const details: string[] = [];
  const seen = new Set<unknown>();
  const visit = (value: unknown): void => {
    if (!value || seen.has(value) || details.length >= 8) return;
    seen.add(value);
    if (value instanceof Error) {
      const coded = value as Error & { code?: unknown; cause?: unknown; errors?: unknown[] };
      details.push([coded.name, typeof coded.code === "string" ? coded.code : "", coded.message].filter(Boolean).join(":"));
      visit(coded.cause);
      if (Array.isArray(coded.errors)) coded.errors.forEach(visit);
    }
  };
  visit(error);
  return details.join(" | ").slice(0, 1_000);
}

// NOTE: despite their docs showing form-encoded examples, the LIVE API only
// accepts a JSON body ("Invalid JSON format" otherwise) — verified against
// the real gateway. The key travels as the `zap_key` JSON field.
async function postJson(url: string, fields: Record<string, string>): Promise<Record<string, unknown>> {
  const body = JSON.stringify(fields);
  let reply: HttpReply;
  if (zapupiFetchForTests) {
    const res = await zapupiFetchForTests(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    reply = { ok: res.ok, status: res.status, text: await res.text() };
  } else {
    reply = await postJsonIpv4(url, body);
  }
  let json: Record<string, unknown> = {};
  try { json = JSON.parse(reply.text) as Record<string, unknown>; } catch { /* non-JSON reply */ }
  if (!reply.ok) {
    // Their error bodies look like {"status":"error","message":"Invalid Zap Key"}.
    // Surfacing the message is safe — our key never appears in responses.
    const hint = typeof json.message === "string" ? ` — ${json.message}` : "";
    throw new Error(`ZapUPI HTTP ${reply.status}${hint}`);
  }
  return json;
}

// ── DB row shape ─────────────────────────────────────────────────────────────

export interface UpiOrderRow {
  order_id: string;
  user_id: string;
  plan: PlanId | "";
  plan_interval: PlanInterval;
  kind: "subscription" | "topup";
  topup_cutting: number;
  topup_uploading: number;
  amount_inr: number;
  status: "pending" | "paid" | "failed" | "review";
  payment_url: string | null;
  txn_id: string | null;
  utr: string | null;
  provider_env: string | null;
  fail_reason: string | null;
  paid_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export function toPublicUpiOrder(row: UpiOrderRow): Record<string, unknown> {
  return {
    orderId: row.order_id,
    plan: row.plan,
    planInterval: row.plan_interval,
    amountInr: row.amount_inr,
    status: row.status,
    paymentUrl: row.status === "pending" ? row.payment_url : null,
    utr: row.utr,
    txnId: row.txn_id,
    failReason: row.fail_reason,
    createdAt: new Date(row.created_at).toISOString(),
    paidAt: row.paid_at ? new Date(row.paid_at).toISOString() : null,
    verificationRetryable: isRetryableZapupiReview(row),
  };
}

export function isRetryableZapupiReview(row: Pick<UpiOrderRow, "status" | "fail_reason">): boolean {
  // Only rows written by the older exact-match verifier are retried. If the
  // new verifier still finds a mismatch it writes "Payment amount…", making
  // that review terminal instead of polling forever.
  return row.status === "review" && /^Paid amount ₹.+ does not match plan price ₹/.test(row.fail_reason ?? "");
}

// ── Create order ─────────────────────────────────────────────────────────────

export async function createZapupiOrder(opts: {
  userId: string;
  plan?: PlanId;
  interval?: PlanInterval;
  topupCutting?: number;
  topupUploading?: number;
}): Promise<{ orderId: string; paymentUrl: string; amountInr: number }> {
  if (!pool) throw new Error("DATABASE_URL is not configured");
  const interval = opts.interval ?? "monthly";
  const isTopup = opts.topupCutting != null || opts.topupUploading != null;
  const cutting = opts.topupCutting ?? 0, uploading = opts.topupUploading ?? 0;
  if (isTopup && (!Number.isInteger(cutting) || !Number.isInteger(uploading) || cutting < 0 || uploading < 0 || cutting + uploading <= 0)) throw new Error("Top-up quantities must be positive integers.");
  if (!isTopup && (!opts.plan || !PLANS[opts.plan])) throw new Error("Invalid plan.");
  const amountInr = isTopup ? cutting * UPI_TOPUP_PRICES_INR.cutting + uploading * UPI_TOPUP_PRICES_INR.uploading : UPI_PLAN_PRICES_INR[opts.plan!][interval];
  const orderId = newUpiOrderId();

  await pool.query(
    `INSERT INTO upi_orders (order_id,user_id,plan,plan_interval,kind,topup_cutting,topup_uploading,amount_inr)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [orderId, opts.userId, opts.plan ?? "", interval, isTopup ? "topup" : "subscription", cutting, uploading, amountInr],
  );

  const base = appBaseUrl();
  let json: Record<string, unknown>;
  try {
    json = await postJson(CREATE_ORDER_URL, {
      zap_key: zapKey(),
      order_id: orderId,
      amount: String(amountInr),
      remark: `${isTopup ? `topup:${cutting}/${uploading}` : opts.plan}|${opts.userId}`,
      webhook_url: `${base}/api/pay/zapupi/webhook`,
      // ZapUPI appends ?order_id=...&utr=... to each callback URL. Keep these
      // query-free; the return page also recovers the id from localStorage if
      // the provider ever omits it.
      success_url: `${base}/pay/upi/return`,
      failed_url: `${base}/pay/upi/return`,
      timeout_url: `${base}/pay/upi/return`,
    });
  } catch (err) {
    await pool.query(
      `UPDATE upi_orders SET status = 'failed', fail_reason = 'Could not reach the payment gateway', updated_at = NOW()
       WHERE order_id = $1 AND status = 'pending'`,
      [orderId],
    );
    logger.error({ errorDetails: safeNetworkErrorDetails(err), orderId }, "zapupi create-order failed");
    throw new Error("Could not start the UPI payment — please try again in a moment.");
  }

  const paymentUrl =
    (typeof json.payment_url === "string" && json.payment_url) ||
    (typeof (json.data as Record<string, unknown> | undefined)?.payment_url === "string" &&
      ((json.data as Record<string, unknown>).payment_url as string)) ||
    "";
  const status = String(json.status ?? "").toLowerCase();

  if (!paymentUrl || (status && status !== "success" && status !== "ok")) {
    const reason = String(json.message ?? json.msg ?? "gateway rejected the order").slice(0, 200);
    await pool.query(
      `UPDATE upi_orders SET status = 'failed', fail_reason = $2, updated_at = NOW()
       WHERE order_id = $1 AND status = 'pending'`,
      [orderId, reason],
    );
    logger.error({ orderId, status, reason }, "zapupi create-order rejected");
    throw new Error("The payment gateway rejected the order — please try again.");
  }

  await pool.query(
    `UPDATE upi_orders SET payment_url = $2, updated_at = NOW() WHERE order_id = $1`,
    [orderId, paymentUrl],
  );
  return { orderId, paymentUrl, amountInr };
}

// ── Provider status ──────────────────────────────────────────────────────────

interface ProviderStatus {
  status: "success" | "failed" | "pending" | "unknown";
  amount: number | null;
  amountPaise: number | null;
  txnId: string | null;
  utr: string | null;
  environment: string | null;
}

function parsePaise(value: unknown): number | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const text = String(value).trim();
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(text);
  if (!match) return null;
  const rupees = Number(match[1]);
  const paise = Number((match[2] ?? "").padEnd(2, "0"));
  const total = rupees * 100 + paise;
  return Number.isSafeInteger(total) ? total : null;
}

export async function getZapupiOrderStatus(orderId: string): Promise<ProviderStatus> {
  const json = await postJson(ORDER_STATUS_URL, { zap_key: zapKey(), order_id: orderId });
  const data = (json.data as Record<string, unknown> | undefined) ?? json;
  const raw = String(data.status ?? json.status ?? "").toLowerCase();
  const status: ProviderStatus["status"] =
    raw === "success" ? "success" : raw === "failed" ? "failed" : raw ? "pending" : "unknown";
  const amountRaw = data.pay_amount ?? data.amount ?? null;
  const amount = amountRaw == null ? null : Number(amountRaw);
  return {
    status,
    amount: Number.isFinite(amount as number) ? (amount as number) : null,
    amountPaise: parsePaise(amountRaw),
    txnId: data.txn_id != null ? String(data.txn_id) : null,
    utr: data.utr != null ? String(data.utr) : null,
    environment: data.environment != null ? String(data.environment).toLowerCase() : null,
  };
}

// ── Confirm core (idempotent, race-safe) ─────────────────────────────────────

export type ConfirmResult =
  | { state: "unknown" }
  | { state: "pending" }
  | { state: "paid"; alreadyPaid: boolean }
  | { state: "failed"; reason: string | null }
  | { state: "review"; reason: string | null };

/**
 * Check with ZapUPI and, if genuinely paid, activate the plan — exactly once.
 * Safe to call from the webhook, the return-page poll, or both at once.
 */
export async function confirmZapupiOrder(orderId: string): Promise<ConfirmResult> {
  if (!pool) return { state: "unknown" };

  // Cheap peek — terminal rows never need another provider call.
  const peek = await pool.query<UpiOrderRow>(
    `SELECT * FROM upi_orders WHERE order_id = $1`,
    [orderId],
  );
  const existing = peek.rows[0];
  if (!existing) return { state: "unknown" };
  if (existing.status === "paid") return { state: "paid", alreadyPaid: true };
  if (existing.status === "failed") return { state: "failed", reason: existing.fail_reason };
  if (existing.status === "review" && !isRetryableZapupiReview(existing)) {
    return { state: "review", reason: existing.fail_reason };
  }

  // Ask the gateway BEFORE taking the row lock (HTTP can be slow).
  const st = await getZapupiOrderStatus(orderId);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<UpiOrderRow>(
      `SELECT * FROM upi_orders WHERE order_id = $1 FOR UPDATE`,
      [orderId],
    );
    const row = rows[0];
    if (!row) { await client.query("ROLLBACK"); return { state: "unknown" }; }
    if (row.status === "paid") { await client.query("COMMIT"); return { state: "paid", alreadyPaid: true }; }
    if (row.status === "failed") { await client.query("COMMIT"); return { state: "failed", reason: row.fail_reason }; }
    if (row.status === "review" && !isRetryableZapupiReview(row)) {
      await client.query("COMMIT");
      return { state: "review", reason: row.fail_reason };
    }

    if (st.status === "success") {
      const isProd = process.env.NODE_ENV === "production";
      if (isProd && st.environment === "test") {
        const reason = "Test-environment payment event received in production";
        await client.query(
          `UPDATE upi_orders SET status = 'review', fail_reason = $2, provider_env = $3, updated_at = NOW()
           WHERE order_id = $1`,
          [orderId, reason, st.environment],
        );
        await client.query("COMMIT");
        logger.warn({ orderId }, "zapupi test-env event blocked in production");
        return { state: "review", reason };
      }
      const expectedPaise = Number(row.amount_inr) * 100;
      const amountMatches = st.amountPaise != null &&
        st.amountPaise >= expectedPaise &&
        st.amountPaise <= expectedPaise + MAX_GATEWAY_ADJUSTMENT_PAISE;
      if (!amountMatches) {
        const reason = `Payment amount ₹${st.amount ?? "?"} does not match order amount ₹${row.amount_inr}`;
        await client.query(
          `UPDATE upi_orders SET status = 'review', fail_reason = $2, txn_id = $3, utr = $4, provider_env = $5, updated_at = NOW()
           WHERE order_id = $1`,
          [orderId, reason, st.txnId, st.utr, st.environment],
        );
        await client.query("COMMIT");
        logger.warn({ orderId, paid: st.amount, expected: row.amount_inr }, "zapupi amount mismatch → review");
        return { state: "review", reason };
      }

      // Genuine, verified payment — activate the plan (same grant path as admin approval).
       if (row.kind === "topup") {
         if (row.topup_cutting > 0) await grantTopupTx(client, row.user_id, row.topup_cutting, "zapupi_topup", { via: "zapupi", orderId, amountInr: row.amount_inr }, "cutting");
         if (row.topup_uploading > 0) await grantTopupTx(client, row.user_id, row.topup_uploading, "zapupi_topup", { via: "zapupi", orderId, amountInr: row.amount_inr }, "uploading");
       } else {
         await grantSubscriptionTx(client, row.user_id, row.plan as PlanId, row.plan_interval, {
           via: "zapupi", orderId, txnId: st.txnId, utr: st.utr, amountInr: row.amount_inr,
         });
       }
      await client.query(
        `UPDATE upi_orders SET status = 'paid', txn_id = $2, utr = $3, provider_env = $4, paid_at = NOW(), updated_at = NOW()
         WHERE order_id = $1`,
        [orderId, st.txnId, st.utr, st.environment],
      );
      await client.query("COMMIT");
      logger.info(
        { orderId, userId: row.user_id, plan: row.plan, amountInr: row.amount_inr },
        "zapupi payment confirmed — plan activated",
      );
      return { state: "paid", alreadyPaid: false };
    }

    if (st.status === "failed") {
      const reason = "Payment failed or was cancelled in the UPI app";
      await client.query(
        `UPDATE upi_orders SET status = 'failed', fail_reason = $2, updated_at = NOW() WHERE order_id = $1`,
        [orderId, reason],
      );
      await client.query("COMMIT");
      return { state: "failed", reason };
    }

    // Still pending at the gateway.
    await client.query("COMMIT");
    return { state: "pending" };
  } catch (err) {
    try { await client.query("ROLLBACK"); } catch { /* ignore */ }
    throw err;
  } finally {
    client.release();
  }
}

/**
 * One-time compatibility sweep for successful payments quarantined by the old
 * exact-amount verifier before ZapUPI's one-paise adjustment was understood.
 * Safe on every boot: terminal paid rows disappear from this query, and grants
 * remain protected by the same row lock and idempotent status transition.
 */
export async function reconcileRetryableZapupiReviews(limit = 50): Promise<number> {
  if (!pool || !isZapupiConfigured()) return 0;
  const { rows } = await pool.query<{ order_id: string }>(
    `SELECT order_id FROM upi_orders
     WHERE status='review' AND fail_reason LIKE 'Paid amount ₹% does not match plan price ₹%'
     ORDER BY updated_at DESC LIMIT $1`,
    [limit],
  );
  let recovered = 0;
  for (const row of rows) {
    try {
      const result = await confirmZapupiOrder(row.order_id);
      if (result.state === "paid") recovered += 1;
    } catch (err) {
      logger.warn({ orderId: row.order_id, errorDetails: safeNetworkErrorDetails(err) }, "zapupi review reconciliation failed");
    }
  }
  return recovered;
}

/** Sanity: plan ids we sell over UPI. */
export function isUpiPlan(plan: string): plan is PlanId {
  return (plan === "30" || plan === "100" || plan === "250") && !!PLANS[plan];
}
