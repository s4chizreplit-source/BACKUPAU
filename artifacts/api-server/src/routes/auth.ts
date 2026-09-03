/**
 * Account routes — email + password auth with server-side sessions.
 *
 *   POST /auth/signup   { email, password, name? }
 *   POST /auth/login    { email, password }
 *   POST /auth/logout
 *   GET  /auth/me       → { user | null }
 */
import { Router, type IRouter, type Request } from "express";
import rateLimit from "express-rate-limit";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import { pool } from "../lib/db";
import {
  SIGNUP_BONUS_CREDITS,
  grantDualTopup,
  refreshPlanState,
  toPublicUser,
  type DbUser,
} from "../lib/billing";
import { isBootstrapAdminEmail, SESSION_COOKIE_NAME } from "../middlewares/sessionAuth";
import { logger } from "../lib/logger";

const router: IRouter = Router();

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many attempts — please wait a few minutes and try again." },
});

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function noDb(res: { status: (n: number) => { json: (b: unknown) => void } }): void {
  res.status(503).json({ error: "Accounts are not available — database is not configured." });
}

function regenerateSession(req: Request): Promise<void> {
  return new Promise((resolve, reject) => {
    req.session.regenerate((err) => (err ? reject(err) : resolve()));
  });
}

function saveSession(req: Request): Promise<void> {
  return new Promise((resolve, reject) => {
    req.session.save((err) => (err ? reject(err) : resolve()));
  });
}

/** Generate a 6-digit numeric OTP and send it to the user's email. */
async function sendVerificationCode(userId: string, email: string): Promise<void> {
  if (!pool) return;
  const code = String(Math.floor(100000 + Math.random() * 900000));
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 min
  // Invalidate any previous unused tokens for this user
  await pool.query(`UPDATE email_verif_tokens SET used = TRUE WHERE user_id = $1 AND used = FALSE`, [userId]);
  await pool.query(
    `INSERT INTO email_verif_tokens (user_id, code, expires_at) VALUES ($1, $2, $3)`,
    [userId, code, expiresAt],
  );
  const { sendEmail } = await import("../lib/mailer");
  await sendEmail({
    to: email,
    subject: `${code} — Your AutoCliper verification code`,
    html: `<div style="font-family:sans-serif;max-width:480px;margin:auto">
      <h2 style="color:#D1FE17;margin-bottom:8px">Verify your email</h2>
      <p style="color:#ccc">Enter this code on AutoCliper to activate your account:</p>
      <div style="font-size:40px;font-weight:900;letter-spacing:8px;color:#fff;margin:24px 0">${code}</div>
      <p style="color:#888;font-size:13px">This code expires in 15 minutes. If you didn't sign up, ignore this email.</p>
    </div>`,
    text: `Your AutoCliper verification code: ${code}\n\nExpires in 15 minutes.`,
  });
}

// ── POST /auth/signup ────────────────────────────────────────────────────────
router.post("/auth/signup", authLimiter, async (req, res): Promise<void> => {
  if (!pool) { noDb(res); return; }
  const { email, password, name, ref } = (req.body ?? {}) as {
    email?: string; password?: string; name?: string; ref?: string;
  };
  const cleanEmail = (email ?? "").trim().toLowerCase();
  if (!EMAIL_RE.test(cleanEmail) || cleanEmail.length > 254) {
    res.status(400).json({ error: "Please enter a valid email address." });
    return;
  }
  if (!password || password.length < 8 || password.length > 200) {
    res.status(400).json({ error: "Password must be at least 8 characters." });
    return;
  }
  const cleanName = (name ?? "").trim().slice(0, 80) || null;

  try {
    const existing = await pool.query(`SELECT 1 FROM users WHERE lower(email) = $1`, [cleanEmail]);
    if (existing.rowCount) {
      res.status(409).json({ error: "An account with this email already exists — try logging in." });
      return;
    }
    const id = `usr_${crypto.randomBytes(9).toString("base64url")}`;
    const hash = await bcrypt.hash(password, 10);
    const role = isBootstrapAdminEmail(cleanEmail) ? "admin" : "user";
    const { rows } = await pool.query<DbUser>(
      `INSERT INTO users (id, email, password_hash, name, role, email_verified) VALUES ($1, $2, $3, $4, $5, FALSE) RETURNING *`,
      [id, cleanEmail, hash, cleanName, role],
    );
    let user = rows[0];

    // Referral link tracking — best-effort, never blocks the signup itself.
    const refCode = String(ref ?? "").trim().toLowerCase();
    if (/^[a-z0-9]{4,32}$/.test(refCode)) {
      try {
        const refRow = await pool.query<{ id: string }>(
          `SELECT id FROM users WHERE referral_code = $1`,
          [refCode],
        );
        const referrerId = refRow.rows[0]?.id;
        if (referrerId && referrerId !== id) {
          await pool.query(`UPDATE users SET referred_by = $2 WHERE id = $1`, [id, referrerId]);
          await pool.query(
            `INSERT INTO referrals (referrer_id, referred_id) VALUES ($1, $2)
             ON CONFLICT (referred_id) DO NOTHING`,
            [referrerId, id],
          );
          logger.info({ userId: id, referrerId }, "referral linked");
        }
      } catch (refErr) {
        logger.warn({ err: refErr }, "referral link failed (signup continues)");
      }
    }

    // This is the only no-plan spendability exception: an explicit signup
    // trial, not a general permission for inactive accounts to use top-ups.
    await pool.query(`UPDATE users SET free_trial = TRUE WHERE id = $1`, [id]);
    if (SIGNUP_BONUS_CREDITS > 0) {
      user = await grantDualTopup(id, SIGNUP_BONUS_CREDITS, "signup_bonus");
    }
    // Mark email verified immediately (OTP flow disabled — add later).
    await pool.query(`UPDATE users SET email_verified = TRUE WHERE id = $1`, [id]);
    await regenerateSession(req);
    req.session.userId = id;
    await saveSession(req);
    logger.info({ userId: id }, "account created");
    res.json({ user: toPublicUser(user) });
  } catch (err) {
    if ((err as { code?: string }).code === "23505") {
      res.status(409).json({ error: "An account with this email already exists — try logging in." });
      return;
    }
    logger.error({ err }, "signup failed");
    res.status(500).json({ error: "Could not create the account. Please try again." });
  }
});

// ── POST /auth/verify-email ───────────────────────────────────────────────────
router.post("/auth/verify-email", authLimiter, async (req, res): Promise<void> => {
  if (!pool) { noDb(res); return; }
  const userId = req.session?.userId;
  if (!userId) { res.status(401).json({ error: "Session expired — please sign up again." }); return; }
  const { code } = (req.body ?? {}) as { code?: string };
  const cleanCode = (code ?? "").trim();
  if (!/^\d{6}$/.test(cleanCode)) {
    res.status(400).json({ error: "Enter the 6-digit code from your email." });
    return;
  }
  try {
    const { rows } = await pool.query(
      `SELECT id FROM email_verif_tokens
        WHERE user_id = $1 AND code = $2 AND used = FALSE AND expires_at > NOW()
        ORDER BY created_at DESC LIMIT 1`,
      [userId, cleanCode],
    );
    if (rows.length === 0) {
      res.status(400).json({ error: "Code is incorrect or has expired. Request a new one." });
      return;
    }
    // Mark token used + verify user
    await pool.query(`UPDATE email_verif_tokens SET used = TRUE WHERE id = $1`, [rows[0].id]);
    await pool.query(`UPDATE users SET email_verified = TRUE WHERE id = $1`, [userId]);
    const fresh = await refreshPlanState(userId);
    logger.info({ userId }, "email verified");
    res.json({ user: toPublicUser(fresh!) });
  } catch (err) {
    logger.error({ err }, "verify-email failed");
    res.status(500).json({ error: "Verification failed — please try again." });
  }
});

// ── POST /auth/resend-verification ───────────────────────────────────────────
router.post("/auth/resend-verification", authLimiter, async (req, res): Promise<void> => {
  if (!pool) { noDb(res); return; }
  const userId = req.session?.userId;
  if (!userId) { res.status(401).json({ error: "Session expired — please sign up again." }); return; }
  try {
    const { rows } = await pool.query(
      `SELECT email, email_verified FROM users WHERE id = $1`, [userId],
    );
    if (!rows[0]) { res.status(404).json({ error: "Account not found." }); return; }
    if (rows[0].email_verified) { res.json({ ok: true, alreadyVerified: true }); return; }
    await sendVerificationCode(userId, rows[0].email);
    res.json({ ok: true });
  } catch (err) {
    logger.error({ err }, "resend-verification failed");
    res.status(500).json({ error: "Could not send code — please try again." });
  }
});

// ── POST /auth/login ─────────────────────────────────────────────────────────
router.post("/auth/login", authLimiter, async (req, res): Promise<void> => {
  if (!pool) { noDb(res); return; }
  const { email, password } = (req.body ?? {}) as { email?: string; password?: string };
  const cleanEmail = (email ?? "").trim().toLowerCase();
  if (!cleanEmail || !password) {
    res.status(400).json({ error: "Email and password are required." });
    return;
  }
  try {
    const { rows } = await pool.query<DbUser>(
      `SELECT * FROM users WHERE lower(email) = $1`,
      [cleanEmail],
    );
    const row = rows[0];
    const ok = row?.password_hash ? await bcrypt.compare(password, row.password_hash) : false;
    if (!row || !ok) {
      res.status(401).json({ error: "Wrong email or password." });
      return;
    }
    if (row.status === "disabled") {
      res.status(403).json({ error: "This account has been disabled. Contact support.", code: "ACCOUNT_DISABLED" });
      return;
    }
    // Bootstrap admins by email list (works for accounts created before the list was set)
    if (row.role !== "admin" && isBootstrapAdminEmail(cleanEmail)) {
      await pool.query(`UPDATE users SET role = 'admin' WHERE id = $1`, [row.id]);
    }
    await regenerateSession(req);
    req.session.userId = row.id;
    await saveSession(req);
    const fresh = (await refreshPlanState(row.id)) ?? row;
    res.json({ user: toPublicUser(fresh) });
  } catch (err) {
    logger.error({ err }, "login failed");
    res.status(500).json({ error: "Could not log in. Please try again." });
  }
});

// ── Password reset ───────────────────────────────────────────────────────────
const RESET_TTL_MS = 30 * 60 * 1000; // 30 minutes

function sha256(raw: string): string {
  return crypto.createHash("sha256").update(raw).digest("hex");
}

/**
 * Returns the configured frontend base URL used in password-reset links.
 *
 * IMPORTANT: this must NEVER be derived from request headers (Origin,
 * Referer, Host, X-Forwarded-Host).  Trusting those would allow an attacker
 * to trigger a reset for a victim and redirect the token to an
 * attacker-controlled domain (reset-link poisoning / account takeover).
 *
 * Set APP_BASE_URL (e.g. "https://autocliper.app") in all environments.
 * In development, if the var is absent, we fall back to localhost — never
 * to anything derived from the incoming request.
 */
function appOrigin(): string {
  const configured = process.env.APP_BASE_URL?.replace(/\/$/, "");
  if (configured) return configured;
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "APP_BASE_URL must be set in production so reset-link URLs cannot be spoofed.",
    );
  }
  // Development-only fallback — localhost is safe here because no real
  // victim email is sent to an external inbox.
  return "http://localhost:5173";
}

// POST /auth/forgot-password { email }
router.post("/auth/forgot-password", authLimiter, async (req, res): Promise<void> => {
  if (!pool) { noDb(res); return; }
  const { email } = (req.body ?? {}) as { email?: string };
  const cleanEmail = (email ?? "").trim().toLowerCase();
  if (!EMAIL_RE.test(cleanEmail)) {
    res.status(400).json({ error: "Please enter a valid email address." });
    return;
  }
  // Same reply whether or not the account exists — no account enumeration.
  const generic = { ok: true, message: "If an account exists for that email, a reset link is on its way." };
  try {
    const { rows } = await pool.query<{ id: string; status: string }>(
      `SELECT id, status FROM users WHERE lower(email) = $1`,
      [cleanEmail],
    );
    const user = rows[0];
    if (!user || user.status === "disabled") { res.json(generic); return; }

    const token = crypto.randomBytes(32).toString("base64url");
    // Invalidate earlier unused tokens so only the newest link works.
    await pool.query(
      `UPDATE password_resets SET used_at = NOW() WHERE user_id = $1 AND used_at IS NULL`,
      [user.id],
    );
    await pool.query(
      `INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES ($1, $2, $3)`,
      [user.id, sha256(token), new Date(Date.now() + RESET_TTL_MS)],
    );

    const link = `${appOrigin()}/reset-password?token=${token}`;
    const { sendEmail } = await import("../lib/mailer");
    await sendEmail({
      to: cleanEmail,
      subject: "Reset your AutoCliper password",
      text: `Someone (hopefully you) asked to reset your AutoCliper password.\n\nReset it here (link expires in 30 minutes):\n${link}\n\nIf you didn't ask for this, you can ignore this email — your password is unchanged.`,
      html: `<div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;padding:24px">
  <h2 style="margin:0 0 12px">Reset your AutoCliper password</h2>
  <p style="color:#444">Someone (hopefully you) asked to reset your password. This link expires in <b>30 minutes</b> and can be used once.</p>
  <p style="margin:24px 0"><a href="${link}" style="background:#D1FE17;color:#000;font-weight:bold;padding:12px 20px;border-radius:10px;text-decoration:none">Choose a new password</a></p>
  <p style="color:#888;font-size:13px">If the button doesn't work, paste this into your browser:<br>${link}</p>
  <p style="color:#888;font-size:13px">Didn't ask for this? Ignore this email — your password is unchanged.</p>
</div>`,
    });
    logger.info({ userId: user.id }, "password reset email sent");
    res.json(generic);
  } catch (err) {
    logger.error({ err }, "forgot-password failed");
    res.status(502).json({ error: "Could not send the reset email right now. Please try again in a few minutes." });
  }
});

// POST /auth/reset-password { token, password }
router.post("/auth/reset-password", authLimiter, async (req, res): Promise<void> => {
  if (!pool) { noDb(res); return; }
  const { token, password } = (req.body ?? {}) as { token?: string; password?: string };
  if (!token || typeof token !== "string" || token.length > 200) {
    res.status(400).json({ error: "This reset link is invalid. Request a new one." });
    return;
  }
  if (!password || password.length < 8 || password.length > 200) {
    res.status(400).json({ error: "Password must be at least 8 characters." });
    return;
  }
  try {
    // Atomically consume the token — a second use finds used_at already set.
    const { rows } = await pool.query<{ user_id: string }>(
      `UPDATE password_resets
          SET used_at = NOW()
        WHERE token_hash = $1 AND used_at IS NULL AND expires_at > NOW()
        RETURNING user_id`,
      [sha256(token)],
    );
    const reset = rows[0];
    if (!reset) {
      res.status(400).json({ error: "This reset link is invalid or has expired. Request a new one." });
      return;
    }
    const hash = await bcrypt.hash(password, 10);
    await pool.query(`UPDATE users SET password_hash = $1 WHERE id = $2`, [hash, reset.user_id]);
    // Log out every existing session for this account.
    await pool.query(`DELETE FROM session WHERE sess->>'userId' = $1`, [reset.user_id]);
    logger.info({ userId: reset.user_id }, "password reset completed");
    res.json({ ok: true });
  } catch (err) {
    logger.error({ err }, "reset-password failed");
    res.status(500).json({ error: "Could not reset the password. Please try again." });
  }
});

// ── POST /auth/logout ────────────────────────────────────────────────────────
router.post("/auth/logout", (req, res): void => {
  req.session?.destroy(() => {
    res.clearCookie(SESSION_COOKIE_NAME);
    res.json({ ok: true });
  });
});

// ── GET /auth/me ─────────────────────────────────────────────────────────────
router.get("/auth/me", async (req, res): Promise<void> => {
  if (!pool) { res.json({ user: null }); return; }
  const userId = req.session?.userId;
  if (!userId) { res.json({ user: null }); return; }
  try {
    const fresh = await refreshPlanState(userId);
    if (!fresh || fresh.status === "disabled") {
      req.session.destroy(() => {});
      res.json({ user: null });
      return;
    }
    res.json({ user: toPublicUser(fresh) });
  } catch (err) {
    logger.error({ err }, "auth/me failed");
    res.status(500).json({ error: "Could not load your account." });
  }
});

export default router;
