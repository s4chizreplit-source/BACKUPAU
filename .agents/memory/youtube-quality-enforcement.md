---
name: YouTube quality enforcement
description: How the download chain verifies requested quality and why selectors must match both orientations
---

# YouTube quality enforcement

**Rule:** every YouTube download (any source: mirror, yt-dlp, external providers) must be ffprobe-verified as `min(width,height)` before acceptance; never trust a provider's quality parameter, and never end a YouTube yt-dlp selector with an unconstrained `/best` tail.

**Why:** YouTube bot-checks hide HD formats but leave a 360p fallback stream up — an unconstrained `/best` (or an unverified provider response) silently ships 360p files for 720/1080p requests. This shipped to production and users noticed.

**How to apply:**
- Quality of a file is `min(w,h)` — NOT height. `[height<=720]` excludes an HD portrait Short (720x1280, height 1280); every strict selector rung needs a `[width<=q]` alternative or portrait sources break entirely.
- Downgrade = `actual < floor(min(requested, 720) * 0.9)`; a 1080p request may use genuine 720p, but must never accept a bot-limited 360p/480p fallback. A failed probe (null) is never positive evidence of a downgrade.
- Enforcement is YouTube-only (`detectSourcePlatform === 'youtube'`): generic sites have one real quality and no alternate sources; rejecting their files only breaks them. Zyla mirror URLs classify as non-YouTube in section downloads — intended.
- Rejected-but-best files are stashed (`.lowq`) while fallbacks run; if every source stays below the HD floor, return an actionable error rather than ship the stash.
- In the yt-dlp ladder, a downgrade rejection must BREAK to external providers — lower rungs return the same 360p stream.
- Warm-up must carry the form's selected quality in both its dedupe key and provider request; otherwise a production fast-mode default buys 720p while the later job waits on a second 1080p conversion.
