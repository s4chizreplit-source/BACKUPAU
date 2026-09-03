---
name: Prompt-guided clip selection
description: Gemini prompt→moment matching on clip jobs — key gating, transcript sourcing, cache identity, dev-vs-VPS testability
---

**Rule:** In prompt-guided selection, check `isGeminiConfigured()` BEFORE acquiring any transcript. Transcript acquisition can bill Deepgram (full-video STT) — never spend that when the matcher can't run anyway.
**Why:** GEMINI_API_KEY exists only on the VPS (prod); the Replit dev workspace has DEEPGRAM_API_KEY but NOT Gemini. Wrong gate order would burn Deepgram money on dev/misconfigured servers just to fall back.
**How to apply:** Any new AI-matching entry point: gate on the model key first, then captions (free), then STT (paid). Dev can only E2E the fallback/wiring/cache paths — the matcher itself needs unit tests with injected `fetchImpl`; real prompt matching is verifiable only on the VPS after deploy.

Other durable choices (task-independent):
- The prompt is part of result identity → hashed into the clip cache key (same pattern as the Kick `ksrc` hint). Different prompts must never share cached clips.
- Prompt picks get NO intro/outro margin — users explicitly ask for cold opens/endings; only clamp to [0, duration−clipLen] and enforce gap ≥ clipLen.
- Full-video STT for matching skips the Latin-only filter (that filter exists solely for subtitle font burning; Gemini reads any script). Mono 16 kHz Opus @24kbps keeps 90 min ≈ 16 MB upload.
- Matcher outcomes must stay distinct: unavailable/no transcript may fall back to automatic clips with a visible note; a successful zero-match must fail before encoding or storage and refund the full reservation. A zero-match is valid only after every transcript chunk completed with a strict, parseable response; incomplete chunks are unavailable. Partial matches produce only evidence-backed clips, never automatic filler.
- Gemini matches are strict `{start,end,reason}` evidence records. Center a short passage inside the requested clip, enforce explicit time windows deterministically, and preserve Deepgram speaker labels in the transcript when diarization supplies them.
