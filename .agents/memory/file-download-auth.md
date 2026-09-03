---
name: File download authorization
description: Trust model for clip/file serving — ownerId, verified history rows, job records; invariants new code must keep
---

# File download authorization (clips, ZIPs, tool outputs)

File URLs used to be public bearer-token style; now every file/ZIP route requires a session + ownership. Three trusted sources, in order:

1. **meta.ownerId** — stamped by storeFile at creation (fast path, no lookups).
2. **clip_jobs history rows** — durable, cross-instance. Trusted ONLY because the single writer (`POST /history`) server-verifies every client-posted clip id before insert (id must appear in the user's own durable job records, or the file meta must carry their ownerId; unverified ids dropped + logged).
3. **Durable job records (JOBS_DIR)** — written exclusively by the clip pipeline, so server-authored; covers the window between "job finished" and "history saved".

Invariants any future change MUST keep:
- **Any new writer to clip_jobs.clips must verify ids the same way** — an unverified row is a download grant (this exact hole was caught in review: attacker posts a foreign id into their history, then downloads it).
- **Never deny on ownerId mismatch alone.** The 2h result cache serves the SAME clip file ids to different paying users, so one id legitimately belongs to several accounts; the history/job-record fallbacks are what authorize the later ones.
- Admin bypasses; positive-only in-process access cache (video Range requests re-hit the route per seek); Range/206 must survive any middleware added to these routes.
- Meta-only reads (no media download) exist for cheap bulk verification — use those when checking many ids.
- Pre-lockdown clip_jobs rows are grandfathered as trusted (files were fully public before, so they grant nothing new).
- Paid warm-up endpoint is credit-gated: below one clip's cost it silently no-ops instead of triggering a paid engine start.
