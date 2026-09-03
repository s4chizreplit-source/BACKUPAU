/**
 * Referral program — every user gets a unique share code.
 *
 *   GET /referral/me → { code, reward, stats { joined, rewarded, creditsEarned } }
 *
 * Codes are generated lazily on first request, so existing accounts get one
 * automatically the moment they open the referral card. The actual reward is
 * granted inside grantSubscriptionTx (lib/billing.ts) when a referred user's
 * first plan purchase is approved — one bonus per referred friend, ever.
 */
import { Router, type IRouter } from "express";
import crypto from "crypto";
import { pool } from "../lib/db";
import { requireUser } from "../middlewares/sessionAuth";
import { REFERRAL_REWARD_CREDITS } from "../lib/billing";

const router: IRouter = Router();

/** 8 lowercase hex chars — short enough to share, 4B combinations. */
const genCode = () => crypto.randomBytes(4).toString("hex");

router.get("/referral/me", requireUser, async (req, res): Promise<void> => {
  if (!pool) { res.status(503).json({ error: "Database is not configured." }); return; }
  const userId = req.currentUser!.id;
  try {
    const row = await pool.query<{ referral_code: string | null }>(
      `SELECT referral_code FROM users WHERE id = $1`,
      [userId],
    );
    let code = row.rows[0]?.referral_code ?? null;

    // Lazily mint a code (retry on the unlikely unique-index collision).
    for (let i = 0; i < 5 && !code; i++) {
      const candidate = genCode();
      try {
        const upd = await pool.query<{ referral_code: string }>(
          `UPDATE users SET referral_code = $2
           WHERE id = $1 AND referral_code IS NULL
           RETURNING referral_code`,
          [userId, candidate],
        );
        code = upd.rows[0]?.referral_code ?? null;
        if (!code) {
          // Another request already set it — read the winner.
          const again = await pool.query<{ referral_code: string | null }>(
            `SELECT referral_code FROM users WHERE id = $1`,
            [userId],
          );
          code = again.rows[0]?.referral_code ?? null;
        }
      } catch (err) {
        if ((err as { code?: string }).code !== "23505") throw err;
      }
    }
    if (!code) { res.status(500).json({ error: "Could not create your referral code." }); return; }

    const stats = await pool.query<{ joined: number; rewarded: number; credits_earned: number }>(
      `SELECT COUNT(*)::int AS joined,
              COUNT(*) FILTER (WHERE status = 'rewarded')::int AS rewarded,
              COALESCE(SUM(reward_credits) FILTER (WHERE status = 'rewarded'), 0)::int AS credits_earned
       FROM referrals WHERE referrer_id = $1`,
      [userId],
    );
    const s = stats.rows[0];
    res.json({
      code,
      reward: REFERRAL_REWARD_CREDITS,
      stats: { joined: s.joined, rewarded: s.rewarded, creditsEarned: s.credits_earned },
    });
  } catch {
    res.status(500).json({ error: "Could not load referral info." });
  }
});

export default router;
