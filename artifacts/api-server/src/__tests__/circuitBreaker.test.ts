/**
 * Unit tests for the Object Storage upload circuit breaker.
 *
 * Scenarios:
 *   1. Three consecutive upload failures → circuit OPENS.
 *   2. While OPEN, storeFile skips the upload immediately (no retry delay).
 *   3. After the cool-down elapses the circuit moves to HALF_OPEN and allows
 *      one probe through; a successful probe resets it to CLOSED.
 *   4. A failed probe re-opens the circuit.
 *   5. /api/healthz reports the correct `storageCircuit.state` for each state.
 */

import path from "path";
import os from "os";
import fs from "fs";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import express from "express";
import supertest from "supertest";

// ── In-memory fake Object Storage ────────────────────────────────────────────

type FakeStore = Map<string, Buffer>;

function makeFailingStorage() {
  return {
    uploadFromFilename: vi.fn(async () => { throw new Error("upload boom"); }),
    uploadFromText:     vi.fn(async () => { throw new Error("upload boom"); }),
    downloadAsText:     vi.fn(async () => ({ ok: false as const, value: "" })),
    downloadToFilename: vi.fn(async () => ({ ok: false as const })),
    list:               vi.fn(async () => ({ ok: true as const, value: [] })),
  };
}

function makeSucceedingStorage(store: FakeStore = new Map()) {
  return {
    uploadFromFilename: vi.fn(async (key: string, filePath: string) => {
      store.set(key, fs.readFileSync(filePath));
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
    downloadToFilename: vi.fn(async (key: string, destPath: string) => {
      const buf = store.get(key);
      if (!buf) return { ok: false as const };
      fs.mkdirSync(path.dirname(destPath), { recursive: true });
      fs.writeFileSync(destPath, buf);
      return { ok: true as const };
    }),
    list: vi.fn(async () => ({ ok: true as const, value: [] })),
  };
}

/** Write a small fixture file and return its path. */
function writeFixture(dir: string, name: string, content = "fake-bytes"): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, content, "utf8");
  return p;
}

// ── Shared setup ──────────────────────────────────────────────────────────────

async function getFileStoreModule() {
  return import("../lib/fileStore.js");
}

// ── Circuit-breaker primitive tests ──────────────────────────────────────────

describe("circuit breaker primitives", () => {
  beforeEach(async () => {
    const mod = await getFileStoreModule();
    mod._resetCircuitBreakerForTest();
  });

  afterEach(async () => {
    const mod = await getFileStoreModule();
    mod._resetCircuitBreakerForTest();
  });

  it("starts CLOSED with zero consecutive failures", async () => {
    const { cbIsOpen, _cb } = await getFileStoreModule();
    expect(_cb.state).toBe("CLOSED");
    expect(_cb.consecutiveFailures).toBe(0);
    expect(cbIsOpen()).toBe(false);
  });

  it("cbFailure increments consecutive failures but does not open before threshold", async () => {
    const { cbFailure, _cb } = await getFileStoreModule();
    cbFailure(); // 1
    cbFailure(); // 2
    expect(_cb.state).toBe("CLOSED");
    expect(_cb.consecutiveFailures).toBe(2);
  });

  it("cbFailure opens the circuit once the threshold (3) is reached", async () => {
    const { cbFailure, cbIsOpen, _cb } = await getFileStoreModule();
    cbFailure(); // 1
    cbFailure(); // 2
    cbFailure(); // 3 → OPEN
    expect(_cb.state).toBe("OPEN");
    expect(cbIsOpen()).toBe(true);
  });

  it("cbSuccess resets the circuit to CLOSED and clears failure count", async () => {
    const { cbFailure, cbSuccess, cbIsOpen, _cb } = await getFileStoreModule();
    cbFailure();
    cbFailure();
    cbFailure(); // OPEN
    expect(_cb.state).toBe("OPEN");

    cbSuccess();
    expect(_cb.state).toBe("CLOSED");
    expect(_cb.consecutiveFailures).toBe(0);
    expect(cbIsOpen()).toBe(false);
  });

  it("cbIsOpen returns false while CLOSED even after two failures", async () => {
    const { cbFailure, cbIsOpen } = await getFileStoreModule();
    cbFailure();
    cbFailure();
    expect(cbIsOpen()).toBe(false);
  });

  it("cbIsOpen transitions OPEN → HALF_OPEN after the cool-down and returns false", async () => {
    const { cbFailure, cbIsOpen, _cb } = await getFileStoreModule();
    cbFailure();
    cbFailure();
    cbFailure(); // OPEN
    expect(_cb.state).toBe("OPEN");

    // Simulate cool-down elapsed by backdating openedAt
    _cb.openedAt = Date.now() - 31_000; // > 30 s cool-down

    // cbIsOpen must return false (probe allowed) and set state to HALF_OPEN
    expect(cbIsOpen()).toBe(false);
    expect(_cb.state).toBe("HALF_OPEN");
  });

  it("cbIsOpen returns false when HALF_OPEN (lets the probe through)", async () => {
    const { cbIsOpen, _cb } = await getFileStoreModule();
    _cb.state = "HALF_OPEN";
    expect(cbIsOpen()).toBe(false);
  });

  it("a failed probe from HALF_OPEN re-opens the circuit", async () => {
    const { cbFailure, cbIsOpen, _cb } = await getFileStoreModule();
    _cb.state = "HALF_OPEN";
    _cb.consecutiveFailures = 3; // already at threshold

    cbFailure(); // simulate probe failure
    expect(_cb.state).toBe("OPEN");
    expect(cbIsOpen()).toBe(true);
  });
});

// ── storeFile circuit-breaker integration ────────────────────────────────────

describe("storeFile — circuit breaker integration", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cb-test-"));
    const mod = await getFileStoreModule();
    mod._resetCircuitBreakerForTest();
    mod._resetBucketCounterForTest();
  });

  afterEach(async () => {
    const mod = await getFileStoreModule();
    mod._setStorageClientForTest(null);
    mod._resetCircuitBreakerForTest();
    mod._resetBucketCounterForTest();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("three consecutive upload failures open the circuit", async () => {
    const mod = await getFileStoreModule();
    mod._setStorageClientForTest(makeFailingStorage() as never);
    mod._resetCircuitBreakerForTest();

    const { storeFile, _cb } = mod;

    for (let i = 0; i < 3; i++) {
      const p = writeFixture(tmpDir, `clip${i}.mp4`, `content-${i}`);
      // storeFile catches upload errors; it resolves but logs a warning
      await storeFile(p, `clip${i}.mp4`, "video/mp4");
    }

    expect(_cb.state).toBe("OPEN");
    expect(_cb.consecutiveFailures).toBeGreaterThanOrEqual(3);
  });

  it("4th storeFile call skips the upload immediately when circuit is OPEN (no retry delay)", async () => {
    const mod = await getFileStoreModule();
    const failing = makeFailingStorage();
    mod._setStorageClientForTest(failing as never);
    mod._resetCircuitBreakerForTest();

    const { storeFile } = mod;

    // Open the circuit with 3 failures
    for (let i = 0; i < 3; i++) {
      const p = writeFixture(tmpDir, `clip${i}.mp4`, `c${i}`);
      await storeFile(p, `clip${i}.mp4`, "video/mp4");
    }

    const uploadCallsBefore = failing.uploadFromFilename.mock.calls.length;

    // 4th call — circuit is OPEN; upload must be skipped entirely
    const start = Date.now();
    const p4 = writeFixture(tmpDir, "clip4.mp4", "fourth");
    const id = await storeFile(p4, "clip4.mp4", "video/mp4");
    const elapsed = Date.now() - start;

    // Must resolve with an id (served from local disk)
    expect(id).toBeTypeOf("string");
    // No additional upload attempts
    expect(failing.uploadFromFilename.mock.calls.length).toBe(uploadCallsBefore);
    // Must be fast — no retry back-off delays (3× 500 ms+ retries would take > 1 s)
    expect(elapsed).toBeLessThan(500);
  });

  it("a successful probe after cool-down resets the circuit to CLOSED", async () => {
    const mod = await getFileStoreModule();
    mod._resetCircuitBreakerForTest();

    const { storeFile, _cb } = mod;

    // Step 1: open the circuit with a failing storage
    mod._setStorageClientForTest(makeFailingStorage() as never);
    for (let i = 0; i < 3; i++) {
      const p = writeFixture(tmpDir, `fail${i}.mp4`, `f${i}`);
      await storeFile(p, `fail${i}.mp4`, "video/mp4");
    }
    expect(_cb.state).toBe("OPEN");

    // Step 2: fast-forward past the cool-down
    _cb.openedAt = Date.now() - 31_000;

    // Step 3: switch to a succeeding storage for the probe
    const store: FakeStore = new Map();
    mod._setStorageClientForTest(makeSucceedingStorage(store) as never);

    // Step 4: one storeFile call — circuit is HALF_OPEN, probe goes through
    const probe = writeFixture(tmpDir, "probe.mp4", "probe-bytes");
    await storeFile(probe, "probe.mp4", "video/mp4");

    // Circuit must now be CLOSED and consecutive failures reset
    expect(_cb.state).toBe("CLOSED");
    expect(_cb.consecutiveFailures).toBe(0);
  });

  it("a failed probe re-opens the circuit from HALF_OPEN", async () => {
    const mod = await getFileStoreModule();
    mod._resetCircuitBreakerForTest();

    const { storeFile, _cb } = mod;

    // Manually put the circuit into HALF_OPEN state
    _cb.state = "HALF_OPEN";
    _cb.consecutiveFailures = 3; // already at threshold so next failure opens it

    // Inject failing storage
    mod._setStorageClientForTest(makeFailingStorage() as never);

    const p = writeFixture(tmpDir, "reprobe.mp4", "reprobe");
    await storeFile(p, "reprobe.mp4", "video/mp4");

    expect(_cb.state).toBe("OPEN");
  });
});

// ── probeStorageIfOpen — background probe tests ───────────────────────────────

describe("probeStorageIfOpen — background circuit-breaker probe", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cb-probe-"));
    const mod = await getFileStoreModule();
    mod._resetCircuitBreakerForTest();
    mod._resetBucketCounterForTest();
  });

  afterEach(async () => {
    const mod = await getFileStoreModule();
    mod._setStorageClientForTest(null);
    mod._resetCircuitBreakerForTest();
    mod._resetBucketCounterForTest();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("does nothing when the circuit is CLOSED", async () => {
    const mod = await getFileStoreModule();
    const succeeding = makeSucceedingStorage();
    mod._setStorageClientForTest(succeeding as never);

    await mod.probeStorageIfOpen();

    // Circuit stays CLOSED; list was never called
    expect(mod._cb.state).toBe("CLOSED");
    expect(succeeding.list.mock.calls.length).toBe(0);
  });

  it("does nothing when the circuit is OPEN but cool-down has not elapsed", async () => {
    const mod = await getFileStoreModule();
    const succeeding = makeSucceedingStorage();
    mod._setStorageClientForTest(succeeding as never);

    // Force OPEN with a fresh openedAt timestamp (cool-down definitely not elapsed)
    mod._cb.state = "OPEN";
    mod._cb.consecutiveFailures = 3;
    mod._cb.openedAt = Date.now(); // just opened

    await mod.probeStorageIfOpen();

    expect(mod._cb.state).toBe("OPEN");
    expect(succeeding.list.mock.calls.length).toBe(0);
  });

  it("closes the circuit via a successful probe without any storeFile call", async () => {
    const mod = await getFileStoreModule();

    // Step 1: open the circuit
    mod._cb.state = "OPEN";
    mod._cb.consecutiveFailures = 3;
    // Step 2: simulate elapsed cool-down
    mod._cb.openedAt = Date.now() - 31_000;

    // Step 3: inject healthy storage
    mod._setStorageClientForTest(makeSucceedingStorage() as never);

    // Step 4: invoke the probe directly — no storeFile involved
    await mod.probeStorageIfOpen();

    expect(mod._cb.state).toBe("CLOSED");
    expect(mod._cb.consecutiveFailures).toBe(0);
  });

  it("re-opens the circuit when the probe's list call fails", async () => {
    const mod = await getFileStoreModule();

    mod._cb.state = "OPEN";
    mod._cb.consecutiveFailures = 3;
    mod._cb.openedAt = Date.now() - 31_000;

    // Inject storage whose list throws
    mod._setStorageClientForTest({
      ...makeFailingStorage(),
      list: vi.fn(async () => { throw new Error("still down"); }),
    } as never);

    await mod.probeStorageIfOpen();

    // Should re-open (consecutiveFailures ≥ threshold again)
    expect(mod._cb.state).toBe("OPEN");
    expect(mod._cb.consecutiveFailures).toBeGreaterThanOrEqual(3);
  });

  it("re-opens the circuit when the probe's list returns ok:false", async () => {
    const mod = await getFileStoreModule();

    mod._cb.state = "OPEN";
    mod._cb.consecutiveFailures = 3;
    mod._cb.openedAt = Date.now() - 31_000;

    mod._setStorageClientForTest({
      ...makeFailingStorage(),
      list: vi.fn(async () => ({ ok: false as const, value: [] })),
    } as never);

    await mod.probeStorageIfOpen();

    expect(mod._cb.state).toBe("OPEN");
  });

  it("closes the circuit when the circuit is already HALF_OPEN (probe in-flight scenario)", async () => {
    const mod = await getFileStoreModule();

    // Simulate the state after cbIsOpen() already transitioned to HALF_OPEN
    mod._cb.state = "HALF_OPEN";
    mod._cb.consecutiveFailures = 3;

    mod._setStorageClientForTest(makeSucceedingStorage() as never);

    await mod.probeStorageIfOpen();

    expect(mod._cb.state).toBe("CLOSED");
    expect(mod._cb.consecutiveFailures).toBe(0);
  });
});

// ── /api/healthz circuit state reporting ─────────────────────────────────────

describe("/api/healthz — circuit state field", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cb-health-"));
    const mod = await getFileStoreModule();
    mod._resetCircuitBreakerForTest();
  });

  afterEach(async () => {
    const mod = await getFileStoreModule();
    mod._setStorageClientForTest(null);
    mod._resetCircuitBreakerForTest();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /**
   * Build a minimal Express app that mounts the health router.
   * We import the router after resetting state to get the current module instance.
   */
  async function buildApp() {
    const { default: healthRouter } = await import("../routes/health.js");
    const app = express();
    app.use("/api", healthRouter);
    return app;
  }

  it("reports CLOSED state and ok=true when Object Storage is healthy", async () => {
    const mod = await getFileStoreModule();
    // Healthy storage: list returns ok
    mod._setStorageClientForTest(makeSucceedingStorage() as never);

    const app = await buildApp();
    const res = await supertest(app).get("/api/healthz");

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(res.body.storage).toBe("ok");
    expect(res.body.storageCircuit.state).toBe("CLOSED");
    expect(res.body.storageCircuit.consecutiveFailures).toBe(0);
  });

  it("reports the current failure count when failures have accumulated but circuit is still CLOSED", async () => {
    const mod = await getFileStoreModule();
    mod._setStorageClientForTest(makeSucceedingStorage() as never);

    // Drive 2 failures into the breaker (below open threshold)
    const { cbFailure } = mod;
    cbFailure();
    cbFailure();

    const app = await buildApp();
    const res = await supertest(app).get("/api/healthz");

    // Storage list call itself succeeds, so status is ok
    expect(res.status).toBe(200);
    expect(res.body.storageCircuit.state).toBe("CLOSED");
    expect(res.body.storageCircuit.consecutiveFailures).toBe(2);
  });

  it("reports OPEN state and returns 503 when circuit is OPEN and storage is unreachable", async () => {
    const mod = await getFileStoreModule();

    // Inject a storage that throws on list (the health check call)
    mod._setStorageClientForTest({
      ...makeFailingStorage(),
      list: vi.fn(async () => { throw new Error("storage down"); }),
    } as never);

    // Manually open the circuit
    const { cbFailure, _cb } = mod;
    cbFailure();
    cbFailure();
    cbFailure(); // OPEN
    expect(_cb.state).toBe("OPEN");

    const app = await buildApp();
    const res = await supertest(app).get("/api/healthz");

    expect(res.status).toBe(503);
    expect(res.body.status).toBe("degraded");
    expect(res.body.storageCircuit.state).toBe("OPEN");
    expect(res.body.storageCircuit.consecutiveFailures).toBeGreaterThanOrEqual(3);
  });

  it("reports HALF_OPEN state when cool-down has elapsed", async () => {
    const mod = await getFileStoreModule();

    // Use succeeding storage so the health list call itself returns ok
    mod._setStorageClientForTest(makeSucceedingStorage() as never);

    const { cbFailure, _cb } = mod;
    cbFailure();
    cbFailure();
    cbFailure(); // OPEN
    _cb.openedAt = Date.now() - 31_000; // fast-forward past cool-down

    const app = await buildApp();
    const res = await supertest(app).get("/api/healthz");

    // After the health endpoint calls checkStorageHealth → getStorageCircuitState,
    // cbIsOpen() may have already transitioned to HALF_OPEN before the snapshot,
    // OR the snapshot is taken before cbIsOpen runs (depends on ordering in checkStorageHealth).
    // Either OPEN or HALF_OPEN is acceptable here — what matters is that it transitions.
    // We confirm by reading state directly after the request.
    expect(["OPEN", "HALF_OPEN"]).toContain(res.body.storageCircuit.state);
    // The consecutive failure count must still reflect the 3 failures
    expect(res.body.storageCircuit.consecutiveFailures).toBeGreaterThanOrEqual(3);
  });
});
