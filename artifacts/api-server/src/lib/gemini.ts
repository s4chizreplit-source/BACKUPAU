/**
 * Gemini caption writer — the only external-AI touchpoint.
 *
 * Never throws: every failure path returns null and callers fall back to a
 * non-AI caption, so posting is never blocked on the model. The API key
 * travels in a request header (never the URL) so it can't leak into logs.
 */

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

export function isGeminiConfigured(): boolean {
  return Boolean(process.env.GEMINI_API_KEY);
}

interface CaptionOpts {
  platforms?: string[];
  timeoutMs?: number;
}

export async function generateViralCaption(topic: string, opts: CaptionOpts = {}): Promise<string | null> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return null;
  const model = process.env.GEMINI_MODEL || "gemini-2.5-flash";
  const subject = topic.trim().slice(0, 300) || "a short vertical video";
  const platforms = (opts.platforms ?? []).filter(Boolean).join(", ");
  const prompt =
    `Write ONE polished English social-media caption for this video: "${subject}".` +
    (platforms ? ` It will be posted on: ${platforms}.` : "") +
    ` Rules: use the video's actual topic, not a generic hook; start with a concise scroll-stopping hook;` +
    ` at most 2 short lines of text; then 3-5 topic-specific hashtags on the last line;` +
    ` include platform tags only when relevant; avoid generic spam tags such as #fyp and #foryou; under 350 characters total;` +
    ` at most 2 emojis; plain text only — no quotes, no markdown, no explanations;` +
    ` write in natural English even when the video title or speech is Hindi/Hinglish.` +
    ` Reply with the caption text only.`;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 8_000);
  try {
    const resp = await fetch(`${GEMINI_BASE}/${model}:generateContent`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        // Generous token cap: flash models may spend "thinking" tokens before
        // the visible answer; captions themselves stay tiny.
        generationConfig: { temperature: 0.9, maxOutputTokens: 2000 },
      }),
      signal: ctrl.signal,
    });
    if (!resp.ok) {
      console.warn(`[gemini] caption request failed: HTTP ${resp.status}`);
      return null;
    }
    const data = (await resp.json()) as {
      candidates?: { content?: { parts?: { text?: string }[] } }[];
    };
    const raw = (data.candidates?.[0]?.content?.parts ?? [])
      .map((p) => p.text ?? "")
      .join("")
      .trim();
    // Models love wrapping answers in quotes/backticks — strip one layer.
    const clean = raw.replace(/^["'`]+|["'`]+$/g, "").trim().slice(0, 2000);
    return clean || null;
  } catch (err) {
    console.warn("[gemini] caption request failed:", (err as Error).message);
    return null;
  } finally {
    clearTimeout(timer);
  }
}
