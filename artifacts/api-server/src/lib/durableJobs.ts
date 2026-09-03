/**
 * PostgreSQL coordination for work that may outlive an HTTP request or a
 * Node process.  This module is deliberately fail-open: the local queue and
 * Object Storage mirror remain valid fallbacks for development and for a
 * temporary database outage.
 */
import crypto from "crypto";
import { pool } from "./db";
import { logger } from "./logger";

export const DURABLE_LEASE_MS = Math.max(
  45_000,
  Number.parseInt(process.env.DURABLE_JOB_LEASE_MS ?? "180000", 10) || 180_000,
);
const ZYLA_LEASE_MS = Math.max(
  60_000,
  Number.parseInt(process.env.ZYLA_INFLIGHT_LEASE_MS ?? "900000", 10) || 900_000,
);

type DbJobRow = {
  id: string;
  status: string;
  payload: Record<string, unknown>;
  lease_owner?: string | null;
  lease_token?: string | null;
  lease_until?: string | Date | null;
  attempt?: number;
};

function token(): string {
  return crypto.randomBytes(16).toString("hex");
}

function enabled(): boolean {
  return pool !== null;
}

export interface DurableJobStats {
  queued: number;
  active: number;
  staleLeases: number;
  available: boolean;
}

/** Insert once; repeated submissions with the same id are harmless. */
export async function enqueueDurableJob(
  id: string,
  userId: string | undefined,
  payload: Record<string, unknown>,
): Promise<boolean> {
  if (!pool) return false;
  try {
    await pool.query(
      `INSERT INTO async_jobs (id, user_id, status, payload)
       VALUES ($1, (SELECT id FROM users WHERE id = $2), 'queued', $3::jsonb)
       ON CONFLICT (id) DO NOTHING`,
      [id, userId ?? null, JSON.stringify(payload)],
    );
    return true;
  } catch (err) {
    logger.warn({ err, id }, "[durable-jobs] enqueue failed; using local fallback");
    return false;
  }
}

/** The DB is authoritative when a row exists; local mirrors are fallback data. */
export async function getDurableJob(id: string): Promise<{
  status: string;
  payload: Record<string, unknown>;
  leaseOwner: string | null;
  leaseToken: string | null;
  leaseUntil: Date | null;
  attempt: number;
} | null> {
  if (!pool) return null;
  try {
    const r = await pool.query<DbJobRow>(
      `SELECT id, status, payload, lease_owner, lease_token, lease_until, attempt
         FROM async_jobs WHERE id = $1`,
      [id],
    );
    const row = r.rows[0];
    if (!row) return null;
    return {
      status: row.status,
      // Explicit state always wins over a lagging JSON mirror.
      payload: { ...(row.payload ?? {}), status: row.status },
      leaseOwner: row.lease_owner ?? null,
      leaseToken: row.lease_token ?? null,
      leaseUntil: row.lease_until ? new Date(row.lease_until) : null,
      attempt: Number(row.attempt ?? 0),
    };
  } catch (err) {
    logger.warn({ err, id }, "[durable-jobs] read failed");
    return null;
  }
}

/** Persist the latest JobRecord without making a database outage fail a clip. */
export async function saveDurableJob(
  id: string,
  record: Record<string, unknown>,
  leaseOwner?: string,
  leaseToken?: string,
): Promise<void> {
  if (!pool) return;
  try {
    await pool.query(
      `UPDATE async_jobs
          SET payload = $2::jsonb,
              status = $3,
              updated_at = NOW(),
              lease_owner = CASE WHEN $4::text IS NULL THEN lease_owner ELSE $4 END,
              lease_until = CASE WHEN $4::text IS NULL THEN lease_until
                                 ELSE NOW() + ($5::text || ' milliseconds')::interval END
        WHERE id = $1
          -- An unleased writer is only allowed to update a still-queued row.
          -- It can never turn another worker's processing result into a stale
          -- status; the owner token is mandatory once execution has begun.
          AND (($6::text IS NULL AND status = 'queued')
            OR (lease_owner = $4 AND lease_token = $6))`,
      [id, JSON.stringify(record), String(record.status ?? "queued"), leaseOwner ?? null, DURABLE_LEASE_MS, leaseToken ?? null],
    );
  } catch (err) {
    logger.warn({ err, id }, "[durable-jobs] save failed");
  }
}

/**
 * Claim the job only if it is queued and the shared number of processing jobs
 * is below the configured global cap.  PostgreSQL row locks make this safe
 * across API instances.
 */
export async function tryClaimDurableJob(
  id: string,
  owner: string,
  maxActive: number,
): Promise<{ claimed: boolean; token?: string; cancelled?: boolean; unavailable?: boolean }> {
  if (!pool) return { claimed: true };
  const client = await pool.connect();
  const leaseToken = token();
  try {
    await client.query("BEGIN");
    // The count-and-claim decision is global, not per job. This transaction
    // advisory lock closes the race where two different queued rows both see
    // the final remaining shared capacity slot.
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('clipai-async-capacity'))`);
    const target = await client.query<{ status: string }>(
      `SELECT status FROM async_jobs WHERE id = $1 FOR UPDATE`,
      [id],
    );
    if (!target.rows[0]) {
      await client.query("ROLLBACK");
      return { claimed: false };
    }
    if (target.rows[0].status === "cancelled") {
      await client.query("COMMIT");
      return { claimed: false, cancelled: true };
    }
    const active = await client.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM async_jobs
        WHERE status = 'processing' AND lease_until > NOW()`,
    );
    if (Number(active.rows[0]?.n ?? 0) >= Math.max(1, maxActive)) {
      await client.query("COMMIT");
      return { claimed: false };
    }
    const updated = await client.query(
      `UPDATE async_jobs
          SET status = 'processing', lease_owner = $2, lease_token = $3,
              lease_until = NOW() + ($4::text || ' milliseconds')::interval,
              attempt = attempt + 1, updated_at = NOW()
        WHERE id = $1 AND status = 'queued'
        RETURNING id`,
      [id, owner, leaseToken, DURABLE_LEASE_MS],
    );
    await client.query("COMMIT");
    return updated.rowCount ? { claimed: true, token: leaseToken } : { claimed: false };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    logger.warn({ err, id }, "[durable-jobs] claim failed");
    return { claimed: false, unavailable: true };
  } finally {
    client.release();
  }
}

export async function renewDurableLease(id: string, owner: string, leaseToken: string): Promise<boolean> {
  if (!pool) return true;
  try {
    const r = await pool.query(
      `UPDATE async_jobs
          SET lease_until = NOW() + ($4::text || ' milliseconds')::interval,
              updated_at = NOW()
        WHERE id = $1 AND status = 'processing'
          AND lease_owner = $2 AND lease_token = $3`,
      [id, owner, leaseToken, DURABLE_LEASE_MS],
    );
    return (r.rowCount ?? 0) > 0;
  } catch (err) {
    logger.warn({ err, id }, "[durable-jobs] heartbeat failed");
    return false;
  }
}

/** Terminal updates are compare-and-set operations: a stale worker cannot
 * overwrite a cancellation or a result produced by a replacement worker. */
export async function finishDurableJob(
  id: string,
  owner: string,
  leaseToken: string,
  record: Record<string, unknown>,
): Promise<boolean> {
  if (!pool) return true;
  try {
    const r = await pool.query(
      `UPDATE async_jobs
          SET status = $4, payload = $5::jsonb, updated_at = NOW(),
              lease_owner = NULL, lease_token = NULL, lease_until = NULL
        WHERE id = $1 AND status = 'processing'
          AND lease_owner = $2 AND lease_token = $3`,
      [id, owner, leaseToken, String(record.status ?? "error"), JSON.stringify(record)],
    );
    return (r.rowCount ?? 0) > 0;
  } catch (err) {
    logger.warn({ err, id }, "[durable-jobs] terminal save failed");
    return false;
  }
}

/** Cross-instance cancellation only wins while a worker has not claimed it. */
export async function cancelDurableJob(id: string): Promise<"cancelled" | "started" | "missing" | "unavailable"> {
  if (!pool) return "unavailable";
  try {
    const r = await pool.query(
      `UPDATE async_jobs SET status = 'cancelled', updated_at = NOW(),
          lease_owner = NULL, lease_token = NULL, lease_until = NULL,
          payload = jsonb_set(payload, '{status}', '"cancelled"'::jsonb)
        WHERE id = $1 AND status = 'queued'
        RETURNING id`,
      [id],
    );
    if ((r.rowCount ?? 0) > 0) return "cancelled";
    const exists = await pool.query(`SELECT status FROM async_jobs WHERE id = $1`, [id]);
    if (!exists.rows[0]) return "missing";
    return "started";
  } catch (err) {
    logger.warn({ err, id }, "[durable-jobs] cancel failed");
    return "unavailable";
  }
}

/** Expired leases are returned to the queue. A later claimant owns the next
 * attempt; no old worker can commit because its token no longer matches. */
export async function reclaimExpiredDurableJobs(): Promise<number> {
  if (!pool) return 0;
  try {
    const r = await pool.query(
      `UPDATE async_jobs
          SET status = 'queued', lease_owner = NULL, lease_token = NULL,
              lease_until = NULL, updated_at = NOW()
        WHERE status = 'processing' AND lease_until <= NOW()`,
    );
    return r.rowCount ?? 0;
  } catch (err) {
    logger.warn({ err }, "[durable-jobs] lease reclaim failed");
    return 0;
  }
}

export async function getDurableJobStats(): Promise<DurableJobStats> {
  if (!pool) return { queued: 0, active: 0, staleLeases: 0, available: false };
  try {
    const r = await pool.query<{ queued: string; active: string; stale: string }>(
      `SELECT
         COUNT(*) FILTER (WHERE status = 'queued')::text AS queued,
         COUNT(*) FILTER (WHERE status = 'processing' AND lease_until > NOW())::text AS active,
         COUNT(*) FILTER (WHERE status = 'processing' AND lease_until <= NOW())::text AS stale
       FROM async_jobs
       WHERE status IN ('queued','processing')`,
    );
    const row = r.rows[0];
    return { queued: Number(row?.queued ?? 0), active: Number(row?.active ?? 0), staleLeases: Number(row?.stale ?? 0), available: true };
  } catch {
    return { queued: 0, active: 0, staleLeases: 0, available: false };
  }
}

// Zyla lease helpers.  The completed mirror remains the source of truth after
// a conversion; this table only coordinates cache misses.
export interface ZylaLease {
  acquired: boolean;
  token?: string;
  progressUrl?: string;
  upstreamJobId?: string;
}

export async function acquireZylaLease(videoId: string, format: string): Promise<ZylaLease> {
  // Downloader route tests intentionally mock the provider and use fake
  // timers; keep them hermetic rather than waiting on a real development DB.
  if (process.env.VITEST) return { acquired: true, token: token() };
  if (!pool) return { acquired: true, token: token() };
  const leaseToken = token();
  try {
    const inserted = await pool.query(
      `INSERT INTO zyla_inflight (video_id, format, lease_token, lease_until)
       VALUES ($1, $2, $3, NOW() + ($4::text || ' milliseconds')::interval)
       ON CONFLICT (video_id, format) DO UPDATE
         SET lease_token = EXCLUDED.lease_token, progress_url = NULL,
             upstream_job_id = NULL, lease_until = EXCLUDED.lease_until,
             updated_at = NOW()
         WHERE zyla_inflight.lease_until <= NOW()
       RETURNING lease_token`,
      [videoId, format, leaseToken, ZYLA_LEASE_MS],
    );
    if (inserted.rowCount) return { acquired: true, token: leaseToken };
    const row = await pool.query<{ lease_token: string; progress_url: string | null; upstream_job_id: string | null }>(
      `SELECT lease_token, progress_url, upstream_job_id FROM zyla_inflight
        WHERE video_id = $1 AND format = $2 AND lease_until > NOW()`,
      [videoId, format],
    );
    const existing = row.rows[0];
    return existing
      ? { acquired: false, token: existing.lease_token, progressUrl: existing.progress_url ?? undefined, upstreamJobId: existing.upstream_job_id ?? undefined }
      : { acquired: false };
  } catch (err) {
    logger.warn({ err, videoId, format }, "[zyla-lease] acquire failed; local dedupe remains active");
    return { acquired: true, token: leaseToken };
  }
}

export async function publishZylaLease(
  videoId: string,
  format: string,
  leaseToken: string,
  progressUrl: string,
  upstreamJobId: string,
): Promise<void> {
  if (process.env.VITEST) return;
  if (!pool) return;
  await pool.query(
    `UPDATE zyla_inflight
        SET progress_url = $4, upstream_job_id = $5, updated_at = NOW(),
            lease_until = NOW() + ($6::text || ' milliseconds')::interval
      WHERE video_id = $1 AND format = $2 AND lease_token = $3`,
    [videoId, format, leaseToken, progressUrl, upstreamJobId, ZYLA_LEASE_MS],
  ).catch((err) => logger.warn({ err, videoId, format }, "[zyla-lease] publish failed"));
}

export async function releaseZylaLease(videoId: string, format: string, leaseToken: string): Promise<void> {
  if (process.env.VITEST) return;
  if (!pool) return;
  await pool.query(
    `DELETE FROM zyla_inflight WHERE video_id = $1 AND format = $2 AND lease_token = $3`,
    [videoId, format, leaseToken],
  ).catch((err) => logger.warn({ err, videoId, format }, "[zyla-lease] release failed"));
}
