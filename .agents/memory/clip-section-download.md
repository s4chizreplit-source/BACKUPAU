---
name: Long-video clip pipeline (section downloads)
description: How the clip job avoids full-video downloads; yt-dlp/ffmpeg gotchas; live streams; 120s proxy limit and async job pattern
---

## Live streams (Twitch in-progress VODs)
- yt-dlp reports `is_live: true` PLUS a valid `duration` for the VOD of a stream that is STILL RUNNING. Never treat `is_live` alone as "use the full-download path": a full download of a growing live VOD never ends (runs to the 20-min timeout, then all fallbacks fail with a misleading "subscriber-only/deleted" error).
- **Rule:** if duration > 0, section-download even when live, but stay 120s/3% behind the live edge (last segments unsealed). Live with no duration (true YouTube live) → fail fast with a clear "stream is live" message; never full-download.

## Hosting proxy kills responses at ~120s
- Synchronous POST responses die at the Replit proxy's ~120s limit — the job finishes server-side but the browser gets a network error. Endpoints that can exceed ~100s need: POST returns `{jobId}` (202), background work, client polls a GET status route.
- Job status records need a **heartbeat** (rewrite updatedMs every ~60s while processing); a staleness check without heartbeats misclassifies healthy long jobs as dead.

## File-host direct downloads (Drive/Dropbox)
- Google Drive `uc?export=download` answers **HTTP 303** → `drive.usercontent.google.com`; redirect-following code must include 303 (301/302/307/308 alone silently breaks all Drive links).
- File hosts return 200 + `text/html` (share/confirm/login page) when a file isn't truly public — reject html content-type for these hosts instead of saving it as .mp4 (otherwise it surfaces later as a confusing ffprobe error).
- Dropbox share links: rewrite via the URL API (hostname → dl.dropboxusercontent.com, delete `dl` param). String-replace approaches broke no-www links and mangled `?dl=0` URLs.

## Kick
- The "Kick VODs are unsupported (signed CloudFront tokens)" belief is STALE — current yt-dlp probes and section-downloads Kick VODs natively, and `kick.com/api/v2/channels/{slug}/videos` returns a **publicly readable** IVS master.m3u8 in `source` for finished VODs too (not just live). Re-verify platform blockers before hard-coding "not supported" errors.
- m3u8 sources must be handed to yt-dlp/ffmpeg for HLS assembly — never streamDownload a playlist URL to a .mp4 path (saves playlist text as "video").
- Full-download timeouts must fit long VODs (a 3-min cap killed every long Kick download while a 404 still fails in seconds).

## Duplicate requests
- Users hammer "Try again" — coalesce identical in-flight requests (Map<cacheKey, Promise>) or the same video downloads N times in parallel.

## Shell gotcha
- `pkill -f "pattern"` kills the ShellExec command's own shell when the pattern appears in its own command line — use the bracket trick: `pgrep -f "bin/[y]t-dlp"`.

# Long-video clip pipeline

The clip job must NEVER download the whole video for yt-dlp-native platforms (YouTube/Twitch/generic):
1. probe duration via `yt-dlp --dump-json --skip-download` (metadata only)
2. pick timestamps, then `yt-dlp --download-sections "*start-end"` per clip (parallel, limited)
3. fall back to full download only for Drive/Dropbox/Kick, live streams, or when probe/sections fail

**Why:** a 2h+ video is gigabytes and 10+ minutes of download; sections make job time independent of video length (54-min VOD → 2 clips in ~29s, verified).

**How to apply:** if this logic is ever missing after a GitHub re-import (it was lost once — July 2026), re-implement rather than raising download timeouts.

## Gotchas (hard-won)
- **npm `ffmpeg-static` SEGFAULTS (exit -11) when yt-dlp uses it** as the HLS/section downloader. yt-dlp's `--ffmpeg-location` must point at the system/Nix ffmpeg **directory** (ffprobe lives alongside). The npm binary is fine for the app's own direct ffmpeg spawns.
- Standalone `yt-dlp_linux` binaries (used in `bin/` for dev + prod builds) do NOT auto-find ffmpeg like the Nix-wrapped yt-dlp does — always pass `--ffmpeg-location`.
- Section files start at the keyframe at/before the requested start → seek 0 within them; also fixes black-frame starts for stream-copy clips.
- **YouTube intermittently bot-blocks the VM IP** ("Sign in to confirm you're not a bot") — affects probe + downloads + sections regardless of yt-dlp version or player_client. Fallback chain (Railway/Vercel full download) keeps YouTube working but slower; the real fix is a user-provided YouTube cookies.txt — uploadable at runtime via `POST /ytdlp/cookies` (validated Netscape format, 0600 local file, persisted to private object storage, restored on startup; `YTDLP_COOKIES_FILE` env still wins when set). Cookie args must be resolved per yt-dlp call (`getCookieArgs()` in `lib/cookieStore`), never cached at module load. Note: `#HttpOnly_` lines in cookies.txt are real cookies, not comments.
- yt-dlp `--dump-json` output can exceed default 200KB maxBuffer on long videos — always set explicit large maxBuffer (64MB).

- Section downloads are network-bound — give them their own concurrency limiter (~4). Reusing the CPU-encode limiter (1 in deployments) serialized five yt-dlp calls and turned a ~40s stage into ~3 min on prod.

## Clip count promise beats curation (user-confirmed product rule)
- **Rule:** when the user asks for N clips and the video physically holds N non-overlapping clips, deliver N — never silently fewer. Capacity counts butt-joined fits (floor(usable/clipDur)+1). If truly impossible, the API returns `countNote` and the UI shows it under "X Clips Ready".
- **Why:** real complaint — 5 requested, 2 delivered from a ~3min video with zero explanation. Greedy loudness-first picking with 1.25× curated gaps fragments short timelines; the shared top-up now ends with a wall-to-wall re-pack anchored on the loudest pick.
- **How to apply:** any future picker strategy must route through topUpPicks (highlightPicker.ts) or preserve the same guarantee; countNote must survive EVERY response path (sync, async job record, 2h result-cache hit — the cache-hit settleJob dropped it once already).

## Baked-in black bars (vertical format)
Many sources carry bars INSIDE the frame — cinema songs are 2.39:1 letterboxed in 16:9 uploads, phone clips pillarboxed. A plain center 9:16 crop keeps those bars in shorts/reels output.
**Fix that works:** per-clip ffmpeg cropdetect probe (fps=2, ~10s window, reset=0 = union across frames), strip detected bars first, then 9:16 center-crop; content narrower than 9:16 → blurred-background composite, never stretch/pillarbox.
**Guards (all needed, else dark scenes get mis-cropped):** reject <3% shrink, area <20%, off-center windows, and windows shrunk on BOTH axes (real bars keep one axis at ~full span).
**Why:** user complaint — Bollywood song clips showed bars top+bottom in the reel frame; verified full-bleed after fix via free upload-path e2e.
**Gotchas:** thumbnails must NOT reapply the clip filter (crop offsets are source-coordinates; clip file is already final). Test-suite ffmpeg stub writes dummy bytes to its last arg — probe output must be os.devNull, not "-", or a junk file named "-" appears in cwd every test run.

## Residential proxy (YTDLP_PROXY)
- Permanent bot-block fix: set YTDLP_PROXY (residential proxy URL, e.g. Webshare rotating endpoint) in server env; yt-dlp gets --proxy for YouTube targets only.
- **Gate:** lib/ytdlpProxy.ytdlpProxyArgs applies proxy ONLY to YouTube-ish targets (youtube.com / youtu.be / googlevideo / ytsearch). Kick/IVS, Zyla mirrors, direct files must never burn per-GB residential bandwidth.
- **Security invariant:** every yt-dlp exec must go through execYtdlp (same lib) — it scrubs scheme://user:pass@ creds from message/stack/cmd/stderr/stdout at throw time. Never use raw promisified execFile for yt-dlp: Node embeds full argv (incl. --proxy creds) in "Command failed" messages, which flow into logs, job records, and API error responses.
- Why proxy beats per-video download APIs for long videos: the pipeline only section-downloads clip ranges, so a 2-hr podcast costs ~50-150MB of proxy data — and uploaded cookies become optional.
