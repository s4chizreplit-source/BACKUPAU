# AutoCliper — One-Shot Replit Setup Prompt

## MASTER PROMPT — paste this whole block as your first message to the Agent

```text
Read REPLIT_SETUP_PROMPT.md in the repo root and follow it EXACTLY, top to
bottom. It documents this entire app. Hard rules for you:

1. This is production code already live at autocliper.com with ALL tests green
   (336 API + 71 UI). Do NOT refactor, rewrite, "improve", or delete any app
   code, tests, or files. Your job is ENVIRONMENT SETUP ONLY.
2. Order of work: pnpm install → create Replit PostgreSQL database → create
   App Storage (Object Storage) bucket → download yt-dlp to bin/yt-dlp and
   chmod +x → install ffmpeg via the system/Nix package manager → set secrets →
   configure the two dev workflows from the doc → start them.
3. Secrets: ask the user for ZYLA_API_KEY, DEEPGRAM_API_KEY, ZAPUPI_ZAP_KEY.
   Generate SESSION_SECRET yourself (openssl rand -hex 32). Optional:
   RESEND_FROM_EMAIL, ADMIN_EMAILS. Never hardcode any key in code.
4. NEVER install the npm package ffmpeg-static — it crashes under yt-dlp.
   System/Nix ffmpeg only.
5. The database schema creates ITSELF when the API boots (ensureSchema).
   Do not write migrations, do not hand-create tables, do not add an ORM.
6. Run tests ONLY after steps in rule 2 are complete and both workflows are
   up. If a test fails, the cause is almost always missing environment
   (DATABASE_URL, Object Storage bucket, bin/yt-dlp, SESSION_SECRET) — fix the
   environment and re-run. Changing app code or test files to make a test pass
   is forbidden.
7. Done means: both workflows running; GET /api/healthz returns ok;
   GET /api/billing/catalog returns plans; homepage renders on port 5000;
   API tests 336 pass; UI tests 71 pass. Then STOP and report.
8. Do not publish/deploy unless the user asks. When they do, copy the exact
   Reserved VM build & run commands from this doc's production section.
```


> **Copy-paste this whole file to Replit Agent after importing this GitHub repo.**
> It contains every install step, dependency, workflow, and secret this app needs.
> Follow it top to bottom and the app works A-to-Z. The ONLY things the user must
> paste are the API keys listed in **Step 5** — everything else is automatic or
> already hardcoded in the code.

---

## What this app is

**AutoCliper** (autocliper.com) — paste a YouTube / Kick / Twitch / Google Drive /
Dropbox link (or upload a file) and AI cuts the loudest, most viral moments into
vertical 9:16 clips with optional burned-in captions (55 styles). Has accounts,
credits, plans (Starter ₹500 / Pro ₹1,000 monthly via UPI), referral bonuses, and
an admin panel.

**Monorepo layout (pnpm workspaces):**

| Package | Path | What it is | Dev port |
|---|---|---|---|
| `@workspace/ytdlp-ui` | `artifacts/ytdlp-ui` | React + Vite frontend | **5000** (webview) |
| `@workspace/api-server` | `artifacts/api-server` | Express + TypeScript API | **8080** (internal) |

In dev the UI proxies `/api/*` → `localhost:8080`. All API routes live under `/api`
(e.g. `http://localhost:8080/api/healthz`).

---

## Step 1 — System packages (Nix)

Install with Replit's system-package tool:

- **`ffmpeg`** (full package — ships `ffprobe` too)

⚠️ **Never install npm `ffmpeg-static` or similar** — those binaries segfault under
yt-dlp's HLS driver. The code resolves the real ffmpeg from PATH / Nix profile
automatically (`artifacts/api-server/src/routes/videoTools.ts`), and the API's
start script already prepends the Nix profile bins to PATH.

Node 20+ and pnpm 9+ are required (`package.json` engines). The repo forces pnpm —
`npm install` will refuse on purpose.

## Step 2 — JS dependencies

```bash
pnpm install
```

That's it — one command installs both packages (workspace root).

## Step 3 — yt-dlp binary (NOT in git — must download)

The 39 MB standalone binary is intentionally untracked. Download the latest:

```bash
mkdir -p bin
curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o bin/yt-dlp
chmod +x bin/yt-dlp
```

The server finds it via PATH / known locations. If boot logs ever say yt-dlp is
missing, set env `YTDLP_PATH=/home/runner/workspace/bin/yt-dlp`.

## Step 4 — Database & Object Storage (Replit built-ins)

1. **Create a Replit PostgreSQL database** → `DATABASE_URL` is set automatically.
   **No migrations needed**: the API self-heals its schema on every boot
   (`ensureSchema` in `src/lib/schema.ts` — CREATE TABLE IF NOT EXISTS, safe to
   re-run forever). Optional manual run:
   `pnpm --filter @workspace/api-server run db:init`.

   Tables it creates (do NOT hand-create or rename these):

   | Table | Stores |
   |---|---|
   | `users` | accounts, password hashes, `role` ('user'/'admin'), credit balances |
   | `session` | login sessions (connect-pg-simple) |
   | `clip_jobs` | every clip job: status, stage, per-clip file ids, owner |
   | `credit_ledger` | every credit grant/spend — balances are derived, never overwritten |
   | `billing_requests` | manual/UPI plan activation requests + admin approvals |
   | `upi_orders` | ZapUPI orders: gateway status, idempotent row-locked grants |
   | `referrals` | who referred whom + 1000-credit bonus bookkeeping |
   | `password_resets` | one-time reset tokens for the email flow |
   | `zyla_cache` | durable per-video+format cache of paid YouTube API starts — never clear it casually, it prevents double-paying |

2. **Create a Replit App Storage (Object Storage) bucket** → this sets
   `DEFAULT_OBJECT_STORAGE_BUCKET_ID`, `PRIVATE_OBJECT_DIR`,
   `PUBLIC_OBJECT_SEARCH_PATHS` automatically. Layout the code manages by itself:
   - `clips/…` — every finished clip file (clips are permanent; history-delete reclaims them)
   - upload chunks + job-state mirrors — so any server instance can pick up a
     job/download started on another instance (critical on autoscale/VM restarts)
   Local disk (`/tmp`) is only a working area; Object Storage is the source of
   truth. Nothing else to configure — the code reads those three env vars.

## Step 5 — Secrets (ask the user to paste these)

Set via Replit Secrets. **Bold = required for full functionality.**

| Secret | Used for | Notes |
|---|---|---|
| **`ZYLA_API_KEY`** | YouTube download API (Zyla Labs "YouTube MP4 Video Downloader") | Paid per start — the code caches per video+format, never re-buys |
| **`DEEPGRAM_API_KEY`** | Speech-to-text for burned-in captions | Caption burn is skip-on-failure — without it clips still render, just captionless |
| **`ZAPUPI_ZAP_KEY`** | ZapUPI payment gateway (UPI plans ₹500/₹1,000) | From pay.zapupi.com dashboard |
| **`SESSION_SECRET`** | Signs login sessions | Generate: `openssl rand -hex 32` — don't ask the user |
| `RESEND_FROM_EMAIL` | From-address for password-reset emails | Optional — defaults to `AutoCliper <onboarding@resend.dev>` |
| `ADMIN_EMAILS` | Comma-separated emails that become **admin** on signup/login | How the first admin is bootstrapped — the admin panel lives at `/admin` |

Password-reset emails go through the **Replit Resend connector** — set up the
Resend integration in this Repl (no raw API key needed). If skipped, everything
works except password-reset emails (they fail loudly in logs, nothing crashes).

**Do NOT set** unless the situation demands: `VITE_API_URL` + `VITE_SITE_URL` (only
when UI and API are published as separate apps), `S3_*` (only for non-Replit
hosting like Railway), `CLIPS_DIR`, `YTDLP_COOKIES_FILE`. Tuning knobs with sane
defaults: `MAX_CONCURRENT_JOBS`, `MAX_QUEUED_JOBS`, `MAX_QUEUED_PER_IP`,
`STORAGE_SIZE_CAP_GB`, `UPLOAD_MAX_GB`, `MIN_FREE_DISK_BYTES`,
`SECTION_DL_PARALLEL`, `UPLOAD_REQUIRE_MIRROR`, `LOG_LEVEL`, `PUBLIC_APP_URL`.

## Step 6 — Workflows (exactly two)

| Name | Command | Port |
|---|---|---|
| `web` (webview) | `PORT=5000 BASE_PATH=/ pnpm --filter @workspace/ytdlp-ui run dev` | 5000 |
| `API Server` (console) | `PORT=8080 pnpm --filter @workspace/api-server run dev` | 8080 |

Start both. UI hot-reloads; restart the API workflow after backend changes.

## Step 7 — Verify (before telling the user it works)

```bash
curl -s http://localhost:8080/api/healthz          # → ok/JSON
curl -s http://localhost:8080/api/billing/catalog  # → plans JSON (proves DB boot)
pnpm --filter @workspace/api-server run test       # full API suite
pnpm --filter @workspace/ytdlp-ui run test         # UI suite
```

Then open the preview: sign up (new accounts get 150 free credits = 3 clips),
paste a YouTube link, and confirm clips render. Captions need `DEEPGRAM_API_KEY`;
YouTube sources need `ZYLA_API_KEY`; payments need `ZAPUPI_ZAP_KEY`.

## Hardcoded by design — do NOT ask the user about these

- Plans & prices: Starter ₹500 / Pro ₹1,000 monthly (UPI), $5/$10 display, yearly
  = 10× monthly. Credits: 50 per clip, 150 signup bonus, 1000 referral bonus.
- 55 caption styles, clip length/count/quality options, platform presets.
- Auth = email+password sessions (no OAuth). Admin panel at `/admin` (role-based).

## Exact production build & run (copy this — it is what autocliper.com uses)

Deployment target: **Reserved VM** (single always-on process; clip jobs are long-running).

Build command:

```bash
pnpm install && pnpm --filter @workspace/ytdlp-ui run build && pnpm --filter @workspace/api-server run build && mkdir -p bin && curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux -o bin/yt-dlp && chmod +x bin/yt-dlp
```

Run command (ONE process — in production the API server also serves the built UI):

```bash
export PATH="$HOME/.nix-profile/bin:/nix/var/nix/profiles/default/bin:/run/current-system/sw/bin:$PATH" && PORT=5000 node --enable-source-maps artifacts/api-server/dist/index.mjs
```

Notes: the PATH export is how the server finds the Nix ffmpeg; yt-dlp is
re-downloaded at build time so deploys never depend on a binary in git; the
two-workflow split is for development only.

## Production notes (when the user asks to publish)

- Prefer a **Reserved VM** deployment — clip jobs are long-running.
- Set `PUBLIC_APP_URL=https://<final-domain>` so payment redirects and emails use
  the right host (falls back sensibly without it).
- ZapUPI webhook (set in the ZapUPI dashboard): `https://<domain>/api/pay/zapupi/webhook`.
  The server re-verifies every webhook with the gateway — unsigned pings are safe.
- Object Storage keeps clips durable across instances; nothing else to configure.

## Known quirks (already handled in code — just don't "fix" them)

- YouTube bot-checks are intermittent; the app falls back to the Zyla API and
  shows users a friendly message. Optional: admins can add cookies via API.
- Kick blocks Node fetch (Cloudflare) — the code shells out to `curl` for Kick.
- Caption burning never fails a job — it skips captions on any STT/render error.
- npm ffmpeg packages segfault — always the system/Nix ffmpeg (see Step 1).

## Fresh-import test failures — read this before touching any code

Every test in this repo passes against a correctly set up environment. On a
fresh import, failures mean the environment is incomplete, in this order:

1. **API tests fail broadly / connection errors** → no `DATABASE_URL` yet.
   Create the Replit PostgreSQL database first, then re-run.
2. **fileAuth / zip / download tests return 401 instead of 200** → session
   environment problem, not an auth bug: `SESSION_SECRET` was missing or
   changed after the API started, or the database (with its `session` table)
   was created after the server booted. Fix: set all secrets, restart the API
   workflow so `ensureSchema` runs with the final env, re-run tests.
3. **Clip/download pipeline tests fail** → `bin/yt-dlp` missing or not
   executable, or ffmpeg absent/npm-installed. Re-download the binary,
   `chmod +x`, ensure system ffmpeg, restart workflows.
4. **Storage-related failures** → App Storage bucket not created yet.
5. A failing **code-review step is not a test failure** — do not loop on it,
   do not rewrite healthy code to satisfy it. All four checks green
   (api test/typecheck, ui test/typecheck) = the import is correct.
