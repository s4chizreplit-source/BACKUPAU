---
name: Hostinger VPS hosting
description: AutoCliper self-hosted on the user's Hostinger VPS — installer flow, dirty-VPS quirks, migration state, DNS cutover implications
---

- App self-hosted on user's Hostinger KVM 1 VPS (srv1676033, 187.77.145.183, Ubuntu 24.04) via `deploy/hostinger-setup.sh`: systemd `autocliper.service` (node, port 3000) + Caddy (80/443, /etc/caddy/Caddyfile hardcodes autocliper.com) + local PostgreSQL; env at /etc/autocliper.env (CLIPS_DIR local disk, STORAGE_SIZE_CAP_GB auto). Updates via `deploy/update.sh`.
- **Repo is PUBLIC** (made public 2026-08-01 so the installer can curl raw). **Never commit secrets or PII**; migration dumps matching `artifacts/ytdlp-ui/public/migration-*.sql` are gitignored on purpose.
  **Why:** checkpoints auto-commit workspace files; a dump in a served dir would leak user rows to the public repo.
- Installer hard lessons: `curl | bash` makes `read` prompts consume the script's own source lines as answers (all reads now use `</dev/tty`); reused VPSes had zombie nginx/PM2 holding 80/443/3000 (stop+disable+pkill before caddy) and git "dubious ownership" on re-runs (safe.directory added); domain input is shape-validated before writing the Caddyfile.
- Prod data migrated to VPS 2026-08-01: users/credit_ledger/billing_requests/upi_orders/zyla_cache (25/56/4/3/25 rows) via psql dump wrapped in `SET session_replication_role = replica` (order/FK-immune, superuser only). Clip FILES were NOT migrated — old history downloads on VPS 404; files remain in Replit Object Storage. The same verified fresh dump was imported into the new Mumbai VPS before DNS cutover.
- Transfer pattern for future dumps: write to gitignored `artifacts/ytdlp-ui/public/migration-<32hex>.sql` (vite serves it at the dev preview root over HTTPS), VPS curls it, delete immediately after import.
- After DNS cutover of autocliper.com to the VPS, "republish on Replit" reminders are moot; the Replit deployment stays up as fallback until the user confirms VPS stability, then he may stop it.
- `executeSql` output is CSV-quoted (cells containing commas/newlines wrapped in double quotes, embedded quotes doubled) — parse with a real CSV reader, never naive line-splits, when reconstructing values.

## Env drift between hosts (added 2026-08-10)
- New provider API keys (e.g. Post for Me) must be added to /etc/autocliper.env BY HAND — Replit secrets never propagate to the VPS. Missing key => /social/status configured:false => every Connect button silently disabled (UI now dims them + tooltip explains).
- The Replit deployment is a SECOND live host with its own secrets and DB. "Connect works there but is dead on autocliper.pro" almost always means env drift between hosts, not a frontend bug — probe /api/social/status on each host first.
