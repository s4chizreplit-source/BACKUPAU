# AutoCliper 🎬

**An educational, open-source final-year academic project** that demonstrates automated video processing: it accepts a user-supplied video URL or file source and generates short vertical clips (Shorts/Reels format) from its most engaging moments, using open-source tools like `yt-dlp` and `FFmpeg`.

## 🤖 Host this anywhere with an AI agent

Want to run or deploy this project on a fresh Replit App (or any other host)? Give your AI agent
this repository link and tell it:

> **"Clone this repo, read `SETUP_PROMPT.md` at the root, and follow it step by step until the
> app is running and deployed."**

[`SETUP_PROMPT.md`](./SETUP_PROMPT.md) contains the complete runbook: system dependencies,
environment variables/secrets, database & storage setup, dev workflows, verification checklist,
deployment commands, and the platform gotchas.

---

## 🎓 Educational Purpose & Responsible Use

> **This repository is a student final-year (capstone) project, built strictly for educational and research purposes.**
>
> - It exists to demonstrate full-stack engineering concepts: REST API design, background job queues, video stream processing, HLS handling, transcript analysis, and cloud deployment.
> - It is **not** a commercial piracy tool, a content repository, or a DRM-circumvention tool.
> - It is built on widely used open-source foundations (`yt-dlp`, `FFmpeg`) for legitimate software research and media-processing education.
> - The operator must supply content they own, have permission to use, or are otherwise legally allowed to process.
> - Optional social publishing is user-controlled; the project does not grant permission to repost someone else’s content.

## ⚖️ Legal & Acceptable Use

This software is provided for **personal, educational, and lawful research purposes only**. By using it, you agree that:

1. **You only process content you have the right to use** — your own videos, videos you have explicit permission for, or content under licenses that allow it (e.g. Creative Commons).
2. **You are responsible for complying** with the Terms of Service of any platform (YouTube, Twitch, Kick, etc.) and with the copyright laws of your country.
3. **You do not use the project for mass scraping, spam, harassment, impersonation, or unauthorized redistribution.**
4. **You do not bypass authentication, paywalls, DRM, access controls, rate limits, or other technical protections.**
5. **You review every clip before publishing it.** Any connected social-account publishing is an explicit operator action and remains the operator’s responsibility.
6. **You review storage and retention settings** before hosting the project for other users, especially when processing uploaded or copyrighted material.

The authors and contributors **do not endorse or encourage copyright infringement** in any form. If you are a rights holder and believe this project is being misused, please open a GitHub issue with the relevant details so the maintainers can review it.

This documentation describes the project’s intended use; it does not guarantee that GitHub or any third-party platform will take no action. Users and operators must follow the applicable platform rules.

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
| Testing | Vitest — API and UI unit tests |

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
pnpm --filter @workspace/api-server run test        # API tests
pnpm --filter @workspace/api-server run typecheck
```

## 📄 License

Released under the [MIT License](LICENSE). Provided **"as is"**, without warranty of any kind. The software is a proof-of-concept for academic evaluation; the authors accept no liability for how third parties choose to use it.

---

*Built as a final-year academic project to learn and demonstrate modern full-stack and media-processing engineering.*
