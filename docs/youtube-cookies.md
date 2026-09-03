# YouTube cookies — keeping downloads working when YouTube blocks the server

YouTube intermittently blocks datacenter IPs with a **"Sign in to confirm you're not
a bot"** wall. When that happens the fast section-download path fails and the app
falls back to slower third-party APIs that only do full downloads. Providing a
YouTube `cookies.txt` lets every yt-dlp call (metadata probe, section downloads,
full downloads) pass the bot check reliably.

## How to provide cookies

### Option A — in the app (recommended)
1. Install a cookies exporter browser extension, e.g. **"Get cookies.txt LOCALLY"**
   (Chrome/Firefox). It exports in the Netscape format yt-dlp requires.
2. Open **youtube.com** while signed in, click the extension, and export the cookies.
3. In the clipper UI, expand **"YouTube cookies"** below the clip settings and
   upload or paste the file.

The server validates the file (must be Netscape format with at least one
`youtube.com` cookie), stores it with `0600` permissions outside the git tree, and
persists a copy to private object storage so it survives restarts. Cookies take
effect immediately — no restart needed. They are never echoed back by any API and
can be removed anytime from the same panel.

### Option B — server operator
Set the `YTDLP_COOKIES_FILE` environment variable to the path of a cookies.txt on
the server. When set, it takes priority over cookies uploaded in the UI.

## Account-safety tradeoffs

- **Cookies act as a login** for the account they came from. Anyone with the file
  can act as that account. Never commit them to git or share them.
- **Use a throwaway/secondary Google account.** Heavy automated downloading can,
  in rare cases, get an account flagged or temporarily blocked by YouTube.
- Cookies expire — if YouTube blocks return, re-export and re-upload.
- Removing cookies (UI panel → Remove, or `DELETE /ytdlp/cookies`) deletes both
  the local file and the persisted copy.

## API

- `GET /ytdlp/cookies/status` → `{ configured, source: "env"|"uploaded"|null, youtubeCookieCount, updatedAt }`
- `POST /ytdlp/cookies` with `{ "cookies": "<cookies.txt content>" }`
- `DELETE /ytdlp/cookies` — removes uploaded cookies (does not affect `YTDLP_COOKIES_FILE`)

## Verifying the fast path

With cookies present, clip jobs for YouTube URLs should log:

```
Section downloads done — skipped full-video download
```

in the API server output, meaning only the clip sections were transferred instead
of the whole video.
