import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import {
  validateCookiesText,
  saveCookies,
  deleteCookies,
  getCookieStatus,
  getCookieArgs,
  reportCookieBotBlock,
  reportCookieSuccess,
  restoreCookiesFromStorage,
  _LOCAL_COOKIES_PATH_FOR_TEST,
} from "../lib/cookieStore";
import { _setStorageClientForTest, type StorageAdapter } from "../lib/fileStore";

const VALID_COOKIES = [
  "# Netscape HTTP Cookie File",
  ".youtube.com\tTRUE\t/\tTRUE\t1999999999\tSID\tabc123",
  ".youtube.com\tTRUE\t/\tTRUE\t1999999999\tHSID\tdef456",
  ".google.com\tTRUE\t/\tTRUE\t1999999999\tNID\txyz",
].join("\n");

function mockStorage(): StorageAdapter & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    async uploadFromFilename() { return { ok: true }; },
    async uploadFromText(key: string, text: string) { store.set(key, text); return { ok: true }; },
    async downloadAsText(key: string) {
      const v = store.get(key);
      return v !== undefined ? { ok: true as const, value: v } : { ok: false as const, value: "" };
    },
    async downloadAsBytes() { return { ok: false, value: Buffer.alloc(0) }; },
    async downloadToFilename() { return { ok: false }; },
    async list() { return { ok: true, value: [] }; },
    async delete(key: string) { store.delete(key); return { ok: true }; },
  };
}

describe("cookieStore", () => {
  beforeEach(() => {
    _setStorageClientForTest(mockStorage());
    try { fs.unlinkSync(_LOCAL_COOKIES_PATH_FOR_TEST); } catch { /* absent */ }
    delete process.env.YTDLP_COOKIES_FILE;
  });
  afterEach(async () => {
    await deleteCookies();
    _setStorageClientForTest(null);
  });

  describe("validateCookiesText", () => {
    it("accepts a valid Netscape cookies.txt with youtube.com cookies", () => {
      const v = validateCookiesText(VALID_COOKIES);
      expect(v.ok).toBe(true);
      expect(v.youtubeCookieCount).toBe(2);
    });

    it("counts #HttpOnly_ prefixed youtube domains", () => {
      const v = validateCookiesText("#HttpOnly_.youtube.com\tTRUE\t/\tTRUE\t1999999999\tSSID\tzzz");
      expect(v.ok).toBe(true);
      expect(v.youtubeCookieCount).toBe(1);
    });

    it("rejects empty input", () => {
      expect(validateCookiesText("").ok).toBe(false);
    });

    it("rejects non-Netscape content (e.g. JSON export)", () => {
      const v = validateCookiesText('[{"domain":".youtube.com","name":"SID"}]');
      expect(v.ok).toBe(false);
      expect(v.error).toMatch(/Netscape/i);
    });

    it("rejects cookies without any youtube.com lines", () => {
      const v = validateCookiesText(".example.com\tTRUE\t/\tTRUE\t1999999999\tfoo\tbar");
      expect(v.ok).toBe(false);
      expect(v.error).toMatch(/youtube\.com/i);
    });

    it("does not match lookalike domains (notyoutube.com)", () => {
      const v = validateCookiesText(".notyoutube.com\tTRUE\t/\tTRUE\t1999999999\tfoo\tbar");
      expect(v.ok).toBe(false);
    });
  });

  describe("save/delete/status", () => {
    it("saves valid cookies, exposes them via args/status, and deletes cleanly", async () => {
      expect(getCookieStatus().configured).toBe(false);
      expect(getCookieArgs()).toEqual([]);

      const result = await saveCookies(VALID_COOKIES);
      expect(result.ok).toBe(true);
      expect(result.persisted).toBe(true);

      const status = getCookieStatus();
      expect(status.configured).toBe(true);
      expect(status.source).toBe("uploaded");
      expect(status.youtubeCookieCount).toBe(2);
      expect(getCookieArgs()).toEqual(["--cookies", _LOCAL_COOKIES_PATH_FOR_TEST]);

      // Local file must be private (0600)
      const mode = fs.statSync(_LOCAL_COOKIES_PATH_FOR_TEST).mode & 0o777;
      expect(mode).toBe(0o600);

      await deleteCookies();
      expect(getCookieStatus().configured).toBe(false);
      expect(getCookieArgs()).toEqual([]);
    });

    it("refuses to save invalid cookies", async () => {
      const result = await saveCookies("not a cookies file");
      expect(result.ok).toBe(false);
      expect(getCookieStatus().configured).toBe(false);
    });
  });

  describe("likely-expired tracking", () => {
    it("ignores bot blocks when no cookies are configured", () => {
      reportCookieBotBlock();
      expect(getCookieStatus().likelyExpired).toBe(false);
    });

    it("flags likelyExpired when a bot block hits with cookies configured", async () => {
      await saveCookies(VALID_COOKIES);
      expect(getCookieStatus().likelyExpired).toBe(false);
      reportCookieBotBlock();
      const s = getCookieStatus();
      expect(s.likelyExpired).toBe(true);
      expect(s.likelyExpiredAt).toBeTypeOf("number");
    });

    it("clears the flag on a successful cookie-backed call", async () => {
      await saveCookies(VALID_COOKIES);
      reportCookieBotBlock();
      expect(getCookieStatus().likelyExpired).toBe(true);
      reportCookieSuccess();
      expect(getCookieStatus().likelyExpired).toBe(false);
    });

    it("clears the flag when fresh cookies are uploaded", async () => {
      await saveCookies(VALID_COOKIES);
      reportCookieBotBlock();
      expect(getCookieStatus().likelyExpired).toBe(true);
      await saveCookies(VALID_COOKIES);
      expect(getCookieStatus().likelyExpired).toBe(false);
    });

    it("clears the flag when cookies are deleted", async () => {
      await saveCookies(VALID_COOKIES);
      reportCookieBotBlock();
      await deleteCookies();
      expect(getCookieStatus().likelyExpired).toBe(false);
    });
  });

  describe("likely-expired persistence across restarts", () => {
    const EXPIRED_KEY = ".private/ytdlp-cookies-expired.json";

    it("persists the marker to storage on bot block and removes it on success", async () => {
      const storage = mockStorage();
      _setStorageClientForTest(storage);
      await saveCookies(VALID_COOKIES);
      reportCookieBotBlock();
      await new Promise((r) => setTimeout(r, 10)); // persistence is fire-and-forget
      expect(storage.store.has(EXPIRED_KEY)).toBe(true);
      reportCookieSuccess();
      await new Promise((r) => setTimeout(r, 10));
      expect(storage.store.has(EXPIRED_KEY)).toBe(false);
    });

    it("restores likelyExpired after a simulated restart", async () => {
      const storage = mockStorage();
      _setStorageClientForTest(storage);
      const at = Date.now() - 60_000;
      storage.store.set(".private/ytdlp-cookies.txt", VALID_COOKIES);
      storage.store.set(EXPIRED_KEY, JSON.stringify({ likelyExpiredAt: at }));
      // No local cookies file, in-memory flag is null — like a fresh process.
      await restoreCookiesFromStorage();
      const s = getCookieStatus();
      expect(s.configured).toBe(true);
      expect(s.likelyExpired).toBe(true);
      expect(s.likelyExpiredAt).toBe(at);
    });

    it("cleans up a stale marker when no cookies are configured", async () => {
      const storage = mockStorage();
      _setStorageClientForTest(storage);
      storage.store.set(EXPIRED_KEY, JSON.stringify({ likelyExpiredAt: Date.now() }));
      await restoreCookiesFromStorage();
      await new Promise((r) => setTimeout(r, 10));
      expect(getCookieStatus().likelyExpired).toBe(false);
      expect(storage.store.has(EXPIRED_KEY)).toBe(false);
    });

    it("ignores a corrupt marker", async () => {
      const storage = mockStorage();
      _setStorageClientForTest(storage);
      storage.store.set(".private/ytdlp-cookies.txt", VALID_COOKIES);
      storage.store.set(EXPIRED_KEY, "not json");
      await restoreCookiesFromStorage();
      expect(getCookieStatus().configured).toBe(true);
      expect(getCookieStatus().likelyExpired).toBe(false);
    });
  });
});
