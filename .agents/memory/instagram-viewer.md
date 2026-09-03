---
name: Instagram viewer/downloader (Zyla IG API)
description: Zyla Instagram Profile & Media Data API integration — key split from YT engine, quota protections, CDN streaming proxy rules
---

# Instagram profile viewer + downloader

Backend `/api/ig/*` (profile, media posts|reels|stories, resolve for pasted post/reel links, download/view streaming proxy) on Zyla API #12390; UI page at `/instagram`.

## Key split from the YouTube engine
- The account's existing `ZYLA_API_KEY` returned 401 "not authorized / please subscribe" for API #12390 — Zyla subscriptions are per-account, and the user may buy different APIs on different Zyla accounts.
- **Rule:** IG routes read `ZYLA_IG_API_KEY ?? ZYLA_API_KEY`. Never overwrite `ZYLA_API_KEY` with a second account's key — that silently breaks the YT downloader (API #11016) whose subscription lives on the first account.
- 401/403 from Zyla = key's account lacks the subscription. Map to a clear "ask admin to update key" error and NEVER cache it (a fixed key must work immediately).

## Paid-quota protections (every upstream call bills)
- 30-min in-memory success cache + in-flight dedupe per endpoint+param (cache key includes cursor params automatically); 404/400 negative-cached ~10 min (bad usernames bill too).
- Tests must stub global fetch; `__tests__/setup.ts` deletes real Zyla keys so unit runs can never spend quota.
- Harvest layer walks arbitrary JSON rather than exact paths — shapes since verified LIVE (2026-08-20 probes against API #12390).

## Live-verified engine behavior (2026-08-20)
- List endpoints (posts/reels) return ~12 items/page under `data.items[]` with `data.pagination.{hasNextPage,nextCursor}`. Advance with **`nextCursor=`** — a `cursor=` param silently returns page 1 again.
- List item shape: `{id, code, title, createdAt, author, totalMedia, statistics, mediaList[]}`; downloadUrl/mediaType live on the nested `mediaList[]` child, which carries NO shortcode/caption → harvest inherits `code` + caption from the parent item (ctx param).
- **Details endpoints resolve ONLY by URL**: `idOrUrl=<numeric media id>` returns 200 with an EMPTY body (no downloadUrl); `idOrUrl=https://www.instagram.com/{p|reel}/<shortcode>/` works. Durable refs (campaigns) must therefore store the SHORTCODE as the media id — numeric ids only resolve while the media still sits on early list pages.
- Listing depth split: campaign detect/create = deep (follow nextCursor, capped pages/items so huge profiles can't burn quota); daily rescan + viewer = shallow page 1 (new media is on top; keeps rescan at 2 paid calls/day).

## Streaming proxy rules (learned via architect review)
- `/ig/view` renders bytes inline under OUR origin → MIME-gate to image/* (never svg+xml) or video/*; everything else 415. `X-Content-Type-Options: nosniff` alone is not protection when upstream declares text/html.
- Every fetch Response NOT piped to the client must have its body cancelled (invalid redirect hops, !ok upstreams, MIME rejections) or sockets leak under normal expired-signed-URL traffic.
- Host allowlist `*.cdninstagram.com` / `*.fbcdn.net`, https only, redirects re-validated hop by hop (max 3), plus `urlResolvesPublic` DNS check.
- IG signed URLs expire (`oe=` param) → map upstream 4xx to "link expired, search again", never stream a corrupt/HTML body as a download.

## Frontend race rule
- Search results/tabs use a generation counter (`genRef`); any await checks its generation before committing state so an old account's media can't bleed into a new search. Per-kind loading map, not one global flag.

## Aspect ratios & client quirks (2026-08-21)
- Zyla serves the ORIGINAL upload file: real accounts' reels are frequently 4:3 (960x720), square (720x720), or odd (792x720) — never assume reels are 9:16. Anything Shorts-bound must be shape-checked (see shorts-vertical-pad.md).
- Cloudflare in front of Zyla bot-blocks python-urllib/curl signatures (403) but Node fetch works — always probe Zyla endpoints via `node -e`, never python/curl.
