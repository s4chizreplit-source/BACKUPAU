// Auto-Pilot "video link" campaigns: the user pastes a YouTube/Kick/Twitch/
// direct link, a normal clip job runs on the backend, and the finished clips
// become campaign items (url = "clip:<fileId>") that the materializer
// schedules exactly like folder files. Share tokens are minted at provider-
// handoff time (they expire) — never here.
//
// Ownership is enforced by construction: clips only ever attach to campaigns
// whose user_id equals the job's paying user, so a foreign clip_job_id can
// never leak someone else's clips into your campaign.
import { requireDb } from "./db";

export interface CampaignClip {
  id: string;
  label: string;
  caption?: string | null;
}

/** Attach a settled job's clips to every campaign of this user waiting on
 *  that job. Idempotent — UNIQUE(campaign_id, url) makes replays no-ops.
 *  Returns how many campaigns matched (0 = job has no campaign; caller may
 *  then run the normal instant auto-post path). */
export async function ingestClipsIntoCampaigns(
  jobId: string,
  userId: string,
  clips: CampaignClip[],
): Promise<number> {
  const db = requireDb();
  const { rows } = await db.query<{ id: string }>(
    `SELECT id FROM social_campaigns WHERE clip_job_id = $1 AND user_id = $2`,
    [jobId, userId],
  );
  if (rows.length === 0) return 0;

  if (clips.length === 0) {
    // A "done" job with zero clips means nothing usable came out — surface
    // that instead of leaving the campaign spinning forever.
    await failClipCampaigns(jobId, userId, "No clips came out of this video — try a different link.");
    return rows.length;
  }

  for (const c of rows) {
    for (const [i, clip] of clips.entries()) {
      await db.query(
        `INSERT INTO social_campaign_items (campaign_id, url, file_name, sort_order)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (campaign_id, url) DO NOTHING`,
        [c.id, `clip:${clip.id}`, (clip.caption || clip.label || `Clip ${i + 1}`).slice(0, 200), i],
      );
    }
    await db.query(
      `UPDATE social_campaigns
       SET clip_status = 'ready', last_error = NULL, updated_at = NOW()
       WHERE id = $1 AND clip_status IS DISTINCT FROM 'ready'`,
      [c.id],
    );
  }
  return rows.length;
}

/** Mark waiting campaigns failed when their clip job errors out or is
 *  cancelled — the card shows the reason and the user can delete/retry.
 *  Never touches campaigns that already went 'ready'. */
export async function failClipCampaigns(jobId: string, userId: string, message: string): Promise<void> {
  await requireDb().query(
    `UPDATE social_campaigns
     SET clip_status = 'failed', last_error = $3, updated_at = NOW()
     WHERE clip_job_id = $1 AND user_id = $2 AND clip_status = 'clipping'`,
    [jobId, userId, message.slice(0, 300)],
  );
}
