/**
 * Viral-style caption generator — one ready-to-paste caption (hook line +
 * hashtags) per finished clip.
 *
 * Deliberately template-based, NOT an LLM call: captions must be free,
 * instant, offline-safe, and behave identically in dev and on autoscale
 * prod. Variety comes from a hash of the source URL (per-job flavor) plus a
 * per-clip rotation, so the same job always produces the same captions
 * (stable across polls, cache hits, and instance handoffs — the value is
 * stored on the clip record anyway) while different sources feel different.
 */

export interface ClipCaptionInput {
  /** Source kind: youtube | twitch | kick | drive | dropbox | upload | unknown. */
  srcKind: string;
  /** Output format the user picked (shorts | original). */
  outputFormat: string;
  clipIndex: number;   // 0-based
  clipCount: number;
  durationSec: number; // this clip's length in seconds
  /** Original filename for device uploads — the best topic hint we have. */
  sourceName?: string;
  /** Stable seed — the source URL is a good choice. */
  seed: string;
  /** User's moment-selection prompt. Topic words here should shape the
   * caption and hashtags instead of falling back to generic viral tags. */
  prompt?: string;
  /** Gemini's evidence-backed explanation for this specific matched moment. */
  promptReason?: string;
  /** Detected language of the source speech/title. Defaults to a best-effort
   * detection from sourceName, then English. Retained for old callers; social
   * captions are now English-first regardless of source language. */
  language?: CaptionLanguage;
}

export type CaptionLanguage = "en" | "hi";

const DEVANAGARI_RE = /[\u0900-\u097f]/u;
const HINDI_LATIN_WORDS = new Set([
  "aap", "aaj", "achha", "acha", "aur", "badiya", "bhai", "bas", "dekho",
  "dekhe", "hai", "hain", "hoga", "kaise", "karna", "karo", "kya", "lagega",
  "mat", "mera", "meri", "nahi", "nahin", "paisa", "pक्का", "pakka", "phir",
  "sabse", "sahi", "wala", "wali", "yeh", "ye", "zabardast",
]);

/** Best-effort, local language detection for generated social captions.
 * Devanagari is authoritative; romanized Hindi is detected from common
 * function/hype words. If there is no usable text, keep the supplied fallback. */
export function detectCaptionLanguage(text?: string, fallback: CaptionLanguage = "en"): CaptionLanguage {
  const value = (text ?? "").trim();
  if (!value) return fallback;
  const letters = [...value].filter(ch => /\p{L}/u.test(ch));
  if (letters.length > 0 && letters.filter(ch => DEVANAGARI_RE.test(ch)).length >= 2) return "hi";

  const words = value
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
  const hindiHits = words.filter(word => HINDI_LATIN_WORDS.has(word)).length;
  return hindiHits >= 2 ? "hi" : "en";
}

// FNV-1a 32-bit — tiny, deterministic, good spread for template picks.
function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// Deterministic PRNG for the hashtag shuffle.
function mulberry32(a: number) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Hook lines for English content. */
const EN_HOOKS = [
  "Wait for it… 🤯",
  "This part broke the internet 🔥",
  "POV: you can't stop rewatching this 👀",
  "Sound ON for this one 🔊",
  "The ending is INSANE ⚡",
  "Nobody talks about this moment 🤫",
  "Watch till the end, trust me 🚀",
  "Bro really did that 💀",
  "This went 0 to 100 real quick 📈",
  "Certified rewatch moment 🔁",
  "You weren't ready for this one 😳",
  "Main character energy only 😤",
];

const EN_TOPIC_HOOKS = [
  (topic: string) => `${topic} moments hit different 🔥`,
  (topic: string) => `This ${topic.toLowerCase()} moment was unreal 👀`,
  (topic: string) => `The ${topic.toLowerCase()} clip everyone needs to see ⚡`,
  (topic: string) => `${topic} — wait for the payoff 🤯`,
];

/** Optional English second line — grounded in the clip's real duration. */
const EN_SPICE = [
  (d: number) => `${d} seconds of pure chaos.`,
  (d: number) => `${d} seconds you'll watch twice.`,
  (d: number) => `Only ${d} seconds — blink and you'll miss it.`,
];

const CORE_TAGS = [
  "#viral", "#trending", "#viralvideo", "#mustwatch", "#watchtillend",
];

const SRC_TAGS: Record<string, string[]> = {
  youtube: ["#youtube"],
  twitch:  ["#twitch", "#twitchclips", "#streamer"],
  kick:    ["#kick", "#kickstreamer", "#livestream"],
};

const FORMAT_TAGS: Record<string, string[]> = {
  shorts: ["#shorts", "#youtubeshorts"],
  reels: ["#reels", "#instagramreels"],
  tiktok: ["#tiktok"],
};

/** Filler words that make useless hashtags (EN + romanized HI). */
const STOP_WORDS = new Set([
  "the", "and", "for", "with", "this", "that", "from", "video", "videos",
  "clip", "clips", "final", "edit", "copy", "new", "file", "full", "part",
  "aur", "wala", "wali", "mera", "meri", "kaa", "kii", "kee", "hai", "con",
  // Machine/file noise that survives the digit filter as pure words:
  "whatsapp", "untitled", "export", "output", "recording", "record",
  "screen", "movie", "media", "audio", "track", "hevc", "uhd", "hdr",
  // Camera/app filename prefixes (IMG_2024…, DSC_, VID_, GoPro, DJI…):
  "img", "dsc", "vid", "mov", "mvi", "cam", "raw", "tmp", "temp",
  "obs", "dji", "gopro",
  // Prompt/instruction words describe what the generator should do, not the
  // video's topic. Filtering them avoids tags such as #caption or #include.
  "find", "show", "choose", "pick", "make", "create", "write", "include",
  "must", "should", "please", "need", "want", "only", "every", "each",
  "moment", "moments", "caption", "captions", "hashtag", "hashtags", "tag",
  "tags", "prompt", "first", "line", "post", "posting", "content", "use",
  "using", "put", "add", "according", "matching", "match", "selected",
]);

/** Pull relevant topic hashtags from a filename, prompt, or match reason.
 * Explicit hashtags always win; normal words are used only after instruction
 * noise and machine/file tokens are removed. */
function topicTags(text?: string, limit = 4): string[] {
  if (!text) return [];
  const explicit = [...text.matchAll(/(^|[^A-Za-z0-9_&])#([A-Za-z][A-Za-z0-9_]{1,49})/g)]
    .map(match => `#${match[2].toLowerCase()}`);
  const base = text.replace(/\.[a-z0-9]{2,5}$/i, ""); // drop a filename extension
  const words = base
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .split(/[^a-z0-9]+/)
    .filter(w =>
      // Human topics only: any digit marks a machine token (IMG_2024, x264,
      // 1080p, UUID fragments like 41d4) — none of those make a hashtag you'd
      // want under a reel. Overly long tokens are opaque ids, not words.
      w.length >= 3 && w.length <= 16 && !STOP_WORDS.has(w) && !/\d/.test(w),
    );
  const wordTags = [...new Set(words)].map(w => `#${w}`);
  return [...new Set([...explicit, ...wordTags])].slice(0, limit);
}

function topicLabel(tags: string[]): string | null {
  if (tags.length === 0) return null;
  const words = tags.slice(0, 2).map(tag => tag.slice(1));
  const phrase = words.join(" ");
  return phrase ? phrase.charAt(0).toUpperCase() + phrase.slice(1) : null;
}

/** Build the full English caption (topic-aware hook + hashtags). */
export function buildClipCaption(input: ClipCaptionInput): string {
  const jobHash = hash32(input.seed);
  const clipHash = hash32(`${input.seed}#${input.clipIndex}`);
  const promptTags = topicTags(input.prompt, 4);
  const reasonTags = topicTags(input.promptReason, 3);
  const nameTags = topicTags(input.sourceName, 2);
  const relevantTags = [...new Set([...promptTags, ...reasonTags, ...nameTags])];
  const topic = topicLabel(relevantTags);

  // Prompt-guided jobs get a grounded topic in the hook; ordinary jobs retain
  // the broad English hook rotation.
  const hook = topic
    ? EN_TOPIC_HOOKS[(jobHash + input.clipIndex) % EN_TOPIC_HOOKS.length](topic)
    : EN_HOOKS[(jobHash + input.clipIndex) % EN_HOOKS.length];

  // ~50% of captions get a duration-grounded second line.
  const lines = [hook];
  if (input.durationSec >= 5 && (clipHash & 1) === 1) {
    const spice = EN_SPICE[(clipHash >>> 1) % EN_SPICE.length];
    lines.push(spice(Math.round(input.durationSec)));
  }

  // Hashtags: prompt/match topic first, then destination + source, and only a
  // small generic tail. Dedupe, cap at 10 to keep the caption intentional.
  const rnd = mulberry32(jobHash ^ Math.imul(input.clipIndex + 1, 0x9e3779b9));
  const core = [...CORE_TAGS];
  for (let i = core.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [core[i], core[j]] = [core[j], core[i]];
  }
  const tags: string[] = [];
  for (const t of [
    ...relevantTags,
    ...(FORMAT_TAGS[input.outputFormat] ?? []),
    ...(SRC_TAGS[input.srcKind] ?? []),
    ...core.slice(0, 3),
  ]) {
    if (!tags.includes(t)) tags.push(t);
    if (tags.length >= 10) break;
  }

  return `${lines.join("\n")}\n\n${tags.join(" ")}`;
}
