import express, { type Express } from "express";
import cors from "cors";
import compression from "compression";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import pinoHttp from "pino-http";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";
import router from "./routes";
import { sessionMiddleware } from "./middlewares/sessionAuth";
import { logger } from "./lib/logger";
import { isGeneralLimiterExempt } from "./lib/rateLimitExempt";

const app: Express = express();

// Trust the first proxy hop (Replit / Railway / Render reverse proxies).
// Required for express-rate-limit to read the real client IP from X-Forwarded-For.
app.set("trust proxy", 1);

// The .pro domain is the public origin. Keep legacy .com and www URLs from
// competing with the canonical pages in search indexes.
const legacyHosts = new Set([
  "autocliper.com",
  "www.autocliper.com",
]);
app.use((req, res, next) => {
  if (process.env.NODE_ENV !== "production" || !legacyHosts.has(req.hostname.toLowerCase())) {
    return next();
  }
  return res.redirect(308, `https://autocliper.pro${req.originalUrl}`);
});

// Security headers — XSS, clickjacking, MIME sniff, etc.
// contentSecurityPolicy disabled — frontend serves inline scripts via Vite
app.use(helmet({ contentSecurityPolicy: false }));

// Compress all JSON/text API responses — cuts bandwidth ~70%
app.use(compression());

// ── Rate limiting ─────────────────────────────────────────────────────────────
// Heavy clip/download jobs get tighter per-IP limits to prevent abuse.
// General API gets a more generous window.
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests — please slow down and try again shortly." },
  // High-frequency legit traffic (job/post-status polls, clip <video> streams,
  // upload chunks) and the auth routes (which carry their own stricter
  // limiter) are exempt — each has a dedicated bucket below/in its router.
  // Without this, one clipping session burned the 200 budget and the LOGIN
  // page 429'd ("Too many requests") for the rest of the window.
  skip: (req) => isGeneralLimiterExempt(req.path),
});

const clipLimiter = rateLimit({
  windowMs: 60 * 1000,  // 1 minute
  max: 10,              // 10 clip jobs per IP per minute
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many clip requests — please wait a moment before trying again." },
});

const downloadLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,              // 20 yt-dlp downloads per IP per minute
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many download requests — please slow down." },
});

const uploadChunkLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 150,             // 150 × 4MB ≈ 600MB/min — far above any realistic uplink
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Uploading too fast — please wait a moment and try again." },
});

// Job + post-status polls tick every ~4s per active job/clip — one SHARED
// per-IP bucket, generous enough for several concurrent jobs/tabs but still
// a hard cap. Exempt from the general budget above.
const statusPollLimiter = rateLimit({
  windowMs: 60_000,
  limit: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many status checks — please slow down a little." },
});

// Clip previews/downloads — every <video> tag issues bursts of range requests,
// and a history page mounts many players at once.
const mediaLimiter = rateLimit({
  windowMs: 60_000,
  limit: 150,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many media requests — please wait a moment." },
});

app.use("/api", generalLimiter);
app.use("/api/video/clip", clipLimiter);
app.use("/api/ytdlp/download", downloadLimiter);
app.use("/api/video/upload/chunk", uploadChunkLimiter);
app.use("/api/video/job", statusPollLimiter);
app.use("/api/social/clip-status", statusPollLimiter);
app.use("/api/video/file", mediaLimiter);

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return { id: req.id, method: req.method, url: req.url?.split("?")[0] };
      },
      res(res) {
        return { statusCode: res.statusCode };
      },
    },
  }),
);

// ALLOWED_ORIGIN — defaults to autocliper.pro in prod, open in dev.
// Set this env var to lock down CORS to a specific domain.
const allowedOrigin = process.env.ALLOWED_ORIGIN
  ?? (process.env.NODE_ENV === "production" ? "https://autocliper.pro" : "*");
app.use(
  cors({
    credentials: allowedOrigin !== "*",
    origin: allowedOrigin === "*" ? true : allowedOrigin,
  }),
);
app.use(express.json({
  limit: "1mb",
  verify: (req, _res, buf) => {
    const originalUrl = (req as unknown as { originalUrl?: string }).originalUrl ?? "";
    if (originalUrl.endsWith("/api/pay/whop/webhook")) {
      (req as unknown as { rawBody?: Buffer }).rawBody = Buffer.from(buf);
    }
  },
}));
app.use(express.urlencoded({ extended: true, limit: "1mb" }));

// Account sessions (email+password auth) — PostgreSQL-backed, 30-day cookie
app.use(sessionMiddleware());

// Root health check (before static files so it always returns JSON)
app.get("/healthz", (_req, res) => res.json({ status: "ok" }));

app.use("/api", router);

// Serve the built frontend whenever the dist folder exists.
// NODE_ENV is not reliably set to "production" by the hosting environment,
// so we gate only on whether the build output is present.
const __serverDir = path.dirname(fileURLToPath(import.meta.url));
const frontendDist = path.resolve(__serverDir, "../../ytdlp-ui/dist/public");
if (fs.existsSync(frontendDist)) {
  // Sitemap routes get dedicated, prerendered HTML with self-referential
  // canonical metadata. They must be registered before static/SPAs fall back
  // to the generic landing document.
  const seoPageFiles = {
    "/pricing": "pricing.html",
    "/terms": "terms.html",
    "/privacy": "privacy.html",
  } as const;
  for (const [route, file] of Object.entries(seoPageFiles)) {
    app.get([route, `${route}/`], (_req, res) => {
      res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
      res.sendFile(path.join(frontendDist, file));
    });
  }

  // Hashed assets (JS/CSS chunks produced by Vite) are immutable — cache 1 year.
  // index.html must never be cached so the SPA always boots fresh.
  app.use(
    express.static(frontendDist, {
      maxAge: "1y",
      immutable: true,
      etag: true,
      setHeaders(res, filePath) {
        if (filePath.endsWith("index.html")) {
          res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
        }
      },
    }),
  );
  // SPA fallback — all non-API routes serve index.html
  // Express 5 requires named wildcards; bare "*" is rejected by path-to-regexp v8
  app.get("/{*path}", (_req, res) => {
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    res.sendFile(path.join(frontendDist, "index.html"));
  });
}

export default app;
