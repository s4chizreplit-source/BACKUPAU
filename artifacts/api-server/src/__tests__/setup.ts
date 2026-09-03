// Global vitest setup (runs before every test file).
//
// Unit tests must NEVER reach the real Zyla API: every start call costs paid
// quota, and queue/clip tests submit fake YouTube URLs by the dozen. The dev
// workspace exports the real ZYLA_API_KEY, so without this guard the clip
// pipeline's Zyla resolver would fire real network calls inside tests.
//
// Files that exercise the Zyla routes (ytDownload.test.ts) stub global fetch
// AND set their own fake key in beforeEach — they are unaffected by this.
delete process.env["ZYLA_API_KEY"];

// Give every test worker its OWN cookies directory. The default is a fixed
// /tmp path shared by parallel test files AND the running dev server — tests
// were racing each other (flaky failures) and wiping the server's live
// cookies.txt. cookieStore reads this env at import time, which is exactly
// when setup files have already run.
import fs from "fs";
import os from "os";
import path from "path";
process.env["CLIPAI_COOKIES_DIR"] = fs.mkdtempSync(path.join(os.tmpdir(), "clipai-cookies-test-"));
