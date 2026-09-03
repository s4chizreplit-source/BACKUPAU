/**
 * Database schema — single source of truth, safe to run repeatedly
 * (IF NOT EXISTS everywhere).
 *
 * Used from two places:
 *   1. Server startup (src/index.ts) — so every environment (dev, VM deploy)
 *      self-heals its schema before serving requests. Without this, publishing
 *      new code that expects a new column breaks until someone runs db:init.
 *   2. The manual `pnpm run db:init` script (src/db-init.ts).
 */
import type { Pool } from "pg";

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS users (
    id          TEXT PRIMARY KEY,               -- usr_<random>
    email       TEXT        NOT NULL,
    created_at  TIMESTAMPTZ DEFAULT NOW()
  );

  ALTER TABLE users
    ADD COLUMN IF NOT EXISTS password_hash  TEXT,
    ADD COLUMN IF NOT EXISTS name           TEXT,
    ADD COLUMN IF NOT EXISTS role           TEXT NOT NULL DEFAULT 'user',
    ADD COLUMN IF NOT EXISTS status         TEXT NOT NULL DEFAULT 'active',
    ADD COLUMN IF NOT EXISTS plan           TEXT NOT NULL DEFAULT 'none',
    ADD COLUMN IF NOT EXISTS plan_interval  TEXT,
    ADD COLUMN IF NOT EXISTS plan_status    TEXT NOT NULL DEFAULT 'none',
    ADD COLUMN IF NOT EXISTS paid_until     TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS next_refill_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS sub_credits    INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS topup_credits  INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS subscription_cutting_credits INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS subscription_uploading_credits INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS topup_cutting_credits INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS topup_uploading_credits INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS legacy_topup_credits INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS free_trial BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS referral_code  TEXT,
    ADD COLUMN IF NOT EXISTS referred_by    TEXT;

  CREATE UNIQUE INDEX IF NOT EXISTS users_referral_code_idx ON users (referral_code);

  -- Referral program: one row per referred signup. rewarded_at is set exactly
  -- once — when the referred user's first plan purchase pays the referrer.
  CREATE TABLE IF NOT EXISTS referrals (
    id             SERIAL      PRIMARY KEY,
    referrer_id    TEXT        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    referred_id    TEXT        NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
    status         TEXT        NOT NULL DEFAULT 'signed_up',   -- signed_up | rewarded
    reward_credits INTEGER,
    created_at     TIMESTAMPTZ DEFAULT NOW(),
    rewarded_at    TIMESTAMPTZ
  );
  CREATE INDEX IF NOT EXISTS referrals_referrer_idx ON referrals (referrer_id, created_at DESC);


  CREATE TABLE IF NOT EXISTS clip_jobs (
    id             SERIAL      PRIMARY KEY,
    user_id        TEXT        REFERENCES users(id) ON DELETE CASCADE,
    source_url     TEXT        NOT NULL,
    platform       TEXT        NOT NULL DEFAULT 'shorts',
    clip_duration  INTEGER     NOT NULL DEFAULT 60,
    clip_count     INTEGER     NOT NULL DEFAULT 10,
    total_duration TEXT,
    status         TEXT                 DEFAULT 'done',
    created_at     TIMESTAMPTZ DEFAULT NOW()
  );

  -- Finished clip files (object-storage ids + metadata) so a signed-in user
  -- can re-download their clips from any device.
  ALTER TABLE clip_jobs
    ADD COLUMN IF NOT EXISTS clips JSONB;

  -- Rows written after clips became permanent (no storage TTL). Legacy rows
  -- keep FALSE and show the honest "expired" state after their 2h window.
  ALTER TABLE clip_jobs
    ADD COLUMN IF NOT EXISTS files_permanent BOOLEAN NOT NULL DEFAULT FALSE;

  -- Auto-expiry: NULL = saved forever (files_permanent=TRUE clips).
  -- Non-null = timestamp after which the clip files are auto-deleted by the
  -- periodic cleanup job. Default 14 days from creation for new rows.
  ALTER TABLE clip_jobs
    ADD COLUMN IF NOT EXISTS clip_expires_at TIMESTAMPTZ;

  CREATE INDEX IF NOT EXISTS clip_jobs_user_created_idx
    ON clip_jobs (user_id, created_at DESC);

  CREATE INDEX IF NOT EXISTS clip_jobs_expires_idx
    ON clip_jobs (clip_expires_at)
    WHERE clip_expires_at IS NOT NULL AND clips IS NOT NULL;

  -- Email verification OTP tokens sent on signup.
  ALTER TABLE users
    ADD COLUMN IF NOT EXISTS email_verified BOOLEAN NOT NULL DEFAULT FALSE;

  CREATE TABLE IF NOT EXISTS email_verif_tokens (
    id         SERIAL      PRIMARY KEY,
    user_id    TEXT        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    code       TEXT        NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    used       BOOLEAN     NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS email_verif_tokens_user_idx ON email_verif_tokens (user_id);
  -- Clean up expired tokens automatically
  CREATE INDEX IF NOT EXISTS email_verif_tokens_expires_idx ON email_verif_tokens (expires_at);

  CREATE TABLE IF NOT EXISTS credit_ledger (
    id         SERIAL PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    delta      INTEGER NOT NULL,
    bucket     TEXT NOT NULL,
    reason     TEXT NOT NULL,
    meta       JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS credit_ledger_user_idx ON credit_ledger (user_id, created_at DESC);

  CREATE TABLE IF NOT EXISTS billing_requests (
    id            SERIAL PRIMARY KEY,
    user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind          TEXT NOT NULL,
    plan          TEXT,
    plan_interval TEXT,
    pack_id       TEXT,
    credits       INTEGER NOT NULL,
    amount_usd    NUMERIC(10,2) NOT NULL,
    status        TEXT NOT NULL DEFAULT 'pending',
    note          TEXT,
    admin_note    TEXT,
    decided_by    TEXT,
    decided_at    TIMESTAMPTZ,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS billing_requests_status_idx ON billing_requests (status, created_at DESC);
  CREATE INDEX IF NOT EXISTS billing_requests_user_idx ON billing_requests (user_id, created_at DESC);

  -- Whop payment ids are the idempotency key. A replay can never grant twice.
  CREATE TABLE IF NOT EXISTS whop_payments (
    payment_id      TEXT PRIMARY KEY,
    user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    plan_id         TEXT NOT NULL,
    payment_status  TEXT NOT NULL,
    paid_at         TIMESTAMPTZ NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS whop_payments_user_idx ON whop_payments (user_id, created_at DESC);

  CREATE TABLE IF NOT EXISTS password_resets (
    id         SERIAL PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,             -- sha256 of the raw token
    expires_at TIMESTAMPTZ NOT NULL,
    used_at    TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS password_resets_user_idx ON password_resets (user_id, created_at DESC);

  CREATE TABLE IF NOT EXISTS session (
    sid    VARCHAR NOT NULL PRIMARY KEY,
    sess   JSON NOT NULL,
    expire TIMESTAMP(6) NOT NULL
  );
  CREATE INDEX IF NOT EXISTS session_expire_idx ON session (expire);

  -- Resolved download-engine mirrors (direct media links, valid ~7 days).
  -- Durable + shared across instances, so ONE paid conversion serves every
  -- restart and every autoscale instance for the link's whole lifetime
  -- (the in-memory cache dies on restart; see lib/zylaCache.ts).
  CREATE TABLE IF NOT EXISTS zyla_cache (
    video_id     TEXT NOT NULL,
    format       TEXT NOT NULL,
    download_url TEXT NOT NULL,
    title        TEXT,
    expires_at   TIMESTAMPTZ NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (video_id, format)
  );
  CREATE INDEX IF NOT EXISTS zyla_cache_expires_idx ON zyla_cache (expires_at);

  -- Durable coordination for asynchronous clip work.  The JSON payload keeps
  -- this table forward-compatible with the existing JobRecord while the
  -- explicit columns make claiming, leases and queue metrics cheap.
  CREATE TABLE IF NOT EXISTS async_jobs (
    id             TEXT PRIMARY KEY,
    user_id        TEXT REFERENCES users(id) ON DELETE CASCADE,
    status         TEXT NOT NULL DEFAULT 'queued',
    payload        JSONB NOT NULL,
    queue_order    BIGSERIAL UNIQUE,
    attempt        INTEGER NOT NULL DEFAULT 0,
    lease_owner    TEXT,
    lease_token    TEXT,
    lease_until    TIMESTAMPTZ,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS async_jobs_claim_idx
    ON async_jobs (status, queue_order)
    WHERE status = 'queued';
  CREATE INDEX IF NOT EXISTS async_jobs_lease_idx
    ON async_jobs (lease_until)
    WHERE status = 'processing';
  CREATE INDEX IF NOT EXISTS async_jobs_user_idx
    ON async_jobs (user_id, created_at DESC);

  -- A start request consumes paid Zyla quota.  This row is the cross-instance
  -- lease that makes a cache miss safe: only its owner may start a conversion.
  CREATE TABLE IF NOT EXISTS zyla_inflight (
    video_id       TEXT NOT NULL,
    format         TEXT NOT NULL,
    lease_token    TEXT NOT NULL,
    progress_url   TEXT,
    upstream_job_id TEXT,
    lease_until    TIMESTAMPTZ NOT NULL,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (video_id, format)
  );
  CREATE INDEX IF NOT EXISTS zyla_inflight_lease_idx
    ON zyla_inflight (lease_until);

  -- ZapUPI (Indian UPI gateway) payment orders — one row per payment attempt.
  -- status: pending → paid | failed | review. "review" means an admin must
  -- look (amount mismatch / test-environment event); it is NEVER auto-granted.
  -- All state lives here so webhook + return-page confirms are race-safe
  -- across autoscale instances (row lock in confirmZapupiOrder).
  CREATE TABLE IF NOT EXISTS upi_orders (
    order_id      TEXT PRIMARY KEY,
    user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    plan          TEXT NOT NULL DEFAULT '',
    plan_interval TEXT NOT NULL DEFAULT 'monthly',
    amount_inr    INTEGER NOT NULL,
    status        TEXT NOT NULL DEFAULT 'pending',
    payment_url   TEXT,
    txn_id        TEXT,
    utr           TEXT,
    provider_env  TEXT,
    fail_reason   TEXT,
    paid_at       TIMESTAMPTZ,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  ALTER TABLE upi_orders
    ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'subscription',
    ADD COLUMN IF NOT EXISTS topup_cutting INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS topup_uploading INTEGER NOT NULL DEFAULT 0;
  CREATE INDEX IF NOT EXISTS upi_orders_user_idx ON upi_orders (user_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS upi_orders_status_idx ON upi_orders (status, created_at DESC);

  -- Short-lived share tokens that allow Buffer (and similar external services)
  -- to fetch a private clip video without user session auth.
  -- Tokens are valid for 24 hours and cleaned up lazily on read.
  CREATE TABLE IF NOT EXISTS clip_share_tokens (
    token      TEXT PRIMARY KEY,
    clip_id    TEXT NOT NULL,
    owner_id   TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS clip_share_tokens_expires_idx ON clip_share_tokens (expires_at);

  -- Post for Me (postforme.dev): connected social accounts, one row per
  -- (user, provider account). PFM dedupes the same physical account
  -- project-wide — reconnecting overwrites PFM's external_id — so the SAME
  -- pfm_account_id may legitimately appear under several users (a shared
  -- page). THIS table is the ownership authority, never PFM's external_id.
  CREATE TABLE IF NOT EXISTS social_connections (
    id               SERIAL PRIMARY KEY,
    user_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    pfm_account_id   TEXT NOT NULL,
    platform         TEXT NOT NULL,
    username         TEXT,
    display_name     TEXT,
    profile_image    TEXT,
    status           TEXT NOT NULL DEFAULT 'connected',
    autopost_enabled BOOLEAN NOT NULL DEFAULT TRUE,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (user_id, pfm_account_id)
  );
  CREATE INDEX IF NOT EXISTS social_connections_user_idx ON social_connections (user_id, platform);

  -- Master auto-post preference per user (default = auto-post enabled)
  CREATE TABLE IF NOT EXISTS social_user_prefs (
    user_id           TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    auto_post_enabled BOOLEAN NOT NULL DEFAULT TRUE,
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  -- Idempotency markers: one row per (user, clip, social account) makes
  -- posting idempotent — auto-post + manual click can never double-post.
  -- status: 'pending'   = claimed, provider post creation in flight
  --         'submitted' = provider post created, waiting for publish
  --         'posted'    = platform confirmed live
  --         'error'     = platform rejected it (reported once, then freed)
  --         'unknown'   = create outcome ambiguous — blocks duplicates until
  --                       reconciled via post_row_id or force-reposted
  CREATE TABLE IF NOT EXISTS clip_account_posts (
    id                SERIAL PRIMARY KEY,
    user_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    clip_id           TEXT NOT NULL,
    social_account_id TEXT NOT NULL,
    platform          TEXT NOT NULL DEFAULT '',
    pfm_post_id       TEXT,
    post_row_id       TEXT,
    status            TEXT NOT NULL DEFAULT 'pending',
    error             TEXT,
    posted_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (user_id, clip_id, social_account_id)
  );
  CREATE INDEX IF NOT EXISTS clip_account_posts_clip_idx ON clip_account_posts (user_id, clip_id);
  CREATE INDEX IF NOT EXISTS clip_account_posts_pfm_idx  ON clip_account_posts (pfm_post_id);
  -- Explicit YouTube 429 results are safe to retry later: the provider has
  -- already reported this account's upload as failed. Keep retry state on the
  -- per-account marker so a multi-platform post never re-sends accounts that
  -- succeeded.
  ALTER TABLE clip_account_posts
    ADD COLUMN IF NOT EXISTS retry_at    TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS retry_count INT NOT NULL DEFAULT 0;
  CREATE INDEX IF NOT EXISTS clip_account_posts_retry_idx
    ON clip_account_posts (retry_at)
    WHERE status = 'retry_wait';

  -- Mirror of every Post for Me post we create (immediate clip posts, clip
  -- schedules, Drive/Dropbox bulk schedules). PFM stores the media and
  -- publishes scheduled posts itself — these rows only feed the calendar and
  -- status UI, and id doubles as the PFM external_id (idempotency key).
  -- status: queued → (provider handoff) → scheduled → processing → posted
  --         creating = immediate post mid-create; failed/cancelled/deleted/unknown
  CREATE TABLE IF NOT EXISTS social_posts (
    id           TEXT PRIMARY KEY,
    user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    pfm_post_id  TEXT,
    source       TEXT NOT NULL DEFAULT 'schedule',
    clip_id      TEXT,
    batch_id     TEXT,
    media_url    TEXT,
    file_name    TEXT NOT NULL DEFAULT '',
    caption      TEXT NOT NULL DEFAULT '',
    account_ids  TEXT[] NOT NULL DEFAULT '{}',
    platforms    TEXT[] NOT NULL DEFAULT '{}',
    scheduled_at TIMESTAMPTZ,
    status       TEXT NOT NULL DEFAULT 'queued',
    attempts     INT NOT NULL DEFAULT 0,
    error        TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS social_posts_user_idx  ON social_posts (user_id, scheduled_at);
  -- claim_idx covers both arms of the drain's claim query (queued + stale
  -- creating); it replaces the old queued-only queue_idx.
  DROP INDEX IF EXISTS social_posts_queue_idx;
  CREATE INDEX IF NOT EXISTS social_posts_claim_idx ON social_posts (scheduled_at) WHERE status IN ('queued','creating');
  CREATE INDEX IF NOT EXISTS social_posts_pfm_idx   ON social_posts (pfm_post_id);
  -- campaign aggregates + per-campaign post lists filter on batch_id; without
  -- this every Auto-Pilot page poll scans all of a user's posts.
  CREATE INDEX IF NOT EXISTS social_posts_batch_idx ON social_posts (batch_id) WHERE batch_id IS NOT NULL;

  -- Posting credits (lib/postCredits.ts): non-clip media charges
  -- CREDITS_PER_POST at provider hand-off. The reservation split lives on the
  -- row so retries can never double-charge and the refund sweep can undo
  -- terminal rows. hold_until parks rows while the balance is empty — they
  -- resume automatically after a top-up.
  ALTER TABLE social_posts
    ADD COLUMN IF NOT EXISTS credit_sub_spent   INT NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS credit_topup_spent INT NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS credit_legacy_spent INT NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS hold_until         TIMESTAMPTZ;

  -- Native YouTube scheduling (campaign lead window): the row is handed to
  -- the provider EARLY with youtube.publish_at + privacy 'private', so the
  -- video sits in YouTube Studio under "Scheduled" during the lead window.
  -- yt_native_publish marks the mode at hand-off; yt_uploaded_at records the
  -- confirmed private upload. Such rows stay 'scheduled' until the slot
  -- passes — a provider success BEFORE the slot means "uploaded", not
  -- "public", and mapping it to 'posted' would kill cancellability and lie
  -- in campaign progress.
  ALTER TABLE social_posts
    ADD COLUMN IF NOT EXISTS yt_native_publish BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS yt_uploaded_at    TIMESTAMPTZ;

  -- Auto-Pilot campaigns: reusable "post this public Drive/Dropbox folder to
  -- these accounts" templates — date range + times-of-day + N videos per time,
  -- with a master on/off switch. A materializer turns each campaign-day into
  -- ordinary social_posts rows (source='campaign', batch_id=campaign id), so
  -- the existing scheduler drain does all actual posting.
  -- status: active | exhausted (folder used up; re-enable/edit re-checks)
  -- start/end/last_planned dates are wall-clock YYYY-MM-DD in the campaign timezone.
  CREATE TABLE IF NOT EXISTS social_campaigns (
    id                TEXT PRIMARY KEY,
    user_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name              TEXT NOT NULL DEFAULT '',
    source_url        TEXT NOT NULL,
    account_ids       TEXT[] NOT NULL DEFAULT '{}',
    times             TEXT[] NOT NULL DEFAULT '{}',
    per_slot          INT  NOT NULL DEFAULT 1,
    start_date        TEXT NOT NULL,
    end_date          TEXT NOT NULL,
    timezone          TEXT NOT NULL DEFAULT 'UTC',
    caption           TEXT NOT NULL DEFAULT '',
    ai_captions       BOOLEAN NOT NULL DEFAULT FALSE,
    source_kind       TEXT NOT NULL DEFAULT 'folder',
    clip_job_id       TEXT,
    clip_status       TEXT,
    clip_params       JSONB,
    enabled           BOOLEAN NOT NULL DEFAULT TRUE,
    status            TEXT NOT NULL DEFAULT 'active',
    last_planned_date TEXT,
    last_error        TEXT,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  ALTER TABLE social_campaigns
    ADD COLUMN IF NOT EXISTS ai_captions BOOLEAN NOT NULL DEFAULT FALSE;
  ALTER TABLE social_campaigns
    ADD COLUMN IF NOT EXISTS source_kind TEXT NOT NULL DEFAULT 'folder';
  ALTER TABLE social_campaigns
    ADD COLUMN IF NOT EXISTS clip_job_id TEXT;
  ALTER TABLE social_campaigns
    ADD COLUMN IF NOT EXISTS clip_status TEXT;
  ALTER TABLE social_campaigns
    ADD COLUMN IF NOT EXISTS clip_params JSONB;
  -- "Schedule ahead": hand posts to the provider only N minutes before their
  -- slot (they appear as Scheduled on the platform from that moment). NULL =
  -- hand off as soon as the day is planned (legacy behavior).
  ALTER TABLE social_campaigns
    ADD COLUMN IF NOT EXISTS handoff_lead_minutes INT;
  CREATE INDEX IF NOT EXISTS social_campaigns_user_idx   ON social_campaigns (user_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS social_campaigns_active_idx ON social_campaigns (status) WHERE enabled;

  -- Detected videos per campaign. post_row_id set = consumed (materialized
  -- into social_posts) — each video posts at most once per campaign; freed
  -- (set back to NULL) when the campaign is paused before the post went out.
  CREATE TABLE IF NOT EXISTS social_campaign_items (
    id          SERIAL PRIMARY KEY,
    campaign_id TEXT NOT NULL REFERENCES social_campaigns(id) ON DELETE CASCADE,
    url         TEXT NOT NULL,
    file_name   TEXT NOT NULL DEFAULT '',
    sort_order  INT  NOT NULL DEFAULT 0,
    post_row_id TEXT,
    planned_for TIMESTAMPTZ,
    skipped     BOOLEAN NOT NULL DEFAULT FALSE,
    UNIQUE (campaign_id, url)
  );
  -- skipped = held-back backlog (Instagram "past videos" limit). The rows
  -- must EXIST so the daily rescan's known-set doesn't re-add them as new.
  ALTER TABLE social_campaign_items
    ADD COLUMN IF NOT EXISTS skipped BOOLEAN NOT NULL DEFAULT FALSE;
  CREATE INDEX IF NOT EXISTS social_campaign_items_free_idx
    ON social_campaign_items (campaign_id, sort_order) WHERE post_row_id IS NULL;

  -- Post for Me webhook registrations: url → shared secret used to verify
  -- incoming deliveries (Post-For-Me-Webhook-Secret header, plain compare).
  CREATE TABLE IF NOT EXISTS pfm_webhooks (
    url        TEXT PRIMARY KEY,
    webhook_id TEXT,
    secret     TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
`;

/** Create/upgrade all tables. Idempotent; throws on hard failures. */
export async function ensureSchema(pool: Pool): Promise<void> {
  // Postgres runs a multi-statement query as ONE implicit transaction — a
  // single failing statement (e.g. a legacy table shape on a self-hosted box)
  // silently rolled back EVERY later CREATE TABLE too, which is how a prod
  // server ended up missing the social tables while boot said "continuing".
  // Run each statement on its own: whatever can heal, heals; failures are
  // collected and thrown at the end so the boot log names the exact culprits.
  const statements = SCHEMA_SQL
    // Strip -- line comments BEFORE splitting: comments may contain ";",
    // which would otherwise split mid-comment and glue the comment's tail
    // onto the next statement (→ bogus syntax errors).
    .replace(/--[^\n]*/g, "")
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  const failures: string[] = [];
  for (const stmt of statements) {
    try {
      await pool.query(stmt);
    } catch (err) {
      failures.push(`${stmt.replace(/\s+/g, " ").slice(0, 90)}… → ${(err as Error).message}`);
    }
  }

  // Case-insensitive email uniqueness. Legacy rows may contain duplicate
  // emails — report them instead of aborting the whole init.
  try {
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_idx ON users (lower(email))`);
  } catch (err) {
    const dupes = await pool.query(
      `SELECT lower(email) AS email, COUNT(*)::int AS n FROM users GROUP BY lower(email) HAVING COUNT(*) > 1 LIMIT 5`,
    );
    console.error(
      "[schema] could not create unique email index — fix these duplicate emails manually:",
      (err as Error).message, dupes.rows,
    );
  }

  if (failures.length > 0) {
    throw new Error(
      `[schema] ${failures.length}/${statements.length} statement(s) failed (all others were applied):\n  • ${failures.join("\n  • ")}`,
    );
  }

  // Versioned data migration, deliberately outside SCHEMA_SQL: the generic
  // semicolon splitter cannot safely run a PL/pgSQL block.  Its marker makes
  // this a one-time, non-destructive upgrade rather than a boot-time rewrite.
  await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const claimed = await client.query(
      `INSERT INTO schema_migrations (name) VALUES ('dual_inr_billing_v1') ON CONFLICT DO NOTHING RETURNING name`,
    );
    if (claimed.rowCount) {
      // Legacy topups were a shared balance. Preserve it exactly once. Active
      // starter/pro subscriptions become the equivalent stable tiers.
      // Old credits were denominated at 50 per generated clip. A partial old
      // clip is rounded up so the one-time migration cannot take value away.
      await client.query(`UPDATE users SET
        legacy_topup_credits = CEIL(topup_credits / 50.0)::INTEGER,
        free_trial = CASE
          WHEN plan='none' AND plan_status='none' THEN TRUE
          ELSE free_trial
        END`);
      await client.query(`UPDATE users SET plan = CASE plan WHEN 'starter' THEN '100' WHEN 'pro' THEN '250' ELSE plan END`);
      await client.query(`UPDATE users SET
        subscription_cutting_credits = CASE
          WHEN plan_status='active' AND plan='100' THEN 100
          WHEN plan_status='active' AND plan='250' THEN 250
          ELSE CEIL(sub_credits / 50.0)::INTEGER
        END,
        subscription_uploading_credits = CASE WHEN plan_status='active' AND plan='100' THEN 100 WHEN plan_status='active' AND plan='250' THEN 250 ELSE 0 END`);
    }
    // A corrective marker is intentionally separate: development briefly ran
    // v1 before the old 50-units-per-output conversion was finalized. Running
    // this after v1 is harmless on fresh environments and repairs those rows.
    const corrected = await client.query(
      `INSERT INTO schema_migrations (name) VALUES ('dual_inr_legacy_conversion_v2') ON CONFLICT DO NOTHING RETURNING name`,
    );
    if (corrected.rowCount) {
      await client.query(`UPDATE users SET
        legacy_topup_credits = CEIL(topup_credits / 50.0)::INTEGER,
        subscription_cutting_credits = CASE
          WHEN plan_status='active' AND plan='100' THEN subscription_cutting_credits
          WHEN plan_status='active' AND plan='250' THEN subscription_cutting_credits
          ELSE GREATEST(subscription_cutting_credits, CEIL(sub_credits / 50.0)::INTEGER)
        END,
        free_trial = CASE
          WHEN plan='none' AND plan_status='none' THEN TRUE
          ELSE free_trial
        END`);
    }
    // Old subscription credits were not bucket-specific. Keep any lapsed
    // remainder shared so reactivation restores its original usefulness for
    // either cutting or uploading, rather than narrowing it to cutting only.
    const sharedLegacy = await client.query(
      `INSERT INTO schema_migrations (name) VALUES ('dual_inr_shared_legacy_v3') ON CONFLICT DO NOTHING RETURNING name`,
    );
    if (sharedLegacy.rowCount) {
      await client.query(`UPDATE users SET
        legacy_topup_credits =
          CEIL(topup_credits / 50.0)::INTEGER + CEIL(sub_credits / 50.0)::INTEGER,
        subscription_cutting_credits = 0,
        subscription_uploading_credits = 0
        WHERE plan_status <> 'active'`);
    }
    await client.query("COMMIT");
  } catch (err) {
    try { await client.query("ROLLBACK"); } catch { /* ignore */ }
    throw err;
  } finally {
    client.release();
  }
}
