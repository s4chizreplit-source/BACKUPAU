/**
 * Unit tests for the Object Storage cleanup cycle (runObjectStorageCleanup).
 *
 * The tests seed a fake in-memory Object Storage bucket with three kinds of
 * entries and verify the cleanup produces the correct outcome:
 *
 *   1. A live pair   — media key + non-expired .meta.json  → must survive
 *   2. An orphan     — media key with NO .meta.json         → must be deleted
 *   3. An expired pair — media key + expired .meta.json    → both must be deleted
 *
 * The bucket byte counter (setBucketBytes / getBucketBytes) must reflect only
 * the size of the surviving live clip after the sweep.
 *
 * runObjectStorageCleanup() is exported from videoTools.ts so it can be called
 * directly without triggering the setInterval timer.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// ── Fake Object Storage ───────────────────────────────────────────────────────

type FakeStore = Map<string, Buffer>;

interface FakeListItem { name: string }

/**
 * Build a fake StorageAdapter backed by an in-memory Map.
 *
 * `list` honours the `matchGlob` option:
 *   - "clips/*.meta.json" → returns only keys that end with ".meta.json"
 *   - absent / any other value  → returns all keys under the given prefix
 */
function makeFakeStorage(store: FakeStore) {
  return {
    uploadFromFilename: vi.fn(async (key: string) => {
      // Not exercised by cleanup tests
      return { ok: true as const };
    }),
    uploadFromText: vi.fn(async (key: string, text: string) => {
      store.set(key, Buffer.from(text, "utf8"));
      return { ok: true as const };
    }),
    downloadAsText: vi.fn(async (key: string) => {
      const buf = store.get(key);
      if (!buf) return { ok: false as const, value: "" };
      return { ok: true as const, value: buf.toString("utf8") };
    }),
    downloadAsBytes: vi.fn(async (key: string) => {
      const buf = store.get(key);
      if (!buf) return { ok: false as const, value: Buffer.alloc(0) };
      return { ok: true as const, value: buf };
    }),
    downloadToFilename: vi.fn(async () => ({ ok: true as const })),
    list: vi.fn(async (opts?: { prefix?: string; matchGlob?: string }): Promise<{ ok: boolean; value: FakeListItem[] }> => {
      const prefix = opts?.prefix ?? "";
      const metaOnly = opts?.matchGlob === "clips/*.meta.json";
      const matches = [...store.keys()]
        .filter(k => k.startsWith(prefix))
        .filter(k => !metaOnly || k.endsWith(".meta.json"))
        .map(name => ({ name }));
      return { ok: true, value: matches };
    }),
    delete: vi.fn(async (key: string) => {
      store.delete(key);
      return { ok: true as const };
    }),
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Seed a live (non-expired) pair into the fake store. */
function seedLivePair(store: FakeStore, base: string, sizeBytes: number): void {
  const meta = {
    name: `${base}.mp4`,
    mimeType: "video/mp4",
    ext: ".mp4",
    expiresMs: Date.now() + 7_200_000, // expires 2 h from now
    sizeBytes,
  };
  store.set(`clips/${base}.meta.json`, Buffer.from(JSON.stringify(meta), "utf8"));
  store.set(`clips/${base}.mp4`, Buffer.alloc(sizeBytes, 0x41)); // 'A' bytes
}

/** Seed an expired pair (past expiresMs) into the fake store. */
function seedExpiredPair(store: FakeStore, base: string, sizeBytes: number): void {
  const meta = {
    name: `${base}.mp4`,
    mimeType: "video/mp4",
    ext: ".mp4",
    expiresMs: Date.now() - 5_000, // expired 5 s ago
    sizeBytes,
  };
  store.set(`clips/${base}.meta.json`, Buffer.from(JSON.stringify(meta), "utf8"));
  store.set(`clips/${base}.mp4`, Buffer.alloc(sizeBytes, 0x42));
}

/** Seed a permanent pair (expiresMs = null — never expires). */
function seedPermanentPair(store: FakeStore, base: string, sizeBytes: number): void {
  const meta = {
    name: `${base}.mp4`,
    mimeType: "video/mp4",
    ext: ".mp4",
    expiresMs: null, // permanent
    sizeBytes,
  };
  store.set(`clips/${base}.meta.json`, Buffer.from(JSON.stringify(meta), "utf8"));
  store.set(`clips/${base}.mp4`, Buffer.alloc(sizeBytes, 0x43));
}

/** Seed an orphan media key (no .meta.json counterpart). */
function seedOrphan(store: FakeStore, base: string): void {
  store.set(`clips/${base}.mp4`, Buffer.from("orphan-bytes", "utf8"));
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("runObjectStorageCleanup — Object Storage sweep", () => {
  let fakeStore: FakeStore;

  beforeEach(async () => {
    fakeStore = new Map();
    const mod = await import("../lib/fileStore.js");
    mod._setStorageClientForTest(makeFakeStorage(fakeStore) as never);
    mod._resetCircuitBreakerForTest();
    mod._resetBucketCounterForTest();
  });

  afterEach(async () => {
    const mod = await import("../lib/fileStore.js");
    mod._setStorageClientForTest(null);
    mod._resetCircuitBreakerForTest();
    mod._resetBucketCounterForTest();
  });

  it("removes an orphan media key that has no .meta.json counterpart", async () => {
    const { runObjectStorageCleanup } = await import("../routes/videoTools.js");

    seedOrphan(fakeStore, "orphan-abc123");

    await runObjectStorageCleanup();

    expect(fakeStore.has("clips/orphan-abc123.mp4")).toBe(false);
  });

  it("removes both the media key and the .meta.json when the clip has expired", async () => {
    const { runObjectStorageCleanup } = await import("../routes/videoTools.js");

    seedExpiredPair(fakeStore, "expired-def456", 1024);

    await runObjectStorageCleanup();

    expect(fakeStore.has("clips/expired-def456.mp4")).toBe(false);
    expect(fakeStore.has("clips/expired-def456.meta.json")).toBe(false);
  });

  it("leaves a live (non-expired) pair completely intact", async () => {
    const { runObjectStorageCleanup } = await import("../routes/videoTools.js");

    seedLivePair(fakeStore, "live-ghi789", 2048);

    await runObjectStorageCleanup();

    expect(fakeStore.has("clips/live-ghi789.mp4")).toBe(true);
    expect(fakeStore.has("clips/live-ghi789.meta.json")).toBe(true);
  });

  it("handles all three cases simultaneously — live pair survives, orphan and expired pair are removed", async () => {
    const { runObjectStorageCleanup } = await import("../routes/videoTools.js");

    // 1. Live pair — should survive
    seedLivePair(fakeStore, "live-clip", 4096);

    // 2. Orphan — should be removed
    seedOrphan(fakeStore, "orphan-media");

    // 3. Expired pair — both should be removed
    seedExpiredPair(fakeStore, "expired-clip", 8192);

    await runObjectStorageCleanup();

    // Live pair untouched
    expect(fakeStore.has("clips/live-clip.mp4")).toBe(true);
    expect(fakeStore.has("clips/live-clip.meta.json")).toBe(true);

    // Orphan gone
    expect(fakeStore.has("clips/orphan-media.mp4")).toBe(false);

    // Expired pair gone
    expect(fakeStore.has("clips/expired-clip.mp4")).toBe(false);
    expect(fakeStore.has("clips/expired-clip.meta.json")).toBe(false);

    // Exactly 2 keys remain (live media + live meta)
    expect(fakeStore.size).toBe(2);
  });

  it("sets the bucket counter to only the size of live clips after the sweep", async () => {
    const { runObjectStorageCleanup } = await import("../routes/videoTools.js");
    const { getBucketBytes } = await import("../lib/fileStore.js");

    const liveSize = 3_000;
    seedLivePair(fakeStore, "live-sized", liveSize);
    seedExpiredPair(fakeStore, "expired-sized", 9_999);
    seedOrphan(fakeStore, "orphan-sized");

    await runObjectStorageCleanup();

    expect(getBucketBytes()).toBe(liveSize);
  });

  it("sets the bucket counter to 0 when no live clips remain after the sweep", async () => {
    const { runObjectStorageCleanup } = await import("../routes/videoTools.js");
    const { getBucketBytes } = await import("../lib/fileStore.js");

    seedExpiredPair(fakeStore, "all-expired", 5_000);
    seedOrphan(fakeStore, "all-orphan");

    await runObjectStorageCleanup();

    expect(getBucketBytes()).toBe(0);
    expect(fakeStore.size).toBe(0);
  });

  it("handles an empty bucket without throwing", async () => {
    const { runObjectStorageCleanup } = await import("../routes/videoTools.js");

    await expect(runObjectStorageCleanup()).resolves.not.toThrow();
  });

  it("leaves a live .meta.json-only entry (no paired media) intact — meta-only is not an orphan", async () => {
    // A .meta.json with no media file is unusual but harmless; the orphan pass
    // only deletes media keys with no meta, not the reverse.
    const { runObjectStorageCleanup } = await import("../routes/videoTools.js");

    const meta = {
      name: "lonely.mp4",
      mimeType: "video/mp4",
      ext: ".mp4",
      expiresMs: Date.now() + 7_200_000,
      sizeBytes: 512,
    };
    fakeStore.set("clips/lonely.meta.json", Buffer.from(JSON.stringify(meta), "utf8"));
    // No corresponding clips/lonely.mp4

    await runObjectStorageCleanup();

    // The lone sidecar must survive
    expect(fakeStore.has("clips/lonely.meta.json")).toBe(true);
  });

  it("is idempotent — running the sweep twice produces the same bucket state", async () => {
    const { runObjectStorageCleanup } = await import("../routes/videoTools.js");

    seedLivePair(fakeStore, "idem-live", 1024);
    seedOrphan(fakeStore, "idem-orphan");
    seedExpiredPair(fakeStore, "idem-expired", 2048);

    await runObjectStorageCleanup();
    const afterFirst = new Set(fakeStore.keys());

    await runObjectStorageCleanup();
    const afterSecond = new Set(fakeStore.keys());

    expect(afterSecond).toEqual(afterFirst);
  });

  // ── Permanent clips (expiresMs === null) ────────────────────────────────────

  it("keeps a permanent pair intact while expired legacy pairs are removed", async () => {
    const { runObjectStorageCleanup } = await import("../routes/videoTools.js");
    const { getBucketBytes } = await import("../lib/fileStore.js");

    seedPermanentPair(fakeStore, "forever-1", 4096);
    seedExpiredPair(fakeStore, "old-ttl", 8192);

    await runObjectStorageCleanup();

    expect(fakeStore.has("clips/forever-1.mp4")).toBe(true);
    expect(fakeStore.has("clips/forever-1.meta.json")).toBe(true);
    expect(fakeStore.has("clips/old-ttl.mp4")).toBe(false);
    expect(fakeStore.has("clips/old-ttl.meta.json")).toBe(false);
    // Counter reflects only what's left: the permanent clip.
    expect(getBucketBytes()).toBe(4096);
  });

  it("keeps permanent pairs across repeated sweeps (they never age out)", async () => {
    const { runObjectStorageCleanup } = await import("../routes/videoTools.js");

    seedPermanentPair(fakeStore, "forever-2", 2048);

    await runObjectStorageCleanup();
    await runObjectStorageCleanup();

    expect(fakeStore.has("clips/forever-2.mp4")).toBe(true);
    expect(fakeStore.has("clips/forever-2.meta.json")).toBe(true);
  });
});
