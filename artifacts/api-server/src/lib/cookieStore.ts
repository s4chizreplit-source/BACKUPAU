/**
 * YouTube cookies store.
 *
 * YouTube intermittently blocks datacenter IPs with a "Sign in to confirm
 * you're not a bot" wall. A cookies.txt exported from a signed-in browser
 * lets every yt-dlp call (probe, section download, full download) pass the
 * bot check reliably.
 *
 * Sources, in priority order:
 *   1. YTDLP_COOKIES_FILE env var (operator-provided path; never overwritten)
 *   2. Uploaded cookies — POSTed via /ytdlp/cookies, kept in a 0600 local file
 *      and persisted to private object storage so they survive restarts.
 *
 * The cookies file lives OUTSIDE the git tree (os.tmpdir()) and the storage
 * key is outside the public clips/ prefix, so it is never committed or served.
 */

import path from "path";
import os from "os";
import fs from "fs";
import { getStorageClient } from "./fileStore";

// CLIPAI_COOKIES_DIR override exists for tests: vitest runs test files in
// parallel workers, and without a per-worker directory the cookie tests (and
// the live dev server) would all fight over one shared /tmp path.
const COOKIES_DIR = process.env.CLIPAI_COOKIES_DIR || path.join(os.tmpdir(), "clipai-cookies");
const LOCAL_COOKIES_PATH = path.join(COOKIES_DIR, "cookies.txt");
/** Object-storage key — private prefix, never listed/served by clip routes. */
const STORAGE_KEY = ".private/ytdlp-cookies.txt";
/** Marker persisted alongside the cookies so the likely-expired warning
 *  survives server restarts. Holds `{ likelyExpiredAt: number }` as JSON. */
const EXPIRED_FLAG_STORAGE_KEY = ".private/ytdlp-cookies-expired.json";

let _updatedAt: number | null = null;
/** Set when a yt-dlp call hit YouTube's bot check WHILE cookies were configured
 *  — a strong signal the cookies expired or were invalidated. Cleared on
 *  upload/delete and on the next successful cookie-backed yt-dlp call. */
let _likelyExpiredAt: number | null = null;

/** Persist the likely-expired marker so it survives restarts. Non-fatal. */
async function persistExpiredFlag(at: number): Promise<void> {
  try {
    await getStorageClient().uploadFromText(EXPIRED_FLAG_STORAGE_KEY, JSON.stringify({ likelyExpiredAt: at }));
  } catch { /* non-fatal — in-memory flag still works until restart */ }
}

/** Remove the persisted likely-expired marker. Non-fatal. */
async function clearPersistedExpiredFlag(): Promise<void> {
  try {
    await getStorageClient().delete(EXPIRED_FLAG_STORAGE_KEY, { ignoreNotFound: true });
  } catch { /* non-fatal */ }
}

/** Record that YouTube's bot check fired even though cookies are configured. */
export function reportCookieBotBlock(): void {
  if (getCookiesFilePath()) {
    _likelyExpiredAt = Date.now();
    console.warn("[cookies] Bot check hit while cookies are configured — they have likely expired.");
    void persistExpiredFlag(_likelyExpiredAt);
  }
}

/** Record that a cookie-backed yt-dlp call succeeded — cookies still work. */
export function reportCookieSuccess(): void {
  if (_likelyExpiredAt !== null) {
    _likelyExpiredAt = null;
    void clearPersistedExpiredFlag();
  }
}

function envCookiesPath(): string | null {
  const p = process.env.YTDLP_COOKIES_FILE;
  if (p && fs.existsSync(p)) return p;
  return null;
}

/** Absolute path of the active cookies file, or null when none configured. */
export function getCookiesFilePath(): string | null {
  const env = envCookiesPath();
  if (env) return env;
  if (fs.existsSync(LOCAL_COOKIES_PATH)) return LOCAL_COOKIES_PATH;
  return null;
}

/** yt-dlp CLI args for cookies — [] when no cookies are configured. */
export function getCookieArgs(): string[] {
  const p = getCookiesFilePath();
  return p ? ["--cookies", p] : [];
}

export interface CookieValidation {
  ok: boolean;
  error?: string;
  youtubeCookieCount: number;
}

/**
 * Validate that `text` looks like a Netscape-format cookies.txt containing
 * at least one youtube.com cookie. yt-dlp requires the Netscape format
 * (7 tab-separated fields per cookie line).
 */
export function validateCookiesText(text: string): CookieValidation {
  if (!text || text.length > 1024 * 1024) {
    return { ok: false, error: "Cookie file is empty or too large (max 1 MB).", youtubeCookieCount: 0 };
  }
  let youtubeCookieCount = 0;
  let anyCookieLines = 0;
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    // Note: "#HttpOnly_" lines are real cookies, not comments.
    if (!line || (line.startsWith("#") && !line.startsWith("#HttpOnly_"))) continue;
    const fields = line.split("\t");
    if (fields.length < 7) continue; // not a valid Netscape cookie line
    anyCookieLines++;
    if (/(^|\.)youtube\.com$/i.test(fields[0].replace(/^#HttpOnly_/, ""))) {
      youtubeCookieCount++;
    }
  }
  if (anyCookieLines === 0) {
    return {
      ok: false,
      error:
        "This doesn't look like a Netscape-format cookies.txt (no tab-separated cookie lines found). " +
        "Export cookies with a browser extension like \"Get cookies.txt LOCALLY\".",
      youtubeCookieCount: 0,
    };
  }
  if (youtubeCookieCount === 0) {
    return {
      ok: false,
      error: "No youtube.com cookies found in the file. Export cookies while on youtube.com and signed in.",
      youtubeCookieCount: 0,
    };
  }
  return { ok: true, youtubeCookieCount };
}

/** Write cookies locally (0600) and persist to private object storage. */
export async function saveCookies(text: string): Promise<CookieValidation & { persisted: boolean }> {
  const v = validateCookiesText(text);
  if (!v.ok) return { ...v, persisted: false };

  fs.mkdirSync(COOKIES_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(LOCAL_COOKIES_PATH, text, { mode: 0o600 });
  _updatedAt = Date.now();
  _likelyExpiredAt = null; // fresh cookies — reset the expired flag
  await clearPersistedExpiredFlag();

  // Persist so cookies survive restarts. Non-fatal: local file still works.
  let persisted = false;
  try {
    const res = await getStorageClient().uploadFromText(STORAGE_KEY, text);
    persisted = res.ok;
  } catch { /* non-fatal */ }
  if (!persisted) {
    console.warn("[cookies] Could not persist cookies to object storage — they will be lost on restart.");
  }
  return { ...v, persisted };
}

/** Remove uploaded cookies (local + persisted). Does not touch YTDLP_COOKIES_FILE. */
export async function deleteCookies(): Promise<void> {
  try { fs.unlinkSync(LOCAL_COOKIES_PATH); } catch { /* not present */ }
  _updatedAt = null;
  _likelyExpiredAt = null;
  try { await getStorageClient().delete(STORAGE_KEY, { ignoreNotFound: true }); } catch { /* non-fatal */ }
  await clearPersistedExpiredFlag();
}

export interface CookieStatus {
  configured: boolean;
  source: "env" | "uploaded" | null;
  youtubeCookieCount: number;
  updatedAt: number | null;
  /** True when a bot-check failure occurred while these cookies were active. */
  likelyExpired: boolean;
  likelyExpiredAt: number | null;
}

export function getCookieStatus(): CookieStatus {
  const expired = { likelyExpired: _likelyExpiredAt !== null, likelyExpiredAt: _likelyExpiredAt };
  if (envCookiesPath()) {
    let count = 0;
    try { count = validateCookiesText(fs.readFileSync(envCookiesPath()!, "utf8")).youtubeCookieCount; } catch { /* ignore */ }
    return { configured: true, source: "env", youtubeCookieCount: count, updatedAt: null, ...expired };
  }
  if (fs.existsSync(LOCAL_COOKIES_PATH)) {
    let count = 0;
    try { count = validateCookiesText(fs.readFileSync(LOCAL_COOKIES_PATH, "utf8")).youtubeCookieCount; } catch { /* ignore */ }
    return { configured: true, source: "uploaded", youtubeCookieCount: count, updatedAt: _updatedAt, ...expired };
  }
  return { configured: false, source: null, youtubeCookieCount: 0, updatedAt: null, likelyExpired: false, likelyExpiredAt: null };
}

/**
 * Restore previously-uploaded cookies from object storage into the local
 * 0600 file at startup. No-op when YTDLP_COOKIES_FILE is set or nothing
 * was persisted. Safe to call multiple times.
 */
export async function restoreCookiesFromStorage(): Promise<void> {
  if (!envCookiesPath() && !fs.existsSync(LOCAL_COOKIES_PATH)) {
    try {
      const res = await getStorageClient().downloadAsText(STORAGE_KEY);
      if (res.ok && res.value) {
        const v = validateCookiesText(res.value);
        if (v.ok) {
          fs.mkdirSync(COOKIES_DIR, { recursive: true, mode: 0o700 });
          fs.writeFileSync(LOCAL_COOKIES_PATH, res.value, { mode: 0o600 });
          _updatedAt = Date.now();
          console.log(`[cookies] Restored YouTube cookies from storage (${v.youtubeCookieCount} youtube.com cookies).`);
        }
      }
    } catch (err) {
      console.warn("[cookies] Cookie restore failed:", (err as Error).message);
    }
  }
  await restoreExpiredFlagFromStorage();
}

/**
 * Restore the persisted likely-expired marker so the "cookies expired"
 * warning survives restarts. Only applies when cookies are configured;
 * a stale marker with no cookies present is cleaned up.
 */
async function restoreExpiredFlagFromStorage(): Promise<void> {
  if (_likelyExpiredAt !== null) return; // fresh in-memory signal wins
  try {
    const res = await getStorageClient().downloadAsText(EXPIRED_FLAG_STORAGE_KEY);
    if (!res.ok || !res.value) return;
    const parsed = JSON.parse(res.value) as { likelyExpiredAt?: unknown };
    const at = typeof parsed.likelyExpiredAt === "number" ? parsed.likelyExpiredAt : null;
    if (at === null) return;
    if (!getCookiesFilePath()) {
      // Marker refers to cookies that no longer exist — clean it up.
      void clearPersistedExpiredFlag();
      return;
    }
    _likelyExpiredAt = at;
    console.warn("[cookies] Restored likely-expired flag from storage — cookies still need re-upload.");
  } catch { /* non-fatal — flag just won't survive this restart */ }
}

/** FOR TESTING ONLY — path of the local uploaded-cookies file. */
export const _LOCAL_COOKIES_PATH_FOR_TEST = LOCAL_COOKIES_PATH;
