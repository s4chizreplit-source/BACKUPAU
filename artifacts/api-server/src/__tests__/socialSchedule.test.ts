/**
 * Pure-logic tests for the bulk social scheduler — slot math, timezone
 * conversion, input validation and URL handling. No network, no DB writes.
 */
import { describe, it, expect } from "vitest";
import {
  zonedTimeToUtc,
  computeSlots,
  isRealDate,
  isBlockedHost,
  dropboxDirect,
  prettyName,
} from "../routes/social";
import { titleFromCaption } from "../lib/postforme";

describe("titleFromCaption", () => {
  it("uses the hook line as-is, keeping emoji", () => {
    expect(titleFromCaption("Wait for it… 🤯\n\n#viral #fyp")).toBe("Wait for it… 🤯");
  });
  it("skips hashtag-only lines and finds the real hook", () => {
    expect(titleFromCaption("#viral #fyp #shorts\nYeh moment miss mat karna 🔥")).toBe("Yeh moment miss mat karna 🔥");
  });
  it("returns undefined when nothing usable (caller falls back to label)", () => {
    expect(titleFromCaption(undefined)).toBeUndefined();
    expect(titleFromCaption("")).toBeUndefined();
    expect(titleFromCaption("#a #b\n\n#c @mention")).toBeUndefined();
  });
  it("caps the title at 95 chars", () => {
    expect(titleFromCaption("x".repeat(200))?.length).toBe(95);
  });
});

describe("zonedTimeToUtc", () => {
  it("converts IST wall time (no DST) to UTC", () => {
    expect(zonedTimeToUtc("2026-08-11", "18:00", "Asia/Kolkata").toISOString())
      .toBe("2026-08-11T12:30:00.000Z");
  });
  it("handles US Eastern winter (EST, UTC-5)", () => {
    expect(zonedTimeToUtc("2026-01-15", "18:00", "America/New_York").toISOString())
      .toBe("2026-01-15T23:00:00.000Z");
  });
  it("handles US Eastern summer (EDT, UTC-4)", () => {
    expect(zonedTimeToUtc("2026-07-15", "18:00", "America/New_York").toISOString())
      .toBe("2026-07-15T22:00:00.000Z");
  });
  it("passes UTC through unchanged", () => {
    expect(zonedTimeToUtc("2026-08-11", "06:15", "UTC").toISOString())
      .toBe("2026-08-11T06:15:00.000Z");
  });
});

describe("computeSlots", () => {
  it("spreads videos day by day across sorted times", () => {
    const slots = computeSlots(5, "2027-01-01", ["18:00", "09:00"], "UTC");
    expect(slots).toHaveLength(5);
    expect(slots[0].toISOString()).toBe("2027-01-01T09:00:00.000Z");
    expect(slots[1].toISOString()).toBe("2027-01-01T18:00:00.000Z");
    expect(slots[2].toISOString()).toBe("2027-01-02T09:00:00.000Z");
    expect(slots[3].toISOString()).toBe("2027-01-02T18:00:00.000Z");
    expect(slots[4].toISOString()).toBe("2027-01-03T09:00:00.000Z");
  });
  it("skips slots already in the past and still fills the batch", () => {
    const slots = computeSlots(2, "2020-01-01", ["18:00"], "UTC");
    expect(slots).toHaveLength(2);
    expect(slots[0].getTime()).toBeGreaterThan(Date.now());
  });
  it("returns strictly ascending instants", () => {
    const slots = computeSlots(10, "2027-06-01", ["23:00", "01:00", "12:00"], "Asia/Kolkata");
    expect(slots).toHaveLength(10);
    for (let i = 1; i < slots.length; i++) {
      expect(slots[i].getTime()).toBeGreaterThan(slots[i - 1].getTime());
    }
  });
});

describe("isRealDate", () => {
  it.each(["2026-08-11", "2028-02-29", "2030-12-31"])("accepts real date %s", (s) => {
    expect(isRealDate(s)).toBe(true);
  });
  it.each([
    "2026-99-99", "2026-02-30", "2027-02-29", "2026-00-10",
    "2019-01-01", "2101-01-01", "not-a-date", "2026-8-1",
  ])("rejects %s", (s) => {
    expect(isRealDate(s)).toBe(false);
  });
});

describe("isBlockedHost", () => {
  it.each([
    "localhost", "127.0.0.1", "10.0.0.5", "172.16.9.1", "172.31.255.1",
    "192.168.1.1", "169.254.10.10", "100.64.0.1", "0.0.0.0", "224.0.0.1",
    "myserver", "foo.local", "api.internal", "::1", "fe80::1",
  ])("blocks private/internal host %s", (h) => {
    expect(isBlockedHost(h)).toBe(true);
  });
  it.each(["cdn.example.com", "8.8.8.8", "172.15.0.1", "172.32.0.1", "s3.amazonaws.com"])(
    "allows public host %s",
    (h) => { expect(isBlockedHost(h)).toBe(false); },
  );
});

describe("dropboxDirect", () => {
  it("converts a file share link to a direct-download URL", () => {
    const d = dropboxDirect("https://www.dropbox.com/scl/fi/abc123/My%20Video.mp4?rlkey=xyz&dl=0");
    expect(d).not.toBeNull();
    expect(d!.name).toBe("My Video.mp4");
    const u = new URL(d!.url);
    expect(u.hostname).toBe("dl.dropboxusercontent.com");
    expect(u.searchParams.get("dl")).toBeNull();
    expect(u.searchParams.get("rlkey")).toBe("xyz"); // needed for access
  });
  it("rejects folder links without ?preview (can't enumerate)", () => {
    expect(dropboxDirect("https://www.dropbox.com/scl/fo/folder123/h?rlkey=abc&dl=0")).toBeNull();
  });
  it("uses the ?preview file for folder links", () => {
    const d = dropboxDirect("https://www.dropbox.com/scl/fo/folder123/h?rlkey=abc&preview=clip.mp4");
    expect(d).not.toBeNull();
    expect(d!.name).toBe("clip.mp4");
    const u = new URL(d!.url);
    expect(u.hostname).toBe("dl.dropboxusercontent.com");
    expect(u.searchParams.get("preview")).toBeNull();
  });
  it("accepts a file-inside-folder link (real /scl/fo/…/file.mp4 shape)", () => {
    const d = dropboxDirect(
      "https://www.dropbox.com/scl/fo/2i3r7as95n8wo7p0ij0u1/AD8GHgxNzxBtIJ9dPdJT65E/Hell%20Grind%20Film/HELLGRIND_film.mp4?rlkey=os6od2pw9hb6up4bzez6jtzbc&st=dcn0eq2g&dl=0",
    );
    expect(d).not.toBeNull();
    expect(d!.name).toBe("HELLGRIND_film.mp4");
    const u = new URL(d!.url);
    expect(u.hostname).toBe("dl.dropboxusercontent.com");
    expect(u.pathname).toBe("/scl/fo/2i3r7as95n8wo7p0ij0u1/AD8GHgxNzxBtIJ9dPdJT65E/Hell%20Grind%20Film/HELLGRIND_film.mp4");
    expect(u.searchParams.get("rlkey")).toBe("os6od2pw9hb6up4bzez6jtzbc"); // access param must survive
    expect(u.searchParams.get("st")).toBe("dcn0eq2g");
    expect(u.searchParams.get("dl")).toBeNull();
  });
  it("decodes URL-encoded file names inside folders", () => {
    const d = dropboxDirect("https://www.dropbox.com/scl/fo/id123/key456/Sub%20Folder/My%20Clip.mp4?rlkey=r");
    expect(d).not.toBeNull();
    expect(d!.name).toBe("My Clip.mp4");
  });
  it("still rejects subfolder links (path ends in a folder, not a file)", () => {
    expect(dropboxDirect("https://www.dropbox.com/scl/fo/id123/key456/Hell%20Grind%20Film?rlkey=r&dl=0")).toBeNull();
  });
  it("rejects non-video files", () => {
    expect(dropboxDirect("https://www.dropbox.com/scl/fi/abc/notes.pdf?rlkey=x")).toBeNull();
  });
});

describe("prettyName", () => {
  it("turns a file name into a readable caption", () => {
    expect(prettyName("my_best-clip_01.mp4")).toBe("my best clip 01");
  });
});

// ── SSRF: DNS-resolving public-URL check (injectable lookup, no network) ─────
import { urlResolvesPublic } from "../lib/ssrfGuard";

describe("urlResolvesPublic (SSRF DNS check)", () => {
  const fake = (ips: string[]) => async () => ips.map((address) => ({ address }));

  it("blocks literal private/metadata hosts without resolving", async () => {
    expect(await urlResolvesPublic("http://127.0.0.1/x.mp4")).toBe(false);
    expect(await urlResolvesPublic("http://localhost/x.mp4")).toBe(false);
    expect(await urlResolvesPublic("http://169.254.169.254/latest/meta-data")).toBe(false);
    expect(await urlResolvesPublic("http://[::1]/x.mp4")).toBe(false);
    expect(await urlResolvesPublic("ftp://cdn.example.com/x.mp4")).toBe(false);
  });

  it("public-looking hostname resolving to a private IP → blocked", async () => {
    expect(await urlResolvesPublic("https://cdn.example.com/v.mp4", fake(["10.0.0.7"]))).toBe(false);
    expect(await urlResolvesPublic("https://cdn.example.com/v.mp4", fake(["::ffff:7f00:1"]))).toBe(false);
    // one private address taints the whole answer set (rebinding round-robin)
    expect(await urlResolvesPublic("https://cdn.example.com/v.mp4", fake(["93.184.216.34", "192.168.1.5"]))).toBe(false);
  });

  it("all-public resolution passes; resolver failure fails closed", async () => {
    expect(await urlResolvesPublic("https://cdn.example.com/v.mp4", fake(["93.184.216.34"]))).toBe(true);
    expect(await urlResolvesPublic("https://cdn.example.com/v.mp4", fake(["93.184.216.34", "2606:2800:220:1:248:1893:25c8:1946"]))).toBe(true);
    expect(await urlResolvesPublic("https://gone.example.com/v.mp4", async () => { throw new Error("NXDOMAIN"); })).toBe(false);
    expect(await urlResolvesPublic("https://empty.example.com/v.mp4", fake([]))).toBe(false);
  });
});
