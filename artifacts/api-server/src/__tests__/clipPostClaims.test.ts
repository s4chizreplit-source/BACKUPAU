/**
 * Double-post protection — posted-marker claims + release classification.
 *
 * Users reported the same clip landing twice on TikTok (auto-post on clip
 * completion + a manual "Post" click). The fix: autoPostClips atomically
 * claims a (user, clip, social account) row BEFORE posting; the unique index
 * guarantees only one caller ever wins. These tests pin:
 *   1. isDefiniteReject — claims are released only when the provider
 *      definitely did NOT create the post (4xx), never on ambiguous outcomes
 *      (5xx / network) where releasing could allow a duplicate.
 *   2. The exact claim INSERT the code uses, against the real dev database
 *      (unique index built by ensureSchema at boot).
 *   3. releaseClaims' conditional DELETE — a claim that already recorded a
 *      provider post id is never released.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "crypto";

const HAS_DB = !!process.env.DATABASE_URL;
// The PFM client refuses to run without a key; these tests never hit the
// network, so a dummy key is safe. Never overwrite a real key.
if (!process.env.POSTFORME_API_KEY) process.env.POSTFORME_API_KEY = "test-key-never-used";
const { PfmApiError, isDefiniteReject } = await import("../lib/postforme");
const { pool } = await import("../lib/db");

afterAll(async () => {
  await pool?.end();
});

describe("isDefiniteReject — release only when the post definitely does not exist", () => {
  it("rejects on provider 4xx (nothing was created)", () => {
    expect(isDefiniteReject(new PfmApiError(400, "bad payload"))).toBe(true);
    expect(isDefiniteReject(new PfmApiError(422, "validation"))).toBe(true);
    expect(isDefiniteReject(new PfmApiError(401, "bad key"))).toBe(true);
  });

  it("is ambiguous on 5xx / network / unknown errors (claim must be kept)", () => {
    expect(isDefiniteReject(new PfmApiError(500, "oops"))).toBe(false);
    expect(isDefiniteReject(new PfmApiError(503, "down"))).toBe(false);
    expect(isDefiniteReject(new TypeError("fetch failed"))).toBe(false);
    expect(isDefiniteReject(new Error("socket hang up"))).toBe(false);
    expect(isDefiniteReject(undefined)).toBe(false);
  });
});

describe.skipIf(!HAS_DB)("posted-marker claims (real DB)", () => {
  const clipId = `claim-test-${crypto.randomBytes(5).toString("hex")}`;
  const userId = `usr_claimtest_${crypto.randomBytes(4).toString("hex")}`;
  const accA = `pfm-acc-a-${userId.slice(-4)}`;
  const accB = `pfm-acc-b-${userId.slice(-4)}`;

  beforeAll(async () => {
    await pool!.query(
      `INSERT INTO users (id, email) VALUES ($1, $2)`,
      [userId, `${userId}@it-test.clipai.dev`],
    );
  });

  afterAll(async () => {
    // FK cascades clean up any leftover clip_account_posts rows
    await pool?.query(`DELETE FROM users WHERE id = $1`, [userId]);
  });

  // The EXACT claim statement autoPostClips uses
  const claim = (accountIds: string[]) =>
    pool!.query<{ social_account_id: string }>(
      `INSERT INTO clip_account_posts (user_id, clip_id, social_account_id, platform, status)
       SELECT $1, $2, unnest($3::text[]), unnest($4::text[]), 'pending'
       ON CONFLICT (user_id, clip_id, social_account_id) DO NOTHING
       RETURNING social_account_id`,
      [userId, clipId, accountIds, accountIds.map(() => "tiktok")],
    );

  it("first claim wins, the racing second claim gets zero rows", async () => {
    const first = await claim([accA]);
    expect(first.rows.map((r) => r.social_account_id)).toEqual([accA]);
    const second = await claim([accA]);
    expect(second.rows).toHaveLength(0);
  });

  it("partially-blocked multi-account claim returns only the free accounts", async () => {
    const r = await claim([accA, accB]); // accA already claimed above
    expect(r.rows.map((x) => x.social_account_id)).toEqual([accB]);
  });

  it("releaseClaims' conditional DELETE never frees a claim that saved its post id", async () => {
    // Simulate the race: the push landed and recorded the provider post id
    await pool!.query(
      `UPDATE clip_account_posts SET pfm_post_id = 'pfm-post-live', status = 'submitted'
       WHERE user_id=$1 AND clip_id=$2 AND social_account_id=$3`,
      [userId, clipId, accA],
    );
    // The exact release statement autoPostClips uses on create failure
    await pool!.query(
      `DELETE FROM clip_account_posts
       WHERE user_id=$1 AND clip_id=$2 AND social_account_id = ANY($3)
         AND status='pending' AND pfm_post_id IS NULL`,
      [userId, clipId, [accA, accB]],
    );
    const left = await pool!.query<{ social_account_id: string }>(
      `SELECT social_account_id FROM clip_account_posts WHERE user_id=$1 AND clip_id=$2 ORDER BY social_account_id`,
      [userId, clipId],
    );
    // accA (has a post id) survives; accB (pending, id-less) was released
    expect(left.rows.map((r) => r.social_account_id)).toEqual([accA]);
  });
});
