/**
 * Device-upload integration tests — init → chunk → finish → clip.
 *
 * Runs against the full express app with the real dev database (skipped when
 * DATABASE_URL is missing, same as authBilling). A real 30s MP4 is generated
 * with ffmpeg so the finish-step ffprobe validation and the end-to-end clip
 * job exercise the true pipeline. Upload sources never touch the paid Zyla
 * engine — the job materializes the uploaded file directly.
 *
 * A separate describe (no DB needed) proves the autoscale handoff story:
 * chunks + meta mirrored to (fake) Object Storage let a *fresh instance* —
 * simulated by wiping all local upload state — recover and materialize the
 * exact original bytes.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { execFile } from "child_process";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";

const HAS_DB = !!process.env.DATABASE_URL;

const app = (await import("../app")).default;
const { pool } = await import("../lib/db");
const up = await import("../lib/uploadStore");
const fileStore = await import("../lib/fileStore");

const TEST_DOMAIN = "up-test.clipai.dev";
const uniq = () => crypto.randomBytes(5).toString("hex");
const email = (tag: string) => `${tag}-${uniq()}@${TEST_DOMAIN}`;
const PASSWORD = "hunter2222!";

const VIDEO_PATH = path.join(os.tmpdir(), `upload-test-${process.pid}.mp4`);
let videoBuf = Buffer.alloc(0);
const createdUploadIds: string[] = [];

/** Generate a 30s test video (~11-12MB so the happy path spans 2+ chunks). */
function generateVideo(): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      "ffmpeg",
      [
        "-y",
        "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30",
        "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100",
        "-t", "30",
        "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
        "-b:v", "3M", "-minrate", "3M", "-maxrate", "3M", "-bufsize", "6M",
        "-c:a", "aac", "-shortest",
        VIDEO_PATH,
      ],
      { timeout: 55_000 },
      err => (err ? reject(err) : resolve()),
    );
  });
}

async function sendAllChunks(agent: ReturnType<typeof request.agent>, uploadId: string, buf: Buffer): Promise<void> {
  for (let i = 0, off = 0; off < buf.length; i++, off += up.UPLOAD_CHUNK_BYTES) {
    const part = buf.subarray(off, Math.min(off + up.UPLOAD_CHUNK_BYTES, buf.length));
    const r = await agent
      .post(`/api/video/upload/chunk?id=${uploadId}&index=${i}`)
      .set("Content-Type", "application/octet-stream")
      .send(part);
    expect(r.status, `chunk ${i}: ${JSON.stringify(r.body)}`).toBe(200);
    expect(r.body.next).toBe(i + 1);
  }
}

beforeAll(async () => {
  await generateVideo();
  videoBuf = fs.readFileSync(VIDEO_PATH);
  // The happy path must exercise the multi-chunk path.
  expect(videoBuf.length).toBeGreaterThan(up.UPLOAD_CHUNK_BYTES);
}, 60_000);

afterAll(async () => {
  fs.rmSync(VIDEO_PATH, { force: true });
  // Best-effort: remove any mirrored objects the tests created.
  try {
    const client = fileStore.getStorageClient();
    for (const id of createdUploadIds) {
      const l = await client.list({ prefix: `uploads/${id}/` });
      if (l.ok) for (const o of l.value) await client.delete(o.name);
    }
  } catch { /* storage unavailable here — nothing was mirrored */ }
  if (pool) {
    await pool.query(`DELETE FROM users WHERE email LIKE $1`, [`%@${TEST_DOMAIN}`]);
    await pool.end();
  }
});

describe.skipIf(!HAS_DB)("device upload API", () => {
  const agentA = request.agent(app);
  const agentB = request.agent(app);
  let uploadUrl = ""; // ready upload of user A (upload://…)
  let unfinishedUrl = ""; // inited-but-never-finished upload of user A

  beforeAll(async () => {
    const a = await agentA.post("/api/auth/signup").send({ email: email("a"), password: PASSWORD, name: "Uploader A" });
    expect(a.status).toBe(200);
    const b = await agentB.post("/api/auth/signup").send({ email: email("b"), password: PASSWORD, name: "Uploader B" });
    expect(b.status).toBe(200);
  });

  it("rejects guests, bad extensions and oversized files at init", async () => {
    const guest = await request(app)
      .post("/api/video/upload/init")
      .send({ name: "a.mp4", size: 1000, mime: "video/mp4" });
    expect(guest.status).toBe(401);

    const badExt = await agentA
      .post("/api/video/upload/init")
      .send({ name: "notes.txt", size: 1000, mime: "text/plain" });
    expect(badExt.status).toBe(415);

    const tooBig = await agentA
      .post("/api/video/upload/init")
      .send({ name: "huge.mp4", size: up.UPLOAD_MAX_BYTES + 1, mime: "video/mp4" });
    expect(tooBig.status).toBe(413);
  });

  it("uploads a real video in sequential chunks and finishes with probed duration", async () => {
    const init = await agentA
      .post("/api/video/upload/init")
      .send({ name: "My Test Video.mp4", size: videoBuf.length, mime: "video/mp4" });
    expect(init.status, JSON.stringify(init.body)).toBe(200);
    expect(init.body.chunkBytes).toBe(up.UPLOAD_CHUNK_BYTES);
    createdUploadIds.push(init.body.uploadId);

    await sendAllChunks(agentA, init.body.uploadId, videoBuf);

    const fin = await agentA.post(`/api/video/upload/finish?id=${init.body.uploadId}`).send({});
    expect(fin.status, JSON.stringify(fin.body)).toBe(200);
    expect(fin.body.url).toMatch(/^upload:\/\//);
    expect(fin.body.name).toBe("My Test Video.mp4");
    expect(fin.body.durationSec).toBeGreaterThanOrEqual(28);
    uploadUrl = fin.body.url;
  }, 90_000);

  it("clips the uploaded video end-to-end (async job, no external downloads)", async () => {
    const kick = await agentA.post("/api/video/clip").send({
      url: uploadUrl,
      clipCount: 1,
      clipDuration: 15,
      platform: "shorts",
      quality: "fast",
      async: true,
    });
    expect(kick.status, JSON.stringify(kick.body)).toBe(202);
    const jobId = kick.body.jobId as string;
    expect(jobId).toBeTruthy();

    const deadline = Date.now() + 110_000;
    let last: Record<string, unknown> = {};
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 2000));
      const poll = await agentA.get(`/api/video/job/${jobId}`);
      expect(poll.status).toBe(200);
      last = poll.body;
      if (last.status === "done" || last.status === "error") break;
    }
    expect(last.status, JSON.stringify(last)).toBe("done");
    const clips = last.clips as Array<{ id?: string; name?: string; duration?: string }>;
    expect(clips?.length).toBe(1);
    expect(clips[0].id).toBeTruthy();
    expect(clips[0].name).toBe("clip_1.mp4");

    // The produced clip must actually be downloadable.
    const file = await agentA.get(`/api/video/file/${clips[0].id}`);
    expect([200, 206]).toContain(file.status);
  }, 120_000);

  it("blocks other accounts and guests from clipping someone else's upload", async () => {
    const foreign = await agentB.post("/api/video/clip").send({ url: uploadUrl, clipCount: 1, async: true });
    expect(foreign.status).toBe(403);

    const guest = await request(app).post("/api/video/clip").send({ url: uploadUrl, clipCount: 1, async: true });
    expect(guest.status).toBe(401);
  });

  it("responds 410 for vanished uploads and 409 for unfinished ones", async () => {
    const gone = await agentA
      .post("/api/video/clip")
      .send({ url: "upload://deadbeef00deadbeef/ghost.mp4", clipCount: 1, async: true });
    expect(gone.status).toBe(410);

    const init = await agentA
      .post("/api/video/upload/init")
      .send({ name: "partial.mp4", size: videoBuf.length, mime: "video/mp4" });
    expect(init.status).toBe(200);
    createdUploadIds.push(init.body.uploadId);
    unfinishedUrl = `upload://${init.body.uploadId}/partial.mp4`;

    const notReady = await agentA.post("/api/video/clip").send({ url: unfinishedUrl, clipCount: 1, async: true });
    expect(notReady.status).toBe(409);
  });

  it("rejects out-of-order chunks with 409 and the expected part number", async () => {
    const init = await agentA
      .post("/api/video/upload/init")
      .send({ name: "ooo.mp4", size: videoBuf.length, mime: "video/mp4" });
    expect(init.status).toBe(200);
    createdUploadIds.push(init.body.uploadId);

    const r = await agentA
      .post(`/api/video/upload/chunk?id=${init.body.uploadId}&index=1`)
      .set("Content-Type", "application/octet-stream")
      .send(videoBuf.subarray(0, 1024));
    expect(r.status).toBe(409);
    expect(String(r.body.error)).toMatch(/part 0/);
  });

  it("rejects a finish when received bytes don't match the declared size", async () => {
    const init = await agentA
      .post("/api/video/upload/init")
      .send({ name: "short.mp4", size: videoBuf.length + 4096, mime: "video/mp4" });
    expect(init.status).toBe(200);
    createdUploadIds.push(init.body.uploadId);

    await sendAllChunks(agentA, init.body.uploadId, videoBuf); // 4096 bytes short

    const fin = await agentA.post(`/api/video/upload/finish?id=${init.body.uploadId}`).send({});
    expect(fin.status).toBe(400);
  }, 90_000);

  it("keeps uploads private: another user cannot add chunks or finish", async () => {
    const init = await agentB
      .post("/api/video/upload/init")
      .send({ name: "b-own.mp4", size: videoBuf.length, mime: "video/mp4" });
    expect(init.status).toBe(200);
    createdUploadIds.push(init.body.uploadId);

    const foreignChunk = await agentA
      .post(`/api/video/upload/chunk?id=${init.body.uploadId}&index=0`)
      .set("Content-Type", "application/octet-stream")
      .send(videoBuf.subarray(0, 1024));
    expect(foreignChunk.status).toBe(403);

    const foreignFinish = await agentA.post(`/api/video/upload/finish?id=${init.body.uploadId}`).send({});
    expect(foreignFinish.status).toBe(403);
  });

  it("rejects a single chunk beyond the per-request cap upfront", async () => {
    const init = await agentB
      .post("/api/video/upload/init")
      .send({ name: "big-chunk.mp4", size: up.UPLOAD_MAX_BYTES - 1, mime: "video/mp4" });
    expect(init.status).toBe(200);
    createdUploadIds.push(init.body.uploadId);

    const r = await agentB
      .post(`/api/video/upload/chunk?id=${init.body.uploadId}&index=0`)
      .set("Content-Type", "application/octet-stream")
      .send(Buffer.alloc(up.UPLOAD_CHUNK_MAX_BYTES + 1024));
    expect(r.status).toBe(413);
  }, 60_000);
});

// ── Autoscale handoff: a fresh instance recovers everything from the mirror ──

type FakeStore = Map<string, Buffer>;

function makeFakeStorage(store: FakeStore) {
  return {
    uploadFromFilename: async (key: string, filename: string) => {
      store.set(key, fs.readFileSync(filename));
      return { ok: true as const };
    },
    uploadFromText: async (key: string, text: string) => {
      store.set(key, Buffer.from(text, "utf8"));
      return { ok: true as const };
    },
    downloadAsText: async (key: string) => {
      const buf = store.get(key);
      return buf ? { ok: true as const, value: buf.toString("utf8") } : { ok: false as const, value: "" };
    },
    downloadAsBytes: async (key: string) => {
      const buf = store.get(key);
      return buf ? { ok: true as const, value: buf } : { ok: false as const, value: Buffer.alloc(0) };
    },
    downloadToFilename: async (key: string, filename: string) => {
      const buf = store.get(key);
      if (!buf) return { ok: false as const };
      fs.writeFileSync(filename, buf);
      return { ok: true as const };
    },
    list: async (opts?: { prefix?: string }) => ({
      ok: true as const,
      value: [...store.keys()].filter(k => k.startsWith(opts?.prefix ?? "")).map(name => ({ name })),
    }),
    delete: async (key: string) => {
      store.delete(key);
      return { ok: true as const };
    },
  };
}

describe("cross-instance recovery from the Object Storage mirror", () => {
  it("materializes the exact original bytes after all local state is wiped", async () => {
    const store: FakeStore = new Map();
    fileStore._setStorageClientForTest(makeFakeStorage(store) as never);
    try {
      up._resetUploadsForTest();
      const meta = await up.initUpload("user-fake-1", "handoff.mp4", videoBuf.length, "video/mp4");

      for (let i = 0, off = 0; off < videoBuf.length; i++, off += up.UPLOAD_CHUNK_BYTES) {
        const part = videoBuf.subarray(off, Math.min(off + up.UPLOAD_CHUNK_BYTES, videoBuf.length));
        const tmp = path.join(os.tmpdir(), `part-${process.pid}-${i}`);
        fs.writeFileSync(tmp, part);
        await up.registerChunk(meta.id, "user-fake-1", i, tmp, part.length);
      }
      const fin = await up.finishUpload(meta.id, "user-fake-1");
      expect(fin.ready).toBe(true);
      expect(fin.durationSec).toBeGreaterThanOrEqual(28);
      // Chunks are cleaned from the mirror after assembly; source + meta stay.
      expect([...store.keys()].some(k => k.includes("chunk_"))).toBe(false);

      // Simulate a brand-new autoscale instance: no memory, no local files.
      up._resetUploadsForTest();
      fs.rmSync(up.UPLOADS_ROOT, { recursive: true, force: true });

      const recovered = await up.resolveUploadForJob(meta.id, "user-fake-1");
      expect(recovered.ready).toBe(true);

      const dest = path.join(os.tmpdir(), `materialized-${process.pid}.mp4`);
      try {
        await up.materializeUploadSource(recovered, dest);
        const got = fs.readFileSync(dest);
        expect(got.length).toBe(videoBuf.length);
        expect(got.equals(videoBuf)).toBe(true);
      } finally {
        fs.rmSync(dest, { force: true });
      }

      // Wrong owner can never touch it, even via the recovery path.
      await expect(up.resolveUploadForJob(meta.id, "someone-else")).rejects.toMatchObject({ status: 403 });
    } finally {
      fileStore._setStorageClientForTest(null);
      up._resetUploadsForTest();
    }
  }, 60_000);
});

// ── Concurrency + strict mirror mode ──────────────────────────────────────────

describe("upload concurrency + strict mirror mode", () => {
  it("serializes concurrent duplicate chunks: both ack, state advances exactly once", async () => {
    const store: FakeStore = new Map();
    fileStore._setStorageClientForTest(makeFakeStorage(store) as never);
    try {
      up._resetUploadsForTest();
      const meta = await up.initUpload("user-race", "race.mp4", videoBuf.length, "video/mp4");
      const part = videoBuf.subarray(0, 1024 * 1024);
      const t1 = path.join(os.tmpdir(), `race-${process.pid}-a`);
      const t2 = path.join(os.tmpdir(), `race-${process.pid}-b`);
      fs.writeFileSync(t1, part);
      fs.writeFileSync(t2, part);

      // The lock serializes them; the loser is a replay and must ack
      // idempotently (the pipelined client may legitimately resend a part).
      const results = await Promise.allSettled([
        up.registerChunk(meta.id, "user-race", 0, t1, part.length),
        up.registerChunk(meta.id, "user-race", 0, t2, part.length),
      ]);
      expect(results.filter(r => r.status === "fulfilled").length).toBe(2);

      const after = await up.loadUploadMeta(meta.id);
      expect(after?.nextChunk).toBe(1);
      expect(after?.receivedBytes).toBe(part.length); // counted exactly once
      // The mirrored bytes are the original, untouched copy.
      expect(store.get(`uploads/${meta.id}/chunk_0`)?.equals(part)).toBe(true);
    } finally {
      fileStore._setStorageClientForTest(null);
      up._resetUploadsForTest();
    }
  }, 30_000);

  it("acks a replayed chunk after a lost ack, and the upload continues", async () => {
    const store: FakeStore = new Map();
    fileStore._setStorageClientForTest(makeFakeStorage(store) as never);
    try {
      up._resetUploadsForTest();
      const meta = await up.initUpload("user-replay", "replay.mp4", videoBuf.length, "video/mp4");
      const part0 = videoBuf.subarray(0, 1024 * 1024);
      const part1 = videoBuf.subarray(1024 * 1024, 2 * 1024 * 1024);
      const tmp = (tag: string) => path.join(os.tmpdir(), `replay-${process.pid}-${tag}`);

      fs.writeFileSync(tmp("a"), part0);
      await up.registerChunk(meta.id, "user-replay", 0, tmp("a"), part0.length);

      // Same part again (the client never saw the ack) — idempotent, no 409.
      fs.writeFileSync(tmp("b"), part0);
      const replay = await up.registerChunk(meta.id, "user-replay", 0, tmp("b"), part0.length);
      expect(replay.nextChunk).toBe(1);
      expect(replay.receivedBytes).toBe(part0.length);

      // Jumping AHEAD is still a hard 409 — ordering is never relaxed.
      fs.writeFileSync(tmp("c"), part1);
      await expect(up.registerChunk(meta.id, "user-replay", 5, tmp("c"), part1.length))
        .rejects.toMatchObject({ status: 409 });

      // The genuinely-next part continues normally.
      fs.writeFileSync(tmp("d"), part1);
      const after = await up.registerChunk(meta.id, "user-replay", 1, tmp("d"), part1.length);
      expect(after.nextChunk).toBe(2);
      expect(after.receivedBytes).toBe(part0.length + part1.length);
    } finally {
      fileStore._setStorageClientForTest(null);
      up._resetUploadsForTest();
    }
  }, 30_000);

  it("stale instance + replay: adopts newer remote state, never regresses the mirror", async () => {
    const store: FakeStore = new Map();
    fileStore._setStorageClientForTest(makeFakeStorage(store) as never);
    process.env.UPLOAD_REQUIRE_MIRROR = "1"; // remote meta is authoritative (autoscale)
    try {
      up._resetUploadsForTest();
      const meta = await up.initUpload("user-stale", "stale.mp4", videoBuf.length, "video/mp4");
      const mb = 1024 * 1024;
      const parts = [0, 1, 2].map(i => videoBuf.subarray(i * mb, (i + 1) * mb));
      const tmp = (tag: string) => path.join(os.tmpdir(), `stale-${process.pid}-${tag}`);

      // This instance registers part 0 → its local meta stops at nextChunk=1.
      fs.writeFileSync(tmp("p0"), parts[0]);
      await up.registerChunk(meta.id, "user-stale", 0, tmp("p0"), parts[0].length);

      // "Another instance" registers parts 1+2 — simulate by advancing the
      // remote mirror directly, leaving THIS instance's local copy stale.
      store.set(`uploads/${meta.id}/chunk_1`, Buffer.from(parts[1]));
      store.set(`uploads/${meta.id}/chunk_2`, Buffer.from(parts[2]));
      const remote = JSON.parse(store.get(`uploads/${meta.id}/meta.json`)!.toString("utf8")) as {
        nextChunk: number; receivedBytes: number;
      } & Record<string, unknown>;
      const ahead: typeof remote = { ...remote, nextChunk: 3, receivedBytes: 3 * mb };
      store.set(`uploads/${meta.id}/meta.json`, Buffer.from(JSON.stringify(ahead)));

      // A replay of part 1 now hits the STALE instance, whose local meta says
      // nextChunk=1 — exactly what a fresh registration would look like from
      // local state alone. It must consult the mirror, recognize the replay,
      // and ack idempotently instead of re-registering.
      fs.writeFileSync(tmp("r1"), parts[1]);
      const res = await up.registerChunk(meta.id, "user-stale", 1, tmp("r1"), parts[1].length);
      expect(res.nextChunk).toBe(3);
      expect(res.receivedBytes).toBe(3 * mb);

      // The mirror was never regressed…
      const after = JSON.parse(store.get(`uploads/${meta.id}/meta.json`)!.toString("utf8")) as typeof remote;
      expect(after.nextChunk).toBe(3);
      expect(after.receivedBytes).toBe(3 * mb);
      // …and the mirrored part-1 bytes are the original, untouched copy.
      expect(store.get(`uploads/${meta.id}/chunk_1`)?.equals(parts[1])).toBe(true);
    } finally {
      delete process.env.UPLOAD_REQUIRE_MIRROR;
      fileStore._setStorageClientForTest(null);
      up._resetUploadsForTest();
    }
  }, 30_000);

  it("double-finish is idempotent — both callers get the same ready record", async () => {
    const store: FakeStore = new Map();
    fileStore._setStorageClientForTest(makeFakeStorage(store) as never);
    try {
      up._resetUploadsForTest();
      const meta = await up.initUpload("user-dfin", "dfin.mp4", videoBuf.length, "video/mp4");
      for (let i = 0, off = 0; off < videoBuf.length; i++, off += up.UPLOAD_CHUNK_BYTES) {
        const part = videoBuf.subarray(off, Math.min(off + up.UPLOAD_CHUNK_BYTES, videoBuf.length));
        const tmp = path.join(os.tmpdir(), `dfin-${process.pid}-${i}`);
        fs.writeFileSync(tmp, part);
        await up.registerChunk(meta.id, "user-dfin", i, tmp, part.length);
      }

      const [a, b] = await Promise.all([
        up.finishUpload(meta.id, "user-dfin"),
        up.finishUpload(meta.id, "user-dfin"),
      ]);
      expect(a.ready).toBe(true);
      expect(b.ready).toBe(true);

      // The assembled source is intact — not corrupted by racing assemblers.
      const dest = path.join(os.tmpdir(), `dfin-out-${process.pid}.mp4`);
      try {
        await up.materializeUploadSource(a, dest);
        expect(fs.readFileSync(dest).equals(videoBuf)).toBe(true);
      } finally {
        fs.rmSync(dest, { force: true });
      }
    } finally {
      fileStore._setStorageClientForTest(null);
      up._resetUploadsForTest();
    }
  }, 60_000);

  it("strict mode refuses to ack anything the mirror didn't accept", async () => {
    const store: FakeStore = new Map();
    const working = makeFakeStorage(store);
    let failUploads = true;
    const flaky = {
      ...working,
      uploadFromText: async (key: string, text: string) =>
        failUploads ? { ok: false as const } : working.uploadFromText(key, text),
      uploadFromFilename: async (key: string, filename: string) =>
        failUploads ? { ok: false as const } : working.uploadFromFilename(key, filename),
    };
    fileStore._setStorageClientForTest(flaky as never);
    process.env.UPLOAD_REQUIRE_MIRROR = "1";
    try {
      up._resetUploadsForTest();

      // init can't even start while the mirror is down
      await expect(up.initUpload("user-strict", "s.mp4", videoBuf.length, "video/mp4"))
        .rejects.toMatchObject({ status: 503 });

      // storage recovers → init works; then the mirror dies again mid-upload
      failUploads = false;
      const meta = await up.initUpload("user-strict", "s.mp4", videoBuf.length, "video/mp4");
      failUploads = true;
      const part = videoBuf.subarray(0, 1024);
      const tmp = path.join(os.tmpdir(), `strict-${process.pid}`);
      fs.writeFileSync(tmp, part);
      await expect(up.registerChunk(meta.id, "user-strict", 0, tmp, part.length))
        .rejects.toMatchObject({ status: 503 });

      // nothing advanced — the SAME index succeeds once storage is back
      failUploads = false;
      fs.writeFileSync(tmp, part);
      const after = await up.registerChunk(meta.id, "user-strict", 0, tmp, part.length);
      expect(after.nextChunk).toBe(1);
      expect(after.receivedBytes).toBe(part.length);
    } finally {
      delete process.env.UPLOAD_REQUIRE_MIRROR;
      fileStore._setStorageClientForTest(null);
      up._resetUploadsForTest();
    }
  }, 60_000);
});
