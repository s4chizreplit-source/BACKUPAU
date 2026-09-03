import { describe, it, expect, afterEach } from "vitest";
import {
  DEEPGRAM_URL,
  deepgramConfigured,
  isMostlyNonLatin,
  mapDeepgramWords,
  transcribeAudioBuffer,
  transcribeClipWindow,
  transcriptText,
} from "../lib/deepgramTranscribe";

const OLD_KEY = process.env.DEEPGRAM_API_KEY;
afterEach(() => {
  if (OLD_KEY === undefined) delete process.env.DEEPGRAM_API_KEY;
  else process.env.DEEPGRAM_API_KEY = OLD_KEY;
});

describe("transcribeAudioBuffer content type", () => {
  it("defaults to audio/wav and honours an override (for opus full-video audio)", async () => {
    const seen: string[] = [];
    const fetchImpl = (async (_url: unknown, init?: { headers?: Record<string, string> }) => {
      seen.push(init?.headers?.["Content-Type"] ?? "");
      return { ok: true, json: async () => ({}) };
    }) as unknown as typeof fetch;
    await transcribeAudioBuffer(Buffer.from("x"), { apiKey: "k", fetchImpl });
    await transcribeAudioBuffer(Buffer.from("x"), { apiKey: "k", fetchImpl, contentType: "audio/ogg" });
    expect(seen).toEqual(["audio/wav", "audio/ogg"]);
  });
});

type Word = { word: string; start: number; end: number; punctuated_word?: string; speaker?: number };
function dgResponse(words: Word[] | undefined, transcript = "", detected = "en") {
  return {
    results: {
      channels: [{ detected_language: detected, alternatives: [{ transcript, words }] }],
    },
  };
}

describe("mapDeepgramWords", () => {
  it("groups words into ≤3-word segments with real timings plus the offset", () => {
    const json = dgResponse([
      { word: "kya", start: 0.1, end: 0.3 },
      { word: "baat", start: 0.35, end: 0.6 },
      { word: "hai", start: 0.65, end: 0.9 },
      { word: "bhai", start: 1.0, end: 1.2 },
    ]);
    const segs = mapDeepgramWords(json, 10);
    expect(segs).toEqual([
      { start: 10.1, end: 10.9, text: "kya baat hai" },
      { start: 11.0, end: 11.2, text: "bhai" },
    ]);
  });

  it("splits a segment on speech gaps larger than 0.6s", () => {
    const json = dgResponse([
      { word: "hello", start: 0, end: 0.5 },
      { word: "world", start: 2.0, end: 2.5 },
    ]);
    const segs = mapDeepgramWords(json, 0);
    expect(segs).toHaveLength(2);
    expect(segs[0]).toEqual({ start: 0, end: 0.5, text: "hello" });
    expect(segs[1]).toEqual({ start: 2.0, end: 2.5, text: "world" });
  });
  it("splits diarized turns and labels the speaker for prompt matching", () => {
    const json = dgResponse([
      { word: "hello", start: 0, end: 0.3, speaker: 0 },
      { word: "there", start: 0.35, end: 0.7, speaker: 0 },
      { word: "hi", start: 0.75, end: 1.0, speaker: 1 },
    ]);
    expect(mapDeepgramWords(json, 5)).toEqual([
      { start: 5, end: 5.7, text: "hello there", speaker: "S1" },
      { start: 5.75, end: 6, text: "hi", speaker: "S2" },
    ]);
  });

  it("prefers punctuated_word over the raw word", () => {
    const json = dgResponse([
      { word: "hello", punctuated_word: "Hello,", start: 0, end: 0.4 },
      { word: "friend", punctuated_word: "friend!", start: 0.5, end: 0.9 },
    ]);
    expect(mapDeepgramWords(json, 0)[0].text).toBe("Hello, friend!");
  });

  it("skips malformed words and returns [] when nothing is usable", () => {
    const json = dgResponse([
      { word: "bad", start: 2, end: 1 },
      { word: "worse" } as unknown as Word,
    ]);
    expect(mapDeepgramWords(json, 0)).toEqual([]);
    expect(mapDeepgramWords(dgResponse(undefined), 0)).toEqual([]);
    expect(mapDeepgramWords({}, 0)).toEqual([]);
    expect(mapDeepgramWords(null, 0)).toEqual([]);
  });
});

describe("isMostlyNonLatin", () => {
  it("accepts English/Hinglish text", () => {
    expect(isMostlyNonLatin("kya baat hai bhai")).toBe(false);
    expect(isMostlyNonLatin("THIS IS A CAPTION!")).toBe(false);
  });
  it("flags Devanagari-majority text", () => {
    expect(isMostlyNonLatin("क्या बात है")).toBe(true);
  });
  it("keeps mostly-Latin mixed text", () => {
    expect(isMostlyNonLatin("hello क्या")).toBe(false);
  });
  it("treats digits/punctuation-only text as Latin-safe", () => {
    expect(isMostlyNonLatin("123 ... !!")).toBe(false);
  });
});

describe("transcriptText", () => {
  it("digs the transcript out of the response", () => {
    expect(transcriptText(dgResponse([], "hello world"))).toBe("hello world");
  });
  it("returns empty string for malformed payloads", () => {
    expect(transcriptText({})).toBe("");
    expect(transcriptText(null)).toBe("");
  });
});

describe("transcribeAudioBuffer", () => {
  const audio = Buffer.from("RIFF-fake-wav");

  it("POSTs to Deepgram with detect_language and Token auth by default", async () => {
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      capturedUrl = url;
      capturedInit = init;
      return { ok: true, json: async () => dgResponse([], "hi") };
    }) as unknown as typeof fetch;
    const out = await transcribeAudioBuffer(audio, { apiKey: "dg-test-key-0000", fetchImpl });
    expect(capturedUrl.startsWith(DEEPGRAM_URL)).toBe(true);
    expect(capturedUrl).toContain("model=nova-2");
    expect(capturedUrl).toContain("detect_language=true");
    expect(capturedUrl).toContain("diarize=true");
    expect(capturedUrl).not.toContain("language=hi-Latn");
    expect((capturedInit?.headers as Record<string, string>).Authorization).toBe("Token dg-test-key-0000");
    expect(transcriptText(out)).toBe("hi");
  });

  it("uses an explicit language instead of detection when given", async () => {
    let capturedUrl = "";
    const fetchImpl = (async (url: string) => {
      capturedUrl = url;
      return { ok: true, json: async () => dgResponse([], "") };
    }) as unknown as typeof fetch;
    await transcribeAudioBuffer(audio, { apiKey: "dg-test-key-0000", language: "hi-Latn", fetchImpl });
    expect(capturedUrl).toContain("language=hi-Latn");
    expect(capturedUrl).not.toContain("detect_language");
  });

  it("throws on non-2xx responses with the status in the message", async () => {
    const fetchImpl = (async () => ({
      ok: false,
      status: 402,
      text: async () => "insufficient credits",
    })) as unknown as typeof fetch;
    await expect(
      transcribeAudioBuffer(audio, { apiKey: "dg-test-key-0000", fetchImpl }),
    ).rejects.toThrow(/402/);
  });

  it("aborts when the hard timeout elapses", async () => {
    const fetchImpl = ((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () =>
          reject(Object.assign(new Error("This operation was aborted"), { name: "AbortError" })),
        );
      })) as unknown as typeof fetch;
    await expect(
      transcribeAudioBuffer(audio, { apiKey: "dg-test-key-0000", timeoutMs: 20, fetchImpl }),
    ).rejects.toThrow(/abort/i);
  });
});

describe("transcribeClipWindow", () => {
  it("returns null (never throws) when no API key is configured", async () => {
    delete process.env.DEEPGRAM_API_KEY;
    const out = await transcribeClipWindow({
      mediaPath: "/nonexistent.mp4",
      seekSec: 0,
      durationSec: 30,
      offsetSec: 0,
      ffmpegPath: "/definitely/not/ffmpeg",
    });
    expect(out).toBeNull();
  });

  it("returns null instead of throwing when audio extraction fails", async () => {
    process.env.DEEPGRAM_API_KEY = "dg-test-key-0000";
    const out = await transcribeClipWindow({
      mediaPath: "/nonexistent.mp4",
      seekSec: 0,
      durationSec: 30,
      offsetSec: 0,
      ffmpegPath: "/definitely/not/ffmpeg",
    });
    expect(out).toBeNull();
  });
});

describe("deepgramConfigured", () => {
  it("reflects the presence of DEEPGRAM_API_KEY", () => {
    delete process.env.DEEPGRAM_API_KEY;
    expect(deepgramConfigured()).toBe(false);
    process.env.DEEPGRAM_API_KEY = "dg-test-key-0000";
    expect(deepgramConfigured()).toBe(true);
    process.env.DEEPGRAM_API_KEY = "   ";
    expect(deepgramConfigured()).toBe(false);
  });
});
