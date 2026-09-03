/**
 * Integration tests — file download authorization + paid warm-up gating.
 *
 * Clip/tool files used to be public bearer-token URLs; now they require a
 * signed-in session AND ownership:
 *   • new files carry ownerId in their meta sidecar,
 *   • legacy files fall back to the requester's clip history (clip_jobs row
 *     referencing the id — shared/joined jobs mean one id can belong to
 *     several accounts),
 *   • finally the durable job records on this instance (the window between
 *     "job finished" and "history saved").
 *
 * Also: POST /video/warm must never trigger the PAID download-engine start
 * for accounts that can't afford a single clip.
 */
import { describe, it, expect, afterAll, vi } from "vitest";
import request from "supertest";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";

const HAS_DB = !!process.env.DATABASE_URL;

// Keep the paid engine untouched: partial-mock the module BEFORE app import.
vi.mock("../routes/ytDownload", async (importOriginal) => {
  const real = await importOriginal<typeof import("../routes/ytDownload")>();
  return { ...real, resolveZylaSource: vi.fn(async () => null) };
});

const app = (await import("../app")).default;
const { pool } = await import("../lib/db");
const { storeFile, deleteStoredFile } = await import("../lib/fileStore");
const { resolveZylaSource } = await import("../routes/ytDownload");

const TEST_DOMAIN = "fileauth-test.clipai.dev";
const uniq = () => crypto.randomBytes(5).toString("hex");
const email = (tag: string) => `${tag}-${uniq()}@${TEST_DOMAIN}`;
const PASSWORD = "hunter2222!";

const createdFileIds: string[] = [];

async function makeStoredFile(content: string, ownerId?: string): Promise<string> {
  const tmp = path.join(os.tmpdir(), `fileauth-${uniq()}.mp4`);
  fs.writeFileSync(tmp, content);
  const id = await storeFile(tmp, "test.mp4", "video/mp4", ownerId);
  createdFileIds.push(id);
  try { fs.unlinkSync(tmp); } catch { /* ignore */ }
  return id;
}

async function signup(agent: ReturnType<typeof request.agent>, tag: string) {
  const res = await agent
    .post("/api/auth/signup")
    .send({ email: email(tag), password: PASSWORD, name: `File ${tag}` });
  expect(res.status).toBe(200);
  return res.body.user as { id: string; email: string };
}

afterAll(async () => {
  await Promise.allSettled(createdFileIds.map((id) => deleteStoredFile(id)));
  if (pool) {
    await pool.query(`DELETE FROM users WHERE email LIKE $1`, [`%@${TEST_DOMAIN}`]);
    await pool.end();
  }
});

describe.skipIf(!HAS_DB)("file download authorization", () => {
  it("requires login and ownership on GET /video/file/:id (Range kept for owners)", async () => {
    const owner = request.agent(app);
    const ownerUser = await signup(owner, "owner");
    const fileId = await makeStoredFile("RANGE_TEST_0123456789", ownerUser.id);

    // Anonymous → 401
    const anon = await request(app).get(`/api/video/file/${fileId}`);
    expect(anon.status).toBe(401);

    // Malformed id → 404 before touching the store
    const junk = await owner.get(`/api/video/file/${encodeURIComponent("../../etc/passwd")}`);
    expect(junk.status).toBe(404);

    // Owner → 200 full body
    const full = await owner.get(`/api/video/file/${fileId}`).buffer(true);
    expect(full.status).toBe(200);
    expect(full.headers["content-disposition"]).toMatch(/^inline;/);

    // Download button → force a real file download, not a new media tab.
    const download = await owner.get(`/api/video/file/${fileId}?download=1`).buffer(true);
    expect(download.status).toBe(200);
    expect(download.headers["content-disposition"]).toMatch(/^attachment;/);

    // Owner + Range → 206 with the right slice (the <video> seek path)
    const partial = await owner
      .get(`/api/video/file/${fileId}`)
      .set("Range", "bytes=0-3")
      .buffer(true);
    expect(partial.status).toBe(206);
    expect(partial.headers["content-range"]).toMatch(/^bytes 0-3\//);
    expect(partial.headers["content-length"]).toBe("4");

    // A different signed-in account → 403
    const stranger = request.agent(app);
    await signup(stranger, "stranger");
    const forbidden = await stranger.get(`/api/video/file/${fileId}`);
    expect(forbidden.status).toBe(403);

    // Admin → 200
    const admin = request.agent(app);
    const adminUser = await signup(admin, "admin");
    await pool!.query(`UPDATE users SET role = 'admin' WHERE id = $1`, [adminUser.id]);
    const asAdmin = await admin.get(`/api/video/file/${fileId}`).buffer(true);
    expect(asAdmin.status).toBe(200);
  });

  it("legacy files (no ownerId) are reachable through the clip history fallback", async () => {
    const legacyId = await makeStoredFile("LEGACY_FILE_BYTES"); // no ownerId — pre-auth era

    const historian = request.agent(app);
    const historianUser = await signup(historian, "historian");
    await pool!.query(
      `INSERT INTO clip_jobs (user_id, source_url, platform, clip_duration, clip_count, clips)
       VALUES ($1, 'https://example.com/v', 'shorts', 60, 1, $2)`,
      [historianUser.id, JSON.stringify([{ id: legacyId, name: "clip_1.mp4", label: "Clip 1" }])],
    );

    const ok = await historian.get(`/api/video/file/${legacyId}`).buffer(true);
    expect(ok.status).toBe(200);

    const outsider = request.agent(app);
    await signup(outsider, "outsider");
    const nope = await outsider.get(`/api/video/file/${legacyId}`);
    expect(nope.status).toBe(403);
  });

  it("just-finished jobs grant access before any history row exists", async () => {
    const fresh = request.agent(app);
    const freshUser = await signup(fresh, "fresh");
    const clipId = await makeStoredFile("JUST_FINISHED_CLIP"); // no ownerId → forces the job-record path

    // Simulate the durable record the pipeline writes on completion.
    const jobsDir = path.join(os.tmpdir(), `clipai-jobs-test-${process.pid}`);
    fs.mkdirSync(jobsDir, { recursive: true });
    const jobId = crypto.randomBytes(12).toString("hex");
    fs.writeFileSync(
      path.join(jobsDir, `${jobId}.json`),
      JSON.stringify({
        status: "done",
        createdMs: Date.now(),
        updatedMs: Date.now(),
        url: "https://example.com/v",
        platform: "shorts",
        userId: freshUser.id,
        clips: [{ id: clipId, name: "clip_1.mp4", label: "Clip 1", startTime: "0:00", endTime: "0:30", duration: "0:30", size: 1, thumbnailDataUrl: "", thumbnailId: "" }],
      }),
    );

    const ok = await fresh.get(`/api/video/file/${clipId}`).buffer(true);
    expect(ok.status).toBe(200);
  });

  it("ZIP downloads filter to the requester's own clips (403 when none are theirs)", async () => {
    const zipOwner = request.agent(app);
    const zipOwnerUser = await signup(zipOwner, "zipowner");
    const mine = await makeStoredFile("MY_CLIP", zipOwnerUser.id);
    const other = request.agent(app);
    const otherUser = await signup(other, "zipother");
    const notMine = await makeStoredFile("NOT_MY_CLIP", otherUser.id);

    // Anonymous → 401
    const anon = await request(app).get(`/api/video/zip?ids=${mine}`);
    expect(anon.status).toBe(401);

    // check=1 reports only the clips the requester may download
    const check = await zipOwner.get(`/api/video/zip?ids=${mine},${notMine}&check=1`);
    expect(check.status).toBe(200);
    expect(check.body).toEqual({ ok: true, available: 1, requested: 2 });

    // Real ZIP: 200, but the foreign clip is excluded
    const zip = await zipOwner.get(`/api/video/zip?ids=${mine},${notMine}`).buffer(true);
    expect(zip.status).toBe(200);
    expect(zip.headers["x-zip-available"]).toBe("1");
    expect(zip.headers["x-zip-requested"]).toBe("2");

    // Only someone else's clips → 403, not an empty archive
    const foreign = await zipOwner.get(`/api/video/zip?ids=${notMine}`);
    expect(foreign.status).toBe(403);
  });
});

describe.skipIf(!HAS_DB)("paid warm-up gating", () => {
  it("skips the paid engine start when the balance can't afford one clip", async () => {
    const zyla = vi.mocked(resolveZylaSource);
    const funded = request.agent(app);
    await signup(funded, "funded"); // signup trial includes cutting credit

    const yes = await funded
      .post("/api/video/warm")
      .send({ url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", quality: "quality" });
    expect(yes.status).toBe(202);
    expect(yes.body).toEqual({ warming: true });
    expect(zyla).toHaveBeenCalledTimes(1);
    expect(zyla).toHaveBeenLastCalledWith("https://www.youtube.com/watch?v=dQw4w9WgXcQ", 1080);

    const broke = request.agent(app);
    const brokeUser = await signup(broke, "broke");
    await pool!.query(
      `UPDATE users SET
         sub_credits = 0,
         topup_credits = 0,
         subscription_cutting_credits = 0,
         topup_cutting_credits = 0,
         legacy_topup_credits = 0
       WHERE id = $1`,
      [brokeUser.id],
    );

    const no = await broke
      .post("/api/video/warm")
      .send({ url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" });
    expect(no.status).toBe(200);
    expect(no.body).toEqual({ warming: false });
    expect(zyla).toHaveBeenCalledTimes(1); // unchanged — no paid start for broke accounts
  });
});

describe.skipIf(!HAS_DB)("history poisoning defense", () => {
  it("posting someone else's file id into /history grants nothing", async () => {
    const victim = request.agent(app);
    const victimUser = await signup(victim, "victim");
    const secretId = await makeStoredFile("VICTIM_SECRET_BYTES", victimUser.id);

    const attacker = request.agent(app);
    await signup(attacker, "attacker");

    // The save "succeeds" but the foreign id is dropped server-side.
    const save = await attacker.post("/api/history").send({
      sourceUrl: "https://example.com/poison",
      clips: [{ id: secretId, name: "clip_1.mp4", label: "Clip 1" }],
    });
    expect(save.status).toBe(200);

    const hist = await attacker.get("/api/history");
    expect(hist.status).toBe(200);
    const row = (hist.body.jobs as Array<{ id: number; clips: unknown }>).find(
      (j) => j.id === save.body.id,
    );
    expect(row).toBeTruthy();
    expect(row!.clips).toBeNull();

    // And the file itself stays locked to the attacker.
    const steal = await attacker.get(`/api/video/file/${secretId}`);
    expect(steal.status).toBe(403);
    const zipSteal = await attacker.get(`/api/video/zip?ids=${secretId}`);
    expect(zipSteal.status).toBe(403);
  });

  it("keeps clips the user actually owns (meta ownerId path)", async () => {
    const owner = request.agent(app);
    const ownerUser = await signup(owner, "histowner");
    const fileId = await makeStoredFile("OWNED_CLIP_BYTES", ownerUser.id);

    const save = await owner.post("/api/history").send({
      sourceUrl: "https://example.com/mine",
      clips: [{ id: fileId, name: "clip_1.mp4", label: "Clip 1" }],
    });
    expect(save.status).toBe(200);

    const hist = await owner.get("/api/history");
    const row = (hist.body.jobs as Array<{ id: number; clips: Array<{ id: string }> | null }>).find(
      (j) => j.id === save.body.id,
    );
    expect(row?.clips?.map((c) => c.id)).toEqual([fileId]);
  });

  it("job-record-backed clips survive the save and still authorize after the record is gone", async () => {
    const jobUser = request.agent(app);
    const jobUserRec = await signup(jobUser, "jobhist");
    const clipId = await makeStoredFile("JOB_BACKED_CLIP"); // legacy: no ownerId

    const jobsDir = path.join(os.tmpdir(), `clipai-jobs-test-${process.pid}`);
    fs.mkdirSync(jobsDir, { recursive: true });
    const jobFile = path.join(jobsDir, `${crypto.randomBytes(12).toString("hex")}.json`);
    fs.writeFileSync(
      jobFile,
      JSON.stringify({
        status: "done",
        createdMs: Date.now(),
        updatedMs: Date.now(),
        url: "https://example.com/v2",
        platform: "shorts",
        userId: jobUserRec.id,
        clips: [{ id: clipId, name: "clip_1.mp4", label: "Clip 1", startTime: "0:00", endTime: "0:30", duration: "0:30", size: 1, thumbnailDataUrl: "", thumbnailId: "" }],
      }),
    );

    // Save history while the job record exists — the id verifies and is kept.
    const save = await jobUser.post("/api/history").send({
      sourceUrl: "https://example.com/v2",
      clips: [{ id: clipId, name: "clip_1.mp4", label: "Clip 1" }],
    });
    expect(save.status).toBe(200);

    // Job record disappears (restart/expiry) — the history row alone must
    // keep the clip downloadable, exactly like cross-device History does.
    fs.unlinkSync(jobFile);
    const dl = await jobUser.get(`/api/video/file/${clipId}`).buffer(true);
    expect(dl.status).toBe(200);
  });
});
