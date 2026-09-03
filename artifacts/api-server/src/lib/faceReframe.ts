/**
 * Face-follow reframing for vertical (9:16) clips — free, on-box, no paid API.
 *
 * How: seek to evenly spaced points in the clip window and decode one tiny
 * 320x240 RGB frame at each point, run the UltraFace RFB-320 ONNX detector
 * (~1.2MB, MIT, CPU ~10ms/frame) on each frame, then turn the face-centre
 * timeline into a piecewise-constant crop path with short eased pans. The
 * final ffmpeg encode gets a crop x-EXPRESSION — no second encode pass.
 *
 * Design choices (deliberate):
 *  • Per-scene STATIC crop + 0.45s pans, not per-frame following: constant
 *    micro-panning looks amateur; podcasts are mostly static shots. A deadzone
 *    + minimum dwell keeps the frame rock-stable until the face really moves.
 *  • Largest face wins (closest/main speaker). Two-person side-by-side shots
 *    lock onto the bigger face rather than averaging (average = empty middle).
 *  • NEVER throws, and returns null on any doubt (model missing, <40% of
 *    frames have a face, content not wider than target). Callers fall back to
 *    the regular center-crop — a worse crop must never break clipping.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CropRect } from "./clipFilter";

// Lazy import type only — onnxruntime-node is a native module; we load it at
// first use so a broken install can only disable reframing, never boot.
type OrtModule = typeof import("onnxruntime-node");
type OrtSession = import("onnxruntime-node").InferenceSession;

/** The model must resolve in every runtime shape: the esbuild bundle
 *  (__dirname = dist/ — build.mjs also copies the model to dist/assets/models
 *  and fails the build if it can't), the package root relative to dist/, and
 *  the src/lib tree that tests and tsx imports run from. The old single
 *  `../../` path silently broke in the bundle and disabled the feature. */
const MODEL_CANDIDATES = [
  path.join(__dirname, "assets/models/version-RFB-320.onnx"),        // next to the bundle (dist/)
  path.join(__dirname, "../assets/models/version-RFB-320.onnx"),     // dist/ → package root
  path.join(__dirname, "../../assets/models/version-RFB-320.onnx"),  // src/lib/ → package root
];

/** First existing model candidate, or null. Exported for the regression test
 *  that keeps a future bundler/layout change from silently killing reframing. */
export function resolveModelPath(): string | null {
  for (const p of MODEL_CANDIDATES) {
    try { if (fs.existsSync(p)) return p; } catch { /* unreadable — keep looking */ }
  }
  return null;
}
const IN_W = 320, IN_H = 240;                 // UltraFace RFB-320 input
const FRAME_BYTES = IN_W * IN_H * 3;          // rawvideo rgb24
// Fast-seeking one frame at each point observes movement much better than
// decoder-only keyframes (which can leave a 30s clip with only 5 samples).
// The scene-level path does not need per-frame tracking; ~1.5s spacing is enough
// to follow a podcast speaker while keeping the analysis bounded.
const SAMPLE_INTERVAL_SEC = 1.5;
const MAX_FRAMES = 24;                        // ~5.5MB raw RGB — bounded per clip
const SAMPLE_TIMEOUT_MS = Math.max(4_000, Number.parseInt(process.env.FACE_SAMPLE_TIMEOUT_MS ?? "", 10) || 12_000);
const SCORE_MIN = 0.62;
const MAX_SEGMENTS = 24;                      // keeps the ffmpeg expression sane

let ortLoad: Promise<{ ort: OrtModule; session: OrtSession } | null> | null = null;
let ortFailedAt = 0;
const ORT_RETRY_COOLDOWN_MS = 60_000;

/** May a previously failed detector load be retried yet? Exported for tests.
 *  A transient load failure (e.g. memory pressure during a traffic spike)
 *  must NOT disable face tracking until the next restart — that is exactly
 *  the "face tracking suddenly died in production" failure mode. */
export function shouldRetryDetectorLoad(failedAt: number, now: number, cooldownMs: number = ORT_RETRY_COOLDOWN_MS): boolean {
  return failedAt > 0 && now - failedAt >= cooldownMs;
}

/** Load onnxruntime + model once; null (and log) when unavailable. A failed
 *  load is retried after a cooldown instead of being cached forever. */
function loadSession(log?: Logger): Promise<{ ort: OrtModule; session: OrtSession } | null> {
  if (!ortLoad && (ortFailedAt === 0 || shouldRetryDetectorLoad(ortFailedAt, Date.now()))) {
    const attempt = (async () => {
      try {
        const modelPath = resolveModelPath();
        if (!modelPath) throw new Error(`model not found; tried: ${MODEL_CANDIDATES.join(" | ")}`);
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const ort = require("onnxruntime-node") as OrtModule;
        const session = await ort.InferenceSession.create(modelPath, {
          logSeverityLevel: 3, intraOpNumThreads: 2,
        });
        ortFailedAt = 0;
        return { ort, session };
      } catch (err) {
        log?.("[face] detector unavailable — reframe disabled (will retry)", { err: String((err as Error).message ?? err) });
        ortFailedAt = Date.now();
        return null;
      }
    })();
    ortLoad = attempt;
    // Clear the cached promise AFTER settlement (a .then, so it cannot race
    // the assignment above even when the attempt fails synchronously) — the
    // next call after the cooldown makes a fresh attempt. Successes stay
    // cached for the process lifetime.
    void attempt.then((res) => { if (res === null && ortLoad === attempt) ortLoad = null; });
  }
  return ortLoad ?? Promise.resolve(null);
}

type Logger = (msg: string, extra?: Record<string, unknown>) => void;

export interface FaceSample { t: number; cx: number | null }  // cx: 0..1 in CONTENT width
export interface PathSeg { start: number; cx: number }
export interface FacePathConfig {
  deadzone: number;
  minDwell: number;
  breach: number;
  alpha: number;
  /** A large composition jump is a camera/speaker cut, not ordinary motion.
   *  Move on the first confirmation so a 1.5s sampler does not wait ~3s. */
  hardCut: number;
}
const DEFAULT_PATH_CONFIG: FacePathConfig = {
  deadzone: 0.07, minDwell: 1.5, breach: 2, alpha: 0.45, hardCut: 0.24,
};

/** Why a REQUESTED reframe didn't happen (geometry no-ops don't count —
 *  content that isn't wider than the target has nothing to follow). */
export type FaceSkipReason =
  | "detector-unavailable"
  | "sampling-failed"
  | "sampling-timeout"
  | "low-coverage"
  | "error";

/** Decode one UltraFace output pair → centre-x (0..1, padded-frame coords) of
 *  the largest face above threshold, or null. Exported for tests. */
export function pickFaceCx(scores: Float32Array, boxes: Float32Array): number | null {
  let bestArea = 0, bestCx: number | null = null;
  const n = Math.min(scores.length / 2, boxes.length / 4);
  for (let i = 0; i < n; i++) {
    const score = scores[i * 2 + 1];
    if (score < SCORE_MIN) continue;
    const x1 = boxes[i * 4], y1 = boxes[i * 4 + 1], x2 = boxes[i * 4 + 2], y2 = boxes[i * 4 + 3];
    const area = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
    if (area > bestArea) { bestArea = area; bestCx = (x1 + x2) / 2; }
  }
  return bestCx;
}

/**
 * Face-centre timeline → stable piecewise path.
 * Gap-fill (carry last), EMA smooth, then segment: a new segment starts only
 * after `breach` consecutive samples outside the deadzone AND `minDwell`s
 * since the last switch. Null when face coverage is too thin to trust (<40%).
 */
export function buildFacePath(
  samples: FaceSample[],
  cfg: FacePathConfig = DEFAULT_PATH_CONFIG,
): PathSeg[] | null {
  if (samples.length === 0) return null;
  const known = samples.filter((s) => s.cx != null);
  if (known.length / samples.length < 0.4) return null;

  let last = known[0].cx!;
  const filled = samples.map((s) => { if (s.cx != null) last = s.cx; return last; });

  let e = filled[0];
  const ema = filled.map((v) => { e = e + cfg.alpha * (v - e); return e; });

  const segs: PathSeg[] = [{ start: samples[0].t, cx: ema[0] }];
  let breachCount = 0, breachIdx = -1, lastSwitchT = samples[0].t;
  for (let i = 1; i < ema.length; i++) {
    const currentCx = segs[segs.length - 1].cx;
    const delta = Math.abs(ema[i] - currentCx);
    if (delta > cfg.deadzone) {
      breachCount++;
      if (breachIdx < 0) breachIdx = i;
      // Use the raw detected position to recognise a true composition cut.
      // EMA deliberately lags to smooth ordinary movement; using it here made
      // a sudden left→right shot wait for a second sparse sample before moving.
      const hardCut = Math.abs(filled[i] - currentCx) >= cfg.hardCut;
      if ((hardCut || breachCount >= cfg.breach) && samples[i].t - lastSwitchT >= cfg.minDwell && segs.length < MAX_SEGMENTS) {
        // Land on the MEDIAN of the raw positions since the breach began —
        // the lagging EMA would land short and force a second catch-up pan.
        const startIdx = hardCut ? i : breachIdx;
        const win = filled.slice(startIdx, i + 1).sort((a, b) => a - b);
        const target = win.length % 2
          ? win[(win.length - 1) / 2]
          : (win[win.length / 2 - 1] + win[win.length / 2]) / 2;
        // Oscillation guard: if the median lands where we already are (pure
        // back-and-forth flicker), it's noise — don't emit a no-op segment.
        if (Math.abs(target - segs[segs.length - 1].cx) > cfg.deadzone) {
          segs.push({ start: samples[startIdx].t, cx: target });
          lastSwitchT = samples[startIdx].t;
        }
        breachCount = 0; breachIdx = -1;
      }
    } else { breachCount = 0; breachIdx = -1; }
  }
  return segs;
}

/**
 * Path → ffmpeg crop x-expression (piecewise-constant with `panSec` linear
 * eases at boundaries), clamped to [0, contentW-cropW], commas escaped for
 * embedding straight into a -vf chain. Exported for tests.
 */
export function faceCropXExpr(segs: PathSeg[], cropW: number, contentW: number, panSec = 0.45): string {
  const maxX = Math.max(0, contentW - cropW);
  const xs = segs.map((s) => {
    const x = Math.min(maxX, Math.max(0, s.cx * contentW - cropW / 2));
    return Math.round(x * 10) / 10;
  });
  let expr = String(xs[xs.length - 1]);
  for (let k = xs.length - 2; k >= 0; k--) {
    const b = Math.round(segs[k + 1].start * 100) / 100;
    const bEnd = Math.round((b + panSec) * 100) / 100;
    expr =
      `if(lt(t,${b}),${xs[k]},` +
      `if(lt(t,${bEnd}),${xs[k]}+(${xs[k + 1]}-(${xs[k]}))*(t-${b})/${panSec},${expr}))`;
  }
  return expr.replace(/,/g, "\\,");
}

/** Evenly distribute a bounded number of sample points across a clip window.
 * Exported so the no-media unit tests can protect coverage and the minimum
 * sample count. */
export function buildSampleTimes(durationSec: number, maxPoints = MAX_FRAMES): number[] {
  if (!Number.isFinite(durationSec) || durationSec <= 0) return [];
  const count = Math.max(2, Math.min(maxPoints, Math.ceil(durationSec / SAMPLE_INTERVAL_SEC)));
  const end = Math.max(0, durationSec - 0.05);
  if (count === 2) return [0, end];
  return Array.from({ length: count }, (_, i) => (end * i) / (count - 1));
}

/** Run ffmpeg → one tiny RGB frame at each evenly spaced point.
 * Input-side `-ss` makes each seek jump to a nearby keyframe instead of
 * decoding the complete high-resolution clip. The requested timestamps are
 * retained because the fast seek may land slightly before the exact point.
 * `preCrop` confines decoding to the active picture so detector coords match
 * the content space the final crop runs in. */
function sampleFrames(opts: {
  ffmpegPath: string; srcPath: string; seekSec: number; durationSec: number; preCrop: CropRect | null;
}): Promise<{ raw: Buffer; times: number[] }> {
  const vf =
    (opts.preCrop ? `crop=${opts.preCrop.w}:${opts.preCrop.h}:${opts.preCrop.x}:${opts.preCrop.y},` : "") +
    `scale=${IN_W}:${IN_H}:force_original_aspect_ratio=decrease,` +
    `pad=${IN_W}:${IN_H}:(ow-iw)/2:(oh-ih)/2`;
  return new Promise<{ raw: Buffer; times: number[] }>((resolve, reject) => {
    let timedOut = false;
    let activeProc: ReturnType<typeof spawn> | null = null;
    const timer = setTimeout(() => {
      timedOut = true;
      activeProc?.kill("SIGKILL");
    }, SAMPLE_TIMEOUT_MS);

    const capture = (atSec: number): Promise<Buffer | null> => new Promise((resolveCapture, rejectCapture) => {
      const args = [
        "-hide_banner", "-nostdin", "-loglevel", "error",
        "-threads", "1", "-ss", (opts.seekSec + atSec).toFixed(3),
        "-i", opts.srcPath, "-an", "-vf", vf, "-frames:v", "1",
        "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1",
      ];
      const proc = spawn(opts.ffmpegPath, args, { stdio: ["ignore", "pipe", "ignore"] });
      activeProc = proc;
      const chunks: Buffer[] = [];
      let total = 0;
      proc.stdout.on("data", (c: Buffer) => {
        const remaining = FRAME_BYTES - total;
        if (remaining <= 0) return;
        const kept = c.subarray(0, remaining);
        total += kept.length;
        if (kept.length > 0) chunks.push(kept);
      });
      proc.on("error", rejectCapture);
      proc.on("close", (code) => {
        if (activeProc === proc) activeProc = null;
        if (code !== 0 || total < FRAME_BYTES) {
          resolveCapture(null);
        } else {
          resolveCapture(Buffer.concat(chunks));
        }
      });
    });

    void (async () => {
      try {
        const rawChunks: Buffer[] = [];
        const times: number[] = [];
        for (const atSec of buildSampleTimes(opts.durationSec)) {
          if (timedOut) throw new Error(`face sampling timed out after ${SAMPLE_TIMEOUT_MS}ms`);
          const frame = await capture(atSec);
          if (frame) {
            rawChunks.push(frame);
            times.push(atSec);
          }
        }
        if (timedOut) {
          reject(new Error(`face sampling timed out after ${SAMPLE_TIMEOUT_MS}ms`));
          return;
        }
        resolve({ raw: Buffer.concat(rawChunks), times });
      } catch (err) {
        if (timedOut) {
          reject(new Error(`face sampling timed out after ${SAMPLE_TIMEOUT_MS}ms`));
        } else {
          reject(err);
        }
      } finally {
        clearTimeout(timer);
      }
    })();
  });
}

// ── Sampling concurrency gate ─────────────────────────────────────────────────
// One sampling window buffers at most MAX_FRAMES raw 320x240 frames ≈ 5.5 MB.
// Unbounded concurrency (jobs × clips) is what pushed small servers into OOM —
// which then also knocked the detector load out. Slots scale with machine RAM
// (deriveFaceSampleParallel) while still overlapping sampling with encodes.

/** RAM-aware default: each slot holds ~22 MB of raw frames plus ONNX overhead.
 *  ~3 GB of machine RAM per slot keeps sampling well clear of the encoders;
 *  floor 2 (overlap even on small boxes), cap 6. Pure — unit-tested. */
export function deriveFaceSampleParallel(memGb: number): number {
  return Math.max(2, Math.min(6, Math.floor(memGb / 3)));
}
const FACE_SAMPLE_PARALLEL = Math.max(1,
  Number.parseInt(process.env.FACE_SAMPLE_PARALLEL ?? "", 10)
    || deriveFaceSampleParallel(os.totalmem() / 2 ** 30));
let faceSlotsBusy = 0;
const faceSlotWaiters: Array<() => void> = [];
async function withFaceSlot<T>(fn: () => Promise<T>): Promise<T> {
  // Re-check after every wake-up: a fresh caller can slip in synchronously
  // between a slot being freed and this waiter's microtask running.
  while (faceSlotsBusy >= FACE_SAMPLE_PARALLEL) {
    await new Promise<void>((resolve) => faceSlotWaiters.push(resolve));
  }
  faceSlotsBusy += 1;
  try {
    return await fn();
  } finally {
    faceSlotsBusy -= 1;
    faceSlotWaiters.shift()?.();
  }
}

/**
 * Main entry: compute the face-follow crop for one clip window.
 * Returns `{ xExpr, cropW }` for buildClipVf, or null → caller keeps the
 * regular center-crop. Never throws.
 */
export async function computeFaceCropExpr(opts: {
  srcPath: string; seekSec: number; durationSec: number;
  active: CropRect | null; srcW: number | null; srcH: number | null;
  targetW: number; targetH: number;
  ffmpegPath: string; log?: Logger;
  /** Detector-unavailable is a WARNING (the user asked for a feature the
   *  server can't deliver), not chatter — route it above info level. */
  warn?: Logger;
  /** Fired when the user asked for face tracking and it could have applied
   *  (wide content) but didn't — lets the job surface an honest note instead
   *  of silently shipping center crops. */
  onSkip?: (reason: FaceSkipReason) => void;
}): Promise<{ xExpr: string; cropW: number } | null> {
  try {
    const contentW = opts.active?.w ?? opts.srcW;
    const contentH = opts.active?.h ?? opts.srcH;
    if (!contentW || !contentH || contentW <= 0 || contentH <= 0) return null;
    // Only useful when the content is meaningfully WIDER than the target —
    // otherwise there is no horizontal room to follow anything.
    if (contentW / contentH <= (opts.targetW / opts.targetH) * 1.02) return null;
    const cropW = Math.floor(Math.min(contentW, (contentH * opts.targetW) / opts.targetH) / 2) * 2;
    if (contentW - cropW < 8) return null;

    const loaded = await loadSession(opts.warn ?? opts.log);
    if (!loaded) { opts.onSkip?.("detector-unavailable"); return null; }
    const { ort, session } = loaded;

    // Sampling + inference hold a face slot — see the gate above for why.
    return await withFaceSlot(async () => {
      const startedAt = Date.now();
      const sampled = await sampleFrames({
        ffmpegPath: opts.ffmpegPath, srcPath: opts.srcPath,
        seekSec: opts.seekSec, durationSec: opts.durationSec, preCrop: opts.active,
      });
      const raw = sampled.raw;
      const frameCount = Math.min(Math.floor(raw.length / FRAME_BYTES), MAX_FRAMES);
      if (frameCount < 2) { opts.onSkip?.("sampling-failed"); return null; }

      // Letterbox mapping: content is drawn centred at scale s inside 320x240.
      const s = Math.min(IN_W / contentW, IN_H / contentH);
      const drawW = Math.max(1, Math.round(contentW * s));
      const padX = (IN_W - drawW) / 2;

      const samples: FaceSample[] = [];
      const input = new Float32Array(3 * IN_H * IN_W);
      for (let f = 0; f < frameCount; f++) {
        const base = f * FRAME_BYTES;
        // HWC rgb24 → CHW float, (v-127)/128 (UltraFace preprocessing)
        for (let p = 0; p < IN_H * IN_W; p++) {
          input[p] = (raw[base + p * 3] - 127) / 128;
          input[IN_H * IN_W + p] = (raw[base + p * 3 + 1] - 127) / 128;
          input[2 * IN_H * IN_W + p] = (raw[base + p * 3 + 2] - 127) / 128;
        }
        const out = await session.run({ input: new ort.Tensor("float32", input, [1, 3, IN_H, IN_W]) });
        const cxPad = pickFaceCx(out.scores.data as Float32Array, out.boxes.data as Float32Array);
        const cx = cxPad == null ? null : Math.min(1, Math.max(0, (cxPad * IN_W - padX) / drawW));
        // showinfo timestamps are relative to the sampled window. If a source
        // omits them, retain a safe coarse estimate rather than discarding a
        // good detection; keyframes are usually 1–2 seconds apart.
        samples.push({ t: sampled.times[f] ?? f * 2, cx });
      }

      const found = samples.filter((sm) => sm.cx != null).length;
      const segs = buildFacePath(samples);
      opts.log?.("[face] sampled", {
        frames: frameCount,
        withFace: found,
        segments: segs?.length ?? 0,
        ms: Date.now() - startedAt,
        sampling: "even-fast-seeks",
      });
      if (!segs) { opts.onSkip?.("low-coverage"); return null; }
      return { xExpr: faceCropXExpr(segs, cropW, contentW), cropW };
    });
  } catch (err) {
    const message = String((err as Error).message ?? err);
    (opts.warn ?? opts.log)?.("[face] reframe failed — using center crop", { err: message });
    opts.onSkip?.(message.startsWith("face sampling timed out") ? "sampling-timeout" : "error");
    return null;
  }
}
