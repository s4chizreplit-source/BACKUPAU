---
name: Clip-link Auto-Pilot campaigns
description: Design invariants for campaigns that generate their own clips from a pasted video link (source_kind='clip_link').
---

# Clip-link campaigns (video link → auto-clips → scheduled posting)

Flow: UI starts the clip job first (`POST /video/clip` async, credits reserved there), then creates the campaign with `sourceKind:'clip_link'` + `clipJobId`. Items are stored as `url = "clip:<fileId>"`; a fresh share token is minted only at provider-handoff time (tokens expire — same pattern as Drive confirm tokens).

**Rules that must hold:**
- **Job-before-campaign race → double-post.** The job can settle (esp. warm cache hits) before the campaign row commits, so "no campaign found at settle" must NOT mean "instant auto-post". Persist a `forCampaign` flag on the job record at start; the settle hook suppresses instant auto-post on that flag alone. The lazy reconciler in GET /social/campaigns feeds the campaign later.
  **Why:** posting the same clip twice is worse than posting a bit later; campaign handoff doesn't share the instant-autopost claim markers, so nothing else dedupes across the two paths.
- **Verify job ownership at campaign create** (readJobAnywhere → `userId` must match), with one generic error so job-id existence never leaks. Ingest also matches `clip_job_id AND user_id` — ownership by construction, but without the create-time check a foreign jobId parks a campaign in 'clipping' forever.
- **Materializer must not consume the day** while `clip_status != 'ready'` (return before last_planned_date update) — today's slots then catch up when clips land. Folder rescan stays gated to `source_kind='folder'` (expandSource on a video URL would insert the raw video as an item).
- Ingest is idempotent via `UNIQUE(campaign_id,url)` + ON CONFLICT DO NOTHING; 0 clips out → campaign fails with a human message. Reconciler fails campaigns whose job is missing >45min (accepted risk: readJobAnywhere null conflates absence with storage outage — fine on single-instance VPS).
- **UI honesty:** if campaign create fails after the job started, tell the user clips still land in My videos. Editing never changes the source of a clip_link campaign (input disabled, patch skipped).
