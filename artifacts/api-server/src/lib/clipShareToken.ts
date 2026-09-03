/**
 * Temporary share tokens for clip files.
 *
 * Lets Post for Me (and other external services) fetch a clip video via a
 * short-lived public URL without needing user session auth.
 * Tokens expire after 24 hours and are cleaned up lazily on read.
 */
import crypto from "crypto";
import { requireDb } from "./db";

const TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

export interface ShareTokenInfo {
  clipId: string;
  ownerId: string;
}

/** Create a 24-hour share token for a clip file. */
export async function createShareToken(clipId: string, ownerId: string): Promise<string> {
  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + TTL_MS);
  await requireDb().query(
    `INSERT INTO clip_share_tokens (token, clip_id, owner_id, expires_at) VALUES ($1, $2, $3, $4)
     ON CONFLICT (token) DO NOTHING`,
    [token, clipId, ownerId, expiresAt],
  );
  return token;
}

/**
 * Validate a share token and return the associated clip info.
 * Returns null if the token is missing, expired, or invalid.
 */
export async function resolveShareToken(token: string): Promise<ShareTokenInfo | null> {
  if (!/^[0-9a-f]{64}$/.test(token)) return null;

  const { rows } = await requireDb().query<{ clip_id: string; owner_id: string }>(
    `SELECT clip_id, owner_id
       FROM clip_share_tokens
      WHERE token = $1 AND expires_at > NOW()`,
    [token],
  );
  if (!rows[0]) return null;
  return { clipId: rows[0].clip_id, ownerId: rows[0].owner_id };
}

/** Purge expired tokens (call periodically from a cleanup job). */
export async function purgeExpiredShareTokens(): Promise<number> {
  const { rowCount } = await requireDb().query(
    `DELETE FROM clip_share_tokens WHERE expires_at <= NOW()`,
  );
  return rowCount ?? 0;
}
