---
name: Clip retention & schema self-heal
description: Clips are permanent (no TTL); invariants for cleanup, history delete, and DB schema at boot.
---

## Clips are permanent — user decision
- Null expiry marks a permanent file; only legacy numeric-TTL entries may ever be auto-deleted. Under size-cap pressure, refuse NEW uploads and warn — never delete a permanent clip.
- **Why:** founder decision (Jul 2026): clips must stay downloadable forever from account history on any device; deleting user clips is worse than refusing new ones.
- **How to apply:** any new sweeper or cap logic must skip null-expiry entries. Local disk copies are only a re-downloadable cache and may be aged out by mtime.

## Reclaim + honesty invariants
- User-initiated history delete is the ONLY reclaim path for permanent files: delete bucket objects BEFORE the DB row, and fail the request when storage is unreachable (idempotent, so the user can retry). No sweeper will ever pick these up.
- Only advertise permanence the server verified (file actually present in the bucket) — a storage outage can leave clips local-only, and those die with the local cache.
- Storage byte counter: optimistic increment on store, decrement only on CONFIRMED deletes, clamp ≥ 0; the periodic sweep rescan stays authoritative.

## Schema self-heals at server startup
- The idempotent schema (IF NOT EXISTS everywhere) runs at server boot; the standalone db:init script is a thin wrapper kept for manual/post-merge runs.
- **Why:** VM deploys never ran db:init — publishing code that expects a new column 500'd in prod until someone intervened manually.
- **How to apply:** new columns/tables go in the shared schema module, never only in a script.

## Per-statement schema healing (added 2026-08-10)
- A multi-statement pool.query is ONE implicit transaction: a single legacy-incompatible statement used to roll back every later CREATE TABLE — prod served for days without the social tables while boot said "continuing with existing schema".
- ensureSchema now strips -- line comments (they can contain ";"), splits per statement, applies everything it can, then throws naming the exact failed statements so journalctl shows the culprits.
