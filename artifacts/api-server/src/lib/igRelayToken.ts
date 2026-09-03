/**
 * Stateless signed tokens for the Instagram media relay.
 *
 * Auto-Pilot campaigns store items as "ig:<username>:<kind>:<mediaId>" — no
 * CDN URL, because Instagram's signed URLs rot within hours while a campaign
 * posts over days or weeks. At publish time the posting provider fetches OUR
 * relay URL; the relay re-resolves a FRESH CDN URL for the pinned media and
 * streams the bytes. The token is HMAC-signed and needs no DB row.
 *
 * Fields are joined with "~" — a character that can never appear in an IG
 * username (letters/digits/dot/underscore) or media id, so parsing is
 * unambiguous even though usernames may contain dots.
 */
import crypto from "crypto";

const DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000; // floor — normal campaign horizon
const MAX_TTL_MS = 400 * 24 * 60 * 60 * 1000;    // cap — never mint decade-long URLs

const USERNAME_RE = /^[a-z0-9](?:[a-z0-9._]{0,29})$/i;
const MEDIA_ID_RE = /^[A-Za-z0-9_-]{5,80}$/;

const secret = (): string => {
  const s = (process.env.SESSION_SECRET ?? "").trim();
  if (!s) throw new Error("SESSION_SECRET is not configured");
  return s;
};

const sign = (payload: string): string =>
  crypto.createHmac("sha256", secret()).update(payload).digest("base64url");

export type IgRelayRef = { username: string; kind: "post" | "reel"; mediaId: string };

/** `ttlMs` lets callers stretch the token to a far-future publish moment —
 *  the provider fetches the bytes at publish time, not at handoff. Clamped
 *  to [30 days, 400 days]. */
export function createIgRelayToken(ref: IgRelayRef, now = Date.now(), ttlMs = DEFAULT_TTL_MS): string {
  if (!USERNAME_RE.test(ref.username)) throw new Error("Invalid Instagram username");
  if (!MEDIA_ID_RE.test(ref.mediaId)) throw new Error("Invalid Instagram media id");
  const ttl = Math.min(Math.max(ttlMs, DEFAULT_TTL_MS), MAX_TTL_MS);
  const payload = `${ref.username.toLowerCase()}~${ref.kind === "reel" ? "r" : "p"}~${ref.mediaId}~${now + ttl}`;
  return `${payload}~${sign(payload)}`;
}

/** Returns the media reference, or null when invalid, expired, or tampered. */
export function verifyIgRelayToken(token: string, now = Date.now()): IgRelayRef | null {
  const m = token.match(/^([a-z0-9._]{1,30})~(r|p)~([A-Za-z0-9_-]{5,80})~(\d{10,16})~([A-Za-z0-9_-]{20,100})$/);
  if (!m) return null;
  const [, username, k, mediaId, expStr, sig] = m;
  if (!USERNAME_RE.test(username)) return null;
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || exp < now) return null;
  const expect = sign(`${username}~${k}~${mediaId}~${exp}`);
  const a = Buffer.from(sig), b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return { username, kind: k === "r" ? "reel" : "post", mediaId };
}
