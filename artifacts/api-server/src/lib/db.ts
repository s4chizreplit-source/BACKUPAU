/**
 * Shared PostgreSQL pool for the whole API server.
 * All modules that need the database import { pool } from here so we keep a
 * single connection pool per process.
 *
 * When DATABASE_URL is not configured (bare dev environments) `pool` is null
 * and every feature that needs the DB responds 503 instead of crashing.
 */
import { Pool } from "pg";

const DB_URL = process.env.DATABASE_URL ?? "";

export const pool: Pool | null = DB_URL
  ? new Pool({
      connectionString: DB_URL,
      // Headroom for background workers (4 campaign materializers + 4 queue
      // drains can hold clients around network I/O) plus web traffic.
      max: 20,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    })
  : null;

export function hasDb(): boolean {
  return pool !== null;
}

/** Throwing accessor for code paths that must have a DB. */
export function requireDb(): Pool {
  if (!pool) throw new Error("DATABASE_URL is not configured");
  return pool;
}
