# AutoCliper 🎬

**An educational, open-source final-year academic project** that demonstrates automated video processing: it takes a publicly available video link and generates short vertical clips (Shorts/Reels format) from its most engaging moments, using open-source tools like `yt-dlp` and `FFmpeg`.

## 🤖 Host this anywhere with an AI agent

Want to run or deploy this project on a fresh Replit App (or any other host)? Give your AI agent
this repository link and tell it:

> **"Clone this repo, read `SETUP_PROMPT.md` at the root, and follow it step by step until the
> app is running and deployed."**

[`SETUP_PROMPT.md`](./SETUP_PROMPT.md) contains the complete runbook: system dependencies,
environment variables/secrets, database & storage setup, dev workflows, verification checklist,
deployment commands, and the platform gotchas.

---

## 🎓 Educational Purpose Disclaimer

> **This repository is a student final-year (capstone) project, built strictly for educational and research purposes.**
>
> - It exists to demonstrate full-stack engineering concepts: REST API design, background job queues, video stream processing, HLS handling, transcript analysis, and cloud deployment.
> - It is **not** a commercial piracy tool, and it does **not** host, store, re-upload, or distribute any copyrighted content.
> - It is built on the same widely used open-source foundations (`yt-dlp`, `FFmpeg`) that power thousands of legitimate research and archival projects on GitHub.
> - No paywalled, DRM-protected, or private content is accessed. The software only processes content that is already publicly reachable, exactly like a browser can.

## ⚖️ Legal & Acceptable Use

This software is provided for **personal, educational, and fair-use purposes only**. By using it, you agree that:

1. **You only process content you have the right to use** — your own videos, videos you have explicit permission for, or content under licenses that allow it (e.g. Creative Commons).
2. **You are responsible for complying** with the Terms of Service of any platform (YouTube, Twitch, Kick, etc.) and with the copyright laws of your country.
3. **Clips are generated locally and temporarily** for the user who requests them — nothing is republished or redistributed by this project.
4. **No DRM circumvention** — the project does not and will not bypass any technical protection measures.

The authors and contributors **do not endorse or encourage copyright infringement** in any form. If you are a rights holder and believe this project is being misused, please open a GitHub issue and we will respond promptly.

## ✨ What It Demonstrates (Features)

- 🔗 Paste a public video link (YouTube, Twitch, Kick VODs, Google Drive/Dropbox files you own)
- 🧠 Transcript-based highlight detection — finds the most engaging moments instead of random timestamps
- ✂️ Generates up to 10 short clips (15–60s) in vertical 9:16 format with H.264/AAC encoding
- ⚡ Section-based downloading — fetches only the seconds needed for each clip, never the full video
- 🔄 Async job queue with progress polling, in-flight request coalescing, and disk-space guards
- 🍪 Optional user-provided cookies for age-restricted content **the user already has access to**

## 🛠️ Tech Stack

| Layer | Technology |
|---|---|
| Frontend | React + TypeScript + Vite + Tailwind CSS |
| Backend | Node.js + Fastify + TypeScript |
| Video | yt-dlp + FFmpeg (open-source) |
| Auth | Clerk |
| Storage | Object storage for generated clips (auto-expiring) |
| Testing | Vitest — 126+ unit tests |

## 🚀 Running Locally

```bash
pnpm install
# backend
PORT=8080 pnpm --filter @workspace/api-server run dev
# frontend
PORT=5000 pnpm --filter @workspace/ytdlp-ui run dev
```

Requires `yt-dlp` and `FFmpeg` binaries available on the system path (both open-source).

## 🧪 Tests

```bash
pnpm --filter @workspace/api-server run test        # 126+ tests
pnpm --filter @workspace/api-server run typecheck
```

## 📄 License

Released under the [MIT License](LICENSE). Provided **"as is"**, without warranty of any kind. The software is a proof-of-concept for academic evaluation; the authors accept no liability for how third parties choose to use it.

---

*Built as a final-year academic project to learn and demonstrate modern full-stack and media-processing engineering.*
