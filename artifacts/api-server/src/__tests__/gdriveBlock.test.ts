/**
 * Drive block-page classification — the difference between "10 days of silent
 * post failures" and an instant, actionable error at campaign creation.
 * Page texts mirror real Drive responses observed live (Aug 2026).
 */
import { describe, it, expect, afterEach } from "vitest";
import {
  classifyGDriveBlockPage, probeGDriveDownloadBlocked, GDRIVE_LOCK_MESSAGE,
} from "../lib/gdriveBlock";

const LOCK_HTML =
  `<!DOCTYPE html><html><head><title>Google Drive - Can&#39;t download file</title></head>` +
  `<body>Sorry, the owner hasn&#39;t given you permission to download this file. ` +
  `Only the owner and editors can download this file.</body></html>`;
const QUOTA_HTML =
  `<html><body>Sorry, you can't view or download this file at this time. ` +
  `Too many users have viewed or downloaded this file recently.</body></html>`;
const SCAN_HTML =
  `<html><body>Google Drive can't scan this file for viruses. ` +
  `<form action="https://drive.usercontent.google.com/download"><input name="confirm" value="t"></form></body></html>`;

describe("classifyGDriveBlockPage", () => {
  it("detects the 'viewers can't download' lock (entity-encoded apostrophes)", () => {
    expect(classifyGDriveBlockPage(LOCK_HTML)).toBe("download-locked");
  });

  it("detects the download-quota page", () => {
    expect(classifyGDriveBlockPage(QUOTA_HTML)).toBe("quota");
  });

  it("virus-scan interstitial is NOT a block — the confirm flow handles it", () => {
    expect(classifyGDriveBlockPage(SCAN_HTML)).toBeNull();
  });

  it("random html is not a block", () => {
    expect(classifyGDriveBlockPage("<html><body>hello world</body></html>")).toBeNull();
  });
});

describe("probeGDriveDownloadBlocked", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; });

  const FILE_ID = "1AbCdEfGhIjKlMnOpQrStU";

  it("returns the lock message for a download-locked file", async () => {
    globalThis.fetch = (async () =>
      new Response(LOCK_HTML, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } })
    ) as typeof fetch;
    expect(await probeGDriveDownloadBlocked(FILE_ID)).toBe(GDRIVE_LOCK_MESSAGE);
  });

  it("returns null when real bytes are served", async () => {
    globalThis.fetch = (async () =>
      new Response(new Uint8Array([0, 0, 0, 1]), { status: 200, headers: { "content-type": "video/mp4" } })
    ) as typeof fetch;
    expect(await probeGDriveDownloadBlocked(FILE_ID)).toBeNull();
  });

  it("fails open on network errors — never blocks a flow on our hiccup", async () => {
    globalThis.fetch = (async () => { throw new Error("boom"); }) as typeof fetch;
    expect(await probeGDriveDownloadBlocked(FILE_ID)).toBeNull();
  });

  it("fails open on quota pages (transient — not a creation blocker)", async () => {
    globalThis.fetch = (async () =>
      new Response(QUOTA_HTML, { status: 200, headers: { "content-type": "text/html" } })
    ) as typeof fetch;
    expect(await probeGDriveDownloadBlocked(FILE_ID)).toBeNull();
  });
});
