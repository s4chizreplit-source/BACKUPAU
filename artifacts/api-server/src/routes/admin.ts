/**
 * Admin panel API — manual control over every account while there is no
 * payment gateway. All routes require an admin session.
 *
 *   GET  /admin/stats
 *   GET  /admin/users?q=&limit=&offset=
 *   GET  /admin/users/:id                → user + recent ledger + requests
 *   POST /admin/users/:id/credits        { delta, note? }
 *   POST /admin/users/:id/plan           { action: "activate"|"remove", plan?, interval? }
 *   POST /admin/users/:id/role           { role: "user"|"admin" }
 *   POST /admin/users/:id/status         { status: "active"|"disabled" }
 *   POST /admin/users/:id/password       { password }
 *   GET  /admin/requests?status=pending
 *   POST /admin/requests/:id/approve     { note? }
 *   POST /admin/requests/:id/reject      { note? }
 */
import { Router, type IRouter } from "express";
import bcrypt from "bcryptjs";
import { pool } from "../lib/db";
import {
  PLANS,
  adminAdjustCredits,
  grantSubscription,
  grantSubscriptionTx,
  grantTopupTx,
  removePlan,
  toPublicUser,
  type DbUser,
  type PlanInterval,
} from "../lib/billing";
import { requireAdmin } from "../middlewares/sessionAuth";
import { toPublicUpiOrder, type UpiOrderRow } from "../lib/zapupi";
import { logger } from "../lib/logger";

const router: IRouter = Router();

router.use("/admin", requireAdmin);

function dbDown(res: { status: (n: number) => { json: (b: unknown) => void } }): void {
  res.status(503).json({ error: "Database is not configured." });
}

// ── GET /admin/stats ─────────────────────────────────────────────────────────
router.get("/admin/stats", async (_req, res): Promise<void> => {
  if (!pool) { dbDown(res); return; }
  const [users, activeSubs, pending, used] = await Promise.all([
    pool.query(`SELECT COUNT(*)::int AS n FROM users`),
    pool.query(`SELECT COUNT(*)::int AS n FROM users WHERE plan_status = 'active'`),
    pool.query(`SELECT COUNT(*)::int AS n FROM billing_requests WHERE status = 'pending'`),
    pool.query(
      `SELECT COALESCE(SUM(-delta), 0)::int AS n FROM credit_ledger
       WHERE reason IN ('clip_reserve', 'clip_refund') AND created_at > NOW() - INTERVAL '30 days'`,
    ),
  ]);
  res.json({
    users: users.rows[0].n,
    activeSubscriptions: activeSubs.rows[0].n,
    pendingRequests: pending.rows[0].n,
    creditsUsed30d: used.rows[0].n,
  });
});

// ── GET /admin/users ─────────────────────────────────────────────────────────
router.get("/admin/users", async (req, res): Promise<void> => {
  if (!pool) { dbDown(res); return; }
  const q = String(req.query.q ?? "").trim();
  const limit = Math.min(Math.max(1, Number(req.query.limit) || 50), 200);
  const offset = Math.max(0, Number(req.query.offset) || 0);
  const params: unknown[] = [];
  let where = "";
  if (q) {
    params.push(`%${q}%`);
    where = `WHERE email ILIKE $1 OR COALESCE(name,'') ILIKE $1`;
  }
  params.push(limit, offset);
  const { rows } = await pool.query<DbUser & { total: number }>(
    `SELECT *, COUNT(*) OVER()::int AS total FROM users ${where}
     ORDER BY created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  res.json({
    total: rows[0]?.total ?? 0,
    users: rows.map((r) => toPublicUser(r)),
  });
});

// ── GET /admin/users/:id ─────────────────────────────────────────────────────
router.get("/admin/users/:id", async (req, res): Promise<void> => {
  if (!pool) { dbDown(res); return; }
  const { rows } = await pool.query<DbUser>(`SELECT * FROM users WHERE id = $1`, [req.params.id]);
  const user = rows[0];
  if (!user) { res.status(404).json({ error: "User not found." }); return; }
  const [ledger, requests] = await Promise.all([
    pool.query(
      `SELECT id, delta, bucket, reason, meta, created_at FROM credit_ledger
       WHERE user_id = $1 ORDER BY created_at DESC, id DESC LIMIT 30`,
      [user.id],
    ),
    pool.query(
      `SELECT * FROM billing_requests WHERE user_id = $1 ORDER BY created_at DESC LIMIT 15`,
      [user.id],
    ),
  ]);
  res.json({ user: toPublicUser(user), ledger: ledger.rows, requests: requests.rows });
});

// ── POST /admin/users/:id/credits ────────────────────────────────────────────
router.post("/admin/users/:id/credits", async (req, res): Promise<void> => {
  if (!pool) { dbDown(res); return; }
  const delta = Number((req.body ?? {}).delta);
  const note = String((req.body ?? {}).note ?? "").slice(0, 300) || undefined;
  if (!Number.isInteger(delta) || delta === 0 || Math.abs(delta) > 100_000) {
    res.status(400).json({ error: "delta must be a non-zero whole number." });
    return;
  }
  try {
    const user = await adminAdjustCredits(req.params.id, delta, {
      adminId: req.currentUser!.id,
      note,
    });
    res.json({ user: toPublicUser(user) });
  } catch (err) {
    const msg = (err as Error).message;
    if (msg.includes("insufficient")) {
      res.status(400).json({ error: "User doesn't have that many credits to remove." });
      return;
    }
    if (msg.includes("not found")) { res.status(404).json({ error: "User not found." }); return; }
    logger.error({ err }, "admin credits adjust failed");
    res.status(500).json({ error: "Could not adjust credits." });
  }
});

// ── POST /admin/users/:id/plan ───────────────────────────────────────────────
router.post("/admin/users/:id/plan", async (req, res): Promise<void> => {
  if (!pool) { dbDown(res); return; }
  const { action, plan, interval } = (req.body ?? {}) as {
    action?: string; plan?: string; interval?: string;
  };
  try {
    if (action === "activate") {
      const planDef = plan === "30" || plan === "100" || plan === "250" ? PLANS[plan] : null;
      const cleanInterval: PlanInterval | null =
        interval === "monthly" || interval === "yearly" ? interval : null;
      if (!planDef || !cleanInterval) {
        res.status(400).json({ error: "Pick a valid plan and interval." });
        return;
      }
      const user = await grantSubscription(req.params.id, planDef.id, cleanInterval, {
        adminId: req.currentUser!.id,
        manual: true,
      });
      res.json({ user: toPublicUser(user) });
      return;
    }
    if (action === "remove") {
      const user = await removePlan(req.params.id, { adminId: req.currentUser!.id });
      if (!user) { res.status(404).json({ error: "User not found." }); return; }
      res.json({ user: toPublicUser(user) });
      return;
    }
    res.status(400).json({ error: "action must be 'activate' or 'remove'." });
  } catch (err) {
    if ((err as Error).message.includes("not found")) {
      res.status(404).json({ error: "User not found." });
      return;
    }
    logger.error({ err }, "admin plan change failed");
    res.status(500).json({ error: "Could not change the plan." });
  }
});

// ── POST /admin/users/:id/role ───────────────────────────────────────────────
router.post("/admin/users/:id/role", async (req, res): Promise<void> => {
  if (!pool) { dbDown(res); return; }
  const role = (req.body ?? {}).role;
  if (role !== "user" && role !== "admin") {
    res.status(400).json({ error: "role must be 'user' or 'admin'." });
    return;
  }
  if (req.params.id === req.currentUser!.id && role !== "admin") {
    res.status(400).json({ error: "You can't remove your own admin access." });
    return;
  }
  const { rows } = await pool.query<DbUser>(
    `UPDATE users SET role = $2 WHERE id = $1 RETURNING *`,
    [req.params.id, role],
  );
  if (!rows[0]) { res.status(404).json({ error: "User not found." }); return; }
  res.json({ user: toPublicUser(rows[0]) });
});

// ── POST /admin/users/:id/status ─────────────────────────────────────────────
router.post("/admin/users/:id/status", async (req, res): Promise<void> => {
  if (!pool) { dbDown(res); return; }
  const status = (req.body ?? {}).status;
  if (status !== "active" && status !== "disabled") {
    res.status(400).json({ error: "status must be 'active' or 'disabled'." });
    return;
  }
  if (req.params.id === req.currentUser!.id && status === "disabled") {
    res.status(400).json({ error: "You can't disable your own account." });
    return;
  }
  const { rows } = await pool.query<DbUser>(
    `UPDATE users SET status = $2 WHERE id = $1 RETURNING *`,
    [req.params.id, status],
  );
  if (!rows[0]) { res.status(404).json({ error: "User not found." }); return; }
  // Disabled users lose their sessions on the next request (requireUser checks status).
  res.json({ user: toPublicUser(rows[0]) });
});

// ── POST /admin/users/:id/password ───────────────────────────────────────────
router.post("/admin/users/:id/password", async (req, res): Promise<void> => {
  if (!pool) { dbDown(res); return; }
  const password = (req.body ?? {}).password;
  if (typeof password !== "string" || password.length < 8 || password.length > 200) {
    res.status(400).json({ error: "Password must be at least 8 characters." });
    return;
  }
  const hash = await bcrypt.hash(password, 10);
  const { rowCount } = await pool.query(
    `UPDATE users SET password_hash = $2 WHERE id = $1`,
    [req.params.id, hash],
  );
  if (!rowCount) { res.status(404).json({ error: "User not found." }); return; }
  res.json({ ok: true });
});

// ── GET /admin/requests ──────────────────────────────────────────────────────
router.get("/admin/requests", async (req, res): Promise<void> => {
  if (!pool) { dbDown(res); return; }
  const status = String(req.query.status ?? "pending");
  const allowed = ["pending", "approved", "rejected", "cancelled", "all"];
  if (!allowed.includes(status)) { res.status(400).json({ error: "Bad status filter." }); return; }
  const where = status === "all" ? "" : `WHERE r.status = $1`;
  const params = status === "all" ? [] : [status];
  const { rows } = await pool.query(
    `SELECT r.*, u.email AS user_email, u.name AS user_name
     FROM billing_requests r JOIN users u ON u.id = r.user_id
     ${where} ORDER BY r.created_at DESC LIMIT 100`,
    params,
  );
  res.json({ requests: rows });
});

// ── GET /admin/upi-orders ────────────────────────────────────────────────────
// Instant UPI payments (ZapUPI) — read-only audit list with payer + UTR.
// "review" rows are the ones needing human eyes (amount mismatch / test env).
router.get("/admin/upi-orders", async (_req, res): Promise<void> => {
  if (!pool) { dbDown(res); return; }
  const { rows } = await pool.query<UpiOrderRow & { user_email: string; user_name: string | null }>(
    `SELECT o.*, u.email AS user_email, u.name AS user_name
     FROM upi_orders o JOIN users u ON u.id = o.user_id
     ORDER BY o.created_at DESC LIMIT 100`,
  );
  res.json({
    orders: rows.map((r) => ({
      ...toPublicUpiOrder(r),
      user_email: r.user_email,
      user_name: r.user_name,
    })),
  });
});

// ── POST /admin/requests/:id/approve ─────────────────────────────────────────
router.post("/admin/requests/:id/approve", async (req, res): Promise<void> => {
  if (!pool) { dbDown(res); return; }
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) { res.status(400).json({ error: "Bad request id." }); return; }
  const note = String((req.body ?? {}).note ?? "").slice(0, 300) || null;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `SELECT * FROM billing_requests WHERE id = $1 FOR UPDATE`,
      [id],
    );
    const request = rows[0];
    if (!request) {
      await client.query("ROLLBACK");
      res.status(404).json({ error: "Request not found." });
      return;
    }
    if (request.status !== "pending") {
      await client.query("ROLLBACK");
      res.status(409).json({ error: `Request is already ${request.status}.` });
      return;
    }
    if (request.kind === "subscribe") {
      await grantSubscriptionTx(client, request.user_id, request.plan, request.plan_interval, {
        requestId: id,
        adminId: req.currentUser!.id,
      });
    } else {
      await grantTopupTx(client, request.user_id, request.credits, "topup", {
        requestId: id,
        packId: request.pack_id,
        adminId: req.currentUser!.id,
      });
    }
    await client.query(
      `UPDATE billing_requests SET status = 'approved', admin_note = $2, decided_by = $3, decided_at = NOW()
       WHERE id = $1`,
      [id, note, req.currentUser!.id],
    );
    await client.query("COMMIT");
    res.json({ ok: true });
  } catch (err) {
    try { await client.query("ROLLBACK"); } catch { /* ignore */ }
    logger.error({ err }, "request approve failed");
    res.status(500).json({ error: "Could not approve the request." });
  } finally {
    client.release();
  }
});

// ── POST /admin/requests/:id/reject ──────────────────────────────────────────
router.post("/admin/requests/:id/reject", async (req, res): Promise<void> => {
  if (!pool) { dbDown(res); return; }
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) { res.status(400).json({ error: "Bad request id." }); return; }
  const note = String((req.body ?? {}).note ?? "").slice(0, 300) || null;
  const { rowCount } = await pool.query(
    `UPDATE billing_requests SET status = 'rejected', admin_note = $2, decided_by = $3, decided_at = NOW()
     WHERE id = $1 AND status = 'pending'`,
    [id, note, req.currentUser!.id],
  );
  if (!rowCount) { res.status(404).json({ error: "No pending request with that id." }); return; }
  res.json({ ok: true });
});

export default router;
