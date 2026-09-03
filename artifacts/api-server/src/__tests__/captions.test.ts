/**
 * Unit tests for the viral caption generator (lib/captions.ts).
 *
 * Captions are deterministic per (seed, clipIndex) — stable across restarts
 * and autoscale instances — while varying across clips and sources.
 */
import { describe, it, expect } from "vitest";
import { buildClipCaption, detectCaptionLanguage, type ClipCaptionInput } from "../lib/captions";

const base: ClipCaptionInput = {
  srcKind: "youtube",
  outputFormat: "shorts",
  clipIndex: 0,
  clipCount: 5,
  durationSec: 30,
  seed: "https://youtube.com/watch?v=abc123",
};

describe("buildClipCaption", () => {
  it("produces a hook line plus a hashtag block", () => {
    const cap = buildClipCaption(base);
    const [text, tags] = cap.split("\n\n");
    expect(text.length).toBeGreaterThan(5);
    expect(text.startsWith("#")).toBe(false);
    const tagList = tags.split(" ");
    expect(tagList.length).toBeGreaterThanOrEqual(6);
    expect(tagList.every(t => t.startsWith("#"))).toBe(true);
    expect(cap).toContain("#viral");
  });

  it("is deterministic for the same seed + index", () => {
    expect(buildClipCaption(base)).toBe(buildClipCaption({ ...base }));
  });

  it("gives every clip in a job a different caption", () => {
    const caps = [0, 1, 2, 3, 4].map(clipIndex => buildClipCaption({ ...base, clipIndex }));
    expect(new Set(caps).size).toBe(caps.length);
  });

  it("varies across different source videos", () => {
    const a = buildClipCaption(base);
    const b = buildClipCaption({ ...base, seed: "https://youtube.com/watch?v=zzz999" });
    expect(a).not.toBe(b);
  });

  it("never duplicates a hashtag", () => {
    for (let i = 0; i < 8; i++) {
      const cap = buildClipCaption({ ...base, clipIndex: i, srcKind: "kick" });
      const tags = cap.split("\n\n")[1].split(" ");
      expect(new Set(tags).size).toBe(tags.length);
    }
  });

  it("adds source-platform tags for stream clips", () => {
    const cap = buildClipCaption({ ...base, srcKind: "kick" });
    expect(cap).toContain("#kick");
  });

  it("pulls topic hashtags out of an uploaded filename", () => {
    const cap = buildClipCaption({
      ...base,
      srcKind: "upload",
      sourceName: "Mera Goa Trip VLOG (final_v2).mp4",
      seed: "upload://abc123/Mera%20Goa%20Trip%20VLOG.mp4",
    });
    expect(cap).toMatch(/#(goa|trip|vlog)/);
  });

  it("keeps captions comfortably under platform limits", () => {
    for (let i = 0; i < 10; i++) {
      const cap = buildClipCaption({
        ...base,
        clipIndex: i,
        durationSec: 59,
        srcKind: "twitch",
        sourceName: "supercalifragilistic adventure compilation.mp4",
      });
      expect(cap.length).toBeLessThanOrEqual(400);
    }
  });

  it("never emits machine-noise hashtags from messy filenames", () => {
    const messy = [
      "IMG_20240513_142530.mp4",
      "550e8400-e29b-41d4-a716-446655440000.mp4",
      "WhatsApp Video 2024-05-13 at 10.11.12.mp4",
      "screen_recording_x264_1080p_final.mp4",
    ];
    for (const sourceName of messy) {
      const cap = buildClipCaption({
        ...base,
        srcKind: "upload",
        sourceName,
        seed: `upload://x/${encodeURIComponent(sourceName)}`,
      });
      const tags = cap.split("\n\n")[1].split(" ");
      expect(tags.some(t => /\d/.test(t))).toBe(false); // no id/date fragments
      expect(cap).not.toMatch(/#(img|whatsapp|screen|recording|x264|1080p)/i);
      expect(cap).toContain("#viral"); // still a full, usable caption
    }
  });

  it("handles unknown sources and missing filenames cleanly", () => {
    const cap = buildClipCaption({ ...base, srcKind: "unknown", seed: "https://cdn.example.com/v.mp4" });
    expect(cap).toContain("#viral");
    expect(cap.split(/\s+/)).not.toContain("#youtube");
    expect(cap).not.toContain("undefined");
  });

  it("detects Devanagari Hindi and romanized Hindi", () => {
    expect(detectCaptionLanguage("आज का सबसे बढ़िया सीन")).toBe("hi");
    expect(detectCaptionLanguage("yeh wala moment sabse zabardast hai")).toBe("hi");
    expect(detectCaptionLanguage("This moment is absolutely incredible")).toBe("en");
  });

  it("keeps social captions English even when the source language is Hindi", () => {
    const hindi = buildClipCaption({ ...base, language: "hi" });
    const english = buildClipCaption({ ...base, language: "en" });
    expect(hindi).toMatch(/[A-Za-z]/);
    expect(hindi).not.toMatch(/[\u0900-\u097f]/u);
    expect(english).toMatch(/[A-Za-z]/);
    expect(english).not.toMatch(/[\u0900-\u097f]/u);
  });

  it("uses prompt and matched-moment context for relevant hashtags", () => {
    const cap = buildClipCaption({
      ...base,
      prompt: "Find funny gaming reactions and rage moments",
      promptReason: "The player reacts to an unexpected win",
    });
    expect(cap).toMatch(/#(funny|gaming|reactions|rage)/);
    expect(cap).toContain("#shorts");
    expect(cap).not.toMatch(/#(caption|find|moment|moments)/);
  });
});
