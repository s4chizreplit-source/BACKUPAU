import { describe, it, expect } from "vitest";
import {
  SUBTITLE_STYLE_IDS,
  normalizeSubtitleStyle,
  cuesForClip,
  buildAss,
  subtitlesVfArg,
} from "../lib/subtitleBurn";
import type { TranscriptSegment } from "../lib/highlightPicker";

describe("normalizeSubtitleStyle", () => {
  it("accepts every gallery style id", () => {
    for (const id of SUBTITLE_STYLE_IDS) {
      expect(normalizeSubtitleStyle({ style: id })).toBe(id);
    }
  });

  it("has all 55 gallery styles", () => {
    expect(SUBTITLE_STYLE_IDS).toHaveLength(55);
  });

  it("rejects junk shapes and unknown styles", () => {
    expect(normalizeSubtitleStyle(null)).toBeNull();
    expect(normalizeSubtitleStyle(undefined)).toBeNull();
    expect(normalizeSubtitleStyle("hormozi")).toBeNull(); // must be an object
    expect(normalizeSubtitleStyle({})).toBeNull();
    expect(normalizeSubtitleStyle({ style: "definitely-not-a-style" })).toBeNull();
    expect(normalizeSubtitleStyle({ style: 42 })).toBeNull();
  });
});

describe("cuesForClip", () => {
  const segs: TranscriptSegment[] = [
    { start: 10, end: 16, text: "one two three four five six" },
    { start: 20, end: 22, text: "seven eight" },
    { start: 40, end: 44, text: "outside the window" },
  ];

  it("keeps only overlapping segments, times relative to the clip", () => {
    const cues = cuesForClip(segs, 10, 30);
    expect(cues.length).toBeGreaterThan(0);
    expect(cues.every((c) => c.start >= 0 && c.end <= 20.001)).toBe(true);
    expect(cues.some((c) => c.text.includes("outside"))).toBe(false);
  });

  it("chunks long segments into ≤3-word cues with interpolated times", () => {
    const cues = cuesForClip([segs[0]], 10, 30);
    expect(cues.map((c) => c.text)).toEqual(["one two three", "four five six"]);
    expect(cues[0].start).toBeCloseTo(0, 2);
    expect(cues[0].end).toBeCloseTo(3, 2);
    expect(cues[1].start).toBeCloseTo(3, 2);
    expect(cues[1].end).toBeCloseTo(6, 2);
  });

  it("clamps a segment straddling the clip start", () => {
    const cues = cuesForClip([{ start: 8, end: 12, text: "hello world" }], 10, 30);
    expect(cues).toHaveLength(1);
    expect(cues[0].start).toBe(0);
    expect(cues[0].text).toBe("hello world");
  });

  it("extends blink-short cues to a readable minimum", () => {
    const cues = cuesForClip([{ start: 0, end: 0.2, text: "hi" }], 0, 30);
    expect(cues).toHaveLength(1);
    expect(cues[0].end - cues[0].start).toBeGreaterThanOrEqual(0.35);
  });

  it("never extends a cue past the next cue's start or the clip end", () => {
    // Rapid speech: two 0.3s chunks back to back — extension must not overlap.
    const cues = cuesForClip([{ start: 0, end: 0.6, text: "a b c d e f" }], 0, 30);
    expect(cues).toHaveLength(2);
    expect(cues[0].end).toBeLessThanOrEqual(cues[1].start);
    // Cue at the very end of the clip cannot spill past it.
    const tail = cuesForClip([{ start: 29.9, end: 30.1, text: "bye" }], 0, 30);
    expect(tail.every((c) => c.end <= 30)).toBe(true);
  });

  it("strips html-ish tags and collapses whitespace", () => {
    const cues = cuesForClip([{ start: 0, end: 2, text: "<c.color>hello</c>   there" }], 0, 30);
    expect(cues).toHaveLength(1);
    expect(cues[0].text).toBe("hello there");
  });

  it("returns nothing for an empty or non-overlapping transcript", () => {
    expect(cuesForClip([], 0, 30)).toEqual([]);
    expect(cuesForClip(segs, 100, 130)).toEqual([]);
  });
});

describe("buildAss", () => {
  const cues = [
    { start: 0, end: 1.5, text: "hey there" },
    { start: 1.5, end: 3, text: "subtitles work" },
  ];

  it("emits a complete v4+ document sized for the vertical canvas", () => {
    const doc = buildAss(cues, "basic");
    expect(doc).toContain("[Script Info]");
    expect(doc).toContain("PlayResX: 1080");
    expect(doc).toContain("PlayResY: 1920");
    expect(doc).toContain("[V4+ Styles]");
    expect(doc.match(/^Dialogue:/gm)).toHaveLength(2);
  });

  it("formats centisecond timestamps", () => {
    const doc = buildAss(cues, "basic");
    expect(doc).toContain("Dialogue: 0,0:00:00.00,0:00:01.50,Cap");
    expect(doc).toContain("Dialogue: 0,0:00:01.50,0:00:03.00,Cap");
  });

  it("uppercases text for shouty styles only", () => {
    expect(buildAss(cues, "hormozi")).toContain("HEY THERE");
    expect(buildAss(cues, "basic")).toContain("hey there");
  });

  it("strips ASS override characters from cue text", () => {
    // "a{\b1}c" → braces and backslash stripped, inner chars kept: "ab1c"
    const doc = buildAss([{ start: 0, end: 1, text: "a{\\b1}c" }], "basic");
    expect(doc).not.toContain("{");
    expect(doc).not.toContain("\\b1");
    expect(doc.split("\n").some((l) => l.startsWith("Dialogue:") && l.endsWith("ab1c"))).toBe(true);
  });

  it("builds a valid document for every gallery style", () => {
    for (const id of SUBTITLE_STYLE_IDS) {
      const doc = buildAss(cues, id);
      expect(doc).toContain("Style: Cap,");
      expect(doc.match(/^Dialogue:/gm)).toHaveLength(2);
    }
  });

  it("prefixes glow styles with a \\blur override", () => {
    const doc = buildAss(cues, "cherryglow");
    for (const line of doc.split("\n").filter((l) => l.startsWith("Dialogue:"))) {
      expect(line).toContain(",{\\blur4}");
    }
    expect(buildAss(cues, "basic")).not.toContain("\\blur");
  });

  it("cycles word colours for eyecandy", () => {
    const doc = buildAss([{ start: 0, end: 1, text: "hey there friend again hey" }], "eyecandy");
    // 4-colour cycle: word 5 wraps back to colour 1.
    expect(doc).toContain("{\\c&H00C34FFF}hey {\\c&H00FF4FB4}there {\\c&H0071CC2E}friend {\\c&H002E9FFF}again {\\c&H00C34FFF}hey");
  });

  it("still strips user override tags in decorated styles", () => {
    const doc = buildAss([{ start: 0, end: 1, text: "a{\\b1}c d" }], "eyecandy");
    expect(doc).not.toContain("\\b1"); // user's tag stripped…
    expect(doc).toContain("{\\c&H00C34FFF}ab1c {\\c&H00FF4FB4}d"); // …ours intact
  });
});

describe("subtitlesVfArg", () => {
  it("wraps the path for the ffmpeg filter parser", () => {
    expect(subtitlesVfArg("/tmp/job/subs_000.ass")).toBe("subtitles=filename='/tmp/job/subs_000.ass'");
  });

  it("escapes quotes and backslashes", () => {
    expect(subtitlesVfArg("/tmp/a'b.ass")).toBe("subtitles=filename='/tmp/a\\'b.ass'");
    expect(subtitlesVfArg("C:\\x.ass")).toBe("subtitles=filename='C:\\\\x.ass'");
  });
});
