/**
 * Durable mirror cache (lib/zylaCache.ts) — round-trip, upsert, expiry and
 * delete against the real dev database (same pattern as authBilling tests).
 * The cache must NEVER throw: with no DB it degrades to null/no-op.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { pool } from "../lib/db";
import { ensureSchema } from "../lib/schema";
import { getCachedMirror, putCachedMirror, deleteCachedMirror } from "../lib/zylaCache";

const VID_A = "zylatest-vid-a";
const VID_B = "zylatest-vid-b";
const VID_C = "zylatest-vid-c";

const maybe = pool ? describe : describe.skip;

maybe("zylaCache (durable mirror cache)", () => {
  beforeAll(async () => {
    await ensureSchema(pool!);
    await pool!.query(`DELETE FROM zyla_cache WHERE video_id LIKE 'zylatest-%'`);
  });

  afterAll(async () => {
    await pool!.query(`DELETE FROM zyla_cache WHERE video_id LIKE 'zylatest-%'`);
  });

  it("round-trips a mirror with title", async () => {
    const exp = Date.now() + 60_000;
    await putCachedMirror(VID_A, "1080", "https://mirror.example/a.mp4", "Song A", exp);
    const hit = await getCachedMirror(VID_A, "1080");
    expect(hit).not.toBeNull();
    expect(hit!.downloadUrl).toBe("https://mirror.example/a.mp4");
    expect(hit!.title).toBe("Song A");
    // TIMESTAMPTZ round-trip loses sub-millisecond precision only
    expect(Math.abs(hit!.expiresAtMs - exp)).toBeLessThan(1_500);
  });

  it("misses on a different format of the same video", async () => {
    expect(await getCachedMirror(VID_A, "720")).toBeNull();
  });

  it("upserts: second write replaces url/title/expiry", async () => {
    await putCachedMirror(VID_A, "1080", "https://mirror.example/a2.mp4", undefined, Date.now() + 120_000);
    const hit = await getCachedMirror(VID_A, "1080");
    expect(hit!.downloadUrl).toBe("https://mirror.example/a2.mp4");
    expect(hit!.title).toBeUndefined();
  });

  it("expired entries are invisible", async () => {
    await putCachedMirror(VID_B, "1080", "https://mirror.example/b.mp4", "Song B", Date.now() - 1_000);
    expect(await getCachedMirror(VID_B, "1080")).toBeNull();
  });

  it("delete removes the entry", async () => {
    await putCachedMirror(VID_C, "1080", "https://mirror.example/c.mp4", undefined, Date.now() + 60_000);
    expect(await getCachedMirror(VID_C, "1080")).not.toBeNull();
    await deleteCachedMirror(VID_C, "1080");
    expect(await getCachedMirror(VID_C, "1080")).toBeNull();
  });

  it("conditional delete never clobbers a fresh row (stale-delete race guard)", async () => {
    await putCachedMirror(VID_C, "720", "https://mirror.example/old.mp4", undefined, Date.now() + 60_000);
    // Another instance finishes a NEW conversion and overwrites the row…
    await putCachedMirror(VID_C, "720", "https://mirror.example/new.mp4", undefined, Date.now() + 60_000);
    // …then a delayed delete conditioned on the dead OLD url must be a no-op.
    await deleteCachedMirror(VID_C, "720", "https://mirror.example/old.mp4");
    expect((await getCachedMirror(VID_C, "720"))?.downloadUrl).toBe("https://mirror.example/new.mp4");
    // Matching URL still deletes.
    await deleteCachedMirror(VID_C, "720", "https://mirror.example/new.mp4");
    expect(await getCachedMirror(VID_C, "720")).toBeNull();
  });
});
