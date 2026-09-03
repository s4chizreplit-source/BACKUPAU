---
name: Railway deployment config
description: How AutoCliper is configured for Railway hosting
---

## Config files added
- `railway.toml` — build + start commands for Railway
- `nixpacks.toml` — Node 20 + ffmpeg via Nix
- `railway.env.example` — all required env vars documented

## yt-dlp on Railway
Build step downloads binary to `/usr/local/bin/yt-dlp` (always on PATH).
`YTDLP_PATH` env var is NOT needed on Railway — `findBinaryFallback` finds it automatically.
On Replit dev, `YTDLP_PATH=/home/runner/workspace/bin/yt-dlp` is still set in `.replit` shared env.

## Start command
`node --enable-source-maps artifacts/api-server/dist/index.mjs`
PORT is injected by Railway automatically.

**Why:** Single-server setup — api-server serves compiled frontend static files in production.
**How to apply:** When Railway env vars are needed, refer to `railway.env.example` for the full list.
