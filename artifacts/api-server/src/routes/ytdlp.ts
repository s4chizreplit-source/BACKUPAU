import { Router, type IRouter } from "express";
import { spawn } from "child_process";
import { randomUUID } from "crypto";
import path from "path";
import os from "os";
import fs from "fs";
import { isSafePublicUrl } from "../lib/ssrfGuard";
import { getCookieArgs } from "../lib/cookieStore";
import { ytdlpProxyArgs, execYtdlp, redactProxySecrets } from "../lib/ytdlpProxy";

const router: IRouter = Router();

// Use YTDLP_PATH env var in production (binary downloaded during build);
// fall back to bare "yt-dlp" which works when it's on PATH (dev/Nix).
const YTDLP_BIN = process.env.YTDLP_PATH || "yt-dlp";

// ── Download concurrency semaphore ────────────────────────────────────────────
// Cap simultaneous yt-dlp spawn processes so the server doesn't get overwhelmed
// by network + CPU at high request volumes. Downloads are mostly network-bound
// but the final mux/merge burns CPU — 15 at once is fine on a big machine, too
// many for a 2-4 core VPS, so the default scales with cores (env-overridable).
const DL_CPUS = os.availableParallelism?.() ?? os.cpus().length;
const MAX_CONCURRENT_DOWNLOADS = Math.max(1, Number.parseInt(
  process.env.YTDLP_MAX_CONCURRENT ?? String(Math.min(15, Math.max(4, DL_CPUS * 2))),
  10) || 1);
let activeDownloads = 0;
const downloadQueue: Array<() => void> = [];

function acquireDownloadSlot(): Promise<void> {
  return new Promise(resolve => {
    if (activeDownloads < MAX_CONCURRENT_DOWNLOADS) {
      activeDownloads++;
      resolve();
    } else {
      downloadQueue.push(() => { activeDownloads++; resolve(); });
    }
  });
}
function releaseDownloadSlot() {
  activeDownloads--;
  downloadQueue.shift()?.();
}

// ── Download job store ─────────────────────────────────────────────────────────

interface DownloadJob {
  status: "running" | "done" | "error";
  tmpDir: string;
  filePath?: string;
  filename?: string;
  ext?: string;
  errorInfo?: YtdlpErrorInfo;
  /** Progress/status lines accumulated so far (for clients that connect late). */
  lines: string[];
  /** Subscribers waiting for new lines. */
  listeners: Set<(line: string) => void>;
  /** Timeout handle for TTL-based cleanup. */
  cleanupTimer?: ReturnType<typeof setTimeout>;
  /** The running yt-dlp child process (present only while status === "running"). */
  proc?: ReturnType<typeof spawn>;
}

const jobs = new Map<string, DownloadJob>();

/**
 * TTL applied AFTER a job reaches a terminal state (done / error).
 * Jobs that are still running are never evicted by this timer.
 */
const JOB_TTL_AFTER_DONE_MS = 15 * 60 * 1000; // 15 minutes

function scheduleJobCleanup(jobId: string) {
  const job = jobs.get(jobId);
  if (!job) return;
  // Only start the timer for terminal states
  if (job.status === "running") return;
  if (job.cleanupTimer) clearTimeout(job.cleanupTimer);
  job.cleanupTimer = setTimeout(() => {
    const j = jobs.get(jobId);
    if (j) {
      try { fs.rmSync(j.tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
      jobs.delete(jobId);
    }
  }, JOB_TTL_AFTER_DONE_MS);
}

function pushJobLine(job: DownloadJob, line: string) {
  job.lines.push(line);
  for (const fn of job.listeners) fn(line);
}

// ── Error classification ───────────────────────────────────────────────────────

interface YtdlpErrorInfo {
  userMessage: string;
  code: string;
  /** HTTP status to return: 422 for rejected URLs, 504 for network/timeout, 500 for unexpected */
  status: number;
}

function classifyYtdlpError(stderr: string, fallback: string): YtdlpErrorInfo {
  const text = (stderr + "\n" + fallback).toLowerCase();

  if (text.includes("private video") || text.includes("video is private")) {
    return { userMessage: "This video is private.", code: "PRIVATE_VIDEO", status: 422 };
  }
  if (
    text.includes("members-only") ||
    text.includes("members only") ||
    text.includes("join this channel")
  ) {
    return {
      userMessage: "This video is for channel members only.",
      code: "MEMBERS_ONLY",
      status: 422,
    };
  }
  if (
    text.includes("age-restricted") ||
    text.includes("age restricted") ||
    text.includes("sign in to confirm your age")
  ) {
    return {
      userMessage: "This video is age-restricted and cannot be downloaded without sign-in.",
      code: "AGE_RESTRICTED",
      status: 422,
    };
  }
  if (
    text.includes("not available in your country") ||
    text.includes("geo") ||
    (text.includes("blocked") && text.includes("country"))
  ) {
    return {
      userMessage: "This video is not available in the server's region (geo-blocked).",
      code: "GEO_BLOCKED",
      status: 422,
    };
  }
  if (
    text.includes("video unavailable") ||
    text.includes("has been removed") ||
    text.includes("no longer available") ||
    text.includes("account has been terminated")
  ) {
    return {
      userMessage: "This video is unavailable or has been removed.",
      code: "VIDEO_UNAVAILABLE",
      status: 422,
    };
  }
  if (
    text.includes("copyright") ||
    text.includes("takedown") ||
    text.includes("content warning")
  ) {
    return {
      userMessage: "This video has been removed due to a copyright claim.",
      code: "COPYRIGHT",
      status: 422,
    };
  }
  if (
    text.includes("unsupported url") ||
    text.includes("no suitable") ||
    text.includes("no video formats") ||
    text.includes("is not a valid url") ||
    text.includes("unable to extract")
  ) {
    return {
      userMessage: "This URL is not supported. Make sure it points to a video page.",
      code: "UNSUPPORTED_URL",
      status: 422,
    };
  }
  if (
    text.includes("timed out") ||
    text.includes("timeout") ||
    text.includes("connection refused") ||
    text.includes("network") ||
    text.includes("ssl")
  ) {
    return {
      userMessage: "Connection timed out reaching the video source. Try again later.",
      code: "NETWORK_ERROR",
      status: 504,
    };
  }

  // Extract the last meaningful line from stderr for display
  const meaningful = stderr
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("[debug]") && !l.startsWith("WARNING:"))
    .slice(-3)
    .join(" ");

  return {
    userMessage: meaningful || "An unexpected error occurred. Please try a different URL.",
    code: "UNKNOWN",
    status: 500,
  };
}


function validateUrl(url: string): boolean {
  return isSafePublicUrl(url);
}

// GET /ytdlp/info?url=...
router.get("/ytdlp/info", async (req, res): Promise<void> => {

  const url = Array.isArray(req.query.url) ? req.query.url[0] : req.query.url;

  if (!url || typeof url !== "string") {
    res.status(400).json({ error: "Missing required query param: url" });
    return;
  }

  if (!validateUrl(url)) {
    res.status(400).json({ error: "Invalid URL" });
    return;
  }

  req.log.info({ url }, "Fetching video info");

  try {
    const { stdout } = await execYtdlp(YTDLP_BIN, [
      "--dump-json",
      "--no-playlist",
      "--no-warnings",
      "--js-runtimes",    "node",
      "--extractor-args", "youtube:player_client=tv_embedded,mweb,ios",
      ...getCookieArgs(),
      ...ytdlpProxyArgs(url),
      url,
    ], { maxBuffer: 64 * 1024 * 1024, timeout: 90_000 });

    const info = JSON.parse(stdout);

    res.json({
      id: info.id,
      title: info.title,
      description: info.description ?? null,
      uploader: info.uploader ?? null,
      duration: info.duration ?? null,
      view_count: info.view_count ?? null,
      like_count: info.like_count ?? null,
      upload_date: info.upload_date ?? null,
      thumbnail: info.thumbnail ?? null,
      webpage_url: info.webpage_url,
      extractor: info.extractor,
    });
  } catch (err: unknown) {
    const message = redactProxySecrets(err instanceof Error ? err.message : String(err));
    const stderr = redactProxySecrets((err as { stderr?: string }).stderr ?? "");
    req.log.error({ err: message, stderr }, "yt-dlp info failed");
    const { userMessage, code, status } = classifyYtdlpError(stderr, message);
    res.status(status).json({ error: userMessage, code });
  }
});

// GET /ytdlp/formats?url=...
router.get("/ytdlp/formats", async (req, res): Promise<void> => {

  const url = Array.isArray(req.query.url) ? req.query.url[0] : req.query.url;

  if (!url || typeof url !== "string") {
    res.status(400).json({ error: "Missing required query param: url" });
    return;
  }

  if (!validateUrl(url)) {
    res.status(400).json({ error: "Invalid URL" });
    return;
  }

  req.log.info({ url }, "Fetching video formats");

  try {
    const { stdout } = await execYtdlp(YTDLP_BIN, [
      "--dump-json",
      "--no-playlist",
      "--no-warnings",
      "--js-runtimes",    "node",
      "--extractor-args", "youtube:player_client=tv_embedded,mweb,ios",
      ...getCookieArgs(),
      ...ytdlpProxyArgs(url),
      url,
    ], { maxBuffer: 64 * 1024 * 1024, timeout: 90_000 });

    const info = JSON.parse(stdout);

    const formats = (info.formats ?? []).map((f: Record<string, unknown>) => ({
      format_id: f.format_id,
      format_note: f.format_note ?? undefined,
      ext: f.ext,
      resolution: f.resolution ?? (f.width && f.height ? `${f.width}x${f.height}` : "audio only"),
      fps: f.fps ?? null,
      filesize: f.filesize ?? null,
      tbr: f.tbr ?? null,
      vcodec: f.vcodec ?? null,
      acodec: f.acodec ?? null,
      url: null, // omit direct URLs for security
    }));

    res.json({
      id: info.id,
      title: info.title,
      formats,
    });
  } catch (err: unknown) {
    const message = redactProxySecrets(err instanceof Error ? err.message : String(err));
    const stderr = redactProxySecrets((err as { stderr?: string }).stderr ?? "");
    req.log.error({ err: message, stderr }, "yt-dlp formats failed");
    const { userMessage, code, status } = classifyYtdlpError(stderr, message);
    res.status(status).json({ error: userMessage, code });
  }
});

// POST /ytdlp/download
// Starts a yt-dlp download job and returns a jobId.
// The client then opens GET /ytdlp/progress/:jobId (SSE) to watch progress,
// and fetches GET /ytdlp/file/:jobId once the "done" event fires.
router.post("/ytdlp/download", async (req, res): Promise<void> => {

  const { url, format = "best", audio_only = false } = req.body as {
    url?: string;
    format?: string;
    audio_only?: boolean;
  };

  if (!url || typeof url !== "string") {
    res.status(400).json({ error: "Missing required field: url" });
    return;
  }

  if (!validateUrl(url)) {
    res.status(400).json({ error: "Invalid URL" });
    return;
  }

  const jobId = randomUUID();
  req.log.info({ url, format, audio_only, jobId }, "Starting download job");

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ytdlp-"));
  const outputTemplate = path.join(tmpDir, "%(title)s.%(ext)s");

  const args: string[] = [
    "--no-playlist",
    "--no-warnings",
    "--newline",          // emit progress on separate lines (not \r)
    ...ytdlpProxyArgs(url),
    "-o", outputTemplate,
  ];

  if (audio_only) {
    args.push("-x", "--audio-format", "mp3");
  } else {
    args.push("-f", format);
  }
  args.push(url);

  const job: DownloadJob = {
    status: "running",
    tmpDir,
    lines: [],
    listeners: new Set(),
  };
  jobs.set(jobId, job);
  // NOTE: do NOT call scheduleJobCleanup here — the TTL only starts once the
  // job reaches a terminal state (done / error), so long-running downloads are
  // never evicted while still in progress.

  // Spawn yt-dlp in the background — do NOT await here so the POST returns fast.
  (async () => {
    await acquireDownloadSlot();
    try {
      await new Promise<void>((resolve, reject) => {
        const proc = spawn(YTDLP_BIN, args);
        job.proc = proc;
        let stderrBuf = "";

        // Forward stdout progress lines to all SSE listeners
        let stdoutPartial = "";
        proc.stdout?.on("data", (chunk: Buffer) => {
          stdoutPartial += chunk.toString();
          const lines = stdoutPartial.split("\n");
          stdoutPartial = lines.pop() ?? "";
          for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed) pushJobLine(job, trimmed);
          }
        });

        proc.stderr?.on("data", (chunk: Buffer) => {
          stderrBuf += chunk.toString();
          // Also forward stderr lines so the client sees warnings/status
          const text = chunk.toString();
          for (const line of text.split("\n")) {
            const trimmed = line.trim();
            if (trimmed) pushJobLine(job, trimmed);
          }
        });

        proc.on("close", (code) => {
          if (code === 0) resolve();
          else {
            const err = new Error(`yt-dlp exited with code ${code}`) as Error & { stderr: string };
            err.stderr = stderrBuf;
            reject(err);
          }
        });
        proc.on("error", reject);
      });

      const files = fs.readdirSync(tmpDir);
      if (files.length === 0) {
        job.status = "error";
        job.errorInfo = { userMessage: "No file was produced by yt-dlp. The format may be unavailable.", code: "NO_OUTPUT", status: 500 };
        pushJobLine(job, "__error__");
        releaseDownloadSlot();
        scheduleJobCleanup(jobId); // TTL starts now that job is terminal
        return;
      }

      const filePath = path.join(tmpDir, files[0]);
      job.filePath = filePath;
      job.filename = path.basename(filePath);
      job.ext = path.extname(filePath).slice(1);
      job.status = "done";
      pushJobLine(job, "__done__");
      releaseDownloadSlot();
      scheduleJobCleanup(jobId); // TTL starts now that job is terminal
    } catch (err: unknown) {
      const message = redactProxySecrets(err instanceof Error ? err.message : String(err));
      const stderr = redactProxySecrets((err as { stderr?: string }).stderr ?? "");
      req.log.error({ err: message, stderr, jobId }, "yt-dlp download job failed");
      job.status = "error";
      job.errorInfo = classifyYtdlpError(stderr, message);
      pushJobLine(job, "__error__");
      releaseDownloadSlot();
      scheduleJobCleanup(jobId); // TTL starts now that job is terminal
    }
  })();

  res.json({ jobId });
});

// GET /ytdlp/progress/:jobId  — SSE stream of yt-dlp output lines
// Sends events until the job is done or errors out, then closes.
router.get("/ytdlp/progress/:jobId", (req, res): void => {

  const { jobId } = req.params;
  const job = jobs.get(jobId);

  if (!job) {
    res.status(404).json({ error: "Job not found" });
    return;
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no"); // disable nginx buffering if present
  res.flushHeaders();

  // Emit a named SSE event so EventSource.addEventListener(type, ...) fires correctly.
  // Format: "event: <type>\ndata: <json>\n\n"
  function sendEvent(type: string, payload: Record<string, unknown>) {
    res.write(`event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`);
  }

  // Replay any lines already buffered (handles late-connecting clients)
  for (const line of job.lines) {
    if (line === "__done__") {
      sendEvent("done", { filename: job.filename, ext: job.ext });
      res.end();
      return;
    } else if (line === "__error__") {
      sendEvent("error", {
        error: job.errorInfo?.userMessage ?? "Download failed",
        code: job.errorInfo?.code ?? "UNKNOWN",
      });
      res.end();
      return;
    } else {
      sendEvent("progress", { line });
    }
  }

  // If already finished before we got here (after replay)
  if (job.status === "done") {
    sendEvent("done", { filename: job.filename, ext: job.ext });
    res.end();
    return;
  }
  if (job.status === "error") {
    sendEvent("error", {
      error: job.errorInfo?.userMessage ?? "Download failed",
      code: job.errorInfo?.code ?? "UNKNOWN",
    });
    res.end();
    return;
  }

  // Subscribe to future lines
  function onLine(line: string) {
    if (line === "__done__") {
      sendEvent("done", { filename: job!.filename, ext: job!.ext });
      cleanup();
      res.end();
    } else if (line === "__error__") {
      sendEvent("error", {
        error: job!.errorInfo?.userMessage ?? "Download failed",
        code: job!.errorInfo?.code ?? "UNKNOWN",
      });
      cleanup();
      res.end();
    } else {
      sendEvent("progress", { line });
    }
  }

  function cleanup() {
    job!.listeners.delete(onLine);
  }

  function onClientDisconnect() {
    cleanup();
    const j = jobs.get(jobId);
    if (!j) return;
    // Only abort if the job is still running (client disconnected mid-download)
    if (j.status === "running") {
      req.log.info({ jobId }, "SSE client disconnected during download — killing yt-dlp process");
      if (j.proc) {
        try { j.proc.kill("SIGTERM"); } catch { /* already exited */ }
      }
      // Clean up the temp dir immediately rather than waiting for TTL
      if (j.cleanupTimer) clearTimeout(j.cleanupTimer);
      jobs.delete(jobId);
      try { fs.rmSync(j.tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }

  job.listeners.add(onLine);
  req.on("close", onClientDisconnect);
});

// GET /ytdlp/file/:jobId  — streams the completed file to the browser
router.get("/ytdlp/file/:jobId", (req, res): void => {

  const { jobId } = req.params;
  const job = jobs.get(jobId);

  if (!job) {
    res.status(404).json({ error: "Job not found or expired" });
    return;
  }
  if (job.status === "running") {
    res.status(409).json({ error: "Download still in progress" });
    return;
  }
  if (job.status === "error") {
    const info = job.errorInfo!;
    res.status(info.status).json({ error: info.userMessage, code: info.code });
    return;
  }

  const filePath = job.filePath!;
  const filename = job.filename!;
  const ext = job.ext!;

  const mimeTypes: Record<string, string> = {
    mp4: "video/mp4",
    webm: "video/webm",
    mkv: "video/x-matroska",
    mp3: "audio/mpeg",
    m4a: "audio/mp4",
    opus: "audio/ogg",
    ogg: "audio/ogg",
  };

  const contentType = mimeTypes[ext] ?? "application/octet-stream";

  res.setHeader("Content-Type", contentType);
  res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(filename)}"`);

  const stream = fs.createReadStream(filePath);
  stream.pipe(res);

  stream.on("close", () => {
    // Clean up after serving — cancel TTL timer and delete immediately
    if (job.cleanupTimer) clearTimeout(job.cleanupTimer);
    jobs.delete(jobId);
    try { fs.rmSync(job.tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });
  stream.on("error", () => {
    res.status(500).end();
  });
});

export default router;
