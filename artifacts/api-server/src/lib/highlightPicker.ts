/**
 * Highlight-based clip timestamp selection.
 *
 * Strategy A (preferred): score the video transcript and pick clip start times
 * around the most "exciting" speech — dense, emphatic, reaction-heavy moments.
 * Strategy B (fallback): the original spread strategy — divide the video into
 * sections and pick a random start inside each (with intro/outro margins).
 *
 * Everything here is pure (no I/O) so it can be unit-tested in isolation; the
 * route layer fetches the transcript and calls into these functions.
 */

export interface TranscriptSegment {
  /** Segment start, seconds from the beginning of the video. */
  start: number;
  /** Segment end, seconds. */
  end: number;
  text: string;
  /** Present only for diarized speech-to-text transcript turns. */
  speaker?: string;
}

// ── VTT parsing (numeric) ─────────────────────────────────────────────────────

/** "HH:MM:SS.mmm" | "MM:SS.mmm" → seconds. NaN-safe: returns -1 on garbage. */
export function vttTimeToSeconds(t: string): number {
  const m = t.trim().match(/^(?:(\d{1,3}):)?(\d{1,2}):(\d{2})(?:[.,](\d{1,3}))?$/);
  if (!m) return -1;
  const h = m[1] ? parseInt(m[1], 10) : 0;
  const min = parseInt(m[2], 10);
  const sec = parseInt(m[3], 10);
  const ms = m[4] ? parseInt(m[4].padEnd(3, "0"), 10) : 0;
  return h * 3600 + min * 60 + sec + ms / 1000;
}

/** Parse a WebVTT document into numeric-time segments (dedupes rolling captions). */
/** Parse YouTube's json3 timedtext format (`fmt=json3`) into numeric-time
 *  segments. YouTube 429-throttles the vtt timedtext endpoint on datacenter
 *  IPs while json3 sails through — so json3 is the primary transcript format. */
export function parseJson3Numeric(raw: string): TranscriptSegment[] {
  interface Json3Event {
    tStartMs?: number;
    dDurationMs?: number;
    /** Set on scroll-append artifacts whose text is already in a prior event. */
    aAppend?: number;
    segs?: { utf8?: string }[];
  }
  let events: Json3Event[];
  try {
    const parsed = JSON.parse(raw) as { events?: Json3Event[] };
    if (!Array.isArray(parsed.events)) return [];
    events = parsed.events;
  } catch {
    return [];
  }
  const segments: TranscriptSegment[] = [];
  for (const ev of events) {
    if (typeof ev.tStartMs !== "number" || typeof ev.dDurationMs !== "number" || ev.dDurationMs <= 0) continue;
    if (ev.aAppend) continue;
    const text = (ev.segs ?? []).map((s) => s.utf8 ?? "").join("").replace(/\s+/g, " ").trim();
    if (!text) continue;
    const start = ev.tStartMs / 1000;
    const end = (ev.tStartMs + ev.dDurationMs) / 1000;
    if (!(start >= 0) || !(end > start)) continue;
    // Auto-captions repeat the previous line as they scroll — skip dupes.
    if (segments.length && segments[segments.length - 1].text === text) continue;
    segments.push({ start, end, text });
  }
  return segments;
}

export function parseVTTNumeric(vtt: string): TranscriptSegment[] {
  const segments: TranscriptSegment[] = [];
  const lines = vtt.split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i].trim();
    if (line.includes(" --> ")) {
      const [rawStart, rawEnd] = line.split(" --> ");
      const start = vttTimeToSeconds(rawStart);
      const end = vttTimeToSeconds(rawEnd.split(" ")[0]);
      i++;
      const textLines: string[] = [];
      while (i < lines.length && lines[i].trim() !== "") {
        const cleaned = lines[i].replace(/<[^>]+>/g, "").trim();
        if (cleaned) textLines.push(cleaned);
        i++;
      }
      if (start >= 0 && end > start && textLines.length > 0) {
        const text = [...new Set(textLines)].join(" ");
        // Auto-captions repeat the previous line as they scroll — skip dupes.
        if (!segments.length || segments[segments.length - 1].text !== text) {
          segments.push({ start, end, text });
        }
      }
    }
    i++;
  }
  return segments;
}

// ── Segment scoring ───────────────────────────────────────────────────────────

/** Words/phrases that correlate with hype, reactions, and payoff moments. */
const EXCITEMENT_WORDS = [
  "insane", "crazy", "unbelievable", "no way", "oh my god", "omg", "what the",
  "let's go", "lets go", "holy", "unreal", "clutch", "wow", "incredible",
  "amazing", "epic", "hilarious", "can't believe", "cant believe", "shocking",
  "finally", "yes!", "never seen", "first time", "best", "worst", "huge",
  "massive", "secret", "revealed", "actually", "literally", "insanely",
  "[laughter]", "[applause]", "[cheering]", "haha", "lmao", "lol",
];

/** Hook patterns — lines that OPEN strong keep viewers past the first seconds.
 *  Viral clips almost always start on one of these. */
const HOOK_PATTERNS: RegExp[] = [
  /^(how|why|what if|did you know|have you ever|imagine|listen|okay so|so basically)\b/i,
  /\b(the (real |actual |hidden |dark )?(truth|secret|reason|problem|story) (is|about|behind|of))\b/i,
  /\b(nobody|no one|they don'?t) (tells?|talks? about|knows?|wants? you to know)\b/i,
  /\b(stop|never|don'?t|avoid) (doing|using|buying|saying|believing|trusting)\b/i,
  /\b(i (was|am|got) (wrong|shocked|stunned|scammed|banned|fired|rich|broke))\b/i,
  /\b(this (changed|changes|will change|could change) (everything|your life|my life))\b/i,
  /\b(here'?s (what|why|how|the thing))\b/i,
  /\b(you won'?t believe|wait for it|watch this|check this out|pay attention)\b/i,
  /\b(biggest (mistake|lie|myth|scam|secret|regret))\b/i,
  /\b(exposed|revealed|caught|leaked|banned|deleted|arrested)\b/i,
];

/** Story-turn markers — narrative tension spikes hold attention mid-clip. */
const STORY_MARKERS = [
  "suddenly", "and then", "but then", "out of nowhere", "plot twist",
  "turns out", "little did", "that's when", "thats when", "until one day",
  "everything changed", "long story short", "true story",
];

/** Concrete stakes: money amounts and percentages hold attention. */
const MONEY_RE = /(\$|₹|£|€|rs\.?\s?|inr\s)\s?\d[\d,]*|\b\d[\d,]*\s?(dollars|rupees|lakh|lakhs|crore|crores|million|billion)\b/i;
const PERCENT_RE = /\b\d+\s?(%|percent|per cent)\b/i;

/** Hindi/Hinglish hype words (Latin script) — a big share of creator content. */
const HINGLISH_WORDS = [
  "gazab", "kamaal", "dhamaka", "bawaal", "bawal", "khulasa", "zabardast",
  "shandaar", "khatarnak", "toofan", "tagda", "jhakaas", "jhakas", "dhansu",
  "paisa", "paise", "sach bataun", "sachchai", "asli sach",
];

/** Excitement score for one caption segment (higher = more clip-worthy). */
export function scoreSegmentText(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  const words = trimmed.split(/\s+/);
  // Base: speech density — talking a lot beats dead air.
  let score = words.length;
  const lower = trimmed.toLowerCase();
  for (const w of EXCITEMENT_WORDS) {
    if (lower.includes(w)) score += 8;
  }
  for (const w of HINGLISH_WORDS) {
    if (lower.includes(w)) score += 7;
  }
  for (const w of STORY_MARKERS) {
    if (lower.includes(w)) score += 6;
  }
  // One hook bonus per segment — a strong opener matters more than stacking.
  for (const re of HOOK_PATTERNS) {
    if (re.test(trimmed)) { score += 10; break; }
  }
  if (MONEY_RE.test(trimmed)) score += 9;
  else if (PERCENT_RE.test(trimmed)) score += 6;
  score += (trimmed.match(/!/g)?.length ?? 0) * 4;
  score += (trimmed.match(/\?/g)?.length ?? 0) * 3;
  if (/\b[A-Z]{3,}\b/.test(trimmed)) score += 3; // SHOUTED words
  return score;
}

// ── Shared margin logic ───────────────────────────────────────────────────────

/** Intro/outro dead zone: first/last 5% of longer videos, capped at 5 min. */
export function introOutroMargin(totalDuration: number): number {
  return totalDuration > 240 ? Math.min(totalDuration * 0.05, 300) : 0;
}

/** How many non-overlapping clips physically fit between the intro/outro
 *  margins. Butt-joined starts are allowed (spacing = clipDuration), so a
 *  164s video fits five 30s clips, not four. */
export function clipCapacity(totalDuration: number, clipDuration: number): number {
  const margin = introOutroMargin(totalDuration);
  const usable = totalDuration - 2 * margin - clipDuration;
  if (usable < 0) return totalDuration >= clipDuration ? 1 : 0;
  return Math.floor(usable / clipDuration) + 1;
}

/** Fine-grained candidate starts used to top clip picks up to the requested
 *  count when scored strategies find fewer distinct peaks than the video can
 *  hold. A small step lets candidates mesh into the gaps between already-picked
 *  clips (wall-to-wall strides would miss offset openings). */
function packedCandidates(totalDuration: number, clipDuration: number): number[] {
  const margin = introOutroMargin(totalDuration);
  const usable = totalDuration - 2 * margin - clipDuration;
  if (usable < 0) return totalDuration >= clipDuration ? [0] : [];
  const step = Math.max(1, clipDuration / 6);
  const out: number[] = [];
  for (let t = margin; t <= margin + usable + 1e-6; t += step) out.push(t);
  return out;
}

/** Shared top-up: first pass keeps the curated 1.25× breathing room, second
 *  pass relaxes to exact non-overlap (gap = clipDuration), and a final pass
 *  re-packs wall-to-wall around the top-scored pick — so users get the count
 *  they asked for whenever the video physically holds it. */
function topUpPicks(
  picked: number[],
  totalDuration: number,
  clipDuration: number,
  count: number,
): number[] {
  const minGap = clipDuration * 1.25;
  if (picked.length < count) {
    for (const t of pickSpreadTimestamps(totalDuration, clipDuration, count)) {
      if (picked.length >= count) break;
      if (picked.every((p) => Math.abs(p - t) >= minGap)) picked.push(t);
    }
  }
  if (picked.length < count) {
    for (const t of packedCandidates(totalDuration, clipDuration)) {
      if (picked.length >= count) break;
      if (picked.every((p) => Math.abs(p - t) >= clipDuration)) picked.push(t);
    }
  }

  // Curated picks can fragment a tight timeline (e.g. peaks 58s apart leave no
  // 30s slot between them even though five clips fit wall-to-wall). If we're
  // still short of what the video can hold, rebuild a butt-joined layout
  // anchored on the top-scored pick and keep the requested count.
  const target = Math.min(count, clipCapacity(totalDuration, clipDuration));
  if (picked.length >= target || picked.length === 0) return picked;
  const margin = introOutroMargin(totalDuration);
  const usableEnd = totalDuration - margin - clipDuration;
  const anchor = picked[0]; // callers push highest-scored first
  let layout: number[] = [];
  for (let t = anchor - Math.floor((anchor - margin) / clipDuration) * clipDuration; t <= usableEnd + 1e-6; t += clipDuration) {
    layout.push(t);
  }
  if (layout.length < target) {
    layout = [];
    for (let t = margin; t <= usableEnd + 1e-6; t += clipDuration) layout.push(t);
  }
  if (layout.length <= picked.length) return picked;
  // Take `target` contiguous slots, keeping the slot nearest the anchor.
  let nearest = 0;
  for (let i = 1; i < layout.length; i++) {
    if (Math.abs(layout[i] - anchor) < Math.abs(layout[nearest] - anchor)) nearest = i;
  }
  const startIdx = Math.max(0, Math.min(nearest - Math.floor((target - 1) / 2), layout.length - target));
  return layout.slice(startIdx, startIdx + target);
}

// ── Strategy A: transcript-scored window picking ──────────────────────────────

/**
 * Pick up to `count` clip start times centred on the highest-scoring transcript
 * windows. Returns null when the transcript is too sparse to be trustworthy —
 * callers should then fall back to pickSpreadTimestamps.
 */
export function pickTranscriptTimestamps(
  segments: TranscriptSegment[],
  totalDuration: number,
  clipDuration: number,
  count: number,
): number[] | null {
  const margin = introOutroMargin(totalDuration);
  const lo = margin;
  const hi = totalDuration - margin - clipDuration;
  if (hi <= lo) return null;

  const usable = segments
    .filter((s) => s.end > lo && s.start < hi + clipDuration && s.text.trim().length > 0)
    .sort((a, b) => a.start - b.start);

  // Too few captions → scoring would just amplify noise.
  if (usable.length < 8) return null;

  // Transcript must cover a meaningful share of the pickable range, otherwise
  // every "highlight" would cluster in the one captioned stretch.
  const span = usable[usable.length - 1].end - usable[0].start;
  if (span < (hi - lo) * 0.4) return null;

  // Pre-score each segment once.
  const segScores = usable.map((s) => ({
    start: s.start,
    end: s.end,
    dur: Math.max(0.5, s.end - s.start),
    score: scoreSegmentText(s.text),
  }));

  // Adaptive "strong segment" threshold for the hook-open bonus: a segment
  // scoring well above the median has real signal (hook/reaction/stakes),
  // not just word count.
  const sortedScores = segScores.map((s) => s.score).sort((a, b) => a - b);
  const median = sortedScores[Math.floor(sortedScores.length / 2)] ?? 0;
  const hookThreshold = Math.max(15, median * 1.5);

  // Slide a clip-sized window across the pickable range; window score is the
  // overlap-weighted sum of segment scores. Two-pointer keeps this linear-ish.
  // Finer step (clipDuration/3) aligns windows to peaks more precisely than
  // the old /2 — still linear, pure in-memory CPU.
  const step = Math.max(1.5, clipDuration / 3);
  const windows: Array<{ start: number; score: number }> = [];
  let firstIdx = 0;
  for (let t = lo; t <= hi; t += step) {
    const winEnd = t + clipDuration;
    while (firstIdx < segScores.length && segScores[firstIdx].end <= t) firstIdx++;
    let score = 0;
    let hookOpen = false;
    for (let j = firstIdx; j < segScores.length && segScores[j].start < winEnd; j++) {
      const seg = segScores[j];
      const ovl = Math.min(seg.end, winEnd) - Math.max(seg.start, t);
      if (ovl > 0) {
        score += seg.score * (ovl / seg.dur);
        // Hook-open: a strong segment starting in the first quarter of the
        // window means the clip OPENS on the hook instead of burying it.
        if (seg.start >= t && seg.start <= t + clipDuration * 0.25 && seg.score >= hookThreshold) {
          hookOpen = true;
        }
      }
    }
    if (hookOpen) score *= 1.25;
    windows.push({ start: t, score });
  }

  // Greedy top-N with a minimum gap so clips don't overlap each other.
  // Snap each pick to the nearest caption-segment start (±2.5s) so clips
  // open on a sentence boundary, not mid-word.
  windows.sort((a, b) => b.score - a.score);
  const minGap = clipDuration * 1.25;
  const picked: number[] = [];
  for (const w of windows) {
    if (w.score <= 0) break;
    let snapped = w.start;
    let bestDist = 2.5 + 1e-6;
    for (const seg of segScores) {
      const d = Math.abs(seg.start - w.start);
      if (d < bestDist && seg.start >= lo && seg.start <= hi) { snapped = seg.start; bestDist = d; }
    }
    if (picked.every((p) => Math.abs(p - snapped) >= minGap)) picked.push(snapped);
    if (picked.length >= count) break;
  }
  if (picked.length === 0) return null;

  // If scoring found fewer distinct peaks than requested, top up (curated
  // spacing first, then exact non-overlap) so users get the count they asked
  // for whenever the video is long enough.
  return topUpPicks(picked, totalDuration, clipDuration, count).sort((a, b) => a - b);
}

// ── Strategy A2: audio-energy picking (for videos with no usable captions) ────

export interface AudioEnergyMeasurement {
  /** Candidate window start, seconds. */
  start: number;
  /** Energy score (higher = louder / more dynamic). Null when probing failed. */
  energy: number | null;
}

/**
 * Deterministic, evenly-spaced candidate window starts to probe for audio
 * energy. Returns more windows than clips requested (so scoring has choices),
 * capped so a long video never triggers dozens of section downloads.
 */
export function pickAudioProbeWindows(
  totalDuration: number,
  clipDuration: number,
  count: number,
): number[] {
  const margin = introOutroMargin(totalDuration);
  const usable = totalDuration - 2 * margin - clipDuration;
  if (usable <= 0) return [];
  const n = Math.min(
    Math.max(count * 3, 6),
    12,
    Math.max(1, Math.floor(usable / clipDuration) + 1),
  );
  const section = usable / n;
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(margin + i * section + section / 2);
  return out;
}

/**
 * Pick up to `count` clip start times from audio-energy measurements: keeps
 * the loudest/most dynamic windows with a minimum gap so clips don't overlap.
 * Returns null when too few windows were successfully measured — callers
 * should then fall back to pickSpreadTimestamps.
 */
export function pickAudioEnergyTimestamps(
  measurements: AudioEnergyMeasurement[],
  totalDuration: number,
  clipDuration: number,
  count: number,
): number[] | null {
  const valid = measurements.filter(
    (m): m is { start: number; energy: number } =>
      m.energy !== null && Number.isFinite(m.energy),
  );
  // Fewer than 2 usable probes → "top energy" is meaningless, don't pretend.
  if (valid.length < 2) return null;

  const sorted = [...valid].sort((a, b) => b.energy - a.energy);
  const minGap = clipDuration * 1.25;
  const picked: number[] = [];
  for (const m of sorted) {
    if (picked.every((p) => Math.abs(p - m.start) >= minGap)) picked.push(m.start);
    if (picked.length >= count) break;
  }
  if (picked.length === 0) return null;

  // Top up if energy found fewer distinct peaks than requested (curated
  // spacing first, then exact non-overlap) so users get the count they asked
  // for whenever the video is long enough.
  return topUpPicks(picked, totalDuration, clipDuration, count).sort((a, b) => a - b);
}

// ── Strategy B: spread fallback (original behaviour) ──────────────────────────

/**
 * Skips intro/outro dead zones, then divides the middle into `count` sections
 * and picks a random start within each — spreads clips across the whole video.
 */
export function pickSpreadTimestamps(
  totalDuration: number,
  clipDuration: number,
  count: number,
): number[] {
  const margin = introOutroMargin(totalDuration);
  const usable = totalDuration - 2 * margin - clipDuration;
  if (usable <= 0) return [0];
  const capacity = Math.floor(usable / clipDuration) + 1;
  const safe = Math.max(1, Math.min(count, capacity));
  // Tight fit (count uses full capacity): deterministic wall-to-wall packing —
  // randomized sections would be narrower than a clip and could overlap.
  if (safe > Math.floor(usable / clipDuration)) {
    const out: number[] = [];
    for (let i = 0; i < safe; i++) out.push(margin + i * clipDuration);
    return out;
  }
  const section = usable / safe;
  const out: number[] = [];
  for (let i = 0; i < safe; i++) {
    const lo = margin + i * section;
    // Cap each random start so the next section's earliest start can never
    // overlap this clip (gap between starts ≥ clipDuration).
    const hi = Math.min(lo + Math.max(0, section - clipDuration), margin + usable);
    out.push(lo + Math.random() * Math.max(0, hi - lo));
  }
  return out;
}
