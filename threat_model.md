# Threat Model

## Project Overview

ClipAI is a full-stack Node.js/TypeScript application that converts long YouTube/TikTok videos into short viral clips. The frontend is React 19 + Vite (port 5000), the backend is Express 5 (port 8080). Authentication uses Clerk. The database is PostgreSQL (Replit-managed). Video processing relies on ffmpeg (Nix/npm), yt-dlp (Nix/npm), and a Railway-hosted yt-dlp download API. The app is publicly deployed via Replit autoscale at `https://autocliper.com`.

## Assets

- **User accounts and sessions** — Clerk-managed. Compromise allows access to a user's clip history.
- **Clip history (clip_jobs table)** — URLs and metadata of processed videos, scoped per user.
- **Application secrets** — `CLERK_SECRET_KEY`, `DATABASE_URL`, `SESSION_SECRET`. Leakage enables auth bypass or database access.
- **Server resources** — CPU, memory, and disk used for ffmpeg/yt-dlp processing. Abuse can cause denial of service or fill object storage.
- **Host filesystem** — temporary files in `/tmp/`. Path traversal could expose or overwrite files.
- **Cloud metadata** — instance credentials accessible via `169.254.169.254` on cloud deployments; reachable via DNS rebinding SSRF bypass.

## Trust Boundaries

- **Browser → API** — All video URLs, format strings, timestamps, and search queries originate from untrusted clients. The server must sanitize before passing to shell commands.
- **API → shell (ffmpeg/yt-dlp)** — User-supplied parameters are passed as argv elements via `execFileAsync`/`spawn` (safe from shell injection). No string interpolation occurs.
- **API → Railway/external download APIs** — Server issues outbound HTTP requests with user-supplied URLs. SSRF is partially mitigated by a literal/syntactic guard but DNS rebinding is not blocked.
- **API → PostgreSQL** — All queries use parameterized statements (pg driver); SQL injection is mitigated.
- **Authenticated → Unauthenticated** — `/api/history` is documented as auth-required but currently has no `requireAuth` middleware; `req.userId` is always `undefined`. Video processing endpoints (`/api/video/*`) have no authentication.

## Scan Anchors

- Production entry points: `artifacts/api-server/src/routes/videoTools.ts`, `artifacts/api-server/src/routes/ytdlp.ts`, `artifacts/api-server/src/routes/history.ts`
- Highest-risk code areas:
  - Missing auth on all of `videoTools.ts` — CPU/disk DoS surface
  - `history.ts` — missing `requireAuth`, unauthenticated writes to `clip_jobs`
  - `ssrfGuard.ts` — syntactic-only, DNS rebinding not blocked
  - Rate limiters in `app.ts` — keyed on forged `X-Forwarded-For`
- Public surface: all `/api/video/*` and `/api/ytdlp/*` endpoints (no auth)
- Authenticated surface: `/api/history` (documented; enforcement currently broken), `/api/ytdlp/*` (correctly protected via inline `requireAuth`)
- CORS: secure in production — `.replit` sets `NODE_ENV=production` and `ALLOWED_ORIGIN=https://autocliper.com`
- Dev-only: none — all routes are production-reachable

## Threat Categories

### Tampering / Elevation of Privilege (Command Injection)

All subprocess calls use `execFileAsync` (promisify of `execFile`) with argument arrays — shell injection is mitigated. `execAsync` (promisify of `exec`) is imported but has zero call sites in production code. No shell string interpolation of user input exists. This threat category is currently mitigated.

### Broken Access Control (Missing Authentication on Sensitive Routes)

Two categories of broken access control:

1. **History routes** (`history.ts`): `requireAuth` middleware is never imported or applied. All four handlers use `req.userId` which is always `undefined`. Effect: `POST /history` inserts orphaned `clip_jobs` rows with `user_id=NULL`; `POST /history/sync-user` triggers a PK violation and returns the raw PostgreSQL error to the caller.

2. **Video processing routes** (`videoTools.ts`): No `requireAuth` on any of the ~12 routes. Any unauthenticated internet user can trigger unlimited ffmpeg/yt-dlp jobs, consuming server resources and filling object storage.

**Required guarantees:**
- `requireAuth` MUST be imported and applied in `history.ts` for all four handlers.
- All routes in `videoTools.ts` MUST apply `requireAuth` before processing requests.

### Information Disclosure (SSRF — DNS Rebinding)

`isSafePublicUrl()` is a literal/syntactic check. It does not resolve DNS. An attacker with a TTL=0 domain can bypass it via DNS rebinding, directing yt-dlp, ffmpeg (via Node's `http.get`), or `fetch` at internal/metadata addresses after the validation step.

**Required guarantee:** URL inputs SHOULD be checked against a strict host allowlist (youtube.com, youtu.be, tiktok.com, etc.) to eliminate SSRF entirely, OR connect-time IP verification should be added.

### Information Disclosure (Database Error Leakage)

All `history.ts` catch blocks return `(err as Error).message` directly to the HTTP client. PostgreSQL errors include table names, column names, and constraint names.

**Required guarantee:** Database errors MUST be caught, logged server-side, and only a generic message returned to clients.

### Denial of Service (Rate Limit Bypass)

`app.set("trust proxy", 1)` causes `express-rate-limit` to key on the leftmost `X-Forwarded-For` value, which attackers can forge. Combined with missing auth on video processing routes, this allows unlimited resource-intensive job spawning.

**Required guarantee:** Rate limiters SHOULD use a `keyGenerator` that trusts only the final (Replit-appended) proxy hop IP, or authentication should be the primary defence.

### Spoofing (CORS)

CORS is correctly restricted in production: `.replit` sets `ALLOWED_ORIGIN=https://autocliper.com` and `NODE_ENV=production`, resulting in `origin: "https://autocliper.com"` with `credentials: true`. No vulnerability here in the production deployment.
