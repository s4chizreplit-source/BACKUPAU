---
name: Concurrency scaling & fair encode queue
description: How clip-job concurrency caps are derived and why the encode queue is round-robin per job, not FIFO
---

## Caps derive from the machine at boot, not constants
Encode slots, active-job count, and face-scan slots all default from `os.availableParallelism()` + `os.totalmem()` (pure `derive*` functions, unit-tested; env vars still override). Deploy scripts size the Node heap as RAM/4 (clamped) the same way.
**Why:** the same codebase runs on a 2-core Replit dev box, autoscale instances, and the user's 16 GB KVM4 VPS — hardcoded defaults tuned for the smallest box wasted the big one (heap was stuck at 1024 MB on 16 GB).
**How to apply:** never hardcode a parallelism number; add a `derive*(cpus, memGb)` fn + env override, and expose the resolved value in `/api/healthz` so prod settings are verifiable.

## Encode queue must be FAIR (round-robin per job), not FIFO
The server-wide encode semaphore groups waiters by a per-pipeline key and grants slots round-robin across keys.
**Why:** with FIFO, one job's 60 queued clips made every other user's FIRST clip wait behind the whole batch — users read that as "the site is stuck".
**How to apply:** any new CPU-heavy per-clip stage goes through `globalEncodeLimit(encodeFairKey, fn)`; never add a plain FIFO semaphore across jobs.

## Slot limiters must survive synchronous throws
Call `Promise.resolve().then(fn)` inside limiters — a bare `fn()` that throws synchronously skips `.finally`, leaks the slot forever, and eventually deadlocks all encodes (architect review caught this; regression-tested).
Note: with this fix, fn starts on a microtask — tests that capture state from inside fn must `await Promise.resolve()` first.

## Check disk headroom when a DOWNLOAD starts, not only at job admission
Full-source downloads can be 5 GB each; with many active jobs, admission-time free-disk checks are stale by the time a late job downloads. `ensureScratchHeadroom()` fails the marginal job with the user-readable "storage full" message instead of letting ENOSPC mid-write kill every running job.
