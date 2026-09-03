import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateViralCaption, isGeminiConfigured } from "./gemini";

const realFetch = globalThis.fetch;

describe("gemini caption writer", () => {
  beforeEach(() => {
    process.env.GEMINI_API_KEY = "test-key";
  });
  afterEach(() => {
    delete process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_MODEL;
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it("is unconfigured without a key and never calls the network", async () => {
    delete process.env.GEMINI_API_KEY;
    const spy = vi.fn();
    globalThis.fetch = spy as unknown as typeof fetch;
    expect(isGeminiConfigured()).toBe(false);
    expect(await generateViralCaption("gym video")).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it("returns the model's caption, stripped of wrapping quotes", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({
        candidates: [{ content: { parts: [{ text: '"Gym beast mode 🔥\n#gym #fitness"' }] } }],
      }), { status: 200 }),
    ) as unknown as typeof fetch;
    expect(await generateViralCaption("gym video")).toBe("Gym beast mode 🔥\n#gym #fitness");
  });

  it("sends the key in a header, never in the URL", async () => {
    let seenUrl = "";
    let seenKey: string | null = null;
    globalThis.fetch = vi.fn(async (url: unknown, init?: RequestInit) => {
      seenUrl = String(url);
      seenKey = (init?.headers as Record<string, string>)["x-goog-api-key"] ?? null;
      return new Response(JSON.stringify({ candidates: [] }), { status: 200 });
    }) as unknown as typeof fetch;
    await generateViralCaption("x");
    expect(seenUrl).not.toContain("test-key");
    expect(seenKey).toBe("test-key");
  });

  it("returns null on HTTP errors", async () => {
    globalThis.fetch = vi.fn(async () => new Response("nope", { status: 429 })) as unknown as typeof fetch;
    expect(await generateViralCaption("x")).toBeNull();
  });

  it("returns null when fetch rejects (timeout/abort)", async () => {
    globalThis.fetch = vi.fn(async () => { throw new Error("aborted"); }) as unknown as typeof fetch;
    expect(await generateViralCaption("x")).toBeNull();
  });

  it("returns null on an empty answer", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({
        candidates: [{ content: { parts: [{ text: "   " }] } }],
      }), { status: 200 }),
    ) as unknown as typeof fetch;
    expect(await generateViralCaption("x")).toBeNull();
  });
});
