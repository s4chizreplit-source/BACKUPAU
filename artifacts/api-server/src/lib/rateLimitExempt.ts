/**
 * Paths exempt from the shared general API budget (200 req / 15 min / IP).
 *
 * Every path here carries its OWN dedicated limiter — exemption never means
 * unlimited. High-frequency legitimate traffic (job polls every ~4s, <video>
 * range-request bursts, chunked uploads) must not drain the shared bucket:
 * that once locked a user out of LOGIN mid-session — a normal clipping
 * session burned the 200 budget and every /api route (auth included) 429'd.
 *
 * Paths are as seen by the limiter mounted at "/api" (no "/api" prefix).
 */
const AUTH_OWN_LIMITER = new Set([
  "/auth/login",
  "/auth/signup",
  "/auth/verify-email",
  "/auth/resend-verification",
  "/auth/forgot-password",
  "/auth/reset-password",
]);

export function isGeneralLimiterExempt(path: string): boolean {
  return (
    path.startsWith("/yt/progress") ||        // downloader progress polls (own limiter in ytDownload)
    path.startsWith("/video/upload/chunk") || // chunked device uploads (own limiter)
    path.startsWith("/video/job/") ||         // clip job status polls (own limiter)
    path.startsWith("/video/file/") ||        // clip previews/downloads — range bursts (own limiter)
    path.startsWith("/social/clip-status") || // post-status polls (own limiter)
    path.startsWith("/ig/view") ||            // IG thumbnail grid bursts (own limiter in instagram.ts)
    path.startsWith("/ig/download") ||        // IG media downloads (own limiter in instagram.ts)
    path.startsWith("/ig/relay/") ||          // posting-provider media fetches (HMAC token + own limiter)
    AUTH_OWN_LIMITER.has(path)                // authLimiter (30/15min) guards these
  );
}
