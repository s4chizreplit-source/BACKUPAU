import { useState, useRef, useEffect, useCallback, memo, lazy, Suspense, type ReactNode } from 'react';
import {
  Link2, Scissors, Download, Play, X, ChevronDown,
  Loader2, AlertCircle, Sparkles, Zap, Check, Volume2, VolumeX,
  History, LogOut, User, Menu, CreditCard, Shield, Copy, Share2,
  Youtube, Globe, Radio, Box, Heart, MessageCircle,
  Trophy, Lock, Video, Cpu, Send, LayoutGrid, FileText, Target, PenLine
} from 'lucide-react';
import { Link, useLocation } from 'wouter';
import { useAuth, apiFetch } from '../lib/auth';

// In production the API lives on a separate server — point VITE_API_URL to it
// (e.g. https://api-server-xxx.replit.app/api). In dev, the Vite proxy handles /api.
import { requestClips, pollClipJob, cancelClipJob, ClipJobCancelledError, type ClipJobResult } from '../lib/clipJob';

// A running clip job survives refreshes server-side — this key remembers it
// so the page can reconnect instead of leaving the user on a dead screen.
const ACTIVE_JOB_KEY = 'autocliper_active_job';
import { Footer } from '../components/Footer';
// Pricing is loaded only when the pricing section is opened.
const PricingCards = lazy(() => import('../components/PricingCards'));
import { PlatformIcon, PLATFORM_META, ALL_PLATFORM_KEYS } from '../components/PlatformIcons';
import { Upload as UploadIcon, FileVideo, Gift, Film, Plus, ArrowRight, Smartphone, MonitorPlay, Building2, Rocket, CalendarDays, Captions, Clock } from 'lucide-react';
import { uploadVideoFile } from '../lib/clipJob';

export const API = import.meta.env.VITE_API_URL
  ? import.meta.env.VITE_API_URL.replace(/\/$/, '')
  : import.meta.env.BASE_URL.replace(/\/$/, '') + '/api';

// ─── Types ────────────────────────────────────────────────────────────────────
export interface CaptionRequirements {
  handles: string[];
  hashtags: string[];
  requiredCaptionText: string | null;
  ctaText: string | null;
  forbidLinks: boolean;
  ctaFirstLine: boolean;
  endCta: boolean;
  minClipSeconds: number | null;
  onScreenCaptions: boolean;
}

export interface Clip {
  id: string;
  name: string;
  label: string;
  startTime: string;
  endTime: string;
  duration: string;
  size: number;
  width?: number;
  height?: number;
  thumbnailDataUrl?: string; // base64 data URL — preferred
  thumbnailId?: string;       // legacy fallback
  caption?: string;           // ready-to-paste viral caption (older jobs lack it)
  aiReason?: string;          // why the AI picked this moment (prompt-guided jobs)
  /** Pasted brief rules retained for caption rewrites, edits, and posting. */
  campaignRequirements?: CaptionRequirements;
}

/** Lightweight UI preview only — the API remains the authority for parsing
 * and enforcing a brief. This gives creators immediate feedback before they
 * spend credits, without ever blocking a normal moment-selection prompt. */
function campaignPromptFeedback(prompt: string): string[] {
  const p = prompt.replace(/\s+/g, ' ').trim();
  if (!p) return [];
  const hasRules = /\b(tag|caption|hashtag|must|require|required|mandatory|cta|call[-\s]?to[-\s]?action|description|bio)\b/i.test(p)
    || /\b(mention|include|use)\b[^.!?\n]{0,80}(?:@[\w.]|#[\w]+)/i.test(p);
  if (!hasRules) return [];
  const handles = [...p.matchAll(/(^|[^A-Za-z0-9_.])@([A-Za-z0-9_](?:[A-Za-z0-9_.]{0,28}[A-Za-z0-9_])?)/g)]
    .map(m => `@${m[2]}`).filter((v, i, all) => all.findIndex(x => x.toLowerCase() === v.toLowerCase()) === i).slice(0, 4);
  const hashtags = [...p.matchAll(/(^|[^A-Za-z0-9_&])#([A-Za-z0-9_]{2,50})/g)]
    .map(m => `#${m[2]}`).filter((v, i, all) => all.findIndex(x => x.toLowerCase() === v.toLowerCase()) === i).slice(0, 5);
  const items = [...handles, ...hashtags];
  if (/\b(first line|start of (?:the )?(?:caption|description))\b/i.test(p)) items.push('CTA first line');
  if (/\b(end of (?:each|every|the) video|end[- ]card)\b/i.test(p)) items.push('end CTA');
  const min = /(?:minimum of|at least|no clips? shorter than)\s+(\d{1,3})\s*sec/i.exec(p);
  if (min) items.push(`${min[1]}s minimum`);
  if (/on[-\s]?screen captions?[^.!?]{0,55}\b(required|must|mandatory|every)\b/i.test(p)) items.push('on-screen captions');
  return items;
}

// ─── Social types ─────────────────────────────────────────────────────────────
export interface SocialAccount {
  id: string;
  type: string;      // "INSTAGRAM" | "TIKTOK" | "YOUTUBE" etc. (normalized uppercase)
  name: string;
  username?: string;
  enabled: boolean;  // per-account auto-post toggle (any connected account can be posted to)
}

/** Raw account row from GET /social/accounts (Post for Me connection mirror). */
export interface ApiSocialAccount {
  id: string;
  platform: string;               // lowercase from the API
  username?: string | null;
  displayName?: string | null;
  profileImage?: string | null;
  status: string;                 // 'connected' | 'disconnected'
  autopostEnabled: boolean;
}

/** Server rows → UI shape. All CONNECTED accounts are postable; `enabled`
 *  mirrors the per-account auto-post preference. */
export function toUiAccounts(rows: ApiSocialAccount[]): SocialAccount[] {
  return rows
    .filter(r => r.status === 'connected')
    .map(r => ({
      id: r.id,
      type: (r.platform || '').toUpperCase(),
      name: r.displayName || r.username || r.platform,
      username: r.username ?? undefined,
      enabled: r.autopostEnabled,
    }));
}

/** Live post status of one clip on one connected account — mirrored from the
 *  posting provider by the server (never guessed client-side). */
export interface ClipPostStatus {
  accountId?: string;
  platform: string;                                   // "tiktok", "instagram", …
  username?: string | null;
  status: 'processing' | 'posted' | 'scheduled' | 'error' | 'deleted';
  error?: string;
}

/** Batch-load the live post status for a set of clips (single request).
 *  Clips that were never posted are simply absent from the map. The server
 *  also self-heals while answering: posts deleted on the platform free their
 *  markers, so those clips can be posted again with a normal tap. */
export function useClipPostStatuses(clipIds: string[], enabled: boolean) {
  const [statuses, setStatuses] = useState<Record<string, ClipPostStatus[]>>({});
  const key = clipIds.join(',');
  const refresh = useCallback(() => {
    if (!enabled || !key) return;
    apiFetch<{ clips: Record<string, ClipPostStatus[]> }>('/social/clip-status', {
      method: 'POST',
      body: JSON.stringify({ clipIds: key.split(',') }),
    }).then(r => setStatuses(r.clips ?? {})).catch(() => { /* signed out / offline — no badges */ });
  }, [key, enabled]);
  useEffect(() => { refresh(); }, [refresh]);
  return { statuses, refresh };
}


// ─── Helpers ──────────────────────────────────────────────────────────────────
function fmtBytes(b: number) {
  if (b > 1e9) return (b / 1e9).toFixed(1) + ' GB';
  if (b > 1e6) return (b / 1e6).toFixed(1) + ' MB';
  return Math.round(b / 1e3) + ' KB';
}

/** Copy to clipboard with a fallback for older mobile browsers. */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Non-secure contexts / older iOS Safari: hidden readonly textarea with
    // an explicit selection range (iOS ignores plain select()).
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.top = '0';
      ta.style.left = '0';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      ta.setSelectionRange(0, text.length);
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

function thumbUrl(id: string) {
  return `${API}/video/file/${id}`;
}
function dlUrl(id: string) {
  // Keep the preview URL inline, but explicitly ask the server for an
  // attachment here. Some browsers ignore the `download` attribute when the
  // response says `Content-Disposition: inline`, especially for larger MP4s.
  return `${API}/video/file/${id}?download=1`;
}

// ─── Recent clips — saved locally in this browser, scoped to the account ──────
// Records are stamped with the account that made them; every UI read goes
// through loadRecentJobs(ownerId) so one browser shared by two accounts (or a
// signed-out visitor) never shows someone else's clips.
export interface RecentJob {
  id: string;
  url: string;
  platform: string;
  date: number;
  totalDuration: string;
  clips: Clip[];
  /** Server clip_jobs row id — links this device copy to account history. */
  historyId?: string;
  /** Account that made the clips — records are only visible to their owner. */
  ownerId?: string;
}

export const RECENT_KEY = 'autocliper_recent_jobs';
export const RECENT_MAX = 8;

// Stored data can come from older app versions or get corrupted — never trust
// its shape. Discard entries that would crash the drawer render or save paths.
function sanitizeRecentJob(j: unknown): RecentJob | null {
  if (!j || typeof j !== 'object') return null;
  const job = j as Record<string, unknown>;
  if (typeof job.id !== 'string' || typeof job.url !== 'string' || !Array.isArray(job.clips)) return null;
  const clips = (job.clips as unknown[])
    .filter((c): c is Record<string, unknown> => !!c && typeof c === 'object' && typeof (c as Record<string, unknown>).id === 'string')
    .map(c => ({ ...(c as unknown as Clip), size: typeof c.size === 'number' ? c.size : 0 }));
  if (clips.length === 0) return null;
  return {
    id: job.id,
    url: job.url,
    platform: typeof job.platform === 'string' ? job.platform : 'shorts',
    date: typeof job.date === 'number' ? job.date : 0,
    totalDuration: typeof job.totalDuration === 'string' ? job.totalDuration : '',
    clips,
    historyId: typeof job.historyId === 'string' ? job.historyId : undefined,
    ownerId: typeof job.ownerId === 'string' ? job.ownerId : undefined,
  };
}

// Raw device store — every account's records mixed together. Internal only.
function loadAllRecentJobs(): RecentJob[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed.map(sanitizeRecentJob).filter((x): x is RecentJob => x !== null);
  } catch {
    return [];
  }
}

/** Records for ONE account. No owner (signed out) → nothing: device history
 *  is private to the account that made the clips. Legacy records saved before
 *  owner-stamping have no ownerId and are hidden the same way. */
export function loadRecentJobs(ownerId?: string | null): RecentJob[] {
  if (!ownerId) return [];
  return loadAllRecentJobs().filter(j => j.ownerId === ownerId);
}

function persistRecentJobs(jobs: RecentJob[]): void {
  // Thumbnails are base64 data URLs — a few jobs can blow the ~5MB localStorage
  // quota. On quota errors, retry with thumbnails stripped from older jobs,
  // then with all thumbnails stripped, then with fewer jobs. History is
  // best-effort: if it still fails, give up silently.
  let list = jobs.slice(0, RECENT_MAX);
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      localStorage.setItem(RECENT_KEY, JSON.stringify(list));
      return;
    } catch {
      const stripThumbs = (j: RecentJob): RecentJob =>
        ({ ...j, clips: Array.isArray(j.clips) ? j.clips.map(c => ({ ...c, thumbnailDataUrl: undefined })) : [] });
      if (attempt === 0) {
        list = list.map((j, i) => i === 0 ? j : stripThumbs(j));
      } else if (attempt === 1) {
        list = list.map(stripThumbs);
      } else {
        list = list.slice(0, Math.max(1, Math.floor(list.length / 2)));
      }
    }
  }
}

export function saveRecentJob(job: RecentJob): RecentJob[] {
  persistRecentJobs([job, ...loadAllRecentJobs().filter(j => j.id !== job.id)]);
  return loadRecentJobs(job.ownerId);
}

export function deleteRecentJob(id: string, ownerId?: string | null): RecentJob[] {
  persistRecentJobs(loadAllRecentJobs().filter(j => j.id !== id));
  return loadRecentJobs(ownerId);
}

/** Clears ONE account's records — never wipes what other accounts saved on
 *  this device. Without an owner there is nothing to clear. */
export function clearRecentJobs(ownerId?: string | null): void {
  if (!ownerId) return;
  const rest = loadAllRecentJobs().filter(j => j.ownerId !== ownerId);
  try {
    if (rest.length === 0) localStorage.removeItem(RECENT_KEY);
    else persistRecentJobs(rest);
  } catch { /* best-effort */ }
}

// ─── Loading dots ─────────────────────────────────────────────────────────────
function Dots() {
  return (
    <span className="inline-flex gap-1 ml-1">
      {[0, 1, 2].map(i => (
        <span
          key={i}
          className="w-1.5 h-1.5 rounded-full bg-white/60 animate-bounce"
          style={{ animationDelay: `${i * 0.15}s` }}
        />
      ))}
    </span>
  );
}

// ─── Back-button support for overlays ─────────────────────────────────────────
// Mobile users press the phone's Back button expecting the overlay to close —
// not to leave the site. Push a history entry when the overlay mounts; popstate
// closes it. If it's closed another way (X / backdrop / Escape), consume the
// entry we pushed so a later Back doesn't need a double-press.
export function useCloseOnBack(onClose: () => void) {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const poppedRef = useRef(false);
  useEffect(() => {
    poppedRef.current = false;
    window.history.pushState({ overlay: true }, '');
    const onPop = () => { poppedRef.current = true; onCloseRef.current(); };
    window.addEventListener('popstate', onPop);
    return () => {
      window.removeEventListener('popstate', onPop);
      if (!poppedRef.current) window.history.back();
    };
  }, []);
}

// ─── Video Player Modal ───────────────────────────────────────────────────────
export const VideoModal = memo(function VideoModal({ clip, onClose }: { clip: Clip; onClose: () => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [loadError, setLoadError] = useState(false);
  // Driven by real media events so a blocked autoplay still shows the play button.
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(false);
  const [progress, setProgress] = useState(0); // 0..1

  useCloseOnBack(onClose);

  function togglePlay() {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused || v.ended) void v.play()?.catch?.(() => { /* autoplay/gesture rejection — overlay stays */ });
    else v.pause();
  }

  function seekTo(e: React.MouseEvent<HTMLDivElement>) {
    const v = videoRef.current;
    if (!v || !Number.isFinite(v.duration) || v.duration <= 0) return;
    const r = e.currentTarget.getBoundingClientRect();
    if (!r.width) return;
    const frac = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    v.currentTime = frac * v.duration;
    setProgress(frac);
  }

  // Close on Escape key
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  // Prevent body scroll while modal open
  useEffect(() => {
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = ''; };
  }, []);

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center p-4"
      onClick={onClose}
    >
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/90 backdrop-blur-md" />

      {/* Modal — width follows the 9:16 video so header/buttons stay aligned */}
      <div
        className="relative z-10 w-full max-w-sm mx-auto flex flex-col"
        style={{ width: 'min(24rem, calc(100vw - 2rem), calc((100dvh - 170px) * 9 / 16))' }}
        onClick={e => e.stopPropagation()}
      >
        {/* Top bar */}
        <div className="flex items-center justify-between mb-3 px-1">
          <div>
            <p className="text-white font-bold text-sm">{clip.label}</p>
            <p className="text-white/40 text-xs mt-0.5">{clip.startTime} – {clip.endTime} · {clip.duration}</p>
          </div>
          <button
            onClick={onClose}
            className="w-9 h-9 rounded-full bg-white/10 hover:bg-white/20 flex items-center justify-center transition-colors"
          >
            <X className="w-5 h-5 text-white" />
          </button>
        </div>

        {/* Video — fixed 9:16 box so the player always matches the modal width */}
        <div className="relative w-full aspect-[9/16] rounded-2xl overflow-hidden bg-black shadow-2xl shadow-black/50">
          {/* Clean player — no native browser controls (3-dot menu, timer, etc.) */}
          <video
            ref={videoRef}
            src={`${API}/video/file/${clip.id}`}
            autoPlay
            playsInline
            muted={muted}
            onPlay={() => setPlaying(true)}
            onPause={() => setPlaying(false)}
            onEnded={() => setPlaying(false)}
            onTimeUpdate={e => {
              const v = e.currentTarget;
              if (v.duration > 0) setProgress(v.currentTime / v.duration);
            }}
            onError={() => setLoadError(true)}
            className="w-full h-full block object-contain bg-black"
          />
          {/* Full-surface tap/keyboard toggle — always present so pause stays reachable */}
          {!loadError && (
            <button
              onClick={togglePlay}
              aria-label={playing ? 'Pause' : 'Play'}
              className={`absolute inset-0 flex items-center justify-center ${playing ? '' : 'bg-black/25'}`}
            >
              {!playing && (
                <span className="w-16 h-16 rounded-full bg-white/15 backdrop-blur-sm border border-white/20 flex items-center justify-center">
                  <Play className="w-7 h-7 text-white fill-white ml-1" />
                </span>
              )}
            </button>
          )}
          {!loadError && (
            <button
              onClick={() => setMuted(m => !m)}
              aria-label={muted ? 'Unmute' : 'Mute'}
              className="absolute top-3 right-3 z-10 w-9 h-9 rounded-full bg-black/50 backdrop-blur-sm flex items-center justify-center hover:bg-black/70 transition-colors"
            >
              {muted ? <VolumeX className="w-4 h-4 text-white" /> : <Volume2 className="w-4 h-4 text-white" />}
            </button>
          )}
          {!loadError && (
            <div
              data-testid="seek-bar"
              className="absolute bottom-0 inset-x-0 h-6 z-10 flex items-end cursor-pointer"
              onClick={seekTo}
            >
              <div className="w-full h-1 bg-white/20">
                <div className="h-full bg-[#D1FE17]" style={{ width: `${Math.min(100, progress * 100)}%` }} />
              </div>
            </div>
          )}
          {loadError && (
            <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/85 p-6 text-center">
              <div className="text-3xl mb-3">⏳</div>
              <p className="text-white font-bold text-sm mb-1">This clip has expired</p>
              <p className="text-white/50 text-xs leading-relaxed">Old clips are cleaned up after a while. Paste the video link again to regenerate it.</p>
            </div>
          )}
        </div>

        {/* Bottom actions */}
        <div className="flex gap-3 mt-4 px-1">
          <a
            href={dlUrl(clip.id)}
            download={clip.name}
            className="flex-1 flex items-center justify-center gap-2 bg-[#D1FE17] text-black text-sm font-black py-3 rounded-xl hover:bg-[#c5f010] active:scale-95 transition-all"
          >
            <Download className="w-4 h-4" />
            Download Clip
          </a>
        </div>
      </div>
    </div>
  );
});

// When a post should go live — 0 posts right away, anything else is handed to
// the posting provider as a scheduled post (YouTube shows it as "scheduled"
// and it publishes on its own at that time).
const POST_DELAY_CHOICES: { label: string; v: number | 'custom' }[] = [
  { label: 'Now', v: 0 },
  { label: '10 min', v: 10 },
  { label: '15 min', v: 15 },
  { label: '30 min', v: 30 },
  { label: '1 hour', v: 60 },
  { label: 'Custom', v: 'custom' },
];

// ─── Clip Card ────────────────────────────────────────────────────────────────
export const ClipCard = memo(function ClipCard({ clip, index, onPlay, socialAccounts = [], socialAccountsReady = true, postStatus }: {
  clip: Clip; index: number; onPlay: () => void; socialAccounts?: SocialAccount[]; socialAccountsReady?: boolean;
  /** Live per-account post status (provider mirror) — seeds the button. */
  postStatus?: ClipPostStatus[];
}) {
  const [imgError, setImgError] = useState(false);
  const [dlState, setDlState] = useState<'idle' | 'downloading' | 'done'>('idle');
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const [postState, setPostState] = useState<'idle' | 'pushing' | 'processing' | 'posted' | 'scheduled' | 'done' | 'already' | 'error'>('idle');
  const [postErr, setPostErr] = useState('');
  const lastPostIdsRef = useRef<string[] | undefined>(undefined);
  const [showPicker, setShowPicker] = useState(false);
  // Editable post text — prefilled from the clip's viral caption each time
  // the picker opens, so what you see is exactly what gets posted.
  const [postCaption, setPostCaption] = useState('');
  const [postTitle, setPostTitle] = useState('');
  const [aiRewriting, setAiRewriting] = useState(false);
  const [aiErr, setAiErr] = useState<string | null>(null);
  useEffect(() => {
    if (!showPicker) return;
    setPostCaption(clip.caption ?? '');
    setPostTitle(firstCaptionLine(clip.caption) ?? clip.label ?? '');
    setPostDelay(0);
    setCustomMin('');
    setDelayErr(null);
  }, [showPicker, clip.caption, clip.label]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  // Delay before the post goes live (minutes); 'custom' shows a free input.
  const [postDelay, setPostDelay] = useState<number | 'custom'>(0);
  const [customMin, setCustomMin] = useState('');
  const [delayErr, setDelayErr] = useState<string | null>(null);
  const [scheduledFor, setScheduledFor] = useState<string | null>(null);
  const pickerRef = useRef<HTMLDivElement>(null);

  // Close picker on outside click
  useEffect(() => {
    if (!showPicker) return;
    const handler = (e: MouseEvent) => {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) setShowPicker(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showPicker]);

  // ── Live post status (posting-provider mirror) ──────────────────────────────
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const stopPolling = () => { if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; } };
  useEffect(() => stopPolling, []);

  /** Poll this clip's live status until the provider settles. Fast (5s,
   *  ≈3 min cap) while publishing; slow (60s, uncapped) while a delayed post
   *  waits for its time — so the card flips to Publishing/Posted on its own. */
  function startPolling(intervalMs = 5000) {
    if (pollRef.current) return;
    const fast = intervalMs <= 10_000;
    let ticks = 0;
    pollRef.current = setInterval(async () => {
      // Fast polling gives up after ~3 min (next visit re-checks). Only an
      // actively-publishing card may settle as posted — scheduled stays put.
      if (fast && ++ticks > 36) { stopPolling(); setPostState(s => (s === 'processing' ? 'posted' : s)); return; }
      try {
        const r = await apiFetch<{ clips: Record<string, ClipPostStatus[]> }>('/social/clip-status', {
          method: 'POST', body: JSON.stringify({ clipIds: [clip.id] }),
        });
        const list = r.clips?.[clip.id] ?? [];
        const failed = list.find(s => s.status === 'error');
        const processing = list.some(s => s.status === 'processing');
        const posted = list.some(s => s.status === 'posted');
        const scheduled = list.some(s => s.status === 'scheduled');
        if (failed) {
          stopPolling();
          setPostErr((failed.error || 'Posting failed on the platform').slice(0, 90));
          setPostState('error');
          setTimeout(() => setPostState(posted ? 'posted' : 'idle'), 6000);
        } else if (processing) {
          // Publishing now — make sure we're watching closely.
          if (!fast) { stopPolling(); setPostState('processing'); startPolling(); }
        } else if (scheduled) {
          // Still waiting for its time — drop to the slow watch.
          setPostState('scheduled');
          if (fast) { stopPolling(); startPolling(60_000); }
        } else {
          stopPolling();
          setPostState(posted ? 'posted' : 'idle');
        }
      } catch { /* transient — keep polling */ }
    }, intervalMs);
  }

  // Server truth seeds the button whenever it's not mid-action: still
  // publishing → "Publishing…" (+ keep checking); live → persistent
  // "Posted ✓"; deleted on the platform → back to a plain Post button.
  useEffect(() => {
    if (!postStatus) return;
    if (postState === 'pushing' || postState === 'already' || postState === 'error' || postState === 'done') return;
    const processing = postStatus.some(s => s.status === 'processing');
    const posted = postStatus.some(s => s.status === 'posted');
    const scheduled = postStatus.some(s => s.status === 'scheduled');
    if (processing) { setPostState('processing'); startPolling(); }
    else if (posted) { setPostState('posted'); }
    else if (scheduled) { setPostState('scheduled'); startPolling(60_000); }
    else if (postState === 'processing' || postState === 'posted' || postState === 'scheduled') { stopPolling(); setPostState('idle'); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [postStatus]);

  function handleDownload(e: React.MouseEvent<HTMLAnchorElement>) {
    e.stopPropagation();
    if (dlState !== 'idle') return;
    setDlState('downloading');
    setTimeout(() => {
      setDlState('done');
      setTimeout(() => setDlState('idle'), 2000);
    }, 1400);
  }

  // First usable caption line → default YouTube title (mirrors the server's
  // fallback so the prefill matches what would post anyway).
  function firstCaptionLine(caption?: string): string | undefined {
    for (const raw of (caption ?? '').split(/\r?\n/)) {
      const line = raw.trim();
      if (!line) continue;
      if (!line.replace(/[#@][\p{L}\p{N}_]+/gu, '').replace(/[\s\p{P}\p{S}]+/gu, '')) continue;
      return line.slice(0, 95);
    }
    return undefined;
  }

  // Rewrite the caption with AI (viral style) — editable before posting.
  async function aiRewrite() {
    if (aiRewriting) return;
    setAiRewriting(true);
    setAiErr(null);
    try {
      const r = await apiFetch<{ caption: string }>('/social/caption-ai', {
        method: 'POST',
        body: JSON.stringify({
          hint: [clip.aiReason, postCaption.trim(), clip.label].filter(Boolean).join('. '),
          ...(clip.campaignRequirements ? { captionRequirements: clip.campaignRequirements } : {}),
        }),
      });
      setPostCaption(r.caption);
    } catch (err) {
      setAiErr((err as Error).message || 'AI caption failed — try again.');
    }
    setAiRewriting(false);
  }

  async function handleCopyCaption(e: React.MouseEvent) {
    e.stopPropagation();
    if (!clip.caption || copyState !== 'idle') return;
    const ok = await copyText(clip.caption);
    setCopyState(ok ? 'copied' : 'failed');
    setTimeout(() => setCopyState('idle'), 1800);
  }

  async function doPost(accountIds?: string[], force = false) {
    // A delay was picked → hand it over as a scheduled post instead of an
    // immediate one. Reposts (force) always go out right away.
    const delayMin = postDelay === 'custom' ? Number(customMin) : postDelay;
    const wantsDelay = postDelay === 'custom' || (typeof postDelay === 'number' && postDelay > 0);
    if (!force && wantsDelay && accountIds && accountIds.length > 0) {
      if (!Number.isFinite(delayMin) || delayMin < 5 || delayMin > 10080) {
        setDelayErr('Enter minutes between 5 and 10080 (7 days).');
        return; // picker stays open so the value can be fixed
      }
      const at = new Date(Date.now() + delayMin * 60_000);
      setShowPicker(false);
      setPostState('pushing');
      setPostErr('');
      try {
        await apiFetch<{ ok: boolean; scheduled: string[]; scheduledAt: string }>('/social/posts/schedule', {
          method: 'POST',
          body: JSON.stringify({
            clipId: clip.id,
            caption: postCaption.trim() || clip.caption,
            ...(clip.campaignRequirements ? { captionRequirements: clip.campaignRequirements } : {}),
            label: clip.label,
            ...(postTitle.trim() ? { youtubeTitle: postTitle.trim() } : {}),
            accountIds,
            scheduledAt: at.toISOString(),
          }),
        });
        setScheduledFor(at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }));
        setPostState('scheduled');
        startPolling(60_000); // slow watch — flips to Publishing/Posted when the time comes
      } catch (e) {
        setPostErr((e instanceof Error && e.message ? e.message : 'Scheduling failed').slice(0, 90));
        setPostState('error');
        setTimeout(() => setPostState('idle'), 6000);
      }
      return;
    }
    setShowPicker(false);
    setPostState('pushing');
    setPostErr('');
    lastPostIdsRef.current = accountIds;
    try {
      const r = await apiFetch<{ ok: boolean; posted: string[]; alreadyPosted?: string[] }>('/social/posts', {
        method: 'POST',
        body: JSON.stringify({
          clipId: clip.id,
          caption: postCaption.trim() || clip.caption,
          ...(clip.campaignRequirements ? { captionRequirements: clip.campaignRequirements } : {}),
          label: clip.label,
          ...(postTitle.trim() ? { youtubeTitle: postTitle.trim() } : {}),
          accountIds,
          ...(force ? { force: true } : {}),
        }),
      });
      // Server skips platforms this clip was already posted to (no duplicates).
      // Offer a deliberate second-tap repost instead of pretending it posted.
      const already = (r.alreadyPosted?.length ?? 0) > 0 && (r.posted?.length ?? 0) === 0;
      if (already) {
        setPostState('already');
        // Repost window over → settle on the persistent "Posted ✓" badge.
        setTimeout(() => setPostState(s => (s === 'already' ? 'posted' : s)), 6000);
      } else {
        // Accepted by the posting provider — now mirror the REAL state:
        // "Publishing…" until the platform confirms the post is live.
        setPostState('processing');
        startPolling();
      }
    } catch (e) {
      // Show the REAL server error — "not connected" was a lie for 500s.
      setPostErr((e instanceof Error && e.message ? e.message : 'Posting failed').slice(0, 90));
      setPostState('error');
      setTimeout(() => setPostState('idle'), 6000);
    }
  }

  function handlePostToSocial(e: React.MouseEvent) {
    e.stopPropagation();
    // Second tap while "Posted before" is showing = deliberate repost of the
    // same selection (clears the posted-markers server-side, then posts).
    if (postState === 'already') {
      void doPost(lastPostIdsRef.current, true);
      return;
    }
    if (postState !== 'idle' && postState !== 'posted' && postState !== 'scheduled') return;
    // Account discovery still pending/failed — never blind-post to everything.
    if (!socialAccountsReady) return;
    if (socialAccounts.length > 0 && !showPicker) {
      setSelectedIds(socialAccounts.map(a => a.id));
      setShowPicker(true);
    } else {
      void doPost(undefined);
    }
  }

  // Live preview of the picked delay (drives the button label + the hint).
  const delayMinPreview = postDelay === 'custom' ? (Number(customMin) || 0) : postDelay;

  return (
    <div className="group relative bg-[#1a1a1a] rounded-2xl overflow-hidden border border-white/5 hover:border-white/20 transition-all duration-200">
      {/* Thumbnail — tap to play */}
      <button
        type="button"
        onClick={onPlay}
        className="relative w-full aspect-[9/16] bg-[#111] overflow-hidden block focus:outline-none"
      >
        {(clip.thumbnailDataUrl || clip.thumbnailId) && !imgError ? (
          <img
            src={clip.thumbnailDataUrl || thumbUrl(clip.thumbnailId!)}
            alt={clip.label}
            className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500"
            onError={() => setImgError(true)}
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center bg-gradient-to-br from-[#1e1e1e] to-[#0d0d0d]">
            <Play className="w-8 h-8 text-white/20" />
          </div>
        )}

        {/* Gradient overlay */}
        <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/10 to-transparent" />

        {/* Duration badge */}
        <div className="absolute top-2 left-2 bg-black/70 backdrop-blur-sm text-white text-[11px] font-bold px-2 py-0.5 rounded-md">
          {clip.duration}
        </div>

        {/* Clip number */}
        <div className="absolute top-2 right-2 w-6 h-6 rounded-full bg-[#D1FE17] text-black text-[11px] font-black flex items-center justify-center">
          {index + 1}
        </div>

        {/* Play button — always visible so users know clips are tappable */}
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="w-12 h-12 rounded-full bg-black/45 backdrop-blur-sm border border-white/25 flex items-center justify-center shadow-lg transition-all duration-200 group-hover:scale-110 group-hover:bg-[#D1FE17]">
            <Play className="w-5 h-5 text-white ml-0.5 group-hover:text-black transition-colors" fill="currentColor" />
          </div>
        </div>

        {/* Bottom info */}
        <div className="absolute bottom-2 left-2 right-2">
          <p className="text-white/70 text-[11px] font-medium">{clip.startTime} – {clip.endTime}</p>
        </div>
      </button>

      {/* Card Footer */}
      <div className="p-3 flex items-center justify-between gap-2">
        <div className="min-w-0">
          {clip.aiReason && (
            <p className="text-[#D1FE17]/80 text-[10px] font-semibold truncate flex items-center gap-1" title={clip.aiReason}>
              <Sparkles className="w-3 h-3 shrink-0" />{clip.aiReason}
            </p>
          )}
          <p className="text-white text-sm font-semibold truncate">{clip.label}</p>
          <p className="text-white/40 text-xs">{fmtBytes(clip.size)}</p>
        </div>

        <a
          href={dlUrl(clip.id)}
          download={clip.name}
          onClick={handleDownload}
          className={[
            "shrink-0 flex items-center gap-1.5 text-xs font-black px-3 py-2 rounded-xl transition-all duration-300 select-none overflow-hidden",
            dlState === 'done'
              ? "bg-white/10 text-[#D1FE17] scale-95"
              : "bg-[#D1FE17] text-black hover:bg-[#c5f010] active:scale-95",
          ].join(' ')}
          style={{ minWidth: 90, justifyContent: 'center' }}
        >
          {dlState === 'idle' && (
            <>
              <Download className="w-3.5 h-3.5" />
              Download
            </>
          )}
          {dlState === 'downloading' && (
            <>
              {/* Animated bouncing arrow */}
              <span className="inline-block animate-bounce">
                <Download className="w-3.5 h-3.5" />
              </span>
              <span className="animate-pulse">Saving…</span>
            </>
          )}
          {dlState === 'done' && (
            <>
              <svg className="w-3.5 h-3.5" viewBox="0 0 16 16" fill="none">
                <path d="M3 8.5l3.5 3.5 6.5-7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
              Saved!
            </>
          )}
        </a>
      </div>

      {/* Post to Social button + platform picker */}
      <div className="px-3 pb-2 -mt-1 relative">
        <button
          type="button"
          onClick={handlePostToSocial}
          disabled={postState === 'pushing' || postState === 'processing'}
          className={[
            'w-full flex items-center justify-center gap-1.5 text-[11px] font-black px-3 py-2 rounded-xl transition-all duration-200 select-none',
            postState === 'done'
              ? 'bg-white/10 text-[#D1FE17] scale-95'
              : postState === 'posted' || postState === 'scheduled'
                ? 'bg-[#D1FE17]/10 text-[#D1FE17] hover:bg-[#D1FE17]/20 active:scale-95'
                : postState === 'already'
                  ? 'bg-[#D1FE17]/15 text-[#D1FE17] hover:bg-[#D1FE17]/25 active:scale-95'
                  : postState === 'error'
                    ? 'bg-white/10 text-red-300'
                    : postState === 'pushing' || postState === 'processing'
                      ? 'bg-white/5 text-white/40 cursor-not-allowed'
                      : socialAccountsReady
                        ? 'bg-white/5 text-white/80 hover:bg-white/10 active:scale-95'
                        : 'bg-white/5 text-white/40 cursor-wait',
          ].join(' ')}
        >
          {postState === 'pushing' && <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Posting…</>}
          {postState === 'processing' && <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Publishing…</>}
          {postState === 'done'    && <><Check   className="w-3.5 h-3.5" /> Posted!</>}
          {postState === 'posted'  && <><Check   className="w-3.5 h-3.5" /> Posted ✓</>}
          {postState === 'scheduled' && <><Clock className="w-3.5 h-3.5" /> Scheduled{scheduledFor ? ` · ${scheduledFor}` : ''} ✓</>}
          {postState === 'already' && <><Share2  className="w-3.5 h-3.5" /> Posted before — tap to repost</>}
          {postState === 'error'   && <><X       className="w-3.5 h-3.5" /> {postErr || 'Posting failed — try again'}</>}
          {postState === 'idle'    && <><Share2  className="w-3.5 h-3.5" /> Post to social{socialAccounts.length > 0 && ` (${socialAccounts.length})`}</>}
        </button>

        {/* Platform picker dropdown */}
        {showPicker && socialAccounts.length > 0 && (
          <div
            ref={pickerRef}
            className="absolute bottom-full left-0 right-0 mb-1.5 bg-[#222] border border-white/10 rounded-2xl shadow-2xl shadow-black/70 z-50 p-3"
          >
            <p className="text-[10px] font-black text-white/40 uppercase tracking-widest mb-2">Choose platforms</p>
            <div className="space-y-1.5 mb-3">
              {socialAccounts.map((acc) => {
                const checked = selectedIds.includes(acc.id);
                const handle = acc.username
                  ? (acc.username.startsWith('@') ? acc.username : `@${acc.username}`)
                  : acc.name;
                return (
                  <label key={acc.id} className="flex items-center gap-2.5 cursor-pointer select-none">
                    <div
                      onClick={() => setSelectedIds(prev =>
                        checked ? prev.filter(id => id !== acc.id) : [...prev, acc.id]
                      )}
                      className={`w-4 h-4 shrink-0 rounded border flex items-center justify-center transition-colors ${checked ? 'bg-[#D1FE17] border-[#D1FE17]' : 'border-white/20 bg-white/5'}`}
                    >
                      {checked && <Check className="w-2.5 h-2.5 text-black" />}
                    </div>
                    <PlatformIcon type={acc.type} size={18} />
                    <span className="text-xs font-semibold text-white/70">{handle}</span>
                  </label>
                );
              })}
            </div>

            {/* What actually gets posted — editable before sending */}
            <div className="mb-3 space-y-2">
              <div>
                <div className="flex items-center justify-between mb-1">
                  <p className="text-[10px] font-black text-white/40 uppercase tracking-widest">Caption</p>
                  <button
                    type="button"
                    onClick={() => void aiRewrite()}
                    disabled={aiRewriting}
                    title="Rewrite this caption with AI in a viral style"
                    className="text-[10px] font-black text-[#D1FE17]/80 hover:text-[#D1FE17] disabled:opacity-50 transition-colors"
                  >
                    {aiRewriting ? 'Writing…' : '✨ AI rewrite'}
                  </button>
                </div>
                <textarea
                  value={postCaption}
                  onChange={(e) => setPostCaption(e.target.value)}
                  rows={3}
                  maxLength={2000}
                  placeholder="Caption for this post…"
                  className="w-full bg-[#161616] border border-white/10 rounded-xl px-2.5 py-2 text-[11px] text-white/80 leading-snug resize-y focus:outline-none focus:border-[#D1FE17]/50"
                />
                {clip.campaignRequirements && (
                  <p className="text-[#D1FE17]/80 text-[10px] leading-relaxed mt-1.5">
                    Campaign requirements stay protected when you rewrite, schedule, or post this caption.
                  </p>
                )}
                {aiErr && <p className="text-red-300 text-[10px] mt-1">{aiErr}</p>}
              </div>
              <div>
                <p className="text-[10px] font-black text-white/40 uppercase tracking-widest mb-1">YouTube title</p>
                <input
                  value={postTitle}
                  onChange={(e) => setPostTitle(e.target.value)}
                  maxLength={95}
                  placeholder="Title shown on YouTube"
                  className="w-full bg-[#161616] border border-white/10 rounded-xl px-2.5 py-2 text-[11px] text-white/80 focus:outline-none focus:border-[#D1FE17]/50"
                />
              </div>
            </div>

            {/* When should this go live? */}
            <div className="mb-3">
              <p className="text-[10px] font-black text-white/40 uppercase tracking-widest mb-1.5">When to post</p>
              <div className="flex flex-wrap gap-1.5">
                {POST_DELAY_CHOICES.map((c) => (
                  <button
                    key={c.label}
                    type="button"
                    onClick={() => { setPostDelay(c.v); setDelayErr(null); }}
                    className={`px-2.5 py-1.5 rounded-lg text-[10px] font-black transition-colors ${postDelay === c.v ? 'bg-[#D1FE17] text-black' : 'bg-white/5 text-white/60 hover:bg-white/10'}`}
                  >
                    {c.label}
                  </button>
                ))}
              </div>
              {postDelay === 'custom' && (
                <div className="mt-2 flex items-center gap-2">
                  <input
                    type="number"
                    min={5}
                    max={10080}
                    value={customMin}
                    onChange={(e) => { setCustomMin(e.target.value); setDelayErr(null); }}
                    placeholder="45"
                    className="w-20 bg-[#161616] border border-white/10 rounded-xl px-2.5 py-2 text-[11px] text-white/80 focus:outline-none focus:border-[#D1FE17]/50"
                  />
                  <span className="text-[10px] text-white/40">minutes from now (5 min – 7 days)</span>
                </div>
              )}
              {delayMinPreview >= 5 && delayMinPreview <= 10080 && (
                <p className="text-[10px] text-white/40 mt-1.5">
                  Goes live around {new Date(Date.now() + delayMinPreview * 60_000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} — shows as scheduled on the platform until then.
                </p>
              )}
              {delayErr && <p className="text-red-300 text-[10px] mt-1">{delayErr}</p>}
            </div>

            <div className="flex gap-2">
              <button
                onClick={() => void doPost(selectedIds)}
                disabled={selectedIds.length === 0}
                className="flex-1 text-xs font-black py-2 rounded-xl bg-[#D1FE17] text-black hover:bg-[#c5f010] active:scale-95 transition-all disabled:opacity-40"
              >
                {delayMinPreview > 0 ? `Schedule (${selectedIds.length})` : `Post (${selectedIds.length})`}
              </button>
              <button
                onClick={() => setShowPicker(false)}
                className="px-3 py-2 rounded-xl bg-white/5 text-white/50 text-xs hover:bg-white/10 transition-colors"
              >✕</button>
            </div>
          </div>
        )}
      </div>

      {/* Viral caption + one-tap copy (new jobs only — old clips have none) */}
      {clip.caption && (
        <div className="px-3 pb-3 -mt-1">
          <p
            className="text-white/50 text-[11px] leading-snug whitespace-pre-line"
            style={{ display: '-webkit-box', WebkitLineClamp: 4, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}
          >
            {clip.caption}
          </p>
          <button
            type="button"
            onClick={handleCopyCaption}
            className={[
              'mt-2 w-full flex items-center justify-center gap-1.5 text-[11px] font-black px-3 py-2 rounded-xl transition-all duration-200 select-none',
              copyState === 'copied'
                ? 'bg-white/10 text-[#D1FE17] scale-95'
                : copyState === 'failed'
                  ? 'bg-white/10 text-red-300'
                  : 'bg-white/5 text-white/80 hover:bg-white/10 active:scale-95',
            ].join(' ')}
          >
            {copyState === 'copied' && (
              <>
                <Check className="w-3.5 h-3.5" />
                Copied!
              </>
            )}
            {copyState === 'failed' && (
              <>
                <X className="w-3.5 h-3.5" />
                Couldn&apos;t copy — select the text above
              </>
            )}
            {copyState === 'idle' && (
              <>
                <Copy className="w-3.5 h-3.5" />
                Copy caption
              </>
            )}
          </button>
        </div>
      )}
    </div>
  );
});

// ─── Platform config ──────────────────────────────────────────────────────────
// Official TikTok note glyph — rendered 3× (cyan + pink offsets under white)
// to recreate the brand's signature chromatic look.
const TIKTOK_PATH = 'M12.525.02c1.31-.02 2.61-.01 3.91-.02.08 1.53.63 3.09 1.75 4.17 1.12 1.11 2.7 1.62 4.24 1.79v4.03c-1.44-.05-2.89-.35-4.2-.97-.57-.26-1.1-.59-1.62-.93-.01 2.92.01 5.84-.02 8.75-.08 1.4-.54 2.79-1.35 3.94-1.31 1.92-3.58 3.17-5.91 3.21-1.43.08-2.86-.31-4.08-1.03-2.02-1.19-3.44-3.37-3.65-5.71-.02-.5-.03-1-.01-1.49.18-1.9 1.12-3.72 2.58-4.96 1.66-1.44 3.98-2.13 6.15-1.72.02 1.48-.04 2.96-.04 4.44-.99-.32-2.15-.23-3.02.37-.63.41-1.11 1.04-1.36 1.75-.21.51-.15 1.07-.14 1.61.24 1.64 1.82 3.02 3.5 2.87 1.12-.01 2.19-.66 2.77-1.61.19-.33.4-.67.41-1.06.1-1.79.06-3.57.07-5.36.01-4.03-.01-8.05.02-12.07z';

const PLATFORMS = [
  {
    id: 'tiktok', label: 'TikTok', sub: '9:16 · 60s', maxDur: 60,
    icon: (
      <svg viewBox="0 0 24 24" className="w-5 h-5 overflow-visible">
        <path d={TIKTOK_PATH} fill="#25F4EE" transform="translate(-0.6 -0.4)" />
        <path d={TIKTOK_PATH} fill="#FE2C55" transform="translate(0.6 0.4)" />
        <path d={TIKTOK_PATH} fill="#fff" />
      </svg>
    ),
  },
  {
    id: 'reels', label: 'Reels', sub: '9:16 · 90s', maxDur: 90,
    icon: (
      <svg viewBox="0 0 24 24" className="w-5 h-5">
        <defs>
          <linearGradient id="igReelsGrad" x1="0%" y1="100%" x2="100%" y2="0%">
            <stop offset="0%" stopColor="#FFD600" />
            <stop offset="30%" stopColor="#FF7A00" />
            <stop offset="60%" stopColor="#FF0069" />
            <stop offset="100%" stopColor="#D300C5" />
          </linearGradient>
        </defs>
        <path fill="url(#igReelsGrad)" d="M12 0C8.74 0 8.333.015 7.053.072 5.775.132 4.905.333 4.14.63c-.789.306-1.459.717-2.126 1.384S.935 3.35.63 4.14C.333 4.905.131 5.775.072 7.053.012 8.333 0 8.74 0 12s.015 3.667.072 4.947c.06 1.277.261 2.148.558 2.913.306.788.717 1.459 1.384 2.126.667.666 1.336 1.079 2.126 1.384.766.296 1.636.499 2.913.558C8.333 23.988 8.74 24 12 24s3.667-.015 4.947-.072c1.277-.06 2.148-.262 2.913-.558.788-.306 1.459-.718 2.126-1.384.666-.667 1.079-1.335 1.384-2.126.296-.765.499-1.636.558-2.913.06-1.28.072-1.687.072-4.947s-.015-3.667-.072-4.947c-.06-1.277-.262-2.149-.558-2.913-.306-.789-.718-1.459-1.384-2.126C21.319 1.347 20.651.935 19.86.63c-.765-.297-1.636-.499-2.913-.558C15.667.012 15.26 0 12 0zm0 2.16c3.203 0 3.585.016 4.85.071 1.17.055 1.805.249 2.227.415.562.217.96.477 1.382.896.419.42.679.819.896 1.381.164.422.36 1.057.413 2.227.057 1.266.07 1.646.07 4.85s-.015 3.585-.074 4.85c-.061 1.17-.256 1.805-.421 2.227-.224.562-.479.96-.899 1.382-.419.419-.824.679-1.38.896-.42.164-1.065.36-2.235.413-1.274.057-1.649.07-4.859.07-3.211 0-3.586-.015-4.859-.074-1.171-.061-1.816-.256-2.236-.421-.569-.224-.96-.479-1.379-.899-.421-.419-.69-.824-.9-1.38-.165-.42-.359-1.065-.42-2.235-.045-1.26-.061-1.649-.061-4.844 0-3.196.016-3.586.061-4.861.061-1.17.255-1.814.42-2.234.21-.57.479-.96.9-1.381.419-.419.81-.689 1.379-.898.42-.166 1.051-.361 2.221-.421 1.275-.045 1.65-.06 4.859-.06zm0 3.678c-3.405 0-6.162 2.76-6.162 6.162 0 3.405 2.76 6.162 6.162 6.162 3.405 0 6.162-2.76 6.162-6.162 0-3.405-2.76-6.162-6.162-6.162zM12 16c-2.21 0-4-1.79-4-4s1.79-4 4-4 4 1.79 4 4-1.79 4-4 4zm7.846-10.405c0 .795-.646 1.44-1.44 1.44-.795 0-1.44-.646-1.44-1.44 0-.794.646-1.439 1.44-1.439.793-.001 1.44.645 1.44 1.439z" />
      </svg>
    ),
  },
  {
    id: 'shorts', label: 'Shorts', sub: '9:16 · 60s', maxDur: 60,
    icon: (
      <svg viewBox="0 0 24 24" className="w-5 h-5">
        <path fill="#FF0000" d="M17.77 10.32l-1.2-.5L18 9.06a3.74 3.74 0 0 0-3.5-6.62L6 6.94a3.74 3.74 0 0 0 .23 6.74l1.2.49L6 14.93a3.75 3.75 0 0 0 3.5 6.63l8.5-4.5a3.74 3.74 0 0 0-.23-6.74z" />
        <path fill="#fff" d="M10 14.65v-5.3L15 12l-5 2.65z" />
      </svg>
    ),
  },
  {
    id: 'original', label: 'Original', sub: '16:9 · No crop', maxDur: 300,
    icon: <Film className="w-5 h-5 text-white/80" />,
  },
] as const;
type PlatformId = typeof PLATFORMS[number]['id'];

// ─── Quality config ───────────────────────────────────────────────────────────
// 720p is what Shorts/TikTok/Reels effectively deliver after their own
// re-encode; 1080p is available for users who want full-HD source files but
// takes noticeably longer on the server.
const QUALITIES = [
  { id: 'fast',    label: '720p',  sub: 'Fast · recommended' },
  { id: 'quality', label: '1080p', sub: 'Full HD · slightly slower' },
] as const;
type QualityId = typeof QUALITIES[number]['id'];

// ─── Settings Panel ───────────────────────────────────────────────────────────
// ─── Subtitle styles ──────────────────────────────────────────────────────────
// Caption style gallery (pure-CSS previews). The ffmpeg burn engine ships with
// the captions update and maps these ids to real rendered looks — keep the ids
// stable: they persist in localStorage and travel with every job request.
const SUB_STYLES = [
  { id: 'none', name: 'Default', preview: <span className="text-white/35 text-[10px] font-bold tracking-wide">No subtitles</span> },
  { id: 'basic', name: 'Basic', preview: <span className="bg-black/85 text-white text-[10px] font-semibold px-1.5 py-0.5 rounded">Hey there,</span> },
  { id: 'modern', name: 'Modern', preview: <span className="text-white text-[11px] font-bold" style={{ textShadow: '0 1px 3px rgba(0,0,0,0.9)' }}>Hey there,</span> },
  { id: 'hormozi', name: 'Hormozi', preview: <span className="text-white text-[10px] font-black uppercase" style={{ textShadow: '-1.5px -1.5px 0 #000, 1.5px -1.5px 0 #000, -1.5px 1.5px 0 #000, 1.5px 1.5px 0 #000' }}>Hey there,</span> },
  { id: 'classic', name: 'Classic', preview: <span className="text-[#FFE100] text-[11px] font-black italic" style={{ textShadow: '1px 1px 0 rgba(0,0,0,0.8)' }}>Hey there,</span> },
  { id: 'heat', name: 'Heat', preview: <span className="text-[#FF9500] text-[11px] font-black" style={{ textShadow: '0 0 8px rgba(255,120,0,0.9)' }}>Hey there,</span> },
  { id: 'icy', name: 'Icy', preview: <span className="text-[#7DE8FF] text-[11px] font-black" style={{ textShadow: '0 0 7px rgba(125,232,255,0.8)' }}>Hey there,</span> },
  { id: 'ghost', name: 'Ghost', preview: <span className="text-white/40 text-[11px] font-bold" style={{ textShadow: '0 0 6px rgba(255,255,255,0.55)' }}>Hey there,</span> },
  { id: 'editorial', name: 'Editorial', preview: <span className="text-white/85 text-[9px] font-medium tracking-[0.18em] uppercase">Hey there,</span> },
  { id: 'tallboy', name: 'Tallboy', preview: <span className="inline-block text-white text-[10px] font-black" style={{ transform: 'scaleY(1.55)', textShadow: '1px 1px 0 rgba(0,0,0,0.8)' }}>Hey there,</span> },
  { id: 'elegant', name: 'Elegant', preview: <span className="text-[#F5E9C9] text-[11px] italic" style={{ fontFamily: 'Georgia, serif' }}>Hey there,</span> },
  { id: 'clean', name: 'Clean', preview: <span className="text-white text-[11px] font-bold">Hey <span className="text-[#4FC3F7]">there,</span></span> },
  { id: 'highlight', name: 'Highlight', preview: <span className="text-white text-[10px] font-black"><span className="bg-[#D1FE17] text-black px-1 rounded-sm">Hey</span> there,</span> },
  { id: 'roundtable', name: 'Roundtable', preview: <span className="bg-[#22c55e] text-black text-[9px] font-bold px-1.5 py-0.5 rounded-full">Hey there,</span> },
  { id: 'matrix', name: 'Matrix', preview: <span className="text-[#22FF55] text-[10px] font-bold" style={{ fontFamily: 'monospace' }}>Hey there,</span> },
  { id: 'bubbly', name: 'Bubbly', preview: <span className="text-[#FF5FD2] text-[11px] font-black" style={{ textShadow: '-1px -1px 0 #fff, 1px -1px 0 #fff, -1px 1px 0 #fff, 1px 1px 0 #fff' }}>Hey there,</span> },
  { id: 'funky', name: 'Funky', preview: <span className="text-[11px] font-black bg-gradient-to-r from-[#FF5FD2] via-[#FFD600] to-[#4FC3F7] bg-clip-text text-transparent">Hey there,</span> },
  { id: 'miner', name: 'Miner', preview: <span className="text-[#39FF14] text-[11px] font-black" style={{ textShadow: '-1px -1px 0 #063b00, 1px -1px 0 #063b00, -1px 1px 0 #063b00, 1px 1px 0 #063b00' }}>Hey there,</span> },
  // ── Canva-inspired batch (ids must match the API's SUBTITLE_STYLE_IDS) ─────
  // Boxes:
  { id: 'classicbox', name: 'Classic Box', preview: <span className="text-white text-[10px] font-bold px-1.5 py-0.5 rounded" style={{ background: 'rgba(110,110,110,0.82)' }}>Hey there,</span> },
  { id: 'clickbait', name: 'Clickbait', preview: <span className="bg-[#FF7ECB] text-black text-[10px] font-bold px-1.5 py-0.5 rounded">Hey there,</span> },
  { id: 'evergreen', name: 'Evergreen', preview: <span className="bg-[#1F3D2B] text-[#ECF5E8] text-[10px] px-1.5 py-0.5 rounded tracking-wide">Hey there,</span> },
  { id: 'newsroom', name: 'Newsroom', preview: <span className="bg-[#F5EFDC] text-[#141414] text-[9px] font-bold uppercase px-1.5 py-0.5">Hey there,</span> },
  { id: 'goldenage', name: 'Golden Age', preview: <span className="bg-[#FFC93B] text-[#101010] text-[10px] font-bold px-1.5 py-0.5 rounded">Hey there,</span> },
  { id: 'cleancut', name: 'Clean Cut', preview: <span className="bg-[#EDFFB0] text-[#202020] text-[10px] font-bold px-1.5 py-0.5 rounded">Hey there,</span> },
  // Bold poster looks:
  { id: 'pixelpop', name: 'Pixel Pop', preview: <span className="text-[#7CFF4F] text-[10px] font-black" style={{ fontFamily: 'monospace', textShadow: '2px 2px 0 #101010' }}>Hey there,</span> },
  { id: 'momentum', name: 'Momentum', preview: <span className="text-[#FF4D2E] text-[11px] font-black italic" style={{ textShadow: '-1px -1px 0 #fff, 1px -1px 0 #fff, -1px 1px 0 #fff, 1px 1px 0 #fff' }}>Hey there,</span> },
  { id: 'peachpop', name: 'Peach Pop', preview: <span className="text-[#FFA13B] text-[11px] font-black" style={{ textShadow: '-1px -1px 0 #FFF2DC, 1px -1px 0 #FFF2DC, -1px 1px 0 #FFF2DC, 1px 1px 0 #FFF2DC' }}>Hey there,</span> },
  { id: 'boldpop', name: 'Bold Pop', preview: <span className="text-[#181818] text-[10px] font-black uppercase" style={{ textShadow: '-1.5px -1.5px 0 #fff, 1.5px -1.5px 0 #fff, -1.5px 1.5px 0 #fff, 1.5px 1.5px 0 #fff' }}>Hey there,</span> },
  { id: 'penpal', name: 'Pen Pal', preview: <span className="text-[#FFD227] text-[11px] font-black italic" style={{ textShadow: '1px 1px 0 #101010' }}>Hey there,</span> },
  { id: 'bigideas', name: 'Big Ideas', preview: <span className="text-[#D9D9D9] text-[10px] font-black uppercase" style={{ textShadow: '2px 2px 0 #303030' }}>Hey there,</span> },
  { id: 'boldlime', name: 'Bold Lime', preview: <span className="text-[#8CFF2E] text-[10px] font-black uppercase" style={{ textShadow: '2px 2px 0 #003810' }}>Hey there,</span> },
  { id: 'heromode', name: 'Hero Mode', preview: <span className="text-[#FFE13B] text-[10px] font-black uppercase" style={{ textShadow: '2px 2px 0 #E02020' }}>Hey there,</span> },
  { id: 'blockparty', name: 'Block Party', preview: <span className="text-[#FFB03B] text-[10px] font-black uppercase" style={{ textShadow: '2.5px 2.5px 0 #141414' }}>Hey there,</span> },
  { id: 'boxoffice', name: 'Box Office', preview: <span className="text-[#E02020] text-[10px] font-black uppercase" style={{ fontFamily: 'Georgia, serif', textShadow: '1px 1px 0 #400000' }}>Hey there,</span> },
  { id: 'markeddown', name: 'Marked Down', preview: <span className="text-[#F5F5F5] text-[10px] font-black italic uppercase" style={{ textShadow: '1px 1px 0 #101010' }}>Hey there,</span> },
  { id: 'publicnotice', name: 'Public Notice', preview: <span className="text-white text-[11px] font-black" style={{ textShadow: '-1px -1px 0 #2E6BFF, 1px -1px 0 #2E6BFF, -1px 1px 0 #2E6BFF, 1px 1px 0 #2E6BFF' }}>Hey there,</span> },
  // Neon / glow:
  { id: 'cherryglow', name: 'Cherry Glow', preview: <span className="text-[#FF1E1E] text-[10px] font-black uppercase" style={{ textShadow: '0 0 7px rgba(255,64,64,0.95)' }}>Hey there,</span> },
  { id: 'solarsign', name: 'Solar Sign', preview: <span className="text-[#FFDF6B] text-[10px] font-black uppercase" style={{ textShadow: '0 0 8px rgba(255,179,0,0.95)' }}>Hey there,</span> },
  { id: 'popcorn', name: 'Popcorn', preview: <span className="text-white text-[11px] font-black" style={{ textShadow: '0 0 7px rgba(255,255,255,0.85)' }}>Hey there,</span> },
  { id: 'afterglow', name: 'Afterglow', preview: <span className="text-[#9FFAFF] text-[11px] font-black" style={{ textShadow: '0 0 7px rgba(79,210,232,0.9)' }}>Hey there,</span> },
  { id: 'talkingpoint', name: 'Talking Point', preview: <span className="text-[#C77DFF] text-[9px] font-black uppercase tracking-wide" style={{ textShadow: '0 0 5px rgba(255,255,255,0.8)' }}>Hey there,</span> },
  { id: 'eerienight', name: 'Eerie Night', preview: <span className="text-[#B8FFC9] text-[10px] font-black" style={{ textShadow: '0 0 8px rgba(112,255,112,0.8)' }}>Hey there,</span> },
  { id: 'arcade', name: 'Arcade', preview: <span className="text-[#FF5FF2] text-[10px] font-black uppercase" style={{ fontFamily: 'monospace', textShadow: '0 0 7px rgba(255,48,192,0.9)' }}>Hey there,</span> },
  { id: 'sugarrush', name: 'Sugar Rush', preview: <span className="text-[#FF8AD8] text-[11px] font-black" style={{ textShadow: '0 0 6px rgba(255,255,255,0.85)' }}>Hey there,</span> },
  { id: 'infocus', name: 'In Focus', preview: <span className="text-white text-[11px] font-black" style={{ textShadow: '0 0 4px rgba(0,0,0,0.95), 0 0 8px rgba(0,0,0,0.9)' }}>Hey there,</span> },
  // Script / minimal:
  { id: 'freehand', name: 'Freehand', preview: <span className="text-[#D6E34D] text-[11px] italic">Hey there,</span> },
  { id: 'digitalkitsch', name: 'Digital Kitsch', preview: <span className="text-[#3DBE4E] text-[11px] italic" style={{ fontFamily: 'Georgia, serif' }}>Hey there,</span> },
  { id: 'sidenote', name: 'Sidenote', preview: <span className="text-white/45 text-[10px] italic" style={{ fontFamily: 'Georgia, serif' }}>Hey there,</span> },
  { id: 'refined', name: 'Refined', preview: <span className="text-[#E8B48F] text-[9px] tracking-[0.2em] uppercase">Hey there,</span> },
  { id: 'clearbrief', name: 'Clear Brief', preview: <span className="text-white/60 text-[10px] tracking-wide">Hey there,</span> },
  { id: 'softlyspoken', name: 'Softly Spoken', preview: <span className="text-white text-[10px] tracking-wide" style={{ textShadow: '0 1px 2px rgba(0,0,0,0.6)' }}>Hey there,</span> },
  { id: 'subtext', name: 'Subtext', preview: <span className="text-[#BFBFBF] text-[9px]">Hey there,</span> },
  { id: 'bytetype', name: 'Byte Type', preview: <span className="text-[#FF7DE0] text-[10px] tracking-wide" style={{ fontFamily: 'monospace' }}>Hey there,</span> },
  { id: 'losttape', name: 'Lost Tape', preview: <span className="text-[#C9B6FF] text-[10px] font-bold uppercase" style={{ fontFamily: 'monospace', textShadow: '1px 1px 0 #4FE3FF' }}>Hey there,</span> },
  { id: 'sweettalk', name: 'Sweet Talk', preview: <span className="text-[#FFB6D9] text-[11px] font-black" style={{ textShadow: '-1px -1px 0 #fff, 1px -1px 0 #fff, -1px 1px 0 #fff, 1px 1px 0 #fff' }}>Hey there,</span> },
  // Word-by-word colour cycle:
  { id: 'eyecandy', name: 'Eye Candy', preview: <span className="text-[10px] font-black"><span className="text-[#FF4FC3]">Hey</span> <span className="text-[#B44FFF]">there</span><span className="text-[#2ECC71]">,</span></span> },
];

// Persisted subtitle preference. Defaults: toggle ON with the "Default" tile
// selected — which burns nothing — so captions only appear once the user
// actively picks a style. Migrates the v1 key so anyone who already had
// captions switched on keeps their chosen style.
function readSubsPref(): { on: boolean; style: string } {
  const fallback = { on: true, style: 'none' };
  try {
    const v2 = JSON.parse(localStorage.getItem('autocliper_subs_v2') ?? 'null');
    if (v2 && typeof v2.on === 'boolean' && SUB_STYLES.some(x => x.id === v2.style)) {
      return { on: v2.on, style: v2.style };
    }
    const v1 = JSON.parse(localStorage.getItem('autocliper_subs') ?? 'null');
    if (v1?.on === true && SUB_STYLES.some(x => x.id === v1.style)) {
      return { on: true, style: v1.style };
    }
    return fallback;
  } catch {
    return fallback;
  }
}

function SettingsPanel({
  platform, setPlatform,
  duration, setDuration,
  clipCount, setClipCount,
  quality, setQuality,
  subsEnabled, setSubsEnabled,
  subsStyle, setSubsStyle,
  aiPrompt, setAiPrompt,
  defaultOpen = false,
}: {
  platform: PlatformId; setPlatform: (v: PlatformId) => void;
  duration: number; setDuration: (v: number) => void;
  clipCount: number; setClipCount: (v: number) => void;
  quality: QualityId; setQuality: (v: QualityId) => void;
  subsEnabled: boolean; setSubsEnabled: (v: boolean) => void;
  subsStyle: string; setSubsStyle: (v: string) => void;
  aiPrompt: string; setAiPrompt: (v: string) => void;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  // Auth resolves after mount — keep following the default (closed on the
  // landing page, open once signed in, phone & PC alike) until the user
  // toggles the dropdown themselves.
  const touched = useRef(false);
  useEffect(() => { if (!touched.current) setOpen(defaultOpen); }, [defaultOpen]);
  const [showMoreStyles, setShowMoreStyles] = useState(false);
  const maxDur = PLATFORMS.find(p => p.id === platform)?.maxDur ?? 300;
  const detectedCampaignRules = campaignPromptFeedback(aiPrompt);

  // Clamp duration when platform changes
  const safeDuration = Math.min(duration, maxDur);

  // Free-typing buffer for the custom seconds input — lets the user type "1"
  // on the way to "120" without instant clamping. Re-syncs whenever the real
  // duration changes (preset chip click, platform auto-clamp, rerun prefill).
  const [durText, setDurText] = useState(String(safeDuration));
  useEffect(() => { setDurText(String(safeDuration)); }, [safeDuration]);

  // Slider fill percentages — lime track up to the current value.

  return (
    <div className="w-full max-w-2xl mx-auto mt-3">
      <button
        type="button"
        onClick={() => { touched.current = true; setOpen(o => !o); }}
        className="flex items-center gap-2 text-white/80 hover:text-white text-sm font-bold transition-colors mx-auto px-4 py-2 rounded-xl border border-white/15 bg-[#161616] hover:border-[#D1FE17]/40 hover:bg-[#D1FE17]/5"
      >
        <Scissors className="w-4 h-4" />
        Clip settings
        <ChevronDown className={`w-4 h-4 transition-transform duration-200 ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div className="mt-4 bg-gradient-to-b from-[#191a14] to-[#141414] border border-white/15 rounded-2xl p-4 sm:p-5 space-y-5 shadow-[0_18px_50px_-30px_rgba(209,254,23,0.5)]">

          {/* Platform picker */}
          <div>
            <label className="block text-white/80 text-[11px] font-black uppercase tracking-widest mb-3">Platform</label>
            <div className="grid grid-cols-4 gap-2">
              {PLATFORMS.map(p => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => {
                    setPlatform(p.id);
                    // auto-clamp duration
                    if (duration > p.maxDur) setDuration(p.maxDur);
                  }}
                  className={`flex flex-col items-center gap-1.5 py-3 px-2 rounded-2xl border text-center transition-all ${
                    platform === p.id
                       ? 'border-[#D1FE17] bg-[#D1FE17]/15 text-white shadow-[0_0_20px_-10px_rgba(209,254,23,0.9)]'
                       : 'border-white/15 bg-[#1a1a1a] text-white/75 hover:border-white/35 hover:text-white'
                  }`}
                >
                  <span className="leading-none">{p.icon}</span>
                  <span className="text-xs font-black leading-none">{p.label}</span>
                  <span className="text-[10px] text-white/65 leading-none font-medium">{p.sub}</span>
                  {platform === p.id && (
                    <div className="w-1.5 h-1.5 rounded-full bg-[#D1FE17] mt-0.5" />
                  )}
                </button>
              ))}
            </div>
          </div>

          {/* Quality picker */}
          <div>
            <label className="block text-white/80 text-[11px] font-black uppercase tracking-widest mb-3">Quality</label>
            <div className="grid grid-cols-2 gap-2">
              {QUALITIES.map(q => (
                <button
                  key={q.id}
                  type="button"
                  onClick={() => setQuality(q.id)}
                  className={`flex flex-col items-center gap-1 py-3 px-2 rounded-2xl border text-center transition-all ${
                    quality === q.id
                       ? 'border-[#D1FE17] bg-[#D1FE17]/15 text-white shadow-[0_0_20px_-10px_rgba(209,254,23,0.9)]'
                       : 'border-white/15 bg-[#1a1a1a] text-white/75 hover:border-white/35 hover:text-white'
                  }`}
                >
                  <span className="text-xs font-black leading-none">{q.label}</span>
                  <span className="text-[10px] text-white/65 leading-none font-medium">{q.sub}</span>
                  {quality === q.id && (
                    <div className="w-1.5 h-1.5 rounded-full bg-[#D1FE17] mt-0.5" />
                  )}
                </button>
              ))}
            </div>
            {quality === 'quality' && (
              <p className="text-white/65 text-[11px] mt-2 leading-relaxed">
                Full-HD clips take a little longer to render — with many clips, expect some extra wait.
              </p>
            )}
          </div>

          {/* Duration + Count row */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {/* Clip duration — slider + custom seconds + presets */}
              <div className="bg-[#161616]/90 border border-white/15 rounded-2xl p-4">
              <div className="flex items-center justify-between gap-3 mb-3">
                <label className="text-white/80 text-[11px] font-black uppercase tracking-widest">Clip length</label>
                <div className="relative w-24 shrink-0">
                  <input
                    type="number"
                    min={5}
                    max={maxDur}
                    inputMode="numeric"
                    value={durText}
                    onChange={e => {
                      const raw = e.target.value;
                      setDurText(raw);
                      const v = Math.round(Number(raw));
                      // Live-sync while valid so submitting without blur works.
                      if (Number.isFinite(v) && v >= 5 && v <= maxDur) setDuration(v);
                    }}
                    onBlur={() => {
                      const v = Math.round(Number(durText));
                      if (durText.trim() === '' || !Number.isFinite(v)) {
                        setDurText(String(safeDuration));
                        return;
                      }
                      const clamped = Math.min(maxDur, Math.max(5, v));
                      setDuration(clamped);
                      setDurText(String(clamped));
                    }}
                    className="w-full bg-[#1e1e1e] text-[#D1FE17] text-sm font-black text-right border border-white/10 rounded-lg py-1.5 pl-2 pr-9 outline-none focus:border-[#D1FE17]/50 transition-colors [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none"
                  />
                  <span className="absolute right-2.5 top-1/2 -translate-y-1/2 text-white/65 text-[10px] font-bold pointer-events-none">sec</span>
                </div>
              </div>
              <div className="flex flex-wrap gap-1.5 mt-2.5">
                {[15, 30, 45, 60, 90, 120].filter(v => v <= maxDur).map(v => (
                  <button
                    key={v}
                    type="button"
                    onClick={() => { setDuration(v); setDurText(String(v)); }}
                    className={`px-2.5 py-1 rounded-lg text-[11px] font-black border transition-all ${
                      safeDuration === v
                        ? 'bg-[#D1FE17] text-black border-[#D1FE17]'
                        : 'bg-[#1e1e1e] text-white/75 border-white/15 hover:text-white hover:border-white/35'
                    }`}
                  >{v < 60 ? `${v}s` : v === 60 ? '1m' : v === 90 ? '1:30' : '2m'}</button>
                ))}
              </div>
            </div>

            {/* Clip count — stepper + live credit cost */}
              <div className="bg-[#161616]/90 border border-white/15 rounded-2xl p-4">
              <div className="flex items-center justify-between gap-3 mb-3">
                <label className="text-white/80 text-[11px] font-black uppercase tracking-widest">No. of clips</label>
                <div className="flex items-center gap-1.5 shrink-0">
                  <button
                    type="button"
                    onClick={() => setClipCount(Math.max(1, clipCount - 1))}
                    className="w-7 h-7 rounded-lg bg-[#1e1e1e] border border-white/10 text-white/70 hover:text-white hover:border-white/30 text-base font-black flex items-center justify-center transition-all"
                  >−</button>
                  <input
                    type="number"
                    min={1}
                    inputMode="numeric"
                    value={clipCount}
                    onChange={e => {
                      const v = parseInt(e.target.value) || 1;
                      setClipCount(Math.max(1, v));
                    }}
                    className="w-12 bg-[#1e1e1e] text-[#D1FE17] text-sm font-black text-center border border-white/10 rounded-lg py-1.5 outline-none focus:border-[#D1FE17]/50 transition-colors [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none"
                  />
                  <button
                    type="button"
                    onClick={() => setClipCount(clipCount + 1)}
                    className="w-7 h-7 rounded-lg bg-[#1e1e1e] border border-white/10 text-white/70 hover:text-white hover:border-white/30 text-base font-black flex items-center justify-center transition-all"
                  >+</button>
                </div>
              </div>
              <div className="flex items-center justify-between mt-2.5">
                <span className="text-white/65 text-[10px] font-semibold">Video length sets the limit</span>
                <span className="inline-flex items-center gap-1 bg-[#D1FE17]/10 border border-[#D1FE17]/20 text-[#D1FE17] text-[10px] font-black px-2 py-0.5 rounded-full">
                  <Zap className="w-3 h-3" />
                  {/* keep in sync with CREDITS_PER_CLIP (50) on the API */}
                  {clipCount * 50} credits
                </span>
              </div>
            </div>
          </div>

          {/* Subtitles — caption style gallery */}
          <div className="mt-3 bg-[#161616]/90 border border-white/15 rounded-2xl p-4">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <div>
                  <label className="text-white/80 text-[11px] font-black uppercase tracking-widest">Subtitles</label>
                  <p className="text-white/60 text-[10px] mt-1">Choose a caption look for every clip</p>
                </div>
              </div>
              <button
                type="button"
                role="switch"
                aria-label="Subtitles"
                aria-checked={subsEnabled}
                onClick={() => setSubsEnabled(!subsEnabled)}
                className={`relative w-11 h-6 rounded-full transition-colors shrink-0 ${subsEnabled ? 'bg-[#D1FE17]' : 'bg-white/10'}`}
              >
                <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full transition-transform ${subsEnabled ? 'translate-x-5 bg-black' : 'bg-white'}`} />
              </button>
            </div>
            {subsEnabled && (
              <>
                {/* Show first 15 styles by default (= 5 rows on mobile); MORE STYLES reveals the rest */}
                <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 gap-2 mt-4">
                  {(showMoreStyles
                    ? SUB_STYLES
                    : (() => {
                        const visible = SUB_STYLES.slice(0, 15);
                        // If selected style is beyond visible range, swap it in at position 14
                        const selectedIdx = SUB_STYLES.findIndex(s => s.id === subsStyle);
                        if (selectedIdx >= 15) {
                          visible[14] = SUB_STYLES[selectedIdx];
                        }
                        return visible;
                      })()
                  ).map(s => (
                    <button
                      key={s.id}
                      type="button"
                      onClick={() => setSubsStyle(s.id)}
                      className={`rounded-xl border p-1.5 pb-2 transition-all ${
                        subsStyle === s.id
                           ? 'border-[#D1FE17] bg-[#D1FE17]/15 shadow-[0_0_20px_-10px_rgba(209,254,23,0.9)]'
                           : 'border-white/15 bg-[#1a1a1a] hover:border-white/35'
                      }`}
                    >
                      <div className="h-11 rounded-lg bg-[#2f2f2f] flex items-center justify-center overflow-hidden px-1">
                        {s.preview}
                      </div>
                      <p className={`text-[10px] font-bold mt-1.5 leading-none ${subsStyle === s.id ? 'text-[#D1FE17]' : 'text-white/75'}`}>{s.name}</p>
                    </button>
                  ))}
                </div>
                {/* More / Less Styles toggle */}
                <button
                  type="button"
                  onClick={() => setShowMoreStyles(v => !v)}
                  className="w-full mt-4 py-3 rounded-xl border border-[#D1FE17]/35 bg-[#D1FE17]/[0.06] hover:border-[#D1FE17]/70 hover:bg-[#D1FE17]/10 transition-all flex items-center justify-center gap-2 text-[#D1FE17] text-[11px] font-black tracking-widest uppercase"
                >
                  {showMoreStyles ? 'LESS STYLES ↑' : 'MORE STYLES ↓'}
                </button>
                <p className="text-white/60 text-[11px] mt-3 leading-relaxed">
                  Pick a style to burn captions onto every clip — speech is transcribed automatically, so it works on any video. Keep "Default" for clean clips without captions. Captioned clips take a little longer to process.
                </p>
              </>
            )}
          </div>

          {/* AI prompt — natural-language moment selection */}
          <div className="mt-3 bg-gradient-to-br from-[#1a1b12] to-[#161616] border border-[#D1FE17]/25 rounded-2xl p-4 shadow-[0_14px_38px_-28px_rgba(209,254,23,0.9)]">
            <div className="flex items-start gap-3 mb-3">
              <div className="w-9 h-9 rounded-xl bg-[#D1FE17]/15 border border-[#D1FE17]/35 flex items-center justify-center text-[#D1FE17] shrink-0">
                <PenLine className="w-4 h-4" />
              </div>
              <div className="min-w-0">
                <label htmlFor="ai-prompt" className="text-white text-xs font-black uppercase tracking-widest">What should we clip? <span className="normal-case font-medium tracking-normal text-white/65">AI prompt · optional</span></label>
                <p className="text-white/70 text-[11px] mt-1 leading-relaxed">Give the AI a direction and it will look for those moments in your video.</p>
              </div>
            </div>
            <textarea
              id="ai-prompt"
              value={aiPrompt}
              onChange={e => setAiPrompt(e.target.value)}
              maxLength={10000}
              rows={3}
              placeholder='Try: "Find the funniest moments, strong opinions, or the best advice."'
              className="w-full min-h-[104px] bg-[#090909]/80 border border-white/20 rounded-xl px-3.5 py-3 text-white text-sm leading-relaxed placeholder:text-white/60 focus:outline-none focus:border-[#D1FE17] focus:ring-2 focus:ring-[#D1FE17]/10 resize-none transition-colors"
            />
            {detectedCampaignRules.length > 0 && (
              <div data-testid="campaign-rules-feedback" className="mt-3 rounded-xl border border-[#D1FE17]/30 bg-[#D1FE17]/[0.07] px-3 py-2.5">
                <p className="text-[#D1FE17] text-[10px] font-black uppercase tracking-wider">Campaign brief detected</p>
                <p className="text-white/75 text-[11px] leading-relaxed mt-1">
                  We’ll keep these mandatory items in captions, AI rewrites, schedules, and posts:
                  <span className="text-white font-semibold"> {detectedCampaignRules.join(' · ')}</span>
                </p>
              </div>
            )}
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <span className="text-[10px] font-black uppercase tracking-wider text-white/65">Ideas</span>
              {[
                ['Funny moments', 'Find the funniest moments and reactions.'],
                ['Best advice', 'Find the clearest, most useful advice.'],
                ['Strong opinions', 'Find the strongest opinions and hot takes.'],
                ['Story moments', 'Find the most emotional or surprising story moments.'],
              ].map(([label, value]) => (
                <button
                  key={label}
                  type="button"
                  onClick={() => setAiPrompt(value)}
                  className="px-2.5 py-1.5 rounded-lg border border-white/15 bg-white/[0.04] text-white/75 text-[10px] font-bold hover:text-[#D1FE17] hover:border-[#D1FE17]/55 hover:bg-[#D1FE17]/10 transition-colors"
                >
                  {label}
                </button>
              ))}
              <span className="ml-auto text-[10px] text-white/55 tabular-nums">{aiPrompt.length}/10000</span>
            </div>
            {aiPrompt.trim() !== '' && (
              <p className="text-white/65 text-[11px] mt-3 leading-relaxed">
                Clips will come only from moments matching your prompt. You can paste a campaign brief here too — mandatory tags, hashtags, CTA placement, and caption rules are applied separately from moment selection. If AI matching is unavailable, we’ll choose clips automatically and tell you; if it finds no matches, no clips are made.
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Source Platforms ─────────────────────────────────────────────────────────
const SOURCE_PLATFORMS = [
  {
    id: 'youtube', label: 'YouTube', placeholder: 'https://youtube.com/watch?v=…',
    color: '#FF0000', bg: 'rgba(255,0,0,0.12)', border: 'rgba(255,0,0,0.4)',
    icon: (
      <svg viewBox="0 0 24 24" className="w-5 h-5" fill="currentColor">
        <path d="M23.5 6.19a3.02 3.02 0 0 0-2.12-2.14C19.54 3.5 12 3.5 12 3.5s-7.54 0-9.38.55A3.02 3.02 0 0 0 .5 6.19C0 8.04 0 12 0 12s0 3.96.5 5.81a3.02 3.02 0 0 0 2.12 2.14C4.46 20.5 12 20.5 12 20.5s7.54 0 9.38-.55a3.02 3.02 0 0 0 2.12-2.14C24 15.96 24 12 24 12s0-3.96-.5-5.81zM9.75 15.5v-7l6.5 3.5-6.5 3.5z"/>
      </svg>
    ),
  },
  {
    id: 'kick', label: 'Kick', placeholder: 'https://kick.com/…',
    color: '#53FC18', bg: 'rgba(83,252,24,0.10)', border: 'rgba(83,252,24,0.35)',
    icon: (
      <svg viewBox="0 0 24 24" className="w-5 h-5" fill="currentColor">
        <path d="M3 2h4v8l5-8h5l-6 9 6 11h-5l-5-9v9H3V2z"/>
      </svg>
    ),
  },
  {
    id: 'twitch', label: 'Twitch', placeholder: 'https://twitch.tv/videos/…',
    color: '#9146FF', bg: 'rgba(145,70,255,0.12)', border: 'rgba(145,70,255,0.4)',
    icon: (
      <svg viewBox="0 0 24 24" className="w-5 h-5" fill="currentColor">
        <path d="M11.571 4.714h1.715v5.143H11.57zm4.715 0H18v5.143h-1.714zM6 0L1.714 4.286v15.428h5.143V24l4.286-4.286h3.428L22.286 12V0zm14.571 11.143l-3.428 3.428h-3.429l-3 3v-3H6.857V1.714h13.714z"/>
      </svg>
    ),
  },
  {
    id: 'gdrive', label: 'Google Drive', placeholder: 'https://drive.google.com/file/d/…',
    color: '#4285F4', bg: 'rgba(66,133,244,0.12)', border: 'rgba(66,133,244,0.4)',
    icon: (
      <svg viewBox="0 0 24 24" className="w-5 h-5" fill="currentColor">
        <path d="M6.28 3L1 12.36l3.72 6.44L10 9.44zm11.44 0L12 9.44l3.28 5.68h6.44zM9.72 11.8L6 18.8h12l-3.72-7z" style={{fill:'#4285F4'}}/>
        <path d="M1 12.36L6.28 3h5.44L6 12.36z" style={{fill:'#34A853'}}/>
        <path d="M12 9.44l5.72-6.44H18l-6.28 10.88L9.72 9.44z" style={{fill:'#FBBC04'}}/>
      </svg>
    ),
  },
  {
    id: 'dropbox', label: 'Dropbox', placeholder: 'https://dropbox.com/s/…',
    color: '#0061FF', bg: 'rgba(0,97,255,0.12)', border: 'rgba(0,97,255,0.4)',
    icon: (
      <svg viewBox="0 0 24 24" className="w-5 h-5" fill="currentColor">
        <path d="M6 2L0 6l6 4-6 4 6 4 6-4-6-4 6-4zm12 0l-6 4 6 4-6 4 6 4 6-4-6-4 6-4zM6 16.5L12 20.5l6-4-6-4z"/>
      </svg>
    ),
  },
  {
    id: 'upload', label: 'My device', placeholder: '',
    color: '#D1FE17', bg: 'rgba(209,254,23,0.10)', border: 'rgba(209,254,23,0.4)',
    icon: <UploadIcon className="w-5 h-5" />,
  },
] as const;
type SourcePlatformId = typeof SOURCE_PLATFORMS[number]['id'];

function detectPlatformFromUrl(url: string): SourcePlatformId | null {
  try {
    const h = new URL(url).hostname.replace(/^www\./, '');
    if (h === 'youtube.com' || h === 'youtu.be') return 'youtube';
    if (h === 'kick.com')                         return 'kick';
    if (h === 'twitch.tv' || h === 'clips.twitch.tv') return 'twitch';
    if (h === 'drive.google.com')                 return 'gdrive';
    if (h === 'dropbox.com')                      return 'dropbox';
  } catch { /* invalid URL — ignore */ }
  return null;
}

// ─── Stat Pills ───────────────────────────────────────────────────────────────
const STATS = [
  { value: '1M+', label: 'videos clipped', Icon: Film },
  { value: '10x', label: 'faster creation', Icon: Zap },
  { value: null, label: 'YouTube · Kick · Twitch · Drive', Icon: MonitorPlay },
];

// ─── FAQ ──────────────────────────────────────────────────────────────────────
const FAQ_ITEMS = [
  {
    q: 'What is AutoCliper?',
    a: 'AutoCliper is an AI video clipping tool. Paste a long video from YouTube, Kick, Twitch, Google Drive or Dropbox — or upload one from your device — and it automatically cuts the best moments into short, viral-ready clips for TikTok, Reels and Shorts.',
  },
  {
    q: 'How does AutoCliper work?',
    a: 'Choose your source platform, paste the link (or pick a file), select your clip style and hit Get Clips. Our engine scans the video, finds the loudest and most exciting moments, crops them to vertical 9:16 and hands you ready-to-post clips — usually in under 2 minutes.',
  },
  {
    q: 'Which platforms can I clip from?',
    a: 'YouTube videos, Kick live streams, Twitch VODs and clips, Google Drive links, Dropbox links, and direct uploads from your phone or computer (up to 2 GB). Output styles: TikTok, Reels, Shorts (9:16) or Original 16:9 with no crop.',
  },
  {
    q: 'What are credits and how do they work?',
    a: 'Cutting and upload processing use separate balances. Plans add their included monthly cutting and upload allowances, and top-ups are added to the matching balance.',
  },
  {
    q: 'Do my clips expire?',
    a: 'No. Clips saved to your account stay available in My videos — download them again anytime, from any device. Clips made without an account are remembered in your browser on that device.',
  },
  {
    q: 'Can I earn money from these clips?',
    a: 'Yes — the clips are made from your source video, so if you have the rights to that content you can post and monetize the clips on TikTok, Reels, Shorts or anywhere else, just like any other edit you make.',
  },
  {
    q: 'How does the referral program work?',
    a: 'Every account gets a unique share link. When a friend joins through your link and buys any plan, your referral cutting-credit reward is added automatically. There is no limit, so refer as many friends as you like.',
  },
  {
    q: 'Can I cancel anytime?',
    a: 'Yes, there is no lock-in. If you stop your plan, the credits you already received stay usable, and your saved clips remain downloadable from your account.',
  },
];

function FaqSection() {
  const [open, setOpen] = useState<number | null>(0);
  return (
    <section id="faq" className="py-16 px-4 sm:px-6">
      <div className="max-w-3xl mx-auto">
        <h2 className="text-3xl sm:text-4xl font-black text-center leading-tight mb-3">
          Got questions? <span className="text-[#D1FE17]">We've got answers.</span>
        </h2>
        <p className="text-center text-white/35 text-sm mb-10">Everything you need to know about AutoCliper.</p>
        <div className="space-y-3">
          {FAQ_ITEMS.map((f, i) => (
            <div key={f.q} className="bg-[#161616] border border-white/8 rounded-2xl overflow-hidden hover:border-white/15 transition-colors">
              <button
                type="button"
                onClick={() => setOpen(open === i ? null : i)}
                className="w-full flex items-center justify-between gap-4 px-5 sm:px-6 py-4 text-left"
              >
                <span className="text-white text-sm sm:text-base font-bold">{f.q}</span>
                <Plus className={`w-5 h-5 text-[#D1FE17] shrink-0 transition-transform duration-200 ${open === i ? 'rotate-45' : ''}`} />
              </button>
              {open === i && (
                <p className="px-5 sm:px-6 pb-5 text-white/50 text-sm leading-relaxed">{f.a}</p>
              )}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

// ─── History Panel ────────────────────────────────────────────────────────────
// ─── Source presentation helpers ──────────────────────────────────────────────
type SourceKind = 'youtube' | 'upload' | 'dropbox' | 'kick' | 'link';

/** Human-friendly source description for history rows — never raw query-string URLs. */
export function sourceInfo(url: string): { label: string; sub: string | null; kind: SourceKind } {
  if (url.startsWith('upload://')) {
    const raw = url.split('/').pop() ?? '';
    let name = raw;
    // Malformed %-encoding must never crash the drawer — fall back to raw.
    try { name = decodeURIComponent(raw); } catch { /* keep raw */ }
    return { label: name || 'Uploaded video', sub: 'From this device', kind: 'upload' };
  }
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, '');
    const path = u.pathname.replace(/\/+$/, '');
    if (host === 'youtu.be' || host.endsWith('youtube.com')) {
      const segs = path.split('/').filter(Boolean);
      const id =
        host === 'youtu.be' ? segs[0] :
        (segs[0] === 'shorts' || segs[0] === 'live' || segs[0] === 'embed') ? segs[1] :
        u.searchParams.get('v');
      return { label: 'YouTube video', sub: id ? `youtu.be/${id}` : host + path, kind: 'youtube' };
    }
    if (host.endsWith('dropbox.com')) return { label: 'Dropbox video', sub: host + path, kind: 'dropbox' };
    if (host.endsWith('kick.com')) {
      const segs = path.split('/').filter(Boolean);
      const ch = segs[0] && segs[0] !== 'video' ? segs[0] : null;
      return { label: ch ? `Kick · ${ch}` : 'Kick video', sub: host + path, kind: 'kick' };
    }
    if (host.endsWith('twitch.tv')) return { label: 'Twitch video', sub: host + path, kind: 'link' };
    return { label: host, sub: host + path, kind: 'link' };
  } catch {
    return { label: url.slice(0, 42), sub: null, kind: 'link' };
  }
}

/** "Jul 31 · 7:04 PM" — empty string for missing/invalid timestamps. */
export function fmtDateTime(t: number | string): string {
  const d = new Date(t);
  if (!Number.isFinite(d.getTime())) return '';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
    + ' · '
    + d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

export function SourceBadge({ kind }: { kind: SourceKind }) {
  const Icon =
    kind === 'youtube' ? Youtube :
    kind === 'upload' ? FileVideo :
    kind === 'kick' ? Radio :
    kind === 'dropbox' ? Box : Globe;
  return (
    <div className="w-10 h-10 shrink-0 rounded-xl bg-white/[0.06] border border-white/10 flex items-center justify-center">
      <Icon className="w-[18px] h-[18px] text-white/60" />
    </div>
  );
}

interface HistoryJob {
  id: string;
  source_url: string;
  platform: string;
  clip_duration: number;
  clip_count: number;
  total_duration: string | null;
  created_at: string;
  /** Clip files linked to this session — present while still downloadable. */
  clips?: Clip[] | null;
  /** True when clips existed but their storage TTL has passed. */
  clips_expired?: boolean;
  /** ISO timestamp when clips auto-delete (null = saved/permanent). */
  clips_expire_at?: string | null;
  /** True when user has saved this session permanently. */
  files_saved?: boolean;
}

/** Format how many days until expiry, e.g. "Expires in 13 days" */
function fmtExpiry(isoStr?: string | null): string | null {
  if (!isoStr) return null;
  const ms = Date.parse(isoStr) - Date.now();
  if (ms <= 0) return null;
  const days = Math.ceil(ms / (1000 * 60 * 60 * 24));
  if (days <= 1) return 'Expires tomorrow';
  return `Expires in ${days} days`;
}

export function HistoryPanel({ onRerun, onPlay, localJobs = [], socialAccounts = [], socialAccountsReady = true }: {
  onRerun: (url: string, platform: string, clipDuration: number, clipCount: number) => void;
  onPlay?: (clip: Clip) => void;
  localJobs?: RecentJob[];
  socialAccounts?: SocialAccount[];
  socialAccountsReady?: boolean;
}) {
  const [jobs, setJobs] = useState<HistoryJob[]>([]);
  // Live post badges for history clips (one batched request per load).
  const historyClipIds = jobs.flatMap(j => j.clips ?? []).map(c => c.id);
  const { statuses: historyPostStatuses } = useClipPostStatuses(historyClipIds, historyClipIds.length > 0);
  const [loading, setLoading] = useState(true);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

  useEffect(() => {
    fetch(`${API}/history`, { credentials: 'include' })
      .then(r => r.json())
      .then(d => { setJobs(d.jobs ?? []); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  const deleteJob = async (id: string) => {
    try {
      const res = await fetch(`${API}/history/${id}`, { method: 'DELETE', credentials: 'include' });
      if (res.ok) setJobs(j => j.filter(x => x.id !== id));
    } catch { /* network hiccup — keep the row visible */ }
  };

  const toggleSave = async (id: string, currentlySaved: boolean) => {
    setSavingId(id);
    try {
      const res = await fetch(`${API}/history/${id}/save`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ save: !currentlySaved }),
      });
      if (res.ok) {
        setJobs(j => j.map(x =>
          x.id === id
            ? { ...x, files_saved: !currentlySaved, clips_expire_at: currentlySaved ? null : x.clips_expire_at }
            : x,
        ));
      }
    } catch { /* keep current state */ }
    setSavingId(null);
  };

  // Sessions already shown as playable groups in the "on this device" section:
  // linked via historyId, or (for records saved before linking existed) the
  // same URL clipped within 24 hours.
  const isLocalTwin = (j: HistoryJob) => {
    const created = Date.parse(j.created_at);
    return localJobs.some(l =>
      l.historyId === String(j.id) ||
      (l.url === j.source_url && Number.isFinite(created) && Math.abs(l.date - created) < 24 * 3600 * 1000),
    );
  };
  const visible = jobs.filter(j => !isLocalTwin(j));

  if (loading) return (
    <div className="flex justify-center py-8">
      <Loader2 className="w-5 h-5 text-white/30 animate-spin" />
    </div>
  );

  if (jobs.length === 0) {
    if (localJobs.length > 0) return null;
    return (
      <div className="text-center py-12">
        <div className="w-12 h-12 mx-auto mb-3 rounded-2xl bg-white/[0.05] border border-white/10 flex items-center justify-center">
          <History className="w-5 h-5 text-white/30" />
        </div>
        <p className="text-white/40 text-sm">No clips yet — generate your first one!</p>
      </div>
    );
  }

  if (visible.length === 0) return null;

  const downloadable = visible.filter(j => Array.isArray(j.clips) && j.clips.length > 0);
  const rest = visible.filter(j => !(Array.isArray(j.clips) && j.clips.length > 0));

  const renderSaveBtn = (job: HistoryJob) => (
    <button
      onClick={() => toggleSave(job.id, !!job.files_saved)}
      disabled={savingId === job.id}
      title={job.files_saved ? 'Saved permanently — click to un-save' : 'Save permanently (never auto-delete)'}
      className={`shrink-0 w-7 h-7 flex items-center justify-center rounded-lg transition-colors text-sm ${
        job.files_saved
          ? 'text-[#D1FE17] hover:text-white/60 hover:bg-white/5'
          : 'text-white/25 hover:text-[#D1FE17] hover:bg-white/5'
      }`}
    >
      {savingId === job.id ? '…' : job.files_saved ? '⭐' : '☆'}
    </button>
  );

  return (
    <div>
      <p className="text-white/40 text-[11px] font-black uppercase tracking-widest mb-2 px-1">From your account</p>
      <div className="space-y-3">

      {/* Downloadable sessions — expandable clip grid with Save + expiry */}
      {downloadable.map(job => {
        const open = openId === job.id;
        const info = sourceInfo(job.source_url);
        const clips = job.clips as Clip[];
        const expiry = fmtExpiry(job.clips_expire_at);
        const meta = [
          `${clips.length} ${clips.length === 1 ? 'clip' : 'clips'}`,
          job.total_duration ? `${job.total_duration} video` : undefined,
          fmtDateTime(job.created_at),
          info.sub ?? undefined,
        ].filter(Boolean).join(' · ');
        return (
          <div key={job.id} className={`bg-[#161616] border rounded-2xl overflow-hidden transition-colors ${open ? 'border-white/[0.14]' : 'border-white/[0.07] hover:border-white/[0.14]'}`}>
            <div className="w-full flex items-center pr-2">
              <button
                type="button"
                onClick={() => setOpenId(open ? null : job.id)}
                className="flex-1 min-w-0 flex items-center gap-3 p-3.5 text-left"
              >
                <SourceBadge kind={info.kind} />
                <div className="flex-1 min-w-0">
                  <p className="text-white/90 text-[13px] font-semibold truncate">{info.label}</p>
                  <p className="text-white/35 text-[11px] mt-0.5 truncate">{meta}</p>
                  {job.files_saved ? (
                    <p className="text-[#D1FE17]/60 text-[10px] mt-0.5">⭐ Saved permanently</p>
                  ) : expiry ? (
                    <p className="text-white/25 text-[10px] mt-0.5">{expiry} · ☆ save to keep</p>
                  ) : null}
                </div>
                <ChevronDown className={`w-4 h-4 text-white/40 shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} />
              </button>
              {renderSaveBtn(job)}
              <button
                type="button"
                onClick={() => deleteJob(job.id)}
                className="shrink-0 w-8 h-8 flex items-center justify-center rounded-lg text-white/20 hover:text-red-400 hover:bg-white/5 transition-colors"
                aria-label="Delete this video's clips"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            {open && (
              <div className="px-4 pb-4">
                <a
                  href={`${API}/video/zip?ids=${clips.map(c => c.id).join(',')}`}
                  download="clips.zip"
                  className="flex items-center justify-center gap-2 w-full bg-[#D1FE17] text-black text-xs font-black py-2.5 rounded-xl hover:bg-[#c5f010] active:scale-95 transition-all mb-3"
                >
                  <Download className="w-3.5 h-3.5" />
                  Download all ({clips.length})
                </a>
                <div className="grid grid-cols-2 gap-3">
                  {clips.map((clip, i) => (
                    <ClipCard key={clip.id} clip={clip} index={i} onPlay={() => onPlay?.(clip)} socialAccounts={socialAccounts} socialAccountsReady={socialAccountsReady} postStatus={historyPostStatuses[clip.id]} />
                  ))}
                </div>
              </div>
            )}
          </div>
        );
      })}

      {/* Non-downloadable / expired sessions */}
      {rest.map(job => {
        const info = sourceInfo(job.source_url);
        const meta = [
          `${job.clip_count} ${job.clip_count === 1 ? 'clip' : 'clips'} · ${job.clip_duration}s each`,
          fmtDateTime(job.created_at),
          info.sub ?? undefined,
        ].filter(Boolean).join(' · ');
        return (
          <div key={job.id} className="bg-[#161616] border border-white/[0.07] rounded-2xl p-3.5 transition-colors hover:border-white/[0.14]">
            <div className="flex items-center gap-3">
              <SourceBadge kind={info.kind} />
              <div className="flex-1 min-w-0">
                <p className="text-white/90 text-[13px] font-semibold truncate">{info.label}</p>
                <p className="text-white/35 text-[11px] mt-0.5 truncate">{meta}</p>
              </div>
              <button
                onClick={() => onRerun(job.source_url, job.platform, job.clip_duration, job.clip_count)}
                className="shrink-0 bg-[#D1FE17] text-black text-xs font-black px-3 py-1.5 rounded-lg hover:bg-[#c5f010] transition-colors"
              >
                Regenerate
              </button>
              <button
                onClick={() => deleteJob(job.id)}
                className="shrink-0 w-7 h-7 flex items-center justify-center rounded-lg text-white/20 hover:text-red-400 hover:bg-white/5 transition-colors"
                aria-label="Delete this session"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            {job.clips_expired && (
              <p className="text-white/30 text-[11px] mt-2 pl-[52px]">
                These clip files have expired — regenerate to get fresh ones.
              </p>
            )}
          </div>
        );
      })}
      </div>
    </div>
  );
}

// ─── Recent clip groups — shared by "My clips" (signed-out) & History drawer ──
function RecentJobList({ jobs, onPlay, onDelete, socialAccounts = [] }: {
  jobs: RecentJob[];
  onPlay: (clip: Clip) => void;
  onDelete: (id: string) => void;
  socialAccounts?: SocialAccount[];
}) {
  const [openId, setOpenId] = useState<string | null>(jobs[0]?.id ?? null);
  // Live post badges for this device's clips (signed-out → request fails silently, no badges).
  const rjClipIds = jobs.flatMap(j => j.clips).map(c => c.id);
  const { statuses: rjPostStatuses } = useClipPostStatuses(rjClipIds, rjClipIds.length > 0);

  return (
    <div className="space-y-3">
      {jobs.map(job => {
        const open = openId === job.id;
        const info = sourceInfo(job.url);
        const meta = [
          `${job.clips.length} ${job.clips.length === 1 ? 'clip' : 'clips'}`,
          job.totalDuration ? `${job.totalDuration} video` : undefined,
          job.date > 0 ? fmtDateTime(job.date) : undefined,
          info.sub ?? undefined,
        ].filter(Boolean).join(' · ');
        return (
          <div key={job.id} className={`bg-[#161616] border rounded-2xl overflow-hidden transition-colors ${open ? 'border-white/[0.14]' : 'border-white/[0.07] hover:border-white/[0.14]'}`}>
            <div className="w-full flex items-center pr-2">
              <button
                type="button"
                onClick={() => setOpenId(open ? null : job.id)}
                className="flex-1 min-w-0 flex items-center gap-3 p-3.5 text-left"
              >
                <SourceBadge kind={info.kind} />
                <div className="flex-1 min-w-0">
                  <p className="text-white/90 text-[13px] font-semibold truncate">{info.label}</p>
                  <p className="text-white/35 text-[11px] mt-0.5 truncate">{meta}</p>
                </div>
                <ChevronDown className={`w-4 h-4 text-white/40 shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} />
              </button>
              <button
                type="button"
                onClick={() => onDelete(job.id)}
                className="shrink-0 w-8 h-8 flex items-center justify-center rounded-lg text-white/20 hover:text-red-400 hover:bg-white/5 transition-colors"
                aria-label="Delete this video's clips"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            {open && (
              <div className="px-4 pb-4">
                <a
                  href={`${API}/video/zip?ids=${job.clips.map(c => c.id).join(',')}`}
                  download="clips.zip"
                  className="flex items-center justify-center gap-2 w-full bg-[#D1FE17] text-black text-xs font-black py-2.5 rounded-xl hover:bg-[#c5f010] active:scale-95 transition-all mb-3"
                >
                  <Download className="w-3.5 h-3.5" />
                  Download all ({job.clips.length})
                </a>
                <div className="grid grid-cols-2 gap-3">
                  {job.clips.map((clip, i) => (
                    <ClipCard key={clip.id} clip={clip} index={i} onPlay={() => onPlay(clip)} socialAccounts={socialAccounts} postStatus={rjPostStatuses[clip.id]} />
                  ))}
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ─── Auth nav (session accounts) ────────────────────────────────────────────────
interface AuthNavProps {
  recentCount?: number;
}

/** One row of the account dropdown — icon chip that lights up lime on hover. */
function UserMenuItem({ icon, label, badge, onSelect }: {
  icon: ReactNode; label: string; badge?: string; onSelect: () => void;
}) {
  return (
    <button
      onClick={onSelect}
      className="group w-full flex items-center gap-3 px-2.5 py-2 rounded-xl text-white/70 hover:text-white hover:bg-white/[0.05] text-sm font-semibold transition-colors"
    >
      <span className="w-7 h-7 shrink-0 rounded-lg bg-white/[0.05] border border-white/[0.07] flex items-center justify-center text-white/50 group-hover:text-[#D1FE17] group-hover:border-[#D1FE17]/25 group-hover:bg-[#D1FE17]/10 transition-colors">
        {icon}
      </span>
      <span className="flex-1 text-left truncate">{label}</span>
      {badge && (
        <span className="shrink-0 text-[10px] font-black text-black bg-[#D1FE17] rounded-full px-1.5 py-0.5">{badge}</span>
      )}
    </button>
  );
}

function AuthNavButtons({ recentCount = 0 }: AuthNavProps) {
  const { user, logout } = useAuth();
  const [, setLocation] = useLocation();
  const [userMenuOpen, setUserMenuOpen] = useState(false);

  useEffect(() => {
    if (!userMenuOpen) return;
    const handler = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest('[data-user-menu]')) setUserMenuOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [userMenuOpen]);

  if (!user) {
    return (
      <>
        <button
          onClick={() => setLocation('/login')}
          className="hidden sm:block text-[13px] font-semibold text-white/50 hover:text-white transition-colors"
        >Sign in</button>
        <button
          onClick={() => setLocation('/signup')}
          className="bg-[#D1FE17] text-black text-[13px] font-black px-4 py-2 rounded-full hover:bg-[#c5f010] active:scale-95 transition-all shadow-[0_0_18px_rgba(209,254,23,0.25)]"
        >Get started — Free</button>
      </>
    );
  }

  return (
    <>
      {/* No standalone My videos / credits chips here — the pill nav covers
          navigation and credits live in the avatar menu (user request). */}
      <div className="relative" data-user-menu>
        <button
          onClick={() => setUserMenuOpen(o => !o)}
          className={`flex items-center gap-2 rounded-xl pl-1.5 pr-2.5 py-1.5 border transition-all ${
            userMenuOpen
              ? 'bg-[#D1FE17]/10 border-[#D1FE17]/30'
              : 'bg-white/8 border-white/10 hover:bg-white/12'
          }`}
        >
          <span className="w-7 h-7 rounded-lg bg-[#D1FE17] text-black text-sm font-black flex items-center justify-center shadow-[0_0_14px_rgba(209,254,23,0.35)]">
            {(user.name || user.email)[0].toUpperCase()}
          </span>
          <span className="hidden sm:block text-sm font-semibold text-white/80 max-w-[100px] truncate">
            {user.name || user.email.split('@')[0]}
          </span>
          <ChevronDown className={`hidden sm:block w-3.5 h-3.5 text-white/40 transition-transform ${userMenuOpen ? 'rotate-180' : ''}`} />
        </button>
        {userMenuOpen && (
          <div className="absolute right-0 top-full mt-2 w-[17rem] rounded-2xl border border-white/10 bg-gradient-to-b from-[#161616] to-[#0e0e0e] shadow-2xl shadow-black/70 overflow-hidden z-50">
            {/* Lime hairline + soft glow — the card's signature */}
            <div className="h-px bg-gradient-to-r from-transparent via-[#D1FE17]/70 to-transparent" />
            <div className="relative px-4 pt-4 pb-3">
              <div className="absolute -top-10 right-0 w-36 h-20 bg-[#D1FE17]/10 blur-2xl pointer-events-none" />
              <div className="relative flex items-center gap-3">
                <span className="w-10 h-10 shrink-0 rounded-xl bg-[#D1FE17] text-black text-lg font-black flex items-center justify-center shadow-[0_0_20px_rgba(209,254,23,0.3)]">
                  {(user.name || user.email)[0].toUpperCase()}
                </span>
                <div className="min-w-0">
                  <p className="text-white text-sm font-black truncate">{user.name || 'Creator'}</p>
                  <p className="text-white/35 text-[11px] truncate mt-0.5">{user.email}</p>
                </div>
              </div>
              <button
                onClick={() => { setUserMenuOpen(false); setLocation('/account'); }}
                className="relative mt-3 w-full flex items-center justify-between rounded-xl border border-[#D1FE17]/20 bg-[#D1FE17]/[0.06] hover:bg-[#D1FE17]/[0.12] px-3 py-2 transition-colors"
              >
                <span className="flex items-center gap-1.5 text-[#D1FE17] text-sm font-black">
                  <Zap className="w-4 h-4" />{user.credits.cutting.total} cutting · {user.credits.uploading.total} uploads
                </span>
                <span className="text-[10px] font-black uppercase tracking-wider text-[#D1FE17]/70">Top up →</span>
              </button>
            </div>
            <div className="p-2 pt-0">
              <p className="px-3 pt-2 pb-1 text-[9px] font-black uppercase tracking-[0.2em] text-white/25">Create &amp; post</p>
              <UserMenuItem icon={<History className="w-4 h-4" />} label="My videos" onSelect={() => { setUserMenuOpen(false); setLocation('/history'); }} />
              <UserMenuItem icon={<Share2 className="w-4 h-4" />} label="Social auto-post" onSelect={() => { setUserMenuOpen(false); setLocation('/social'); }} />
              <UserMenuItem icon={<Rocket className="w-4 h-4" />} label="Auto-Pilot" onSelect={() => { setUserMenuOpen(false); setLocation('/autopilot'); }} />
              <p className="px-3 pt-2 pb-1 text-[9px] font-black uppercase tracking-[0.2em] text-white/25">Credits &amp; billing</p>
              <UserMenuItem icon={<Gift className="w-4 h-4" />} label="Refer &amp; earn" onSelect={() => { setUserMenuOpen(false); setLocation('/account'); }} />
              <UserMenuItem icon={<CreditCard className="w-4 h-4" />} label="Account &amp; billing" onSelect={() => { setUserMenuOpen(false); setLocation('/account'); }} />
              <UserMenuItem icon={<Zap className="w-4 h-4" />} label="Pricing &amp; credits" onSelect={() => { setUserMenuOpen(false); setLocation('/pricing'); }} />
              {user.role === 'admin' && (
                <UserMenuItem icon={<Shield className="w-4 h-4" />} label="Admin panel" onSelect={() => { setUserMenuOpen(false); setLocation('/admin'); }} />
              )}
            </div>
            <div className="mx-3 h-px bg-white/[0.06]" />
            <div className="p-2">
              <button
                onClick={async () => { setUserMenuOpen(false); await logout(); setLocation('/'); }}
                className="group w-full flex items-center gap-3 px-2.5 py-2 rounded-xl text-red-400/70 hover:text-red-400 hover:bg-red-500/[0.07] text-sm font-semibold transition-colors"
              >
                <span className="w-7 h-7 shrink-0 rounded-lg bg-white/[0.05] border border-white/[0.07] flex items-center justify-center group-hover:bg-red-500/10 group-hover:border-red-500/25 transition-colors">
                  <LogOut className="w-4 h-4" />
                </span>
                Sign out
              </button>
            </div>
          </div>
        )}
      </div>
    </>
  );
}

// Defers iframe src until after page paint — keeps main thread free on load
function LazyFrame({ src, delayMs = 1500, ...props }: React.IframeHTMLAttributes<HTMLIFrameElement> & { delayMs?: number }) {
  const [active, setActive] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setActive(true), delayMs);
    return () => clearTimeout(t);
  }, [delayMs]);
  return active
    ? <iframe src={src} {...props} />
    : <div style={{ position: 'absolute', inset: 0, background: '#111' }} />;
}

// ─── Main Page ─────────────────────────────────────────────────────────────────
export default function ClipperPage() {
  const { user, loading: authLoading, refresh, logout } = useAuth();
  const isSignedIn = !!user;
  const [, setLocation] = useLocation();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const [url, setUrl] = useState('');
  const [sourcePlatform, setSourcePlatform] = useState<SourcePlatformId>('youtube');
  const [duration, setDuration] = useState(30);
  const [clipCount, setClipCount] = useState(5);
  const [platform, setPlatform] = useState<PlatformId>('shorts');
  const [quality, setQuality] = useState<QualityId>('quality');

  // Subtitle choice — toggle ON by default with the "Default" (no captions)
  // tile ticked; captions only burn once the user picks an actual style.
  const [subsEnabled, setSubsEnabled] = useState<boolean>(() => readSubsPref().on);
  const [subsStyle, setSubsStyle] = useState<string>(() => readSubsPref().style);
  // Face tracking is always on — the toggle was removed from UI.
  // Optional natural-language instruction for WHICH moments to clip — sent
  // with the job when non-empty; empty keeps today's automatic selection.
  const [aiPrompt, setAiPrompt] = useState<string>('');

  useEffect(() => {
  }, []);

  useEffect(() => {
    try { localStorage.setItem('autocliper_subs_v2', JSON.stringify({ on: subsEnabled, style: subsStyle })); } catch { /* private mode */ }
  }, [subsEnabled, subsStyle]);
  const [videoFile, setVideoFile] = useState<File | null>(null); // "My device" source

  const [phase, setPhase] = useState<'idle' | 'loading' | 'done' | 'error'>('idle');
  const [loadMsg, setLoadMsg] = useState('');
  // Progress bar — 0-100, only ever moves forward.
  const jobProgressRef = useRef(0);
  const [jobProgress, setJobProgress] = useState(0);
  const advanceProgress = (p: number) => {
    const next = Math.max(jobProgressRef.current, Math.round(p));
    if (next !== jobProgressRef.current) { jobProgressRef.current = next; setJobProgress(next); }
  };
  const [clips, setClips] = useState<Clip[]>([]);
  // Live "Posted ✓ / Publishing…" badges for result cards (bundle.social mirror).
  const { statuses: clipPostStatuses, refresh: refreshClipPostStatuses } = useClipPostStatuses(
    clips.map(c => c.id), isSignedIn && phase === 'done' && clips.length > 0,
  );
  const [postAllState, setPostAllState] = useState<'idle' | 'pushing' | 'done' | 'already'>('idle');

  // Social accounts fetched once when clips finish (used by ClipCard platform picker)
  const [socialStatus, setSocialStatus] = useState<{ hasAccounts: boolean; accountCount: number; activeCount: number } | null>(null);
  const [socialAccounts, setSocialAccounts] = useState<SocialAccount[]>([]);
  useEffect(() => {
    if (!user) return;
    apiFetch<{ hasAccounts: boolean; accountCount: number; activeCount: number }>('/social/status')
      .then(s => {
        setSocialStatus(s);
        if (s.hasAccounts) {
          apiFetch<{ accounts: ApiSocialAccount[] }>('/social/accounts')
            .then(d => setSocialAccounts(toUiAccounts(d.accounts)))
            .catch(() => {});
        }
      })
      .catch(() => {});
  }, [user]);

  const [totalDuration, setTotalDuration] = useState('');
  const [countNote, setCountNote] = useState('');
  const [error, setError] = useState('');
  const [errorCode, setErrorCode] = useState(''); // e.g. INSUFFICIENT_CREDITS → show "View plans"
  const [playingClip, setPlayingClip] = useState<Clip | null>(null);
  const [recentJobs, setRecentJobs] = useState<RecentJob[]>([]);
  // Device history is account-scoped — (re)load it when auth resolves or the
  // signed-in account changes. Signed out => empty, whatever this browser holds.
  useEffect(() => {
    setRecentJobs(loadRecentJobs(user?.id));
  }, [user?.id]);

  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const resultsRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const jobIdRef = useRef<string | null>(null);
  // True once the server reports real pipeline steps — stops the canned rotation.
  const serverStageRef = useRef(false);
  // Job id shown with a Cancel button — only while the job waits in the queue
  const [cancellableJobId, setCancellableJobId] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);

  // Stop background job polling + message rotation if the user leaves this page
  useEffect(() => () => {
    abortRef.current?.abort();
    if (intervalRef.current) clearInterval(intervalRef.current);
  }, []);

  const canSubmit = sourcePlatform === 'upload' ? !!videoFile : url.trim().startsWith('http');

  // Warm-on-paste: tell the server about a YouTube link the moment it lands in
  // the box, so the download engine converts while the user is still choosing
  // clip count/length. Best-effort — failures are silent, the server dedupes
  // and rate-limits, and the eventual job simply finds the source ready.
  const lastWarmedRef = useRef('');
  useEffect(() => {
    if (!user) return;
    const val = url.trim();
    if (!/^https?:\/\//i.test(val) || detectPlatformFromUrl(val) !== 'youtube') return;
    const warmKey = `${val}|${quality}`;
    if (lastWarmedRef.current === warmKey) return;
    const t = setTimeout(() => {
      lastWarmedRef.current = warmKey;
      apiFetch('/video/warm', { method: 'POST', body: JSON.stringify({ url: val, quality }) })
        .catch(() => { /* best-effort — the clip job works either way */ });
    }, 800);
    return () => clearTimeout(t);
  }, [url, user, quality]);

  // Reconnect to a still-running job after a refresh, tab restore, or dev
  // reload — the server keeps processing even when this tab loses its polling
  // loop, so a stored job id means clips may be ready (or still on the way).
  const resumeTriedRef = useRef(false);
  useEffect(() => {
    if (!user || resumeTriedRef.current) return;
    let stored: { jobId?: string; ts?: number; url?: string; platform?: string; clipDuration?: number; ownerId?: string } | null = null;
    try { stored = JSON.parse(localStorage.getItem(ACTIVE_JOB_KEY) ?? 'null'); } catch { stored = null; }
    if (!stored) return;
    const s = stored;
    const jobId = s.jobId;
    if (typeof jobId !== 'string' || !jobId) return;
    // Only the account that started the job may reconnect to it — a shared
    // browser must never replay one account's clips to another. Ownerless
    // records predate owner-stamping; drop them instead of adopting them.
    if (s.ownerId !== user.id) {
      if (!s.ownerId) { try { localStorage.removeItem(ACTIVE_JOB_KEY); } catch { /* best-effort */ } }
      return;
    }
    // Jobs hard-stop at 30 minutes — anything older is finished or gone.
    if (typeof s.ts !== 'number' || Date.now() - s.ts > 30 * 60 * 1000) {
      try { localStorage.removeItem(ACTIVE_JOB_KEY); } catch { /* best-effort */ }
      return;
    }
    resumeTriedRef.current = true;
    const jobUrl = typeof s.url === 'string' && s.url ? s.url : url;
    const jobPlatform = PLATFORMS.some(p => p.id === s.platform) ? (s.platform as PlatformId) : platform;
    const jobDuration = typeof s.clipDuration === 'number' && Number.isFinite(s.clipDuration) ? s.clipDuration : duration;

    setPhase('loading');
    setError('');
    setErrorCode('');
    setClips([]);
    setCountNote('');
    serverStageRef.current = false;
    setLoadMsg('Reconnecting to your clips…');
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    jobIdRef.current = jobId;

    (async () => {
      try {
        const data = await pollClipJob(API, jobId, {
          signal: ac.signal,
          onStatus: ({ status, queuePosition, stage, progress }) => {
            if (status === 'queued' && queuePosition > 0) {
              setLoadMsg(`Waiting in line — ${queuePosition} ${queuePosition === 1 ? 'job' : 'jobs'} ahead of you…`);
              advanceProgress(2);
              setCancellableJobId(jobId);
            } else {
              setCancellableJobId(null);
              if (stage) { serverStageRef.current = true; setLoadMsg(stage); }
              if (progress !== undefined) advanceProgress(progress);
            }
          },
        });
        try { localStorage.removeItem(ACTIVE_JOB_KEY); } catch { /* best-effort */ }
        finishJob(data, { url: jobUrl, platform: jobPlatform, clipDuration: jobDuration });
      } catch (err) {
        if (ac.signal.aborted) return; // user started a new job meanwhile
        try { localStorage.removeItem(ACTIVE_JOB_KEY); } catch { /* best-effort */ }
        if (err instanceof ClipJobCancelledError) { setPhase('idle'); return; }
        // "Lost track of this job" after a refresh usually means it finished
        // long ago or the record expired — land on the form quietly; real
        // failures still surface loudly during live submissions.
        if (err instanceof Error && /lost track/i.test(err.message)) { setPhase('idle'); return; }
        setError(err instanceof Error ? err.message : String(err));
        setPhase('error');
      } finally {
        jobIdRef.current = null;
        setCancellableJobId(null);
        void refresh(); // credits may have settled while we were away
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  // Clip results belong to the account that made them — the moment the session
  // ends (logout or expiry), take them off the screen and stop any polling.
  useEffect(() => {
    if (authLoading || user) return;
    abortRef.current?.abort();
    jobIdRef.current = null;
    setCancellableJobId(null);
    setPhase('idle');
    setClips([]);
    setTotalDuration('');
    setCountNote('');
    setError('');
    setErrorCode('');
    resumeTriedRef.current = false; // the next login may resume its own job
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authLoading, user]);

  const MSGS = [
    'Downloading video…',
    'Analysing content…',
    'Detecting best moments…',
    'Generating clips…',
    'Finishing up…',
  ];

  // Shared tail of a fresh submission and a resumed job: show the clips and
  // record them locally + in account history.
  const finishJob = (data: ClipJobResult, meta: { url: string; platform: PlatformId; clipDuration: number }) => {
    setClips(data.clips);
    setTotalDuration(data.totalDuration);
    setCountNote(typeof data.countNote === 'string' ? data.countNote : '');
    setPhase('done');

    // Save locally (this browser) so the finished clips survive a refresh —
    // visible only to the account that made them.
    const localJob: RecentJob = {
      id: String(Date.now()),
      url: meta.url,
      platform: meta.platform,
      date: Date.now(),
      totalDuration: data.totalDuration,
      clips: data.clips,
      ownerId: user?.id,
    };
    setRecentJobs(saveRecentJob(localJob));

    if (isSignedIn) {
      // Also record in account history, then link the device copy to the
      // server row so the History drawer shows one entry instead of two.
      fetch(`${API}/history`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          sourceUrl: meta.url,
          platform: meta.platform,
          clipDuration: meta.clipDuration,
          clipCount: data.clips.length,
          totalDuration: data.totalDuration,
          // Link the finished clip files to the account so any signed-in
          // device can download them (thumbnails stripped — too big for DB).
          clips: data.clips.map(c => ({
            id: c.id, name: c.name, label: c.label,
            startTime: c.startTime, endTime: c.endTime,
             duration: c.duration, size: c.size, caption: c.caption,
             campaignRequirements: c.campaignRequirements,
          })),
        }),
      })
        .then(r => (r.ok ? r.json() : null))
        .then((d: { id?: string | number } | null) => {
          // Skip the link-back if the user already deleted this group —
          // re-saving would resurrect it.
          if (d?.id != null && loadRecentJobs(user?.id).some(j => j.id === localJob.id)) {
            setRecentJobs(saveRecentJob({ ...localJob, historyId: String(d.id) }));
          }
        })
        .catch(() => {});
    }

    setTimeout(() => {
      resultsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 100);
  };

  const handleSubmit = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!canSubmit) return;
    if (phase === 'loading') return; // guard against double-submit (rapid clicks/Enter)
    if (!user) { setLocation('/login?next=/'); return; } // clips need an account (credits)

    setPhase('loading');
    setError('');
    setErrorCode('');
    setClips([]);
    setCountNote('');
    serverStageRef.current = false; // new job — canned rotation runs until real stages arrive

    // Cancel any previous submission's polling before starting a new one
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;

    let idx = 0;
    let queuedAhead = 0; // >0 while the server has this job waiting in line
    // Rotation starts when clipping starts — for device uploads that is AFTER
    // the upload itself (the progress % owns the message until then).
    const startRotation = () => {
      setLoadMsg(MSGS[0]);
      intervalRef.current = setInterval(() => {
        if (queuedAhead > 0 || serverStageRef.current) return; // hold queue/server text — don't rotate over it
        idx = Math.min(idx + 1, MSGS.length - 1);
        setLoadMsg(MSGS[idx]);
      }, 4000);
    };

    try {
      // "My device": push the file up in 4MB parts first, then clip the
      // uploaded copy exactly like any other source.
      let jobUrl = url;
      if (sourcePlatform === 'upload') {
        if (!videoFile) { setPhase('idle'); return; }
        setLoadMsg('Uploading your video — 0%');
        advanceProgress(1);
        const uploaded = await uploadVideoFile(API, videoFile, {
          signal: ac.signal,
          onProgress: pct => { setLoadMsg(`Uploading your video — ${Math.floor(pct)}%`); advanceProgress(pct * 0.18); },
        });
        jobUrl = uploaded.url;
      }
      startRotation();

      // Async job + polling — survives the proxy's 120s limit on long videos
      const data = await requestClips(
        API,
        // Subtitles only burn when the user actively picked a style — the
        // "Default" tile (and the toggle off) both mean no captions.
        { url: jobUrl, clipDuration: duration, platform, clipCount, quality, subtitles: subsEnabled && subsStyle !== 'none' ? { style: subsStyle } : null, faceTrack: true, prompt: aiPrompt.trim() || undefined },
        {
          signal: ac.signal,
          onJobId: (id) => {
            jobIdRef.current = id;
            // Remember the running job so a refresh/reload can reconnect to it.
            try {
              localStorage.setItem(ACTIVE_JOB_KEY, JSON.stringify({
                jobId: id, ts: Date.now(), url: jobUrl, platform, clipDuration: duration, ownerId: user?.id,
              }));
            } catch { /* private mode — resume just won't be available */ }
          },
          onStatus: ({ status, queuePosition, stage, progress }) => {
            if (status === 'queued' && queuePosition > 0) {
              queuedAhead = queuePosition;
              setLoadMsg(`Waiting in line — ${queuePosition} ${queuePosition === 1 ? 'job' : 'jobs'} ahead of you…`);
              advanceProgress(2);
              // While queued the server can still cancel this job — offer the button
              setCancellableJobId(jobIdRef.current);
            } else {
              // Our turn — processing started; cancelling is no longer possible
              setCancellableJobId(null);
              if (queuedAhead > 0) {
                queuedAhead = 0;
                if (!serverStageRef.current) setLoadMsg(MSGS[idx]);
              }
              if (stage) {
                // Real pipeline step from the server beats canned rotating text
                serverStageRef.current = true;
                setLoadMsg(stage);
              }
              if (progress !== undefined) advanceProgress(progress);
            }
          },
        },
      );

      try { localStorage.removeItem(ACTIVE_JOB_KEY); } catch { /* best-effort */ }
      finishJob(data, { url: jobUrl, platform, clipDuration: duration });
    } catch (err) {
      if (ac.signal.aborted) return; // cancelled — user left or resubmitted
      if (err instanceof ClipJobCancelledError) {
        // Cancelled (this tab's button or another tab) — back to the form, no error
        try { localStorage.removeItem(ACTIVE_JOB_KEY); } catch { /* best-effort */ }
        setPhase('idle');
        return;
      }
      const apiErr = err as Error & { status?: number; code?: string };
      if (apiErr.status === 401) {
        setLocation('/login?next=/'); // session expired mid-flight
        return;
      }
      if (apiErr.code === 'INSUFFICIENT_CREDITS' || apiErr.status === 402) {
        setErrorCode('INSUFFICIENT_CREDITS');
      }
      setError(err instanceof Error ? err.message : String(err));
      setPhase('error');
      // The job settled (failed) — nothing left to reconnect to.
      try { localStorage.removeItem(ACTIVE_JOB_KEY); } catch { /* best-effort */ }
    } finally {
      if (intervalRef.current) clearInterval(intervalRef.current);
      jobIdRef.current = null;
      setCancellableJobId(null);
      setCancelling(false);
      void refresh(); // credits moved (spent / refunded) — update the chip
    }
  };

  // Leave the line: tell the server to drop the waiting job, then reset the UI.
  const handleCancelJob = async () => {
    const jobId = cancellableJobId;
    if (!jobId || cancelling) return;
    setCancelling(true);
    const ok = await cancelClipJob(API, jobId);
    if (ok) {
      abortRef.current?.abort(); // stop polling
      if (intervalRef.current) clearInterval(intervalRef.current);
      jobIdRef.current = null;
      setCancellableJobId(null);
      try { localStorage.removeItem(ACTIVE_JOB_KEY); } catch { /* best-effort */ }
      setPhase('idle');
    }
    // If !ok the job already started processing — keep waiting; the button
    // disappears on the next 'processing' status update.
    setCancelling(false);
  };

  const reset = () => {
    setPhase('idle');
    setClips([]);
    setCountNote('');
    setUrl('');
    setError('');
    setErrorCode('');
    serverStageRef.current = false;
  };

  // Handoff from /history: "Regenerate" stores the job settings and navigates
  // here — pick them up once and prefill the form.
  useEffect(() => {
    try {
      const raw = sessionStorage.getItem('autocliper_rerun');
      if (!raw) return;
      sessionStorage.removeItem('autocliper_rerun');
      const r = JSON.parse(raw);
      if (typeof r?.url === 'string' && r.url) {
        setUrl(r.url);
        if (PLATFORMS.some(p => p.id === r.platform)) setPlatform(r.platform as PlatformId);
        if (Number.isFinite(r.clipDuration)) setDuration(Math.min(Math.max(Math.round(r.clipDuration), 5), 300));
        if (Number.isFinite(r.clipCount)) setClipCount(Math.max(Math.round(r.clipCount), 1));
      }
    } catch { /* corrupted handoff — land on an empty form */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="min-h-screen bg-[#0d0d0d] text-white font-sans">
      <style>{`@keyframes slideDown{0%{top:0;opacity:1}80%{opacity:0.6}100%{top:100%;opacity:0}}`}</style>

      {/* ── Video Player Modal ────────────────────────────────────────────── */}
      {playingClip && (
        <VideoModal clip={playingClip} onClose={() => setPlayingClip(null)} />
      )}

      {/* ── Navbar ────────────────────────────────────────────────────────── */}
      <nav className="sticky top-0 z-50 bg-[#0a0a0a]/80 backdrop-blur-2xl">
        {/* Lime hairline bottom */}
        <div className="absolute bottom-0 inset-x-0 h-px bg-gradient-to-r from-transparent via-[#D1FE17]/20 to-transparent" />
        <div className="max-w-6xl mx-auto px-4 sm:px-6 h-[60px] flex items-center justify-between gap-4">
          {/* Logo */}
          <a href="/" className="flex items-center gap-2.5 shrink-0">
            <div className="w-8 h-8 rounded-xl bg-[#D1FE17] flex items-center justify-center shadow-[0_0_20px_rgba(209,254,23,0.35)]">
              <Scissors className="w-4 h-4 text-black" strokeWidth={2.5} />
            </div>
            <span className="font-black text-[17px] tracking-tight text-white">AutoCliper</span>
          </a>

          {/* Center nav — desktop: slim frosted pill. Signed in = app links
              (My videos / Auto-Pilot / Social) instead of marketing anchors. */}
          {isSignedIn ? (
            <div className="hidden md:flex items-center gap-0.5 px-1.5 py-1.5 rounded-full border border-white/[0.07] bg-white/[0.03] text-sm font-semibold text-white/50">
              <Link href="/" className="px-4 py-1.5 rounded-full text-white bg-white/[0.08] transition-all duration-150">Home</Link>
              <Link href="/history" className="px-4 py-1.5 rounded-full hover:text-white hover:bg-white/[0.06] transition-all duration-150">My videos</Link>
              <Link href="/autopilot" className="px-4 py-1.5 rounded-full hover:text-white hover:bg-white/[0.06] transition-all duration-150">Auto-Pilot</Link>
              <Link href="/social" className="px-4 py-1.5 rounded-full hover:text-white hover:bg-white/[0.06] transition-all duration-150">Social</Link>
              <a href="#refer" className="flex items-center gap-1.5 px-4 py-1.5 rounded-full text-[#D1FE17]/80 hover:text-[#D1FE17] hover:bg-[#D1FE17]/8 transition-all duration-150">
                <Gift className="w-3.5 h-3.5" />Refer
              </a>
            </div>
          ) : (
            <div className="hidden md:flex items-center gap-0.5 px-1.5 py-1.5 rounded-full border border-white/[0.07] bg-white/[0.03] text-sm font-semibold text-white/50">
              <a href="#features" className="px-3.5 py-1.5 rounded-full hover:text-white hover:bg-white/[0.06] transition-all duration-150 whitespace-nowrap">Features</a>
              <a href="#autopilot" className="px-3.5 py-1.5 rounded-full hover:text-white hover:bg-white/[0.06] transition-all duration-150 whitespace-nowrap">Auto-Pilot</a>
              <a href="#pricing" className="px-3.5 py-1.5 rounded-full hover:text-white hover:bg-white/[0.06] transition-all duration-150">Pricing</a>
              <a href="#refer" className="flex items-center gap-1.5 px-4 py-1.5 rounded-full text-[#D1FE17]/80 hover:text-[#D1FE17] hover:bg-[#D1FE17]/8 transition-all duration-150">
                <Gift className="w-3.5 h-3.5" />Refer
              </a>
            </div>
          )}

          {/* Right: auth + hamburger */}
          <div className="flex items-center gap-2.5 shrink-0">
            <AuthNavButtons recentCount={recentJobs.length} />
            <button
              type="button"
              onClick={() => setMobileMenuOpen(o => !o)}
              className="md:hidden w-9 h-9 flex items-center justify-center rounded-xl bg-white/[0.05] border border-white/[0.07] hover:bg-white/10 transition-colors"
              aria-label="Toggle menu"
            >
              {mobileMenuOpen
                ? <X className="w-4.5 h-4.5 text-white/60" />
                : <Menu className="w-4.5 h-4.5 text-white/60" />}
            </button>
          </div>
        </div>

        {/* Mobile menu — premium slide-down panel */}
        {mobileMenuOpen && (
          <div className="md:hidden border-t border-white/[0.06] bg-gradient-to-b from-[#111111] to-[#0d0d0d] px-4 pt-3 pb-5">

            {/* ── Signed-in: identity + credits card ─────────────────────── */}
            {isSignedIn && user && (
              <div className="mb-3">
                <div className="flex items-center justify-between gap-3 bg-white/[0.04] border border-white/[0.08] rounded-2xl px-4 py-3">
                  <div className="flex items-center gap-3 min-w-0">
                    <span className="w-9 h-9 shrink-0 rounded-xl bg-[#D1FE17] text-black font-black text-base flex items-center justify-center shadow-[0_0_14px_rgba(209,254,23,0.3)]">
                      {(user.name || user.email)[0].toUpperCase()}
                    </span>
                    <div className="min-w-0">
                      <p className="text-white text-sm font-black truncate">{user.name || user.email.split('@')[0]}</p>
                      <p className="text-white/35 text-[11px] truncate">{user.email}</p>
                    </div>
                  </div>
                  <Link
                    href="/account"
                    onClick={() => setMobileMenuOpen(false)}
                    className="flex items-center gap-1.5 bg-[#D1FE17]/10 border border-[#D1FE17]/30 text-[#D1FE17] rounded-xl px-3 py-1.5 text-sm font-black hover:bg-[#D1FE17]/20 transition-colors shrink-0"
                  >
                    <Zap className="w-3.5 h-3.5" />{user.credits.cutting.total} cutting
                  </Link>
                </div>
              </div>
            )}

            {/* ── Quick actions (icon-chip rows) ──────────────────────────── */}
            <div className="space-y-0.5">
              {isSignedIn && (
                <>
                  <p className="px-2 pt-1 pb-1 text-[9px] font-black uppercase tracking-[0.2em] text-white/25">My content</p>
                  <Link
                    href="/history"
                    onClick={() => setMobileMenuOpen(false)}
                    className="group flex items-center gap-3 px-2.5 py-2.5 rounded-xl hover:bg-white/[0.05] transition-colors"
                  >
                    <span className="w-8 h-8 rounded-lg bg-white/[0.05] border border-white/[0.07] flex items-center justify-center text-white/50 group-hover:text-[#D1FE17] group-hover:border-[#D1FE17]/25 group-hover:bg-[#D1FE17]/10 transition-colors shrink-0">
                      <History className="w-4 h-4" />
                    </span>
                    <span className="text-sm font-semibold text-white/75 group-hover:text-white transition-colors flex-1">My clips</span>
                    {recentJobs.length > 0 && (
                      <span className="text-[10px] font-black text-black bg-[#D1FE17] rounded-full px-1.5 py-0.5">{recentJobs.length}</span>
                    )}
                  </Link>
                  <Link
                    href="/social"
                    onClick={() => setMobileMenuOpen(false)}
                    className="group flex items-center gap-3 px-2.5 py-2.5 rounded-xl hover:bg-white/[0.05] transition-colors"
                  >
                    <span className="w-8 h-8 rounded-lg bg-white/[0.05] border border-white/[0.07] flex items-center justify-center text-white/50 group-hover:text-[#D1FE17] group-hover:border-[#D1FE17]/25 group-hover:bg-[#D1FE17]/10 transition-colors shrink-0">
                      <Share2 className="w-4 h-4" />
                    </span>
                    <span className="text-sm font-semibold text-white/75 group-hover:text-white transition-colors">Connect accounts</span>
                  </Link>
                  <Link
                    href="/autopilot"
                    onClick={() => setMobileMenuOpen(false)}
                    className="group flex items-center gap-3 px-2.5 py-2.5 rounded-xl hover:bg-white/[0.05] transition-colors"
                  >
                    <span className="w-8 h-8 rounded-lg bg-white/[0.05] border border-white/[0.07] flex items-center justify-center text-white/50 group-hover:text-[#D1FE17] group-hover:border-[#D1FE17]/25 group-hover:bg-[#D1FE17]/10 transition-colors shrink-0">
                      <Rocket className="w-4 h-4" />
                    </span>
                    <span className="text-sm font-semibold text-white/75 group-hover:text-white transition-colors">Auto-Pilot</span>
                  </Link>
                  <div className="my-1.5 mx-1 h-px bg-white/[0.05]" />
                </>
              )}

              {/* Marketing links only make sense before signing up — signed-in
                  users already have their app links in "My content" above. */}
              {!isSignedIn && (
                <>
                  <p className="px-2 pt-1 pb-1 text-[9px] font-black uppercase tracking-[0.2em] text-white/25">Explore</p>
                  {([
                    { href: '#features', label: 'Features', icon: <Sparkles className="w-4 h-4" /> },
                    { href: '#autopilot', label: 'Auto-Pilot', icon: <Rocket className="w-4 h-4" /> },
                    { href: '/pricing', label: 'Pricing', icon: <Zap className="w-4 h-4" /> },
                  ] as const).map(item => (
                    <a
                      key={item.label}
                      href={item.href}
                      onClick={() => setMobileMenuOpen(false)}
                      className="group flex items-center gap-3 px-2.5 py-2.5 rounded-xl hover:bg-white/[0.05] transition-colors"
                    >
                      <span className="w-8 h-8 rounded-lg bg-white/[0.05] border border-white/[0.07] flex items-center justify-center text-white/50 group-hover:text-[#D1FE17] group-hover:border-[#D1FE17]/25 group-hover:bg-[#D1FE17]/10 transition-colors shrink-0">
                        {item.icon}
                      </span>
                      <span className="text-sm font-semibold text-white/75 group-hover:text-white transition-colors">{item.label}</span>
                    </a>
                  ))}
                </>
              )}

              {/* Refer CTA */}
              <a
                href="#refer"
                onClick={() => setMobileMenuOpen(false)}
                className="group flex items-center gap-3 px-2.5 py-2.5 rounded-xl hover:bg-[#D1FE17]/[0.07] transition-colors"
              >
                <span className="w-8 h-8 rounded-lg bg-[#D1FE17]/10 border border-[#D1FE17]/25 flex items-center justify-center text-[#D1FE17] shrink-0">
                  <Gift className="w-4 h-4" />
                </span>
                <span className="text-sm font-bold text-[#D1FE17] flex-1">Refer &amp; earn</span>
                <span className="text-[10px] font-black text-black bg-[#D1FE17] rounded-full px-1.5 py-0.5">Reward</span>
              </a>
            </div>

            {/* ── Auth footer ─────────────────────────────────────────────── */}
            {!isSignedIn ? (
              <div className="mt-4 flex gap-2">
                <Link
                  href="/login"
                  onClick={() => setMobileMenuOpen(false)}
                  className="flex-1 text-center py-2.5 rounded-xl border border-white/10 text-sm font-semibold text-white/70 hover:text-white hover:bg-white/5 transition-colors"
                >Log in</Link>
                <Link
                  href="/signup"
                  onClick={() => setMobileMenuOpen(false)}
                  className="flex-1 text-center py-2.5 rounded-xl bg-[#D1FE17] text-black text-sm font-black hover:bg-[#c5f010] active:scale-95 transition-all"
                >Get started — Free</Link>
              </div>
            ) : (
              <button
                onClick={async () => { setMobileMenuOpen(false); await logout(); setLocation('/'); }}
                className="mt-4 w-full flex items-center gap-3 px-2.5 py-2.5 rounded-xl text-red-400/70 hover:text-red-400 hover:bg-red-500/[0.07] text-sm font-semibold transition-colors"
              >
                <span className="w-8 h-8 rounded-lg bg-white/[0.05] border border-white/[0.07] flex items-center justify-center transition-colors">
                  <LogOut className="w-4 h-4" />
                </span>
                Sign out
              </button>
            )}
          </div>
        )}
      </nav>

      {/* ── Hero ──────────────────────────────────────────────────────────── */}
      <section className="relative pt-12 pb-8 px-4 sm:px-6 overflow-hidden">
        {/* Glows */}
        <div className="absolute top-0 left-1/4 w-[700px] h-[400px] bg-[#D1FE17]/5 rounded-full blur-[120px] pointer-events-none -translate-x-1/2" />
        <div className="absolute top-20 right-0 w-[400px] h-[600px] bg-[#D1FE17]/3 rounded-full blur-[140px] pointer-events-none" />

        <div className="relative max-w-6xl mx-auto">
          {/* ── Split layout: left=text+form  right=phones (desktop, logged-out only) ── */}
          <div className={isSignedIn
            ? "flex flex-col items-center w-full"
            : "flex flex-col lg:flex-row items-center gap-10 lg:gap-6 xl:gap-12"}>

            {/* ── LEFT: text + form ────────────────────────────────── */}
            <div className={isSignedIn ? "w-full max-w-3xl mx-auto text-center" : "flex-1 min-w-0 w-full text-center lg:text-left"}>
              {/* Badge */}
              <div className="inline-flex items-center gap-2 bg-white/5 border border-white/10 text-white/70 text-xs font-bold uppercase tracking-widest px-4 py-1.5 rounded-full mb-7">
                <Zap className="w-3 h-3 text-[#D1FE17]" />
                #1 AI Video Clipping Tool
              </div>

              {/* Headline */}
              <h1 className="text-4xl sm:text-5xl md:text-6xl font-black leading-[1.05] tracking-tight mb-5">
                1 long video.<br />
                <span className="text-[#D1FE17]">{clipCount} viral clips.</span>
              </h1>

              <p className={`text-white/50 text-base sm:text-lg mb-6 leading-relaxed max-w-lg mx-auto${isSignedIn ? '' : ' lg:mx-0'}`}>
                Paste a link from YouTube, Kick, Twitch, Google Drive or Dropbox —
                AI finds the best moments and cuts them into short viral clips automatically.
              </p>

              {/* Auto-post pitch */}
              <div className={`mb-8 max-w-lg mx-auto${isSignedIn ? '' : ' lg:mx-0'}`}>
                <Link
                  href="/social"
                  className="group flex flex-col sm:flex-row items-center justify-center gap-2.5 sm:gap-4 rounded-2xl border border-[#D1FE17]/15 bg-[#D1FE17]/[0.04] hover:bg-[#D1FE17]/[0.08] hover:border-[#D1FE17]/30 transition-all px-4 sm:px-5 py-3.5"
                >
                  <div className="flex items-center gap-1 shrink-0">
                    {ALL_PLATFORM_KEYS.slice(0, 5).map(k => (
                      <PlatformIcon key={k} type={k} size={22} />
                    ))}
                    <div className="w-[22px] h-[22px] rounded-md bg-white/8 flex items-center justify-center text-[8px] font-black text-white/40">+5</div>
                  </div>
                  <p className="text-sm font-bold text-white/75 leading-snug text-center">
                    Connect your accounts once — <span className="text-[#D1FE17]">every clip auto-posts</span> to all your socials
                  </p>
                  <span className="flex items-center gap-1 text-xs font-black text-[#D1FE17] whitespace-nowrap group-hover:gap-2 transition-all">
                    Connect <ArrowRight className="w-3.5 h-3.5" />
                  </span>
                </Link>
              </div>

              {/* ── Input bar ─────────────────────────────────────────────── */}
          <form onSubmit={handleSubmit} className="max-w-2xl mx-auto">
            {/* Source platform selector */}
            <div className="mb-4">
              <p className="text-white/75 text-xs font-black uppercase tracking-widest mb-3 text-center">Choose your video source</p>
              <div className="grid grid-cols-3 sm:grid-cols-6 gap-2">
                {SOURCE_PLATFORMS.map(sp => {
                  const active = sourcePlatform === sp.id;
                  return (
                    <button
                      key={sp.id}
                      type="button"
                      onClick={() => setSourcePlatform(sp.id)}
                      style={active ? { background: sp.bg, borderColor: sp.border, color: sp.color } : {}}
                      className={`flex flex-col items-center gap-1.5 py-3 px-2 rounded-xl border text-center transition-all duration-200 ${
                        active
                          ? 'shadow-lg scale-105'
                          : 'bg-white/5 border-white/15 text-white/75 hover:bg-white/10 hover:border-white/35 hover:text-white hover:scale-102'
                      }`}
                    >
                      <span style={{ color: sp.color }}>
                        {sp.icon}
                      </span>
                      <span className="text-[10px] font-bold leading-tight">{sp.label}</span>
                    </button>
                  );
                })}
              </div>
            </div>

            <div
              className="relative flex items-center bg-[#1a1a1a] rounded-2xl p-1.5 transition-all shadow-xl shadow-black/30 focus-within:shadow-[0_0_28px_-10px_rgba(209,254,23,0.45)]"
              style={{ border: `1.5px solid ${SOURCE_PLATFORMS.find(s => s.id === sourcePlatform)?.border ?? 'rgba(255,255,255,0.1)'}` }}
            >
              {sourcePlatform === 'upload' ? (
                <>
                  <FileVideo className="w-5 h-5 text-white/70 ml-3 shrink-0" />
                  <label
                    className={`flex-1 min-w-0 flex items-center gap-2 px-3 py-2.5 ${phase === 'loading' ? 'cursor-not-allowed' : 'cursor-pointer'}`}
                    onDragOver={e => e.preventDefault()}
                    onDrop={e => {
                      e.preventDefault();
                      if (phase === 'loading') return;
                      const f = e.dataTransfer.files?.[0];
                      if (f) setVideoFile(f);
                    }}
                  >
                    <input
                      type="file"
                      accept="video/*,.mp4,.mov,.m4v,.mkv,.webm,.avi"
                      className="hidden"
                      disabled={phase === 'loading'}
                      onChange={e => { setVideoFile(e.target.files?.[0] ?? null); e.target.value = ''; }}
                    />
                    {videoFile ? (
                      <>
                        <span className="truncate text-white text-sm sm:text-base font-medium">{videoFile.name}</span>
                        <span className="text-white/65 text-xs font-semibold shrink-0">{(videoFile.size / (1024 * 1024)).toFixed(1)} MB</span>
                      </>
                    ) : (
                       <span className="text-white/70 text-sm sm:text-base font-medium">Choose a video from your device — or drag &amp; drop…</span>
                    )}
                  </label>
                  {videoFile && phase !== 'loading' && (
                    <button
                      type="button"
                      onClick={() => setVideoFile(null)}
                      className="w-8 h-8 flex items-center justify-center text-white/30 hover:text-white/70 transition-colors shrink-0"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  )}
                </>
              ) : (
                <>
                  <Link2 className="w-5 h-5 text-white/70 ml-3 shrink-0" />
                  <input
                    type="url"
                    value={url}
                    onChange={e => {
                      const val = e.target.value;
                      setUrl(val);
                      const detected = detectPlatformFromUrl(val);
                      if (detected) setSourcePlatform(detected);
                    }}
                    placeholder={SOURCE_PLATFORMS.find(s => s.id === sourcePlatform)?.placeholder ?? 'Paste a video link…'}
                    className="flex-1 bg-transparent text-white placeholder:text-white/60 text-sm sm:text-base font-medium px-3 py-2.5 outline-none min-w-0"
                    disabled={phase === 'loading'}
                  />
                  {url && (
                    <button
                      type="button"
                      onClick={() => setUrl('')}
                      className="w-8 h-8 flex items-center justify-center text-white/30 hover:text-white/70 transition-colors shrink-0"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  )}
                </>
              )}
            </div>

            {sourcePlatform === 'upload' && (
               <p className="text-white/65 text-[11px] font-semibold mt-2 text-center">
                MP4 · MOV · M4V · MKV · WEBM · AVI — up to 2 GB
              </p>
            )}

            {/* Settings — hidden on mobile landing page, always visible when signed in */}
            <div className={isSignedIn ? "block" : "hidden sm:block"}>
            <SettingsPanel
              platform={platform} setPlatform={setPlatform}
              duration={duration} setDuration={setDuration}
              clipCount={clipCount} setClipCount={setClipCount}
              quality={quality} setQuality={setQuality}
              subsEnabled={subsEnabled} setSubsEnabled={setSubsEnabled}
              subsStyle={subsStyle} setSubsStyle={setSubsStyle}
              aiPrompt={aiPrompt} setAiPrompt={setAiPrompt}
              defaultOpen={isSignedIn}
            />
            </div>

            {/* Big CTA below the settings — last stop before submit */}
            <button
              type="submit"
              disabled={!canSubmit || phase === 'loading'}
              aria-describedby={!canSubmit ? 'clip-submit-help' : undefined}
              className={`w-full mt-4 bg-[#D1FE17] text-black text-base sm:text-lg font-black py-4 rounded-2xl border-2 border-[#D1FE17] transition-all flex items-center justify-center gap-2 shadow-lg shadow-[#D1FE17]/25 ${
                canSubmit && phase !== 'loading'
                  ? 'hover:bg-[#c5f010] active:scale-[0.98]'
                  : 'opacity-60 cursor-not-allowed'
              }`}
            >
              {phase === 'loading' ? (
                <Loader2 className="w-5 h-5 animate-spin" />
              ) : canSubmit ? (
                <Sparkles className="w-5 h-5" />
              ) : (
                <Link2 className="w-5 h-5 text-black" />
              )}
              <span>Get Clips</span>
              {phase === 'loading' && (
                <span className="text-xs font-bold text-black/60">Creating…</span>
              )}
            </button>
            {!canSubmit && phase !== 'loading' && (
              <div id="clip-submit-help" className="mt-3 flex items-center justify-center gap-2 text-center">
                <span className="rounded-full border border-[#D1FE17]/35 bg-[#D1FE17]/10 px-2 py-1 text-[10px] font-black uppercase tracking-wider text-[#D1FE17]">
                  Step 1
                </span>
                <p className="text-white/75 text-xs font-semibold">
                  {sourcePlatform === 'upload'
                    ? 'Choose a video above to unlock clipping.'
                    : 'Paste a video link above to unlock clipping.'}
                </p>
              </div>
            )}

          </form>

          {/* Credits nudge */}
          {user && user.credits.cutting.total === 0 && (
            <div className="max-w-2xl mx-auto mt-4 flex items-center justify-center gap-1.5 bg-amber-400/8 border border-amber-400/20 text-amber-200/90 text-xs font-semibold px-4 py-2.5 rounded-xl flex-wrap">
              <Zap className="w-3.5 h-3.5 shrink-0" />
              <span>You're out of cutting credits —</span>
              <Link href="/pricing" className="text-[#D1FE17] font-black hover:underline">get more</Link>
              <span>to keep clipping.</span>
            </div>
          )}
          {!user && (
            <div className="max-w-2xl mx-auto mt-4 flex flex-col sm:flex-row items-center justify-between gap-3 rounded-2xl border border-white/12 bg-[#151515] px-4 py-3.5">
              <div className="text-center sm:text-left">
                <p className="text-white text-sm font-black">New here? Start clipping free.</p>
                <p className="text-white/65 text-xs mt-0.5">Create an account and get 3 free clips — no card needed.</p>
              </div>
              <Link
                href="/signup"
                className="shrink-0 inline-flex items-center gap-1.5 rounded-xl bg-[#D1FE17] px-4 py-2.5 text-xs font-black text-black hover:bg-[#c5f010] active:scale-95 transition-all"
              >
                Create free account <ArrowRight className="w-3.5 h-3.5" strokeWidth={3} />
              </Link>
            </div>
          )}

          {/* Stats */}
          <div className="hidden sm:flex flex-wrap items-center justify-center gap-3 mt-8">
            {STATS.map(s => (
              <div
                key={s.label}
                className="group flex items-center gap-2.5 bg-[#161616] border border-white/10 pl-1.5 pr-4 py-1.5 rounded-full transition-all duration-300 hover:border-[#D1FE17]/40 hover:shadow-[0_0_24px_rgba(209,254,23,0.12)] hover:-translate-y-0.5"
              >
                <span className="w-7 h-7 rounded-full bg-[#D1FE17]/10 border border-[#D1FE17]/25 flex items-center justify-center text-[#D1FE17] transition-transform duration-300 group-hover:scale-110">
                  <s.Icon className="w-3.5 h-3.5" />
                </span>
                <span className="text-xs font-semibold text-white/45">
                  {s.value && <span className="text-sm font-black text-[#D1FE17] tracking-tight mr-1.5">{s.value}</span>}
                  {s.label}
                </span>
              </div>
            ))}
          </div>
            </div>{/* end LEFT column */}

            {/* ── RIGHT: 4 staggered iPhones — desktop only, landing page only ── */}
            {!isSignedIn && (() => {
              const phones = [
                { embedId: 'eac32d3a0fd148e89e85a1eaa28aba10', tag: 'Auto-Share' },
                { embedId: '8e2f06f4b50c4cbe8ededc978a63ec85', tag: 'Auto-Post' },
                { embedId: 'd97b926c3589406dbd76c3aaf7b15235', tag: 'Viral Clips' },
                { embedId: '358351cf783b4aefa8f8099dcb4238e6', tag: 'AI Clipping' },
              ];
              const PhoneShell = ({ embedId, tag, style, noEmbed, delayMs = 1500 }: { embedId: string; tag: string; style: React.CSSProperties; noEmbed?: boolean; delayMs?: number }) => (
                <div className="absolute flex items-center" style={style}>
                  <div className="absolute -left-[4px] top-[22%] flex flex-col gap-1 z-30 pointer-events-none">
                    <div className="w-[3px] h-3 rounded-full bg-[#2a2a2a]" />
                    <div className="w-[3px] h-3 rounded-full bg-[#2a2a2a]" />
                    <div className="w-[3px] h-5 rounded-full bg-[#2a2a2a]" />
                  </div>
                  <div className="absolute -right-[4px] top-[28%] z-30 pointer-events-none">
                    <div className="w-[3px] h-7 rounded-full bg-[#2a2a2a]" />
                  </div>
                  <div className="relative w-full overflow-hidden bg-[#111] shadow-[0_0_0_2px_#2e2e2e,0_0_0_3px_#1a1a1a,0_30px_70px_-15px_rgba(0,0,0,0.95)]" style={{ borderRadius: '2.2rem', aspectRatio: '9/16' }}>
                    <div className="absolute inset-0 rounded-[2rem] bg-gradient-to-br from-white/[0.07] via-transparent to-transparent pointer-events-none z-30" />
                    <div className="absolute top-2 left-1/2 -translate-x-1/2 z-40 pointer-events-none bg-black rounded-full flex items-center gap-0.5 px-2" style={{ width: '60px', height: '18px' }}>
                      <div className="w-1.5 h-1.5 rounded-full bg-[#1a1a1a] border border-white/10 ml-auto" />
                      <div className="w-1 h-1 rounded-full bg-[#1c1c1e]" />
                    </div>
                    <div className="absolute top-6 left-0 right-0 flex items-center justify-between px-2.5 z-30 pointer-events-none">
                      <div className="flex items-center gap-1">
                        <div className="w-4 h-4 rounded-lg bg-[#D1FE17] flex items-center justify-center shadow-[0_0_8px_rgba(209,254,23,0.5)]">
                          <Scissors className="w-2 h-2 text-black" strokeWidth={2.5} />
                        </div>
                        <span className="text-white text-[7px] font-black drop-shadow-lg">AutoCliper</span>
                      </div>
                      <div className="bg-[#D1FE17] text-black text-[6px] font-black px-1.5 py-0.5 rounded shadow-lg">{tag}</div>
                    </div>
                    <div className="absolute right-2 bottom-10 flex flex-col items-center gap-2 z-30 pointer-events-none">
                      {[{ icon: <Heart className="w-3 h-3 text-white fill-white" />, count: '12.4K' },
                        { icon: <MessageCircle className="w-3 h-3 text-white" />, count: '847' },
                        { icon: <Share2 className="w-3 h-3 text-white" />, count: 'Share' }].map((a, ai) => (
                        <div key={ai} className="flex flex-col items-center gap-0.5">
                          <div className="w-7 h-7 rounded-full bg-black/40 backdrop-blur-sm border border-white/10 flex items-center justify-center">{a.icon}</div>
                          <span className="text-white text-[6px] font-bold drop-shadow">{a.count}</span>
                        </div>
                      ))}
                    </div>
                    <div className="absolute bottom-4 left-2.5 right-10 z-30 pointer-events-none">
                      <div className="flex items-center gap-1 mb-0.5">
                        <div className="w-4 h-4 rounded-full bg-[#D1FE17] flex items-center justify-center text-black text-[6px] font-black border border-white">A</div>
                        <span className="text-white text-[7px] font-black drop-shadow">@autocliper</span>
                      </div>
                      <p className="text-white text-[6px] font-semibold leading-tight drop-shadow [text-shadow:0_1px_4px_rgba(0,0,0,0.9)]">
                        1 video → 5 viral clips ✂️ #autocliper
                      </p>
                    </div>
                    <div className="absolute bottom-1 left-1/2 -translate-x-1/2 w-14 h-0.5 rounded-full bg-white/30 z-30 pointer-events-none" />
                    {noEmbed
                      ? <div className="absolute inset-0 bg-gradient-to-br from-[#1a0808] via-[#0a0d18] to-[#0a120a]">
                          <div className="absolute inset-0" style={{ background: 'radial-gradient(ellipse at 40% 55%, rgba(209,254,23,0.06) 0%, transparent 65%)' }} />
                        </div>
                      : <>
                          <LazyFrame
                            src={`https://app.heygen.com/embeds/${embedId}?autoplay=1&muted=1&loop=1&controls=0`}
                            title={tag} frameBorder="0" delayMs={delayMs}
                            allow="autoplay; fullscreen; picture-in-picture" allowFullScreen
                            className="absolute top-0 left-0 w-full"
                            style={{ bottom: '-50px', height: 'calc(100% + 50px)', background: '#111' }}
                          />
                          <div className="absolute inset-0 z-10 pointer-events-none" style={{ bottom: '28px' }} />
                        </>
                    }
                    <div className="absolute bottom-0 left-0 right-0 h-7 bg-[#111] z-20 pointer-events-none" />
                  </div>
                </div>
              );
              return (
                <div className="hidden lg:block shrink-0 relative" style={{ width: '450px', height: '600px' }}>
                  {/* Bottom row — lazy iframe, loads 2.5–3s after page paint */}
                  <PhoneShell embedId={phones[3].embedId} tag={phones[3].tag} delayMs={3000}
                    style={{ width: '168px', bottom: '0', right: '20px', transform: 'rotate(4deg)', zIndex: 1, opacity: 0.68 }} />
                  <PhoneShell embedId={phones[2].embedId} tag={phones[2].tag} delayMs={2500}
                    style={{ width: '178px', bottom: '15px', left: '25px', transform: 'rotate(-3deg)', zIndex: 2, opacity: 0.75 }} />
                  {/* Top row — front, clearly visible */}
                  <PhoneShell embedId={phones[1].embedId} tag={phones[1].tag}
                    style={{ width: '188px', top: '0', right: '0', transform: 'rotate(5deg)', zIndex: 3, opacity: 0.90 }} />
                  <PhoneShell embedId={phones[0].embedId} tag={phones[0].tag}
                    style={{ width: '200px', top: '0', left: '0', transform: 'rotate(-4deg)', zIndex: 4 }} />
                </div>
              );
            })()}

          </div>{/* end flex-row */}

          {/* ── Mobile phones — 4 phones, 2×2 layout, landing page only ─── */}
          {!isSignedIn && (() => {
            const mPhones = [
              { embedId: 'eac32d3a0fd148e89e85a1eaa28aba10', tag: 'Auto-Share' },
              { embedId: '8e2f06f4b50c4cbe8ededc978a63ec85', tag: 'Auto-Post' },
              { embedId: 'd97b926c3589406dbd76c3aaf7b15235', tag: 'Viral Clips' },
              { embedId: '358351cf783b4aefa8f8099dcb4238e6', tag: 'AI Clipping' },
            ];
            const MPhone = ({ embedId, tag, style, noEmbed, delayMs = 1800 }: { embedId: string; tag: string; style: React.CSSProperties; noEmbed?: boolean; delayMs?: number }) => (
              <div className="absolute" style={style}>
                <div className="absolute -left-[3px] top-[22%] flex flex-col gap-1 z-30 pointer-events-none">
                  <div className="w-[3px] h-2.5 rounded-full bg-[#2a2a2a]" /><div className="w-[3px] h-2.5 rounded-full bg-[#2a2a2a]" /><div className="w-[3px] h-4 rounded-full bg-[#2a2a2a]" />
                </div>
                <div className="absolute -right-[3px] top-[28%] z-30 pointer-events-none"><div className="w-[3px] h-6 rounded-full bg-[#2a2a2a]" /></div>
                <div className="relative w-full overflow-hidden bg-[#111] shadow-[0_0_0_2px_#2e2e2e,0_0_0_3px_#1a1a1a,0_20px_50px_-10px_rgba(0,0,0,0.9)]" style={{ borderRadius: '1.6rem', aspectRatio: '9/16' }}>
                  <div className="absolute inset-0 rounded-[1.4rem] bg-gradient-to-br from-white/[0.07] via-transparent to-transparent pointer-events-none z-30" />
                  <div className="absolute top-1.5 left-1/2 -translate-x-1/2 z-40 pointer-events-none bg-black rounded-full" style={{ width: '44px', height: '13px' }} />
                  <div className="absolute top-4 left-0 right-0 flex items-center justify-between px-2 z-30 pointer-events-none">
                    <div className="flex items-center gap-0.5"><div className="w-3 h-3 rounded-md bg-[#D1FE17] flex items-center justify-center"><Scissors className="w-1.5 h-1.5 text-black" strokeWidth={2.5} /></div><span className="text-white text-[5px] font-black">AutoCliper</span></div>
                    <div className="bg-[#D1FE17] text-black text-[4px] font-black px-1 py-0.5 rounded">{tag}</div>
                  </div>
                  <div className="absolute right-1.5 bottom-6 flex flex-col items-center gap-1 z-30 pointer-events-none">
                    <div className="w-4 h-4 rounded-full bg-black/40 flex items-center justify-center"><Heart className="w-2 h-2 text-white fill-white" /></div>
                    <div className="w-4 h-4 rounded-full bg-black/40 flex items-center justify-center"><MessageCircle className="w-2 h-2 text-white" /></div>
                    <div className="w-4 h-4 rounded-full bg-black/40 flex items-center justify-center"><Share2 className="w-2 h-2 text-white" /></div>
                  </div>
                  <div className="absolute bottom-1 left-1/2 -translate-x-1/2 w-8 h-0.5 rounded-full bg-white/25 z-30 pointer-events-none" />
                  {noEmbed
                    ? <div className="absolute inset-0 bg-gradient-to-br from-[#1a0808] via-[#0a0d18] to-[#0a120a]">
                        <div className="absolute inset-0" style={{ background: 'radial-gradient(ellipse at 40% 55%, rgba(209,254,23,0.06) 0%, transparent 65%)' }} />
                      </div>
                    : <>
                        <LazyFrame src={`https://app.heygen.com/embeds/${embedId}?autoplay=1&muted=1&loop=1&controls=0`} title={tag} frameBorder="0" delayMs={delayMs} allow="autoplay; fullscreen; picture-in-picture" allowFullScreen className="absolute top-0 left-0 w-full" style={{ bottom: '-44px', height: 'calc(100% + 44px)', background: '#111' }} />
                        <div className="absolute inset-0 z-10 pointer-events-none" style={{ bottom: '22px' }} />
                      </>
                  }
                  <div className="absolute bottom-0 left-0 right-0 h-6 bg-[#111] z-20 pointer-events-none" />
                </div>
              </div>
            );
            return (
              <div className="lg:hidden mt-10 flex justify-center">
                <div className="relative" style={{ width: 'min(90vw, 360px)', height: 'min(120vw, 480px)' }}>
                  {/* Bottom row — lazy iframe, 2.5–3s delay */}
                  <MPhone embedId={mPhones[3].embedId} tag={mPhones[3].tag} delayMs={3000}
                    style={{ width: 'min(38vw, 138px)', bottom: 0, right: '12px', transform: 'rotate(4deg)', zIndex: 1, opacity: 0.65 }} />
                  <MPhone embedId={mPhones[2].embedId} tag={mPhones[2].tag} delayMs={2500}
                    style={{ width: 'min(40vw, 148px)', bottom: '10px', left: '12px', transform: 'rotate(-3deg)', zIndex: 2, opacity: 0.72 }} />
                  {/* Top row — clearly visible */}
                  <MPhone embedId={mPhones[1].embedId} tag={mPhones[1].tag}
                    style={{ width: 'min(42vw, 155px)', top: 0, right: 0, transform: 'rotate(5deg)', zIndex: 3, opacity: 0.90 }} />
                  <MPhone embedId={mPhones[0].embedId} tag={mPhones[0].tag}
                    style={{ width: 'min(44vw, 162px)', top: 0, left: 0, transform: 'rotate(-5deg)', zIndex: 4 }} />
                </div>
              </div>
            );
          })()}

        </div>{/* end max-w-6xl */}
      </section>

      {/* ── Loading state ─────────────────────────────────────────────────── */}
      {phase === 'loading' && (
        <section className="py-12 px-4 text-center">
          <div className="max-w-md mx-auto">
            {/* Spinner ring */}
            <div className="relative w-20 h-20 mx-auto mb-6">
              <div className="absolute inset-0 rounded-full border-4 border-white/5" />
              <div className="absolute inset-0 rounded-full border-4 border-transparent border-t-[#D1FE17] animate-spin" />
              <div className="absolute inset-3 rounded-full bg-[#161616] flex items-center justify-center">
                <Scissors className="w-6 h-6 text-[#D1FE17]" />
              </div>
            </div>
            <p className="text-white/90 text-lg font-semibold">
              {loadMsg}
              <Dots />
            </p>
            <p className="text-white/35 text-sm mt-2">
              Large videos may take 2–5 minutes. Don't close this tab.
            </p>
            {/* Progress bar — smooth 1→100%, never jumps backward */}
            <div className="mt-6 h-1.5 bg-white/8 rounded-full overflow-hidden max-w-xs mx-auto">
              <div
                className="h-full bg-[#D1FE17] rounded-full"
                style={{ width: `${Math.max(3, jobProgress)}%`, transition: 'width 1.4s cubic-bezier(0.22,1,0.36,1)' }}
              />
            </div>
            {/* Cancel — only while the job is still waiting in the queue */}
            {cancellableJobId && (
              <button
                type="button"
                onClick={handleCancelJob}
                disabled={cancelling}
                className="mt-6 inline-flex items-center gap-2 bg-white/8 hover:bg-white/15 disabled:opacity-50 text-white/80 hover:text-white text-sm font-bold px-5 py-2.5 rounded-xl border border-white/10 transition-colors"
              >
                <X className="w-4 h-4" />
                {cancelling ? 'Leaving the line…' : 'Cancel — leave the line'}
              </button>
            )}
          </div>
        </section>
      )}

      {/* ── Error state ───────────────────────────────────────────────────── */}
      {phase === 'error' && (
        <section className="py-12 px-4 text-center">
          <div className="max-w-md mx-auto bg-red-950/40 border border-red-500/20 rounded-2xl p-8">
            <AlertCircle className="w-10 h-10 text-red-400 mx-auto mb-4" />
            <h3 className="text-white text-lg font-bold mb-2">
              {errorCode === 'INSUFFICIENT_CREDITS' ? 'Not enough credits' : 'Something went wrong'}
            </h3>
            <p className="text-white/50 text-sm leading-relaxed mb-6">{error}</p>
            <div className="flex items-center justify-center gap-3 flex-wrap">
              {errorCode === 'INSUFFICIENT_CREDITS' && (
                <Link
                  href="/pricing"
                  className="bg-[#D1FE17] text-black text-sm font-black px-6 py-2.5 rounded-xl hover:bg-[#c5f010] transition-colors"
                >
                  View plans
                </Link>
              )}
              <button
                onClick={reset}
                className="bg-white/10 hover:bg-white/15 text-white text-sm font-bold px-6 py-2.5 rounded-xl transition-colors"
              >
                Try again
              </button>
            </div>
          </div>
        </section>
      )}

      {/* ── Results ───────────────────────────────────────────────────────── */}
      {phase === 'done' && clips.length > 0 && (
        <section ref={resultsRef} className="py-10 px-4 sm:px-6">
          <div className="max-w-6xl mx-auto">

            {/* Header */}
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-8">
              <div>
                <h2 className="text-2xl sm:text-3xl font-black">
                  {clips.length} Clips Ready 🎬
                </h2>
                {countNote && (
                  <p className="text-amber-200/80 text-xs font-semibold mt-1.5">{countNote}</p>
                )}
                <p className="text-white/40 text-sm mt-1">
                  From a {totalDuration} video · Tap any clip to play · Saved to{' '}
                  <Link
                    href="/history"
                    className="text-[#D1FE17] hover:underline font-semibold"
                  >My videos</Link>
                </p>
              </div>
              <div className="flex items-center gap-3 flex-wrap">
                {/* Post All to Social */}
                <button
                  onClick={async () => {
                    if (postAllState !== 'idle') return;
                    setPostAllState('pushing');
                    try {
                      const rs = await Promise.all(clips.map(c =>
                        apiFetch<{ ok: boolean; posted: string[]; alreadyPosted?: string[] }>('/social/posts', {
                          method: 'POST',
                          body: JSON.stringify({ clipId: c.id, caption: c.caption, label: c.label }),
                        }).catch(() => null),
                      ));
                      // Clips already posted are skipped server-side — if nothing new
                      // went out, say "already posted" instead of a fake "Posted!".
                      const postedCount = rs.filter(r => (r?.posted?.length ?? 0) > 0).length;
                      const alreadyCount = rs.filter(r => r && (r.posted?.length ?? 0) === 0 && (r.alreadyPosted?.length ?? 0) > 0).length;
                      setPostAllState(postedCount === 0 && alreadyCount > 0 ? 'already' : 'done');
                      refreshClipPostStatuses();   // cards flip to "Publishing…" and mirror the provider
                      setTimeout(() => setPostAllState('idle'), 4000);
                    } catch { setPostAllState('idle'); }
                  }}
                  disabled={postAllState === 'pushing'}
                  className={[
                    'flex items-center gap-2 text-sm font-black px-5 py-2.5 rounded-xl transition-all active:scale-95',
                    postAllState === 'done' || postAllState === 'already'
                      ? 'bg-white/10 text-[#D1FE17]'
                      : postAllState === 'pushing'
                        ? 'bg-white/5 text-white/40 cursor-not-allowed'
                        : 'bg-white/10 text-white hover:bg-white/15',
                  ].join(' ')}
                >
                  {postAllState === 'pushing' && <><Loader2 className="w-4 h-4 animate-spin" /> Posting…</>}
                  {postAllState === 'done'    && <><Check   className="w-4 h-4" /> Posted!</>}
                  {postAllState === 'already' && <><Check   className="w-4 h-4" /> Already posted ✓</>}
                  {postAllState === 'idle'    && <><Share2  className="w-4 h-4" /> Post All to Social</>}
                </button>
                {/* Download all */}
                <button
                  onClick={async () => {
                    // Preferred: one ZIP download — mobile browsers show a single
                    // prompt instead of blocking N separate files.
                    const ids = clips.map(c => c.id).join(',');
                    try {
                      const check = await fetch(`${API}/video/zip?ids=${ids}&check=1`);
                      if (!check.ok) throw new Error('zip unavailable');
                      const a = document.createElement('a');
                      a.href = `${API}/video/zip?ids=${ids}`;
                      a.download = 'clips.zip';
                      document.body.appendChild(a);
                      a.click();
                      a.remove();
                      return;
                    } catch {
                      // Fall through to per-file downloads below.
                    }
                    // Fallback: stagger the downloads — many mobile browsers drop
                    // all but the first when N links are clicked in the same tick.
                    clips.forEach((c, i) => setTimeout(() => {
                      const a = document.createElement('a');
                      a.href = dlUrl(c.id);
                      a.download = c.name;
                      a.click();
                    }, i * 600));
                  }}
                  className="flex items-center gap-2 bg-[#D1FE17] text-black text-sm font-black px-5 py-2.5 rounded-xl hover:bg-[#c5f010] active:scale-95 transition-all"
                >
                  <Download className="w-4 h-4" />
                  Download All
                </button>
                <button
                  onClick={reset}
                  className="flex items-center gap-2 bg-white/8 hover:bg-white/12 text-white/70 text-sm font-semibold px-4 py-2.5 rounded-xl transition-colors"
                >
                  New video
                </button>
              </div>
            </div>

            {/* Clips grid */}
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3 sm:gap-4">
              {clips.map((clip, i) => (
                <ClipCard key={clip.id} clip={clip} index={i} onPlay={() => setPlayingClip(clip)} socialAccounts={socialAccounts} postStatus={clipPostStatuses[clip.id]} />
              ))}
            </div>
          </div>
        </section>
      )}

      {/* ── Features — everything AutoCliper does, in plain words ─────────── */}
      {phase === 'idle' && !isSignedIn && (
        <section id="features" className="py-20 px-4 sm:px-6">
          <div className="max-w-5xl mx-auto">
            <p className="text-center text-[#D1FE17] text-xs font-black uppercase tracking-[0.25em] mb-3">What you get</p>
            <h2 className="text-3xl sm:text-4xl font-black text-center leading-tight">
              Built to make you <span className="text-[#D1FE17]">go viral.</span>
            </h2>
            <p className="text-center text-white/35 text-sm sm:text-base mt-3 mb-12 max-w-xl mx-auto">
              Paste one link — AutoCliper cuts the best moments, adds subtitles, writes
              the caption and posts it everywhere for you. Here's everything you get:
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
              {[
                { n: '01', icon: <Scissors className="w-5 h-5" />, title: 'Cuts the best moments', desc: 'AI scans the full video and clips the loudest, most exciting parts — never random cuts.' },
                { n: '02', icon: <Captions className="w-5 h-5" />, title: 'Subtitles on every clip', desc: 'Word-by-word captions burned in automatically, so people watch even on mute.' },
                { n: '03', icon: <Smartphone className="w-5 h-5" />, title: 'Ready for TikTok & Reels', desc: 'Every clip comes out vertical 9:16 — no cropping, no editing apps needed.' },
                { n: '04', icon: <Zap className="w-5 h-5" />, title: 'Done in ~2 minutes', desc: 'From pasted link to finished, downloadable clips in about two minutes.' },
                { n: '05', icon: <PenLine className="w-5 h-5" />, title: 'AI writes your caption', desc: 'Every post gets its own scroll-stopping caption — written for you automatically.' },
                { n: '06', icon: <Send className="w-5 h-5" />, title: 'Posts to your socials', desc: 'Connect TikTok, Instagram & YouTube once — clips publish in one tap.' },
                { n: '07', icon: <Rocket className="w-5 h-5" />, title: 'Auto-Pilot mode', desc: 'Pick days & a time once — fresh clips get posted daily while you sleep.' },
                { n: '08', icon: <Globe className="w-5 h-5" />, title: 'Works with any video', desc: 'YouTube, Kick, Twitch, Drive, Dropbox — or upload straight from your phone.' },
              ].map(f => (
                <div key={f.title} className="relative group">
                  {/* Hairline gradient border — lime-lit from the top, like the plan cards */}
                  <div className="relative h-full rounded-3xl p-px bg-[#D1FE17]/45 transition-all duration-300 group-hover:bg-[#D1FE17]/75 group-hover:-translate-y-1.5 group-hover:shadow-[0_24px_60px_-20px_rgba(209,254,23,0.4)]">
                    <div className="relative h-full overflow-hidden rounded-[calc(1.5rem-1px)] bg-gradient-to-b from-[#202b0b] via-[#151b0d] to-[#0e0e0e] p-6">
                      {/* Soft lime glow that breathes in on hover */}
                      <div className="absolute -top-14 -left-14 w-40 h-40 rounded-full bg-[#D1FE17]/10 blur-3xl opacity-70 group-hover:opacity-100 transition-opacity duration-500 pointer-events-none" />
                      <span className="absolute -top-1.5 right-3 text-[64px] font-black leading-none bg-gradient-to-b from-[#D1FE17]/20 to-transparent bg-clip-text text-transparent select-none pointer-events-none transition-colors duration-500 group-hover:from-[#D1FE17]/40">{f.n}</span>
                      <div className="relative w-11 h-11 rounded-2xl bg-[#D1FE17] text-black flex items-center justify-center mb-4 shadow-[0_10px_30px_-8px_rgba(209,254,23,0.5)] transition-transform duration-300 group-hover:scale-110 group-hover:-rotate-6">
                        {f.icon}
                      </div>
                      <div className="relative text-white text-base font-black mb-1.5">{f.title}</div>
                      <div className="relative text-white/45 text-sm leading-relaxed">{f.desc}</div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>
      )}

      {/* ── Social auto-post feature section ─────────────────────────────── */}
      {phase === 'idle' && !isSignedIn && (
        <section id="autopost" className="py-10 pb-16 px-4 sm:px-6 relative overflow-hidden">
          {/* Background glow */}
          <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[800px] h-[500px] rounded-full bg-[#D1FE17]/4 blur-[130px] pointer-events-none" />
          <div className="max-w-5xl mx-auto relative">

            {/* Label + headline */}
            <p className="text-center text-[#D1FE17] text-xs font-black uppercase tracking-[0.25em] mb-3">Social auto-post</p>
            <h2 className="text-3xl sm:text-4xl lg:text-5xl font-black text-center leading-tight mb-4">
              Cut once.<br />
              <span className="text-[#D1FE17]">Post everywhere.</span>
            </h2>
            <p className="text-center text-white/40 text-sm sm:text-base max-w-2xl mx-auto mb-10 leading-relaxed">
              The only AI clipper that automatically posts your clips to Instagram, TikTok, YouTube and
              7 more platforms simultaneously — the moment they're generated. Zero extra clicks.
            </p>

            {/* Platform icons belt */}
            <div className="flex items-center justify-center gap-2 sm:gap-2.5 flex-wrap mb-12">
              {([
                { type: 'INSTAGRAM', label: 'Instagram' },
                { type: 'TIKTOK',    label: 'TikTok'    },
                { type: 'YOUTUBE',   label: 'YouTube'   },
                { type: 'TWITTER',   label: 'X'         },
                { type: 'FACEBOOK',  label: 'Facebook'  },
                { type: 'LINKEDIN',  label: 'LinkedIn'  },
                { type: 'THREADS',   label: 'Threads'   },
                { type: 'PINTEREST', label: 'Pinterest' },
                { type: 'BLUESKY',   label: 'Bluesky'   },
              ] as const).map((plat) => (
                <div
                  key={plat.label}
                  className="flex items-center gap-2 bg-[#1a1a1a] border border-white/8 rounded-2xl px-3 py-2.5 hover:-translate-y-1 hover:border-white/20 transition-all duration-200 cursor-default"
                >
                  <PlatformIcon type={plat.type} size={24} />
                  <span className="text-[11px] font-black text-white/55">{plat.label}</span>
                </div>
              ))}
            </div>

            {/* 3-step flow */}
            <div className="grid md:grid-cols-3 gap-6 md:gap-0 mb-12 relative">
              {/* Connecting line (desktop) */}
              <div className="hidden md:block absolute top-8 left-[calc(100%/6)] right-[calc(100%/6)] h-px bg-gradient-to-r from-transparent via-[#D1FE17]/30 to-transparent" />

              {([
                { icon: <Video className="w-6 h-6 text-[#D1FE17]" />, step: '01', title: 'Paste a video link',       desc: 'YouTube, Kick, Twitch, Google Drive, Dropbox — or upload directly from your device.' },
                { icon: <Cpu className="w-6 h-6 text-[#D1FE17]" />,   step: '02', title: 'AI finds the best moments', desc: 'Our engine scans the full video and cuts the loudest, most viral moments into short vertical clips.' },
                { icon: <Send className="w-6 h-6 text-[#D1FE17]" />,  step: '03', title: 'Auto-posted instantly',     desc: 'Every clip automatically posts to all your connected platforms — no app switching, no manual upload.' },
              ]).map((item, i) => (
                <div key={item.step} className="relative flex md:flex-col items-start md:items-center md:text-center gap-4 px-4">
                  <div className="relative shrink-0">
                    <div className="w-14 h-14 rounded-2xl bg-[#1a1a1a] border border-[#D1FE17]/20 flex items-center justify-center shadow-[0_0_30px_rgba(209,254,23,0.08)]">
                      {item.icon}
                    </div>
                    {/* Step number badge */}
                    <span className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-[#D1FE17] text-black text-[9px] font-black flex items-center justify-center shadow-sm">
                      {i + 1}
                    </span>
                  </div>
                  <div>
                    <h3 className="text-white font-black text-base mb-1.5">{item.title}</h3>
                    <p className="text-white/40 text-sm leading-relaxed">{item.desc}</p>
                  </div>
                </div>
              ))}
            </div>

            {/* USP grid — why this is unique */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-10">
              {([
                { icon: <Trophy className="w-5 h-5" />,     title: "World's first",    desc: 'The only AI clipper with built-in 10-platform social auto-post' },
                { icon: <LayoutGrid className="w-5 h-5" />, title: '10 platforms',     desc: 'Instagram · TikTok · YouTube · X · Facebook · LinkedIn + 4 more' },
                { icon: <FileText className="w-5 h-5" />,   title: 'AI captions',      desc: 'Platform-specific viral captions written automatically for every clip' },
                { icon: <Zap className="w-5 h-5" />,        title: 'Zero extra clicks', desc: 'Clip generated = already posted. No manual upload, no app switching.' },
              ]).map(u => (
                <div
                  key={u.title}
                  className="relative group bg-gradient-to-b from-[#1a1a1a] to-[#141414] border border-white/8 hover:border-[#D1FE17]/25 rounded-2xl p-4 text-center transition-all duration-200 hover:-translate-y-1"
                >
                  <div className="absolute inset-0 rounded-2xl bg-[#D1FE17]/0 group-hover:bg-[#D1FE17]/3 transition-colors pointer-events-none" />
                  <div className="w-10 h-10 rounded-2xl bg-[#D1FE17]/10 border border-[#D1FE17]/15 flex items-center justify-center mb-3 text-[#D1FE17] mx-auto group-hover:bg-[#D1FE17]/15 transition-colors">
                    {u.icon}
                  </div>
                  <p className="text-white font-black text-sm mb-1">{u.title}</p>
                  <p className="text-white/35 text-[11px] leading-snug">{u.desc}</p>
                </div>
              ))}
            </div>

            {/* CTA */}
            <div className="text-center">
              {isSignedIn ? (
                <Link
                  href="/social"
                  className="inline-flex items-center gap-2.5 bg-[#D1FE17] text-black text-sm font-black px-8 py-4 rounded-2xl hover:bg-[#c5f010] active:scale-95 transition-all shadow-[0_0_50px_rgba(209,254,23,0.3)]"
                >
                  <Share2 className="w-4 h-4" /> Connect social accounts
                </Link>
              ) : (
                <Link
                  href="/signup"
                  className="inline-flex items-center gap-2.5 bg-[#D1FE17] text-black text-sm font-black px-8 py-4 rounded-2xl hover:bg-[#c5f010] active:scale-95 transition-all shadow-[0_0_50px_rgba(209,254,23,0.3)]"
                >
                  <Zap className="w-4 h-4" /> Get started — it's free
                </Link>
              )}
              <p className="text-white/25 text-xs mt-3">Free with all plans · No extra charge</p>
            </div>

          </div>
        </section>
      )}

      {/* ── Auto-Pilot showcase — set it once, it posts every day ─────────── */}
      {phase === 'idle' && !isSignedIn && (
        <section id="autopilot" className="relative py-16 pb-24 px-4 sm:px-6 overflow-hidden">
          {/* Ambient lime glow behind the whole section */}
          <div className="absolute top-1/3 left-1/2 -translate-x-1/2 w-[640px] h-[420px] bg-[#D1FE17]/[0.05] blur-[120px] rounded-full pointer-events-none" />
          <div className="relative max-w-5xl mx-auto">
            <p className="text-center text-[#D1FE17] text-xs font-black uppercase tracking-[0.25em] mb-3 flex items-center justify-center gap-2">
              <Rocket className="w-3.5 h-3.5" />Auto-Pilot
            </p>
            <h2 className="text-3xl sm:text-4xl font-black text-center leading-tight">
              Set it once. <span className="text-[#D1FE17]">It posts every day.</span>
            </h2>
            <p className="text-center text-white/35 text-sm sm:text-base mt-3 mb-12 max-w-xl mx-auto">
              Paste one video link — Auto-Pilot cuts it into clips, writes a caption for
              every post, and publishes them to your accounts on schedule. Your channels
              stay active while you sleep.
            </p>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-10 md:gap-12 items-center">
              {/* Left: the pitch */}
              <div className="space-y-6">
                {[
                  { icon: <Link2 className="w-5 h-5" />, title: 'Drop one link — or a whole folder', desc: 'A YouTube, Kick or Twitch video, or a Drive/Dropbox folder of ready videos. Auto-Pilot takes it from there.' },
                  { icon: <CalendarDays className="w-5 h-5" />, title: 'Pick the days & posting time', desc: 'Every day at 7:30 PM for the next month? Two taps. Pause or resume any time.' },
                  { icon: <Sparkles className="w-5 h-5" />, title: 'AI clips, captions & posts — hands-free', desc: 'Each post gets its own AI-written viral caption, then goes out automatically to TikTok, Reels & Shorts.' },
                ].map(s => (
                  <div key={s.title} className="flex items-start gap-4">
                    <div className="w-11 h-11 shrink-0 rounded-2xl bg-[#D1FE17] text-black flex items-center justify-center shadow-[0_10px_30px_-8px_rgba(209,254,23,0.5)]">
                      {s.icon}
                    </div>
                    <div>
                      <h3 className="text-white text-base sm:text-lg font-black">{s.title}</h3>
                      <p className="text-white/45 text-sm leading-relaxed mt-1">{s.desc}</p>
                    </div>
                  </div>
                ))}
                <div className="flex flex-wrap items-center gap-4 pt-2">
                  <Link
                    href="/signup?next=%2Fautopilot"
                    className="inline-flex items-center gap-2 bg-[#D1FE17] text-black text-[15px] font-black px-6 py-3 rounded-2xl hover:bg-[#c5f010] active:scale-95 transition-all shadow-[0_0_30px_rgba(209,254,23,0.3)]"
                  >
                    <Rocket className="w-4 h-4" />Start Auto-Pilot free
                  </Link>
                  <span className="text-white/30 text-xs font-semibold">Free credits on signup · no card needed</span>
                </div>
              </div>

              {/* Right: mock campaign card — what running on Auto-Pilot looks like */}
              <div className="relative">
                <div className="absolute -inset-4 bg-[#D1FE17]/[0.07] blur-3xl rounded-full pointer-events-none" />
                <div className="relative rounded-3xl p-px bg-gradient-to-b from-[#D1FE17]/50 via-white/10 to-white/5">
                  <div className="rounded-[calc(1.5rem-1px)] bg-gradient-to-b from-[#151a0b] via-[#111111] to-[#0e0e0e] p-5 sm:p-6">
                    <div className="flex items-center justify-between gap-3 mb-4">
                      <div className="flex items-center gap-3 min-w-0">
                        <div className="w-10 h-10 shrink-0 rounded-xl bg-[#D1FE17] text-black flex items-center justify-center shadow-[0_0_20px_rgba(209,254,23,0.35)]">
                          <Rocket className="w-5 h-5" />
                        </div>
                        <div className="min-w-0">
                          <p className="text-white font-black text-sm truncate">Gaming channel — daily shorts</p>
                          <p className="text-white/35 text-[11px] font-semibold mt-0.5">1 link → 8 clips · posts daily 7:30 PM</p>
                        </div>
                      </div>
                      <div className="w-11 h-6 rounded-full bg-[#D1FE17] relative shrink-0" title="Auto-Pilot is on">
                        <span className="absolute right-0.5 top-0.5 w-5 h-5 rounded-full bg-black" />
                      </div>
                    </div>
                    <div className="flex flex-wrap gap-1.5 mb-4">
                      {['TikTok', 'Reels', 'Shorts'].map(p => (
                        <span key={p} className="px-2.5 py-1 rounded-full bg-white/[0.06] border border-white/10 text-white/60 text-[11px] font-bold">{p}</span>
                      ))}
                      <span className="px-2.5 py-1 rounded-full bg-[#D1FE17]/10 border border-[#D1FE17]/30 text-[#D1FE17] text-[11px] font-black flex items-center gap-1">
                        <Sparkles className="w-3 h-3" />AI captions
                      </span>
                    </div>
                    <div className="grid grid-cols-7 gap-1.5 mb-4">
                      {(['M', 'T', 'W', 'T', 'F', 'S', 'S'] as const).map((d, i) => (
                        <div
                          key={i}
                          className={`h-12 rounded-xl flex flex-col items-center justify-center gap-1 border ${
                            i < 4 ? 'bg-[#D1FE17]/[0.08] border-[#D1FE17]/25' : 'bg-white/[0.03] border-white/[0.06]'
                          }`}
                        >
                          <span className="text-[9px] font-black text-white/30">{d}</span>
                          {i < 4 ? (
                            <Check className="w-3.5 h-3.5 text-[#D1FE17]" strokeWidth={3} />
                          ) : i === 4 ? (
                            <span className="w-2 h-2 rounded-full bg-[#D1FE17] animate-pulse" />
                          ) : (
                            <span className="w-1.5 h-1.5 rounded-full bg-white/15" />
                          )}
                        </div>
                      ))}
                    </div>
                    <div className="flex items-center justify-between text-[11px] font-bold">
                      <span className="text-white/40 flex items-center gap-1.5">
                        <span className="w-1.5 h-1.5 rounded-full bg-[#D1FE17] animate-pulse" />4 posted this week
                      </span>
                      <span className="text-[#D1FE17]">Next post today · 7:30 PM</span>
                    </div>
                  </div>
                </div>
                {/* Floating "posted" toast */}
                <div className="absolute -bottom-5 right-2 sm:-right-4 rounded-2xl border border-white/10 bg-[#161616]/95 backdrop-blur px-3.5 py-2.5 shadow-2xl shadow-black/60 flex items-center gap-2.5">
                  <span className="w-7 h-7 rounded-lg bg-[#D1FE17] text-black flex items-center justify-center">
                    <Check className="w-4 h-4" strokeWidth={3} />
                  </span>
                  <div>
                    <p className="text-white text-[11px] font-black leading-tight">Posted to TikTok</p>
                    <p className="text-white/35 text-[10px] font-semibold">while you were sleeping 😴</p>
                  </div>
                </div>
              </div>
            </div>

            {/* Quick stats strip */}
            <div className="mt-16 grid grid-cols-2 md:grid-cols-4 gap-3">
              {[
                { icon: <Link2 className="w-4 h-4" />, t: '1 link in', d: 'up to 10 clips out' },
                { icon: <PenLine className="w-4 h-4" />, t: 'AI captions', d: 'written for every post' },
                { icon: <CalendarDays className="w-4 h-4" />, t: 'Posts daily', d: 'weeks planned ahead' },
                { icon: <Share2 className="w-4 h-4" />, t: 'TikTok · IG · YT', d: 'all from one place' },
              ].map(x => (
                <div key={x.t} className="rounded-2xl border border-white/[0.07] bg-white/[0.03] px-4 py-3.5 flex items-center gap-3">
                  <span className="w-9 h-9 shrink-0 rounded-xl bg-[#D1FE17]/10 border border-[#D1FE17]/25 text-[#D1FE17] flex items-center justify-center">
                    {x.icon}
                  </span>
                  <div className="min-w-0">
                    <p className="text-white text-sm font-black truncate">{x.t}</p>
                    <p className="text-white/35 text-[11px] font-semibold truncate">{x.d}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>
      )}

      {/* ── Full pricing section with INR UPI checkout ─────────────────────── */}
      {phase === 'idle' && !isSignedIn && (
        <section id="pricing" className="py-10 pb-16 px-4 sm:px-6">
          <div className="max-w-5xl mx-auto">
            <p className="text-center text-[#D1FE17] text-xs font-black uppercase tracking-[0.25em] mb-3">Pricing</p>
            <h2 className="text-3xl sm:text-4xl font-black text-center leading-tight mb-3">
              Simple pricing. <span className="text-[#D1FE17]">Viral results.</span>
            </h2>
            <p className="text-center text-white/35 text-sm sm:text-base mb-10 max-w-lg mx-auto">
              Separate cutting credits and uploads included. Pick a plan or top up any time.
            </p>
            <Suspense fallback={null}>
              <PricingCards initialInterval="yearly" signupNext="/pricing" />
            </Suspense>
          </div>
        </section>
      )}

      {/* ── FAQ ───────────────────────────────────────────────────────────── */}
      {phase === 'idle' && !isSignedIn && <FaqSection />}

      {/* ── Refer & earn banner ───────────────────────────────────────────── */}
      {phase === 'idle' && !isSignedIn && (
        <section id="refer" className="py-6 pb-20 px-4 sm:px-6">
          <div className="max-w-5xl mx-auto relative overflow-hidden bg-gradient-to-br from-[#D1FE17]/15 via-[#161616] to-[#161616] border border-[#D1FE17]/25 rounded-3xl p-8 sm:p-10 text-center">
            <div className="absolute -top-24 -right-24 w-64 h-64 bg-[#D1FE17]/10 rounded-full blur-3xl pointer-events-none" />
            <div className="inline-flex items-center gap-2 bg-[#D1FE17]/10 border border-[#D1FE17]/25 rounded-full px-4 py-1.5 mb-4">
              <Gift className="w-3.5 h-3.5 text-[#D1FE17]" />
              <span className="text-[#D1FE17] text-xs font-black uppercase tracking-widest">Refer &amp; earn</span>
            </div>
            <h2 className="text-3xl sm:text-4xl font-black leading-tight">
              Refer a friend, get a <span className="text-[#D1FE17]">cutting-credit reward</span>
            </h2>
            <p className="text-white/45 text-sm sm:text-base mt-3 max-w-xl mx-auto">
              Share your link — when your friend buys any plan, your referral reward is added automatically.
              No limit, refer as many friends as you like.
            </p>
            <Link
              href={isSignedIn ? '/account' : '/signup'}
              className="inline-flex items-center gap-2 bg-[#D1FE17] text-black font-black px-7 py-3.5 rounded-full hover:bg-[#c2ef0e] active:scale-95 transition-all mt-6"
            >
              <Gift className="w-4 h-4" />
              {isSignedIn ? 'Get your referral link' : 'Sign up & get your link'}
            </Link>
          </div>
        </section>
      )}


      {/* ── Footer ────────────────────────────────────────────────────────── */}
      {!isSignedIn && <Footer />}
    </div>
  );
}
