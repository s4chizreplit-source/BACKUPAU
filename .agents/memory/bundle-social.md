---
name: bundle.social social posting
description: bundle.social replaces Buffer for social auto-posting — admin key, per-user teams, hosted connect portal.
---

# bundle.social Integration

## Architecture
- Admin sets `BUNDLE_API_KEY` once (from bundle.social dashboard → API Keys)
- Each AutoCliper user gets their own bundle.social "team" inside the admin's org
- `bundle_teams` table maps `user_id → team_id`
- Users connect Instagram/TikTok/YouTube via bundle.social's hosted portal (no Buffer/extra account)
- Posts go through admin's org key — users never need a bundle.social account

## Key API
- Base URL: `https://api.bundle.social/api/v1`
- Auth header: `x-api-key: <BUNDLE_API_KEY>`
- Create team: `POST /team` `{ name }`
- Connect portal: `POST /social-account/create-portal-link` `{ teamId, redirectUrl, socialAccountTypes[], expiresIn }`
- Social accounts: `GET /social-account?teamId=...` (exact path TBC — returns 404 if team deleted)
- Create post: `POST /post` `{ teamId, socialAccountIds[], content, mediaUrls[] }`

**Why:** Buffer cannot programmatically add users' social channels to admin org. bundle.social supports per-user teams under one org key, hosted connect portal handles all OAuth.

## DB Tables
- `bundle_teams (user_id PK, team_id UNIQUE, created_at)`
- `bundle_account_prefs (user_id, account_id, enabled, updated_at)` — PK (user_id, account_id)

## Routes
- `GET /user/social/status` — hasTeam + accountCount
- `GET /user/social/connect-url` — creates team if needed + returns hosted portal link
- `GET /user/social/accounts` — list accounts with enabled pref
- `PATCH /user/social/accounts/:id` — toggle enabled
- `DELETE /user/social/team` — remove team + prefs
- `GET /admin/social/teams` — admin view of all connected users

## Files
- `artifacts/api-server/src/lib/bundle.ts` — core client
- `artifacts/ytdlp-ui/src/pages/Social.tsx` — user-facing `/social` page
- Route: `/social` (old `/buffer` redirects here)

## VPS Setup
Add to `.env`: `BUNDLE_API_KEY=<key from bundle.social dashboard>`
Then run `update.sh` to redeploy.
