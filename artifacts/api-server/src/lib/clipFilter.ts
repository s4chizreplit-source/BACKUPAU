/**
 * Active-picture detection + vertical-fill filter construction for platform clips.
 *
 * Why: many sources carry BAKED-IN black bars — Bollywood/cinema songs are
 * 2.39:1 letterboxed inside a 16:9 upload, old TV rips are 4:3 pillarboxed,
 * phone footage gets re-uploaded as 16:9 with huge side bars. A naive center
 * 9:16 crop keeps those bars inside the vertical frame (the #1 "this doesn't
 * look like a real Reel/Short" complaint). The pipeline probes the active
 * picture area with ffmpeg cropdetect, strips the bars, then fills the canvas:
 *   • content wider than 9:16   → center-crop to 9:16 (true full-bleed)
 *   • content narrower than 9:16 → blurred-background composite (no stretch,
 *     no black pillars — the standard "music reel" look)
 * Detection is deliberately defensive: anything ambiguous (dark scenes,
 * off-center detections, tiny areas) falls back to the plain legacy chain.
 *
 * Everything here is pure string/number logic so it unit-tests without ffmpeg;
 * the actual cropdetect probe lives next to the encoder (needs FFMPEG_PATH).
 */

export interface CropRect { w: number; h: number; x: number; y: number }

/**
 * Last `crop=W:H:X:Y` suggestion printed by cropdetect on stderr. With
 * reset=0 cropdetect accumulates a running max-area window, so the last
 * line is the union over all sampled frames (robust against one dark frame).
 */
export function parseCropDetect(stderr: string): CropRect | null {
  let last: CropRect | null = null;
  const re = /crop=(\d+):(\d+):(-?\d+):(-?\d+)/g;
  for (const m of stderr.matchAll(re)) {
    last = { w: +m[1], h: +m[2], x: +m[3], y: +m[4] };
  }
  return last;
}

/** Source dimensions parsed from ffmpeg's input dump ("Stream … Video: … 1920x1080 …"). */
export function parseSourceDims(stderr: string): { w: number; h: number } | null {
  for (const line of stderr.split("\n")) {
    if (!/Stream #\d+:\d+.*Video:/.test(line)) continue;
    // Dimensions token is a bare WxH — scan tokens so codec tags like
    // (avc1 / 0x31637661) can't false-match.
    for (const tok of line.split(/[\s,]+/)) {
      const m = tok.match(/^(\d{2,5})x(\d{2,5})$/);
      if (m) return { w: +m[1], h: +m[2] };
    }
  }
  return null;
}

/**
 * Accept a cropdetect suggestion only when it looks like real letterbox/
 * pillarbox bars. Rejects: missing/degenerate rects, suspiciously tiny areas
 * (dark scene fooled the probe), sub-3% shrink (noise, not bars), and most
 * off-center windows (usually dark content, not a real picture area).
 *
 * A deliberate exception accepts a full-width, wide picture anchored at the
 * top or bottom of a tall source. Many podcast exports are vertical canvases
 * with a 16:9 camera feed at the top and a black/caption panel below; treating
 * that whole canvas as a vertical video leaves the speaker tiny and prevents
 * face-follow cropping from ever seeing the actual camera picture.
 */
export function pickActiveArea(det: CropRect | null, srcW: number, srcH: number): CropRect | null {
  if (!det || srcW <= 0 || srcH <= 0) return null;
  if (det.w < 64 || det.h < 64 || det.x < 0 || det.y < 0) return null;
  if (det.w > srcW || det.h > srcH) return null;
  if (det.w * det.h < srcW * srcH * 0.2) return null;
  // Real bars leave the OTHER axis at (nearly) full span — letterbox keeps
  // full width, pillarbox keeps full height. A window shrunk on both axes is
  // a dark scene / vignette, not bars — never crop real content.
  if (det.w < srcW * 0.98 && det.h < srcH * 0.98) return null;
  const shrinkW = srcW - det.w;
  const shrinkH = srcH - det.h;
  if (shrinkW < srcW * 0.03 && shrinkH < srcH * 0.03) return null;
  const centeredBars =
    Math.abs(det.x - shrinkW / 2) <= srcW * 0.05 &&
    Math.abs(det.y - shrinkH / 2) <= srcH * 0.05;
  if (centeredBars) return det;

  // Embedded landscape video inside a vertical canvas: full width, clearly
  // landscape, short enough that it cannot be a slightly-offset letterbox,
  // and pinned to one canvas edge. This is intentionally narrow so dark
  // scenes and ordinary off-centre content still fall back untouched.
  const isEmbeddedWidePanel =
    det.w >= srcW * 0.98 &&
    det.h <= srcH * 0.7 &&
    det.w / det.h >= 1.2 &&
    (det.y <= srcH * 0.03 || det.y + det.h >= srcH * 0.97);
  return isEmbeddedWidePanel ? det : null;
}

/**
 * Build the -vf/-filter:v graph for a vertical platform clip.
 *
 * Wide (or unknown) content: crop FIRST at source resolution, then scale once
 * to target — the old order (scale=-2:1920,crop) pushed a 6.5M-px/frame image
 * through the scaler before discarding 2/3 of it, brutal on small prod CPUs.
 * crop=min(iw,ih*W/H):ih takes the center 9:16 window (no-op for narrower
 * sources); scale…decrease + pad keeps geometry safe; setsar=1 squares pixels.
 *
 * Narrow content (rarer: tall screen recordings, odd verticals): a stretched
 * or pillarboxed result looks amateur, so composite the clip over a blurred,
 * canvas-filling copy of itself — the standard music-reel treatment. This
 * branch decodes once and splits, so it costs one extra scale+blur only when
 * actually needed.
 */
export function buildClipVf(opts: {
  active: CropRect | null;
  srcW: number | null;
  srcH: number | null;
  targetW: number;
  targetH: number;
  fps: number | null;
  /** Face-follow crop from lib/faceReframe.ts: replaces the static center
   *  crop with a per-clip x-expression (already comma-escaped). Only applies
   *  to the wide branch — narrow content has no horizontal room to follow. */
  faceCrop?: { xExpr: string; cropW: number } | null;
}): string {
  const { active, targetW, targetH, fps } = opts;
  const fpsStep = fps ? `fps=${fps},` : "";
  const preCrop = active ? `crop=${active.w}:${active.h}:${active.x}:${active.y},` : "";
  const contentW = active ? active.w : opts.srcW;
  const contentH = active ? active.h : opts.srcH;

  const isNarrower =
    contentW != null && contentH != null && contentW > 0 && contentH > 0 &&
    contentW / contentH < (targetW / targetH) * 0.995;

  if (isNarrower) {
    return (
      `${preCrop}${fpsStep}split=2[fgs][bgs];` +
      `[fgs]scale=${targetW}:${targetH}:force_original_aspect_ratio=decrease:force_divisible_by=2[fg];` +
      `[bgs]scale=${targetW}:${targetH}:force_original_aspect_ratio=increase:force_divisible_by=2,crop=${targetW}:${targetH},boxblur=20:2[bg];` +
      `[bg][fg]overlay=(W-w)/2:(H-h)/2,setsar=1`
    );
  }

  if (opts.faceCrop && contentW != null && contentH != null) {
    return (
      `${preCrop}crop=${opts.faceCrop.cropW}:${contentH}:${opts.faceCrop.xExpr}:0,${fpsStep}` +
      `scale=${targetW}:${targetH}:force_original_aspect_ratio=decrease:force_divisible_by=2,` +
      `pad=${targetW}:${targetH}:(ow-iw)/2:(oh-ih)/2,setsar=1`
    );
  }

  return (
    `${preCrop}crop=min(iw\\,ih*${targetW}/${targetH}):ih,${fpsStep}` +
    `scale=${targetW}:${targetH}:force_original_aspect_ratio=decrease:force_divisible_by=2,` +
    `pad=${targetW}:${targetH}:(ow-iw)/2:(oh-ih)/2,setsar=1`
  );
}

/** Build the quality-preserving filter for the "Original" 16:9 output.
 * Unlike the vertical platforms, Original must not crop the source, but it
 * still needs to encode to the requested 720p/1080p canvas instead of
 * stream-copying a 360p/480p source. */
export function buildOriginalVf(opts: {
  targetW: number;
  targetH: number;
  fps: number | null;
}): string {
  const fpsStep = opts.fps ? `fps=${opts.fps},` : "";
  return (
    `${fpsStep}scale=${opts.targetW}:${opts.targetH}:force_original_aspect_ratio=decrease:force_divisible_by=2,` +
    `pad=${opts.targetW}:${opts.targetH}:(ow-iw)/2:(oh-ih)/2,setsar=1`
  );
}
