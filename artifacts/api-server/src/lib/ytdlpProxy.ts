/** Residential-proxy support for yt-dlp YouTube traffic.
 *
 *  When YTDLP_PROXY is set (e.g. `http://user:pass@p.webshare.io:80`),
 *  YouTube-targeting yt-dlp invocations get `--proxy <url>` so requests leave
 *  through a residential IP instead of the datacenter IP YouTube bot-checks
 *  ("Sign in to confirm you're not a bot").
 *
 *  The proxy is deliberately applied ONLY to YouTube targets: routing Kick
 *  VODs, IVS playlists, Zyla R2 mirrors, or direct-file downloads through a
 *  per-GB residential proxy would burn paid bandwidth on hosts that never
 *  bot-block this server. Non-YouTube targets always return no args.
 *
 *  SECURITY: the proxy URL carries credentials and lands on the yt-dlp
 *  command line, and Node's execFile failure messages embed the full command.
 *  Every yt-dlp invocation must therefore go through `execYtdlp`, which
 *  scrubs credentials out of the error (message/stack/cmd/stderr/stdout) at
 *  birth — before any log line, job record, or API response can pick it up.
 */
import { execFile, type ExecFileOptions } from "child_process";
import { promisify } from "util";

const execFileP = promisify(execFile);

/** True when the yt-dlp target is YouTube: a youtube.com / youtu.be /
 *  googlevideo.com URL, or a `ytsearchN:` search expression (those hit
 *  youtube.com too and get bot-checked the same way). */
export function isYouTubeTarget(target: string): boolean {
  const t = target.trim();
  if (/^ytsearch/i.test(t)) return true;
  try {
    const host = new URL(t).hostname.toLowerCase().replace(/^www\./, "");
    return (
      host === "youtube.com" || host.endsWith(".youtube.com") ||
      host === "youtu.be" ||
      host === "youtube-nocookie.com" || host.endsWith(".youtube-nocookie.com") ||
      host === "googlevideo.com" || host.endsWith(".googlevideo.com")
    );
  } catch {
    return false;
  }
}

/** yt-dlp args routing this invocation through the configured residential
 *  proxy — `[]` when YTDLP_PROXY is unset or the target is not YouTube.
 *  Reads the env at call time so tests (and future hot config) stay simple. */
export function ytdlpProxyArgs(targetUrl: string): string[] {
  const proxy = (process.env.YTDLP_PROXY || "").trim();
  if (!proxy) return [];
  if (!isYouTubeTarget(targetUrl)) return [];
  return ["--proxy", proxy];
}

/** Matches `scheme://user:pass@` credentials embedded in any URL. */
const CRED_URL_RE = /([a-z][a-z0-9+.-]*:\/\/)([^/\s@:]+):([^/\s@]+)@/gi;

/** Scrub proxy credentials from free text (error messages, stderr, argv
 *  echoes). Replaces `scheme://user:pass@` with `scheme://***:***@` and, as a
 *  belt-and-braces, blanks the exact configured YTDLP_PROXY value even when
 *  it has no user:pass shape. */
export function redactProxySecrets(text: string): string {
  if (!text) return text;
  let out = text.replace(CRED_URL_RE, "$1***:***@");
  const proxy = (process.env.YTDLP_PROXY || "").trim();
  if (proxy && out.includes(proxy)) out = out.split(proxy).join("[proxy redacted]");
  return out;
}

/** Scrub credential-bearing strings on an Error in place (execFile attaches
 *  cmd/stderr/stdout as extra enumerable props that loggers serialize). */
function scrubProxyError(err: unknown): unknown {
  if (err && typeof err === "object") {
    const e = err as Record<string, unknown>;
    for (const k of ["message", "stack", "cmd", "stderr", "stdout", "shortMessage"]) {
      if (typeof e[k] === "string") {
        try { e[k] = redactProxySecrets(e[k] as string); } catch { /* read-only prop — skip */ }
      }
    }
  }
  return err;
}

/** execFile for yt-dlp with credential-safe failures: any thrown error is
 *  scrubbed of proxy credentials before it propagates. All yt-dlp call sites
 *  must use this instead of a raw promisified execFile. */
export async function execYtdlp(
  bin: string,
  args: string[],
  options?: ExecFileOptions & { maxBuffer?: number },
): Promise<{ stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileP(bin, args, options ?? {});
    return { stdout: String(stdout), stderr: String(stderr) };
  } catch (err) {
    throw scrubProxyError(err);
  }
}
