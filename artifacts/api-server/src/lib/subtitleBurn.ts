/**
 * Styled subtitle burning for platform clips.
 *
 * Turns the transcript segments the highlight picker already fetches into
 * per-clip ASS subtitle files that ffmpeg (libass) burns straight onto the
 * video. Everything here is pure string/number logic so it unit-tests without
 * ffmpeg — the burn itself is just `,subtitles=…` appended to the clip's
 * -vf chain by the route layer.
 *
 * Fonts: the runtime ships DejaVu (Sans/Serif/Mono) only, so every style maps
 * onto those. No Devanagari/CJK fonts are installed — the transcript fetch is
 * English-only (`--sub-langs en…`), which keeps glyph coverage safe.
 *
 * ASS colours are &HAABGR (blue-green-red, alpha first, 00 = opaque).
 */
import type { TranscriptSegment } from "./highlightPicker";

export interface SubCue { start: number; end: number; text: string }

/** Keep ids in lockstep with SUB_STYLES in the frontend clipper page. */
export const SUBTITLE_STYLE_IDS = [
  "basic", "modern", "hormozi", "classic", "heat", "icy", "ghost",
  "editorial", "tallboy", "elegant", "clean", "highlight", "roundtable",
  "matrix", "bubbly", "funky", "miner",
  // Canva-inspired gallery (Aug 2026 batch) — approximated on DejaVu fonts.
  "classicbox", "pixelpop", "momentum", "clickbait", "evergreen", "peachpop",
  "boldpop", "cherryglow", "penpal", "bigideas", "boldlime", "newsroom",
  "solarsign", "refined", "popcorn", "eyecandy", "sweettalk", "infocus",
  "afterglow", "talkingpoint", "freehand", "eerienight", "publicnotice",
  "heromode", "bytetype", "goldenage", "clearbrief", "digitalkitsch",
  "softlyspoken", "subtext", "markeddown", "arcade", "boxoffice",
  "sugarrush", "sidenote", "cleancut", "blockparty", "losttape",
] as const;
export type SubtitleStyleId = (typeof SUBTITLE_STYLE_IDS)[number];

/** Body shape is untrusted — accept `{ style: "heat" }`-ish objects only. */
export function normalizeSubtitleStyle(raw: unknown): SubtitleStyleId | null {
  if (!raw || typeof raw !== "object") return null;
  const style = (raw as { style?: unknown }).style;
  return (SUBTITLE_STYLE_IDS as readonly unknown[]).includes(style)
    ? (style as SubtitleStyleId)
    : null;
}

const MAX_WORDS_PER_CUE = 3;
const MIN_CUE_SECONDS = 0.35;

/** Strip HTML-ish tags/whitespace down to plain renderable words. */
function cleanText(t: string): string {
  return t.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * Cut the video-wide transcript down to one clip's window and re-chunk it into
 * short, punchy cues (≤3 words) with linearly interpolated timings — the
 * standard shorts-caption cadence. Result times are relative to the clip's
 * own t=0.
 */
export function cuesForClip(
  segments: TranscriptSegment[],
  clipStart: number,
  clipEnd: number,
): SubCue[] {
  const cues: SubCue[] = [];
  for (const seg of segments) {
    if (seg.end <= clipStart || seg.start >= clipEnd) continue;
    const text = cleanText(seg.text);
    if (!text) continue;
    const words = text.split(" ");
    const segDur = Math.max(0.001, seg.end - seg.start);
    let consumed = 0; // words consumed — keeps interpolation exact on the uneven last chunk
    for (let i = 0; i < words.length; i += MAX_WORDS_PER_CUE) {
      const chunk = words.slice(i, i + MAX_WORDS_PER_CUE);
      const s = seg.start + (consumed / words.length) * segDur;
      consumed += chunk.length;
      const e = seg.start + (consumed / words.length) * segDur;
      const start = Math.max(s, clipStart);
      const end = Math.min(e, clipEnd);
      if (end - start < 0.05) continue;
      cues.push({ start: start - clipStart, end: end - clipStart, text: chunk.join(" ") });
    }
  }
  cues.sort((a, b) => a.start - b.start);
  // Enforce a minimum on-screen time. A cue may grow toward MIN_CUE_SECONDS
  // but never past the next cue's start or the clip's end — and never shrink.
  for (let i = 0; i < cues.length; i++) {
    const maxEnd = Math.min(
      i + 1 < cues.length ? cues[i + 1].start : Infinity,
      clipEnd - clipStart,
    );
    const target = Math.min(cues[i].start + MIN_CUE_SECONDS, maxEnd);
    if (target > cues[i].end) cues[i].end = target;
  }
  return cues;
}

interface AssStyle {
  font: "DejaVu Sans" | "DejaVu Serif" | "DejaVu Sans Mono";
  size: number;
  primary: string;
  outline: string;
  back: string;
  bold: 0 | -1;
  italic: 0 | -1;
  scaleY: number;
  spacing: number;
  /** 1 = outline+shadow, 3 = opaque box behind the text. */
  borderStyle: 1 | 3;
  outlineW: number;
  shadow: number;
  uppercase?: boolean;
  /** libass gaussian edge blur (`{\blur N}` per line) — the neon/glow looks. */
  blur?: number;
  /** Cycle these &H..BGR colours word-by-word (Eye Candy-style rainbow). */
  wordColors?: string[];
}

/** Visual map for every gallery style — tuned for 1080×1920 canvases. */
const STYLES: Record<SubtitleStyleId, AssStyle> = {
  basic:      { font: "DejaVu Sans", size: 60, primary: "&H00FFFFFF", outline: "&H00101010", back: "&H00101010", bold: -1, italic: 0,  scaleY: 100, spacing: 0, borderStyle: 3, outlineW: 10, shadow: 0 },
  modern:     { font: "DejaVu Sans", size: 62, primary: "&H00FFFFFF", outline: "&H82000000", back: "&H00000000", bold: -1, italic: 0,  scaleY: 100, spacing: 0, borderStyle: 1, outlineW: 2,  shadow: 0 },
  hormozi:    { font: "DejaVu Sans", size: 76, primary: "&H00FFFFFF", outline: "&H00000000", back: "&H00000000", bold: -1, italic: 0,  scaleY: 100, spacing: 0, borderStyle: 1, outlineW: 6,  shadow: 2, uppercase: true },
  classic:    { font: "DejaVu Sans", size: 64, primary: "&H0000E1FF", outline: "&H00000000", back: "&H00000000", bold: -1, italic: -1, scaleY: 100, spacing: 0, borderStyle: 1, outlineW: 3,  shadow: 1 },
  heat:       { font: "DejaVu Sans", size: 68, primary: "&H000095FF", outline: "&H000030B0", back: "&H00000000", bold: -1, italic: 0,  scaleY: 100, spacing: 0, borderStyle: 1, outlineW: 3,  shadow: 1 },
  icy:        { font: "DejaVu Sans", size: 66, primary: "&H00FFE87D", outline: "&H00A05A00", back: "&H00000000", bold: -1, italic: 0,  scaleY: 100, spacing: 0, borderStyle: 1, outlineW: 3,  shadow: 0 },
  ghost:      { font: "DejaVu Sans", size: 64, primary: "&H50FFFFFF", outline: "&H50000000", back: "&H00000000", bold: -1, italic: 0,  scaleY: 100, spacing: 0, borderStyle: 1, outlineW: 1,  shadow: 0 },
  editorial:  { font: "DejaVu Sans", size: 46, primary: "&H00D9D9D9", outline: "&H00000000", back: "&H00000000", bold: 0,  italic: 0,  scaleY: 100, spacing: 6, borderStyle: 1, outlineW: 2,  shadow: 0, uppercase: true },
  tallboy:    { font: "DejaVu Sans", size: 62, primary: "&H00FFFFFF", outline: "&H00000000", back: "&H00000000", bold: -1, italic: 0,  scaleY: 150, spacing: 0, borderStyle: 1, outlineW: 4,  shadow: 1, uppercase: true },
  elegant:    { font: "DejaVu Serif", size: 60, primary: "&H00C9E9F5", outline: "&H00403020", back: "&H00000000", bold: 0, italic: -1, scaleY: 100, spacing: 1, borderStyle: 1, outlineW: 2,  shadow: 0 },
  clean:      { font: "DejaVu Sans", size: 62, primary: "&H00FFFFFF", outline: "&H00202020", back: "&H00000000", bold: -1, italic: 0,  scaleY: 100, spacing: 0, borderStyle: 1, outlineW: 2,  shadow: 0 },
  highlight:  { font: "DejaVu Sans", size: 62, primary: "&H00000000", outline: "&H0017FED1", back: "&H0017FED1", bold: -1, italic: 0,  scaleY: 100, spacing: 0, borderStyle: 3, outlineW: 10, shadow: 0 },
  roundtable: { font: "DejaVu Sans", size: 60, primary: "&H00000000", outline: "&H005EC522", back: "&H005EC522", bold: -1, italic: 0,  scaleY: 100, spacing: 0, borderStyle: 3, outlineW: 10, shadow: 0 },
  matrix:     { font: "DejaVu Sans Mono", size: 60, primary: "&H0055FF22", outline: "&H00003300", back: "&H00000000", bold: -1, italic: 0, scaleY: 100, spacing: 0, borderStyle: 1, outlineW: 2, shadow: 0 },
  bubbly:     { font: "DejaVu Sans", size: 68, primary: "&H00D25FFF", outline: "&H00FFFFFF", back: "&H00000000", bold: -1, italic: 0,  scaleY: 100, spacing: 0, borderStyle: 1, outlineW: 3,  shadow: 1 },
  funky:      { font: "DejaVu Sans", size: 68, primary: "&H00FF3CC8", outline: "&H0000D6FF", back: "&H00000000", bold: -1, italic: 0,  scaleY: 100, spacing: 0, borderStyle: 1, outlineW: 3,  shadow: 1 },
  miner:      { font: "DejaVu Sans", size: 66, primary: "&H0014FF39", outline: "&H00003B06", back: "&H00000000", bold: -1, italic: 0,  scaleY: 100, spacing: 0, borderStyle: 1, outlineW: 3,  shadow: 0 },

  // ── Canva-inspired batch (colours are &HAABBGGRR — BGR order!) ────────────
  // Boxes (BorderStyle 3 — text on a filled pill):
  classicbox:   { font: "DejaVu Sans", size: 58, primary: "&H00FFFFFF", outline: "&H306E6E6E", back: "&H306E6E6E", bold: -1, italic: 0, scaleY: 100, spacing: 0, borderStyle: 3, outlineW: 12, shadow: 0 },
  clickbait:    { font: "DejaVu Sans", size: 60, primary: "&H00000000", outline: "&H00CB7EFF", back: "&H00CB7EFF", bold: -1, italic: 0, scaleY: 100, spacing: 0, borderStyle: 3, outlineW: 10, shadow: 0 },
  evergreen:    { font: "DejaVu Sans", size: 56, primary: "&H00E8F5EC", outline: "&H002B3D1F", back: "&H002B3D1F", bold: 0,  italic: 0, scaleY: 100, spacing: 1, borderStyle: 3, outlineW: 11, shadow: 0 },
  newsroom:     { font: "DejaVu Sans", size: 62, primary: "&H00141414", outline: "&H00DCEFF5", back: "&H00DCEFF5", bold: -1, italic: 0, scaleY: 100, spacing: 0, borderStyle: 3, outlineW: 11, shadow: 0, uppercase: true },
  goldenage:    { font: "DejaVu Sans", size: 60, primary: "&H00101010", outline: "&H003BC9FF", back: "&H003BC9FF", bold: -1, italic: 0, scaleY: 100, spacing: 0, borderStyle: 3, outlineW: 10, shadow: 0 },
  cleancut:     { font: "DejaVu Sans", size: 58, primary: "&H00202020", outline: "&H00B0FFED", back: "&H00B0FFED", bold: -1, italic: 0, scaleY: 100, spacing: 0, borderStyle: 3, outlineW: 10, shadow: 0 },
  // Bold poster looks (outline / offset shadow):
  pixelpop:     { font: "DejaVu Sans Mono", size: 62, primary: "&H004FFF7C", outline: "&H00101010", back: "&H00101010", bold: -1, italic: 0, scaleY: 100, spacing: 0, borderStyle: 1, outlineW: 3, shadow: 2 },
  momentum:     { font: "DejaVu Sans", size: 66, primary: "&H002E4DFF", outline: "&H00FFFFFF", back: "&H00202020", bold: -1, italic: -1, scaleY: 100, spacing: 0, borderStyle: 1, outlineW: 2, shadow: 1 },
  peachpop:     { font: "DejaVu Sans", size: 68, primary: "&H003BA1FF", outline: "&H00DCF2FF", back: "&H00202020", bold: -1, italic: 0, scaleY: 100, spacing: 0, borderStyle: 1, outlineW: 3, shadow: 1 },
  boldpop:      { font: "DejaVu Sans", size: 72, primary: "&H00181818", outline: "&H00FFFFFF", back: "&H00303030", bold: -1, italic: 0, scaleY: 100, spacing: 1, borderStyle: 1, outlineW: 4, shadow: 1, uppercase: true },
  penpal:       { font: "DejaVu Sans", size: 64, primary: "&H0027D2FF", outline: "&H00101010", back: "&H00101010", bold: -1, italic: -1, scaleY: 100, spacing: 0, borderStyle: 1, outlineW: 3, shadow: 0 },
  bigideas:     { font: "DejaVu Sans", size: 68, primary: "&H00D9D9D9", outline: "&H00303030", back: "&H00000000", bold: -1, italic: 0, scaleY: 100, spacing: 0, borderStyle: 1, outlineW: 2, shadow: 3, uppercase: true },
  boldlime:     { font: "DejaVu Sans", size: 74, primary: "&H002EFF8C", outline: "&H00103800", back: "&H00000000", bold: -1, italic: 0, scaleY: 100, spacing: 0, borderStyle: 1, outlineW: 2, shadow: 4, uppercase: true },
  heromode:     { font: "DejaVu Sans", size: 74, primary: "&H003BE1FF", outline: "&H002020E0", back: "&H002020E0", bold: -1, italic: 0, scaleY: 100, spacing: 0, borderStyle: 1, outlineW: 2, shadow: 4, uppercase: true },
  blockparty:   { font: "DejaVu Sans", size: 72, primary: "&H003BB0FF", outline: "&H00141414", back: "&H00141414", bold: -1, italic: 0, scaleY: 100, spacing: 1, borderStyle: 1, outlineW: 3, shadow: 5, uppercase: true },
  boxoffice:    { font: "DejaVu Serif", size: 68, primary: "&H002020E0", outline: "&H00000040", back: "&H00000000", bold: -1, italic: 0, scaleY: 100, spacing: 0, borderStyle: 1, outlineW: 3, shadow: 1, uppercase: true },
  markeddown:   { font: "DejaVu Sans", size: 62, primary: "&H00F5F5F5", outline: "&H00101010", back: "&H00101010", bold: -1, italic: -1, scaleY: 100, spacing: 0, borderStyle: 1, outlineW: 3, shadow: 0, uppercase: true },
  publicnotice: { font: "DejaVu Sans", size: 64, primary: "&H00FFFFFF", outline: "&H00FF6B2E", back: "&H00000000", bold: -1, italic: 0, scaleY: 100, spacing: 0, borderStyle: 1, outlineW: 3, shadow: 0 },
  // Neon / glow looks (blur + coloured outline = halo):
  cherryglow:   { font: "DejaVu Sans", size: 66, primary: "&H001E1EFF", outline: "&H004040FF", back: "&H00000000", bold: -1, italic: 0, scaleY: 100, spacing: 0, borderStyle: 1, outlineW: 4, shadow: 0, uppercase: true, blur: 4 },
  solarsign:    { font: "DejaVu Sans", size: 64, primary: "&H006BDFFF", outline: "&H0000B3FF", back: "&H00000000", bold: -1, italic: 0, scaleY: 100, spacing: 0, borderStyle: 1, outlineW: 4, shadow: 0, uppercase: true, blur: 5 },
  popcorn:      { font: "DejaVu Sans", size: 62, primary: "&H00FFFFFF", outline: "&H50FFFFFF", back: "&H00000000", bold: -1, italic: 0, scaleY: 100, spacing: 0, borderStyle: 1, outlineW: 4, shadow: 0, blur: 3 },
  afterglow:    { font: "DejaVu Sans", size: 64, primary: "&H00FFFA9F", outline: "&H00E8D24F", back: "&H00000000", bold: -1, italic: 0, scaleY: 100, spacing: 0, borderStyle: 1, outlineW: 4, shadow: 0, blur: 4 },
  talkingpoint: { font: "DejaVu Sans", size: 56, primary: "&H00FF7DC7", outline: "&H00FFFFFF", back: "&H00000000", bold: -1, italic: 0, scaleY: 100, spacing: 1, borderStyle: 1, outlineW: 2, shadow: 0, uppercase: true, blur: 2 },
  eerienight:   { font: "DejaVu Sans", size: 64, primary: "&H00C9FFB8", outline: "&H6070FF70", back: "&H00000000", bold: -1, italic: 0, scaleY: 100, spacing: 1, borderStyle: 1, outlineW: 5, shadow: 0, blur: 5 },
  arcade:       { font: "DejaVu Sans Mono", size: 62, primary: "&H00F25FFF", outline: "&H00C030FF", back: "&H00000000", bold: -1, italic: 0, scaleY: 100, spacing: 1, borderStyle: 1, outlineW: 4, shadow: 0, uppercase: true, blur: 4 },
  sugarrush:    { font: "DejaVu Sans", size: 64, primary: "&H00D88AFF", outline: "&H00FFFFFF", back: "&H00000000", bold: -1, italic: 0, scaleY: 100, spacing: 0, borderStyle: 1, outlineW: 3, shadow: 0, blur: 3 },
  infocus:      { font: "DejaVu Sans", size: 64, primary: "&H00FFFFFF", outline: "&H00000000", back: "&H00000000", bold: -1, italic: 0, scaleY: 100, spacing: 0, borderStyle: 1, outlineW: 5, shadow: 0, blur: 2 },
  // Script / minimal looks:
  freehand:     { font: "DejaVu Sans", size: 64, primary: "&H004DE3D6", outline: "&H40101010", back: "&H00000000", bold: 0,  italic: -1, scaleY: 100, spacing: 1, borderStyle: 1, outlineW: 2, shadow: 0 },
  digitalkitsch:{ font: "DejaVu Serif", size: 62, primary: "&H004EBE3D", outline: "&H30101010", back: "&H00000000", bold: 0,  italic: -1, scaleY: 100, spacing: 1, borderStyle: 1, outlineW: 2, shadow: 0 },
  sidenote:     { font: "DejaVu Serif", size: 52, primary: "&H60FFFFFF", outline: "&H80000000", back: "&H00000000", bold: 0,  italic: -1, scaleY: 100, spacing: 1, borderStyle: 1, outlineW: 1, shadow: 0 },
  refined:      { font: "DejaVu Sans", size: 48, primary: "&H008FB4E8", outline: "&H60000000", back: "&H00000000", bold: 0,  italic: 0, scaleY: 100, spacing: 5, borderStyle: 1, outlineW: 1, shadow: 0, uppercase: true },
  clearbrief:   { font: "DejaVu Sans", size: 60, primary: "&H68FFFFFF", outline: "&H90000000", back: "&H00000000", bold: 0,  italic: 0, scaleY: 100, spacing: 2, borderStyle: 1, outlineW: 1, shadow: 0 },
  softlyspoken: { font: "DejaVu Sans", size: 54, primary: "&H00FFFFFF", outline: "&H70000000", back: "&H00000000", bold: 0,  italic: 0, scaleY: 100, spacing: 2, borderStyle: 1, outlineW: 1, shadow: 0 },
  subtext:      { font: "DejaVu Sans", size: 48, primary: "&H00BFBFBF", outline: "&H80000000", back: "&H00000000", bold: 0,  italic: 0, scaleY: 100, spacing: 1, borderStyle: 1, outlineW: 1, shadow: 0 },
  bytetype:     { font: "DejaVu Sans Mono", size: 56, primary: "&H00E07DFF", outline: "&H60101010", back: "&H00000000", bold: 0,  italic: 0, scaleY: 100, spacing: 2, borderStyle: 1, outlineW: 1, shadow: 0 },
  losttape:     { font: "DejaVu Sans Mono", size: 60, primary: "&H00FFB6C9", outline: "&H00FFE34F", back: "&H00000000", bold: -1, italic: 0, scaleY: 100, spacing: 1, borderStyle: 1, outlineW: 2, shadow: 1, uppercase: true },
  sweettalk:    { font: "DejaVu Sans", size: 64, primary: "&H00D9B6FF", outline: "&H00FFFFFF", back: "&H00202020", bold: -1, italic: 0, scaleY: 100, spacing: 0, borderStyle: 1, outlineW: 3, shadow: 1 },
  // Word-by-word colour cycle:
  eyecandy:     { font: "DejaVu Sans", size: 64, primary: "&H00C34FFF", outline: "&H00FFFFFF", back: "&H00202020", bold: -1, italic: 0, scaleY: 100, spacing: 0, borderStyle: 1, outlineW: 2, shadow: 1, wordColors: ["&H00C34FFF", "&H00FF4FB4", "&H0071CC2E", "&H002E9FFF"] },
};

function assTime(t: number): string {
  const cs = Math.max(0, Math.round(t * 100));
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  const c = cs % 100;
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(c).padStart(2, "0")}`;
}

/** ASS override braces / backslashes would inject style tags — strip them. */
function escapeAssText(t: string): string {
  return t.replace(/[\\{}]/g, "").replace(/\r?\n/g, " ");
}

/** Build a complete .ass document for one clip's cues in the given style. */
export function buildAss(
  cues: SubCue[],
  styleId: SubtitleStyleId,
  opts?: { playResX?: number; playResY?: number },
): string {
  const st = STYLES[styleId];
  const w = opts?.playResX ?? 1080;
  const h = opts?.playResY ?? 1920;
  // Captions sit in the lower fifth — clear of platform UI overlays.
  const marginV = Math.round(h * 0.19);
  const header = [
    "[Script Info]",
    "; AutoCliper burned captions",
    "ScriptType: v4.00+",
    `PlayResX: ${w}`,
    `PlayResY: ${h}`,
    "WrapStyle: 0",
    "ScaledBorderAndShadow: yes",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    `Style: Cap,${st.font},${st.size},${st.primary},&H000000FF,${st.outline},${st.back},${st.bold},${st.italic},0,0,100,${st.scaleY},${st.spacing},0,${st.borderStyle},${st.outlineW},${st.shadow},2,90,90,${marginV},1`,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ];
  const lines = cues.map((c) => {
    const text = escapeAssText(st.uppercase ? c.text.toUpperCase() : c.text);
    // Escape first, THEN add our own override tags — user text can never
    // smuggle tags in, while glow/word-colour styles still get theirs.
    const deco = st.blur ? `{\\blur${st.blur}}` : "";
    const body = st.wordColors?.length
      ? text
          .split(" ")
          .map((w, i) => `{\\c${st.wordColors![i % st.wordColors!.length]}}${w}`)
          .join(" ")
      : text;
    return `Dialogue: 0,${assTime(c.start)},${assTime(c.end)},Cap,,0,0,0,,${deco}${body}`;
  });
  return header.concat(lines).join("\n") + "\n";
}

/** ffmpeg -vf argument burning `assPath` — escaped for the filter parser. */
export function subtitlesVfArg(assPath: string): string {
  const esc = assPath.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  return `subtitles=filename='${esc}'`;
}
