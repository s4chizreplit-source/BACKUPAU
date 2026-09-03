import app from "./app";
import { logger } from "./lib/logger";
import { checkStorageHealth } from "./lib/fileStore";
import { pool } from "./lib/db";
import { ensureSchema } from "./lib/schema";
import { ensurePfmWebhook, getWebhookSecrets } from "./lib/postforme";
import { reclaimExpiredDurableJobs } from "./lib/durableJobs";
import { reconcileRetryableZapupiReviews } from "./lib/zapupi";

// ── Process-level safety net ──────────────────────────────────────────────────
// An unhandled rejection or uncaught exception must NEVER silently kill the
// server and give every user a 502 until systemd restarts it (3-5s gap).
// Log loudly so the issue shows up in `journalctl -u autocliper`, then keep
// running — the bad request is already gone; the server itself is healthy.
process.on("unhandledRejection", (reason) => {
  logger.error({ err: reason }, "[process] unhandledRejection — keeping server alive");
});
process.on("uncaughtException", (err) => {
  logger.error({ err }, "[process] uncaughtException — keeping server alive");
});

const rawPort = process.env["PORT"] ?? "8080";
const port = Number(rawPort);
if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

// Self-heal the DB schema before serving requests, so a fresh publish that
// expects a new column/table never 500s until someone runs db:init manually.
// Failures are logged loudly but don't kill the server — routes already
// degrade gracefully when the DB is unavailable.
async function start(): Promise<void> {
  if (pool) {
    try {
      await ensureSchema(pool);
      logger.info("[db] schema ensured");
      const reclaimed = await reclaimExpiredDurableJobs();
      if (reclaimed) logger.warn({ reclaimed }, "[durable-jobs] reclaimed expired worker leases");
      // A crashed worker's lease is deliberately allowed to expire before its
      // work becomes claimable again. This sweep is cheap and makes recovery
      // independent of which API instance receives the next request.
      setInterval(() => { void reclaimExpiredDurableJobs(); }, 30_000).unref();
    } catch (err) {
      logger.error({ err }, "[db] schema init failed — continuing with the existing schema");
    }
  } else {
    logger.warn("[db] DATABASE_URL not set — accounts/history/billing routes will be unavailable");
  }
  // Register the Post for Me webhook (prod only — needs PUBLIC_APP_URL).
  // Non-blocking: posting still works without it via status polling.
  if (pool) {
    void ensurePfmWebhook(logger).catch(() => {});
    // Prime the webhook-secret cache so the first delivery verifies in-memory
    // (PFM expects the ack within 1 second).
    void getWebhookSecrets().catch(() => {});
  }
  listen();
  if (pool) {
    void reconcileRetryableZapupiReviews()
      .then((recovered) => {
        if (recovered) logger.info({ recovered }, "zapupi reviewed payments auto-activated");
      })
      .catch((err) => logger.warn({ err }, "zapupi startup reconciliation failed"));
  }
}

function listen(): void {
  app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");

  // Startup probe — warn loudly if Object Storage is unreachable so ops can
  // catch misconfiguration before users hit it.  Non-blocking: the server
  // continues listening even if storage is down so existing local-cache hits
  // still work while the issue is investigated.
  checkStorageHealth().then(({ ok, error }) => {
    if (ok) {
      logger.info("[storage] Object Storage reachability check passed");
    } else {
      logger.error(
        { error },
        "[storage] Object Storage is NOT reachable at startup — uploads will fail until this is resolved",
      );
    }
  }).catch(() => { /* checkStorageHealth swallows its own errors */ });
  });
}

void start();
