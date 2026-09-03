/**
 * Unit tests for the two-pass local disk cleanup that runs inside the periodic
 * cleanup interval in videoTools.ts.
 *
 * The tests seed a temporary directory with three kinds of entries:
 *   1. A live pair  — media file + non-expired .meta.json   → must survive
 *   2. An orphan    — media file with NO .meta.json sidecar  → must be removed
 *   3. An expired pair — media file + expired .meta.json     → both must be removed
 *
 * runLocalDiskCleanup() is exported from videoTools.ts so it can be called
 * directly here without triggering the setInterval timer.
 */

import path from "path";
import os from "os";
import fs from "fs";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

// Import the exported cleanup function
import { runLocalDiskCleanup } from "../routes/videoTools.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Write a media file stub and return its basename. */
function writeMedia(dir: string, name: string): string {
  fs.writeFileSync(path.join(dir, name), "fake-media-bytes", "utf8");
  return name;
}

/** Write a .meta.json sidecar with the given expiresMs (null = permanent) and return its basename. */
function writeMeta(dir: string, base: string, ext: string, expiresMs: number | null): string {
  const metaName = `${base}.meta.json`;
  const meta = {
    name: `${base}${ext}`,
    mimeType: "video/mp4",
    ext,
    expiresMs,
  };
  fs.writeFileSync(path.join(dir, metaName), JSON.stringify(meta), "utf8");
  return metaName;
}

/** Return all filenames currently in dir. */
function listDir(dir: string): string[] {
  return fs.readdirSync(dir).sort();
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("runLocalDiskCleanup — two-pass local disk cleanup", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cleanup-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("removes an orphan media file that has no paired .meta.json sidecar", () => {
    // Seed: orphan only
    writeMedia(tmpDir, "orphan-abc123.mp4");

    runLocalDiskCleanup(tmpDir);

    expect(fs.existsSync(path.join(tmpDir, "orphan-abc123.mp4"))).toBe(false);
  });

  it("removes both the media file and the sidecar when the clip has expired", () => {
    // Seed: expired pair
    const base = "expired-def456";
    const ext = ".mp4";
    writeMedia(tmpDir, `${base}${ext}`);
    writeMeta(tmpDir, base, ext, Date.now() - 1_000); // expired 1 s ago

    runLocalDiskCleanup(tmpDir);

    expect(fs.existsSync(path.join(tmpDir, `${base}${ext}`))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, `${base}.meta.json`))).toBe(false);
  });

  it("leaves a live (non-expired) paired clip completely intact", () => {
    // Seed: live pair
    const base = "live-ghi789";
    const ext = ".mp4";
    writeMedia(tmpDir, `${base}${ext}`);
    writeMeta(tmpDir, base, ext, Date.now() + 7_200_000); // expires in 2 h

    runLocalDiskCleanup(tmpDir);

    expect(fs.existsSync(path.join(tmpDir, `${base}${ext}`))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, `${base}.meta.json`))).toBe(true);
  });

  it("handles all three cases simultaneously — live pair survives, orphan and expired pair are removed", () => {
    const now = Date.now();

    // 1. Live pair — should survive
    writeMedia(tmpDir, "live-clip.mp4");
    writeMeta(tmpDir, "live-clip", ".mp4", now + 7_200_000);

    // 2. Orphan — should be removed
    writeMedia(tmpDir, "orphan-media.mp4");

    // 3. Expired pair — both files should be removed
    writeMedia(tmpDir, "expired-clip.mp4");
    writeMeta(tmpDir, "expired-clip", ".mp4", now - 5_000);

    runLocalDiskCleanup(tmpDir);

    const remaining = listDir(tmpDir);

    // Live pair untouched
    expect(remaining).toContain("live-clip.mp4");
    expect(remaining).toContain("live-clip.meta.json");

    // Orphan gone
    expect(remaining).not.toContain("orphan-media.mp4");

    // Expired pair gone
    expect(remaining).not.toContain("expired-clip.mp4");
    expect(remaining).not.toContain("expired-clip.meta.json");

    // Exactly 2 files remain
    expect(remaining).toHaveLength(2);
  });

  it("is idempotent — running cleanup twice on the same directory produces the same result", () => {
    const now = Date.now();

    writeMedia(tmpDir, "live-again.mp4");
    writeMeta(tmpDir, "live-again", ".mp4", now + 7_200_000);
    writeMedia(tmpDir, "orphan-again.mp4");

    runLocalDiskCleanup(tmpDir);
    const afterFirst = listDir(tmpDir);

    runLocalDiskCleanup(tmpDir);
    const afterSecond = listDir(tmpDir);

    expect(afterSecond).toEqual(afterFirst);
  });

  it("does not touch a .meta.json file that has no paired media file (sidecar-only edge case)", () => {
    // Orphan sidecar (no media) — the cleanup only deletes media orphans and
    // expired pairs; a lonely sidecar is left for the TTL pass to handle once
    // it expires.
    const now = Date.now();
    writeMeta(tmpDir, "lonely-meta", ".mp4", now + 7_200_000);

    runLocalDiskCleanup(tmpDir);

    expect(fs.existsSync(path.join(tmpDir, "lonely-meta.meta.json"))).toBe(true);
  });

  it("removes an expired .meta.json-only entry (no paired media) during the TTL pass", () => {
    // If the media file was already deleted but the sidecar is expired, the
    // sidecar itself should be removed by Pass 1.
    writeMeta(tmpDir, "stale-only", ".mp4", Date.now() - 500);
    // No media file — this is fine; the unlink for the media just silently fails.

    runLocalDiskCleanup(tmpDir);

    expect(fs.existsSync(path.join(tmpDir, "stale-only.meta.json"))).toBe(false);
  });

  it("handles an empty directory without throwing", () => {
    expect(() => runLocalDiskCleanup(tmpDir)).not.toThrow();
  });

  it("handles a malformed .meta.json without crashing or touching other files", () => {
    // Write a broken sidecar
    fs.writeFileSync(path.join(tmpDir, "broken.meta.json"), "not-valid-json", "utf8");

    // Write a valid live pair
    const base = "healthy";
    writeMedia(tmpDir, `${base}.mp4`);
    writeMeta(tmpDir, base, ".mp4", Date.now() + 7_200_000);

    expect(() => runLocalDiskCleanup(tmpDir)).not.toThrow();

    // Healthy pair must still be present
    expect(fs.existsSync(path.join(tmpDir, `${base}.mp4`))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, `${base}.meta.json`))).toBe(true);
  });

  // ── Permanent clips (expiresMs === null) ────────────────────────────────────
  // The bucket copy lives forever; the LOCAL copy is only a serve cache and is
  // evicted by file age so small prod disks don't fill up.

  it("keeps a permanent clip whose local cache copy is still fresh", () => {
    writeMedia(tmpDir, "forever-fresh.mp4");
    writeMeta(tmpDir, "forever-fresh", ".mp4", null);

    runLocalDiskCleanup(tmpDir);

    expect(fs.existsSync(path.join(tmpDir, "forever-fresh.mp4"))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, "forever-fresh.meta.json"))).toBe(true);
  });

  it("evicts a permanent clip's STALE local cache copy (bucket copy stays authoritative)", () => {
    writeMedia(tmpDir, "forever-stale.mp4");
    writeMeta(tmpDir, "forever-stale", ".mp4", null);
    // Age both files past the 2h local-cache window.
    const old = new Date(Date.now() - 3 * 60 * 60 * 1000);
    fs.utimesSync(path.join(tmpDir, "forever-stale.mp4"), old, old);
    fs.utimesSync(path.join(tmpDir, "forever-stale.meta.json"), old, old);

    runLocalDiskCleanup(tmpDir);

    expect(fs.existsSync(path.join(tmpDir, "forever-stale.mp4"))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, "forever-stale.meta.json"))).toBe(false);
  });

  it("evicts a stale permanent sidecar that lost its media file (falls back to meta mtime)", () => {
    writeMeta(tmpDir, "forever-lonely", ".mp4", null);
    const old = new Date(Date.now() - 3 * 60 * 60 * 1000);
    fs.utimesSync(path.join(tmpDir, "forever-lonely.meta.json"), old, old);

    runLocalDiskCleanup(tmpDir);

    expect(fs.existsSync(path.join(tmpDir, "forever-lonely.meta.json"))).toBe(false);
  });
});
