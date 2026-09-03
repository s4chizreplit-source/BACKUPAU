# 🤖 SETUP PROMPT — Rebuild & Deploy AutoCliper From This Repo

> **How to use this file:** open a fresh Replit App (or any host), give your AI agent the link
> to this repository and say:
>
> **"Clone this repo, then read `SETUP_PROMPT.md` at the root and follow it step by step until
> the app is running and deployed."**
>
> Everything the agent needs — system dependencies, environment variables, commands, database,
> storage, verification steps, and platform gotchas — is written below. Follow it top to bottom.

---

## 1. What this app is

**AutoCliper** — paste a long video link (YouTube / Kick / Twitch / Google Drive / Dropbox / device
upload) and it auto-detects the best moments and cuts short vertical clips (Shorts/Reels format).

pnpm monorepo, two packages:

| Package | Path | Stack | Port (dev) |
|---|---|---|---|
| `@workspace/ytdlp-ui` | `artifacts/ytdlp-ui` | React 19 + Vite 7 + Tailwind v4, wouter, react-query | **5000** |
| `@workspace/api-server` | `artifacts/api-server` | Express 5 + TypeScript (esbuild bundle), Postgres | **8080** |

In dev, Vite proxies `/api` → `http://127.0.0.1:8080`. In production the API server alone serves
both the API **and** the built frontend (from `artifacts/ytdlp-ui/dist/public`) — one process.

Auth is custom email+password sessions (PG-backed, cookie `clipai.sid`). Credits system: signup
grants 150 credits, 1 clip = 50 credits, credits are reserved before a job and refunded on failure.
Payments are manual admin-approved requests (Stripe planned). Admin panel at `/admin`.

## 2. System dependencies (install these FIRST)

1. **Node.js 20+** and **pnpm 10** (`corepack enable` or `npm i -g pnpm`).
2. **ffmpeg + ffprobe — REAL system binaries** (apt/nix/brew). ⚠️ **Never install the npm packages
   `ffmpeg-static` / `@ffprobe-installer/ffprobe`** — they segfault when yt-dlp shells out to them
   and were deliberately removed. The server resolves binaries from PATH and common system
   locations, and logs a boot **WARNING** if none are found. Override with `FFPROBE_PATH` if needed.
3. **yt-dlp binary** — `bin/` is gitignored on purpose. Download the latest release:
   ```bash
   mkdir -p bin && curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o bin/yt-dlp && chmod +x bin/yt-dlp
   ```
   (or set `YTDLP_PATH` to an existing binary; on Railway, `nixpacks.toml` already installs it
   to `/usr/local/bin` during build).
4. **PostgreSQL** — any Postgres works; on Replit create the built-in PostgreSQL database
   (provides `DATABASE_URL` automatically). Schema is **self-healing**: `db-init` is idempotent and
   runs automatically at every boot — no manual migration step needed.
5. **Object storage for clips** (pick ONE):
   - **Replit App Storage** (recommended on Replit): create a bucket; the env vars
     (`DEFAULT_OBJECT_STORAGE_BUCKET_ID`, …) appear automatically.
   - **Any S3-compatible store** (R2/S3/MinIO): set `S3_BUCKET`, `S3_ENDPOINT`, `S3_REGION`,
     `S3_ACCESS_KEY`, `S3_SECRET_KEY`.
   - **None**: falls back to local disk — fine for a single-server dev box, NOT for autoscale.

## 3. Environment variables / secrets

**Required:**

| Var | What |
|---|---|
| `DATABASE_URL` | Postgres connection string |
| `SESSION_SECRET` | long random string — signs session cookies |
| `ZYLA_API_KEY` | Zyla "YouTube Video Downloader" API key — the YouTube download engine. ⚠️ **PAID per download start.** The app dedupes starts via a durable `zyla_cache` DB table; never bypass it, never log the key, never call Zyla in test loops |
| `ADMIN_EMAILS` | comma-separated emails that become admins on signup/login |

**Email (password reset):** uses **Resend**. On Replit, add the Resend *integration/connector* (the
code calls it through `@replit/connectors-sdk` — no raw API key needed) and optionally set
`RESEND_FROM_EMAIL` once a domain is verified. On non-Replit hosts, adapt
`artifacts/api-server/src/lib/mailer.ts` to call Resend's REST API with a `RESEND_API_KEY` instead.

**Optional tuning (sane defaults exist for all):**
`MAX_CONCURRENT_JOBS`, `MAX_QUEUED_JOBS`, `MAX_QUEUED_PER_IP`, `CLIPS_PARALLEL`,
`SECTION_DL_PARALLEL`, `ENCODE_PROFILE`, `STORAGE_SIZE_CAP_GB`, `MIN_FREE_DISK_BYTES`,
`UPLOAD_MAX_GB`, `UPLOAD_REQUIRE_MIRROR`, `CLIPS_DIR`, `CLIPAI_COOKIES_DIR`, `YTDLP_COOKIES_FILE`,
`YTDLP_PATH`, `FFPROBE_PATH`, `APP_BASE_URL`, `ALLOWED_ORIGIN`, `LOG_LEVEL`.
Frontend (only if UI and API are hosted separately): `VITE_API_URL`. Optional: `VITE_SITE_URL` — public origin used in shared links like referral links (defaults to `https://autocliper.com`).

## 4. Install & run (development)

```bash
pnpm install

# terminal 1 — API on :8080 (esbuild-bundles then starts; restart after backend edits)
PORT=8080 pnpm --filter @workspace/api-server run dev

# terminal 2 — UI on :5000 (Vite dev server, proxies /api → 8080)
PORT=5000 BASE_PATH=/ pnpm --filter @workspace/ytdlp-ui run dev
```

On **Replit**, recreate these as two workflows (names must serve the preview on port 5000):
- `web`: `PORT=5000 BASE_PATH=/ pnpm --filter @workspace/ytdlp-ui run dev`
- `API Server`: `PORT=8080 pnpm --filter @workspace/api-server run dev`

## 5. Verify the setup (all must pass before calling it done)

```bash
pnpm --filter @workspace/api-server run typecheck   # clean
pnpm --filter @workspace/ytdlp-ui  run typecheck    # clean
pnpm --filter @workspace/api-server run test        # ~270 tests, all green
pnpm --filter @workspace/ytdlp-ui  run test         # ~58 tests, all green
curl -s http://127.0.0.1:8080/healthz               # 200 JSON
```

Functional smoke: open the app → Sign up (a fresh account gets **150 credits**) → paste a public
YouTube link → Get Clips → clips render, play, and download. Log in with an `ADMIN_EMAILS` account
and open `/admin` to see stats. ⚠️ Each *new* video started through Zyla costs paid quota — for
repeat testing reuse the same URL (the durable cache makes re-runs free).

## 6. Production / deployment

**Build once, serve from the API process:**

```bash
pnpm --filter @workspace/ytdlp-ui  run build   # → artifacts/ytdlp-ui/dist/public
pnpm --filter @workspace/api-server run build  # → artifacts/api-server/dist/index.mjs
NODE_ENV=production PORT=8080 pnpm --filter @workspace/api-server run start
```

The API serves the built UI itself — deploy **one** service, point it at the start command above
(any port; set `PORT`). Schema migrates itself at boot, so publishing new code is enough.

- **Replit publish:** Reserved VM or Autoscale both work (job records are mirrored to object
  storage for multi-instance safety). Build command = the two builds above; run command = the
  start line. Set the required secrets in the deployment environment too.
- **Railway:** `railway.toml` + `nixpacks.toml` are already in the repo (they install ffmpeg and
  yt-dlp at build time). `railway.env.example` lists the envs to fill.
- **Docker:** a `Dockerfile` exists at the root as a starting point.

## 7. Gotchas that will bite you if ignored

- **Zyla is paid per download start** — the cache table makes repeats free; don't "test" with
  fresh URLs in a loop, and never expose or log `ZYLA_API_KEY`.
- **YouTube sometimes bot-blocks server IPs** — the app has a cookies flow (`/api/cookies`) where
  a logged-in user can upload browser cookies; they persist under `CLIPAI_COOKIES_DIR`.
- **Kick is Cloudflare-protected** — plain Node fetch gets 403; the code already routes Kick
  through a curl-based fallback. Don't "simplify" it back to fetch.
- **ffmpeg from npm segfaults under yt-dlp** — system binaries only (see §2).
- **`/api/yt/*` metadata endpoints are deliberately public**; clip endpoints require login and
  return 401 `AUTH_REQUIRED` / 402 `INSUFFICIENT_CREDITS {needed, available}`.
- **pg returns NUMERIC columns as strings** (e.g. `billing_requests.amount_usd`) — don't do math
  on them without `Number()`.
- Clips are **permanent** by default; a storage sweeper enforces `STORAGE_SIZE_CAP_GB` and skips
  permanent clips. History-delete reclaims storage.

## 8. Referral system (works end-to-end — keep it working)

Every account has a unique referral link; when a referred friend buys **any** plan, the referrer
is automatically paid **1000 credits** (`REFERRAL_REWARD_CREDITS` in `api-server/src/lib/billing.ts`).

How the pieces connect (all built + integration-tested):

- **Tables:** `users.referral_code` (unique, lazily minted) + `users.referred_by`, plus one
  `referrals` row per referred user (`referred_id` is UNIQUE; `status` signed_up → rewarded).
  Schema self-heals at boot like everything else.
- **Link capture:** the SPA stores `?ref=CODE` from **any** route in localStorage (30-day TTL);
  signup sends it as an optional `ref` field. Invalid or self-referral codes are silently
  ignored — a bad ref must NEVER fail a signup.
- **Payout:** fires inside `grantSubscriptionTx`, in the **same transaction** as the plan grant.
  A one-shot `UPDATE … WHERE rewarded_at IS NULL … RETURNING` guard means a friend can buy ten
  plans but the referrer is paid exactly once. Credits land as never-expiring top-up credits;
  ledger reason: `referral_reward`.
- **API:** `GET /api/referral/me` (auth required) mints/returns the code, reward size and stats.
- **UI:** Account page "Refer & earn" card (copy link + WhatsApp/Telegram/X share + stats grid),
  a landing-page banner above the footer, and a user-menu shortcut.
- **Link domain:** share links are built from `SITE_ORIGIN` (`ytdlp-ui/src/lib/site.ts`) —
  defaults to `https://autocliper.com`, overridable with `VITE_SITE_URL` on other hosts. Never
  build referral links from `window.location` (dev/preview URLs would leak to users).
- **Tests:** `api-server/src/__tests__/referrals.test.ts` — minting, case-insensitive linking,
  bogus-code tolerance, exactly-once payout, stats.

**When Stripe (or any new payment path) lands:** it must grant plans through
`grantSubscription`/`grantSubscriptionTx` — the referral payout then rides along for free.

## 9. Do NOT

- Do not commit secrets, `.env` files, or the `bin/` directory.
- Do not add `ffmpeg-static` / `@ffprobe-installer/ffprobe` back.
- Do not run casual Zyla test jobs on new URLs (paid quota).
- Do not remove the schema self-heal at boot — deployments rely on it.
- Do not bypass the credits reserve/refund flow when touching job code.
- Do not pay referral rewards anywhere except inside `grantSubscriptionTx`, and do not remove
  its one-shot `rewarded_at IS NULL` guard — that is the only thing preventing double payouts.

*More operational detail for day-to-day agent work lives in `replit.md`.*
