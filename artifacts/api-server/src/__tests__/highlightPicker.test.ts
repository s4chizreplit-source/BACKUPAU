/**
 * Unit tests for transcript-based highlight picking.
 *
 * Scenarios:
 *   1. VTT time parsing (HH:MM:SS.mmm, MM:SS.mmm, garbage).
 *   2. parseVTTNumeric extracts numeric segments and dedupes rolling captions.
 *   3. scoreSegmentText rewards excitement words, exclamations, shouting.
 *   4. pickTranscriptTimestamps concentrates picks around high-energy moments
 *      (demonstrably NOT uniform-random).
 *   5. Falls back (returns null) on sparse/absent transcripts.
 *   6. Picked timestamps respect intro/outro margins, gaps, and clip count.
 *   7. pickSpreadTimestamps keeps its original spread behaviour.
 */

import { describe, it, expect } from "vitest";
import {
  vttTimeToSeconds,
  parseVTTNumeric,
  scoreSegmentText,
  pickTranscriptTimestamps,
  pickSpreadTimestamps,
  pickAudioProbeWindows,
  pickAudioEnergyTimestamps,
  introOutroMargin,
  clipCapacity,
  type TranscriptSegment,
  type AudioEnergyMeasurement,
} from "../lib/highlightPicker";

describe("pickAudioProbeWindows", () => {
  it("returns evenly spaced deterministic windows inside the margins", () => {
    const total = 3600, clip = 30;
    const w1 = pickAudioProbeWindows(total, clip, 3);
    const w2 = pickAudioProbeWindows(total, clip, 3);
    expect(w1).toEqual(w2); // deterministic
    const margin = introOutroMargin(total);
    for (const t of w1) {
      expect(t).toBeGreaterThanOrEqual(margin);
      expect(t + clip).toBeLessThanOrEqual(total - margin);
    }
    expect(w1.length).toBeGreaterThanOrEqual(6);
    expect(w1.length).toBeLessThanOrEqual(12);
  });

  it("returns empty when the video is shorter than margins + clip", () => {
    expect(pickAudioProbeWindows(20, 30, 3)).toEqual([]);
  });

  it("caps windows for short videos so probes never overlap-explode", () => {
    const w = pickAudioProbeWindows(200, 30, 5);
    expect(w.length).toBeLessThanOrEqual(Math.floor(200 / 30));
  });
});

describe("pickAudioEnergyTimestamps", () => {
  const m = (start: number, energy: number | null): AudioEnergyMeasurement => ({ start, energy });

  it("keeps the loudest windows", () => {
    const measurements = [m(100, -40), m(400, -12), m(700, -35), m(1000, -8), m(1300, -30)];
    const picked = pickAudioEnergyTimestamps(measurements, 1600, 30, 2);
    expect(picked).toEqual([400, 1000]);
  });

  it("respects the minimum gap between picks", () => {
    const measurements = [m(100, -10), m(110, -11), m(500, -20)];
    const picked = pickAudioEnergyTimestamps(measurements, 1000, 30, 2)!;
    expect(picked).toContain(100);
    expect(picked).not.toContain(110); // within 1.25×clip of 100
    expect(picked).toContain(500);
  });

  it("returns null when fewer than 2 windows were measured", () => {
    expect(pickAudioEnergyTimestamps([m(100, -10), m(400, null)], 1000, 30, 3)).toBeNull();
    expect(pickAudioEnergyTimestamps([m(100, null), m(400, null)], 1000, 30, 3)).toBeNull();
  });

  it("tops up from spread when energy finds fewer peaks than requested", () => {
    const measurements = [m(300, -10), m(310, -12)]; // only one usable peak after gap filter
    const picked = pickAudioEnergyTimestamps(measurements, 3600, 30, 4)!;
    expect(picked.length).toBeGreaterThan(1);
    expect(picked.length).toBeLessThanOrEqual(4);
    // Sorted ascending, no overlaps
    const sorted = [...picked].sort((a, b) => a - b);
    expect(picked).toEqual(sorted);
    for (let i = 1; i < picked.length; i++) {
      expect(picked[i] - picked[i - 1]).toBeGreaterThanOrEqual(30 * 1.25);
    }
  });
});

describe("vttTimeToSeconds", () => {
  it("parses HH:MM:SS.mmm", () => {
    expect(vttTimeToSeconds("01:02:03.500")).toBeCloseTo(3723.5);
  });
  it("parses MM:SS.mmm", () => {
    expect(vttTimeToSeconds("02:03.250")).toBeCloseTo(123.25);
  });
  it("returns -1 for garbage", () => {
    expect(vttTimeToSeconds("not a time")).toBe(-1);
  });
});

describe("parseVTTNumeric", () => {
  const vtt = [
    "WEBVTT",
    "",
    "00:00:01.000 --> 00:00:04.000",
    "hello <c>world</c>",
    "",
    "00:00:04.000 --> 00:00:07.000",
    "hello world", // rolling dupe of previous text
    "",
    "00:00:07.000 --> 00:00:10.000",
    "something new!",
    "",
  ].join("\n");

  it("extracts numeric segments and strips tags", () => {
    const segs = parseVTTNumeric(vtt);
    expect(segs[0]).toEqual({ start: 1, end: 4, text: "hello world" });
  });

  it("dedupes consecutive identical captions", () => {
    const segs = parseVTTNumeric(vtt);
    expect(segs).toHaveLength(2);
    expect(segs[1].text).toBe("something new!");
  });
});

describe("scoreSegmentText", () => {
  it("scores excited speech higher than flat speech of the same length", () => {
    const flat = scoreSegmentText("we are going to look at the data now");
    const hype = scoreSegmentText("oh my god that was INSANE let's go!!!");
    expect(hype).toBeGreaterThan(flat);
  });
  it("returns 0 for empty text", () => {
    expect(scoreSegmentText("   ")).toBe(0);
  });
  it("rewards hook openers over flat statements", () => {
    const flat = scoreSegmentText("we continued with the meeting agenda");
    const hook = scoreSegmentText("nobody tells you the truth about this");
    expect(hook).toBeGreaterThan(flat);
  });
  it("rewards concrete money stakes", () => {
    const flat = scoreSegmentText("I made some money from this project");
    const money = scoreSegmentText("I made 50 lakh rupees from this project");
    expect(money).toBeGreaterThan(flat);
  });
  it("rewards story-turn markers", () => {
    const flat = scoreSegmentText("we kept walking down the same road");
    const turn = scoreSegmentText("but then out of nowhere everything changed");
    expect(turn).toBeGreaterThan(flat);
  });
  it("rewards Hinglish hype words", () => {
    const flat = scoreSegmentText("yeh video dekho aur batao kaisa laga");
    const hype = scoreSegmentText("yeh toh gazab dhamaka hai zabardast scene");
    expect(hype).toBeGreaterThan(flat);
  });
  it("keeps snapped picks in-bounds and non-overlapping (off-grid captions)", () => {
    // Captions deliberately offset from the window grid so snapping kicks in.
    const segs: TranscriptSegment[] = [];
    for (let t = 1.3; t < 600; t += 7.9) {
      segs.push({ start: t, end: t + 6, text: "just some ordinary talking here" });
    }
    for (const h of [101.7, 303.3, 471.9]) {
      for (let t = h; t < h + 20; t += 5) {
        segs.push({ start: t, end: t + 5, text: "OH MY GOD that was INSANE no way!!! unbelievable!!!" });
      }
    }
    segs.sort((a, b) => a.start - b.start);
    const picks = pickTranscriptTimestamps(segs, 600, 30, 5);
    expect(picks).not.toBeNull();
    for (const t of picks!) {
      expect(t).toBeGreaterThanOrEqual(0);
      expect(t).toBeLessThanOrEqual(600 - 30 + 1e-6);
    }
    const sorted = [...picks!].sort((a, b) => a - b);
    for (let i = 1; i < sorted.length; i++) {
      expect(sorted[i] - sorted[i - 1]).toBeGreaterThanOrEqual(30 - 1e-6);
    }
  });
});

/** Build a transcript covering [0, total] with flat captions every 10s, plus a
 *  hype burst around each `hotspot`. */
function makeTranscript(total: number, hotspots: number[]): TranscriptSegment[] {
  const segs: TranscriptSegment[] = [];
  for (let t = 0; t < total; t += 10) {
    segs.push({ start: t, end: t + 8, text: "just some ordinary talking here" });
  }
  for (const h of hotspots) {
    for (let t = h; t < h + 20; t += 5) {
      segs.push({ start: t, end: t + 5, text: "OH MY GOD that was INSANE no way!!! unbelievable!!!" });
    }
  }
  return segs.sort((a, b) => a.start - b.start);
}

describe("pickTranscriptTimestamps", () => {
  const TOTAL = 3600; // 1-hour video
  const CLIP = 30;

  it("concentrates picks near high-energy moments (not uniform)", () => {
    const hotspots = [600, 1500, 2700];
    const picked = pickTranscriptTimestamps(makeTranscript(TOTAL, hotspots), TOTAL, CLIP, 3);
    expect(picked).not.toBeNull();
    expect(picked).toHaveLength(3);
    // Every pick lands within ±45s of some hotspot — impossible for uniform spread.
    for (const p of picked!) {
      expect(hotspots.some((h) => Math.abs(p - h) <= 45)).toBe(true);
    }
  });

  it("is deterministic (no randomness in transcript mode)", () => {
    const segs = makeTranscript(TOTAL, [900, 2000]);
    const a = pickTranscriptTimestamps(segs, TOTAL, CLIP, 2);
    const b = pickTranscriptTimestamps(segs, TOTAL, CLIP, 2);
    expect(a).toEqual(b);
  });

  it("respects intro/outro margins", () => {
    const margin = introOutroMargin(TOTAL);
    const picked = pickTranscriptTimestamps(makeTranscript(TOTAL, [10, 3550]), TOTAL, CLIP, 5)!;
    for (const p of picked) {
      expect(p).toBeGreaterThanOrEqual(margin);
      expect(p).toBeLessThanOrEqual(TOTAL - margin - CLIP);
    }
  });

  it("keeps a minimum gap between picks", () => {
    const picked = pickTranscriptTimestamps(makeTranscript(TOTAL, [1000]), TOTAL, CLIP, 5)!;
    const sorted = [...picked].sort((x, y) => x - y);
    for (let i = 1; i < sorted.length; i++) {
      expect(sorted[i] - sorted[i - 1]).toBeGreaterThanOrEqual(CLIP * 1.25 - 1e-6);
    }
  });

  it("tops up to the requested count when few peaks exist", () => {
    const picked = pickTranscriptTimestamps(makeTranscript(TOTAL, [1800]), TOTAL, CLIP, 5);
    expect(picked!.length).toBe(5);
  });

  it("returns null when transcript has too few segments", () => {
    const sparse: TranscriptSegment[] = [
      { start: 100, end: 105, text: "hi" },
      { start: 200, end: 205, text: "there" },
    ];
    expect(pickTranscriptTimestamps(sparse, TOTAL, CLIP, 3)).toBeNull();
  });

  it("returns null when transcript covers too little of the video", () => {
    // 10 segments all crammed into the first 100s of an hour-long video
    const clustered: TranscriptSegment[] = [];
    for (let t = 300; t < 400; t += 10) {
      clustered.push({ start: t, end: t + 8, text: "words words words words" });
    }
    expect(pickTranscriptTimestamps(clustered, TOTAL, CLIP, 3)).toBeNull();
  });

  it("returns null when the video is shorter than the clip + margins", () => {
    expect(pickTranscriptTimestamps(makeTranscript(20, []), 20, 30, 3)).toBeNull();
  });
});

describe("pickSpreadTimestamps", () => {
  it("returns [0] when the video is shorter than the clip", () => {
    expect(pickSpreadTimestamps(20, 30, 3)).toEqual([0]);
  });

  it("spreads picks across sections within margins", () => {
    const total = 3600, clip = 30;
    const margin = introOutroMargin(total);
    const out = pickSpreadTimestamps(total, clip, 5);
    expect(out).toHaveLength(5);
    for (const t of out) {
      expect(t).toBeGreaterThanOrEqual(margin);
      expect(t).toBeLessThanOrEqual(total - margin - clip);
    }
    // Ascending — one per section
    for (let i = 1; i < out.length; i++) expect(out[i]).toBeGreaterThan(out[i - 1]);
  });
});

describe("clipCapacity", () => {
  it("counts butt-joined fits — a 164s video holds five 30s clips", () => {
    expect(clipCapacity(164, 30)).toBe(5);
  });
  it("returns 1 when only a single clip fits", () => {
    expect(clipCapacity(40, 30)).toBe(1);
  });
  it("returns 0 when the video is shorter than one clip", () => {
    expect(clipCapacity(20, 30)).toBe(0);
  });
});

describe("short-video clip counts (requested vs delivered)", () => {
  it("spread packs wall-to-wall when the request needs full capacity", () => {
    const picks = pickSpreadTimestamps(164, 30, 5);
    expect(picks).toHaveLength(5);
    const sorted = [...picks].sort((a, b) => a - b);
    for (let i = 1; i < sorted.length; i++) {
      expect(sorted[i] - sorted[i - 1]).toBeGreaterThanOrEqual(30);
    }
    for (const t of sorted) expect(t + 30).toBeLessThanOrEqual(164);
  });

  it("spread never returns more than capacity", () => {
    expect(pickSpreadTimestamps(164, 30, 10)).toHaveLength(5);
  });

  it("randomized spread keeps starts at least a clip apart", () => {
    for (let run = 0; run < 25; run++) {
      const picks = pickSpreadTimestamps(600, 30, 3);
      const sorted = [...picks].sort((a, b) => a - b);
      for (let i = 1; i < sorted.length; i++) {
        expect(sorted[i] - sorted[i - 1]).toBeGreaterThanOrEqual(30);
      }
    }
  });

  it("audio picker delivers the full requested count when the video holds it", () => {
    // Real regression: 164s video, 5×30s requested, probe windows ~33.5s apart
    // (closer than the 37.5s curated gap) — old code returned only 2 clips.
    const m = (start: number, energy: number): AudioEnergyMeasurement => ({ start, energy });
    const measurements = [m(16.75, -10), m(50.25, -20), m(83.75, -12), m(117.25, -25)];
    const picked = pickAudioEnergyTimestamps(measurements, 164, 30, 5)!;
    expect(picked).toHaveLength(5);
    for (let i = 1; i < picked.length; i++) {
      expect(picked[i] - picked[i - 1]).toBeGreaterThanOrEqual(30);
    }
    for (const t of picked) expect(t + 30).toBeLessThanOrEqual(164);
  });

  it("audio picker re-packs around the loudest moment on fragmented timelines", () => {
    // Peaks 58s apart fragment a 176s timeline: strict picking yields 3, but
    // five 30s clips fit — the final pass must anchor on the loudest pick.
    const m = (start: number, energy: number): AudioEnergyMeasurement => ({ start, energy });
    const measurements = [m(14.6, -8), m(43.8, -30), m(73, -12), m(102.2, -28), m(131.4, -15)];
    const picked = pickAudioEnergyTimestamps(measurements, 176, 30, 5)!;
    expect(picked).toHaveLength(5);
    for (let i = 1; i < picked.length; i++) {
      // 1e-6 tolerance: butt-joined starts differ by exactly one clip length,
      // but decimal floats drift a few femtoseconds.
      expect(picked[i] - picked[i - 1]).toBeGreaterThanOrEqual(30 - 1e-6);
    }
    for (const t of picked) expect(t + 30).toBeLessThanOrEqual(176);
    // The loudest moment (14.6s) must survive the re-pack.
    expect(picked.some((t) => Math.abs(t - 14.6) < 1)).toBe(true);
  });
});

describe("long-video margins at near-capacity requests", () => {
  it("keeps every pick inside the intro/outro margins at full capacity", () => {
    // 600s video → 30s margins each side, pickable window [30, 570].
    const cap = clipCapacity(600, 30);
    expect(cap).toBe(18); // floor((600-60-30)/30)+1
    const picks = pickSpreadTimestamps(600, 30, 18);
    expect(picks).toHaveLength(18);
    const sorted = [...picks].sort((a, b) => a - b);
    expect(sorted[0]).toBeGreaterThanOrEqual(30 - 1e-6);
    expect(sorted[sorted.length - 1] + 30).toBeLessThanOrEqual(570 + 1e-6);
    for (let i = 1; i < sorted.length; i++) {
      expect(sorted[i] - sorted[i - 1]).toBeGreaterThanOrEqual(30 - 1e-6);
    }
  });
});
