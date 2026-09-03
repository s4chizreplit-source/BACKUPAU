/**
 * YouTube cookies management routes.
 *
 * POST   /ytdlp/cookies         — upload/paste a cookies.txt (body: { cookies: string })
 * GET    /ytdlp/cookies/status  — { configured, source, youtubeCookieCount, updatedAt }
 * DELETE /ytdlp/cookies         — remove uploaded cookies
 *
 * Cookie contents are never echoed back in any response.
 */
import { Router, type IRouter } from "express";
import { requireAdmin } from "../middlewares/sessionAuth";
import {
  saveCookies,
  deleteCookies,
  getCookieStatus,
  restoreCookiesFromStorage,
} from "../lib/cookieStore";

const router: IRouter = Router();

// Restore persisted cookies once at startup (async, non-blocking).
restoreCookiesFromStorage().catch((err: unknown) =>
  console.warn("[cookies] startup restore error:", (err as Error).message),
);

router.get("/ytdlp/cookies/status", (req, res): void => {
  res.json(getCookieStatus());
});

// Uploading/removing cookies affects every user's pipeline — admin only.
router.post("/ytdlp/cookies", requireAdmin, async (req, res): Promise<void> => {

  const { cookies } = req.body as { cookies?: string };
  if (!cookies || typeof cookies !== "string") {
    res.status(400).json({ error: "Missing required field: cookies (cookies.txt content)" });
    return;
  }

  const result = await saveCookies(cookies);
  if (!result.ok) {
    res.status(422).json({ error: result.error, code: "INVALID_COOKIES" });
    return;
  }

  req.log.info({ youtubeCookieCount: result.youtubeCookieCount, persisted: result.persisted }, "YouTube cookies saved");
  res.json({
    ok: true,
    youtubeCookieCount: result.youtubeCookieCount,
    persisted: result.persisted,
    status: getCookieStatus(),
  });
});

router.delete("/ytdlp/cookies", requireAdmin, async (req, res): Promise<void> => {
  await deleteCookies();
  req.log.info("YouTube cookies removed");
  res.json({ ok: true, status: getCookieStatus() });
});

export default router;
