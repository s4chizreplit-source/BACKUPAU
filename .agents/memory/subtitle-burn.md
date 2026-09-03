---
name: Subtitle burn pipeline
description: How burned clip subtitles get their transcript (Deepgram STT), why YouTube caption endpoints were abandoned, and the burn-alignment/font rules.
---

# Subtitle burn pipeline

## Transcript source: Deepgram STT on the clip's own audio (since July 31, 2026)
Burned subtitles do NOT use YouTube caption downloads anymore. Each subtitles-ON clip extracts its own mono 16 kHz wav slice and transcribes it through Deepgram (`nova-2`, pre-recorded API, `DEEPGRAM_API_KEY` secret). Segments come back on the video timeline and feed the existing `cuesForClip`/`buildAss` burn unchanged.

**Why:** YouTube 429-throttles timedtext downloads from datacenter IPs — first vtt, then json3 too (the throttle escalates; it is IP-reputation-based and cookies only soften it). Burned subs kept failing with honest-but-useless "skipped" notes. Owner decision: subtitles must work for every source (YouTube, Kick, uploads, Drive) with zero cookies dependency; Deepgram at ~$0.0043/min is cheap enough to skip the free-captions attempt entirely (his $200 signup credit ≈ years).
**How to apply:** never reintroduce a YouTube caption dependency into the burn path. Highlight picking still uses YouTube captions opportunistically (with audio-loudness fallback) — that's fine because it fails soft. If the burn transcript source or output shape changes again, bump the subs cache-key version (`subs:<style>.vN`) in lockstep or stale caption-less results replay.

## Failure containment contract
`transcribeClipWindow` never throws: missing key, ffmpeg failure, HTTP error, hard timeout (45s AbortController), or non-Latin transcript all return null → clip ships bare + honest countNote (three variants: not-configured / all-skipped / partial). A slow transcription must never stall clip delivery — owner's explicit priority is smoothness.

## Script/font rules
Runtime fonts are DejaVu (Latin) only. Deepgram flow: `detect_language` first; majority-non-Latin transcript → one retry with `language=hi-Latn` (romanized Hindi/Hinglish); still non-Latin → skip burn (tofu boxes are worse than a note). Devanagari rendering = separate future font work.

## Alignment rules (unchanged, still load-bearing)
- Integer clip starts when burning (`Math.floor` on picked timestamps) + force-keyframes flag on section downloads keyed on `subtitleStyle`.
- Alignment is intrinsic now: transcription and the ffmpeg cut read the same file with the same time base (section file seek 0, or full source seek startSec), so cues can't desync even if the section starts on an earlier keyframe.
