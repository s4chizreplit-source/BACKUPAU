/**
 * Prompt-guided clip moment matching (Gemini).
 *
 * The user types a natural-language instruction ("clip every goal", "only the
 * parts about cricket") and this module asks Gemini to pick the best-matching
 * moments from a timed transcript. Contract mirrors lib/gemini.ts:
 *   - NEVER throws — callers receive an explicit unavailable/no-match/matched
 *     outcome so they can distinguish automatic fallback from an honest miss.
 *   - The API key travels in a request header, never the URL.
 *   - Pure helpers (formatting, chunking, parsing, merging) are exported for
 *     unit tests; only matchPromptMoments does I/O.
 */
import type { TranscriptSegment } from "./highlightPicker";

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

// Long campaign briefs can include detailed content rules, examples, and
// placement requirements, so keep the clip-selection prompt generous.
export const MAX_PROMPT_LEN = 10_000;

/** Collapse whitespace and trim. Null when not a usable non-empty string.
 *  Does NOT cap length — the route rejects over-long prompts with a clear
 *  message instead of silently truncating the user's instruction. */
export function sanitizePrompt(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const p = raw.replace(/\s+/g, " ").trim();
  return p.length > 0 ? p : null;
}

// ── Transcript → model input ──────────────────────────────────────────────────

/** Merge segments into ~15s "[m:ss] text" lines — compact enough that hours
 *  of speech fit the model budget, precise enough to land clips on the moment. */
export const TRANSCRIPT_BUCKET_SEC = 15;

export function formatTranscriptLines(segments: TranscriptSegment[]): string[] {
  const buckets = new Map<number, string[]>();
  for (const s of segments) {
    if (!(s.start >= 0)) continue;
    const text = s.text.replace(/\s+/g, " ").trim();
    if (!text) continue;
    const b = Math.floor(s.start / TRANSCRIPT_BUCKET_SEC);
    const arr = buckets.get(b);
    const attributed = s.speaker ? `${s.speaker}: ${text}` : text;
    if (arr) arr.push(attributed);
    else buckets.set(b, [attributed]);
  }
  const lines: string[] = [];
  for (const b of [...buckets.keys()].sort((a, z) => a - z)) {
    const t = b * TRANSCRIPT_BUCKET_SEC;
    const m = Math.floor(t / 60);
    lines.push(`[${m}:${String(t % 60).padStart(2, "0")}] ${buckets.get(b)!.join(" ")}`);
  }
  return lines;
}

/** Split transcript lines into ≤maxChunks chunks of ≤budget chars each. Lines
 *  beyond the last chunk are dropped — at the default budget that's ~4 hours
 *  of dense speech, which also bounds what we spend on model input. */
export const CHUNK_CHAR_BUDGET = 24_000;
export const MAX_CHUNKS = 4;

export function chunkTranscript(lines: string[], budget = CHUNK_CHAR_BUDGET, maxChunks = MAX_CHUNKS): string[] {
  const chunks: string[] = [];
  let cur: string[] = [];
  let curLen = 0;
  for (const line of lines) {
    if (curLen + line.length + 1 > budget && cur.length > 0) {
      chunks.push(cur.join("\n"));
      if (chunks.length >= maxChunks) return chunks;
      cur = [];
      curLen = 0;
    }
    cur.push(line);
    curLen += line.length + 1;
  }
  if (cur.length > 0 && chunks.length < maxChunks) chunks.push(cur.join("\n"));
  return chunks;
}

// ── Model reply → validated moments ───────────────────────────────────────────

export interface MomentCandidate {
  start: number;
  /** End of the matching passage, used to center short passages in a clip. */
  end?: number;
  reason: string;
  score: number;
}

/** 90 | "90" | "1:30" | "1:02:03" → seconds. Null on garbage. */
export function parseStartValue(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v) && v >= 0) return v;
  if (typeof v === "string") {
    const t = v.trim();
    if (/^\d+(\.\d+)?$/.test(t)) return parseFloat(t);
    const m = t.match(/^(?:(\d{1,3}):)?(\d{1,2}):(\d{2})(?:\.\d+)?$/);
    if (m) {
      const h = m[1] ? parseInt(m[1], 10) : 0;
      return h * 3600 + parseInt(m[2], 10) * 60 + parseInt(m[3], 10);
    }
  }
  return null;
}

/** Parse one model reply. We tolerate harmless code fences / the older wrapper
 * object, but each actual match must retain the strict start/end/reason proof. */
function decodeMomentList(raw: string): unknown[] | null {
  const cleaned = raw.replace(/^\s*```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return null;
  }
  const list = Array.isArray(parsed) ? parsed : (parsed as { moments?: unknown }).moments;
  return Array.isArray(list) ? list : null;
}

function parseMomentRecord(item: unknown): MomentCandidate | null {
  if (!item || typeof item !== "object") return null;
  const rec = item as Record<string, unknown>;
  const start = parseStartValue(rec.start);
  if (start === null) return null;
  const end = parseStartValue(rec.end);
  if (end === null || end < start) return null;
  const reason = typeof rec.reason === "string"
    ? rec.reason.replace(/\s+/g, " ").trim().slice(0, 90)
    : "";
  if (!reason) return null;
  const scoreRaw = rec.relevance ?? rec.score;
  const score = typeof scoreRaw === "number" && Number.isFinite(scoreRaw)
    ? Math.max(0, Math.min(100, scoreRaw))
    : 50;
  return { start, end, reason, score };
}

/** Parse strict evidence-backed matches from a Gemini reply. */
export function parseMomentsReply(raw: string): MomentCandidate[] {
  const list = decodeMomentList(raw);
  if (!list) return [];
  const out: MomentCandidate[] = [];
  for (const item of list) {
    const candidate = parseMomentRecord(item);
    if (candidate) out.push(candidate);
  }
  return out;
}

/** An explicit empty array is a valid no-match result. Any nonempty reply must
 * consist entirely of strict match records; malformed model output is
 * inconclusive and must not trigger the zero-match failure path. */
function hasCompleteMomentsReply(raw: string): boolean {
  const list = decodeMomentList(raw);
  return list !== null && (list.length === 0 || list.every((item) => parseMomentRecord(item) !== null));
}

export interface PromptStartWindow {
  minStart: number;
  maxStart: number;
}

/** Parse common explicit start-window wording so the route can enforce it even
 * if a model attempts to return an out-of-range moment. The matcher still gets
 * the original instruction for less structured constraints. */
export function promptStartWindow(prompt: string): PromptStartWindow | null {
  const first = prompt.match(/\b(?:in\s+)?(?:the\s+)?first\s+(\d+(?:\.\d+)?)\s*(seconds?|secs?|minutes?|mins?|hours?|hrs?)\b/i);
  if (!first) return null;
  const n = Number(first[1]);
  if (!Number.isFinite(n) || n < 0) return null;
  const unit = first[2].toLowerCase();
  const multiplier = unit.startsWith("h") ? 3600 : unit.startsWith("m") ? 60 : 1;
  return { minStart: 0, maxStart: n * multiplier };
}

/** Highest-relevance first, clamped to [0, totalDuration - clipDuration],
 *  non-overlapping (gap ≥ clipDuration). No intro/outro margins here — when a
 *  user's prompt matches the first minute, they get the first minute.
 *  Returns ≤count moments sorted by start time. */
export function pickPromptMoments(
  cands: MomentCandidate[],
  totalDuration: number,
  clipDuration: number,
  count: number,
  startWindow?: PromptStartWindow | null,
): { start: number; reason: string }[] {
  const hi = Math.max(0, totalDuration - clipDuration);
  const sorted = [...cands].sort((a, b) => b.score - a.score);
  const picked: { start: number; reason: string }[] = [];
  for (const c of sorted) {
    if (picked.length >= count) break;
    // The evidence-bearing match itself must be in the requested window. For
    // short passages, center the passage within the requested clip before
    // clamping, so we retain a little context on both sides.
    if (startWindow && (c.start < startWindow.minStart || c.start > startWindow.maxStart)) continue;
    const span = Math.max(0, (c.end ?? c.start) - c.start);
    let start = span > 0 && span < clipDuration
      ? c.start - (clipDuration - span) / 2
      : c.start;
    start = Math.max(0, Math.min(start, hi));
    // The externally observable clip start must respect explicit wording such
    // as "first 15 minutes", not just the model's raw candidate timestamp.
    if (startWindow) {
      start = Math.max(startWindow.minStart, Math.min(start, startWindow.maxStart, hi));
    }
    if (picked.every((p) => Math.abs(p.start - start) >= clipDuration)) {
      picked.push({ start, reason: c.reason });
    }
  }
  return picked.sort((a, b) => a.start - b.start);
}

// ── The one I/O function ──────────────────────────────────────────────────────

export interface PromptMatchOpts {
  prompt: string;
  segments: TranscriptSegment[];
  totalDuration: number;
  clipDuration: number;
  count: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
}

export type PromptMatchResult =
  | { kind: "matched"; moments: { start: number; reason: string }[] }
  | { kind: "no-matches" }
  | { kind: "unavailable" };

/** Ask Gemini for the moments best matching the user's prompt. Long
 *  transcripts are chunked; chunk results merge by relevance. A failed matcher
 *  is different from a successful zero-match: only the former may fall back to
 *  automatic clips. Never throws. */
export async function matchPromptMoments(
  opts: PromptMatchOpts,
): Promise<PromptMatchResult> {
  const key = process.env.GEMINI_API_KEY;
  const log = opts.log ?? (() => {});
  if (!key) {
    log("[prompt] no Gemini key configured — cannot match");
    return { kind: "unavailable" };
  }
  const lines = formatTranscriptLines(opts.segments);
  if (lines.length === 0) return { kind: "unavailable" };
  const chunks = chunkTranscript(lines);
  const model = process.env.GEMINI_MODEL || "gemini-2.5-flash";
  const doFetch = opts.fetchImpl ?? fetch;
  const startWindow = promptStartWindow(opts.prompt);
  // Ask each chunk for a few extras so the cross-chunk merge has choices.
  const perChunk = Math.min(10, Math.max(opts.count + 2, 4));

  const askChunk = async (transcript: string): Promise<{ ok: boolean; candidates: MomentCandidate[] }> => {
    const windowRule = startWindow
      ? `STRICT TIME WINDOW: every returned start MUST be between ${startWindow.minStart} and ${startWindow.maxStart} seconds. `
      : "";
    const text =
      `You pick video clip moments. Below is a timed transcript (each line starts with [minutes:seconds]) and a user instruction.\n` +
      `Find up to ${perChunk} moments that BEST match the instruction. Each output must include the exact matching passage start and end in seconds; the final clip is ${Math.round(opts.clipDuration)} seconds.\n` +
      `HARD RULES: ${windowRule}Named people and topics require direct evidence in the transcript (speaker label when present, otherwise matching words); no evidence means EXCLUDE. Never add filler moments. Fewer honest matches are better.\n` +
      `Reply with STRICT JSON only: [{"start":<number>,"end":<number>,"reason":"<short evidence-based label, max 10 words, same language as the instruction>","relevance":<0-100>}]\n` +
      `Only include genuinely matching evidence — reply [] if nothing matches.\n\n` +
      `USER INSTRUCTION: ${opts.prompt}\n\nTRANSCRIPT:\n${transcript}`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 25_000);
    try {
      const resp = await doFetch(`${GEMINI_BASE}/${model}:generateContent`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": key },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text }] }],
          generationConfig: {
            temperature: 0.2,
            maxOutputTokens: 4000,
            responseMimeType: "application/json",
          },
        }),
        signal: ctrl.signal,
      });
      if (!resp.ok) {
        log(`[prompt] Gemini HTTP ${resp.status}`);
        return { ok: false, candidates: [] };
      }
      const data = (await resp.json()) as {
        candidates?: { content?: { parts?: { text?: string }[] } }[];
      };
      const reply = (data.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? "").join("").trim();
      if (!hasCompleteMomentsReply(reply)) {
        log("[prompt] Gemini returned an incomplete match response");
        return { ok: false, candidates: [] };
      }
      return { ok: true, candidates: parseMomentsReply(reply) };
    } catch (e) {
      log(`[prompt] Gemini request failed: ${(e as Error).message}`);
      return { ok: false, candidates: [] };
    } finally {
      clearTimeout(timer);
    }
  };

  const results = await Promise.all(chunks.map(askChunk));
  const successful = results.filter((r) => r.ok);
  if (successful.length === 0) {
    log("[prompt] every Gemini request failed", { chunks: chunks.length });
    return { kind: "unavailable" };
  }
  const all = successful.flatMap((r) => r.candidates);
  if (all.length === 0) {
    // A definitive zero-match means every transcript chunk reached the model
    // and explicitly said "[]". If even one chunk failed or was malformed,
    // it is an inconclusive matcher outage and the caller must use automatic
    // selection rather than fail/refund a possibly valid requested moment.
    if (successful.length !== results.length) {
      log("[prompt] incomplete Gemini evaluation — falling back", { chunks: chunks.length, completed: successful.length });
      return { kind: "unavailable" };
    }
    log("[prompt] no matching moments returned", { chunks: chunks.length });
    return { kind: "no-matches" };
  }
  const picked = pickPromptMoments(all, opts.totalDuration, opts.clipDuration, opts.count, startWindow);
  log("[prompt] AI matched moments", { asked: opts.count, matched: picked.length, chunks: chunks.length });
  return picked.length > 0 ? { kind: "matched", moments: picked } : { kind: "no-matches" };
}
