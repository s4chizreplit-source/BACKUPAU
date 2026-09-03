---
name: Kick clipping & downloading
description: How Kick sources resolve — browser-assisted hint, curl-only API access, IVS m3u8 rules, yt-dlp quirks.
---

# Kick clipping & downloading

- **Browser-assisted resolution is the primary path**: Kick's API reflects ANY Origin in CORS (verified live), so the user's browser fetches the channel-videos/video API itself and sends the IVS m3u8 as a `kickSrc` hint with the clip job. A home IP + real browser is never bot-blocked, so this works even when the server's IP is fully blocked. The hint is user input → strict allowlist (https, host exactly stream.kick.com, *.m3u8) before the server's downloader may touch it.
- Server-side fallback keeps working without a hint (campaigns, API callers): kick.com API via **curl subprocess only** — Kick's Cloudflare 403s Node fetch by TLS fingerprint but allows curl (+browser UA, Accept-Language, Referer, --compressed; 3 attempts with backoff; 404 = real answer, don't retry).
- yt-dlp's kick page/extractor path is dead (kick.com/video/{uuid} → generic extractor → 404/403) — never rely on it; go straight for the IVS m3u8. The `stream.kick.com` IVS playlist + segments stay publicly readable even during API blocks, and yt-dlp handles them as generic HLS (sections + full downloads both verified).
- Live streams: the channel API's `is_live` videos entry carries the in-progress recording's m3u8; probing THAT yields the sealed recorded duration (`duration: null` on the channel URL itself). A browser hint for a live stream must carry `kickIsLive` so the server keeps its stay-behind-the-live-edge margin.

**Why:** Kick blocking is IP-reputation based and hits VPS/datacenter IPs hardest — the user's own browser is the one client that always gets through.

**How to apply:** any new Kick flow = browser hint first, curl API fallback second, never Node fetch, never trust an unvalidated hint URL.

## UUIDv7 link scheme (2026-08)
New kick.com/{channel}/videos/{uuid} links use UUIDv7 ids whose embedded 48-bit time EQUALS the VOD start_time (to the second), but v1/video, v2/video and web.kick.com all 404 on them — only the legacy v4 video.uuid resolves anywhere. Resolve v7 links by matching the uuid time to a channel-list entry start_time (nearest, <=10min tolerance); ids minted mid-session map to the live entry. Kick page HTML is Cloudflare-403 even where the API answers — never scrape pages, always the JSON API.
