---
name: Device-upload sources
description: Design constraints for user-file uploads as clip sources (chunked transport, autoscale handoff, upload:// scheme)
---

## Rules

- **Uploads must be chunked (≈4MB parts).** A single multi-GB POST dies at the proxy's body-size/time limits. Client does init → chunk×N (sequential, indexed) → finish; use XHR for chunks because fetch has no upload-progress events.
- **Mirror every chunk + meta to Object Storage BEFORE acking the chunk.** On autoscale, the next chunk may land on a different instance; the ordered meta chain (nextChunk counter) is what lets any instance resume or finish. Degrades gracefully to local-only when storage is unavailable (dev).
- **Validate with ffprobe at finish** (video stream present, ≥3s) — extension/mime checks alone accept garbage.
- **`upload://<id>/<encodedName>` pseudo-URL scheme** flows through the existing clip pipeline as just another source kind: resolve + owner-authorize it BEFORE reserving credits (fail fast, no hold), then materialize locally (hardlink → copy → storage download) instead of downloading. Upload sources must never touch paid external downloaders (Zyla) or transcript fetches.

**Why:** proxy limits and per-instance /tmp are the two things that silently break "just upload the file" designs on autoscale; per-chunk mirroring is what makes multi-instance uploads coherent.

**How to apply:** any future "user provides a file" feature (thumbnails, watermarks, audio tracks) should reuse this store/scheme rather than invent a new single-shot upload path. E2E tests are safe to run — upload-source clip jobs bypass all paid engines.

## Chunked-upload concurrency rules
- A pipelined/retrying chunk client REQUIRES replay-idempotent acks server-side
  (already-registered part → ack, no write). Strict 409-on-duplicate turns a lost
  ack into a dead upload. Jump-AHEAD parts must stay 409 — ordering never relaxes.
- **Why:** upload speed must come from overlapping the browser→server and
  server→storage legs, never from weakening mirror-before-ack durability.
- On multi-instance deploys the storage-mirrored meta is the only truth: local
  state can be stale even when an incoming part index matches expectations, so
  consult the mirror BEFORE deciding replay vs fresh write, and make meta mirror
  writes monotonic (never overwrite a remote that is ahead).
- Client 409 recovery: wait for the predecessor part's ack, then resend once —
  timed retries are wrong (a predecessor resend can take 30s+ on slow uplinks).
- The replit.dev proxy passes 8MB request bodies fine (verified live).
