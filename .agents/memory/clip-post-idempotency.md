---
name: Clip post idempotency
description: Provider-agnostic invariants that stop double-posting clips to social accounts
---

Rules for posting clips to social platforms via any external provider (currently Post for Me):

1. **Claim before post.** Insert a per-(user, clip, account) marker with `INSERT … ON CONFLICT DO NOTHING` BEFORE any provider call; only rows you actually claimed get posted. A unique index is the real lock — app-level checks alone always race.
2. **Release only on definite reject.** Free claims only when the provider definitively rejected (4xx). Ambiguous outcomes (5xx, network error, timeout) may have created a post — mark `unknown` and recover deterministically by querying the provider with your own external id; never blind-release, never blind-retry.
3. **Sweeps must be conditional.** A "stale pending" cleanup may delete a row ONLY if it is still id-less at delete time (`DELETE … WHERE status='pending' AND provider_post_id IS NULL`). Sweeping a row that recorded its provider post id re-opens the claim while the post is live → duplicate on next tap.
4. **Never demote posted.** Late failure events/retried webhooks must not downgrade an already-posted marker. Errors are surfaced once to the user, then the marker is freed for retry.
5. **UI mirrors provider truth.** Per-account status comes from provider post state + per-account results, self-healing (gone posts free markers; result success promotes). Optimistic settles need an age threshold, not hope.

**Why:** every one of these came from a real double-post or stuck-forever bug with the previous provider; the claims table + conditional sweeps survived the provider swap unchanged.

**How to apply:** any new code path that writes to the claims table must keep the unique index, the conditional-delete pattern, and the definite-reject-only release. Test files cover each invariant — extend them, don't delete.
