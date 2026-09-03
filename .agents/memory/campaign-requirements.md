---
name: Campaign-requirements compliance
description: Pasted Whop/Discord campaign rule sheets in the clip AI-prompt box are parsed deterministically and enforced on captions, duration, subtitles, and an end-card CTA.
---

# Campaign requirements (pasted rule sheets)

Rule: compulsory campaign items (must-tag handles, hashtags, CTA-first-line, min clip length, on-screen captions, end-of-video CTA) are parsed and enforced by deterministic regex (`campaignRequirements.ts`), NEVER by an LLM.
**Why:** dev has no GEMINI key (VPS does), and a campaign payout dies on a missing @tag — compulsory items can't depend on a model's mood or availability.
**How to apply:** the pasted prompt still flows unchanged to Gemini for moment-matching; the enforcement layer only guarantees outputs. Any new caption writer (Auto-Pilot materializer, retry paths, future posting surfaces) must run `enforceCaptionRequirements` too.

Hard-won details:
- Caption enforcement runs check → trim → RE-CHECK in a loop: a required tag that only lived in the trimmed-off tail must be re-appended after the 2200-char cap, or the guarantee silently breaks. Matching is token-boundary aware (@dougelk ≠ @dougelks; a trailing sentence period still counts as present).
- Rule parsing is gated on requirement language NEAR each match (must/minimum/required/rejected/every video window) — "find a segment at least 15 seconds long" is moment selection, not a rule. Zero behavior change for plain prompts is a hard requirement (architect review caught both this and the trim gap).
- The prompt cache-key part carries a `.req1` marker when rules are detected so pre-feature cached clip results never replay as non-compliant output. Bump the marker if enforcement semantics change again.
- ffmpeg end-card CTA (drawtext over final ~3s, top area, clear of bottom subtitles) must never cost a clip: encode-with-CTA failure retries once without it (counted, surfaced in the honest job note). Stream-copy branch skips it entirely. Strip `"'\%;`, reject non-ASCII (DejaVu = Latin-only), quote only the text/enable values.
- When the campaign minimum length exceeds the platform max (e.g. 90s min on 60s Shorts), the job note says so honestly instead of claiming the minimum was met.
- Auto-Pilot stores the prompt in clip_params: "Try clips again" replays it, and the materializer re-enforces rules on EVERY posted caption (custom/AI/filename source alike).
