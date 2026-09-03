---
name: Face-follow clip reframe
description: How vertical clips follow the speaker's face — detector choice, single-pass crop expression, fallback rules
---
- Vertical (9:16) clips can follow the largest face: UltraFace RFB-320 ONNX (~1.2MB, MIT) committed under api-server assets/models — never fetched at runtime (VPS installs from git).
- onnxruntime-node loads lazily and NEVER blocks boot; any load/detect failure → null → regular center crop. A worse crop must never fail a clip job.
- Reframe happens INSIDE the one main ffmpeg encode as a crop x-expression (piecewise + short pans, commas \,-escaped like the rest of the chain). A second encode over the finished vertical clip would recrop burned subtitles and double CPU — don't reintroduce it. The old mediapipe/python face_track.py was dead code (mediapipe never installed anywhere).
- Path rules: sample evenly spaced 320x240 frames in CONTENT coords (post active-area crop), using fast seek-to-one-frame probes instead of decoder keyframes; largest face wins (never average two faces — the average frames nobody); deadzone + min-dwell + median landing keeps the frame static-per-scene; <40% face coverage → fallback to center.
- Face analysis must have a short hard timeout and use the same fair CPU queue as video encodes. Keyframe-only samples can make a moving speaker look static; full-frame decoding can starve on the small production VM. Keep the face-cache revision bumped whenever reframe output changes.

**Why:** double-encode recrops subtitles; per-frame panning looks amateur; silent fallback keeps clipping unbreakable.
**How to apply:** whenever touching the clip vf chain, the faceTrack option, or upgrading the detector model.

## Bundle path regression (2026-08-13)
The feature shipped DEAD: MODEL_PATH used __dirname + ../../ which resolves correctly from src/lib but points outside the package from the esbuild dist/ bundle — loader is never-throw so every job silently center-cropped. Fixes: resolveModelPath() tries bundle-relative, package-root and src-relative candidates; build.mjs copies the model to dist/assets/models and HARD-FAILS the build if missing; detector-unavailable now logs at warn and the job result carries an honest user-facing note (same pattern as skipped subtitles); cache marker ft:3 orphans the bad cached clips.
Lesson: never sign off a feature by importing from src — verify through the built workflow server; __dirname changes meaning after bundling.

## Load-failure caching & memory (added 2026-08-16)
- NEVER cache a detector/model load failure forever: one transient failure (usually OOM pressure) permanently killed face tracking until restart. Failures now retry after a 60s cooldown; clear the cached promise on rejection carefully (a sync throw can re-cache null forever).
- Sampling+inference run under a small RAM-aware semaphore; semaphore waiters must re-check the cap in a while-loop after every wake-up. The primary CPU guard is the fair encode queue, so analysis never competes with an active encode on a constrained VM.
