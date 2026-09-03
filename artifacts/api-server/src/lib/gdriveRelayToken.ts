/**
 * Stateless signed tokens for the Google Drive media relay.
 *
 * The posting provider fetches media by URL at publish time — which can be
 * hours or days after we hand the post over. Drive's own direct-download URLs
 * rot for third-party fetchers (one-time confirm tokens, HTML interstitials);
 * observed live as "All media failed to process, please check media URLS" on
 * every account. So we hand the provider OUR relay URL instead; the token pins
 * the Drive file id, is HMAC-signed, and needs no DB row.
 */
import crypto from "crypto";

const DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000; // floor — normal campaign horizon
const MAX_TTL_MS = 400 * 24 * 60 * 60 * 1000;    // cap — never mint decade-long URLs

/** Drive file ids are URL-safe; anything else never reaches the relay. */
const ID_RE = /^[A-Za-z0-9_-]{10,120}$/;

const secret = (): string => {
  const s = (process.env.SESSION_SECRET ?? "").trim();
  if (!s) throw new Error("SESSION_SECRET is not configured");
  return s;
};

const sign = (payload: string): string =>
  crypto.createHmac("sha256", secret()).update(payload).digest("base64url");

/** `ttlMs` lets callers stretch the token to a far-future publish moment —
 *  the provider fetches the bytes at publish time, not at handoff. Clamped
 *  to [30 days, 400 days]. */
export function createGDriveRelayToken(fileId: string, now = Date.now(), ttlMs = DEFAULT_TTL_MS): string {
  if (!ID_RE.test(fileId)) throw new Error("Invalid Google Drive file id");
  const ttl = Math.min(Math.max(ttlMs, DEFAULT_TTL_MS), MAX_TTL_MS);
  const payload = `${fileId}.${now + ttl}`;
  return `${payload}.${sign(payload)}`;
}

/** Returns the Drive file id, or null when invalid, expired, or tampered. */
export function verifyGDriveRelayToken(token: string, now = Date.now()): string | null {
  const m = token.match(/^([A-Za-z0-9_-]{10,120})\.(\d{10,16})\.([A-Za-z0-9_-]{20,100})$/);
  if (!m) return null;
  const [, id, expStr, sig] = m;
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || exp < now) return null;
  const expect = sign(`${id}.${exp}`);
  const a = Buffer.from(sig), b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return id;
}
