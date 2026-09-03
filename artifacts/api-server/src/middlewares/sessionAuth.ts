/**
 * Session-based auth for AutoCliper accounts (email + password).
 *
 * - sessionMiddleware(): express-session backed by the `session` table in
 *   PostgreSQL (connect-pg-simple), 30-day rolling cookie.
 * - requireUser: loads the signed-in user onto req.currentUser (401 when
 *   signed out, 403 when the account is disabled).
 * - requireAdmin: same, plus role check.
 */
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import { pool } from "../lib/db";
import type { DbUser } from "../lib/billing";
import { logger } from "../lib/logger";

declare module "express-session" {
  interface SessionData {
    userId?: string;
  }
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      currentUser?: DbUser;
    }
  }
}

export const SESSION_COOKIE_NAME = "clipai.sid";

export function sessionMiddleware(): RequestHandler {
  if (!pool) {
    logger.warn("DATABASE_URL not set — sessions disabled, auth endpoints will return 503");
    return (_req, _res, next) => next();
  }
  const PGStore = connectPgSimple(session);
  const secret = process.env.SESSION_SECRET ?? "";
  if (!secret) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("SESSION_SECRET is required in production — refusing to start with a forgeable session key.");
    }
    logger.warn("SESSION_SECRET not set — using an insecure dev-only fallback");
  }
  return session({
    store: new PGStore({ pool, tableName: "session", createTableIfMissing: true }),
    name: SESSION_COOKIE_NAME,
    secret: secret || "dev-only-insecure-secret",
    resave: false,
    saveUninitialized: false,
    rolling: true,
    proxy: true,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: "auto",
      maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
    },
  });
}

export async function loadSessionUser(req: Request): Promise<DbUser | null> {
  const userId = req.session?.userId;
  if (!userId || !pool) return null;
  const { rows } = await pool.query<DbUser>(`SELECT * FROM users WHERE id = $1`, [userId]);
  return rows[0] ?? null;
}

export const requireUser: RequestHandler = async (req, res, next) => {
  try {
    if (!pool) {
      res.status(503).json({ error: "Accounts are not available — database is not configured." });
      return;
    }
    const user = await loadSessionUser(req);
    if (!user) {
      res.status(401).json({ error: "Please log in to continue.", code: "AUTH_REQUIRED" });
      return;
    }
    if (user.status === "disabled") {
      res.status(403).json({ error: "This account has been disabled. Contact support.", code: "ACCOUNT_DISABLED" });
      return;
    }
    req.currentUser = user;
    next();
  } catch (err) {
    next(err);
  }
};

export const requireAdmin: RequestHandler = (req: Request, res: Response, next: NextFunction) => {
  requireUser(req, res, (err?: unknown) => {
    if (err) { next(err); return; }
    if (req.currentUser?.role !== "admin") {
      res.status(403).json({ error: "Admin access required.", code: "ADMIN_REQUIRED" });
      return;
    }
    next();
  });
};

/** Emails listed in ADMIN_EMAILS get the admin role on signup/login (bootstrap). */
export function isBootstrapAdminEmail(email: string): boolean {
  return (process.env.ADMIN_EMAILS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .includes(email.trim().toLowerCase());
}
