/**
 * Durable cross-instance cache of resolved download-engine mirrors.
 *
 * The in-memory cache in routes/ytDownload.ts dies on every restart and is
 * invisible to sibling autoscale instances — so the SAME video kept consuming
 * a fresh paid engine start (and a multi-minute conversion wait) after each
 * deploy, or whenever the request landed on a different instance. This table
 * makes one finished conversion reusable by every instance for the link's
 * whole ~6-day lifetime.
 *
 * All functions swallow errors: the cache is an accelerator, never a
 * dependency. With no DB (or a failing query) callers simply fall back to
 * starting a fresh engine job.
 */
import { pool } from "./db";
import { logger } from "./logger";

export interface CachedMirror {
  downloadUrl: string;
  title?: string;
  expiresAtMs: number;
}

export async function getCachedMirror(
  videoId: string,
  format: string,
): Promise<CachedMirror | null> {
  if (!pool) return null;
  try {
    const r = await pool.query(
      `SELECT download_url, title, expires_at FROM zyla_cache
        WHERE video_id = $1 AND format = $2 AND expires_at > NOW()`,
      [videoId, format],
    );
    const row = r.rows[0];
    if (!row) return null;
    return {
      downloadUrl: String(row.download_url),
      ...(row.title ? { title: String(row.title) } : {}),
      expiresAtMs: new Date(row.expires_at as string | Date).getTime(),
    };
  } catch (err) {
    logger.warn({ err }, "[zyla-cache] read failed");
    return null;
  }
}

export async function putCachedMirror(
  videoId: string,
  format: string,
  downloadUrl: string,
  title: string | undefined,
  expiresAtMs: number,
): Promise<void> {
  if (!pool) return;
  try {
    await pool.query(
      `INSERT INTO zyla_cache (video_id, format, download_url, title, expires_at)
       VALUES ($1, $2, $3, $4, to_timestamp($5 / 1000.0))
       ON CONFLICT (video_id, format)
       DO UPDATE SET download_url = EXCLUDED.download_url,
                     title        = EXCLUDED.title,
                     expires_at   = EXCLUDED.expires_at,
                     created_at   = NOW()`,
      [videoId, format, downloadUrl, title ?? null, expiresAtMs],
    );
  } catch (err) {
    logger.warn({ err }, "[zyla-cache] write failed");
  }
}

/** Drop a cached mirror (e.g. the link died before its expiry). Pass the dead
 *  URL as `onlyIfUrl` so a stale delete can never clobber a FRESH row written
 *  concurrently by another instance finishing a new conversion. */
export async function deleteCachedMirror(
  videoId: string,
  format: string,
  onlyIfUrl?: string,
): Promise<void> {
  if (!pool) return;
  try {
    if (onlyIfUrl !== undefined) {
      await pool.query(
        `DELETE FROM zyla_cache WHERE video_id = $1 AND format = $2 AND download_url = $3`,
        [videoId, format, onlyIfUrl],
      );
    } else {
      await pool.query(`DELETE FROM zyla_cache WHERE video_id = $1 AND format = $2`, [
        videoId,
        format,
      ]);
    }
  } catch (err) {
    logger.warn({ err }, "[zyla-cache] delete failed");
  }
}
