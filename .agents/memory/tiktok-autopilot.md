---
name: TikTok Auto-Pilot source
description: Durable constraints for the public TikTok campaign source and its media handoff.
---

TikTok Auto-Pilot is a public-profile, polling-based source: persist stable video ids and refresh CDN media at handoff time; ignore photo posts and never mark a live profile exhausted.

**Why:** TikTok’s public-media responses contain temporary CDN URLs, may mix photo posts with videos, and do not provide a webhook-based new-upload signal.

**How to apply:** Keep the dedicated TikTok Zyla credential separate from Instagram/YouTube credentials, front-insert newly discovered videos, and keep relay URLs signed, owner-safe, short-lived, and restricted to TikTok media hosts.

Paid TikTok discovery must use three layers together: same-request deduplication, a bounded response cache, and bounded admission with per-user request limits.

**Why:** An active-call cap alone still allows an outage to accumulate an unbounded waiting queue or one account to exhaust paid API quota with unique profiles.

**How to apply:** Reject excess queued discovery promptly, release admission on every failure/timeout, and keep provider relays available independently of interactive lookup limits.