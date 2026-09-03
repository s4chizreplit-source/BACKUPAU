/**
 * Campaign-requirements compliance (Whop / Discord clipping campaigns).
 *
 * Clippers paste a campaign's rules straight into the AI prompt box:
 *   "Must tag @watchoceans & @dougelks on all platforms"
 *   "Length: A minimum of 15 seconds"
 *   "On-screen captions. Required on every video"
 *   "Clear call-to-action in the first line of the caption AND at the end of
 *    each video ... 'Follow @dougelks & @watchoceans for more content like this.'"
 *
 * This module reads those rules DETERMINISTICALLY (regex — no model call) so
 * compulsory items never depend on an AI's mood:
 *   - extractCampaignRequirements(prompt) → structured rules or null
 *   - enforceCaptionRequirements(caption) → caption guaranteed to carry every
 *     compulsory tag/hashtag/CTA (idempotent — safe to run twice)
 *   - drawtextCtaFilters(...) → ffmpeg drawtext end-card for "CTA at the end
 *     of the video" rules
 *
 * The Gemini moment-matcher still sees the full prompt for WHICH moments to
 * clip; this layer only guarantees the compulsory outputs. Everything here is
 * pure and never throws.
 */

export interface CampaignRequirements {
  /** Handles that must appear in every caption (no leading @, original casing). */
  handles: string[];
  /** Hashtags that must appear in every caption (no leading #, original casing). */
  hashtags: string[];
  /** Exact copy the brief says must appear in the caption. */
  requiredCaptionText: string | null;
  /** CTA sentence — quoted in the rules when available, else composed from handles. */
  ctaText: string | null;
  /** The brief explicitly says that links must not appear in the caption. */
  forbidLinks: boolean;
  /** Rules demand the CTA in the caption's FIRST line. */
  ctaFirstLine: boolean;
  /** Rules demand a CTA at the END of the video itself (burned end-card). */
  endCta: boolean;
  /** Minimum clip length in seconds ("minimum of 15 seconds", "no clips shorter than..."). */
  minClipSeconds: number | null;
  /** Rules demand burned on-screen captions. */
  onScreenCaptions: boolean;
}

const HANDLE_RE = /(^|[^A-Za-z0-9_.])@([A-Za-z0-9_](?:[A-Za-z0-9_.]{0,28}[A-Za-z0-9_])?)/g;
const HASHTAG_RE = /(^|[^A-Za-z0-9_&])#([A-Za-z0-9_]{2,50})/g;

/** Keywords that mark the prompt as carrying caption/posting RULES rather than
 *  a pure "which moments" instruction. Without one of these, @/# mentions are
 *  treated as content references, not compulsory caption items. */
const RULES_CONTEXT_RE = /\b(tag|tags|tagged|tagging|caption|captions|hashtag|hashtags|must|require|required|requirement|compulsory|mandatory|cta|call[-\s]?to[-\s]?action|placement|description|bio)\b/i;
// "Include/use @brand in every caption" and "mention @brand in the
// description" are common brief wording, but a bare @mention in a moment
// selection prompt is not a publishing rule. Keep these verbs contextual.
const MENTION_RULE_RE = /\b(mention|include|use)\b[^.!?\n]{0,80}(?:@[\w.]|#[A-Za-z0-9_])/i;

/** Requirement-language check in a small window around a specific rule match.
 *  A rules sheet says "Must be longer than 15 seconds" / "Captions required on
 *  every video"; a moment-selection prompt says "find a segment at least 15
 *  seconds long". Only the former may change the job's output. */
const NEAR_RULE_RE = /\b(must|minimum|require[ds]?|requirements?|mandatory|compulsory|rejected?|rejection|rules?|no clips?|no videos?|every video|all videos|no exceptions?)\b/i;

function windowHas(text: string, index: number, matchLen: number, re: RegExp, radius = 70): boolean {
  const from = Math.max(0, index - radius);
  const to = Math.min(text.length, index + matchLen + radius);
  return re.test(text.slice(from, to));
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Token-aware presence: a required `@dougelk` is NOT satisfied by
 *  `@dougelks`, but a trailing sentence period ("…@dougelks.") still counts. */
const hasHandleIn = (text: string, handle: string) =>
  new RegExp(`@${escapeRe(handle)}(?![A-Za-z0-9_]|\\.[A-Za-z0-9_])`, "i").test(text);
const hasHashtagIn = (text: string, tag: string) =>
  new RegExp(`#${escapeRe(tag)}(?![A-Za-z0-9_])`, "i").test(text);

function dedupeCaseInsensitive(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const it of items) {
    const k = it.toLowerCase();
    if (!seen.has(k)) { seen.add(k); out.push(it); }
  }
  return out;
}

/** Parse pasted campaign rules out of the user's prompt. Returns null when the
 *  prompt carries no recognizable rules — the clip job then behaves exactly as
 *  before. Works on sanitized prompts (whitespace collapsed to single spaces). */
export function extractCampaignRequirements(prompt: string): CampaignRequirements | null {
  if (typeof prompt !== "string") return null;
  const p = prompt.replace(/\s+/g, " ").trim();
  if (p.length < 8) return null;

  const rulesContext = RULES_CONTEXT_RE.test(p) || MENTION_RULE_RE.test(p);

  const handles: string[] = [];
  if (rulesContext) {
    for (const m of p.matchAll(HANDLE_RE)) handles.push(m[2]!);
  }
  const hashtags: string[] = [];
  if (rulesContext) {
    for (const m of p.matchAll(HASHTAG_RE)) hashtags.push(m[2]!);
  }
  const uniqueHandles = dedupeCaseInsensitive(handles).slice(0, 8);
  const uniqueHashtags = dedupeCaseInsensitive(hashtags).slice(0, 12);

  // Minimum clip length — take the strictest (largest) stated minimum.
  const mins: number[] = [];
  for (const re of [
    /minimum of (\d{1,3})\s*sec(?:ond)?s?/gi,
    /at least (\d{1,3})\s*sec(?:ond)?s?/gi,
    /longer than (\d{1,3})\s*sec(?:ond)?s?/gi,
    /shorter than (\d{1,3})\s*sec(?:ond)?s?/gi, // "no clips shorter than 15 seconds"
    /(\d{1,3})\s*sec(?:ond)?s?\s*(?:minimum|or longer|\+)/gi,
  ]) {
    for (const m of p.matchAll(re)) {
      const n = Number(m[1]);
      if (!Number.isFinite(n) || n < 5 || n > 180) continue;
      // Only rule-sheet language may change clip length — "find a segment at
      // least 15 seconds long" is moment selection, not a campaign rule.
      if (!windowHas(p, m.index ?? 0, m[0].length, NEAR_RULE_RE)) continue;
      mins.push(n);
    }
  }
  const minClipSeconds = mins.length > 0 ? Math.max(...mins) : null;

  // Same near-window gating: "On-screen captions. Required on every video" is
  // a rule; "clip the parts with on-screen captions" is content description.
  let onScreenCaptions = false;
  const onScreenM = /on[-\s]?screen captions?/i.exec(p);
  if (onScreenM && windowHas(p, onScreenM.index, onScreenM[0].length, NEAR_RULE_RE)) onScreenCaptions = true;
  if (/\bcaptions?\b[^.!?]{0,40}\brequired\b/i.test(p)) onScreenCaptions = true;

  const CTA_WORD = "(?:cta|call[-\\s]?to[-\\s]?action)";
  const ctaFirstLine = new RegExp(
    `${CTA_WORD}[^.!?]{0,80}first line|first line[^.!?]{0,80}${CTA_WORD}`, "i",
  ).test(p);
  const endCta = new RegExp(
    `${CTA_WORD}[^.!?]{0,100}(?:at the end|end of (?:each|the|every) video)`, "i",
  ).test(p) || /at the end of (?:each|the|every) video[^.!?]{0,60}(?:cta|call[-\s]?to[-\s]?action)/i.test(p);

  // A brief can mandate literal copy without calling it a CTA, for example:
  // `must write in the caption "NOW STREAMING ON ..."` This must survive
  // every caption generator/rewrite exactly as supplied.
  let requiredCaptionText: string | null = null;
  const requiredCopyM = /\b(?:must|should|please|need to)\s+(?:write|include|use|put|add)\s+(?:the\s+)?(?:following\s+)?(?:text\s+)?(?:in|on)\s+(?:the\s+)?(?:caption|description|post)[^"“”\n]{0,60}["“]([^"“”\n]{2,220})["”]/i.exec(p);
  if (requiredCopyM) {
    requiredCaptionText = requiredCopyM[1]!.trim().replace(/\s+/g, " ").slice(0, 220) || null;
  }
  const forbidLinks = /\b(?:do not|don't|never)\s+(?:link(?:\s+to)?|add|include|use|share)\b|\bno\s+links?\b/i.test(p);

  // CTA text: prefer a sentence the rules quote verbatim; otherwise capture a
  // concise `CTA: ...` / `call to action is ...` instruction, then compose a
  // natural one from the compulsory handles. Never invent handles.
  let ctaText: string | null = null;
  // Double/curly quotes first — apostrophes ("Doug Elk's") make single-quote
  // pairs unreliable, so they are only a fallback.
  outer: for (const re of [
    /["\u201C\u201D]([^"\u201C\u201D]{8,140})["\u201C\u201D]/g,
    /'([^']{8,140})'/g,
  ]) {
    for (const m of p.matchAll(re)) {
      const candidate = m[1]!.trim();
      if (/@[A-Za-z0-9_.]/.test(candidate) || /\bfollow\b/i.test(candidate)) {
        ctaText = candidate;
        break outer;
      }
    }
  }
  if (!ctaText) {
    const ctaM = /(?:\bcta\b|\bcall[-\s]?to[-\s]?action\b)\s*(?:is|:|-)\s*["“]?([^.!?\n]{8,140})["”]?/i.exec(p);
    const candidate = ctaM?.[1]?.trim().replace(/[,"'”]+$/, "").trim();
    if (candidate && !/\b(first line|at the end|end of)\b/i.test(candidate)) ctaText = candidate;
  }
  if (!ctaText && (ctaFirstLine || endCta) && uniqueHandles.length > 0) {
    ctaText = `Follow ${uniqueHandles.map((h) => `@${h}`).join(" & ")} for more!`;
  }

  const anyRule =
    uniqueHandles.length > 0 || uniqueHashtags.length > 0 || minClipSeconds !== null ||
    onScreenCaptions || ctaFirstLine || endCta || requiredCaptionText !== null || forbidLinks;
  if (!anyRule) return null;

  return {
    handles: uniqueHandles,
    hashtags: uniqueHashtags,
    requiredCaptionText,
    ctaText,
    forbidLinks,
    ctaFirstLine,
    endCta,
    minClipSeconds,
    onScreenCaptions,
  };
}

/** Validate requirement metadata carried by a clip/history record or by a
 * posting request. The UI is allowed to send this as a same-request fallback
 * before its history row has committed, but all values are bounded and shaped
 * here before they reach the enforcer. */
export function normalizeCampaignRequirements(raw: unknown): CampaignRequirements | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const list = (value: unknown, max: number, pattern: RegExp): string[] =>
    Array.isArray(value)
      ? dedupeCaseInsensitive(value.filter((v): v is string => typeof v === "string")
          .map(v => v.trim()).filter(v => pattern.test(v))).slice(0, max)
      : [];
  const handles = list(r.handles, 8, /^[A-Za-z0-9_](?:[A-Za-z0-9_.]{0,28}[A-Za-z0-9_])?$/);
  const hashtags = list(r.hashtags, 12, /^[A-Za-z0-9_]{2,50}$/);
  const requiredCaptionText = typeof r.requiredCaptionText === "string"
    ? r.requiredCaptionText.trim().replace(/\s+/g, " ").slice(0, 220) || null
    : null;
  const ctaText = typeof r.ctaText === "string" ? r.ctaText.trim().slice(0, 140) || null : null;
  const minClipSeconds = typeof r.minClipSeconds === "number" && Number.isFinite(r.minClipSeconds)
    ? Math.min(180, Math.max(5, Math.round(r.minClipSeconds)))
    : null;
  const ctaFirstLine = r.ctaFirstLine === true;
  const endCta = r.endCta === true;
  const forbidLinks = r.forbidLinks === true;
  const onScreenCaptions = r.onScreenCaptions === true;
  if (!handles.length && !hashtags.length && !requiredCaptionText && !ctaText && !ctaFirstLine && !endCta && !forbidLinks && minClipSeconds === null && !onScreenCaptions) {
    return null;
  }
  return { handles, hashtags, requiredCaptionText, ctaText, forbidLinks, ctaFirstLine, endCta, minClipSeconds, onScreenCaptions };
}

/** Caption length cap shared by TikTok/Instagram (YouTube allows more). */
const CAPTION_LIMIT = 2200;

/** Deterministically guarantee the caption satisfies the campaign rules:
 *  CTA first line when demanded, every compulsory @handle and #hashtag
 *  present. Idempotent; compulsory parts always survive the length cap. */
export function enforceCaptionRequirements(caption: string, req: CampaignRequirements): string {
  let base = (caption ?? "").trim();
  if (req.forbidLinks) {
    // A campaign may forbid a streaming/affiliate link. Strip URL forms before
    // checking the rest of the requirements so AI rewrites cannot reintroduce
    // one. This intentionally leaves ordinary non-link text untouched.
    base = base.replace(/(?:https?:\/\/|www\.)[^\s)\]}>,]+/gi, "").replace(/[ \t]+\n/g, "\n").trim();
  }

  // Compliance is re-checked after every trim: a tag that only lived in the
  // trimmed-off tail must be re-appended, or the guarantee silently breaks.
  for (let pass = 0; pass < 4; pass++) {
    // 1) CTA in the first line: prepend unless the first line already carries
    //    the CTA (or all compulsory handles, which reads as a CTA).
    let ctaLine: string | null = null;
    if (req.ctaText) {
      const cta = req.ctaText.trim();
      const firstLine = base.split("\n", 1)[0] ?? "";
      const firstHasCta = cta.length > 0 && firstLine.toLowerCase().includes(cta.toLowerCase());
      const firstHasAllHandles =
        req.handles.length > 0 && req.handles.every((h) => hasHandleIn(firstLine, h));
      if (req.ctaFirstLine) {
        if (!firstHasCta && !firstHasAllHandles) ctaLine = cta;
      } else if (!base.toLowerCase().includes(cta.toLowerCase()) && req.handles.some((h) => !hasHandleIn(base, h))) {
        // No first-line rule: only add the CTA when it's needed to carry
        // missing compulsory handles (avoids duplicating a fine caption).
        ctaLine = cta;
      }
    }

    const requiredLine = req.requiredCaptionText &&
      !base.toLowerCase().includes(req.requiredCaptionText.toLowerCase())
      ? req.requiredCaptionText
      : null;
    const prefix = [ctaLine, requiredLine].filter((line): line is string => Boolean(line)).join("\n");
    const withCta = prefix ? `${prefix}${base ? "\n" + base : ""}` : base;

    // 2) Compulsory handles/hashtags still missing → append as a final line.
    //    Token-aware: `@dougelks` never satisfies a required `@dougelk`.
    const missing: string[] = [];
    for (const h of req.handles) if (!hasHandleIn(withCta, h)) missing.push(`@${h}`);
    for (const t of req.hashtags) if (!hasHashtagIn(withCta, t)) missing.push(`#${t}`);
    const missingLine = missing.join(" ");

    const parts: string[] = [];
    if (ctaLine) parts.push(ctaLine);
    if (requiredLine) parts.push(requiredLine);
    if (base) parts.push(base);
    if (missingLine) parts.push(missingLine);
    const joined = parts.join("\n").trim();

    // 3) Length cap: compulsory parts always survive; only the base caption
    //    is trimmed — then the loop re-verifies what the trim swallowed.
    if (joined.length <= CAPTION_LIMIT || base.length === 0) return joined;
    const overhead =
      (ctaLine ? ctaLine.length + 1 : 0) +
      (requiredLine ? requiredLine.length + 1 : 0) +
      (missingLine ? missingLine.length + 1 : 0);
    base = base.slice(0, Math.max(0, CAPTION_LIMIT - overhead)).trimEnd();
  }

  // Unreachable in practice (the base strictly shrinks each pass) — fall back
  // to compulsory items only, never an over-limit or non-compliant caption.
  const tags = [...req.handles.map((h) => `@${h}`), ...req.hashtags.map((t) => `#${t}`)].join(" ");
  return [req.ctaText?.trim(), req.requiredCaptionText?.trim(), tags].filter(Boolean).join("\n").trim().slice(0, CAPTION_LIMIT);
}

/** One-line, user-facing summary for the job notes — honest about what the
 *  system enforced on the user's behalf. */
export function summarizeRequirements(
  req: CampaignRequirements,
  applied?: { subtitlesForced?: boolean; ctaSkipped?: number; minCappedTo?: number | null },
): string {
  const bits: string[] = [];
  if (req.handles.length > 0) bits.push(`caption tags ${req.handles.map((h) => `@${h}`).join(" ")}`);
  if (req.hashtags.length > 0) bits.push(`hashtags ${req.hashtags.map((t) => `#${t}`).join(" ")}`);
  if (req.requiredCaptionText) bits.push("required caption text");
  if (req.forbidLinks) bits.push("links removed from captions");
  if (req.ctaFirstLine && req.ctaText) bits.push("CTA in the first caption line");
  if (req.minClipSeconds) {
    const cap = applied?.minCappedTo;
    bits.push(cap && cap < req.minClipSeconds
      // Honest when the campaign minimum can't be met on this format — never
      // claim a minimum that the platform cap silently shortened.
      ? `campaign minimum ${req.minClipSeconds}s exceeds this format's ${cap}s limit — clips are ${cap}s (use the Original format for longer)`
      : `clips ≥ ${req.minClipSeconds}s`);
  }
  if (req.onScreenCaptions) bits.push(applied?.subtitlesForced ? "on-screen captions (turned on for you)" : "on-screen captions");
  if (req.endCta && req.ctaText) {
    bits.push(
      applied?.ctaSkipped && applied.ctaSkipped > 0
        ? `CTA end-card (skipped on ${applied.ctaSkipped} clip${applied.ctaSkipped === 1 ? "" : "s"})`
        : "CTA end-card on the video",
    );
  }
  return `Campaign rules applied: ${bits.join(" · ")}.`;
}

// ── End-of-video CTA drawtext ─────────────────────────────────────────────────

/** Characters we allow into a burned end-card. Runtime fonts are DejaVu
 *  (Latin) — anything else would render tofu boxes, so we skip instead. */
const CTA_SAFE_RE = /^[\x20-\x7E]+$/;

function balancedSplit(text: string): string[] {
  if (text.length <= 30) return [text];
  const mid = Math.floor(text.length / 2);
  let best = -1;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === " " && (best === -1 || Math.abs(i - mid) < Math.abs(best - mid))) best = i;
  }
  if (best === -1) return [text];
  return [text.slice(0, best).trim(), text.slice(best + 1).trim()].filter((s) => s.length > 0);
}

/** Build ffmpeg drawtext filter strings that burn the CTA over the clip's
 *  final ~3 seconds (top area — clear of subtitles at the bottom). Returns
 *  null when the clip is too short or the text can't render safely; the
 *  caller must treat null as "no end-card", never as an error. */
export function drawtextCtaFilters(
  ctaText: string,
  clipDurationSec: number,
  targetW: number,
  targetH: number,
): string[] | null {
  if (!(clipDurationSec >= 8) || !(targetW > 0) || !(targetH > 0)) return null;
  // Strip characters that fight the filtergraph parser or the font, keep the
  // message readable: quotes dropped, everything non-Latin rejected.
  const cleaned = ctaText.replace(/["'\\%;]/g, "").replace(/\s+/g, " ").trim();
  if (cleaned.length < 4 || cleaned.length > 140 || !CTA_SAFE_RE.test(cleaned)) return null;

  const lines = balancedSplit(cleaned);
  const longest = Math.max(...lines.map((l) => l.length));
  // DejaVu Sans Bold ≈ 0.62 × fontsize per char; keep 8% side margins.
  const fitSize = Math.floor((targetW * 0.92) / (0.62 * longest));
  const fontsize = Math.max(20, Math.min(fitSize, Math.floor(targetH / 22)));
  const showFrom = Math.max(0, clipDurationSec - 3).toFixed(2);
  const boxPad = Math.max(8, Math.round(fontsize * 0.35));
  const yBase = Math.round(targetH * 0.14);
  const lineStep = Math.round(fontsize * 1.45);

  return lines.map((line, i) =>
    [
      `drawtext=text='${line}'`,
      "expansion=none",
      "font=DejaVu Sans",
      `fontsize=${fontsize}`,
      "fontcolor=white",
      "borderw=2",
      "bordercolor=black@0.9",
      "box=1",
      "boxcolor=black@0.55",
      `boxborderw=${boxPad}`,
      "x=(w-text_w)/2",
      `y=${yBase + i * lineStep}`,
      `enable='gte(t,${showFrom})'`,
    ].join(":"),
  );
}
