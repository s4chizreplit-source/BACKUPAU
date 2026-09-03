---
name: Autoscale job-store mirror
description: Why async job records must be mirrored to Object Storage on autoscale, and the write-ordering race that comes with it
---

# Autoscale job-store mirror

**Rule:** On Replit Autoscale, anything written to per-instance disk (/tmp) is invisible to other instances and dies on scale-to-zero. Async job status records MUST be mirrored to Object Storage; polling reads need a local-first + bucket-fallback path.

**Why:** Live site showed "Lost track of this job" — poll requests landed on a different/fresh instance than the one running the job. Dev never reproduces this (single server).

**How to apply:**
- Mirror writes must be ORDERED per job (promise chain per jobId). Fire-and-forget uploads race: a rapid queued→processing→done sequence (e.g. cache hit) can land out of order and leave a stale "processing" as the final bucket record.
- Local-first reads: terminal (done/error) local records are authoritative; non-terminal local records older than the heartbeat interval may be a stale re-cache — check bucket and prefer the record with newer updatedMs.
- GC mirrored records (they're tiny but unbounded otherwise).
- Autoscale containers have small scratch disks — dev-sized free-disk guards (3GB) 503 every request in prod; default low (1GB) with env override.
- **Autoscale throttles CPU outside request handling** — background ffmpeg encodes crawl at ~0.04x and die on timeout (observed live: fps=1.1 on a 30s clip). Multi-minute background video jobs need a Reserved VM deployment (`deploymentTarget: "vm"`), not autoscale. Also encode ONE clip at a time in deployments — parallel encodes starve each other on small containers.
- Switching an already-published app autoscale→VM: `deployConfig` alone made the next publish FAIL with a clean build log and no runtime logs; user had to unpublish + pick the type in Publishing settings, then it built as gce. Build provider `cloud_run` vs `gce` in build history tells you which target actually built.
- Smallest Reserved VM (e2-small, 0.5 vCPU) encodes 1080x1920 veryfast at ~0.1x realtime — still blows a 4-min per-clip timeout. Deployments default to a light encode profile (720x1280/superfast/fps=30, `ENCODE_PROFILE` override) and /api/healthz reports the active profile so prod can be verified after each publish.
- YouTube bot-blocks datacenter IPs far more than the dev workspace IP. Without cookies, cap yt-dlp retries (`--retries 2 --extractor-retries 1`) and skip transcript fetches after a bot-check hit, or each blocked job wastes ~4 min in doomed internal retries before reaching fallbacks.
- Proof-test pattern: run async job to done, `rm` the local job file (simulates other instance), GET status again — must return the full done record from the bucket.
- **Local job-record files are on the download-AUTH hot path** (scan of all records decides which file ids a user may fetch). Done records embed base64 thumbnails (MBs of JSON): the scan must be async with a per-file parse cache, and the cache key must include the **inode** (`ino:mtimeMs:size`) — mtime+size alone can collide on rapid same-size rewrites. Only cache a stable snapshot (stat before AND after read must match).
- **Job-record writes must be atomic (temp file + rename), never in-place.** Async readers on the libuv threadpool CAN observe a torn in-place `writeFileSync` (sync writer + async reader ≠ single-threaded safety) → transient auth denials right after a job finishes. Rename also gives each version a fresh inode, which feeds the cache key. Temp names must not end in `.json` (all scans filter on that) and need a leak sweep for crash leftovers.

## Ownership rule for startup cleanup
Job records cached locally from the bucket may belong to jobs live on OTHER instances. Any startup "fail orphaned jobs" sweep must check a persisted per-machine owner id stamped on every record; only fail owned records, and just delete (never mirror errors for) foreign cache copies.

**Vitest quirk:** parallel test workers sharing one tmp jobs dir ALSO share the persisted owner id, so each file's import-time orphan sweep can kill other files' live queued jobs (flaky under load). Job-store paths must be per-process in test env (`process.env.VITEST`).
