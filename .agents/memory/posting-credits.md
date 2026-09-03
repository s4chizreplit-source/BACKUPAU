---
name: Posting credits (Auto-Pilot / bulk schedule)
description: How drain-managed social posts charge 50 credits at provider hand-off, and the refund ambiguity rules that stop double-charges and free posts.
---

**Rule:** Drain-managed posts (source `schedule`/`campaign`) with non-clip media (Drive/Dropbox/IG/pasted URL) charge `CREDITS_PER_POST` at provider hand-off. Clip media (`clip_id` set or `media_url` starting `clip:`) posts free — it paid at clip generation. Manual `source='clip'` never charges.

**Why:** Before this, Auto-Pilot/Drive posting was unlimited and free on any plan, making subscriptions meaningless. Charge point = hand-off (the moment we commit the post to the provider), not row creation, so cancels before hand-off never touch credits.

**How to apply:**
- Charge is ONE tx: reserve + stamp split onto the row (`credit_sub_spent`/`credit_topup_spent`) with predicate `status='creating' AND both markers = 0`. The zero-marker predicate is the double-charge guard — stale reclaim can hand the same row to two workers, and without it the second reserve silently overwrites the first split (architect caught this). rowCount 0 → LostRace → whole tx rolls back.
- Non-zero markers = already charged → retries skip the charge (`needsPostCharge`).
- Insufficient credits → row back to `queued` + `hold_until` (claim skips future holds) → auto-resumes after top-up; schedule rows give up after 7 days past slot; campaign rows also die at hand-off >30 min past slot (late-grace const duplicated in social routes — campaigns module imports social, so importing the const back would cycle).
- Refunds live in ONE idempotent sweep over terminal rows (failed/cancelled/deleted) still carrying a charge — never sprinkle refunds in failure writers. Ambiguity classes are the money-critical part:
  - `pfm_post_id` set → provider outcome known → refund immediately (works with provider down; sweep must run even when the provider is unconfigured).
  - `pfm_post_id` null → the ambiguous create may have landed → verify by external id (= row id) first: found+failed → HEAL row back to lifecycle and keep the charge; found+cancelled/deleted → provider delete THEN refund; definite not-found → refund; lookup error/no provider → keep charge, retry next sweep. Refunding blind here = free posts every provider outage.
- Ledger reasons: `post_reserve` / `post_refund`. Test suite exercises the full matrix against the real dev DB.
