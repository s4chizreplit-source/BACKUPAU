/**
 * parseJson3Numeric — YouTube json3 timedtext parsing.
 *
 * json3 is the primary transcript format: YouTube 429-throttles the vtt
 * timedtext endpoint on datacenter IPs while json3 downloads fine. The parser
 * must produce the same cue-level TranscriptSegment shape as parseVTTNumeric.
 */
import { describe, it, expect } from "vitest";
import { parseJson3Numeric } from "../lib/highlightPicker";

const sample = JSON.stringify({
  wireMagic: "pb3",
  events: [
    // Window-definition event — no text, no duration semantics we care about.
    { tStartMs: 0, dDurationMs: 540000, id: 1, wpWinPosId: 2, wsWinStyleId: 1 },
    // Normal ASR cue built from word-level segs.
    {
      tStartMs: 1200,
      dDurationMs: 2800,
      segs: [{ utf8: "kya" }, { utf8: " scene" }, { utf8: " hai" }],
    },
    // Newline-only spacer event — must be dropped.
    { tStartMs: 4000, dDurationMs: 10, segs: [{ utf8: "\n" }] },
    // Scroll-append artifact — text already covered by the prior cue.
    { tStartMs: 4000, dDurationMs: 2500, aAppend: 1, segs: [{ utf8: "kya scene hai" }] },
    // Next real cue.
    { tStartMs: 4010, dDurationMs: 1990, segs: [{ utf8: "bhai " }, { utf8: "dekh" }] },
    // Rolling duplicate of the previous line — must be deduped.
    { tStartMs: 6000, dDurationMs: 1500, segs: [{ utf8: "bhai dekh" }] },
    // Missing duration — dropped.
    { tStartMs: 9000, segs: [{ utf8: "no duration" }] },
  ],
});

describe("parseJson3Numeric", () => {
  it("extracts cue-level segments with numeric times", () => {
    const segs = parseJson3Numeric(sample);
    expect(segs).toEqual([
      { start: 1.2, end: 4.0, text: "kya scene hai" },
      { start: 4.01, end: 6.0, text: "bhai dekh" },
    ]);
  });

  it("returns [] for malformed JSON", () => {
    expect(parseJson3Numeric("{not json")).toEqual([]);
  });

  it("returns [] when events is missing", () => {
    expect(parseJson3Numeric(JSON.stringify({ wireMagic: "pb3" }))).toEqual([]);
  });

  it("collapses internal whitespace in seg text", () => {
    const raw = JSON.stringify({
      events: [{ tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: "  hello \n" }, { utf8: "  world " }] }],
    });
    expect(parseJson3Numeric(raw)).toEqual([{ start: 0, end: 1, text: "hello world" }]);
  });
});
