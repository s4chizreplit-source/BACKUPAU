---
name: Auto-Pilot campaign materializer invariants
description: Race-safety rules for the social campaign materializer (folder → daily social_posts) and the clip-link retry flow — keep these when editing campaigns/scheduling code.
---

# Auto-Pilot campaign invariants

Campaigns materialize one campaign-day at a time into ordinary `social_posts`
rows (`source='campaign'`, `batch_id=campaign id`); the existing scheduler
drain does all posting. The materializer holds `FOR UPDATE SKIP LOCKED` on the
campaign row and advances `last_planned_date` under that lock.

**Rules (review-found races — keep them):**

1. **Disable-first teardown.** Pause/delete must first commit `enabled=FALSE`
   on the campaign row (a plain UPDATE waits out an in-flight materializer's
   row lock), and only THEN cancel queued rows / delete. Cancel-then-delete
   without disabling lets a concurrent materializer commit a post nobody
   cancels.
   **Why:** the materializer runs on a timer on every instance; the row lock is
   the only serialization point.

2. **Never reset the planning cursor on edits.** `last_planned_date` must NOT
   be nulled when dates/times/etc. change — `nextMaterializeDate` clamps into
   the edited range on its own, and a reset re-plans a day whose posts are
   already queued → double-posting. The ONLY reset is resume-after-pause,
   because pause already cancelled the queued rows.

3. **Mostly partial PATCH from the UI.** The edit form sends only changed fields
   except caption + AI-caption settings, which are always reaffirmed so queued
   captions can be refreshed. It never sends `timezone` on edit (times were
   entered relative to the original zone; another zone would shift every slot).

4. Missed whole DAYS are skipped, never backfilled (`nextMaterializeDate`
   clamps up to today). But TODAY's already-passed slots are caught up, not
   dropped: `planDaySlots` reschedules them at now+5min staggered 10min apart
   (user expectation: a campaign created/edited mid-day still posts today's
   quota). `nextRunAt` mirrors this only when `last_planned_date < today` —
   once today is consumed it must NOT advertise a catch-up. Item consumed =
   `post_row_id` set, freed only when its post row is `cancelled`.

5. **Instagram sources are living profiles.** Items are durable refs
   `ig:<username>:<kind>:<mediaId>` (kind=post|reel) — never CDN URLs (IG signed
   links rot in hours). The posting drain resolves them to an HMAC relay URL
   (`/api/ig/relay/:token`, SESSION_SECRET-signed, fields `~`-joined because `~`
   can't appear in IG usernames/ids) which re-fetches a fresh CDN link at
   publish time through the Meta-CDN allowlist streamer. Rescan runs EVERY
   planned day (not only when short); new finds front-insert with
   sort_order < MIN(sort_order) so they post at the NEXT slot ahead of backlog.
   Instagram campaigns must NEVER flip to `exhausted` — the materializer only
   selects `status='active'`, so a one-time exhaust would kill new-reel
   discovery forever (architect-caught bug). Empty backlog = consume the day,
   stay active; end_date alone stops planning (and paid rescans). Source is
   immutable on PATCH (users must create a new campaign). Zyla IG lists cache
   30 min per username → campaign tests use fresh usernames per phase or the
   exported cache-clear test hook to simulate "next day".

6. **Clip retry ("Try clips again").** Failed clip-link campaigns retry by the
   FRONTEND starting a replacement `/video/clip` job (job params are not
   reconstructable server-side; the campaign's `clip_params` JSONB stores
   {clipCount, quality} for replay — legacy rows null → UI defaults), then a
   retry route attaches the new jobId. The failed→clipping flip must be a
   CONDITIONAL update (`WHERE clip_status='failed'`) so concurrent retries
   can't double-attach — the loser's job stays a harmless orphan because
   forCampaign jobs never auto-post. Reject retry when end_date < today in the
   campaign tz (a paid job could never post). Job-attach ownership checks
   deliberately mirror create: own job, not error/cancelled; attaching your
   own older job is allowed (clips are yours either way).

**How to apply:** any new campaign teardown path, bulk edit, or "re-plan"
feature must go through disable-first + cancel + (optional) cursor reset, in
that order, and prove no day can be planned twice. Any new clip_status
transition must be a conditional UPDATE, and any flow that starts a paid job
on a campaign's behalf must check the campaign can still post first.

## Caption-mode contract
Caption modes are strict and mutually exclusive: filename mode alone may use a
readable filename; custom mode must reuse the exact saved text for every video;
AI mode must use a generated viral caption and may only fall back to a generic
viral caption, never to the filename. The campaign post list shows the actual
caption rather than the source filename. Caption-mode edits refresh only future
rows still waiting locally; provider-handed-off and posted rows are immutable.

**Why:** silently treating Gemini timeout/unavailability as filename mode made
the selected AI option appear ignored and could publish raw `.mp4` names.

**How to apply:** keep AI precedence over stale custom text, preserve custom
text verbatim, and condition any repair UPDATE on local queued/creating status
with no provider post ID.

## Backlog limit (post only newest-N past videos)
- Held-back old videos MUST still be inserted as rows with skipped=TRUE. **Why:** the daily rescan's known-set is ARRAY_AGG of existing item urls — omitted rows make the rescan front-insert old page-1 videos as "new". Planner excludes via AND NOT skipped; progress counts use COUNT(*) FILTER (WHERE NOT skipped).
- "Newest N" is only correct after GLOBAL time ordering: reels and feed posts arrive as two separate newest-first lists, so tail-of-merged-lists picks wrong videos. Sort merged list newest-first by taken_at (inherit it down to mediaList children exactly like code/caption) only when ALL items have parseable stamps; otherwise keep list order as the deterministic fallback.
- backlogLimit is create-only + instagram-only (int 0..MAX_ITEMS; 0 = future uploads only; absent = all). Response `queued` = detected − held; rescan-inserted new uploads default skipped=FALSE so they always post.

## One clip per posting time (strict pairing)
Rule: every posting time gets exactly ONE clip, and clip campaigns must keep clip count == number of posting times; per-slot multipliers are always coerced to 1.
**Why:** the old times × per-slot multiplication silently posted far more per day than users expected (3×3=9); the user wants one clip per time, each clip with its own slot.
**How to apply:** enforce the pairing at EVERY entry point that creates/edits a clip campaign or attaches a clip job (create, schedule edit, retry, future bulk/admin paths); legacy rows keep their old multiplier until a schedule edit migrates them.

## Missed-slot grace (burst-posting fix, 2026-08-21)
A campaign created mid-day used to "catch up" ALL already-passed daily slots at now+5min staggered 10min apart — user with slots 12:00/16:00/18:00 IST creating at ~17:56 got 3 posts in a 10-minute burst. Rule now: slots more than 30 min late (LATE_GRACE_MS in routes/campaigns.ts) are DROPPED for the day — queued videos simply ride the next day's slots; slots ≤30 min late still recover at now+5min. nextRunAt display mirrors the same rule (rolls to tomorrow when today's slots are all beyond grace). materializeOne's empty-plan branch is a real path that must still consume the day (advance last_planned_date) or it re-plans forever.

## Campaigns must live on the deployment, not the dev preview
The posting provider fetches/validates relay media at PUBLISH time, not at hand-off. A campaign created in the dev workspace mints dev-domain relay URLs; the workspace is usually asleep at slot time, so every post fails with "All media failed to process" even though same-day catch-up posts (workspace awake) succeed.
**How to apply:** real campaigns belong on the always-on deployment. When a user reports this exact provider error, check the media URL host on the provider's post record first (dev domain = wrong environment or stale PUBLIC_APP_URL, see env-quirks).

## Native YouTube scheduling (lead window)
- Rows from campaigns with handoff_lead_minutes + ALL-YouTube targets + slot >2min away hand off natively: upload NOW as private with youtube publish_at=slot (NO provider scheduled_at) → video sits in YT Studio "Scheduled" through the lead window and YT itself publishes on time. Everything else (NULL lead, manual schedule rows, mixed platforms, late catch-up) stays provider-scheduled.
- Lifecycle trap: provider success BEFORE the slot = uploaded-private, NOT public. Such rows keep status 'scheduled' (marker yt_native_publish, upload recorded in yt_uploaded_at); drain housekeeping flips 'posted' once the slot passes. Mapping early success → 'posted' killed cancel/pause and lied in campaign progress.
- Cancel after native hand-off is refused with an honest message: deleting the PFM record does NOT pull the video off YouTube — only YT Studio can.
**Why:** users judge the lead feature by "does it show under Scheduled in YT Studio"; provider-side scheduling uploads only at publish time, so it never did.
**How to apply:** any new social_posts status writer must not promote yt_native_publish rows to 'posted' while scheduled_at is still in the future.
