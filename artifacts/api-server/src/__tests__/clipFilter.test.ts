import { describe, it, expect } from "vitest";
import { buildClipVf, buildOriginalVf, parseCropDetect, parseSourceDims, pickActiveArea } from "../lib/clipFilter";

const CINEMASCOPE_STDERR = `
Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'section_0.mp4':
  Duration: 00:00:30.03, start: 0.000000, bitrate: 4741 kb/s
  Stream #0:0[0x1](und): Video: h264 (High) (avc1 / 0x31637661), yuv420p(tv, bt709, progressive), 1920x1080 [SAR 1:1 DAR 16:9], 4602 kb/s, 30 fps, 30 tbr, 15360 tbn (default)
  Stream #0:1[0x2](und): Audio: aac (LC) (mp4a / 0x6134706D), 44100 Hz, stereo, fltp, 128 kb/s (default)
[Parsed_cropdetect_1 @ 0x5d1] x1:0 x2:1919 y1:140 y2:939 w:1920 h:784 x:0 y:148 pts:1024 t:1.066667 crop=1920:784:0:148
[Parsed_cropdetect_1 @ 0x5d1] x1:0 x2:1919 y1:138 y2:941 w:1920 h:800 x:0 y:140 pts:2048 t:2.133333 crop=1920:800:0:140
`;

describe("parseCropDetect", () => {
  it("returns the LAST (union) crop suggestion", () => {
    expect(parseCropDetect(CINEMASCOPE_STDERR)).toEqual({ w: 1920, h: 800, x: 0, y: 140 });
  });
  it("returns null when no crop lines exist", () => {
    expect(parseCropDetect("frame=  60 fps=0.0 q=-0.0 size=N/A")).toBeNull();
  });
});

describe("parseSourceDims", () => {
  it("extracts WxH from the video stream line, ignoring codec tags", () => {
    expect(parseSourceDims(CINEMASCOPE_STDERR)).toEqual({ w: 1920, h: 1080 });
  });
  it("ignores audio-only dumps", () => {
    expect(parseSourceDims("Stream #0:0: Audio: aac, 44100 Hz")).toBeNull();
  });
});

describe("pickActiveArea", () => {
  const src = { w: 1920, h: 1080 };
  it("accepts a real centered letterbox", () => {
    const det = { w: 1920, h: 800, x: 0, y: 140 };
    expect(pickActiveArea(det, src.w, src.h)).toEqual(det);
  });
  it("accepts a real centered pillarbox (vertical phone video in 16:9)", () => {
    const det = { w: 608, h: 1080, x: 656, y: 0 };
    expect(pickActiveArea(det, src.w, src.h)).toEqual(det);
  });
  it("rejects sub-3% shrink as noise", () => {
    expect(pickActiveArea({ w: 1900, h: 1070, x: 10, y: 5 }, src.w, src.h)).toBeNull();
  });
  it("rejects suspiciously tiny areas (dark scene)", () => {
    expect(pickActiveArea({ w: 400, h: 300, x: 760, y: 390 }, src.w, src.h)).toBeNull();
  });
  it("rejects centered windows shrunk on BOTH axes (dark scene, not bars)", () => {
    expect(pickActiveArea({ w: 1600, h: 900, x: 160, y: 90 }, src.w, src.h)).toBeNull();
  });
  it("rejects ordinary off-center windows (content, not bars)", () => {
    expect(pickActiveArea({ w: 1920, h: 800, x: 0, y: 20 }, src.w, src.h)).toBeNull();
  });
  it("accepts a wide video panel anchored inside a tall canvas", () => {
    const vertical = { w: 1080, h: 1920 };
    const panel = { w: 1080, h: 608, x: 0, y: 0 };
    expect(pickActiveArea(panel, vertical.w, vertical.h)).toEqual(panel);
  });
  it("rejects degenerate/missing detections and unknown source dims", () => {
    expect(pickActiveArea(null, src.w, src.h)).toBeNull();
    expect(pickActiveArea({ w: 0, h: 0, x: 0, y: 0 }, src.w, src.h)).toBeNull();
    expect(pickActiveArea({ w: 1920, h: 800, x: 0, y: 140 }, 0, 0)).toBeNull();
  });
});

describe("buildClipVf", () => {
  const target = { targetW: 1080, targetH: 1920 };

  it("matches the legacy chain exactly when nothing is detected (regression)", () => {
    expect(buildClipVf({ active: null, srcW: null, srcH: null, ...target, fps: 30 })).toBe(
      "crop=min(iw\\,ih*1080/1920):ih,fps=30," +
      "scale=1080:1920:force_original_aspect_ratio=decrease:force_divisible_by=2," +
      "pad=1080:1920:(ow-iw)/2:(oh-ih)/2,setsar=1",
    );
  });

  it("omits the fps step when fps is null (quality profile)", () => {
    expect(buildClipVf({ active: null, srcW: 1920, srcH: 1080, ...target, fps: null })).toBe(
      "crop=min(iw\\,ih*1080/1920):ih," +
      "scale=1080:1920:force_original_aspect_ratio=decrease:force_divisible_by=2," +
      "pad=1080:1920:(ow-iw)/2:(oh-ih)/2,setsar=1",
    );
  });

  it("strips baked letterbox bars FIRST, then center-crops to 9:16", () => {
    const vf = buildClipVf({ active: { w: 1920, h: 800, x: 0, y: 140 }, srcW: 1920, srcH: 1080, ...target, fps: null });
    expect(vf.startsWith("crop=1920:800:0:140,crop=min(iw\\,ih*1080/1920):ih,")).toBe(true);
    expect(vf).toContain("scale=1080:1920");
    expect(vf).not.toContain("split");
  });

  it("uses the blurred-background composite for narrower-than-9:16 content", () => {
    const vf = buildClipVf({ active: { w: 480, h: 1080, x: 720, y: 0 }, srcW: 1920, srcH: 1080, ...target, fps: 30 });
    expect(vf).toBe(
      "crop=480:1080:720:0,fps=30,split=2[fgs][bgs];" +
      "[fgs]scale=1080:1920:force_original_aspect_ratio=decrease:force_divisible_by=2[fg];" +
      "[bgs]scale=1080:1920:force_original_aspect_ratio=increase:force_divisible_by=2,crop=1080:1920,boxblur=20:2[bg];" +
      "[bg][fg]overlay=(W-w)/2:(H-h)/2,setsar=1",
    );
  });

  it("keeps the plain crop chain for exact 9:16 sources (no pointless blur pass)", () => {
    const vf = buildClipVf({ active: null, srcW: 1080, srcH: 1920, ...target, fps: null });
    expect(vf).not.toContain("split");
  });
});

describe("buildOriginalVf", () => {
  it("scales and pads Original output to 720p without cropping", () => {
    expect(buildOriginalVf({ targetW: 1280, targetH: 720, fps: 30 })).toBe(
      "fps=30,scale=1280:720:force_original_aspect_ratio=decrease:force_divisible_by=2," +
      "pad=1280:720:(ow-iw)/2:(oh-ih)/2,setsar=1",
    );
  });

  it("scales Original output to 1080p without an fps cap", () => {
    expect(buildOriginalVf({ targetW: 1920, targetH: 1080, fps: null })).toBe(
      "scale=1920:1080:force_original_aspect_ratio=decrease:force_divisible_by=2," +
      "pad=1920:1080:(ow-iw)/2:(oh-ih)/2,setsar=1",
    );
  });
});
