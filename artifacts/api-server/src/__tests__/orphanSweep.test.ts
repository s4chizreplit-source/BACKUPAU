/**
 * Startup orphan-sweep tests for routes/videoTools.ts.
 *
 * On boot the server marks queued/processing job records as failed — but ONLY
 * the ones this instance owns (wrote itself). Records cached locally from
 * Object Storage belong to OTHER instances whose jobs may still be running:
 * they must never be failed or have an error mirrored to shared storage
 * (that would clobber a legitimate remote processing/done record).
 */

import { describe, it, expect, vi } from "vitest";
import fs from "fs";
import path from "path";
// Isolate this test's JOBS_DIR from other test files sharing /tmp: point
// os.tmpdir() at a unique scratch dir BEFORE videoTools loads. (Computed in
// vi.hoisted so the hoisted os mock factory can safely reference it.)
const TMP = vi.hoisted(() => `/tmp/orphan-sweep-test-${process.pid}-${Date.now()}`);
vi.mock("os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("os")>();
  const tmpdir = () => TMP;
  return { ...actual, tmpdir, default: { ...actual, tmpdir } };
});

// Capture Object Storage mirror uploads.
const uploads: Array<{ key: string; json: string }> = [];
vi.mock("../lib/fileStore", () => ({
  SERVE_DIR: path.join(TMP, "serve"),
  STORAGE_SIZE_CAP_BYTES: 10 * 1024 ** 3,
  getStorageClient: () => ({
    list: async () => ({ ok: false, value: [] }),
    uploadFromText: async (key: string, json: string) => { uploads.push({ key, json }); return { ok: true }; },
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
const MY_ID = "prev-process-owner-0001"; // persisted .owner-id from the "previous process"
const REMOTE_ID = "remote-instance-9999";

function seedJob(id: string, rec: Record<string, unknown>): void {
  fs.writeFileSync(path.join(JOBS_DIR, `${id}.json`), JSON.stringify(rec));
}
function readSeed(id: string): Record<string, unknown> | null {
  const p = path.join(JOBS_DIR, `${id}.json`);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

describe("startup orphan sweep", () => {
  it("fails only jobs owned by this instance; never touches or mirrors cross-instance cache copies", async () => {
    fs.mkdirSync(JOBS_DIR, { recursive: true });
    fs.writeFileSync(path.join(JOBS_DIR, ".owner-id"), MY_ID);

    const now = Date.now();
    // Ours, non-terminal → must be failed and mirrored
    seedJob("ownedproc001", { status: "processing", createdMs: now, updatedMs: now, url: "u", platform: "shorts", owner: MY_ID });
    seedJob("ownedqueue01", { status: "queued", queuePosition: 3, createdMs: now, updatedMs: now, url: "u", platform: "shorts", owner: MY_ID });
    // Ours, terminal → untouched
    seedJob("owneddone001", { status: "done", createdMs: now, updatedMs: now, url: "u", platform: "shorts", owner: MY_ID, clips: [] });
    // Cached copy of ANOTHER instance's live job → must NOT be failed or mirrored
    seedJob("remoteproc01", { status: "processing", createdMs: now, updatedMs: now, url: "u", platform: "shorts", owner: REMOTE_ID });

    // Import triggers the sweep (module-level).
    await import("../routes/videoTools.js");
    await new Promise((r) => setTimeout(r, 300)); // let async mirror uploads settle

    // Owned non-terminal records were failed with the friendly retry message
    for (const id of ["ownedproc001", "ownedqueue01"]) {
      const rec = readSeed(id);
      expect(rec?.status).toBe("error");
      expect(String(rec?.error)).toContain("restarted");
      expect(rec?.owner).toBe(MY_ID); // still stamped with the persisted machine id
    }
    // Owned terminal record untouched
    expect(readSeed("owneddone001")?.status).toBe("done");

    // Remote instance's record: local stale cache dropped, NOT rewritten as error
    expect(readSeed("remoteproc01")).toBeNull();

    // Mirror uploads: errors published only for OWNED jobs, never the remote one
    const errorUploads = uploads.filter((u) => JSON.parse(u.json).status === "error");
    const errorKeys = errorUploads.map((u) => u.key).sort();
    expect(errorKeys).toEqual(["jobs/ownedproc001.json", "jobs/ownedqueue01.json"]);
    expect(uploads.some((u) => u.key === "jobs/remoteproc01.json")).toBe(false);
  });
});
