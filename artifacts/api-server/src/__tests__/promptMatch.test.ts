import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  MAX_PROMPT_LEN,
  TRANSCRIPT_BUCKET_SEC,
  chunkTranscript,
  formatTranscriptLines,
  matchPromptMoments,
  parseMomentsReply,
  parseStartValue,
  pickPromptMoments,
  promptStartWindow,
  sanitizePrompt,
} from "../lib/promptMatch";
import type { TranscriptSegment } from "../lib/highlightPicker";

const OLD_KEY = process.env.GEMINI_API_KEY;
beforeEach(() => {
  process.env.GEMINI_API_KEY = "test-gemini-key";
});
afterEach(() => {
  if (OLD_KEY === undefined) delete process.env.GEMINI_API_KEY;
  else process.env.GEMINI_API_KEY = OLD_KEY;
});

function seg(start: number, end: number, text: string): TranscriptSegment {
  return { start, end, text };
}

/** Gemini-shaped response whose reply text is `text`. */
function geminiReply(text: string) {
  return { candidates: [{ content: { parts: [{ text }] } }] };
}

describe("sanitizePrompt", () => {
  it("trims and collapses whitespace", () => {
    expect(sanitizePrompt("  clip   the\n goals  ")).toBe("clip the goals");
  });
  it("rejects non-strings and empties", () => {
    expect(sanitizePrompt(undefined)).toBeNull();
    expect(sanitizePrompt(null)).toBeNull();
    expect(sanitizePrompt(42)).toBeNull();
    expect(sanitizePrompt("   ")).toBeNull();
  });
  it("does not cap length — the route rejects over-long prompts explicitly", () => {
    const long = "x".repeat(MAX_PROMPT_LEN + 100);
    expect(sanitizePrompt(long)).toHaveLength(MAX_PROMPT_LEN + 100);
  });
});

describe("formatTranscriptLines", () => {
  it("buckets segments into [m:ss] lines", () => {
    const lines = formatTranscriptLines([
      seg(2, 4, "hello there"),
      seg(5, 8, "big   news"),
      seg(16, 18, "second bucket"),
      seg(65, 66, "minute one"),
    ]);
    expect(lines).toEqual([
      "[0:00] hello there big news",
      "[0:15] second bucket",
      "[1:00] minute one",
    ]);
  });
  it("skips empty text and negative starts, keeps time order", () => {
    const lines = formatTranscriptLines([
      seg(40, 41, "later"),
      seg(-5, 1, "garbage"),
      seg(3, 4, "   "),
      seg(1, 2, "early"),
    ]);
    expect(lines).toEqual(["[0:00] early", `[0:${TRANSCRIPT_BUCKET_SEC * 2}] later`]);
  });
  it("keeps diarized speaker labels when a voice changes", () => {
    expect(formatTranscriptLines([
      { ...seg(2, 4, "first voice"), speaker: "S1" },
      { ...seg(5, 8, "second voice"), speaker: "S2" },
    ])).toEqual(["[0:00] S1: first voice S2: second voice"]);
  });
});

describe("chunkTranscript", () => {
  it("keeps small transcripts in one chunk", () => {
    expect(chunkTranscript(["[0:00] a", "[0:15] b"])).toHaveLength(1);
  });
  it("splits on the char budget and caps chunk count", () => {
    const lines = Array.from({ length: 40 }, (_, i) => `[${i}:00] ${"x".repeat(50)}`);
    const chunks = chunkTranscript(lines, 300, 3);
    expect(chunks.length).toBe(3);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(300);
    // Lines beyond the cap are dropped, never merged into an oversized chunk.
    expect(chunks.join("\n").length).toBeLessThan(lines.join("\n").length);
  });
});

describe("parseStartValue", () => {
  it("accepts numbers, numeric strings, and clock strings", () => {
    expect(parseStartValue(90)).toBe(90);
    expect(parseStartValue("90")).toBe(90);
    expect(parseStartValue("90.5")).toBe(90.5);
    expect(parseStartValue("1:30")).toBe(90);
    expect(parseStartValue("1:02:03")).toBe(3723);
  });
  it("rejects garbage", () => {
    expect(parseStartValue(-5)).toBeNull();
    expect(parseStartValue("soon")).toBeNull();
    expect(parseStartValue(NaN)).toBeNull();
    expect(parseStartValue({})).toBeNull();
    expect(parseStartValue(undefined)).toBeNull();
  });
});

describe("parseMomentsReply", () => {
  it("parses the strict shape", () => {
    const out = parseMomentsReply('[{"start":30,"end":35,"reason":"goal scored","relevance":90}]');
    expect(out).toEqual([{ start: 30, end: 35, reason: "goal scored", score: 90 }]);
  });
  it("tolerates code fences without relaxing the strict match fields", () => {
    const fenced = "```json\n[{\"start\":\"1:05\",\"end\":\"1:10\",\"reason\":\"funny bit\",\"score\":70}]\n```";
    expect(parseMomentsReply(fenced)).toEqual([{ start: 65, end: 70, reason: "funny bit", score: 70 }]);
  });
  it("defaults missing relevance to 50 and caps reasons at 90 chars", () => {
    const out = parseMomentsReply(`{"moments":[{"start":5,"end":7,"reason":"${"r".repeat(200)}"}]}`);
    expect(out[0].score).toBe(50);
    expect(out[0].reason).toHaveLength(90);
  });
  it("drops entries without complete evidence bounds/reason and survives garbage", () => {
    expect(parseMomentsReply('{"moments":[{"reason":"no start"},{"start":5,"reason":"no end"},{"start":8,"end":7,"reason":"bad range"}]}')).toEqual([]);
    expect(parseMomentsReply("not json at all")).toEqual([]);
    expect(parseMomentsReply('{"moments":"nope"}')).toEqual([]);
  });
  it("rejects a nonempty model response with incomplete evidence", () => {
    expect(parseMomentsReply('[{"start":10,"reason":"missing end"}]')).toEqual([]);
  });
});

describe("pickPromptMoments", () => {
  it("keeps highest relevance, enforces non-overlap, sorts by start", () => {
    const out = pickPromptMoments(
      [
        { start: 100, reason: "ok", score: 60 },
        { start: 110, reason: "overlaps best", score: 55 }, // within 30s of 100
        { start: 300, reason: "best", score: 95 },
        { start: 10, reason: "third", score: 40 },
      ],
      600, 30, 3,
    );
    expect(out).toEqual([
      { start: 10, reason: "third" },
      { start: 100, reason: "ok" },
      { start: 300, reason: "best" },
    ]);
  });
  it("clamps starts so the clip always fits inside the video", () => {
    const out = pickPromptMoments([{ start: 999, reason: "end", score: 80 }], 120, 30, 2);
    expect(out).toEqual([{ start: 90, reason: "end" }]);
  });
  it("no intro/outro margin — a matched moment at 0s stays at 0s", () => {
    const out = pickPromptMoments([{ start: 0, reason: "cold open", score: 80 }], 3600, 30, 1);
    expect(out).toEqual([{ start: 0, reason: "cold open" }]);
  });
  it("centers a short matching passage inside the requested clip", () => {
    const out = pickPromptMoments([{ start: 100, end: 110, reason: "short proof", score: 80 }], 600, 30, 1);
    expect(out).toEqual([{ start: 90, reason: "short proof" }]);
  });
  it("enforces an explicit first-N-minutes window on the actual clip start", () => {
    const window = promptStartWindow("only moments about goals from the first 15 minutes");
    expect(window).toEqual({ minStart: 0, maxStart: 900 });
    const out = pickPromptMoments([
      { start: 895, end: 899, reason: "goal in range", score: 90 },
      { start: 905, end: 910, reason: "goal outside", score: 99 },
    ], 1800, 30, 2, window);
    expect(out).toEqual([{ start: 882, reason: "goal in range" }]);
  });
  it("respects the requested count", () => {
    const cands = [0, 100, 200, 300].map((s) => ({ start: s, reason: "m", score: 50 }));
    expect(pickPromptMoments(cands, 600, 30, 2)).toHaveLength(2);
  });
});

describe("matchPromptMoments", () => {
  const segments = Array.from({ length: 20 }, (_, i) => seg(i * 20, i * 20 + 5, `line number ${i}`));
  const base = { prompt: "clip the goals", segments, totalDuration: 400, clipDuration: 30, count: 2 };

  it("returns picked moments and keeps the key in a header, never the URL", async () => {
    const calls: { url: string; headers: Record<string, string> }[] = [];
    const fetchImpl = (async (url: unknown, init?: { headers?: Record<string, string> }) => {
      calls.push({ url: String(url), headers: init?.headers ?? {} });
      return {
        ok: true,
        json: async () => geminiReply('[{"start":60,"end":70,"reason":"goal one","relevance":90},{"start":200,"end":220,"reason":"goal two","relevance":80}]'),
      };
    }) as unknown as typeof fetch;
    const out = await matchPromptMoments({ ...base, fetchImpl });
    expect(out).toEqual({ kind: "matched", moments: [
      { start: 50, reason: "goal one" },
      { start: 195, reason: "goal two" },
    ] });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).not.toContain("test-gemini-key");
    expect(calls[0].headers["x-goog-api-key"]).toBe("test-gemini-key");
  });

  it("returns null without a key", async () => {
    delete process.env.GEMINI_API_KEY;
    const fetchImpl = (async () => { throw new Error("must not be called"); }) as unknown as typeof fetch;
    expect(await matchPromptMoments({ ...base, fetchImpl })).toEqual({ kind: "unavailable" });
  });

  it("returns null when every request fails (HTTP error)", async () => {
    const fetchImpl = (async () => ({ ok: false, status: 500, json: async () => ({}) })) as unknown as typeof fetch;
    expect(await matchPromptMoments({ ...base, fetchImpl })).toEqual({ kind: "unavailable" });
  });
  it("treats a failed chunk plus an empty chunk as unavailable, not a zero-match", async () => {
    const chunkedSegments = Array.from(
      { length: 3 },
      (_, i) => seg(i * 20, i * 20 + 5, "x".repeat(9_000)),
    );
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return calls === 1
        ? { ok: false, status: 503, json: async () => ({}) }
        : { ok: true, json: async () => geminiReply("[]") };
    }) as unknown as typeof fetch;
    expect(await matchPromptMoments({ ...base, segments: chunkedSegments, fetchImpl }))
      .toEqual({ kind: "unavailable" });
    expect(calls).toBeGreaterThan(1);
  });
  it("keeps an evidence-backed match when another chunk fails", async () => {
    const chunkedSegments = Array.from(
      { length: 3 },
      (_, i) => seg(i * 20, i * 20 + 5, "x".repeat(9_000)),
    );
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return calls === 1
        ? { ok: false, status: 503, json: async () => ({}) }
        : { ok: true, json: async () => geminiReply('[{"start":40,"end":50,"reason":"direct proof","relevance":90}]') };
    }) as unknown as typeof fetch;
    expect(await matchPromptMoments({ ...base, segments: chunkedSegments, fetchImpl }))
      .toEqual({ kind: "matched", moments: [{ start: 30, reason: "direct proof" }] });
  });

  it("returns null when the model finds no matches", async () => {
    const fetchImpl = (async () => ({ ok: true, json: async () => geminiReply('{"moments":[]}') })) as unknown as typeof fetch;
    expect(await matchPromptMoments({ ...base, fetchImpl })).toEqual({ kind: "no-matches" });
  });

  it("returns null on empty transcript without calling the model", async () => {
    let called = 0;
    const fetchImpl = (async () => { called++; return { ok: true, json: async () => geminiReply("{}") }; }) as unknown as typeof fetch;
    expect(await matchPromptMoments({ ...base, segments: [], fetchImpl })).toEqual({ kind: "unavailable" });
    expect(called).toBe(0);
  });
});
