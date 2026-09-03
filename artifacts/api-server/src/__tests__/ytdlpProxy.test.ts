import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { ytdlpProxyArgs, isYouTubeTarget, redactProxySecrets, execYtdlp } from "../lib/ytdlpProxy";

const PROXY = "http://user:pass@p.example-proxy.io:80";

let saved: string | undefined;
beforeEach(() => { saved = process.env.YTDLP_PROXY; });
afterEach(() => {
  if (saved === undefined) delete process.env.YTDLP_PROXY;
  else process.env.YTDLP_PROXY = saved;
});

describe("ytdlpProxyArgs", () => {
  it("returns [] when YTDLP_PROXY is unset, even for YouTube", () => {
    delete process.env.YTDLP_PROXY;
    expect(ytdlpProxyArgs("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toEqual([]);
  });

  it("returns [] when YTDLP_PROXY is whitespace only", () => {
    process.env.YTDLP_PROXY = "   ";
    expect(ytdlpProxyArgs("https://youtu.be/dQw4w9WgXcQ")).toEqual([]);
  });

  it("adds --proxy for YouTube URLs when set", () => {
    process.env.YTDLP_PROXY = PROXY;
    for (const u of [
      "https://www.youtube.com/watch?v=zN_lhtJFsgg",
      "https://youtube.com/shorts/abc123DEF45",
      "https://youtu.be/zN_lhtJFsgg?si=xyz",
      "https://music.youtube.com/watch?v=abc",
      "https://m.youtube.com/watch?v=abc",
      "https://rr3---sn-gwpa.googlevideo.com/videoplayback?x=1",
    ]) {
      expect(ytdlpProxyArgs(u)).toEqual(["--proxy", PROXY]);
    }
  });

  it("adds --proxy for ytsearch expressions (searches hit youtube.com too)", () => {
    process.env.YTDLP_PROXY = PROXY;
    expect(ytdlpProxyArgs("ytsearch8:funny cricket moments")).toEqual(["--proxy", PROXY]);
    expect(ytdlpProxyArgs("ytsearch")).toEqual(["--proxy", PROXY]);
  });

  it("never proxies non-YouTube targets (protects paid per-GB bandwidth)", () => {
    process.env.YTDLP_PROXY = PROXY;
    for (const u of [
      "https://kick.com/video/abc",
      "https://d1abc.cloudfront.net/ivs/playlist.m3u8", // Kick IVS playlist
      "https://youtube-api-progress-copy.up.railway.app/api/download?id=x", // Zyla mirror
      "https://pub-abc.r2.dev/file.mp4",
      "https://www.dropbox.com/scl/fo/abc?rlkey=x",
      "https://example.com/notyoutube.com/video.mp4",
      "https://evilyoutube.com/watch?v=abc", // suffix trick must not match
      "not a url at all",
      "",
    ]) {
      expect(ytdlpProxyArgs(u)).toEqual([]);
    }
  });
});

describe("isYouTubeTarget", () => {
  it("matches YouTube hosts and subdomains only", () => {
    expect(isYouTubeTarget("https://www.youtube.com/watch?v=a")).toBe(true);
    expect(isYouTubeTarget("https://youtube-nocookie.com/embed/a")).toBe(true);
    expect(isYouTubeTarget("https://fakeyoutube.com/watch?v=a")).toBe(false);
    expect(isYouTubeTarget("https://youtube.com.evil.io/watch")).toBe(false);
  });
});

describe("redactProxySecrets", () => {
  it("scrubs user:pass credentials from command-failed messages", () => {
    const msg =
      "Command failed: /bin/yt-dlp --proxy http://alice:s3cret@p.webshare.io:80 https://youtube.com/watch?v=a\nERROR: timeout";
    const out = redactProxySecrets(msg);
    expect(out).not.toContain("s3cret");
    expect(out).not.toContain("alice:");
    expect(out).toContain("***:***@p.webshare.io:80");
    expect(out).toContain("ERROR: timeout"); // rest of the text is preserved
  });

  it("scrubs the exact configured proxy even without a user:pass shape", () => {
    process.env.YTDLP_PROXY = "http://plainhost.example:8080";
    const out = redactProxySecrets("connect failed via http://plainhost.example:8080 boom");
    expect(out).not.toContain("plainhost.example:8080");
    expect(out).toContain("[proxy redacted]");
  });

  it("leaves credential-free text untouched", () => {
    delete process.env.YTDLP_PROXY;
    const msg = "ERROR: [youtube] zN_lhtJFsgg: Sign in to confirm you're not a bot";
    expect(redactProxySecrets(msg)).toBe(msg);
  });
});

describe("execYtdlp", () => {
  it("scrubs credentials from exec failure messages", async () => {
    const cred = "http://user:pass@proxyhost.example:80";
    let caught: Error | null = null;
    try {
      // node exits non-zero; the extra arg lands in the "Command failed:" message.
      await execYtdlp(process.execPath, ["-e", "process.exit(3)", cred]);
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).not.toBeNull();
    expect(caught!.message).toContain("***:***@proxyhost.example:80");
    expect(caught!.message).not.toContain("user:pass");
  });

  it("returns stdout on success", async () => {
    const { stdout } = await execYtdlp(process.execPath, ["-e", "console.log('ok')"]);
    expect(stdout.trim()).toBe("ok");
  });
});
