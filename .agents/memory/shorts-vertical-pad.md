---
name: YouTube Shorts vertical padding
description: Why campaign videos landed in YouTube long-form and how the auto-pad-to-9:16 handoff pipeline works
---

# YouTube Shorts classification & vertical padding

**The rule (confirmed live):** YouTube files an upload as a Short purely from the file — duration ≤ 3 min AND height ≥ width. There is NO API flag; providers (Post for Me) cannot force it. Any wider-than-tall video (960x720, 1280x720, even 792x720) lands in the long-form feed no matter what. IG reels are NOT reliably vertical — Zyla serves the original upload aspect (4:3, square, landscape all seen in real accounts).

**Fix in place:** at provider handoff, campaign rows ONLY (`row.source === "campaign"` — manual schedule rows may be intentionally landscape) run through `lib/verticalPad.ts`:
- probe → wider-than-tall AND ≤180s → ffmpeg pad onto blurred 1080x1920 canvas (split/scale-cover-blur/overlay filter; validated against real 960x720 reel).
- Output keyed `padded/<sha256("padv1|"+mediaRef).slice(0,32)>.mp4` in Object Storage — deterministic so retries/instances reuse instead of re-encoding.
- Provider gets stateless HMAC relay URL `/api/video/padded-relay/<token>` (SESSION_SECRET-signed, mirrors gdrive relay tokens).
- EVERY failure returns null → caller falls back to the original URL (unpadded post beats no post).

**Why:** user's campaign posted 6 videos to YouTube; all landed long-form because sources were 4:3/16:9. No provider or API setting could have fixed it — only reshaping the file works.

**How to apply:**
- Square (720x720) and vertical pass through untouched — already Shorts-eligible. >180s never padded (padding can't make it a Short; vertical long-form looks broken).
- Server-side fetches of media URLs must use manual bounded redirects with per-hop `urlResolvesPublic` DNS checks (SSRF — a public URL redirecting to metadata IP is the classic bypass). Never `redirect: "follow"` on user-influenced URLs.
- Padded objects are derived data with meta-sidecar retention (`padded/<id>.json` touchedMs, swept after 45 days untouched, touch-on-reuse; missing/corrupt meta is healed, never deleted blindly).
- Cold relay downloads: temp-name + atomic rename + in-flight dedupe, or concurrent requests serve half-written files.
- ig: refs resolve fresh CDN via igFreshVideoUrl directly at handoff — routing through our own public ig relay would burn its rate limiter.
