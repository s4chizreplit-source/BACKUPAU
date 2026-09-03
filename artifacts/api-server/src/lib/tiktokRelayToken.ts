/**
 * Stateless signed references for TikTok Auto-Pilot media.
 *
 * Campaign items keep the stable TikTok video id, not a signed CDN URL.
 * The posting provider fetches the relay at publish time and the relay resolves
 * a fresh media URL from Zyla.
 */
import crypto from "crypto";

const DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_TTL_MS = 400 * 24 * 60 * 60 * 1000;
const USERNAME_RE = /^[a-z0-9](?:[a-z0-9._]{0,29})$/i;
const VIDEO_ID_RE = /^[A-Za-z0-9_-]{1,120}$/;

const secret = (): string => {
  const value = (process.env.SESSION_SECRET ?? "").trim();
  if (!value) throw new Error("SESSION_SECRET is not configured");
  return value;
};

const sign = (payload: string): string =>
  crypto.createHmac("sha256", secret()).update(payload).digest("base64url");

export type TikTokRelayRef = { username: string; videoId: string };

export function createTikTokRelayToken(
  ref: TikTokRelayRef,
  now = Date.now(),
  ttlMs = DEFAULT_TTL_MS,
): string {
  if (!USERNAME_RE.test(ref.username)) throw new Error("Invalid TikTok username");
  if (!VIDEO_ID_RE.test(ref.videoId)) throw new Error("Invalid TikTok video id");
  const ttl = Math.min(Math.max(ttlMs, DEFAULT_TTL_MS), MAX_TTL_MS);
  const payload = `${ref.username.toLowerCase()}~${ref.videoId}~${now + ttl}`;
  return `${payload}~${sign(payload)}`;
}

export function verifyTikTokRelayToken(token: string, now = Date.now()): TikTokRelayRef | null {
  const match = token.match(
    /^([a-z0-9._]{1,30})~([A-Za-z0-9_-]{1,120})~(\d{10,16})~([A-Za-z0-9_-]{20,100})$/,
  );
  if (!match) return null;
  const [, username, videoId, expText, signature] = match;
  if (!USERNAME_RE.test(username)) return null;
  const expiresAt = Number(expText);
  if (!Number.isFinite(expiresAt) || expiresAt < now) return null;
  const expected = sign(`${username}~${videoId}~${expiresAt}`);
  const actual = Buffer.from(signature);
  const wanted = Buffer.from(expected);
  if (actual.length !== wanted.length || !crypto.timingSafeEqual(actual, wanted)) return null;
  return { username, videoId };
}