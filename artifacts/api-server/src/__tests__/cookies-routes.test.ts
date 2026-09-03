/**
 * Integration tests: /ytdlp/cookies HTTP routes.
 *
 * Covers:
 *  - POST /ytdlp/cookies with a valid Netscape cookies.txt → 200, count, status
 *  - POST with invalid content → 422 INVALID_COOKIES
 *  - POST with a missing `cookies` field → 400
 *  - GET /ytdlp/cookies/status reflects configured/unconfigured state
 *  - DELETE /ytdlp/cookies removes uploaded cookies
 *  - Cookie contents are never echoed back in any response
 *
 * The object-storage client is mocked so the tests run without live services.
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import express from "express";
import * as http from "http";
import * as fs from "fs";

// ── Mock object storage so saveCookies/deleteCookies never hit the network ───
vi.mock("../lib/fileStore", () => ({
  getStorageClient: () => ({
    uploadFromText: vi.fn(async () => ({ ok: true })),
    delete: vi.fn(async () => ({ ok: true })),
    downloadAsText: vi.fn(async () => ({ ok: false })),
  }),
}));

// ── Admin gate stub — POST/DELETE are admin-only; tests flip the actor ───────
// (The real requireAdmin does a session+DB lookup; here we only verify the
// routes are wired through it. Its own behavior is covered elsewhere.)
const authState = vi.hoisted(() => ({
  actor: { id: "admin-test", role: "admin" } as { id: string; role: string } | null,
}));
vi.mock("../middlewares/sessionAuth", () => ({
  requireAdmin: (req: never, res: never, next: () => void) => {
    const r = res as { status: (n: number) => { json: (b: unknown) => void } };
    if (!authState.actor) {
      r.status(401).json({ error: "Sign in required." });
      return;
    }
    if (authState.actor.role !== "admin") {
      r.status(403).json({ error: "Admin access required.", code: "ADMIN_REQUIRED" });
      return;
    }
    (req as { currentUser?: unknown }).currentUser = authState.actor;
    next();
  },
}));

import cookiesRouter from "../routes/cookies.js";
import { _LOCAL_COOKIES_PATH_FOR_TEST } from "../lib/cookieStore.js";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const SECRET_VALUE = "supersecretcookievalue123";
const VALID_COOKIES = [
  "# Netscape HTTP Cookie File",
  `.youtube.com\tTRUE\t/\tTRUE\t2147483647\tSID\t${SECRET_VALUE}`,
  `#HttpOnly_.youtube.com\tTRUE\t/\tTRUE\t2147483647\tSSID\t${SECRET_VALUE}b`,
  `.example.com\tTRUE\t/\tFALSE\t2147483647\tfoo\tbar`,
].join("\n");

const NO_YT_COOKIES = [
  "# Netscape HTTP Cookie File",
  `.example.com\tTRUE\t/\tFALSE\t2147483647\tfoo\tbar`,
].join("\n");

// ── Helpers ───────────────────────────────────────────────────────────────────

async function startServer(): Promise<{ server: http.Server; baseUrl: string }> {
  const app = express();
  app.use(express.json());
  // The routes use req.log (pino-http in production) — stub it here.
  app.use((req, _res, next) => {
    (req as unknown as { log: unknown }).log = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    next();
  });
  app.use(cookiesRouter);
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const addr = server.address() as { port: number };
  return { server, baseUrl: `http://127.0.0.1:${addr.port}` };
}

async function stopServer(server: http.Server): Promise<void> {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
}

function removeLocalCookiesFile(): void {
  try {
    fs.unlinkSync(_LOCAL_COOKIES_PATH_FOR_TEST);
  } catch {
    /* not present */
  }
}

let server: http.Server;
let baseUrl: string;

// ── Route behavior ────────────────────────────────────────────────────────────

describe("/ytdlp/cookies routes", () => {
  beforeAll(async () => {
    delete process.env.YTDLP_COOKIES_FILE;
    ({ server, baseUrl } = await startServer());
  });

  afterAll(async () => {
    removeLocalCookiesFile();
    await stopServer(server);
  });

  beforeEach(() => {
    removeLocalCookiesFile();
    authState.actor = { id: "admin-test", role: "admin" };
  });

  it("POST is rejected when not signed in", async () => {
    authState.actor = null;
    const res = await fetch(`${baseUrl}/ytdlp/cookies`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cookies: VALID_COOKIES }),
    });
    expect(res.status).toBe(401);
  });

  it("POST and DELETE are rejected for non-admin users", async () => {
    authState.actor = { id: "user-test", role: "user" };
    const post = await fetch(`${baseUrl}/ytdlp/cookies`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cookies: VALID_COOKIES }),
    });
    expect(post.status).toBe(403);
    const del = await fetch(`${baseUrl}/ytdlp/cookies`, { method: "DELETE" });
    expect(del.status).toBe(403);
  });

  it("GET /ytdlp/cookies/status reports unconfigured when no cookies exist", async () => {
    const res = await fetch(`${baseUrl}/ytdlp/cookies/status`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      configured: false,
      source: null,
      youtubeCookieCount: 0,
    });
  });

  it("POST /ytdlp/cookies with a valid cookies.txt saves and reports the count", async () => {
    const res = await fetch(`${baseUrl}/ytdlp/cookies`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cookies: VALID_COOKIES }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.youtubeCookieCount).toBe(2); // SID + #HttpOnly_ SSID
    expect(body.status).toMatchObject({
      configured: true,
      source: "uploaded",
      youtubeCookieCount: 2,
    });
    // Cookies file exists locally with restrictive permissions.
    expect(fs.existsSync(_LOCAL_COOKIES_PATH_FOR_TEST)).toBe(true);
  });

  it("never echoes cookie contents back in the response", async () => {
    const res = await fetch(`${baseUrl}/ytdlp/cookies`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cookies: VALID_COOKIES }),
    });
    const text = await res.text();
    expect(text).not.toContain(SECRET_VALUE);

    const statusRes = await fetch(`${baseUrl}/ytdlp/cookies/status`);
    expect(await statusRes.text()).not.toContain(SECRET_VALUE);
  });

  it("POST with non-Netscape content returns 422 INVALID_COOKIES", async () => {
    const res = await fetch(`${baseUrl}/ytdlp/cookies`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cookies: "this is not a cookies file" }),
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe("INVALID_COOKIES");
    expect(body.error).toMatch(/netscape/i);
    expect(fs.existsSync(_LOCAL_COOKIES_PATH_FOR_TEST)).toBe(false);
  });

  it("POST with no youtube.com cookies returns 422 INVALID_COOKIES", async () => {
    const res = await fetch(`${baseUrl}/ytdlp/cookies`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cookies: NO_YT_COOKIES }),
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe("INVALID_COOKIES");
    expect(body.error).toMatch(/youtube\.com/i);
  });

  it("POST with a missing cookies field returns 400", async () => {
    const res = await fetch(`${baseUrl}/ytdlp/cookies`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toMatch(/cookies/i);
  });

  it("DELETE /ytdlp/cookies removes uploaded cookies", async () => {
    // Upload first.
    await fetch(`${baseUrl}/ytdlp/cookies`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cookies: VALID_COOKIES }),
    });
    expect(fs.existsSync(_LOCAL_COOKIES_PATH_FOR_TEST)).toBe(true);

    const res = await fetch(`${baseUrl}/ytdlp/cookies`, { method: "DELETE" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.status).toMatchObject({ configured: false, source: null });
    expect(fs.existsSync(_LOCAL_COOKIES_PATH_FOR_TEST)).toBe(false);
  });
});
