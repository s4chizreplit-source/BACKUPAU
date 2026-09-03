/**
 * Billing routes (user-facing).
 *
 *   GET  /billing/catalog              → plans + top-up packs (public)
 *   POST /billing/subscribe            → request a plan (manual activation for now)
 *   POST /billing/topup                → request a credit pack
 *   GET  /billing/requests             → my requests
 *   POST /billing/requests/:id/cancel  → cancel my pending request
 *   GET  /billing/ledger               → my recent credit activity
 *
 * No payment gateway yet: requests sit in `billing_requests` until an admin
 * approves them in the admin panel. Stripe checkout will replace the request
 * step later and call the same grant functions.
 */
import { Router, type IRouter } from "express";
import { pool } from "../lib/db";
import {
  PLANS,
  SIGNUP_BONUS_CREDITS,
  CREDITS_PER_CLIP,
  CREDITS_PER_POST,
} from "../lib/billing";
import { requireUser } from "../middlewares/sessionAuth";
import { isZapupiConfigured } from "../lib/zapupi";
import { logger } from "../lib/logger";

const router: IRouter = Router();

// ── GET /billing/catalog ─────────────────────────────────────────────────────
router.get("/billing/catalog", (_req, res): void => {
  res.json({
    plans: Object.values(PLANS).map((p) => ({
      id: p.id,
      name: p.name,
      tagline: p.tagline,
      monthlyCredits: p.monthlyCredits,
      priceMonthlyInr: p.priceMonthly,
      priceYearlyInr: p.priceYearly,
      cuttingCredits: p.monthlyCredits,
      uploadingCredits: p.monthlyCredits,
    })),
    packs: [],
    signupBonus: SIGNUP_BONUS_CREDITS,
    creditsPerClip: CREDITS_PER_CLIP,
    creditsPerPost: CREDITS_PER_POST,
    // Instant UPI payments (India) — present only when the gateway is configured.
    upi: isZapupiConfigured()
      ? { available: true, cuttingRateInr: 6, uploadingRateInr: 3 }
      : null,
  });
});

// ── POST /billing/subscribe ──────────────────────────────────────────────────
router.post("/billing/subscribe", requireUser, async (req, res): Promise<void> => {
  if (!pool) { res.status(503).json({ error: "Billing unavailable." }); return; }
  const { plan, interval } = (req.body ?? {}) as { plan?: string; interval?: string };
  const planDef = (plan === "30" || plan === "100" || plan === "250") ? PLANS[plan] : null;
  const cleanInterval =
    interval === "monthly" || interval === "yearly" ? interval : null;
  if (!planDef || !cleanInterval) {
    res.status(400).json({ error: "Pick a valid plan and billing interval." });
    return;
  }
  const userId = req.currentUser!.id;
  try {
    // One live subscribe request at a time — replace any older pending one
    await pool.query(
      `UPDATE billing_requests SET status = 'cancelled', decided_at = NOW()
       WHERE user_id = $1 AND kind = 'subscribe' AND status = 'pending'`,
      [userId],
    );
    const { rows } = await pool.query(
      `INSERT INTO billing_requests (user_id, kind, plan, plan_interval, credits, amount_usd)
       VALUES ($1, 'subscribe', $2, $3, $4, $5) RETURNING *`,
       [userId, planDef.id, cleanInterval, planDef.monthlyCredits, cleanInterval === "yearly" ? planDef.priceYearly : planDef.priceMonthly],
    );
    res.json({ request: rows[0] });
  } catch (err) {
    logger.error({ err }, "subscribe request failed");
    res.status(500).json({ error: "Could not submit the request. Please try again." });
  }
});

// ── POST /billing/topup ──────────────────────────────────────────────────────
router.post("/billing/topup", requireUser, async (req, res): Promise<void> => {
  if (!pool) { res.status(503).json({ error: "Billing unavailable." }); return; }
  res.status(410).json({ error: "Use UPI top-ups." });
});

// ── GET /billing/requests ────────────────────────────────────────────────────
router.get("/billing/requests", requireUser, async (req, res): Promise<void> => {
  if (!pool) { res.json({ requests: [] }); return; }
  const { rows } = await pool.query(
    `SELECT * FROM billing_requests WHERE user_id = $1 ORDER BY created_at DESC LIMIT 20`,
    [req.currentUser!.id],
  );
  res.json({ requests: rows });
});

// ── POST /billing/requests/:id/cancel ────────────────────────────────────────
router.post("/billing/requests/:id/cancel", requireUser, async (req, res): Promise<void> => {
  if (!pool) { res.status(503).json({ error: "Billing unavailable." }); return; }
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) { res.status(400).json({ error: "Bad request id." }); return; }
  const { rowCount } = await pool.query(
    `UPDATE billing_requests SET status = 'cancelled', decided_at = NOW()
     WHERE id = $1 AND user_id = $2 AND status = 'pending'`,
    [id, req.currentUser!.id],
  );
  if (!rowCount) { res.status(404).json({ error: "No pending request found." }); return; }
  res.json({ ok: true });
});

// ── GET /billing/ledger ──────────────────────────────────────────────────────
router.get("/billing/ledger", requireUser, async (req, res): Promise<void> => {
  if (!pool) { res.json({ entries: [] }); return; }
  const { rows } = await pool.query(
    `SELECT id, delta, bucket, reason, meta, created_at FROM credit_ledger
     WHERE user_id = $1 ORDER BY created_at DESC, id DESC LIMIT 50`,
    [req.currentUser!.id],
  );
  res.json({ entries: rows });
});

export default router;
