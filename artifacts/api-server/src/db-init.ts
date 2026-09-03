/**
 * Database initialisation — creates/updates the tables needed by AutoCliper.
 * Safe to run multiple times (IF NOT EXISTS everywhere).
 *
 * The actual schema lives in src/lib/schema.ts and ALSO runs automatically at
 * server startup, so deployed environments self-heal. This script remains for
 * manual runs and the post-merge setup hook:
 *
 *   pnpm --filter @workspace/api-server run db:init
 */
import { Pool } from "pg";
import { ensureSchema } from "./lib/schema";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  console.log("Running DB init…");
  await ensureSchema(pool);
  console.log("DB init complete — tables: users, clip_jobs, credit_ledger, billing_requests, password_resets, session");
  await pool.end();
}

main().catch((err) => {
  console.error("DB init failed:", err);
  process.exit(1);
});
