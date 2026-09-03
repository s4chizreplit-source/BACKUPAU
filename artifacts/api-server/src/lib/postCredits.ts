/**
 * Posting credits — the rule that makes plans mean something for Auto-Pilot
 * and bulk scheduling:
 *
 *   • Every video PUSHED to social accounts costs one uploading credit.
 *     Generated clips independently consumed cutting credit at generation;
 *     Drive/Dropbox folders, Instagram reposts and pasted links use the same
 *     provider-handoff rule.
 *   • No credits → no hand-off. The row waits (hold_until) and resumes by
 *     itself after a top-up; it never posts on an empty balance.
 *
 * Charge point is provider hand-off — the moment we commit the post to the
 * provider. The reservation and the row marker (credit_sub_spent /
 * credit_topup_spent) commit in ONE transaction keyed on status='creating',
 * so a cancel racing the charge rolls the whole thing back, retries can never
 * double-charge, and a crash can never strand a hold without its marker.
 *
 * Refunds are deliberately NOT sprinkled across every failure writer.
 * A single idempotent sweep (called from the drain tick) refunds any terminal
 * row (failed/cancelled/deleted) still carrying a charge — one place that
 * covers the drain, cancel endpoints, housekeeping, webhook and reconciler
 * alike, including failure writers added in the future.
 */
import type { Pool } from "pg";
import {
  CREDITS_PER_POST,
  refundUploadingCreditsTx,
  reserveUploadingCreditsTx,
  withTx,
} from "./billing";

export interface PostChargeRow {
  id: string;
  user_id: string;
  source: string;
  clip_id: string | null;
  media_url: string | null;
  credit_sub_spent?: number | null;
  credit_topup_spent?: number | null;
  credit_legacy_spent?: number | null;
}

export function needsPostCharge(row: PostChargeRow): boolean {
  // Every provider hand-off is an uploading operation, including generated
  // clips. Cutting and uploading are separately metered in the INR catalog.
  // Retries carry the split from the first successful charge — never re-charge.
  return ((row.credit_sub_spent ?? 0) + (row.credit_topup_spent ?? 0) + (row.credit_legacy_spent ?? 0)) === 0;
}

export type PostChargeResult =
  | { ok: true }
  | { ok: false; available: number; needed: number }
  | { lostRace: true };

class LostRace extends Error {}

/** Reserve CREDITS_PER_POST and stamp the split onto the row — atomically. */
export async function chargePostRow(db: Pool, row: PostChargeRow): Promise<PostChargeResult> {
  try {
    return await withTx(db, async (client) => {
      const r = await reserveUploadingCreditsTx(client, row.user_id, CREDITS_PER_POST, "post_reserve", {
        postRowId: row.id,
        source: row.source,
      });
      if (!r.ok) return { ok: false as const, available: r.available, needed: r.needed };
      const upd = await client.query(
        `UPDATE social_posts
         SET credit_sub_spent = $2, credit_topup_spent = $3, credit_legacy_spent = $4, updated_at = NOW()
         WHERE id = $1 AND status = 'creating'
            AND credit_sub_spent = 0 AND credit_topup_spent = 0 AND credit_legacy_spent = 0`,
        [row.id, r.fromSub, r.fromTopup, r.fromLegacy],
      );
      // Cancelled/reclaimed between claim and charge — or ALREADY charged by a
      // concurrent worker (stale reclaim can hold the same row twice; the
      // zero-marker predicate makes the second charge lose) → roll the hold
      // back too. Without the marker predicate two workers could both reserve
      // and the second split would overwrite the first: a silent double-charge.
      if ((upd.rowCount ?? 0) === 0) throw new LostRace("row left 'creating' mid-charge");
      return { ok: true as const };
    });
  } catch (err) {
    if (err instanceof LostRace) return { lostRace: true as const };
    throw err;
  }
}

export interface SweepProviderOps {
  /** Definite lookup by our external id (= row id). Must return the provider
   *  post only when it exists, null ONLY on a definite not-found, and THROW
   *  on fetch failure — an error must never be mistaken for "no post". */
  find: (externalId: string) => Promise<{ id: string } | null>;
  /** Provider-side delete — used before refunding a cancelled/deleted row
   *  whose ambiguous create turned out to have landed. */
  remove: (pfmPostId: string) => Promise<void>;
}

/**
 * Refund every terminal row still carrying a charge. Each refund is its own
 * transaction (one bad row can't wedge the rest); the conditional zeroing
 * UPDATE makes repeats and concurrent sweeps harmless. Returns refund count.
 *
 * Ambiguity rule (the money-critical part): a charged terminal row WITHOUT a
 * pfm_post_id may still have a live provider post — its create timed out
 * ambiguously and the recovery lookup kept failing. Refunding it blind would
 * hand out free posts every provider outage. So:
 *   • pfm_post_id set → the provider told us the outcome (webhook fail /
 *     cancel-delete) → refund straight away, works even while PFM is down.
 *   • pfm_post_id null → verify via `provider.find` first: definite
 *     not-found → refund; found + failed → HEAL the row back to 'scheduled'
 *     (service was delivered — keep the charge); found + cancelled/deleted →
 *     take the provider post down, then refund; lookup error or no provider
 *     configured → keep the charge and retry next sweep.
 */
export async function sweepPostCreditRefunds(
  db: Pool,
  provider?: SweepProviderOps,
  limit = 25,
): Promise<number> {
  const { rows } = await db.query<{ id: string; status: string; pfm_post_id: string | null }>(
    `SELECT id, status, pfm_post_id FROM social_posts
     WHERE status IN ('failed','cancelled','deleted')
        AND (credit_sub_spent > 0 OR credit_topup_spent > 0 OR credit_legacy_spent > 0)
     LIMIT $1`,
    [limit],
  );
  let done = 0;
  for (const { id, status, pfm_post_id } of rows) {
    try {
      if (pfm_post_id === null) {
        if (!provider) continue; // can't verify while PFM is unconfigured — keep the charge
        const found = await provider.find(id); // throws → catch below → retry next sweep
        if (found) {
          if (status === "failed") {
            // The "failed" post actually exists provider-side — heal it and
            // keep the charge; the webhook lifecycle takes over from here.
            await db.query(
              `UPDATE social_posts
               SET status='scheduled', pfm_post_id=$2, error=NULL, updated_at=NOW()
               WHERE id=$1 AND status='failed'`,
              [id, found.id],
            );
            continue; // no refund — the user is getting the post
          }
          // cancelled/deleted: the user said no — undo the provider post
          // BEFORE refunding (throws → retry next sweep, charge kept).
          await provider.remove(found.id);
        }
        // definite not-found, or removed above → refundable
      }
      await withTx(db, async (client) => {
        const { rows: undone } = await client.query<{
           user_id: string; s: number; t: number; l: number; row_status: string;
        }>(
          `UPDATE social_posts sp
            SET credit_sub_spent = 0, credit_topup_spent = 0, credit_legacy_spent = 0, updated_at = NOW()
            FROM (SELECT id, user_id, status, credit_sub_spent AS s, credit_topup_spent AS t, credit_legacy_spent AS l
                 FROM social_posts WHERE id = $1 FOR UPDATE) old
           WHERE sp.id = old.id
             AND sp.status IN ('failed','cancelled','deleted')
              AND (old.s > 0 OR old.t > 0 OR old.l > 0)
            RETURNING old.user_id, old.s, old.t, old.l, old.status AS row_status`,
          [id],
        );
        if (undone.length === 0) return; // raced with another sweep — fine
        const u = undone[0];
        await refundUploadingCreditsTx(client, u.user_id, u.s, u.t, "post_refund", {
          postRowId: id,
          rowStatus: u.row_status,
        }, u.l);
        done++;
      });
    } catch (err) {
      // Row keeps its charge marker — the next sweep retries it.
      console.warn(`[postCredits] refund for row ${id} failed: ${(err as Error).message}`);
    }
  }
  return done;
}
