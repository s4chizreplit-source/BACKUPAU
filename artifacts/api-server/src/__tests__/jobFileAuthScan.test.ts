/**
 * getUserJobFileIds() — the job-record scan that authorizes file downloads
 * and verifies history saves. It caches parsed records per file (done-job
 * records embed base64 thumbnails and can be megabytes), keyed by
 * inode:mtime:size, so correctness of invalidation is security-critical:
 *
 *   1. Only the owning user's clip/thumbnail ids are returned.
 *   2. A rewritten record (atomic temp+rename, like writeJob) is picked up
 *      immediately — new clip ids appear on the very next call.
 *   3. A deleted record's ids disappear (and its cache entry is pruned).
 *   4. Junk records are skipped without breaking the scan.
 *   5. Atomic-write temp files (".<id>.tmp-*") are never scanned.
 */

import { describe, it, expect, vi } from "vitest";
import fs from "fs";
import path from "path";

// Isolate JOBS_DIR from other test files sharing /tmp: point os.tmpdir() at a
// unique scratch dir BEFORE videoTools loads (same pattern as orphanSweep).
const TMP = vi.hoisted(() => `/tmp/job-auth-scan-test-${process.pid}-${Date.now()}`);
vi.mock("os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("os")>();
  const tmpdir = () => TMP;
  return { ...actual, tmpdir, default: { ...actual, tmpdir } };
});

vi.mock("../lib/fileStore", () => ({
  SERVE_DIR: path.join(TMP, "serve"),
  STORAGE_SIZE_CAP_BYTES: 10 * 1024 ** 3,
  getStorageClient: () => ({
    list: async () => ({ ok: false, value: [] }),
    uploadFromText: async () => ({ ok: true }),
    downloadAsText: async () => ({ ok: false }),
    delete: async () => ({ ok: true }),
  }),
  storeFile: vi.fn(async () => "stored-1"),
  resolveFile: vi.fn(async () => null),
  checkStorageHealth: vi.fn(async () => ({ ok: true })),
  getStorageCircuitState: vi.fn(() => "CLOSED"),
  setBucketBytes: vi.fn(),
  initBucketCounter: vi.fn(async () => undefined),
  probeStorageIfOpen: vi.fn(async () => undefined),
}));
vi.mock("../lib/cookieStore", () => ({
  getCookieArgs: () => [],
  reportCookieBotBlock: () => {},
  reportCookieSuccess: () => {},
}));
vi.mock("../lib/ssrfGuard", () => ({ isSafePublicUrl: (u: string) => u.startsWith("http") }));

const JOBS_DIR = path.join(TMP, `clipai-jobs-test-${process.pid}`);

/** Write a job record the way production does: temp file + atomic rename. */
function seedJobAtomic(id: string, rec: Record<string, unknown>): void {
  const tmp = path.join(JOBS_DIR, `.${id}.tmp-seed-${Math.random().toString(36).slice(2)}`);
  fs.writeFileSync(tmp, JSON.stringify(rec));
  fs.renameSync(tmp, path.join(JOBS_DIR, `${id}.json`));
}

const doneRec = (
  userId: string,
  clips: Array<{ id: string; thumbnailId?: string }>,
): Record<string, unknown> => ({
  status: "done",
  userId,
  createdMs: Date.now(),
  updatedMs: Date.now(),
  url: "http://example.com/v",
  platform: "shorts",
  clips,
});

describe("getUserJobFileIds parse cache", () => {
  it("returns only the owner's ids, tracks atomic rewrites and deletions, skips junk and temp files", async () => {
    fs.mkdirSync(JOBS_DIR, { recursive: true });

    seedJobAtomic("jobalice0001", doneRec("user-alice", [
      { id: "clip-a1", thumbnailId: "thumb-a1" },
      { id: "clip-a2" },
    ]));
    seedJobAtomic("jobbob000001", doneRec("user-bob", [{ id: "clip-b1", thumbnailId: "thumb-b1" }]));
    // Junk record + a stray atomic-write temp file — both must be ignored.
    fs.writeFileSync(path.join(JOBS_DIR, "junkrecord01.json"), "{not json");
    fs.writeFileSync(
      path.join(JOBS_DIR, ".jobalice0001.tmp-99-7"),
      JSON.stringify(doneRec("user-alice", [{ id: "clip-tmp-should-not-appear" }])),
    );

    const { getUserJobFileIds } = await import("../routes/videoTools.js");

    // 1. Ownership isolation (repeat once to exercise the cached path too).
    for (let pass = 0; pass < 2; pass++) {
      const alice = await getUserJobFileIds("user-alice");
      expect(alice).toEqual(new Set(["clip-a1", "thumb-a1", "clip-a2"]));
      expect(alice.has("clip-b1")).toBe(false);
      expect(alice.has("clip-tmp-should-not-appear")).toBe(false);
      const bob = await getUserJobFileIds("user-bob");
      expect(bob).toEqual(new Set(["clip-b1", "thumb-b1"]));
    }

    // 2. Atomic rewrite adds a clip — visible on the immediately-next call.
    seedJobAtomic("jobalice0001", doneRec("user-alice", [
      { id: "clip-a1", thumbnailId: "thumb-a1" },
      { id: "clip-a2" },
      { id: "clip-a3", thumbnailId: "thumb-a3" },
    ]));
    const afterRewrite = await getUserJobFileIds("user-alice");
    expect(afterRewrite.has("clip-a3")).toBe(true);
    expect(afterRewrite.has("thumb-a3")).toBe(true);

    // 3. Deleting the record revokes its ids on the next call.
    fs.unlinkSync(path.join(JOBS_DIR, "jobalice0001.json"));
    const afterDelete = await getUserJobFileIds("user-alice");
    expect(afterDelete.size).toBe(0);
    // Bob is unaffected throughout.
    expect(await getUserJobFileIds("user-bob")).toEqual(new Set(["clip-b1", "thumb-b1"]));
  });
});
