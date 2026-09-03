---
name: Durable job coordination
description: Shared coordination rules for async clips and paid Zyla conversions across API instances.
---

Async clip jobs use PostgreSQL as the shared coordination source while local files and Object Storage remain compatibility mirrors and outage fallbacks. A worker obtains an opaque lease token before it starts work; only that exact token may renew the lease or write a terminal result.

**Why:** API instances can restart, autoscale, and receive different polling requests. A process-local queue or unconditional terminal write lets a stale worker overwrite a cancellation/replacement or multiply expensive source work.

**How to apply:** Keep new job-state writes compatible with the durable payload and preserve token-checked compare-and-set behavior for completion. Keep per-instance resource guards in addition to the shared capacity ceiling. Zyla cache misses must take the inflight lease before making a paid start; finished results still belong in the durable mirror cache.