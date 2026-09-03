/**
 * Integration tests — POST /social/campaigns/:id/retry-clip ("Try clips again").
 *
 * A failed video-link campaign can be pointed at a FRESH clip job: the UI
 * starts the job (same request as create) and hands the jobId to this route,
 * which flips the campaign back to 'clipping' so the normal settle/ingest
 * machinery feeds it. These tests run against the real dev database through
 * the full express app (like authBilling.test.ts) and are skipped when
 * DATABASE_URL is not configured.
 *
 * Covered:
 *   - ownership: a stranger can't retry someone else's campaign (404), and a
 *     job owned by someone else can't be attached (400)
 *   - state guards: folder campaigns 400, non-failed clip states 409,
 *     malformed job ids 400, already-settled jobs 400, and a fresh job whose
 *     clip count doesn't match the campaign's stored count 400
 *   - happy path: clip_job_id swaps, clip_status='clipping', last_error clears
 *     — and an immediate second retry 409s (no longer failed)
 *   - GET list returns clip_params so the UI can replay the exact settings
 */
import { describe, it, expect, afterAll } from "vitest";
import request from "supertest";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";

const HAS_DB = !!process.env.DATABASE_URL;

const app = (await import("../app")).default;
const { pool } = await import("../lib/db");

const TEST_DOMAIN = "retry-it.clipai.dev";
const uniq = () => crypto.randomBytes(5).toString("hex");
const email = (tag: string) => `${tag}-${uniq()}@${TEST_DOMAIN}`;
const newJobId = () => crypto.randomBytes(12).toString("hex");

// Same per-worker jobs dir the server uses under vitest (see videoTools.ts:
// JOBS_DIR = os.tmpdir()/clipai-jobs-test-<pid> when VITEST is set).
const JOBS_DIR = path.join(os.tmpdir(), `clipai-jobs-test-${process.pid}`);
const seededJobs: string[] = [];
function seedJob(id: string, rec: Record<string, unknown>): void {
  fs.mkdirSync(JOBS_DIR, { recursive: true });
  const p = path.join(JOBS_DIR, `${id}.json`);
  fs.writeFileSync(p, JSON.stringify(rec));
  seededJobs.push(p);
}
function processingJob(userId: string): Record<string, unknown> {
  return {
    status: "processing",
    userId,
    url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    platform: "shorts",
    forCampaign: true,
    createdMs: Date.now(),
    updatedMs: Date.now(),
  };
}

async function insertCampaign(
  userId: string,
  over: {
    source_kind?: string; clip_status?: string | null; clip_job_id?: string | null;
    clip_params?: string | null; end_date?: string;
  } = {},
): Promise<string> {
  const id = crypto.randomUUID();
  await pool!.query(
    `INSERT INTO social_campaigns
       (id, user_id, name, source_url, account_ids, times, per_slot,
        start_date, end_date, timezone, caption, ai_captions,
        source_kind, clip_job_id, clip_status, clip_params, last_error, enabled, status)
     VALUES ($1,$2,'Retry IT','https://www.youtube.com/watch?v=dQw4w9WgXcQ','{acc1}','{16:00}',1,
             '2026-08-10',$7,'UTC','',FALSE,$3,$4,$5,$6,'YouTube is limiting this video to 360p (test)',TRUE,'active')`,
    [
      id, userId,
      over.source_kind ?? "clip_link",
      over.clip_job_id === undefined ? newJobId() : over.clip_job_id,
      over.clip_status === undefined ? "failed" : over.clip_status,
      over.clip_params ?? null,
      over.end_date ?? "2099-12-31",
    ],
  );
  return id;
}

afterAll(async () => {
  for (const p of seededJobs) { try { fs.unlinkSync(p); } catch { /* gone */ } }
  if (pool) {
    await pool.query(`DELETE FROM users WHERE email LIKE $1`, [`%@${TEST_DOMAIN}`]);
    await pool.end();
  }
});

describe.skipIf(!HAS_DB)("POST /social/campaigns/:id/retry-clip", () => {
  const owner = request.agent(app);
  const stranger = request.agent(app);
  let ownerId = "";
  let strangerId = "";

  it("setup: two accounts", async () => {
    const a = await owner.post("/api/auth/signup").send({ email: email("owner"), password: "hunter2222!" });
    expect(a.status).toBe(200);
    ownerId = a.body.user.id;
    const b = await stranger.post("/api/auth/signup").send({ email: email("stranger"), password: "hunter2222!" });
    expect(b.status).toBe(200);
    strangerId = b.body.user.id;
  });

  it("404s for a campaign you don't own (and for guests, 401)", async () => {
    const cid = await insertCampaign(ownerId);
    const r = await stranger.post(`/api/social/campaigns/${cid}/retry-clip`).send({ jobId: newJobId() });
    expect(r.status).toBe(404);
    const guest = await request(app).post(`/api/social/campaigns/${cid}/retry-clip`).send({ jobId: newJobId() });
    expect(guest.status).toBe(401);
  });

  it("400s for folder campaigns — nothing to retry", async () => {
    const cid = await insertCampaign(ownerId, { source_kind: "folder", clip_status: null, clip_job_id: null });
    const r = await owner.post(`/api/social/campaigns/${cid}/retry-clip`).send({ jobId: newJobId() });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/video-link/i);
  });

  it("409s when clips are not in a failed state", async () => {
    const cid = await insertCampaign(ownerId, { clip_status: "clipping" });
    const r = await owner.post(`/api/social/campaigns/${cid}/retry-clip`).send({ jobId: newJobId() });
    expect(r.status).toBe(409);
  });

  it("400s when the campaign's date range is already over — a new job could never post", async () => {
    const cid = await insertCampaign(ownerId, { end_date: "2020-01-01" });
    const r = await owner.post(`/api/social/campaigns/${cid}/retry-clip`).send({ jobId: newJobId() });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/dates are over/i);
  });

  it("400s on a malformed job id", async () => {
    const cid = await insertCampaign(ownerId);
    const r = await owner.post(`/api/social/campaigns/${cid}/retry-clip`).send({ jobId: "not-a-job" });
    expect(r.status).toBe(400);
  });

  it("400s when the new job belongs to someone else — foreign clips can never feed your campaign", async () => {
    const cid = await insertCampaign(ownerId);
    const foreignJob = newJobId();
    seedJob(foreignJob, processingJob(strangerId));
    const r = await owner.post(`/api/social/campaigns/${cid}/retry-clip`).send({ jobId: foreignJob });
    expect(r.status).toBe(400);
  });

  it("400s when the new job already settled as failed/cancelled", async () => {
    const cid = await insertCampaign(ownerId);
    const dead = newJobId();
    seedJob(dead, { ...processingJob(ownerId), status: "error", error: "boom" });
    const r = await owner.post(`/api/social/campaigns/${cid}/retry-clip`).send({ jobId: dead });
    expect(r.status).toBe(400);
  });

  it("400s when the fresh job's clip count doesn't match the campaign's — strict pairing survives retries", async () => {
    const cid = await insertCampaign(ownerId, { clip_params: JSON.stringify({ clipCount: 2, quality: "fast" }) });
    const wrong = newJobId();
    seedJob(wrong, { ...processingJob(ownerId), clipCount: 5 });
    const r = await owner.post(`/api/social/campaigns/${cid}/retry-clip`).send({ jobId: wrong });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/exactly 2/i);

    // A job cutting the right number of clips attaches fine.
    const right = newJobId();
    seedJob(right, { ...processingJob(ownerId), clipCount: 2 });
    const ok = await owner.post(`/api/social/campaigns/${cid}/retry-clip`).send({ jobId: right });
    expect(ok.status).toBe(200);
    expect(ok.body.ok).toBe(true);
  });

  it("happy path: swaps the job, flips back to clipping, clears the error — then a second retry 409s", async () => {
    const oldJob = newJobId();
    const cid = await insertCampaign(ownerId, { clip_job_id: oldJob });
    const fresh = newJobId();
    seedJob(fresh, processingJob(ownerId));

    const r = await owner.post(`/api/social/campaigns/${cid}/retry-clip`).send({ jobId: fresh });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);

    const { rows } = await pool!.query(
      `SELECT clip_job_id, clip_status, last_error, status FROM social_campaigns WHERE id = $1`, [cid],
    );
    expect(rows[0]).toEqual({ clip_job_id: fresh, clip_status: "clipping", last_error: null, status: "active" });

    const again = await owner.post(`/api/social/campaigns/${cid}/retry-clip`).send({ jobId: newJobId() });
    expect(again.status).toBe(409);
  });

  it("GET list returns clipParams so the UI can replay the exact settings", async () => {
    await insertCampaign(ownerId, { clip_params: JSON.stringify({ clipCount: 8, quality: "fast" }) });
    const r = await owner.get("/api/social/campaigns");
    expect(r.status).toBe(200);
    const withParams = (r.body.campaigns as { clipParams?: { clipCount?: number; quality?: string } | null }[])
      .find((c) => c.clipParams?.clipCount === 8);
    expect(withParams?.clipParams).toEqual({ clipCount: 8, quality: "fast" });
  });
});
