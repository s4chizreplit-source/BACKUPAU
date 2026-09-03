/**
 * PostgreSQL coordination checks. These run only where DATABASE_URL is
 * available, like the other persistence suites; unit pipeline tests continue
 * to exercise the fail-open local fallback.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "../lib/db";
import { ensureSchema } from "../lib/schema";
import {
  cancelDurableJob,
  enqueueDurableJob,
  finishDurableJob,
  getDurableJob,
  reclaimExpiredDurableJobs,
  tryClaimDurableJob,
} from "../lib/durableJobs";

const maybe = pool ? describe : describe.skip;
const PREFIX = "durable-test-";
const record = (status = "queued") => ({
  status,
  createdMs: Date.now(),
  updatedMs: Date.now(),
  url: "https://example.com/video",
  platform: "shorts",
});

maybe("durable job coordination", () => {
  beforeAll(async () => {
    await ensureSchema(pool!);
    await pool!.query(`DELETE FROM async_jobs WHERE id LIKE $1`, [`${PREFIX}%`]);
  });

  afterAll(async () => {
    await pool!.query(`DELETE FROM async_jobs WHERE id LIKE $1`, [`${PREFIX}%`]);
  });

  it("lets exactly one worker claim a queued job and protects terminal state with its lease token", async () => {
    const id = `${PREFIX}claim`;
    await enqueueDurableJob(id, undefined, record());
    const [one, two] = await Promise.all([
      tryClaimDurableJob(id, "worker-a", 10),
      tryClaimDurableJob(id, "worker-b", 10),
    ]);
    const winner = one.claimed ? one : two;
    const loser = one.claimed ? two : one;
    expect(winner.claimed).toBe(true);
    expect(loser.claimed).toBe(false);
    expect(winner.token).toBeTruthy();

    expect(await finishDurableJob(id, "wrong-worker", "wrong-token", record("done"))).toBe(false);
    expect(await finishDurableJob(id, one.claimed ? "worker-a" : "worker-b", winner.token!, record("done"))).toBe(true);
    expect((await getDurableJob(id))?.status).toBe("done");
  });

  it("atomically enforces a shared cap when different jobs race for the last slot", async () => {
    const a = `${PREFIX}cap-a`;
    const b = `${PREFIX}cap-b`;
    await Promise.all([
      enqueueDurableJob(a, undefined, record()),
      enqueueDurableJob(b, undefined, record()),
    ]);
    const claims = await Promise.all([
      tryClaimDurableJob(a, "worker-a", 1),
      tryClaimDurableJob(b, "worker-b", 1),
    ]);
    expect(claims.filter((claim) => claim.claimed)).toHaveLength(1);
    const winnerIndex = claims.findIndex((claim) => claim.claimed);
    const winnerId = winnerIndex === 0 ? a : b;
    const winnerOwner = winnerIndex === 0 ? "worker-a" : "worker-b";
    await finishDurableJob(winnerId, winnerOwner, claims[winnerIndex].token!, record("done"));
  });

  it("reclaims an expired lease and permits a safe new attempt", async () => {
    const id = `${PREFIX}expired`;
    await enqueueDurableJob(id, undefined, record());
    const first = await tryClaimDurableJob(id, "worker-a", 10);
    expect(first.claimed).toBe(true);
    await pool!.query(
      `UPDATE async_jobs SET lease_until = NOW() - interval '1 second' WHERE id = $1`,
      [id],
    );
    expect(await reclaimExpiredDurableJobs()).toBeGreaterThanOrEqual(1);
    const second = await tryClaimDurableJob(id, "worker-b", 10);
    expect(second.claimed).toBe(true);
    expect(second.token).not.toBe(first.token);
  });

  it("cancels only before a worker owns the job", async () => {
    const queued = `${PREFIX}cancelled`;
    await enqueueDurableJob(queued, undefined, record());
    expect(await cancelDurableJob(queued)).toBe("cancelled");
    expect((await getDurableJob(queued))?.status).toBe("cancelled");

    const processing = `${PREFIX}processing`;
    await enqueueDurableJob(processing, undefined, record());
    expect((await tryClaimDurableJob(processing, "worker-a", 10)).claimed).toBe(true);
    expect(await cancelDurableJob(processing)).toBe("started");
  });
});
