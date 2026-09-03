---
name: Post for Me posting provider
description: Active social auto-posting provider (replaced bundle.social, Aug 2026) — API quirks, Quickstart project limits, ownership and webhook rules
---

Post for Me (postforme.dev, user's Pro plan) is the ONLY posting provider. bundle.social is fully removed.

**API basics.** Base `https://api.postforme.dev/v1`, `Authorization: Bearer POSTFORME_API_KEY` (server-only secret — never in client code or logs). Platform slugs lowercase: facebook, instagram, x, tiktok, youtube, pinterest, linkedin, bluesky, threads, tiktok_business. Post status enum `draft|scheduled|processing|processed`; per-account outcomes ONLY via `GET /social-post-results?post_id=` (`success` flag + error). `DELETE /social-posts/:id` cancels (404 = already gone). `GET /social-posts?external_id=` recovers ambiguous creates.

**Ownership.** Accounts/posts are tagged `external_id = user_<id>`, but PFM dedupes the same physical account project-wide — the local connections table is the ownership authority. Every route taking account ids must verify locally and 403 on foreign ids; never trust PFM's external_id alone.

**Quickstart project limits (user's current plan tier).**
- Platforms must be ENABLED per-platform in PFM dashboard → Project Setup, else auth-url returns 404 "Social provider app credentials not found". This is user-side config, not code.
- `redirect_url_override` is REJECTED ("Redirect URL Override is not allowed for Quickstart Projects") — the dashboard's single Project Redirect URL is used. Code sends the override first and auto-falls back without it on that error, so it works on both project tiers.
- Consequence: OAuth always lands on the dashboard-configured (prod) callback even when initiated from dev; dev still picks the account up via external_id sync on the next accounts load.

**Why:** all three discovered by live smoke against the real key; the error precedence (override-check vs credentials-check) differs per platform, so don't infer enablement from which error comes back.

**Login variants.** When BOTH login variants of a platform are enabled in the PFM dashboard, auth-url REQUIRES `platform_data: { <platform>: { connection_type } }` (nested by platform key, same pattern as post platform_configurations) — instagram: "instagram"|"facebook", x: "oauth1"|"oauth2". Top-level `connection_type` is silently ignored (same 400 repeats). Whitelist-validate client input server-side; default x→oauth2. Bluesky auth-url returns 201 with an EMPTY `url` (app-password platform, no OAuth page) — treat empty url as not-connectable-via-API and surface honestly instead of a generic 502.

**Webhooks.** Deliveries carry plain-compare header `Post-For-Me-Webhook-Secret`; must 2xx within ~1s (PFM retries ~8x/24h). Verify via cached DB secrets: primed at boot, stale-served on DB error, sub-second race → 401 fail-closed on timeout. Ack first, process async + idempotent (replays and late events must be no-ops; never demote a posted marker).

**Media.** PFM fetches media by URL at/near publish time. User-supplied URL scheduling must pass a DNS-resolving SSRF check (`urlResolvesPublic`) at enqueue AND again at handoff; Drive confirm tokens are one-time so direct-URL resolution happens at handoff, not enqueue. Scheduler drain: `FOR UPDATE SKIP LOCKED` lease + attempts cap + never schedule in the past.

**How to apply:** any new posting feature goes through the local ownership check + claim markers (see clip-post-idempotency.md); any new user-URL intake needs the DNS-level SSRF check; platform enablement problems are dashboard config, surface them honestly (409) instead of retrying.

## 'processed' is NOT success (Aug 2026 incident)
PFM post status 'processed' only means "finished attempting". Truth lives in per-account results (`GET /social-post-results?post_id=`). Blind processed→posted showed POSTED ✓ while every account had failed.
**Rule:** aggregate mapping — all-fail→failed (+real error), partial→posted+surfaced error, empty results→processing with 15-min optimistic grace. Every aggregate status write is compare-and-set on the observed status so webhook truth beats stale refresh/cached views. Never demote per-account clip_account_posts 'posted' markers; only the aggregate row self-corrects.

## Scheduled (delayed) posts have their own status
PFM `scheduled|draft` must map to a distinct 'scheduled' clip status — folding them into 'processing' lets the UI's capped fast-poll window settle them as fake POSTED. Provider-unreachable fallback: a non-posted marker whose linked social_posts row has a FUTURE scheduled_at reports 'scheduled', never 'processing'. UI rule: scheduled cards use a slow uncapped watch; the capped 5s poll is only for actively-publishing posts, and its give-up fallback may only promote 'processing'→'posted', nothing else.

## Drive media must be relayed
PFM's fetcher cannot consume drive.google.com direct/confirm URLs (one-time confirm tokens rot, big files hit the "can't scan for viruses" HTML interstitial) → all-account media failure. Hand PFM our signed relay URL (`/api/video/gdrive-relay/<HMAC token>`, SESSION_SECRET-signed, stateless) and re-resolve Drive fresh per fetch. TTL must outlive the PUBLISH moment (provider fetches bytes at publish, not at handoff) — stretch by scheduled_at, clamp 30–400d.

The Drive relay must identify downloads as `video/mp4` (Drive often says `application/octet-stream`) and forward byte-range requests, including `206`, `Content-Range`, and `Accept-Ranges`. PFM probes seekability before TikTok ingest and rejects a full-body octet-stream response as “All media failed to process” even when every byte is reachable.

Drive phone exports named `.mov`/`.m4v` need an actual H.264/AAC MP4 transcode before TikTok handoff; changing only the response MIME type is insufficient. PFM may fetch the MOV successfully and still return the generic “Failed to post to TikTok.”

TikTok `reached_active_user_cap` is an app/provider quota rejection at `/v2/post/publish/video/init/`, before media upload. Successful OAuth refresh + creator lookup confirms reconnecting/transcoding cannot fix it; the provider must gain cap or wait for reset.

## Empty results ≠ evidence (never optimistic-promote)
Rule: a post may only be shown/stored as posted when an explicit per-account SUCCESS result exists. PFM 'processed' with zero visible results means "truth not visible yet" → stay processing. A failed results fetch must surface as ambiguous state (null), never be swallowed into an empty list — empty-by-error is indistinguishable from empty-by-truth and gets misread as "nothing failed".
**Why:** live incident (Aug 2026): rows correctly marked failed ("All media failed to process") were resurrected to POSTED after a redeploy — webhook retries re-evaluated them, the results fetch hiccuped into [], and a 15-min "settle optimistic" rule promoted zero-evidence rows. User saw 3 green POSTED ticks for videos that never reached YouTube.
**How to apply:** every path that persists an aggregate or per-account post status (webhook processed events, poll refresh, live status feeds, create/recovery persistence) must route through the same evidence-based mapper; empty results never move a settled (failed/posted) row; honest-stuck-in-processing beats silent lies — results were verified to persist ≥18h on the provider, so later polls settle truth.

## YouTube-native scheduling capability
- platform_configurations.youtube.publish_at (ISO) maps to YT status.publishAt and is honoured ONLY with privacy_status:'private'. Omit body.scheduled_at then — PFM processes immediately (upload now, YT publishes later).
- Consequence: 'processed' + success results arrive long BEFORE the video is public (it is private-scheduled on YT). Success ≠ public for these posts, and deleting the PFM post afterwards does NOT remove the already-uploaded YT video.
- Default behavior otherwise: PFM uploads media AT the scheduled_at moment — nothing appears in YT Studio beforehand.

## YouTube resumable-upload 429 retry
Only retry a provider result that explicitly says **both** “resumable upload session” and HTTP **429**, and only for the YouTube account that failed. Preserve the existing per-account marker and its retry counter across the new provider hand-off; never delete/reinsert it. Keep the marker locked while the retry is being created, and prevent a manual force-post from deleting a waiting/in-flight retry marker.

**Why:** a broad 429 retry can resend permanent failures, while deleting the marker resets the retry budget and permits a concurrent force-post to create duplicate provider posts.

**How to apply:** wait 15 minutes, allow at most two retries, and leave other account markers untouched. After the limit, surface the original provider failure normally. Any change to this flow needs tests for strict error matching, the bounded counter, and marker-lock concurrency.
