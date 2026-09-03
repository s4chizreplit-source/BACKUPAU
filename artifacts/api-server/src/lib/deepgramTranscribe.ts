/**
 * Deepgram speech-to-text for burned clip subtitles.
 *
 * The owner's chosen transcript engine (July 2026): burned subtitles no longer
 * touch YouTube's caption endpoints (which 429-throttle datacenter IPs) or
 * uploaded cookies — every subtitles-ON clip transcribes its own audio slice
 * through Deepgram's pre-recorded API and burns what was actually said. Works
 * for every source: YouTube, Kick, Twitch, device uploads, Drive/Dropbox.
 *
 * Contract with the route layer:
 *   - transcribeClipWindow() NEVER throws — any failure (missing key, ffmpeg
 *     error, HTTP error, timeout, non-Latin transcript) returns null, so a
 *     slow or broken transcription can never stall or crash a clip job. The
 *     route shows the honest "skipped" note instead.
 *   - Returned segments are on the VIDEO timeline (offsetSec added), so the
 *     existing cuesForClip()/buildAss() burn pipeline works unchanged.
 *
 * Fonts: the runtime ships DejaVu (Latin glyphs) only, so we need Latin-script
 * output — `detect_language` first, and when the transcript comes back in a
 * non-Latin script (e.g. Devanagari for Hindi songs) we retry once with
 * `language=hi-Latn` (romanized Hindi/Hinglish). Still non-Latin → null,
 * because burning tofu boxes is worse than an honest note.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import type { TranscriptSegment } from "./highlightPicker";

const execFileAsync = promisify(execFile);

export const DEEPGRAM_URL = "https://api.deepgram.com/v1/listen";
const DEFAULT_TIMEOUT_MS = 45_000;

export function deepgramConfigured(): boolean {
  return Boolean(process.env.DEEPGRAM_API_KEY?.trim());
}

// Deepgram /v1/listen (pre-recorded) response — only the fields we read.
export interface DeepgramWord {
  word: string;
  start: number;
  end: number;
  punctuated_word?: string;
  /** Deepgram emits a zero-based numeric speaker id when diarization is on. */
  speaker?: number;
}
interface DeepgramResponse {
  results?: {
    channels?: {
      detected_language?: string;
      alternatives?: { transcript?: string; words?: DeepgramWord[] }[];
    }[];
  };
}

/** Majority-non-Latin check — DejaVu can't render Devanagari/CJK/Arabic. */
export function isMostlyNonLatin(text: string): boolean {
  let latin = 0;
  let other = 0;
  for (const ch of text) {
    if (!/\p{L}/u.test(ch)) continue;
    const cp = ch.codePointAt(0) ?? 0;
    if (cp <= 0x024f) latin++;
    else other++;
  }
  return other > latin;
}

export function transcriptText(json: unknown): string {
  return (json as DeepgramResponse)?.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? "";
}

/**
 * Group Deepgram words into short transcript segments (≤3 words, split on
 * speech gaps) on the video timeline. Three-word groups mean cuesForClip()
 * passes the real word timings straight through instead of interpolating
 * inside long segments — burned cues land exactly when the word is spoken.
 */
export function mapDeepgramWords(json: unknown, offsetSec: number): TranscriptSegment[] {
  const alt = (json as DeepgramResponse)?.results?.channels?.[0]?.alternatives?.[0];
  const words = Array.isArray(alt?.words) ? alt!.words! : [];
  const segments: TranscriptSegment[] = [];
  let group: DeepgramWord[] = [];
  const flush = () => {
    if (group.length === 0) return;
    const text = group
      .map((w) => (w.punctuated_word ?? w.word ?? "").trim())
      .filter(Boolean)
      .join(" ");
    const start = group[0].start;
    const end = group[group.length - 1].end;
    const speaker = group[0].speaker;
    if (text && end > start) {
      segments.push({
        start: start + offsetSec,
        end: end + offsetSec,
        text,
        ...(typeof speaker === "number" ? { speaker: `S${speaker + 1}` } : {}),
      });
    }
    group = [];
  };
  for (const w of words) {
    if (typeof w?.start !== "number" || typeof w?.end !== "number" || !(w.end > w.start)) continue;
    const prev = group[group.length - 1];
    // Keep speaker turns separate so prompt matching can cite the person who
    // said a line. Subtitle rendering does not use this optional field.
    if (prev && (
      w.start - prev.end > 0.6 ||
      group.length >= 3 ||
      (typeof w.speaker === "number" && typeof prev.speaker === "number" && w.speaker !== prev.speaker)
    )) flush();
    group.push(w);
  }
  flush();
  return segments;
}

/** POST one audio buffer to Deepgram. Throws on HTTP errors and timeouts. */
export async function transcribeAudioBuffer(
  audio: Buffer,
  opts: { apiKey: string; language?: string; timeoutMs?: number; fetchImpl?: typeof fetch; contentType?: string },
): Promise<unknown> {
  const params = new URLSearchParams({
    model: "nova-2",
    smart_format: "true",
    punctuate: "true",
    // Harmless for subtitle clips and required for prompt matching: words gain
    // a speaker id when Deepgram can identify a voice change.
    diarize: "true",
  });
  if (opts.language) params.set("language", opts.language);
  else params.set("detect_language", "true");
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const doFetch = opts.fetchImpl ?? fetch;
    const res = await doFetch(`${DEEPGRAM_URL}?${params.toString()}`, {
      method: "POST",
      headers: { Authorization: `Token ${opts.apiKey}`, "Content-Type": opts.contentType ?? "audio/wav" },
      body: new Uint8Array(audio),
      signal: ctl.signal,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`Deepgram HTTP ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`);
    }
    return (await res.json()) as unknown;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Extract `durationSec` of mono 16 kHz wav from `mediaPath` starting at
 * `seekSec`, transcribe it, and return segments on the video timeline
 * (clip-local word times + offsetSec). Never throws — null on any failure.
 */
export async function transcribeClipWindow(opts: {
  mediaPath: string;
  seekSec: number;
  durationSec: number;
  /** The clip's start on the video timeline — added to every timestamp. */
  offsetSec: number;
  ffmpegPath: string;
  timeoutMs?: number;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
}): Promise<TranscriptSegment[] | null> {
  const apiKey = process.env.DEEPGRAM_API_KEY?.trim();
  const log = opts.log ?? (() => {});
  if (!apiKey) {
    log("[deepgram] no API key configured — skipping transcription");
    return null;
  }
  const wavPath = path.join(os.tmpdir(), `dg_${crypto.randomBytes(6).toString("hex")}.wav`);
  try {
    // Audio-only slice: mono 16 kHz wav keeps the upload tiny (~1.9 MB/min).
    await execFileAsync(
      opts.ffmpegPath,
      [
        "-y", "-ss", opts.seekSec.toFixed(3), "-i", opts.mediaPath,
        "-t", opts.durationSec.toFixed(3),
        "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le",
        wavPath,
      ],
      { timeout: 60_000, maxBuffer: 8 * 1024 * 1024 },
    );
    const audio = await fs.promises.readFile(wavPath);
    if (audio.length < 1000) {
      log("[deepgram] extracted audio is empty — skipping transcription");
      return null;
    }
    const started = Date.now();
    let json = await transcribeAudioBuffer(audio, { apiKey, timeoutMs: opts.timeoutMs });
    let text = transcriptText(json);
    // DejaVu fonts are Latin-only: retry Hindi/Hinglish audio as romanized.
    if (text && isMostlyNonLatin(text)) {
      log("[deepgram] non-Latin transcript — retrying as romanized Hindi (hi-Latn)");
      try {
        const retry = await transcribeAudioBuffer(audio, { apiKey, language: "hi-Latn", timeoutMs: opts.timeoutMs });
        const retryText = transcriptText(retry);
        if (retryText.trim() && !isMostlyNonLatin(retryText)) {
          json = retry;
          text = retryText;
        }
      } catch {
        /* keep the original result */
      }
    }
    if (!text.trim()) {
      log("[deepgram] empty transcript — no speech in this clip window", { ms: Date.now() - started });
      return null;
    }
    if (isMostlyNonLatin(text)) {
      log("[deepgram] transcript stayed non-Latin — fonts can't render it, skipping burn");
      return null;
    }
    const segments = mapDeepgramWords(json, opts.offsetSec);
    log("[deepgram] transcribed clip audio", {
      ms: Date.now() - started,
      segments: segments.length,
      billedAudioSec: Math.round(opts.durationSec),
    });
    return segments.length > 0 ? segments : null;
  } catch (e) {
    log(`[deepgram] transcription failed — ${(e as Error).message}`);
    return null;
  } finally {
    try { fs.rmSync(wavPath, { force: true }); } catch { /* ignore */ }
  }
}

/** Cap on how much of a long video gets transcribed for prompt matching —
 *  bounds both the Deepgram bill and the extraction time. 90 minutes covers
 *  full podcast episodes; anything beyond is transcribed from the start. */
export const FULL_TRANSCRIBE_MAX_SEC = 90 * 60;

/**
 * Transcribe (up to the first FULL_TRANSCRIBE_MAX_SEC of) a local video into
 * timed segments for prompt-guided moment matching. Unlike clip-window
 * transcription this KEEPS non-Latin scripts — the transcript goes to Gemini,
 * which reads Devanagari/CJK fine; only subtitle BURNING needs Latin glyphs.
 * Mono 16 kHz Opus keeps a 90-min upload ~16 MB (wav would be ~170 MB).
 * Never throws — null on any failure (missing key, ffmpeg error, HTTP error).
 */
export async function transcribeFullVideo(opts: {
  mediaPath: string;
  /** Total video duration, seconds — used only for the cap log. */
  durationSec: number;
  ffmpegPath: string;
  timeoutMs?: number;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
}): Promise<TranscriptSegment[] | null> {
  const apiKey = process.env.DEEPGRAM_API_KEY?.trim();
  const log = opts.log ?? (() => {});
  if (!apiKey) {
    log("[deepgram] no API key configured — skipping full-video transcription");
    return null;
  }
  const takeSec = Math.min(Math.max(1, opts.durationSec || FULL_TRANSCRIBE_MAX_SEC), FULL_TRANSCRIBE_MAX_SEC);
  if (opts.durationSec > FULL_TRANSCRIBE_MAX_SEC) {
    log(`[deepgram] video longer than ${Math.round(FULL_TRANSCRIBE_MAX_SEC / 60)} min — transcribing the first ${Math.round(FULL_TRANSCRIBE_MAX_SEC / 60)} min only`);
  }
  const oggPath = path.join(os.tmpdir(), `dgf_${crypto.randomBytes(6).toString("hex")}.ogg`);
  try {
    await execFileAsync(
      opts.ffmpegPath,
      [
        "-y", "-i", opts.mediaPath, "-t", takeSec.toFixed(0),
        "-vn", "-ac", "1", "-ar", "16000", "-c:a", "libopus", "-b:a", "24k", "-f", "ogg",
        oggPath,
      ],
      { timeout: 5 * 60_000, maxBuffer: 8 * 1024 * 1024 },
    );
    const audio = await fs.promises.readFile(oggPath);
    if (audio.length < 1000) {
      log("[deepgram] extracted full-video audio is empty — skipping");
      return null;
    }
    const started = Date.now();
    const json = await transcribeAudioBuffer(audio, { apiKey, timeoutMs: opts.timeoutMs ?? 180_000, contentType: "audio/ogg" });
    const segments = mapDeepgramWords(json, 0);
    log("[deepgram] transcribed full video audio", {
      ms: Date.now() - started,
      segments: segments.length,
      billedAudioSec: Math.round(takeSec),
    });
    return segments.length > 0 ? segments : null;
  } catch (e) {
    log(`[deepgram] full-video transcription failed — ${(e as Error).message}`);
    return null;
  } finally {
    try { fs.rmSync(oggPath, { force: true }); } catch { /* ignore */ }
  }
}
