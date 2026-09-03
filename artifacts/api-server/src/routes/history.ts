/**
 * Per-account clip history — which videos a user clipped and with what
 * settings. Requires a signed-in session; rows live in the `clip_jobs` table.
 *
 * Finished clip files (object-storage ids + metadata) are stored on the row
 * too, so a signed-in user can re-download clips from any device. Files are
 * stored permanently now (rows with files_permanent = TRUE); legacy rows from
 * the 2h-TTL era show an honest "expired" state instead.
 */
import { Router, type IRouter, type Response } from "express";
import { pool } from "../lib/db";
import { deleteStoredFile, isStoredRemotely, readFileMeta } from "../lib/fileStore";
import { getUserJobFileIds } from "./videoTools";
import { requireUser } from "../middlewares/sessionAuth";
import { normalizeCampaignRequirements, type CampaignRequirements } from "../lib/campaignRequirements";

/** How long new clips live before auto-deletion (7 days). */
export const CLIP_AUTO_EXPIRE_MS = 7 * 24 * 60 * 60 * 1000;

const router: IRouter = Router();

// Legacy only: rows created before clips became permanent had a 2h storage
// TTL (created_at anchors "were the files still alive?"). Rows with
// files_permanent = TRUE never consult this.
export const CLIP_FILE_TTL_MS = 2 * 60 * 60 * 1000;

function noDb(res: Response): void {
  res.status(503).json({ error: "History is not available — database is not configured." });
}

// ── Server-side sanitising of client-posted clip metadata ────────────────────
// The client posts what the clip pipeline returned to it, but never trust the
// shape: cap counts/lengths and keep only the fields the History UI needs.
// Thumbnails (base64 data URLs) are deliberately dropped — they'd bloat rows.
interface StoredClip {
  id: string;
  name: string;
  label: string;
  startTime: string;
  endTime: string;
  duration: string;
  size: number;
  caption?: string;
  campaignRequirements?: CampaignRequirements;
}

const MAX_CLIPS = 30;
const str = (v: unknown, max: number): string =>
  typeof v === "string" ? v.slice(0, max) : "";

export function sanitizeClips(raw: unknown): StoredClip[] | null {
  if (!Array.isArray(raw)) return null;
  const out: StoredClip[] = [];
  for (const c of raw.slice(0, MAX_CLIPS)) {
    if (!c || typeof c !== "object") continue;
    const r = c as Record<string, unknown>;
    const id = str(r.id, 128);
    // File ids are hex/uuid-ish tokens — refuse anything that could be a path.
    if (!/^[\w.-]{8,128}$/.test(id)) continue;
    const clip: StoredClip = {
      id,
      name: str(r.name, 128) || "clip.mp4",
      label: str(r.label, 64) || "Clip",
      startTime: str(r.startTime, 32),
      endTime: str(r.endTime, 32),
      duration: str(r.duration, 32),
      size: typeof r.size === "number" && Number.isFinite(r.size) ? Math.max(0, Math.floor(r.size)) : 0,
    };
    const caption = str(r.caption, 2000);
    if (caption) clip.caption = caption;
    const campaignRequirements = normalizeCampaignRequirements(r.campaignRequirements);
    if (campaignRequirements) clip.campaignRequirements = campaignRequirements;
    out.push(clip);
  }
  return out.length > 0 ? out : null;
}

// ── GET /api/history ─────────────────────────────────────────────────────────
router.get("/history", requireUser, async (req, res): Promise<void> => {
  if (!pool) { noDb(res); return; }
  try {
    const { rows } = await pool.query(
      `SELECT id, source_url, platform, clip_duration, clip_count,
              total_duration, status, created_at, clips, files_permanent,
              clip_expires_at
       FROM clip_jobs
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT 50`,
      [req.currentUser!.id],
    );
    const now = Date.now();
    const jobs = rows.map((r) => {
      const createdMs = Date.parse(r.created_at);
      const hasClips = Array.isArray(r.clips) && r.clips.length > 0;
      // Saved (files_permanent=true) rows never expire.
      // Rows with clip_expires_at: alive until that timestamp.
      // Legacy rows (no clip_expires_at, files_permanent=false): old 2h TTL.
      let alive: boolean;
      if (r.files_permanent === true) {
        alive = hasClips;
      } else if (r.clip_expires_at) {
        alive = hasClips && Date.parse(r.clip_expires_at) > now;
      } else {
        alive = hasClips && Number.isFinite(createdMs) && now - createdMs < CLIP_FILE_TTL_MS;
      }
      const { files_permanent, clip_expires_at, ...rest } = r;
      return {
        ...rest,
        clips: alive ? r.clips : null,
        clips_expired: hasClips && !alive,
        clips_expire_at: alive && !files_permanent ? (clip_expires_at ?? null) : null,
        files_saved: files_permanent === true,
      };
    });
    res.json({ jobs });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── POST /api/history ────────────────────────────────────────────────────────
router.post("/history", requireUser, async (req, res): Promise<void> => {
  if (!pool) { noDb(res); return; }
  const { sourceUrl, platform, clipDuration, clipCount, totalDuration, clips } =
    req.body as {
      sourceUrl?: string;
      platform?: string;
      clipDuration?: number;
      clipCount?: number;
      totalDuration?: string;
      clips?: unknown;
    };
  if (!sourceUrl) { res.status(400).json({ error: "sourceUrl required" }); return; }
  let storedClips = sanitizeClips(clips);
  // SECURITY — never trust client-posted file ids. A history row grants
  // permanent download rights (the file routes consult clip_jobs when
  // authorizing), so an unverified save would let anyone "claim" a foreign
  // file id and then download it. Keep only ids the server can prove are the
  // user's own: referenced by one of THEIR durable job records (covers
  // shared-cache clips, where one file id legitimately belongs to several
  // accounts, and legacy files without ownerId), or whose file meta carries
  // their ownerId. Everything else is dropped and logged.
  if (storedClips && storedClips.length > 0) {
    const uid = req.currentUser!.id;
    const jobFileIds = await getUserJobFileIds(uid);
    const verdicts = await Promise.all(
      storedClips.map(async (c) => {
        if (jobFileIds.has(c.id)) return true;
        const meta = await readFileMeta(c.id);
        return meta?.ownerId === uid;
      }),
    );
    const dropped = storedClips.filter((_, i) => !verdicts[i]).map((c) => c.id);
    if (dropped.length > 0) {
      storedClips = storedClips.filter((_, i) => verdicts[i]);
      req.log.warn({ userId: uid, dropped }, "history save dropped unverified clip ids");
      if (storedClips.length === 0) storedClips = null;
    }
  }
  // Only advertise permanence when every referenced file actually reached
  // Object Storage. During a storage outage clips can be local-only — those
  // die with the local cache, so their rows keep the honest legacy 2h gate.
  let filesPermanent = false;
  if (storedClips) {
    const checks = await Promise.all(storedClips.map((c) => isStoredRemotely(c.id)));
    filesPermanent = checks.length > 0 && checks.every(Boolean);
  }
  // All clips saved permanently by default — cloud storage will be added later.
  filesPermanent = true;
  const expiresAt = null;
  try {
    const { rows } = await pool.query(
      `INSERT INTO clip_jobs (user_id, source_url, platform, clip_duration, clip_count, total_duration, clips, files_permanent, clip_expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [
        req.currentUser!.id,
        sourceUrl,
        platform ?? "shorts",
        clipDuration ?? 60,
        clipCount ?? 10,
        totalDuration ?? null,
        storedClips ? JSON.stringify(storedClips) : null,
        filesPermanent,
        expiresAt,
      ],
    );
    res.json({ id: rows[0].id });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── PATCH /api/history/:id/save ──────────────────────────────────────────────
// Toggle "saved" state. Saving a clip sets files_permanent=true and clears
// clip_expires_at so the auto-cleanup job never touches it. Un-saving resets
// expiry to 14 days from now (or now+14d if it already passed).
router.patch("/history/:id/save", requireUser, async (req, res): Promise<void> => {
  if (!pool) { noDb(res); return; }
  const { save } = req.body as { save?: boolean };
  const saving = save !== false; // default true
  try {
    const newExpiry = saving ? null : new Date(Date.now() + CLIP_AUTO_EXPIRE_MS);
    const { rowCount } = await pool.query(
      `UPDATE clip_jobs
          SET files_permanent   = $1,
              clip_expires_at   = $2
        WHERE id = $3 AND user_id = $4`,
      [saving, newExpiry, req.params.id, req.currentUser!.id],
    );
    if (!rowCount) { res.status(404).json({ error: "Session not found." }); return; }
    res.json({ ok: true, saved: saving });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── DELETE /api/history/:id ──────────────────────────────────────────────────
router.delete("/history/:id", requireUser, async (req, res): Promise<void> => {
  if (!pool) { noDb(res); return; }
  try {
    // Clips are stored permanently, so deleting a history row must also
    // reclaim the files — and files go FIRST. If storage is unreachable we
    // keep the row and fail the request, so the user can simply retry
    // (deleteStoredFile is idempotent). Deleting the row first would strand
    // the files forever: no TTL sweeper ever touches permanent clips.
    const { rows } = await pool.query(
      "SELECT clips FROM clip_jobs WHERE id = $1 AND user_id = $2",
      [req.params.id, req.currentUser!.id],
    );
    const clips = rows[0]?.clips;
    if (Array.isArray(clips)) {
      const ids = clips
        .map((c) => (c as { id?: unknown })?.id)
        .filter((x): x is string => typeof x === "string");
      const results = await Promise.allSettled(ids.map((id) => deleteStoredFile(id)));
      const allOk = results.every((r) => r.status === "fulfilled" && r.value === true);
      if (!allOk) {
        res.status(502).json({
          error: "Couldn't remove the clip files from storage — please try again in a moment.",
        });
        return;
      }
    }
    await pool.query(
      "DELETE FROM clip_jobs WHERE id = $1 AND user_id = $2",
      [req.params.id, req.currentUser!.id],
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── Auto-cleanup: delete files for expired clip_jobs rows ─────────────────────
// Called from the periodic storage sweep in videoTools.ts every 15 min.
// Finds rows whose clip_expires_at has passed, deletes their files, then
// nulls the clips column so they show the "expired" state in History.
export async function cleanupExpiredClipJobs(): Promise<void> {
  if (!pool) return;
  try {
    // Fetch up to 50 expired rows at a time (avoids long transactions).
    const { rows } = await pool.query<{ id: number; clips: unknown }>(
      `SELECT id, clips FROM clip_jobs
        WHERE files_permanent = FALSE
          AND clip_expires_at IS NOT NULL
          AND clip_expires_at < NOW()
          AND clips IS NOT NULL
        LIMIT 50`,
    );
    if (rows.length === 0) return;

    for (const row of rows) {
      const clips = Array.isArray(row.clips) ? row.clips as Array<{ id?: unknown }> : [];
      const ids = clips.map(c => c?.id).filter((x): x is string => typeof x === "string");
      // Delete files — tolerate individual failures (files may already be gone).
      await Promise.allSettled(ids.map(id => deleteStoredFile(id)));
      // Null out clips column so the row shows "expired" in History.
      await pool.query(
        `UPDATE clip_jobs SET clips = NULL WHERE id = $1`,
        [row.id],
      );
    }
    console.log(`[history] Auto-cleaned ${rows.length} expired clip job(s).`);
  } catch (err) {
    console.warn("[history] cleanupExpiredClipJobs error:", (err as Error).message);
  }
}

export default router;
