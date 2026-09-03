import { describe, expect, it } from "vitest";
import {
  needsVerticalPad, buildVerticalPadFilter, MAX_SHORT_SEC,
  createPaddedMediaToken, verifyPaddedMediaToken,
  isPaddedMetaExpired, PADDED_RETENTION_MS, needsCompatibilityTranscode,
} from "../lib/verticalPad";

describe("needsVerticalPad", () => {
  it("pads wider-than-tall Shorts-length videos (the live YouTube long-form bug)", () => {
    expect(needsVerticalPad(960, 720, 17.4)).toBe(true);   // 4:3 reel repost
    expect(needsVerticalPad(792, 720, 12.6)).toBe(true);   // slightly-wide meme
    expect(needsVerticalPad(1280, 720, 26)).toBe(true);    // 16:9 feed post
  });
  it("leaves square and vertical untouched — already Shorts-eligible", () => {
    expect(needsVerticalPad(720, 720, 14.4)).toBe(false);
    expect(needsVerticalPad(576, 1024, 10)).toBe(false);
    expect(needsVerticalPad(720, 1280, 6.4)).toBe(false);
  });
  it("skips videos too long to ever be a Short", () => {
    expect(needsVerticalPad(1920, 1080, MAX_SHORT_SEC)).toBe(true);
    expect(needsVerticalPad(1920, 1080, MAX_SHORT_SEC + 1)).toBe(false);
  });
  it("treats unknown dims/duration as not-paddable (post original instead)", () => {
    expect(needsVerticalPad(0, 0, 10)).toBe(false);
    expect(needsVerticalPad(NaN, 720, 10)).toBe(false);
    expect(needsVerticalPad(960, 720, NaN)).toBe(false);
    expect(needsVerticalPad(960, 720, 0)).toBe(false);
  });
});

describe("buildVerticalPadFilter", () => {
  it("targets a blurred 1080x1920 canvas with centered overlay", () => {
    const f = buildVerticalPadFilter();
    expect(f).toContain("1080:1920");
    expect(f).toContain("boxblur");
    expect(f).toContain("overlay=(W-w)/2:(H-h)/2");
    expect(f).toContain("format=yuv420p");
  });
});

describe("padded media tokens", () => {
  const id = "a".repeat(32);
  it("round-trips a valid id", () => {
    const t = createPaddedMediaToken(id);
    expect(verifyPaddedMediaToken(t)).toBe(id);
  });
  it("rejects expiry and tampering", () => {
    const t = createPaddedMediaToken(id, Date.now());
    expect(verifyPaddedMediaToken(t, Date.now() + 401 * 24 * 60 * 60 * 1000)).toBeNull();
    const [payload1, payload2, sig] = t.split(".");
    expect(verifyPaddedMediaToken(`${"b".repeat(32)}.${payload2}.${sig}`)).toBeNull();
    expect(verifyPaddedMediaToken(`${payload1}.${payload2}.${sig.slice(0, -2)}xx`)).toBeNull();
  });
  it("refuses to mint for malformed ids", () => {
    expect(() => createPaddedMediaToken("not-hex!")).toThrow();
  });
});

describe("isPaddedMetaExpired", () => {
  const now = 1_800_000_000_000;
  it("expires only past the retention window", () => {
    expect(isPaddedMetaExpired({ touchedMs: now - PADDED_RETENTION_MS - 1 }, now)).toBe(true);
    expect(isPaddedMetaExpired({ touchedMs: now - PADDED_RETENTION_MS + 60_000 }, now)).toBe(false);
    expect(isPaddedMetaExpired({ touchedMs: now }, now)).toBe(false);
  });
  it("never expires corrupt/missing meta — sweeper heals it instead", () => {
    expect(isPaddedMetaExpired(null, now)).toBe(false);
    expect(isPaddedMetaExpired({}, now)).toBe(false);
    expect(isPaddedMetaExpired({ touchedMs: "yesterday" }, now)).toBe(false);
    expect(isPaddedMetaExpired("garbage", now)).toBe(false);
  });
});

describe("forced compatibility transcode", () => {
  it("normalizes MOV/M4V phone exports but not ordinary MP4 files", () => {
    expect(needsCompatibilityTranscode("camera.MOV")).toBe(true);
    expect(needsCompatibilityTranscode("upload.m4v")).toBe(true);
    expect(needsCompatibilityTranscode("clip.mp4")).toBe(false);
  });
});
