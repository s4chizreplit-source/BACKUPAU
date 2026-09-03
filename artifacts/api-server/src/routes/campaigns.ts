/**
 * Auto-Pilot campaigns — reusable "post this folder to these accounts" templates.
 *
 * A campaign maps a public Drive/Dropbox folder to a set of the user's
 * connected accounts, with a date range, times-of-day, and how many videos
 * to post at each time. A small materializer turns each campaign-day into
 * ordinary social_posts rows (source='campaign', batch_id=campaign id) that
 * the EXISTING scheduler drain hands to Post for Me — no new posting path.
 *
 * Multi-instance safety: a campaign is materialized inside a transaction
 * holding FOR UPDATE SKIP LOCKED on its row, and last_planned_date advances
 * under that lock — so each campaign-day is planned exactly once, no matter
 * how many server instances run. Missed days (downtime) are skipped, never
 * backfilled: posts are always in the future.
 *
 * Pause semantics: OFF cancels this campaign's not-yet-posted rows (provider
 * side too) and frees their videos; ON resumes from today with those videos
 * first in line. Already-published posts are never touched.
 */

import { Router, type IRouter } from "express";
import rateLimit from "express-rate-limit";
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { requireUser } from "../middlewares/sessionAuth";
import { requireDb } from "../lib/db";
import { isPfmConfigured, verifyAccountOwnership, refreshAggregateRows } from "../lib/postforme";
import { probeGDriveDownloadBlocked } from "../lib/gdriveBlock";
import { extractGDriveId } from "./videoTools";
import { generateViralCaption, isGeminiConfigured } from "../lib/gemini";
import { buildClipCaption } from "../lib/captions";
import { extractCampaignRequirements, enforceCaptionRequirements, normalizeCampaignRequirements } from "../lib/campaignRequirements";
import { ingestClipsIntoCampaigns, failClipCampaigns } from "../lib/campaignClips";
import { readJobAnywhere } from "./videoTools";
import {
  expandSource, zonedTimeToUtc, isRealDate, prettyName, addDaysStr,
  cancelRow, type SocialPostRow, type SourceFile,
} from "./social";
import { parseIgUsername, igListProfileVideos, type IgVideoItem } from "./instagram";
import { parseTikTokUsername, listTikTokProfileVideos, type TikTokVideoItem } from "./tiktok";

const router: IRouter = Router();

const MAX_ACTIVE_CAMPAIGNS = 20;
const MAX_RANGE_DAYS = 400;
const MAX_ITEMS = 1000;   // matches the bulk scheduler's per-batch cap
// Keep a finite safety bound while allowing campaigns to schedule all videos
// in a large folder at one posting time. The actual number posted is still
// limited by the campaign's available items.
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const campaignDetectLimiter = rateLimit({
  windowMs: 60_000,
  limit: 20,
  keyGenerator: (req) => req.currentUser?.id ?? "anonymous",
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many source checks — wait a minute and try again." },
});

export interface CampaignRow {
  id: string; user_id: string; name: string; source_url: string;
  account_ids: string[]; times: string[]; per_slot: number;
  start_date: string; end_date: string; timezone: string; caption: string;
  ai_captions: boolean; enabled: boolean; status: string; last_planned_date: string | null;
  last_error: string | null; created_at: string; updated_at: string;
  source_kind: string; clip_job_id: string | null; clip_status: string | null;
  clip_params: { clipCount?: number; quality?: string; prompt?: string } | null;
  handoff_lead_minutes: number | null;
}

export type CampaignCaptionMode = "filename" | "custom" | "ai";

/** The two legacy columns encode one mutually-exclusive UI choice:
 * AI always wins, otherwise non-empty custom text wins, otherwise filename. */
export function campaignCaptionMode(
  c: Pick<CampaignRow, "caption" | "ai_captions">,
): CampaignCaptionMode {
  if (c.ai_captions) return "ai";
  return c.caption.trim() ? "custom" : "filename";
}

/** Resolve exactly what will be posted for the selected caption mode.
 * AI failures use a deterministic viral caption, never a filename disguised
 * as an AI result. */
export function resolveCampaignCaption(
  c: Pick<CampaignRow, "caption" | "ai_captions" | "source_kind">,
  fileName: string,
  seed: string,
  aiCaption?: string | null,
): string {
  const mode = campaignCaptionMode(c);
  if (mode === "custom") return c.caption.trim();
  const readableName = prettyName(fileName) || fileName;
  if (mode === "filename") return readableName;
  const generated = aiCaption?.trim();
  if (generated) return generated;
  return buildClipCaption({
    srcKind: c.source_kind,
    outputFormat: "shorts",
    clipIndex: 0,
    clipCount: 1,
    durationSec: 30,
    sourceName: fileName,
    seed,
    // Auto-Pilot's AI caption option is English-first; a failed model call
    // must still produce a viral caption rather than exposing the filename.
    language: "en",
  });
}

/** Re-apply the campaign's selected caption mode to posts that are still
 * waiting locally. Already handed-off/posted rows are immutable here. This
 * also repairs old AI rows that were created with the filename fallback. */
async function refreshPendingCampaignCaptions(
  c: CampaignRow,
  opts: { onlyFilenameFallback?: boolean } = {},
): Promise<number> {
  const db = requireDb();
  const found = await db.query<{
    id: string; file_name: string; caption: string; media_url: string; platforms: string[];
  }>(
    `SELECT id, file_name, caption, media_url, platforms
     FROM social_posts
     WHERE user_id = $1 AND batch_id = $2 AND source = 'campaign'
       AND status IN ('queued','creating') AND pfm_post_id IS NULL
       AND scheduled_at > NOW()
     ORDER BY scheduled_at ASC
     LIMIT 100`,
    [c.user_id, c.id],
  );
  const rows = opts.onlyFilenameFallback
    ? found.rows.filter((row) => row.caption.trim() === (prettyName(row.file_name) || row.file_name))
    : found.rows;
  if (rows.length === 0) return 0;

  const mode = campaignCaptionMode(c);
  const aiDeadline = Date.now() + 10_000;
  const campReq = typeof c.clip_params?.prompt === "string"
    ? extractCampaignRequirements(c.clip_params.prompt)
    : null;
  const ids: string[] = [];
  const captions: string[] = [];
  for (const row of rows) {
    let aiCaption: string | null = null;
    if (mode === "ai" && isGeminiConfigured() && process.env.VITEST !== "true") {
      const left = aiDeadline - Date.now();
      if (left > 500) {
        aiCaption = await generateViralCaption(prettyName(row.file_name) || row.file_name, {
          platforms: row.platforms,
          timeoutMs: Math.min(4_000, left),
        });
      }
    }
    let caption = resolveCampaignCaption(c, row.file_name, row.media_url, aiCaption);
    if (campReq) caption = enforceCaptionRequirements(caption, campReq);
    ids.push(row.id);
    captions.push(caption);
  }
  const updated = await db.query(
    `UPDATE social_posts AS p
     SET caption = v.caption, updated_at = NOW()
     FROM (SELECT unnest($1::text[]) AS id, unnest($2::text[]) AS caption) AS v
     WHERE p.id = v.id AND p.user_id = $3 AND p.batch_id = $4
       AND p.status IN ('queued','creating') AND p.pfm_post_id IS NULL`,
    [ids, captions, c.user_id, c.id],
  );
  return updated.rowCount ?? 0;
}

// "Schedule ahead" window: hand posts to the platform N minutes before their
// slot. NULL = as soon as the day is planned (legacy). Bounds keep the value
// meaningful — below 5 min the hand-off pipeline can't finish reliably, and
// beyond 24h it's indistinguishable from "immediately" (days plan daily).
export const MIN_LEAD_MINUTES = 5;
export const MAX_LEAD_MINUTES = 1440;

/** Parse a request-body leadMinutes value. null/'' clear the setting
 *  (= hand off immediately); numbers must be whole minutes in bounds. */
export function parseLeadMinutes(v: unknown): { ok: true; value: number | null } | { ok: false; error: string } {
  if (v === undefined || v === null || v === "") return { ok: true, value: null };
  const n = Number(v);
  if (!Number.isInteger(n) || n < MIN_LEAD_MINUTES || n > MAX_LEAD_MINUTES) {
    return {
      ok: false,
      error: `Schedule-ahead time must be a whole number of minutes between ${MIN_LEAD_MINUTES} and ${MAX_LEAD_MINUTES} (24 hours).`,
    };
  }
  return { ok: true, value: n };
}

/** Clip-job settings captured at campaign create, so a failed job can be
 *  retried later with the SAME settings. Returns null for anything that isn't
 *  an object (legacy campaigns stay null → the UI falls back to form defaults). */
export function sanitizeClipParams(v: unknown): { clipCount: number; quality: "fast" | "quality"; prompt?: string } | null {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const o = v as { clipCount?: unknown; quality?: unknown; prompt?: unknown };
  const n = Number(o.clipCount);
  // The AI prompt is stored for two jobs: "Try clips again" replays it, and
  // the materializer re-applies pasted campaign rules to every caption.
  const prompt = typeof o.prompt === "string" ? o.prompt.replace(/\s+/g, " ").trim().slice(0, 10_000) : "";
  return {
    clipCount: Number.isInteger(n) ? Math.min(50, Math.max(1, n)) : 5,
    quality: o.quality === "fast" ? "fast" : "quality",
    ...(prompt ? { prompt } : {}),
  };
}

// ── Pure date/slot helpers (exported for tests) ───────────────────────────────

/** Wall-clock YYYY-MM-DD for `now` in an IANA timezone. */
export function todayInTz(timeZone: string, now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(now);
}

/** Inclusive day count of a YYYY-MM-DD range (1 = same day). */
export function rangeDays(start: string, end: string): number {
  const [y1, m1, d1] = start.split("-").map(Number);
  const [y2, m2, d2] = end.split("-").map(Number);
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86_400_000) + 1;
}

/** Which campaign-day should be materialized right now? null = nothing to do.
 *  Days the server slept through are skipped (never backfilled). */
export function nextMaterializeDate(
  c: { start_date: string; end_date: string; last_planned_date: string | null },
  today: string,
): string | null {
  let d = c.last_planned_date ? addDaysStr(c.last_planned_date, 1) : c.start_date;
  if (d < c.start_date) d = c.start_date;  // range was edited forward
  if (d < today) d = today;                // downtime catch-up: jump to today
  if (d > today) return null;              // today already planned / starts later
  if (d > c.end_date) return null;         // range over
  return d;
}

/** A slot that passed no more than this long ago still posts (shortly after
 *  "now"). Anything later is NOT posted the same day — users pick exact
 *  posting times, and an hours-late catch-up turns "12:00, 16:00, 18:00"
 *  into three posts in a ten-minute burst (real user complaint). */
export const LATE_GRACE_MS = 30 * 60_000;

/** One entry per video to post on `dateStr`. Campaigns now always store
 *  per_slot = 1 (one video per posting time); legacy rows created by the old
 *  multiplier UI may still repeat a time per_slot times.
 *  Slots post AT their set times. A slot that just passed (≤ LATE_GRACE_MS —
 *  brief downtime, a clip job finishing moments late, "created 12:05 with a
 *  12:00 slot") is recovered at now+5min, staggered 10 min apart so several
 *  near-misses don't fire together. A slot missed by MORE than the grace is
 *  skipped for the day: its video stays queued and simply rides the next
 *  planned day's slots. */
export function planDaySlots(
  times: string[], perSlot: number, dateStr: string, timeZone: string, nowMs: number,
): Date[] {
  const out: Date[] = [];
  let recovered = 0;
  for (const t of [...times].sort()) {
    let at = zonedTimeToUtc(dateStr, t, timeZone);
    const lateMs = nowMs - at.getTime();
    if (lateMs > LATE_GRACE_MS) continue; // long gone — rolls to a later day
    if (at.getTime() < nowMs + 5 * 60_000) {
      at = new Date(nowMs + 5 * 60_000 + recovered * 10 * 60_000);
      recovered++;
    }
    for (let i = 0; i < perSlot; i++) out.push(at);
  }
  // Recovered slots can land after a genuinely-future one; keep the queue in
  // time order so folder order == posting order.
  return out.sort((a, b) => a.getTime() - b.getTime());
}

/** Next posting instant within the range (display only — the queue is truth
 *  once rows exist). */
export function nextRunAt(
  c: { times: string[]; start_date: string; end_date: string; timezone: string; last_planned_date?: string | null },
  now: Date = new Date(),
): Date | null {
  const today = todayInTz(c.timezone, now);
  const from = today > c.start_date ? today : c.start_date;
  if (from > c.end_date) return null;
  const sorted = [...c.times].sort();
  const minMs = now.getTime() + 5 * 60_000;
  // Today is in range but not planned yet, and a slot passed within the
  // grace → the materializer will catch it up minutes from now (see
  // planDaySlots). Slots missed by more than the grace roll forward instead.
  if (from === today && (c.last_planned_date ?? "") < today) {
    const hasRecoverable = sorted.some((t) => {
      const at = zonedTimeToUtc(today, t, c.timezone).getTime();
      return at < minMs && now.getTime() - at <= LATE_GRACE_MS;
    });
    if (hasRecoverable) return new Date(minMs);
  }
  for (let i = 0; i <= MAX_RANGE_DAYS; i++) {
    const d = addDaysStr(from, i);
    if (d > c.end_date) return null;
    for (const t of sorted) {
      const at = zonedTimeToUtc(d, t, c.timezone);
      if (at.getTime() >= minMs) return at;
    }
  }
  return null;
}

// ── Validation ────────────────────────────────────────────────────────────────

function cleanTimes(times: unknown): string[] | null {
  const arr = Array.isArray(times) ? [...new Set(times.map((t) => String(t)))] : [];
  if (arr.length === 0 || arr.length > 12 || arr.some((t) => !TIME_RE.test(t))) return null;
  return arr.sort();
}

function cleanAccountIds(ids: unknown): string[] {
  return Array.isArray(ids)
    ? [...new Set(ids.filter((x): x is string => typeof x === "string" && x.length > 0))].slice(0, 50)
    : [];
}

function validTimezone(tz: unknown): string | null {
  const s = typeof tz === "string" && tz ? tz : "UTC";
  try { new Intl.DateTimeFormat("en-US", { timeZone: s }); return s; }
  catch { return null; }
}

// ── Item ingestion ────────────────────────────────────────────────────────────

/** Append detected videos to a campaign's item list. Already-known URLs keep
 *  their row (and consumed state); new ones are appended in listing order.
 *  `skipFirst` marks the first N files (the OLDEST, lists are oldest-first)
 *  as held back: they are stored so the rescan knows them, but never post. */
async function insertItems(client: PoolClient, campaignId: string, files: SourceFile[], skipFirst = 0): Promise<void> {
  if (files.length === 0) return;
  const { rows } = await client.query<{ max: number | null }>(
    `SELECT MAX(sort_order) AS max FROM social_campaign_items WHERE campaign_id = $1`,
    [campaignId],
  );
  let order = (rows[0]?.max ?? -1) + 1;
  const urls: string[] = [], names: string[] = [], orders: number[] = [], skips: boolean[] = [];
  const seen = new Set<string>();
  for (let idx = 0; idx < files.length; idx++) {
    const f = files[idx]!;
    if (seen.has(f.url)) continue;
    seen.add(f.url);
    urls.push(f.url); names.push(f.name); orders.push(order++); skips.push(idx < skipFirst);
  }
  await client.query(
    `INSERT INTO social_campaign_items (campaign_id, url, file_name, sort_order, skipped)
     SELECT $1, unnest($2::text[]), unnest($3::text[]), unnest($4::int[]), unnest($5::boolean[])
     ON CONFLICT (campaign_id, url) DO NOTHING`,
    [campaignId, urls, names, orders, skips],
  );
}

/** Display name for an IG video: caption snippet when present (hashtags and
 *  handles stripped), else a stable "@user reel <id-tail>" fallback. */
export function igFileName(username: string, v: IgVideoItem): string {
  const cap = (v.caption ?? "").replace(/[#@]\S+/g, " ").replace(/\s+/g, " ").trim();
  if (cap.length >= 8) return cap.slice(0, 80);
  return `@${username} ${v.kind} ${v.id.slice(-6)}`;
}

/** Campaign items for a profile's videos. Instagram lists newest-first;
 *  campaigns post OLDEST-first so the account's story replays in order.
 *  Items carry no CDN URL (those rot in hours) — just a stable reference
 *  the posting relay re-resolves at publish time. */
export function igItemsToFiles(username: string, videos: IgVideoItem[]): SourceFile[] {
  return [...videos].reverse().map((v) => ({
    url: `ig:${username}:${v.kind}:${v.id}`,
    name: igFileName(username, v),
  }));
}

/** Display name for a TikTok video, preferring its description while keeping
 * stable, readable names when the post has no caption. */
export function tikTokFileName(username: string, video: TikTokVideoItem): string {
  const caption = (video.caption ?? "").replace(/[#@]\S+/g, " ").replace(/\s+/g, " ").trim();
  if (caption.length >= 8) return caption.slice(0, 80);
  return `@${username} video ${video.id.slice(-8)}`;
}

/** TikTok returns newest-first; campaigns replay the backlog oldest-first. */
export function tikTokItemsToFiles(username: string, videos: TikTokVideoItem[]): SourceFile[] {
  return [...videos].reverse().map((video) => ({
    url: `tt:${username}:${video.id}`,
    name: tikTokFileName(username, video),
  }));
}

/** Insert newly-discovered profile videos AHEAD of the unposted backlog —
 *  "a new reel goes out at the next slot" is what Auto-Pilot from a live
 *  profile means. Known URLs keep their row and consumed state; sort_order
 *  may go negative, which pickItems handles (plain ORDER BY). */
async function insertNewIgItemsFront(client: PoolClient, campaignId: string, files: SourceFile[]): Promise<void> {
  if (files.length === 0) return;
  const { rows } = await client.query<{ min: number | null; urls: string[] | null }>(
    `SELECT MIN(sort_order) AS min, ARRAY_AGG(url) AS urls
     FROM social_campaign_items WHERE campaign_id = $1`,
    [campaignId],
  );
  const known = new Set(rows[0]?.urls ?? []);
  const fresh = files.filter((f) => !known.has(f.url));
  if (fresh.length === 0) return;
  let order = (rows[0]?.min ?? 0) - fresh.length;
  const urls: string[] = [], names: string[] = [], orders: number[] = [];
  for (const f of fresh) { urls.push(f.url); names.push(f.name); orders.push(order++); }
  await client.query(
    `INSERT INTO social_campaign_items (campaign_id, url, file_name, sort_order)
     SELECT $1, unnest($2::text[]), unnest($3::text[]), unnest($4::int[])
     ON CONFLICT (campaign_id, url) DO NOTHING`,
    [campaignId, urls, names, orders],
  );
}

// ── Materializer (the daily worker) ───────────────────────────────────────────

export async function materializeOne(id: string, now: Date): Promise<void> {
  const client = await requireDb().connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<CampaignRow>(
      `SELECT * FROM social_campaigns
       WHERE id = $1 AND enabled AND status = 'active'
       FOR UPDATE SKIP LOCKED`,
      [id],
    );
    const c = rows[0];
    if (!c) { await client.query("ROLLBACK"); return; }

    // Link campaigns wait for their clip job. The day is deliberately NOT
    // consumed — the moment clips land, today's remaining slots still plan
    // (times missed by ≤ the grace window catch up at now+5min; older ones
    // wait for their next day's slot).
    if (c.source_kind === "clip_link" && c.clip_status !== "ready") {
      await client.query("ROLLBACK");
      return;
    }

    const today = todayInTz(c.timezone, now);
    const d = nextMaterializeDate(c, today);
    if (!d) { await client.query("ROLLBACK"); return; }

    const slots = planDaySlots(c.times, c.per_slot, d, c.timezone, now.getTime());
    if (slots.length === 0) {
      // Every slot today already passed by more than the grace (campaign
      // created/resumed late in the day). Consume the day — the videos stay
      // queued and post at tomorrow's slots.
      await client.query(
        `UPDATE social_campaigns SET last_planned_date = $2, updated_at = NOW() WHERE id = $1`,
        [c.id, d],
      );
      await client.query("COMMIT");
      return;
    }

    // Only currently-connected selected accounts get posts. None connected →
    // surface a warning and retry next tick (the day is NOT consumed).
    const { owned } = await verifyAccountOwnership(c.user_id, c.account_ids);
    if (owned.length === 0) {
      const msg = "None of the selected accounts are connected — reconnect them on the Social page";
      if (c.last_error !== msg) {
        await client.query(
          `UPDATE social_campaigns SET last_error = $2, updated_at = NOW() WHERE id = $1`,
          [c.id, msg],
        );
      }
      await client.query("COMMIT");
      return;
    }
    const ownedIds = owned.map((o) => o.pfmAccountId);
    const platforms = [...new Set(owned.map((o) => o.platform))];

    const pickItems = async (): Promise<{ id: number; url: string; file_name: string }[]> => {
      const r = await client.query<{ id: number; url: string; file_name: string }>(
        `SELECT id, url, file_name FROM social_campaign_items
         WHERE campaign_id = $1 AND post_row_id IS NULL AND NOT skipped
         ORDER BY sort_order, id
         LIMIT $2`,
        [c.id, slots.length],
      );
      return r.rows;
    };

    let items = await pickItems();
    if (c.source_kind === "folder" && items.length < slots.length && rescansInFlight < 2) {
      // The folder may have grown since ingestion — re-scan (at most once per
      // campaign-day, and only when we're short). Failures are non-fatal.
      rescansInFlight++;
      try {
        const fresh = await expandSource(c.source_url).catch(() => null);
        if (fresh && fresh.files.length > 0) {
          await insertItems(client, c.id, fresh.files.slice(0, MAX_ITEMS));
          items = await pickItems();
        }
      } finally {
        rescansInFlight--;
      }
    } else if ((c.source_kind === "instagram" || c.source_kind === "tiktok") && rescansInFlight < 2) {
      // A live profile grows — rescan on EVERY planned day (not only when
      // short) so new reels are discovered and jump the queue: they post at
      // the next slots, ahead of the remaining backlog. Failures are
      // non-fatal; today still plans from what's already ingested.
      rescansInFlight++;
      try {
        const uname = c.source_kind === "instagram" ? parseIgUsername(c.source_url) : parseTikTokUsername(c.source_url);
        const r = uname
          ? c.source_kind === "instagram"
            ? await igListProfileVideos(uname).catch(() => null)
            : await listTikTokProfileVideos(uname).catch(() => null)
          : null;
        if (uname && r && r.ok && r.videos.length > 0) {
          const files = c.source_kind === "instagram"
            ? igItemsToFiles(uname, r.videos as IgVideoItem[])
            : tikTokItemsToFiles(uname, r.videos as TikTokVideoItem[]);
          await insertNewIgItemsFront(client, c.id, files.slice(0, MAX_ITEMS));
          items = await pickItems();
        }
      } finally {
        rescansInFlight--;
      }
    }

    if (items.length === 0) {
      if (c.source_kind === "instagram" || c.source_kind === "tiktok") {
        // A live profile is never "done" — new reels may appear any day. Stay
        // active, consume the day (today's rescan already ran above), and let
        // tomorrow's materialization rescan again. end_date still bounds the
        // campaign: past it, nextMaterializeDate stops planning (and paying
        // for rescans) entirely.
        await client.query(
          `UPDATE social_campaigns
           SET last_planned_date = $2, last_error = NULL, updated_at = NOW()
           WHERE id = $1`,
          [c.id, d],
        );
        await client.query("COMMIT");
         console.log(`[autopilot] campaign ${c.id}: no unposted ${c.source_kind} videos for ${d} — watching for new ones`);
        return;
      }
      await client.query(
        `UPDATE social_campaigns
         SET status = 'exhausted', last_planned_date = $2, last_error = NULL, updated_at = NOW()
         WHERE id = $1`,
        [c.id, d],
      );
      await client.query("COMMIT");
      console.log(`[autopilot] campaign ${c.id} exhausted (all videos posted)`);
      return;
    }

    const rowIds: string[] = [], urls: string[] = [], names: string[] = [], caps: string[] = [], ats: string[] = [];
    // AI captions run under a strict total budget so this campaign's
    // transaction client is never held long on a slow model. Anything past
    // the budget gets a deterministic viral caption — never a filename when
    // the user explicitly selected AI.
    const aiDeadline = Date.now() + 10_000;
    // Clip-link campaigns whose clip job carried pasted campaign rules: every
    // posted caption must satisfy the compulsory tags/CTA — whatever its
    // source (custom text, AI, or filename). Deterministic, so posting never
    // depends on a model call.
    const campReq = typeof c.clip_params?.prompt === "string"
      ? extractCampaignRequirements(c.clip_params.prompt)
      : null;
    for (const [i, it] of items.entries()) {
      const name = it.file_name || `Video ${it.id}`;
      rowIds.push(randomUUID());
      urls.push(it.url);
      names.push(name);
      let aiCaption: string | null = null;
      if (campaignCaptionMode(c) === "ai" && isGeminiConfigured()) {
        const left = aiDeadline - Date.now();
        if (left > 500) {
          aiCaption = await generateViralCaption(prettyName(name) || name, {
            platforms, timeoutMs: Math.min(4_000, left),
          });
        }
      }
      let cap = resolveCampaignCaption(c, name, it.url, aiCaption);
      if (campReq) cap = enforceCaptionRequirements(cap, campReq);
      caps.push(cap);
      ats.push(slots[i].toISOString());
    }

    await client.query(
      `INSERT INTO social_posts
         (id, user_id, source, batch_id, media_url, file_name, caption, account_ids, platforms, scheduled_at, status)
       SELECT unnest($1::text[]), $2, 'campaign', $3, unnest($4::text[]), unnest($5::text[]),
              unnest($6::text[]), $7::text[], $8::text[], unnest($9::timestamptz[]), 'queued'`,
      [rowIds, c.user_id, c.id, urls, names, caps, ownedIds, platforms, ats],
    );
    await client.query(
      `UPDATE social_campaign_items AS it
       SET post_row_id = m.rid, planned_for = m.at::timestamptz
       FROM (SELECT unnest($1::int[]) AS iid, unnest($2::text[]) AS rid, unnest($3::text[]) AS at) AS m
       WHERE it.id = m.iid`,
      [items.map((it) => it.id), rowIds, ats],
    );

    const { rows: rem } = await client.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM social_campaign_items
       WHERE campaign_id = $1 AND post_row_id IS NULL`,
      [c.id],
    );
    // Instagram campaigns never exhaust — the daily rescan keeps watching the
    // profile for new reels until end_date.
    const exhausted = c.source_kind !== "instagram" && c.source_kind !== "tiktok" && Number(rem[0]?.n ?? "0") === 0;
    await client.query(
      `UPDATE social_campaigns
       SET last_planned_date = $2, last_error = NULL, status = $3, updated_at = NOW()
       WHERE id = $1`,
      [c.id, d, exhausted ? "exhausted" : "active"],
    );
    await client.query("COMMIT");
    console.log(`[autopilot] campaign ${c.id}: planned ${items.length} post(s) for ${d}`);
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    const msg = `Auto-pilot hiccup: ${(err as Error).message}`.slice(0, 300);
    await requireDb().query(
      `UPDATE social_campaigns SET last_error = $2, updated_at = NOW() WHERE id = $1`,
      [id, msg],
    ).catch(() => {});
    console.warn(`[autopilot] campaign ${id} failed:`, (err as Error).message);
  } finally {
    client.release();
  }
}

// At most 2 folder rescans in flight across the parallel materialize workers:
// a rescan is network I/O made while holding that campaign's transaction
// client, so a burst of exhausted campaigns must not pin pool connections on
// slow Drive responses. Campaigns that skip simply retry on a later tick.
let rescansInFlight = 0;

let materializeBusy = false;
export async function materializeCampaigns(now: Date = new Date()): Promise<void> {
  if (materializeBusy || !isPfmConfigured()) return;
  materializeBusy = true;
  try {
    const { rows } = await requireDb().query<{ id: string }>(
      `SELECT id FROM social_campaigns
       WHERE enabled AND status = 'active'
       ORDER BY updated_at ASC
       LIMIT 100`,
    );
    // A few campaigns in parallel: one slow Drive folder rescan must not
    // stall everyone behind it. Safe — materializeOne takes the campaign's
    // row lock (FOR UPDATE SKIP LOCKED), so overlap just skips.
    const ids = rows.map((r) => r.id);
    let cursor = 0;
    await Promise.all(
      Array.from({ length: Math.min(4, ids.length) }, async () => {
        while (cursor < ids.length) {
          const id = ids[cursor++];
          await materializeOne(id, now).catch((err) => {
            console.warn(`[autopilot] campaign ${id} failed:`, (err as Error).message);
          });
        }
      }),
    );
  } catch (err) {
    console.warn("[autopilot] tick failed:", (err as Error).message);
  } finally {
    materializeBusy = false;
  }
}

// The workspace shell exports NODE_ENV=development globally, so vitest keeps
// it — VITEST is the reliable "inside a test process" signal. Background
// sweeps must never fire there: they'd plan REAL campaigns from the shared
// dev database under whatever mocks the test file installed.
const IS_TEST = process.env.NODE_ENV === "test" || process.env.VITEST !== undefined;
if (!IS_TEST) {
  setInterval(() => { void materializeCampaigns(); }, 60_000).unref();
  setTimeout(() => { void materializeCampaigns(); }, 7_000).unref();  // boot: plan today promptly
}

const kickMaterializer = (): void => {
  // Tests drive materializeOne on their own seeded campaigns — a background
  // sweep here would touch OTHER campaigns in the shared dev database.
  if (IS_TEST) return;
  setTimeout(() => { void materializeCampaigns(); }, 150).unref();
};

// ── Pause / delete helpers ────────────────────────────────────────────────────

/** Cancel every not-yet-published row of a campaign (provider side included)
 *  and put their videos back in line. Published posts are untouched. */
async function stopFuturePosts(userId: string, campaignId: string): Promise<{ cancelled: number; errors: number }> {
  const db = requireDb();
  const { rows } = await db.query<SocialPostRow>(
    `SELECT * FROM social_posts
     WHERE batch_id = $1 AND user_id = $2 AND status IN ('queued','creating','scheduled','failed')`,
    [campaignId, userId],
  );
  let cancelled = 0, errors = 0;
  for (const row of rows) {
    const err = await cancelRow(row);
    if (err) errors++; else cancelled++;
  }
  await db.query(
    `UPDATE social_campaign_items SET post_row_id = NULL, planned_for = NULL
     WHERE campaign_id = $1
       AND post_row_id IN (SELECT id FROM social_posts WHERE batch_id = $1 AND status = 'cancelled')`,
    [campaignId],
  );
  return { cancelled, errors };
}

// ── Routes ────────────────────────────────────────────────────────────────────

function displayState(c: CampaignRow, today: string): string {
  if (!c.enabled) return "paused";
  if (c.status === "exhausted") return "exhausted";
  if (today > c.end_date) return "ended";
  if (today < c.start_date) return "upcoming";
  if (c.last_error) return "warning";
  return "running";
}

function campaignJson(c: CampaignRow): Record<string, unknown> {
  return {
    id: c.id, name: c.name, sourceUrl: c.source_url,
    accountIds: c.account_ids, times: c.times, perSlot: c.per_slot,
    startDate: c.start_date, endDate: c.end_date, timezone: c.timezone,
    caption: c.caption, aiCaptions: c.ai_captions, enabled: c.enabled,
    sourceKind: c.source_kind, clipStatus: c.clip_status,
    clipParams: c.clip_params ?? null,
    leadMinutes: c.handoff_lead_minutes,
    lastError: c.last_error, createdAt: c.created_at,
  };
}

// POST /social/caption-ai — one-shot viral caption for the UI's ✨ buttons
// (Auto-Pilot custom caption + the manual clip-post dialog).
router.post("/social/caption-ai", requireUser, async (req, res): Promise<void> => {
  if (!isGeminiConfigured()) {
    res.status(503).json({ error: "AI captions aren't set up yet — add a Gemini API key to the server." });
    return;
  }
  const body = (req.body ?? {}) as { hint?: unknown; platforms?: unknown; captionRequirements?: unknown };
  const hint = String(body.hint ?? "").trim().slice(0, 300);
  const platforms = Array.isArray(body.platforms)
    ? body.platforms.filter((p): p is string => typeof p === "string").slice(0, 10)
    : [];
  const generated = await generateViralCaption(hint || "a short viral video", { platforms });
  const requirements = normalizeCampaignRequirements(body.captionRequirements);
  const caption = generated && requirements
    ? enforceCaptionRequirements(generated, requirements)
    : generated;
  if (!caption) {
    res.status(502).json({ error: "The AI didn't answer — try again in a moment." });
    return;
  }
  res.json({ caption });
});

// POST /social/campaigns/detect — expand a link so the UI can show the count
router.post("/social/campaigns/detect", requireUser, campaignDetectLimiter, async (req, res): Promise<void> => {
  const body = (req.body ?? {}) as { source?: unknown; sourceKind?: unknown };
  const source = String(body.source ?? "").trim();
  if (!source) { res.status(400).json({ error: "Paste a Google Drive folder link first." }); return; }

  // Instagram profile? Either the UI said so, or the input is unmistakable
  // (instagram.com link / bare @handle). Counts VIDEOS only — photos never post.
  const igExplicit = body.sourceKind === "instagram";
  const ttExplicit = body.sourceKind === "tiktok";
  const igUsername = igExplicit || /instagram\.com/i.test(source) || (source.startsWith("@") && !ttExplicit)
    ? parseIgUsername(source) : null;
  if (igExplicit && !igUsername) {
    res.status(400).json({ error: "Enter a valid Instagram username or profile link." });
    return;
  }
  if (igUsername) {
    const r = await igListProfileVideos(igUsername, { deep: true });
    if (!r.ok) { res.status(r.status === 429 ? 429 : 400).json({ error: r.error }); return; }
    if (r.videos.length === 0) {
      res.status(400).json({ error: "No videos found on that profile — it may be private, empty, or photos-only." });
      return;
    }
    res.json({
      ok: true,
      ig: true,
      username: igUsername,
      count: Math.min(r.videos.length, MAX_ITEMS),
      names: r.videos.slice(0, 8).map((v) => igFileName(igUsername, v)),
    });
    return;
  }
  const ttUsername = ttExplicit || /tiktok\.com/i.test(source) || (source.startsWith("@") && !igExplicit)
    ? parseTikTokUsername(source) : null;
  if (ttExplicit && !ttUsername) {
    res.status(400).json({ error: "Enter a valid TikTok username or profile link." });
    return;
  }
  if (ttUsername) {
    const r = await listTikTokProfileVideos(ttUsername, { deep: true });
    if (!r.ok) { res.status(r.status === 429 ? 429 : 400).json({ error: r.error }); return; }
    if (r.videos.length === 0) {
      res.status(400).json({ error: "No TikTok videos found on that profile — it may be private, empty, or unavailable." });
      return;
    }
    res.json({
      ok: true, tiktok: true, username: ttUsername,
      count: Math.min(r.videos.length, MAX_ITEMS),
      names: r.videos.slice(0, 8).map((v) => tikTokFileName(ttUsername, v)),
    });
    return;
  }
  try {
    const r = await expandSource(source);
    if (r.files.length === 0) {
      res.status(400).json({ error: r.skipped ?? "No videos found at that link." });
      return;
    }
    res.json({
      ok: true,
      count: Math.min(r.files.length, MAX_ITEMS),
      names: r.files.slice(0, 8).map((f) => f.name || "(unnamed)"),
      capped: r.files.length > MAX_ITEMS ? MAX_ITEMS : undefined,
    });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

// POST /social/campaigns — create (and start) a campaign
router.post("/social/campaigns", requireUser, async (req, res): Promise<void> => {
  const userId = req.currentUser!.id;
  if (!isPfmConfigured()) { res.status(503).json({ error: "Social posting is not configured." }); return; }
  const body = (req.body ?? {}) as {
    name?: unknown; source?: unknown; accountIds?: unknown; times?: unknown;
    perSlot?: unknown; startDate?: unknown; endDate?: unknown; timezone?: unknown; caption?: unknown;
    aiCaptions?: unknown; sourceKind?: unknown; clipJobId?: unknown; clipParams?: unknown;
    backlogLimit?: unknown; leadMinutes?: unknown;
  };

  // "folder" = Drive/Dropbox folder of ready videos. "clip_link" = a single
  // video link whose clips a backend job is generating right now — items
  // arrive when that job settles (or via the lazy reconciler on GET).
  // "instagram" = a public profile whose videos are reposted as-is; new
  // uploads are discovered on the daily rescan and jump the queue.
  let sourceKind: "folder" | "clip_link" | "instagram" | "tiktok" =
    body.sourceKind === "clip_link" ? "clip_link"
    : body.sourceKind === "instagram" ? "instagram"
    : body.sourceKind === "tiktok" ? "tiktok"
    : "folder";
  const clipJobId = sourceKind === "clip_link" ? String(body.clipJobId ?? "").trim() : "";
  if (sourceKind === "clip_link" && !/^[a-f0-9]{16,64}$/i.test(clipJobId)) {
    res.status(400).json({ error: "Clip job reference is missing — start again." }); return;
  }
  let clipJobRec: Awaited<ReturnType<typeof readJobAnywhere>> = null;
  if (sourceKind === "clip_link") {
    // The job must exist AND belong to the caller — otherwise anyone could
    // attach a foreign jobId and park a campaign in 'clipping' forever.
    // Same generic error either way so job-id existence never leaks.
    const jobRec = await readJobAnywhere(clipJobId).catch(() => null);
    if (!jobRec || jobRec.userId !== userId) {
      res.status(400).json({ error: "That clip job could not be found — start again from the form." }); return;
    }
    if (jobRec.status === "error" || jobRec.status === "cancelled") {
      res.status(400).json({ error: "That clip job already failed — start a new one." }); return;
    }
    clipJobRec = jobRec;
  }

  const source = String(body.source ?? "").trim();
  if (!source) {
    res.status(400).json({
      error: sourceKind === "clip_link"
        ? "Paste a video link (YouTube, Kick, Twitch, or a direct .mp4)."
        : sourceKind === "instagram"
          ? "Enter the Instagram profile (@username or link)."
          : sourceKind === "tiktok"
            ? "Enter the TikTok profile (@username or link)."
          : "Paste a Google Drive/Dropbox folder link.",
    });
    return;
  }
  // An unmistakable Instagram link on the folder tab is treated as Instagram —
  // expandSource would only reject it with a confusing folder error.
  if (sourceKind === "folder" && /instagram\.com/i.test(source) && parseIgUsername(source)) {
    sourceKind = "instagram";
  }
  if (sourceKind === "folder" && /tiktok\.com/i.test(source) && parseTikTokUsername(source)) {
    sourceKind = "tiktok";
  }
  const igUsername = sourceKind === "instagram" ? parseIgUsername(source) : null;
  if (sourceKind === "instagram" && !igUsername) {
    res.status(400).json({ error: "Enter a valid Instagram username or profile link." });
    return;
  }
  const tiktokUsername = sourceKind === "tiktok" ? parseTikTokUsername(source) : null;
  if (sourceKind === "tiktok" && !tiktokUsername) {
    res.status(400).json({ error: "Enter a valid TikTok username or profile link." });
    return;
  }
  const times = cleanTimes(body.times);
  if (!times) { res.status(400).json({ error: "Times must be 1-12 unique entries in HH:MM (24-hour) format." }); return; }
  // One video per posting time — the number of times IS the daily quota.
  // body.perSlot from older clients is deliberately ignored: the old
  // multiplier UI let 3 times × 3 videos silently become 9 posts a day.
  // For clip campaigns the pairing is strict: every clip gets its own time.
  const clipParams = sourceKind === "clip_link" ? sanitizeClipParams(body.clipParams) : null;
  if (sourceKind === "clip_link") {
    if (!clipParams) { res.status(400).json({ error: "Clip settings are missing — start again from the form." }); return; }
    if (clipParams.clipCount !== times.length) {
      const n = clipParams.clipCount;
      res.status(400).json({
        error: `Every clip needs its own posting time — ${n} clip${n === 1 ? "" : "s"} need${n === 1 ? "s" : ""} exactly ${n} posting time${n === 1 ? "" : "s"} (you added ${times.length}).`,
      });
      return;
    }
    // The attached job is the source of truth for how many clips will arrive —
    // a mismatched job would starve some posting times or spill extras across
    // days. Jobs from before this rule carry no count and pass unchecked.
    const jobClips = Number(clipJobRec?.clipCount);
    if (Number.isInteger(jobClips) && jobClips !== clipParams.clipCount) {
      res.status(400).json({
        error: `This clip job cuts ${jobClips} clip${jobClips === 1 ? "" : "s"} but the campaign is set to ${clipParams.clipCount} — start again from the form so they match.`,
      });
      return;
    }
  }
  const startDate = String(body.startDate ?? "");
  const endDate = String(body.endDate ?? "");
  if (!isRealDate(startDate) || !isRealDate(endDate)) {
    res.status(400).json({ error: "Start and end dates must be real YYYY-MM-DD dates." }); return;
  }
  if (endDate < startDate) { res.status(400).json({ error: "End date must be on or after the start date." }); return; }
  if (rangeDays(startDate, endDate) > MAX_RANGE_DAYS) {
    res.status(400).json({ error: `Date range is too long — keep it under ${MAX_RANGE_DAYS} days.` }); return;
  }
  const tz = validTimezone(body.timezone);
  if (!tz) { res.status(400).json({ error: "Invalid timezone." }); return; }
  if (endDate < todayInTz(tz)) { res.status(400).json({ error: "End date is already in the past." }); return; }
  const caption = String(body.caption ?? "").trim().slice(0, 2000);
  const aiCaptions = body.aiCaptions === true;
  const name = (String(body.name ?? "").trim() || "Auto-Pilot").slice(0, 80);

  // How long before each slot the post is handed to the platform as a
  // scheduled post. NULL = as soon as it's planned (legacy behavior).
  const leadParsed = parseLeadMinutes(body.leadMinutes);
  if (!leadParsed.ok) { res.status(400).json({ error: leadParsed.error }); return; }
  const leadMinutes = leadParsed.value;

  // Instagram only: cap how many of the profile's EXISTING videos post — the
  // newest N. Older ones are ingested but held back; new uploads discovered
  // by the daily rescan always post. Empty/absent = post the whole backlog.
  let backlogLimit: number | null = null;
  if ((sourceKind === "instagram" || sourceKind === "tiktok") && body.backlogLimit !== undefined && body.backlogLimit !== null && body.backlogLimit !== "") {
    const n = Number(body.backlogLimit);
    if (!Number.isInteger(n) || n < 0 || n > MAX_ITEMS) {
      res.status(400).json({ error: "Past-videos limit must be a whole number (0 or more)." });
      return;
    }
    backlogLimit = n;
  }

  const ids = cleanAccountIds(body.accountIds);
  if (ids.length === 0) { res.status(400).json({ error: "Select at least one account." }); return; }
  const { owned, foreign } = await verifyAccountOwnership(userId, ids);
  if (foreign.length > 0) {
    res.status(403).json({ error: "One or more selected accounts don't belong to your profile — refresh and try again." });
    return;
  }
  if (owned.length === 0) {
    res.status(400).json({ error: "None of the selected accounts are connected — connect them on the Social page first." });
    return;
  }

  const db = requireDb();
  const { rows: activeRows } = await db.query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM social_campaigns WHERE user_id = $1 AND enabled`, [userId],
  );
  if (Number(activeRows[0]?.n ?? "0") >= MAX_ACTIVE_CAMPAIGNS) {
    res.status(400).json({ error: `You already have ${MAX_ACTIVE_CAMPAIGNS} active campaigns — pause or delete one first.` });
    return;
  }

  let files: SourceFile[] = [];
  let skipFirst = 0; // instagram backlog limit: how many OLDEST files to hold back
  if (sourceKind === "folder") {
    try {
      const r = await expandSource(source);
      files = r.files.slice(0, MAX_ITEMS);
      if (files.length === 0) {
        res.status(400).json({ error: r.skipped ?? "No videos found at that link — is the folder public?" });
        return;
      }
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
      return;
    }

    // Preflight: a Drive folder can be listable while its files are
    // download-locked ("Only the owner and editors can download") — then every
    // post would fail silently over days. One cheap probe catches it NOW.
    const firstDriveId = files.map((f) => extractGDriveId(f.url)).find((x): x is string => !!x);
    if (firstDriveId) {
      const blocked = await probeGDriveDownloadBlocked(firstDriveId);
      if (blocked) { res.status(400).json({ error: blocked }); return; }
    }
  } else if (sourceKind === "instagram") {
    const r = await igListProfileVideos(igUsername!, { deep: true });
    if (!r.ok) { res.status(r.status === 429 ? 429 : 400).json({ error: r.error }); return; }
    files = igItemsToFiles(igUsername!, r.videos).slice(0, MAX_ITEMS);
    if (files.length === 0) {
      res.status(400).json({ error: "No videos found on that profile — it may be private, empty, or photos-only." });
      return;
    }
    // Files are oldest-first — holding back the first (len - N) keeps the
    // newest N active, and those still post oldest-first among themselves.
    if (backlogLimit !== null && files.length > backlogLimit) {
      skipFirst = files.length - backlogLimit;
    }
  } else if (sourceKind === "tiktok") {
    const r = await listTikTokProfileVideos(tiktokUsername!, { deep: true });
    if (!r.ok) { res.status(r.status === 429 ? 429 : 400).json({ error: r.error }); return; }
    files = tikTokItemsToFiles(tiktokUsername!, r.videos).slice(0, MAX_ITEMS);
    if (files.length === 0) {
      res.status(400).json({ error: "No TikTok videos found on that profile — it may be private, empty, or unavailable." });
      return;
    }
    if (backlogLimit !== null && files.length > backlogLimit) skipFirst = files.length - backlogLimit;
  }

  // Canonical profile URL for instagram — stable display, and the daily
  // rescan re-parses the username straight from it.
  const storedSource = sourceKind === "instagram"
    ? `https://www.instagram.com/${igUsername}/`
    : sourceKind === "tiktok"
      ? `https://www.tiktok.com/@${tiktokUsername}/`
      : source;
  const id = randomUUID();
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    // Clip settings (validated above: count === times) ride along so "Try
    // clips again" can replay the job with the exact settings the user picked.
    await client.query(
      `INSERT INTO social_campaigns
         (id, user_id, name, source_url, account_ids, times, per_slot,
          start_date, end_date, timezone, caption, ai_captions,
          source_kind, clip_job_id, clip_status, clip_params, handoff_lead_minutes, enabled, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,TRUE,'active')`,
      [id, userId, name, storedSource, ids, times, 1 /* one video per posting time */, startDate, endDate, tz, caption, aiCaptions,
       sourceKind, clipJobId || null, sourceKind === "clip_link" ? "clipping" : null,
       clipParams ? JSON.stringify(clipParams) : null, leadMinutes],
    );
    await insertItems(client, id, files, skipFirst);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    res.status(500).json({ error: (err as Error).message });
    return;
  } finally {
    client.release();
  }

  req.log.info({ campaignId: id, videos: files.length, held: skipFirst }, "[autopilot] campaign created");
  kickMaterializer();  // starts today's posts right away when the range includes today
  res.json({ ok: true, id, detected: files.length, queued: files.length - skipFirst });
});

// GET /social/campaigns — list with progress + queue truth
router.get("/social/campaigns", requireUser, async (req, res): Promise<void> => {
  const userId = req.currentUser!.id;
  const db = requireDb();
  const { rows: camps } = await db.query<CampaignRow>(
    `SELECT * FROM social_campaigns WHERE user_id = $1 ORDER BY created_at DESC`, [userId],
  );
  if (camps.length === 0) { res.json({ campaigns: [] }); return; }

  // Lazy reconciler for link campaigns: the clip job may have settled before
  // the campaign row existed (cached jobs are fast), or the server restarted
  // mid-ingest. Cheap — only 'clipping' campaigns hit the job store, and
  // ingestion is idempotent so racing the settle hook is harmless.
  for (const c of camps) {
    if (c.source_kind !== "clip_link" || c.clip_status !== "clipping" || !c.clip_job_id) continue;
    try {
      const rec = await readJobAnywhere(c.clip_job_id);
      if (rec?.status === "done") {
        const clips = (rec.clips ?? []).map((k) => ({ id: k.id, label: k.label ?? "", caption: k.caption ?? null }));
        await ingestClipsIntoCampaigns(c.clip_job_id, userId, clips);
        c.clip_status = clips.length > 0 ? "ready" : "failed";
        if (clips.length > 0) c.last_error = null;
      } else if (rec?.status === "error" || rec?.status === "cancelled") {
        const msg = rec.status === "cancelled" ? "Clip job was cancelled." : (rec.error ?? "Clip job failed.");
        await failClipCampaigns(c.clip_job_id, userId, msg);
        c.clip_status = "failed"; c.last_error = msg;
      } else if (!rec && Date.now() - new Date(c.created_at).getTime() > 45 * 60_000) {
        const msg = "Lost track of the clip job — delete this campaign and create it again.";
        await failClipCampaigns(c.clip_job_id, userId, msg);
        c.clip_status = "failed"; c.last_error = msg;
      }
    } catch { /* transient — the next poll retries */ }
  }

  const ids = camps.map((c) => c.id);
  const { rows: itemAgg } = await db.query<{ campaign_id: string; total: number; used: number }>(
    `SELECT campaign_id,
            COUNT(*) FILTER (WHERE NOT skipped)::int AS total,
            COUNT(*) FILTER (WHERE post_row_id IS NOT NULL)::int AS used
     FROM social_campaign_items WHERE campaign_id = ANY($1::text[])
     GROUP BY campaign_id`,
    [ids],
  );
  const { rows: postAgg } = await db.query<{
    batch_id: string; posted: number; failed: number; upcoming: number; next_at: string | null;
  }>(
    `SELECT batch_id,
            COUNT(*) FILTER (WHERE status IN ('posted','processing')
                             OR (status = 'scheduled' AND scheduled_at <= NOW()))::int AS posted,
            COUNT(*) FILTER (WHERE status = 'failed')::int AS failed,
            COUNT(*) FILTER (WHERE status IN ('queued','creating','scheduled')
                             AND scheduled_at > NOW())::int AS upcoming,
            MIN(scheduled_at) FILTER (WHERE status IN ('queued','creating','scheduled')
                                      AND scheduled_at > NOW()) AS next_at
     FROM social_posts
     WHERE user_id = $1 AND source = 'campaign' AND batch_id = ANY($2::text[])
     GROUP BY batch_id`,
    [userId, ids],
  );
  const byIdItems = new Map(itemAgg.map((r) => [r.campaign_id, r]));
  const byIdPosts = new Map(postAgg.map((r) => [r.batch_id, r]));

  res.json({
    campaigns: camps.map((c) => {
      const it = byIdItems.get(c.id);
      const po = byIdPosts.get(c.id);
      const today = todayInTz(c.timezone);
      const queueNext = po?.next_at ? new Date(po.next_at) : null;
      const computedNext = c.enabled && c.status === "active" ? nextRunAt(c) : null;
      return {
        ...campaignJson(c),
        state: displayState(c, today),
        totalVideos: it?.total ?? 0,
        usedVideos: it?.used ?? 0,
        posted: po?.posted ?? 0,
        failed: po?.failed ?? 0,
        upcoming: po?.upcoming ?? 0,
        nextAt: (queueNext ?? computedNext)?.toISOString() ?? null,
        daysLeft: today <= c.end_date ? rangeDays(today, c.end_date) : 0,
      };
    }),
  });
});

// PATCH /social/campaigns/:id — edit fields / toggle on-off
router.patch("/social/campaigns/:id", requireUser, async (req, res): Promise<void> => {
  const userId = req.currentUser!.id;
  const db = requireDb();
  const { rows } = await db.query<CampaignRow>(
    `SELECT * FROM social_campaigns WHERE id = $1 AND user_id = $2`,
    [req.params.id, userId],
  );
  const c = rows[0];
  if (!c) { res.status(404).json({ error: "Campaign not found" }); return; }

  const body = (req.body ?? {}) as Record<string, unknown>;
  const sets: string[] = [];
  const vals: unknown[] = [];
  const set = (col: string, v: unknown): void => { vals.push(v); sets.push(`${col} = $${vals.length + 2}`); };

  const captionSettingsSent = body.caption !== undefined || body.aiCaptions !== undefined;
  const nextCaption = body.caption !== undefined
    ? String(body.caption).trim().slice(0, 2000)
    : c.caption;
  const nextAiCaptions = body.aiCaptions !== undefined ? body.aiCaptions === true : c.ai_captions;
  if (body.name !== undefined) set("name", (String(body.name).trim() || "Auto-Pilot").slice(0, 80));
  if (body.caption !== undefined) set("caption", nextCaption);
  if (body.aiCaptions !== undefined) set("ai_captions", nextAiCaptions);

  if (body.leadMinutes !== undefined) {
    const lead = parseLeadMinutes(body.leadMinutes);
    if (!lead.ok) { res.status(400).json({ error: lead.error }); return; }
    // Applies to rows still waiting locally; posts already handed to the
    // platform keep the moment they were scheduled with.
    set("handoff_lead_minutes", lead.value);
  }

  if (body.times !== undefined) {
    const times = cleanTimes(body.times);
    if (!times) { res.status(400).json({ error: "Times must be 1-12 unique entries in HH:MM (24-hour) format." }); return; }
    // Clip campaigns keep the strict one-clip-one-time pairing on edits too —
    // otherwise a schedule edit could starve some times or spill clips across
    // days. Legacy rows without stored params (or with more clips than the
    // 12-time cap can pair) stay freely editable.
    if (c.source_kind === "clip_link") {
      const want = Number(c.clip_params?.clipCount);
      if (Number.isInteger(want) && want >= 1 && want <= 12 && times.length !== want) {
        res.status(400).json({
          error: `This campaign posts ${want} clip${want === 1 ? "" : "s"} — keep exactly ${want} posting time${want === 1 ? "" : "s"} (you sent ${times.length}).`,
        });
        return;
      }
    }
    set("times", times);
    // Editing the schedule moves the row to one-video-per-time semantics —
    // legacy campaigns may still carry per_slot > 1 from the old multiplier UI.
    set("per_slot", 1);
  }
  // body.perSlot is deliberately ignored: one video per posting time, always.

  const nextStart = body.startDate !== undefined ? String(body.startDate) : c.start_date;
  const nextEnd = body.endDate !== undefined ? String(body.endDate) : c.end_date;
  const nextTz = body.timezone !== undefined ? validTimezone(body.timezone) : c.timezone;
  if (body.startDate !== undefined || body.endDate !== undefined || body.timezone !== undefined) {
    if (!isRealDate(nextStart) || !isRealDate(nextEnd)) {
      res.status(400).json({ error: "Start and end dates must be real YYYY-MM-DD dates." }); return;
    }
    if (!nextTz) { res.status(400).json({ error: "Invalid timezone." }); return; }
    if (nextEnd < nextStart) { res.status(400).json({ error: "End date must be on or after the start date." }); return; }
    if (rangeDays(nextStart, nextEnd) > MAX_RANGE_DAYS) {
      res.status(400).json({ error: `Date range is too long — keep it under ${MAX_RANGE_DAYS} days.` }); return;
    }
    if (body.startDate !== undefined) set("start_date", nextStart);
    if (body.endDate !== undefined) set("end_date", nextEnd);
    if (body.timezone !== undefined) set("timezone", nextTz);
    // last_planned_date is deliberately NOT reset here: nextMaterializeDate
    // clamps into the edited range on its own, and a reset would re-plan a day
    // whose posts are already queued (double-posting). Only resume-after-pause
    // resets it — and pause has already cancelled the queued rows by then.
  }

  if (body.accountIds !== undefined) {
    const ids = cleanAccountIds(body.accountIds);
    if (ids.length === 0) { res.status(400).json({ error: "Select at least one account." }); return; }
    const { owned, foreign } = await verifyAccountOwnership(userId, ids);
    if (foreign.length > 0) { res.status(403).json({ error: "One or more selected accounts don't belong to your profile." }); return; }
    if (owned.length === 0) { res.status(400).json({ error: "None of the selected accounts are connected." }); return; }
    set("account_ids", ids);
  }

  // Source change → re-detect now, drop unused old videos, keep history
  let redetected: number | null = null;
  if (body.source !== undefined && String(body.source).trim() !== c.source_url) {
    if (c.source_kind === "instagram" || c.source_kind === "tiktok") {
      res.status(400).json({ error: `A ${c.source_kind === "tiktok" ? "TikTok" : "Instagram"} campaign is tied to its profile — create a new campaign for a different profile.` });
      return;
    }
    const source = String(body.source).trim();
    if (!source) { res.status(400).json({ error: "Folder link can't be empty." }); return; }
    let files: SourceFile[];
    try {
      const r = await expandSource(source);
      files = r.files.slice(0, MAX_ITEMS);
      if (files.length === 0) { res.status(400).json({ error: r.skipped ?? "No videos found at that link." }); return; }
    } catch (err) { res.status(400).json({ error: (err as Error).message }); return; }
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `DELETE FROM social_campaign_items WHERE campaign_id = $1 AND post_row_id IS NULL`, [c.id],
      );
      await insertItems(client, c.id, files);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      res.status(500).json({ error: (err as Error).message });
      return;
    } finally { client.release(); }
    set("source_url", source);
    set("status", "active");
    set("last_error", null);
    redetected = files.length;
  }

  // Toggle
  let stopped: { cancelled: number; errors: number } | null = null;
  const toggledOn = body.enabled === true && !c.enabled;
  const toggledOff = body.enabled === false && c.enabled;
  if (toggledOn) {
    const { rows: activeRows } = await db.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM social_campaigns WHERE user_id = $1 AND enabled AND id <> $2`,
      [userId, c.id],
    );
    if (Number(activeRows[0]?.n ?? "0") >= MAX_ACTIVE_CAMPAIGNS) {
      res.status(400).json({ error: `You already have ${MAX_ACTIVE_CAMPAIGNS} active campaigns — pause one first.` });
      return;
    }
    set("enabled", true);
    set("status", "active");
    set("last_planned_date", null);  // resume: re-plan today
    set("last_error", null);
  } else if (toggledOff) {
    set("enabled", false);
  }

  if (sets.length === 0 && !redetected) { res.json({ ok: true, unchanged: true }); return; }

  if (sets.length > 0) {
    await db.query(
      `UPDATE social_campaigns SET ${sets.join(", ")}, updated_at = NOW() WHERE id = $1 AND user_id = $2`,
      [c.id, userId, ...vals],
    );
  }

  let captionsRefreshed = 0;
  if (captionSettingsSent && !toggledOff) {
    captionsRefreshed = await refreshPendingCampaignCaptions({
      ...c,
      caption: nextCaption,
      ai_captions: nextAiCaptions,
    });
  }
  if (toggledOff) stopped = await stopFuturePosts(userId, c.id);
  if (toggledOn || redetected !== null || body.startDate !== undefined || body.endDate !== undefined) kickMaterializer();

  res.json({
    ok: true,
    ...(captionsRefreshed > 0 ? { captionsRefreshed } : {}),
    ...(redetected !== null ? { detected: redetected } : {}),
    ...(stopped ? { cancelled: stopped.cancelled, cancelErrors: stopped.errors } : {}),
  });
});

// POST /social/campaigns/:id/retry-clip — attach a FRESH clip job to a failed
// link campaign. The UI starts the new job first (same request as create:
// POST /video/clip with forCampaign:true) and hands the jobId here; the
// campaign flips back to 'clipping' and the normal settle/ingest machinery
// feeds it the clips when the job lands. Double-taps are harmless: the same
// settings hit the result cache, and an overwritten old job never auto-posts
// (forCampaign jobs with no matching campaign stay quiet by design).
router.post("/social/campaigns/:id/retry-clip", requireUser, async (req, res): Promise<void> => {
  const userId = req.currentUser!.id;
  const db = requireDb();
  const { rows } = await db.query<CampaignRow>(
    `SELECT * FROM social_campaigns WHERE id = $1 AND user_id = $2`,
    [req.params.id, userId],
  );
  const c = rows[0];
  if (!c) { res.status(404).json({ error: "Campaign not found" }); return; }
  if (c.source_kind !== "clip_link") {
    res.status(400).json({ error: "Only video-link campaigns have clips to retry." }); return;
  }
  if (c.clip_status !== "failed") {
    res.status(409).json({ error: "This campaign's clips are not in a failed state — nothing to retry." }); return;
  }
  // A campaign whose date range is already over would happily accept the new
  // (paid) clip job and then never post anything — make the user extend the
  // dates first. end_date is wall-clock YYYY-MM-DD in the campaign timezone.
  if (c.end_date < todayInTz(c.timezone)) {
    res.status(400).json({ error: "This campaign's dates are over — edit the end date first, then try the clips again." }); return;
  }
  const jobId = String((req.body as { jobId?: unknown })?.jobId ?? "").trim();
  if (!/^[a-f0-9]{16,64}$/i.test(jobId)) {
    res.status(400).json({ error: "Clip job reference is missing — try again." }); return;
  }
  // DELIBERATELY the same ownership rules as create (see the clipJobId checks
  // there): the job must exist AND belong to the caller (generic error either
  // way so job-id existence never leaks), and a job that already settled as
  // failed/cancelled can't be attached. Attaching one of your own older jobs
  // is allowed, exactly like create — the clips are yours either way.
  const jobRec = await readJobAnywhere(jobId).catch(() => null);
  if (!jobRec || jobRec.userId !== userId) {
    res.status(400).json({ error: "That clip job could not be found — try again." }); return;
  }
  if (jobRec.status === "error" || jobRec.status === "cancelled") {
    res.status(400).json({ error: "That clip job already failed — start a new one." }); return;
  }
  // Strict one-clip-one-time pairing survives retries: the fresh job must cut
  // exactly as many clips as this campaign schedules. Jobs started before the
  // rule carry no count and pass — ingest still posts one clip per time.
  const wantClips = Number(c.clip_params?.clipCount);
  const jobClips = Number(jobRec.clipCount);
  if (Number.isInteger(wantClips) && Number.isInteger(jobClips) && wantClips !== jobClips) {
    res.status(400).json({
      error: `This campaign posts ${wantClips} clip${wantClips === 1 ? "" : "s"} — start the new clip job with exactly ${wantClips} clip${wantClips === 1 ? "" : "s"} (it cuts ${jobClips}).`,
    });
    return;
  }
  // Conditional flip so two concurrent retries can't both win: only the one
  // that still sees 'failed' attaches its job. The loser's freshly started
  // job stays a harmless orphan (forCampaign jobs never auto-post, and same
  // settings usually collapse into the same cached job anyway). status /
  // enabled are left alone — pausing and exhaustion stay user-controlled.
  const upd = await db.query(
    `UPDATE social_campaigns
     SET clip_job_id = $3, clip_status = 'clipping', last_error = NULL, updated_at = NOW()
     WHERE id = $1 AND user_id = $2 AND clip_status = 'failed'`,
    [c.id, userId, jobId],
  );
  if ((upd.rowCount ?? 0) === 0) {
    res.status(409).json({ error: "A retry is already running for this campaign." }); return;
  }
  req.log.info({ campaignId: c.id, jobId }, "[autopilot] clip job retried");
  res.json({ ok: true });
});

// POST /social/campaigns/:id/retry-failed — reschedule every failed post in
// this campaign. A local 'failed' result is only written after the provider
// reports zero successful accounts, so clearing the old provider id cannot
// duplicate a post that reached TikTok. Stagger the rows to avoid sending a
// whole campaign to the provider in one burst.
router.post("/social/campaigns/:id/retry-failed", requireUser, async (req, res): Promise<void> => {
  const userId = req.currentUser!.id;
  const db = requireDb();
  const { rows: camp } = await db.query<CampaignRow>(
    `SELECT * FROM social_campaigns WHERE id = $1 AND user_id = $2`,
    [req.params.id, userId],
  );
  if (!camp[0]) { res.status(404).json({ error: "Campaign not found" }); return; }

  const result = await db.query(
    `WITH failed AS (
       SELECT id,
              ROW_NUMBER() OVER (ORDER BY scheduled_at ASC NULLS LAST, created_at ASC) - 1 AS position
       FROM social_posts
       WHERE user_id = $1 AND batch_id = $2 AND source = 'campaign'
         AND status = 'failed'
     )
     UPDATE social_posts AS p
     SET status='queued',
         pfm_post_id=NULL,
         scheduled_at=NOW() + make_interval(mins => (failed.position::int * 2)),
         attempts=0,
         hold_until=NULL,
         error=NULL,
         yt_native_publish=false,
         yt_uploaded_at=NULL,
         updated_at=NOW()
     FROM failed
     WHERE p.id = failed.id AND p.status = 'failed'
     RETURNING p.id`,
    [userId, camp[0].id],
  );
  const retried = result.rowCount ?? 0;
  req.log.info({ campaignId: camp[0].id, retried }, "[autopilot] failed posts rescheduled");
  res.json({ ok: true, retried });
});

// GET /social/campaigns/:id/posts — per-video live status for one campaign
router.get("/social/campaigns/:id/posts", requireUser, async (req, res): Promise<void> => {
  const userId = req.currentUser!.id;
  const db = requireDb();
  const { rows: camp } = await db.query<CampaignRow>(
    `SELECT * FROM social_campaigns WHERE id = $1 AND user_id = $2`,
    [req.params.id, userId],
  );
  if (!camp[0]) { res.status(404).json({ error: "Campaign not found" }); return; }
  // Opening the post list repairs future rows created by the old AI→filename
  // fallback. The update is conditional and never touches handed-off posts.
  if (camp[0].ai_captions) {
    await refreshPendingCampaignCaptions(camp[0], { onlyFilenameFallback: true });
  }
  const { rows } = await db.query<{
    id: string; file_name: string; scheduled_at: string | null;
    caption: string; status: string; error: string | null; platforms: string[]; pfm_post_id: string | null;
  }>(
    `SELECT id, file_name, caption, scheduled_at, status, error, platforms, pfm_post_id
     FROM social_posts
     WHERE user_id = $1 AND batch_id = $2 AND source = 'campaign'
     ORDER BY scheduled_at ASC NULLS LAST, created_at ASC
     LIMIT 500`,
    [userId, camp[0].id],
  );
  // Provider-truth refresh — this list is exactly what a user stares at when
  // "it says posted but nothing showed up". Heals stale/optimistic statuses.
  await refreshAggregateRows(rows);
  res.json({
    posts: rows.map((r) => ({
      id: r.id,
      fileName: r.file_name,
      caption: r.caption,
      postAt: r.scheduled_at,
      status: r.status,
      error: r.error,
      platforms: r.platforms,
    })),
  });
});

// DELETE /social/campaigns/:id — cancel future posts, then remove the template
router.delete("/social/campaigns/:id", requireUser, async (req, res): Promise<void> => {
  const userId = req.currentUser!.id;
  const db = requireDb();
  const { rows } = await db.query<CampaignRow>(
    `SELECT * FROM social_campaigns WHERE id = $1 AND user_id = $2`,
    [req.params.id, userId],
  );
  if (!rows[0]) { res.status(404).json({ error: "Campaign not found" }); return; }
  // Disable FIRST. This UPDATE waits out any in-flight materializer holding the
  // row lock, and once it commits no new posts can be created for this campaign
  // — only then is cancelling the queue race-free. (Deleting straight away
  // would let a concurrent materializer commit a post that nobody cancels.)
  await db.query(
    `UPDATE social_campaigns SET enabled = FALSE, updated_at = NOW() WHERE id = $1 AND user_id = $2`,
    [rows[0].id, userId],
  );
  const stopped = await stopFuturePosts(userId, rows[0].id);
  await db.query(`DELETE FROM social_campaigns WHERE id = $1 AND user_id = $2`, [rows[0].id, userId]);
  res.json({ ok: true, cancelled: stopped.cancelled });
});

export default router;
