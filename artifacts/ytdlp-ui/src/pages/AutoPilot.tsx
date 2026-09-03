/**
 * Auto-Pilot — reusable posting campaigns.
 *
 * Paste a public Google Drive folder once → every video inside is detected →
 * pick accounts, a date range and posting times (one video per time) → the
 * campaign posts them by itself, day after day, until the folder or the date
 * range runs out. Campaigns can be paused/resumed any time; pausing cancels
 * queued posts and puts their videos back in line.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'wouter';
import {
  AlertCircle, CalendarClock, CheckCircle2, ChevronDown, FolderOpen, Loader2,
  Pause, Pencil, Play, Plus, RefreshCw, Rocket, Share2, Sparkles, Trash2, X,
} from 'lucide-react';
import { apiFetch, useAuth } from '../lib/auth';
import { resolveKickHint } from '../lib/clipJob';
import { AppHeader } from '../components/AppHeader';
import { PlatformIcon, PLATFORM_META } from '../components/PlatformIcons';
import { SourceBrandRow } from '../components/SourceBrandIcons';


// ── Types ─────────────────────────────────────────────────────────────────────
interface SocialAccount {
  id: string; type: string; name: string;
  username?: string; avatarUrl?: string;
}
type CampaignState = 'running' | 'upcoming' | 'paused' | 'exhausted' | 'ended' | 'warning';
interface Campaign {
  id: string; name: string; sourceUrl: string; accountIds: string[];
  times: string[]; perSlot: number; startDate: string; endDate: string;
  timezone: string; caption: string; aiCaptions?: boolean; enabled: boolean;
  sourceKind?: 'folder' | 'clip_link' | 'instagram' | 'tiktok'; clipStatus?: 'clipping' | 'ready' | 'failed' | null;
  clipParams?: { clipCount?: number; quality?: string; prompt?: string } | null;
  leadMinutes?: number | null;
  lastError: string | null; createdAt: string;
  state: CampaignState;
  totalVideos: number; usedVideos: number;
  posted: number; failed: number; upcoming: number;
  nextAt: string | null; daysLeft: number;
}

interface CampaignPost {
  id: string; fileName: string; caption: string; postAt: string | null;
  status: string; error: string | null; platforms: string[];
}

const fmtAt = (iso: string | Date) =>
  new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const fmtDate = (ymd: string) => {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(y, (m ?? 1) - 1, d ?? 1).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
};
const inclusiveDays = (start: string, end: string): number => {
  const [y1, m1, d1] = start.split('-').map(Number);
  const [y2, m2, d2] = end.split('-').map(Number);
  if (!y1 || !y2) return 0;
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86_400_000) + 1;
};
const plusDays = (ymd: string, days: number): string => {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
};
const sameSet = (a: string[], b: string[]): boolean => {
  if (a.length !== b.length) return false;
  const x = [...a].sort(), y = [...b].sort();
  return x.every((v, i) => v === y[i]);
};

// ── State chip ────────────────────────────────────────────────────────────────
function StateChip({ c }: { c: Campaign }) {
  const base = 'text-[10px] font-black uppercase tracking-wider px-2 py-1 rounded-lg';
  switch (c.state) {
    case 'running':
      return <span className={`${base} text-black bg-[#D1FE17]`}>On air</span>;
    case 'upcoming':
      return <span className={`${base} text-[#D1FE17] bg-[#D1FE17]/10`}>Starts {fmtDate(c.startDate)}</span>;
    case 'paused':
      return <span className={`${base} text-white/40 bg-white/5`}>Paused</span>;
    case 'exhausted':
      return <span className={`${base} text-[#D1FE17]/80 bg-[#D1FE17]/10`}>Folder done</span>;
    case 'ended':
      return <span className={`${base} text-white/30 bg-white/5`}>Ended</span>;
    default:
      return <span className={`${base} text-amber-300 bg-amber-500/10`}>Needs attention</span>;
  }
}

// ── Page shell ────────────────────────────────────────────────────────────────
export default function AutoPilotPage() {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div className="min-h-screen bg-[#0d0d0d] text-white font-sans">
        <AppHeader />
        <div className="flex justify-center py-24"><Loader2 className="w-6 h-6 animate-spin text-white/30" /></div>
      </div>
    );
  }
  if (!user) {
    return (
      <div className="min-h-screen bg-[#0d0d0d] text-white font-sans">
        <AppHeader />
        <div className="text-center py-24 px-4">
          <div className="w-14 h-14 mx-auto mb-4 rounded-2xl bg-white/[0.05] border border-white/10 flex items-center justify-center">
            <Rocket className="w-6 h-6 text-white/30" />
          </div>
          <p className="text-white/70 font-bold">Sign in to use Auto-Pilot</p>
          <p className="text-white/40 text-sm mt-1 mb-6">A Drive folder that posts itself — on your schedule.</p>
          <Link href="/login" className="inline-block bg-[#D1FE17] text-black text-sm font-black px-6 py-3 rounded-xl hover:bg-[#c5f010] transition-colors">Sign in</Link>
        </div>
      </div>
    );
  }
  return <AutoPilotView />;
}

// ── Main view ─────────────────────────────────────────────────────────────────
function AutoPilotView() {
  // Connected accounts (same source as the Schedule page)
  const [accounts, setAccounts] = useState<SocialAccount[]>([]);
  const [accountsReady, setAccountsReady] = useState(false);
  useEffect(() => {
    let stale = false;
    (async () => {
      try {
        const s = await apiFetch<{ hasAccounts: boolean }>('/social/status');
        if (stale) return;
        if (s.hasAccounts) {
          const d = await apiFetch<{ accounts: {
            id: string; platform: string; username?: string | null;
            displayName?: string | null; profileImage?: string | null; status: string;
          }[] }>('/social/accounts');
          if (stale) return;
          setAccounts(d.accounts.filter(a => a.status === 'connected').map(a => ({
            id: a.id,
            type: (a.platform || '').toUpperCase(),
            name: a.displayName || a.username || a.platform,
            username: a.username ?? undefined,
            avatarUrl: a.profileImage ?? undefined,
          })));
        }
        setAccountsReady(true);
      } catch { if (!stale) setAccountsReady(true); }
    })();
    return () => { stale = true; };
  }, []);

  // Campaign list
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [listLoading, setListLoading] = useState(true);
  const loadList = useCallback(async () => {
    try {
      const d = await apiFetch<{ campaigns: Campaign[] }>('/social/campaigns');
      setCampaigns(d.campaigns);
    } catch { /* keep current list */ }
    setListLoading(false);
  }, []);
  useEffect(() => { void loadList(); }, [loadList]);

  // Soft refresh while anything is live
  const anyLive = campaigns.some(c => c.enabled && (c.state === 'running' || c.state === 'warning' || c.state === 'upcoming'));
  useEffect(() => {
    if (!anyLive) return;
    const t = setInterval(() => { void loadList(); }, 30_000);
    return () => clearInterval(t);
  }, [anyLive, loadList]);

  // While any link campaign is still generating clips, poll the list — the
  // server heals job→campaign races on every GET, so the card flips to
  // ready/failed on its own without a manual refresh.
  const anyClipping = campaigns.some(c => c.clipStatus === 'clipping');
  useEffect(() => {
    if (!anyClipping) return;
    const t = setInterval(() => { void loadList(); }, 15_000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anyClipping]);

  const [banner, setBanner] = useState<{ kind: 'success' | 'error'; msg: string } | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Campaign | null>(null);
  const [retryingPostsId, setRetryingPostsId] = useState<string | null>(null);

  async function toggle(c: Campaign) {
    setBanner(null);
    try {
      const r = await apiFetch<{ ok: boolean; cancelled?: number }>(`/social/campaigns/${c.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ enabled: !c.enabled }),
      });
      if (!c.enabled) {
        setBanner({ kind: 'success', msg: `"${c.name}" is back on — it resumes from today.` });
      } else {
        setBanner({ kind: 'success', msg: `"${c.name}" paused${r.cancelled ? ` — ${r.cancelled} upcoming post${r.cancelled === 1 ? '' : 's'} cancelled` : ''}. Videos stay in line for when you switch it back on.` });
      }
      void loadList();
    } catch (err) {
      setBanner({ kind: 'error', msg: (err as Error).message || 'Could not update the campaign.' });
    }
  }

  // "Try clips again" on a failed link campaign: start a fresh clip job with
  // the campaign's saved settings (older campaigns fall back to the form
  // defaults), then point the campaign at the new job — it goes right back to
  // "Making clips…" and posts on schedule the moment they land.
  const [retryingId, setRetryingId] = useState<string | null>(null);
  async function retryClips(c: Campaign) {
    if (retryingId) return;
    setBanner(null);
    setRetryingId(c.id);
    try {
      const kickHint = await resolveKickHint(c.sourceUrl);
      const j = await apiFetch<{ jobId?: string }>('/video/clip', {
        method: 'POST',
        body: JSON.stringify({
          url: c.sourceUrl,
          clipCount: c.clipParams?.clipCount ?? 5,
          platform: 'shorts',
          clipDuration: 30,
          quality: c.clipParams?.quality ?? 'quality',
          faceTrack: true,
          ...(c.clipParams?.prompt ? { prompt: c.clipParams.prompt } : {}),
          async: true,
          forCampaign: true,
          ...(kickHint ?? {}),
        }),
      });
      if (!j.jobId) throw new Error('The clip job did not start — try again.');
      await apiFetch(`/social/campaigns/${c.id}/retry-clip`, {
        method: 'POST',
        body: JSON.stringify({ jobId: j.jobId }),
      });
      setBanner({
        kind: 'success',
        msg: c.enabled
          ? `"${c.name}" is making clips again — posting starts on schedule the moment they're ready.`
          : `"${c.name}" is making clips again — switch it back on when you want posting to start.`,
      });
      void loadList();
    } catch (err) {
      setBanner({ kind: 'error', msg: (err as Error).message || 'Could not restart the clips — try again.' });
    }
    setRetryingId(null);
  }

  async function retryFailedPosts(c: Campaign) {
    if (retryingPostsId || c.failed === 0) return;
    setBanner(null);
    setRetryingPostsId(c.id);
    try {
      const result = await apiFetch<{ ok: boolean; retried: number }>(`/social/campaigns/${c.id}/retry-failed`, {
        method: 'POST',
      });
      setBanner({
        kind: 'success',
        msg: result.retried > 0
          ? `${result.retried} failed post${result.retried === 1 ? '' : 's'} rescheduled. They will post every 2 minutes.`
          : 'There are no failed posts left to reschedule.',
      });
      void loadList();
    } catch (err) {
      setBanner({ kind: 'error', msg: (err as Error).message || 'Could not reschedule the failed posts.' });
    } finally {
      setRetryingPostsId(null);
    }
  }

  async function remove(c: Campaign) {
    if (!window.confirm(`Delete "${c.name}"? Upcoming posts get cancelled; already-published posts stay live.`)) return;
    setBanner(null);
    try {
      await apiFetch(`/social/campaigns/${c.id}`, { method: 'DELETE' });
      setBanner({ kind: 'success', msg: `"${c.name}" deleted.` });
      if (editing?.id === c.id) { setEditing(null); setFormOpen(false); }
      void loadList();
    } catch (err) {
      setBanner({ kind: 'error', msg: (err as Error).message || 'Could not delete the campaign.' });
    }
  }

  return (
    <div className="min-h-screen bg-[#0d0d0d] text-white font-sans">
      <AppHeader />
      <main className="max-w-3xl mx-auto px-4 pb-24 pt-8">
        <div className="flex items-center gap-3 mb-2">
          <div className="w-10 h-10 rounded-xl bg-[#D1FE17]/10 flex items-center justify-center">
            <Rocket className="w-5 h-5 text-[#D1FE17]" />
          </div>
          <h1 className="text-2xl font-black">Auto-Pilot</h1>
        </div>
        <p className="text-white/40 text-sm mb-6">
          A folder — or one video we auto-clip — that posts itself. Pick accounts, dates and times once, then let it run.
        </p>

        {/* How it works */}
        <div className="grid grid-cols-3 gap-2 mb-8">
          {[
            { icon: FolderOpen, label: '1 · Paste a folder or video link' },
            { icon: Share2, label: '2 · Pick accounts & dates' },
            { icon: Rocket, label: '3 · It posts daily — done' },
          ].map((s, i) => (
            <div key={i} className="bg-[#161616] border border-white/[0.06] rounded-2xl px-3 py-3 text-center">
              <s.icon className="w-4 h-4 text-[#D1FE17] mx-auto mb-1.5" />
              <p className="text-[11px] font-bold text-white/60 leading-tight">{s.label}</p>
            </div>
          ))}
        </div>

        {banner && (
          <div className={`mb-4 rounded-2xl px-4 py-3 text-sm font-bold flex items-start gap-2.5 ${banner.kind === 'success' ? 'bg-[#D1FE17]/10 text-[#D1FE17]' : 'bg-red-500/10 text-red-300'}`}>
            {banner.kind === 'success' ? <CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0" /> : <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />}
            <span className="min-w-0">{banner.msg}</span>
          </div>
        )}

        {/* New / edit form */}
        {formOpen ? (
          <CampaignForm
            key={editing?.id ?? 'new'}
            accounts={accounts}
            accountsReady={accountsReady}
            editing={editing}
            onClose={() => { setFormOpen(false); setEditing(null); }}
            onSaved={(msg) => {
              setFormOpen(false); setEditing(null);
              setBanner({ kind: 'success', msg });
              void loadList();
            }}
          />
        ) : (
          <button
            type="button"
            onClick={() => { setEditing(null); setFormOpen(true); setBanner(null); }}
            className="w-full flex items-center justify-center gap-2 bg-[#D1FE17] text-black font-black py-4 rounded-2xl hover:bg-[#c5f010] active:scale-[0.99] transition-all mb-8"
          >
            <Plus className="w-4 h-4" /> New campaign
          </button>
        )}

        {/* Campaign list */}
        <h2 className="text-lg font-black mb-1 mt-2">Your campaigns</h2>
        <p className="text-white/35 text-xs mb-4">Each one runs on its own. Pause any time — nothing already published (or already uploaded to YouTube) is touched.</p>
        {listLoading ? (
          <div className="flex justify-center py-10"><Loader2 className="w-5 h-5 animate-spin text-white/30" /></div>
        ) : campaigns.length === 0 ? (
          <div className="bg-[#161616] border border-white/[0.06] rounded-2xl px-4 py-8 text-center">
            <p className="text-white/85 text-sm font-bold">No campaigns yet</p>
            <p className="text-white/60 text-xs mt-1">Create one above — paste a folder or a video link, set the dates, and it takes over.</p>
          </div>
        ) : (
          <div className="space-y-4">
            {campaigns.map(c => (
              <CampaignCard
                key={c.id}
                c={c}
                onToggle={() => void toggle(c)}
                onEdit={() => { setEditing(c); setFormOpen(true); setBanner(null); window.scrollTo({ top: 0, behavior: 'smooth' }); }}
                onDelete={() => void remove(c)}
                onRetryClips={c.sourceKind === 'clip_link' && c.clipStatus === 'failed' ? () => void retryClips(c) : undefined}
                retrying={retryingId === c.id}
                onRetryFailed={c.failed > 0 ? () => void retryFailedPosts(c) : undefined}
                retryingFailed={retryingPostsId === c.id}
              />
            ))}
          </div>
        )}
      </main>
    </div>
  );
}

// ── Per-post status chip ──────────────────────────────────────────────────────
/** Same semantics as the Schedule page: a 'scheduled' post whose time has
 *  passed was handed to the posting service and goes out — count it posted. */
function postDisplay(p: CampaignPost): { label: string; cls: string; live?: boolean } {
  const due = p.postAt ? new Date(p.postAt).getTime() <= Date.now() : false;
  switch (p.status) {
    case 'processing':
      return { label: 'Posting…', cls: 'text-black bg-[#D1FE17]', live: true };
    case 'queued':
    case 'creating':
      return due
        ? { label: 'Posting…', cls: 'text-black bg-[#D1FE17]', live: true }
        : { label: 'In line', cls: 'text-white/50 bg-white/[0.06]' };
    case 'scheduled': {
      if (!due) return { label: 'Scheduled', cls: 'text-white/50 bg-white/[0.06]' };
      // Time reached: the posting service is publishing right now. Show it as
      // live work for a grace window; the webhook flips it to 'posted' soon.
      const overdueMs = p.postAt ? Date.now() - new Date(p.postAt).getTime() : 0;
      return overdueMs < 15 * 60_000
        ? { label: 'Posting…', cls: 'text-black bg-[#D1FE17]', live: true }
        : { label: 'Posted', cls: 'text-[#D1FE17] bg-[#D1FE17]/10' };
    }
    case 'posted':
      return { label: 'Posted ✓', cls: 'text-[#D1FE17] bg-[#D1FE17]/10' };
    case 'failed':
      return { label: 'Failed', cls: 'text-red-300 bg-red-500/10' };
    case 'cancelled':
    case 'deleted':
      return { label: 'Cancelled', cls: 'text-white/30 bg-white/[0.04]' };
    default:
      return { label: p.status, cls: 'text-white/50 bg-white/[0.06]' };
  }
}

// ── Campaign card ─────────────────────────────────────────────────────────────
function CampaignCard({ c, onToggle, onEdit, onDelete, onRetryClips, retrying, onRetryFailed, retryingFailed }: {
  c: Campaign; onToggle: () => void; onEdit: () => void; onDelete: () => void;
  onRetryClips?: () => void; retrying?: boolean; onRetryFailed?: () => void; retryingFailed?: boolean;
}) {
  const pct = c.totalVideos > 0 ? Math.min(100, Math.round((c.usedVideos / c.totalVideos) * 100)) : 0;
  const perDay = c.times.length * c.perSlot;

  // Live per-post panel: fetched when opened, refreshed every 10s while open.
  const [postsOpen, setPostsOpen] = useState(false);
  const [posts, setPosts] = useState<CampaignPost[] | null>(null);
  const loadPosts = useCallback(async () => {
    try {
      const d = await apiFetch<{ posts: CampaignPost[] }>(`/social/campaigns/${c.id}/posts`);
      setPosts(d.posts);
    } catch { /* keep last snapshot */ }
  }, [c.id]);
  useEffect(() => {
    if (!postsOpen) return;
    void loadPosts();
    const t = setInterval(() => { void loadPosts(); }, 10_000);
    return () => clearInterval(t);
  }, [postsOpen, loadPosts]);
  return (
    <div className={`bg-[#161616] border rounded-3xl p-4 sm:p-5 ${c.enabled ? 'border-white/[0.07]' : 'border-white/[0.05] opacity-75'}`}>
      <div className="flex items-center gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <p className="text-sm font-black truncate">{c.name}</p>
            <StateChip c={c} />
            {c.sourceKind === 'clip_link' && c.clipStatus === 'clipping' && (
              <span className="text-[9px] font-black uppercase tracking-wider px-2 py-1 rounded-md text-amber-300 bg-amber-500/10 animate-pulse">
                🎬 Making clips…
              </span>
            )}
          </div>
          <p className="text-white/35 text-xs mt-1 truncate">
            {perDay}/day ({c.perSlot > 1 ? `${c.perSlot}× ` : ''}at {c.times.join(', ')}) · {fmtDate(c.startDate)} → {fmtDate(c.endDate)}
          </p>
        </div>
        {/* On/off switch */}
        <button
          type="button"
          onClick={onToggle}
          aria-label={c.enabled ? 'Pause campaign' : 'Resume campaign'}
          className={`shrink-0 relative w-12 h-7 rounded-full transition-colors ${c.enabled ? 'bg-[#D1FE17]' : 'bg-white/10'}`}
        >
          <span className={`absolute top-1 w-5 h-5 rounded-full bg-black/90 flex items-center justify-center transition-all ${c.enabled ? 'left-6' : 'left-1'}`}>
            {c.enabled
              ? <Play className="w-2.5 h-2.5 text-[#D1FE17]" />
              : <Pause className="w-2.5 h-2.5 text-white/40" />}
          </span>
        </button>
      </div>

      {/* Progress */}
      <div className="mt-4">
        <div className="flex items-center justify-between text-[11px] font-bold text-white/40 mb-1.5">
          <span>
            {c.sourceKind === 'clip_link' && c.clipStatus === 'clipping'
              ? 'Clips are being made — posting starts the moment they land'
              : <>{c.usedVideos} / {c.totalVideos} videos used</>}
          </span>
          <span className="tabular-nums">{pct}%</span>
        </div>
        <div className="h-2 rounded-full bg-white/[0.06] overflow-hidden">
          <div className="h-full rounded-full bg-[#D1FE17] transition-all" style={{ width: `${pct}%` }} />
        </div>
        <div className={`mt-3 grid gap-2 ${c.failed > 0 ? 'grid-cols-3' : 'grid-cols-2'}`}>
          <div className="bg-[#0f0f0f] rounded-xl px-3 py-2">
            <p className="text-base font-black text-[#D1FE17] tabular-nums leading-none">{c.posted}</p>
            <p className="text-[9px] font-black uppercase tracking-wider text-white/30 mt-1">Posted</p>
          </div>
          <div className="bg-[#0f0f0f] rounded-xl px-3 py-2">
            <p className="text-base font-black text-white/80 tabular-nums leading-none">{c.upcoming}</p>
            <p className="text-[9px] font-black uppercase tracking-wider text-white/30 mt-1">Queued</p>
          </div>
          {c.failed > 0 && (
            <div className="bg-red-500/[0.06] rounded-xl px-3 py-2">
              <p className="text-base font-black text-red-300 tabular-nums leading-none">{c.failed}</p>
              <p className="text-[9px] font-black uppercase tracking-wider text-red-300/50 mt-1">Failed</p>
            </div>
          )}
        </div>
        {onRetryFailed && (
          <button
            type="button"
            onClick={onRetryFailed}
            disabled={retryingFailed}
            className="mt-2.5 w-full flex items-center justify-center gap-1.5 bg-red-500/10 border border-red-400/20 text-red-200 text-[11px] font-black px-3 py-2.5 rounded-lg hover:bg-red-500/15 active:scale-[0.99] disabled:opacity-60 transition-all"
          >
            {retryingFailed ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
            {retryingFailed ? 'Rescheduling failed posts…' : `Retry all ${c.failed} failed post${c.failed === 1 ? '' : 's'}`}
          </button>
        )}
      </div>

      {/* Next run / warnings */}
      <div className="mt-3 flex items-center justify-between gap-2 flex-wrap">
        <p className="text-white/35 text-[11px]">
          {c.state === 'running' && c.nextAt && <>Next post {fmtAt(c.nextAt)} · {c.daysLeft} day{c.daysLeft === 1 ? '' : 's'} left</>}
          {c.state === 'upcoming' && c.nextAt && <>First post {fmtAt(c.nextAt)}</>}
          {c.state === 'exhausted' && (c.sourceKind === 'clip_link'
            ? <>Every clip from this video is posted or queued.</>
            : <>Every detected video is posted or queued. Add videos to the folder and it re-checks when resumed.</>)}
          {c.state === 'ended' && <>Date range finished {fmtDate(c.endDate)}.</>}
          {c.state === 'paused' && <>Paused — flip the switch to resume from today.</>}
        </p>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => setPostsOpen(o => !o)}
            className={`text-[11px] font-black px-2 py-1.5 rounded-lg transition-colors flex items-center gap-1 ${postsOpen ? 'text-[#D1FE17] bg-[#D1FE17]/10' : 'text-white/40 hover:text-white/70 hover:bg-white/5'}`}
          >
            <ChevronDown className={`w-3 h-3 transition-transform ${postsOpen ? 'rotate-180' : ''}`} />
            {postsOpen ? 'Hide posts' : 'Live status'}
          </button>
          <Link href="/schedule" className="text-[11px] font-black text-white/40 hover:text-white/70 px-2 py-1.5 rounded-lg hover:bg-white/5 transition-colors flex items-center gap-1">
            <CalendarClock className="w-3 h-3" /> Calendar
          </Link>
          <button type="button" onClick={onEdit} aria-label="Edit campaign"
            className="w-7 h-7 flex items-center justify-center rounded-lg text-white/30 hover:text-white hover:bg-white/5 transition-colors">
            <Pencil className="w-3.5 h-3.5" />
          </button>
          <button type="button" onClick={onDelete} aria-label="Delete campaign"
            className="w-7 h-7 flex items-center justify-center rounded-lg text-white/30 hover:text-red-300 hover:bg-white/5 transition-colors">
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {c.lastError && (
        <div className="mt-2 text-[11px] font-bold text-amber-300/90 bg-amber-500/[0.07] border border-amber-500/15 rounded-xl px-3 py-2">
          {c.lastError}
          {onRetryClips && (
            <button
              type="button"
              onClick={onRetryClips}
              disabled={retrying}
              className="mt-2.5 w-full flex items-center justify-center gap-1.5 bg-[#D1FE17] text-black text-[11px] font-black px-3 py-2.5 rounded-lg hover:bg-[#c5f010] active:scale-[0.99] disabled:opacity-60 transition-all"
            >
              {retrying ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
              {retrying ? 'Starting the clip job…' : 'Try clips again'}
            </button>
          )}
        </div>
      )}

      {/* Live per-post status (auto-refreshes every 10s while open) */}
      {postsOpen && (
        <div className="mt-3 pt-3 border-t border-white/[0.06]">
          {posts === null ? (
            <div className="flex justify-center py-4"><Loader2 className="w-4 h-4 animate-spin text-white/30" /></div>
          ) : posts.length === 0 ? (
            <p className="text-white/30 text-[11px] text-center py-3">
              No posts prepared yet — the first batch appears here when its time slot gets planned.
            </p>
          ) : (
            <div className="space-y-1.5 max-h-72 overflow-y-auto pr-1">
              {posts.map(p => {
                const d = postDisplay(p);
                return (
                  <div key={p.id} className={`bg-[#0f0f0f] rounded-xl px-3 py-2 ${d.label === 'Cancelled' ? 'opacity-50' : ''}`}>
                    <div className="flex items-center gap-2.5">
                      <span className={`shrink-0 text-[9px] font-black uppercase tracking-wider px-2 py-1 rounded-md ${d.cls} ${d.live ? 'animate-pulse' : ''}`}>
                        {d.label}
                      </span>
                      <p
                        title={p.caption || p.fileName || 'Video'}
                        className={`flex-1 min-w-0 text-xs font-bold truncate ${d.label === 'Cancelled' ? 'line-through text-white/40' : ''}`}
                      >
                        {p.caption || p.fileName || 'Video'}
                      </p>
                      {(p.platforms ?? []).length > 0 && (
                        <span className="shrink-0 flex items-center gap-1" aria-label={`Posting to ${p.platforms.join(', ')}`}>
                          {p.platforms.slice(0, 6).map(pf => <PlatformIcon key={pf} type={pf} size={14} />)}
                        </span>
                      )}
                      {p.postAt && (
                        <span className="shrink-0 text-[10px] font-bold text-white/30">{fmtAt(p.postAt)}</span>
                      )}
                    </div>
                    {p.status === 'failed' && p.error && (
                      <p className="mt-1 ml-0.5 text-[10px] font-bold text-red-300/80 truncate">{p.error}</p>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Create / edit form ────────────────────────────────────────────────────────
function CampaignForm({ accounts, accountsReady, editing, onClose, onSaved }: {
  accounts: SocialAccount[];
  accountsReady: boolean;
  editing: Campaign | null;
  onClose: () => void;
  onSaved: (msg: string) => void;
}) {
  const timezone = useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone, []);
  const today = useMemo(() => new Date().toISOString().slice(0, 10), []);

  const [name, setName] = useState(editing?.name ?? '');
  const [source, setSource] = useState(editing?.sourceUrl ?? '');
  const [sourceKind, setSourceKind] = useState<'folder' | 'clip_link' | 'instagram' | 'tiktok'>(
    editing?.sourceKind === 'clip_link' ? 'clip_link' : editing?.sourceKind === 'instagram' ? 'instagram' : editing?.sourceKind === 'tiktok' ? 'tiktok' : 'folder',
  );
  const [clipCount, setClipCount] = useState(5);
  const [clipQuality, setClipQuality] = useState<'fast' | 'quality'>('quality');
  const [clipPrompt, setClipPrompt] = useState(editing?.clipParams?.prompt ?? '');
  const [detect, setDetect] = useState<{ count: number; names: string[] } | null>(
    editing ? { count: editing.totalVideos, names: [] } : null,
  );
  const [detecting, setDetecting] = useState(false);
  const [backlogLimit, setBacklogLimit] = useState(''); // '' = post all past videos
  const [selectedIds, setSelectedIds] = useState<string[]>(
    editing ? editing.accountIds.filter(id => accounts.some(a => a.id === id)) : accounts.map(a => a.id),
  );
  const [startDate, setStartDate] = useState(editing?.startDate ?? today);
  const [endDate, setEndDate] = useState(editing?.endDate ?? plusDays(today, 9));
  const [times, setTimes] = useState<string[]>(editing?.times ?? ['16:00']);
  // "Schedule ahead": how long before each posting time the video is uploaded
  // to YouTube as a native scheduled video (private + publishAt — visible in
  // YT Studio). null = hand off as soon as the day is planned; the provider
  // holds it and publishes at the slot.
  const leadPresets: { label: string; v: number | null }[] = [
    { label: 'Right away', v: null },
    { label: '10 min before', v: 10 },
    { label: '30 min before', v: 30 },
    { label: '1 hour before', v: 60 },
    { label: '3 hours before', v: 180 },
  ];
  const initLead = editing?.leadMinutes ?? null;
  const initLeadIsCustom = initLead !== null && !leadPresets.some(p => p.v === initLead);
  const [leadMin, setLeadMin] = useState<number | null>(initLead);
  const [leadCustom, setLeadCustom] = useState(initLeadIsCustom);
  const [leadCustomStr, setLeadCustomStr] = useState(initLeadIsCustom ? String(initLead) : '');
  const nextTimeCandidate = (ts: string[]): string | null => {
    const candidates = ['12:00', '18:00', '09:00', '20:00', '15:00', '21:00', '08:00', '11:00', '14:00', '17:00', '19:00', '10:00'];
    const found = candidates.find(x => !ts.includes(x));
    if (found) return found;
    for (let h = 0; h < 24; h++) {
      const cand = `${String(h).padStart(2, '0')}:30`;
      if (!ts.includes(cand)) return cand;
    }
    return null;
  };
  const addTime = () => {
    setTimes(ts => {
      if (ts.length >= 12) return ts;
      const next = nextTimeCandidate(ts);
      return next ? [...ts, next].sort() : ts;
    });
  };
  // One clip = one posting time: on the clip tab the clip count and the
  // number of times move together, so a 3-clip campaign always has exactly
  // 3 times — one clip posts at each. Also dedupes (a duplicate time would
  // silently shrink the schedule below the clip count).
  const syncTimesToCount = (count: number) => {
    setTimes(ts => {
      const next = [...new Set(ts)];
      while (next.length > count) next.pop();
      while (next.length < count) {
        const cand = nextTimeCandidate(next);
        if (!cand) break;
        next.push(cand);
      }
      return next.sort();
    });
  };
  const changeClipCount = (updater: (n: number) => number) => {
    const v = Math.min(12, Math.max(1, Math.floor(updater(clipCount))));
    setClipCount(v);
    syncTimesToCount(v);
  };
  // Strict pairing (one clip = one posting time) on the clip tab: creating
  // follows the clip-count stepper; editing an existing clip campaign locks
  // the schedule to its stored clip count (the server rejects mismatches).
  // null = free editing — folder/Instagram tabs, or legacy clip rows without
  // stored params / counts beyond the 12-time cap.
  const storedClipCount = editing?.clipParams?.clipCount ?? 0;
  const pairCount =
    sourceKind !== 'clip_link' ? null
    : !editing ? clipCount
    : Number.isInteger(storedClipCount) && storedClipCount >= 1 && storedClipCount <= 12 ? storedClipCount
    : null;
  // Keep the times list in lockstep whenever the pairing target changes
  // (tab switch, clip-count change, edit form opening on a clip campaign).
  useEffect(() => {
    if (pairCount !== null) syncTimesToCount(pairCount);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pairCount]);
  const [captionMode, setCaptionMode] = useState<'filename' | 'custom' | 'ai'>(
    editing?.aiCaptions ? 'ai' : editing?.caption ? 'custom' : 'filename',
  );
  const [customCaption, setCustomCaption] = useState(editing?.caption ?? '');
  const [aiWriting, setAiWriting] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Accounts can land after the form opens (fresh page load → Edit click).
  useEffect(() => {
    if (accounts.length === 0) return;
    setSelectedIds(prev => {
      if (prev.length > 0) return prev;
      return editing
        ? editing.accountIds.filter(id => accounts.some(a => a.id === id))
        : accounts.map(a => a.id);
    });
  }, [accounts, editing]);

  async function runDetect() {
    if (!source.trim() || detecting) return;
    setDetecting(true);
    setError(null);
    setDetect(null);
    try {
      const r = await apiFetch<{ count: number; names: string[] }>('/social/campaigns/detect', {
        method: 'POST',
        body: JSON.stringify({ source: source.trim(), sourceKind }),
      });
      setDetect({ count: r.count, names: r.names });
    } catch (err) {
      setError((err as Error).message || 'Could not read that folder.');
    }
    setDetecting(false);
  }

  // One AI draft into the custom-caption box (user can edit before saving).
  async function aiDraft() {
    if (aiWriting) return;
    setAiWriting(true);
    setError(null);
    try {
      const r = await apiFetch<{ caption: string }>('/social/caption-ai', {
        method: 'POST',
        body: JSON.stringify({ hint: customCaption.trim() || name.trim() || 'a short viral video' }),
      });
      setCustomCaption(r.caption);
    } catch (err) {
      setError((err as Error).message || 'AI caption failed — try again.');
    }
    setAiWriting(false);
  }

  const perDay = times.length; // one video per posting time
  const days = inclusiveDays(startDate, endDate);
  const capacity = perDay * Math.max(0, days);
  const plan = detect && days > 0 ? {
    toPost: Math.min(detect.count, capacity),
    leftover: Math.max(0, detect.count - capacity),
  } : null;

  async function submit() {
    if (submitting) return;
    setError(null);
    if (!source.trim()) {
      setError(sourceKind === 'clip_link' ? 'Paste your video link (step 1).'
        : sourceKind === 'instagram' ? 'Enter the Instagram profile (step 1).'
        : sourceKind === 'tiktok' ? 'Enter the TikTok profile (step 1).'
        : 'Paste your Google Drive folder link (step 1).');
      return;
    }
    if (selectedIds.length === 0) { setError('Select at least one account (step 2).'); return; }
    const timesClean = [...new Set(times)].sort();
    if (timesClean.length === 0) { setError('Add at least one posting time (step 3).'); return; }
    if (pairCount !== null && timesClean.length !== pairCount) {
      setError(`Every clip needs its own time — ${pairCount} clip${pairCount === 1 ? '' : 's'} need${pairCount === 1 ? 's' : ''} ${pairCount} different posting time${pairCount === 1 ? '' : 's'} (you have ${timesClean.length}).`);
      return;
    }
    if (captionMode === 'custom' && !customCaption.trim()) {
      setError('Enter the caption text to use for every video (step 4).');
      return;
    }
    if (!startDate || !endDate || endDate < startDate) { setError('Check the dates — the end date must be on or after the start date.'); return; }
    let leadEff: number | null = leadMin;
    if (leadCustom) {
      const n = Number(leadCustomStr);
      if (!Number.isInteger(n) || n < 5 || n > 1440) { setError('Schedule-ahead time must be 5–1440 minutes.'); return; }
      leadEff = n;
    }
    setSubmitting(true);
    const caption = captionMode === 'custom' ? customCaption : '';
    const aiCaptions = captionMode === 'ai';
    try {
      if (editing) {
        // Send only what actually changed. A caption-only edit must not touch
        // the schedule, and the campaign keeps its original timezone — the
        // times were entered relative to it.
        const cleanName = name.trim() || 'Auto-Pilot';
        const patch: Record<string, unknown> = {};
        if (cleanName !== editing.name) patch.name = cleanName;
        if (sourceKind === 'folder' && source.trim() !== editing.sourceUrl) patch.source = source.trim();
        if (!sameSet(selectedIds, editing.accountIds)) patch.accountIds = selectedIds;
        if (!sameSet(timesClean, editing.times)) patch.times = timesClean;
        if (startDate !== editing.startDate) patch.startDate = startDate;
        if (endDate !== editing.endDate) patch.endDate = endDate;
        // Always reaffirm the selected caption mode. Besides keeping the two
        // legacy fields mutually exclusive, the server uses this to refresh
        // captions on posts that are still queued locally.
        patch.caption = caption;
        patch.aiCaptions = aiCaptions;
        if ((leadEff ?? null) !== (editing.leadMinutes ?? null)) patch.leadMinutes = leadEff;
        if (Object.keys(patch).length === 0) { onSaved('Nothing changed.'); return; }
        await apiFetch(`/social/campaigns/${editing.id}`, { method: 'PATCH', body: JSON.stringify(patch) });
        onSaved(`"${cleanName}" updated.`);
      } else {
        let clipJobId: string | undefined;
        if (sourceKind === 'clip_link') {
          // Start the backend clip job first — the campaign then waits on it
          // and posts the clips on schedule the moment they're ready.
          // Kick links: the browser resolves the media source itself (Kick
          // often bot-blocks server IPs; see resolveKickHint). Never throws.
          const kickHint = await resolveKickHint(source.trim());
          const j = await apiFetch<{ jobId?: string }>('/video/clip', {
            method: 'POST',
            body: JSON.stringify({
              url: source.trim(),
              clipCount,
              platform: 'shorts',
              clipDuration: 30,
              quality: clipQuality,
              faceTrack: true,
              ...(clipPrompt.trim() ? { prompt: clipPrompt.trim() } : {}),
              async: true,
              forCampaign: true,
              ...(kickHint ?? {}),
            }),
          });
          if (!j.jobId) throw new Error('The clip job did not start — try again.');
          clipJobId = j.jobId;
        }
        let r: { ok: boolean; detected: number; queued?: number };
        try {
          r = await apiFetch<{ ok: boolean; detected: number; queued?: number }>('/social/campaigns', {
            method: 'POST',
            body: JSON.stringify({
              name: name.trim() || undefined,
              source: source.trim(),
              accountIds: selectedIds, times: timesClean, startDate, endDate, timezone, caption, aiCaptions,
              ...(leadEff !== null ? { leadMinutes: leadEff } : {}),
              ...(sourceKind === 'clip_link'
                ? { sourceKind: 'clip_link', clipJobId, clipParams: { clipCount, quality: clipQuality, ...(clipPrompt.trim() ? { prompt: clipPrompt.trim() } : {}) } }
                : sourceKind === 'instagram' || sourceKind === 'tiktok'
                  ? {
                      sourceKind,
                      ...(backlogLimit.trim() !== '' && Number.isFinite(Number(backlogLimit))
                        ? { backlogLimit: Math.max(0, Math.floor(Number(backlogLimit))) }
                        : {}),
                    }
                  : {}),
            }),
          });
        } catch (err) {
          // The clip job already started — be honest about where the clips go.
          if (sourceKind === 'clip_link') {
            throw new Error(`${(err as Error).message || 'Could not save the campaign.'} Your clips are still being made and will land in My videos — post them from there, or create the campaign again.`);
          }
          throw err;
        }
        onSaved(sourceKind === 'clip_link'
          ? `Campaign is live! ${clipCount} clip${clipCount === 1 ? '' : 's'} are being made right now — one posts at each time you set, starting the moment they're ready. You can close this page.`
          : sourceKind === 'instagram' || sourceKind === 'tiktok'
            ? `Campaign is live! ${r.detected} video${r.detected === 1 ? '' : 's'} found on the profile${
                r.queued !== undefined && r.queued < r.detected ? ` — posting the newest ${r.queued}` : ''
              } — ${perDay}/day from ${fmtDate(startDate)}. New uploads are picked up automatically every day.`
            : `Campaign is live! ${r.detected} video${r.detected === 1 ? '' : 's'} detected — ${perDay}/day from ${fmtDate(startDate)}. You can close this page.`);
      }
    } catch (err) {
      setError((err as Error).message || 'Could not save the campaign.');
      setSubmitting(false);
    }
  }

  return (
    <div className="bg-gradient-to-b from-[#1a1b13] via-[#151515] to-[#121212] border border-[#D1FE17]/35 rounded-[28px] p-4 sm:p-7 mb-8 shadow-[0_24px_80px_-36px_rgba(209,254,23,0.55)]">
      <div className="flex items-start justify-between gap-4 mb-7">
        <div>
          <h3 className="text-base font-black flex items-center gap-2">
            <span className="w-7 h-7 rounded-lg bg-[#D1FE17]/15 border border-[#D1FE17]/30 flex items-center justify-center">
              <Rocket className="w-4 h-4 text-[#D1FE17]" />
            </span>
            {editing ? 'Edit campaign' : 'New campaign'}
          </h3>
          <p className="text-xs text-white/60 mt-2 ml-9">
            {editing ? 'Update the source, accounts, timing, or caption.' : 'Set it once and Auto-Pilot keeps posting on schedule.'}
          </p>
        </div>
        <button type="button" onClick={onClose} aria-label="Close form"
          className="w-8 h-8 flex items-center justify-center rounded-xl text-white/60 border border-white/10 hover:text-white hover:bg-white/10 transition-colors">
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Step 1 — videos (lime badge + rail = clear numbered steps) */}
      <div className="relative pl-11 sm:pl-12 pb-8">
        <span className="absolute left-0 top-0 w-8 h-8 rounded-full bg-[#D1FE17] text-black text-sm font-black flex items-center justify-center shadow-[0_0_16px_rgba(209,254,23,0.3)]">1</span>
        <span className="absolute left-[15px] top-10 bottom-0 w-px bg-[#D1FE17]/20" aria-hidden />
        <p className="text-sm font-black leading-none pt-2">Add your videos</p>
        <p className="text-xs text-white/65 mt-2 mb-1">Choose where your videos come from. We’ll detect them before you start.</p>
      {!editing && (
        <div className="mt-4 grid grid-cols-1 sm:grid-cols-3 gap-2">
          {([
            ['folder', '📁', 'Ready video folder'],
            ['instagram', '📸', 'Instagram profile'],
            ['tiktok', '♪', 'TikTok profile'],
            ['clip_link', '🎬', 'One video → auto-clips'],
          ] as const).map(([k, icon, label]) => (
            <button
              key={k}
              type="button"
              onClick={() => {
                setSourceKind(k); setDetect(null); setError(null); setBacklogLimit('');
              }}
              className={`flex items-center justify-center gap-2 px-3 py-3 rounded-xl border text-xs font-black transition-all ${sourceKind === k ? 'bg-[#D1FE17]/15 border-[#D1FE17] text-[#D1FE17] shadow-[0_0_22px_-8px_rgba(209,254,23,0.8)]' : 'bg-[#0d0d0d]/70 border-white/15 text-white/70 hover:border-white/35 hover:text-white'}`}
            >
              <span className="text-base leading-none">{icon}</span>
              <span>{label}</span>
            </button>
          ))}
        </div>
      )}
      <div className="mt-3 flex flex-col sm:flex-row gap-2">
        <input
          value={source}
          onChange={e => { setSource(e.target.value); setDetect(null); }}
          placeholder={sourceKind === 'clip_link'
            ? 'https://youtube.com/watch?v=…'
            : sourceKind === 'instagram'
              ? '@username or instagram.com/username'
              : sourceKind === 'tiktok'
                ? '@username or tiktok.com/@username'
              : 'https://drive.google.com/drive/folders/…'}
          disabled={!!editing && sourceKind !== 'folder'}
          className="flex-1 min-w-0 h-12 bg-[#090909]/90 border border-white/20 focus:border-[#D1FE17] rounded-2xl px-4 text-sm text-white placeholder:text-white/50 outline-none font-mono transition-colors disabled:opacity-50"
        />
        {sourceKind !== 'clip_link' && (
          <button
            type="button"
            onClick={() => void runDetect()}
            disabled={detecting || !source.trim()}
            className="shrink-0 h-12 flex items-center justify-center gap-1.5 bg-[#D1FE17] hover:bg-[#c5f010] border border-[#D1FE17] text-black text-xs font-black px-5 rounded-2xl transition-all hover:shadow-[0_8px_24px_-10px_rgba(209,254,23,0.9)] disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {detecting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <FolderOpen className="w-3.5 h-3.5" />}
            Detect
          </button>
        )}
      </div>
      {detect && (
        <p className="text-[#D1FE17] text-xs font-black mt-2 flex items-center gap-1.5">
          <CheckCircle2 className="w-3.5 h-3.5" />
          {detect.count} video{detect.count === 1 ? '' : 's'} {editing && detect.names.length === 0 ? 'in this campaign' : 'detected'}
           {detect.names.length > 0 && <span className="text-white/65 font-medium truncate">({detect.names.slice(0, 3).join(', ')}{detect.count > 3 ? '…' : ''})</span>}
        </p>
      )}
          {sourceKind === 'clip_link' ? (
        <>
           <div className="mt-3"><SourceBrandRow note="Works with" ids={['youtube', 'kick', 'twitch', 'gdrive', 'dropbox', 'mp4']} /></div>
          <div className="mt-3 flex items-center gap-3 flex-wrap">
             <p className="text-[11px] font-bold text-white/75">Clips from this video:</p>
            <div className="flex items-center gap-2">
              <button type="button" onClick={() => changeClipCount(n => n - 1)} aria-label="Fewer clips"
                className="w-7 h-7 rounded-lg bg-white/[0.06] border border-white/10 font-black hover:bg-white/[0.1] transition-colors">−</button>
              <span className="text-sm font-black tabular-nums w-6 text-center">{clipCount}</span>
               <button type="button" onClick={() => changeClipCount(n => n + 1)} aria-label="More clips"
                className="w-7 h-7 rounded-lg bg-white/[0.06] border border-white/10 font-black hover:bg-white/[0.1] transition-colors">+</button>
                <span className="text-white/60 text-[11px]">up to 12 · each clip gets its own posting time</span>
            </div>
             <label className="flex items-center gap-2 text-[11px] font-bold text-white/75">
               Quality
               <select
                 value={clipQuality}
                 onChange={e => setClipQuality(e.target.value as 'fast' | 'quality')}
                 className="bg-[#0d0d0d] border border-white/10 rounded-xl px-2.5 py-2 text-xs font-black text-white outline-none"
               >
                 <option value="quality">1080p · Full HD</option>
                 <option value="fast">720p · Faster</option>
               </select>
             </label>
          </div>
          {!editing && (
            <div className="mt-3">
               <label htmlFor="clip-prompt" className="text-[11px] font-bold text-white/75">AI prompt / campaign rules <span className="text-white/60 font-medium">(optional)</span></label>
              <textarea
                id="clip-prompt"
                value={clipPrompt}
                onChange={e => setClipPrompt(e.target.value)}
                maxLength={10000}
                rows={2}
                placeholder='e.g. "only the funny parts" — or paste your campaign rules (must-tag handles, min length, CTA) and the clips + captions will follow them'
                 className="w-full mt-2 bg-black/40 border border-white/20 rounded-xl px-3 py-3 text-white text-sm placeholder-white/50 focus:outline-none focus:border-[#D1FE17] resize-none transition-colors"
              />
            </div>
          )}
           <p className="text-white/60 text-[11px] leading-relaxed mt-2">
            The clips are made on our servers the moment you hit start (normal clip credits apply) and also land in My videos.
            Posting begins as soon as they're ready — one clip goes out at each posting time you set below.
            Posting your own clips is included — no extra credits.
          </p>
        </>
      ) : sourceKind === 'instagram' || sourceKind === 'tiktok' ? (
        <>
            <div className="mt-3"><SourceBrandRow note="Works with" ids={[sourceKind]} /></div>
          {!editing && (
            <div className="mt-3">
                <label htmlFor="profile-backlog" className="text-[11px] font-bold text-white/75">
                How many past videos to post?{' '}
                 <span className="text-white/60 font-medium">(leave empty for all{detect ? ` ${detect.count}` : ''})</span>
              </label>
              <div className="mt-1.5 flex items-center gap-2.5 flex-wrap">
                   <input
                   id="profile-backlog"
                  type="number"
                  min={0}
                  max={1000}
                  step={1}
                  value={backlogLimit}
                  onChange={e => setBacklogLimit(e.target.value)}
                  placeholder="All"
                   className="w-28 h-11 bg-black/40 border border-white/20 rounded-xl px-3 text-white text-sm placeholder-white/50 focus:outline-none focus:border-[#D1FE17] transition-colors"
                />
                 <span className="text-white/60 text-[11px]">
                  e.g. 10 = only the 10 newest videos post, then it waits · 0 = only future uploads
                </span>
              </div>
            </div>
          )}
           <p className="text-white/60 text-[11px] leading-relaxed mt-2">
             Public profiles only. Your chosen past videos post on your schedule (oldest first) —
             and every NEW upload is picked up automatically every day and posted at the next slot, with its caption.
            Each video posted uses 50 credits — if you run out, posts wait and resume after a top-up.
          </p>
        </>
      ) : (
        <>
           <div className="mt-3"><SourceBrandRow note="Works with" ids={['gdrive', 'dropbox', 'mp4']} /></div>
           <p className="text-white/60 text-[11px] leading-relaxed mt-2">
            Share the folder as "Anyone with the link can view". Dropbox and direct .mp4 links work too.
            Each video posted uses 50 credits — if you run out, posts wait and resume after a top-up.
          </p>
        </>
      )}

      {/* Name */}
      <label className="block mt-5 text-[11px] font-bold uppercase tracking-wider text-white/75">Campaign name <span className="normal-case tracking-normal text-white/55 font-medium">(optional)</span></label>
      <input
        value={name}
        onChange={e => setName(e.target.value)}
        placeholder="e.g. August reels push"
        maxLength={80}
        className="mt-2 w-full h-12 bg-[#090909]/90 border border-white/20 focus:border-[#D1FE17] rounded-2xl px-4 text-sm text-white placeholder:text-white/50 outline-none transition-colors"
      />

      </div>

      {/* Step 2 — accounts */}
      <div className="relative pl-11 sm:pl-12 pb-8">
        <span className="absolute left-0 top-0 w-8 h-8 rounded-full bg-[#D1FE17] text-black text-sm font-black flex items-center justify-center shadow-[0_0_16px_rgba(209,254,23,0.3)]">2</span>
        <span className="absolute left-[15px] top-10 bottom-0 w-px bg-[#D1FE17]/20" aria-hidden />
        <p className="text-sm font-black leading-none pt-2">Choose where to post</p>
        <p className="text-xs text-white/65 mt-2">Every selected account gets every post. You can change this later.</p>
      <div className="mt-3">
        {!accountsReady ? (
          <div className="flex items-center gap-2 text-white/70 text-sm"><Loader2 className="w-4 h-4 animate-spin text-[#D1FE17]" /> Loading your accounts…</div>
        ) : accounts.length === 0 ? (
          <Link href="/social" className="flex items-center gap-2 text-sm font-bold text-[#D1FE17] hover:underline">
            <Share2 className="w-4 h-4" /> No accounts connected yet — connect them on the Social page first →
          </Link>
        ) : (
          <div className="flex flex-wrap gap-2">
            {accounts.map(acc => {
              const on = selectedIds.includes(acc.id);
              return (
                <button
                  key={acc.id}
                  type="button"
                  onClick={() => setSelectedIds(ids => on ? ids.filter(i => i !== acc.id) : [...ids, acc.id])}
                  className={`flex items-center gap-2 px-3 py-2.5 rounded-xl border text-xs font-bold transition-all ${on ? 'bg-[#D1FE17]/15 border-[#D1FE17] text-white shadow-[0_0_18px_-10px_rgba(209,254,23,0.9)]' : 'bg-[#0d0d0d]/70 border-white/15 text-white/70 hover:border-white/35 hover:text-white'}`}
                >
                  <PlatformIcon type={acc.type} size={18} />
                  {PLATFORM_META[acc.type]?.label ?? acc.type}
                  {acc.username ? <span className="text-white/60 font-medium">@{acc.username.replace(/^@/, '')}</span> : null}
                  {on && <CheckCircle2 className="w-3.5 h-3.5 text-[#D1FE17]" />}
                </button>
              );
            })}
          </div>
        )}
      </div>

      </div>

      {/* Step 3 — schedule */}
      <div className="relative pl-11 sm:pl-12 pb-8">
        <span className="absolute left-0 top-0 w-8 h-8 rounded-full bg-[#D1FE17] text-black text-sm font-black flex items-center justify-center shadow-[0_0_16px_rgba(209,254,23,0.3)]">3</span>
        <span className="absolute left-[15px] top-10 bottom-0 w-px bg-[#D1FE17]/20" aria-hidden />
        <p className="text-sm font-black leading-none pt-2">Set the schedule</p>
        <p className="text-xs text-white/65 mt-2">Pick dates, times, and how many videos go out each time.</p>
      <div className="mt-3 grid sm:grid-cols-2 gap-4">
        <div>
          <p className="text-[11px] font-bold uppercase tracking-wider text-white/75 mb-2">Starts</p>
          <input
            type="date" value={startDate} min={today}
            onChange={e => setStartDate(e.target.value)}
            onClick={e => { try { e.currentTarget.showPicker?.(); } catch { /* typing still works */ } }}
            className="w-full h-12 bg-[#090909]/90 border border-white/20 focus:border-[#D1FE17] rounded-2xl px-4 text-sm text-white outline-none [color-scheme:dark] cursor-pointer transition-colors"
          />
        </div>
        <div>
          <p className="text-[11px] font-bold uppercase tracking-wider text-white/75 mb-2">Ends</p>
          <input
            type="date" value={endDate} min={startDate || today}
            onChange={e => setEndDate(e.target.value)}
            onClick={e => { try { e.currentTarget.showPicker?.(); } catch { /* typing still works */ } }}
            className="w-full h-12 bg-[#090909]/90 border border-white/20 focus:border-[#D1FE17] rounded-2xl px-4 text-sm text-white outline-none [color-scheme:dark] cursor-pointer transition-colors"
          />
          <div className="flex flex-wrap gap-1.5 mt-2">
            {([['1 week', 7], ['2 weeks', 14], ['1 month', 30]] as const).map(([label, n]) => (
              <button
                key={label}
                type="button"
                onClick={() => setEndDate(plusDays(startDate || today, n - 1))}
                className="text-[10px] font-black px-2.5 py-1.5 rounded-lg border border-white/15 text-white/70 hover:text-[#D1FE17] hover:border-[#D1FE17]/60 hover:bg-[#D1FE17]/10 transition-colors"
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="mt-4">
        <p className="text-[11px] font-bold text-white/75 mb-2">
          Posting times · your timezone ({timezone})
          <span className="text-white/60 font-medium"> — one video posts at each time</span>
        </p>
        <div className="flex flex-wrap items-center gap-2">
          {times.map((t, i) => (
            <span key={i} className="flex items-center gap-1 bg-[#D1FE17]/15 border border-[#D1FE17]/55 rounded-xl px-2 py-1.5 shadow-[0_0_16px_-10px_rgba(209,254,23,0.8)]">
              <input
                type="time"
                value={t}
                onChange={e => { const v = e.target.value; if (v) setTimes(ts => ts.map((x, j) => (j === i ? v : x))); }}
                onClick={e => { try { e.currentTarget.showPicker?.(); } catch { /* typing still works */ } }}
                onBlur={() => { if (pairCount !== null) syncTimesToCount(pairCount); else setTimes(ts => [...new Set(ts)].sort()); }}
                aria-label={`Posting time ${i + 1}`}
                className="bg-transparent text-xs font-black text-white outline-none [color-scheme:dark] cursor-pointer"
              />
              {times.length > 1 && pairCount === null && (
                <button type="button" onClick={() => setTimes(ts => ts.filter((_, j) => j !== i))} className="text-white/70 hover:text-red-300" aria-label={`Remove time ${t}`}>
                  <X className="w-3 h-3" />
                </button>
              )}
            </span>
          ))}
          {times.length < 12 && pairCount === null && (
            <button
              type="button"
              onClick={addTime}
              className="flex items-center gap-1 text-xs font-black text-[#D1FE17] hover:bg-[#D1FE17]/10 px-2 py-1.5 rounded-xl transition-colors"
            >
              <Plus className="w-3.5 h-3.5" /> Add time
            </button>
          )}
          <span className="text-white/70 text-[11px] font-bold">= {perDay}/day</span>
        </div>
        <p className="text-white/60 text-[11px] leading-relaxed mt-2">
          {pairCount !== null
            ? editing
              ? `This campaign posts ${pairCount} clip${pairCount === 1 ? '' : 's'} — it keeps exactly ${pairCount} posting time${pairCount === 1 ? '' : 's'}. Tap a time to change it.`
              : `One time per clip — ${clipCount} clip${clipCount === 1 ? '' : 's'} = ${clipCount} time${clipCount === 1 ? '' : 's'}. Change the clip count in step 1 to add or remove times. Tap a time to change it.`
            : 'Tap a time to change it right there. Exactly one video posts at each time.'}
        </p>
      </div>

      <div className="mt-4">
        <p className="text-[11px] font-bold text-white/75 mb-2">
          Schedule on YouTube early
          <span className="text-white/60 font-medium"> — upload ahead of time and see the video as Scheduled in YouTube Studio before it goes live.</span>
        </p>
        <div className="flex flex-wrap items-center gap-2">
          {leadPresets.map(p => {
            const active = !leadCustom && (leadMin ?? null) === p.v;
            return (
              <button
                key={p.label}
                type="button"
                onClick={() => { setLeadCustom(false); setLeadMin(p.v); }}
                className={`text-[10px] font-black px-2.5 py-1.5 rounded-lg border transition-colors ${active ? 'border-[#D1FE17] text-[#D1FE17] bg-[#D1FE17]/15 shadow-[0_0_16px_-10px_rgba(209,254,23,0.8)]' : 'border-white/15 text-white/70 hover:text-[#D1FE17] hover:border-[#D1FE17]/60 hover:bg-[#D1FE17]/10'}`}
              >
                {p.label}
              </button>
            );
          })}
          <button
            type="button"
            onClick={() => setLeadCustom(true)}
            className={`text-[10px] font-black px-2.5 py-1.5 rounded-lg border transition-colors ${leadCustom ? 'border-[#D1FE17] text-[#D1FE17] bg-[#D1FE17]/15 shadow-[0_0_16px_-10px_rgba(209,254,23,0.8)]' : 'border-white/15 text-white/70 hover:text-[#D1FE17] hover:border-[#D1FE17]/60 hover:bg-[#D1FE17]/10'}`}
          >
            Custom
          </button>
          {leadCustom && (
            <span className="flex items-center gap-1">
              <input
                inputMode="numeric"
                value={leadCustomStr}
                onChange={e => setLeadCustomStr(e.target.value.replace(/[^0-9]/g, ''))}
                placeholder="45"
                aria-label="Minutes before the posting time"
                className="w-14 bg-black/50 border border-white/25 rounded-lg px-2 py-1.5 text-xs font-black text-white outline-none focus:border-[#D1FE17]"
              />
              <span className="text-white/65 text-[11px]">min before</span>
            </span>
          )}
        </div>
        <p className="text-white/60 text-[11px] leading-relaxed mt-2">
          {leadCustom || leadMin !== null
            ? 'The post waits here until then — after hand-off it shows as "Scheduled" on the platform and still goes live right at its time.'
            : 'Each video is handed to the platform as soon as its day is planned, and shows as "Scheduled" there until it goes live.'}
        </p>
      </div>

      </div>

      {/* Step 4 — caption (last step: no rail below) */}
      <div className="relative pl-11 sm:pl-12 pb-1">
        <span className="absolute left-0 top-0 w-8 h-8 rounded-full bg-[#D1FE17] text-black text-sm font-black flex items-center justify-center shadow-[0_0_16px_rgba(209,254,23,0.3)]">4</span>
        <p className="text-sm font-black leading-none pt-2">Pick the caption style</p>
        <p className="text-xs text-white/65 mt-2 mb-3">The text that goes with every post.</p>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => setCaptionMode('filename')}
            className={`px-3 py-2.5 rounded-xl border text-xs font-bold transition-all ${captionMode === 'filename' ? 'bg-[#D1FE17]/15 border-[#D1FE17] text-[#D1FE17] shadow-[0_0_18px_-10px_rgba(209,254,23,0.9)]' : 'bg-[#0d0d0d]/70 border-white/15 text-white/70 hover:border-white/35 hover:text-white'}`}
          >
            Video's file name
          </button>
          <button
            type="button"
            onClick={() => setCaptionMode('custom')}
            className={`px-3 py-2.5 rounded-xl border text-xs font-bold transition-all ${captionMode === 'custom' ? 'bg-[#D1FE17]/15 border-[#D1FE17] text-[#D1FE17] shadow-[0_0_18px_-10px_rgba(209,254,23,0.9)]' : 'bg-[#0d0d0d]/70 border-white/15 text-white/70 hover:border-white/35 hover:text-white'}`}
          >
            Same text for all
          </button>
          <button
            type="button"
            onClick={() => setCaptionMode('ai')}
            className={`px-3 py-2.5 rounded-xl border text-xs font-bold transition-all ${captionMode === 'ai' ? 'bg-[#D1FE17]/15 border-[#D1FE17] text-[#D1FE17] shadow-[0_0_18px_-10px_rgba(209,254,23,0.9)]' : 'bg-[#0d0d0d]/70 border-white/15 text-white/70 hover:border-white/35 hover:text-white'}`}
          >
            ✨ AI viral caption
          </button>
          {captionMode === 'custom' && (
            <>
              <input
                value={customCaption}
                onChange={e => setCustomCaption(e.target.value)}
                placeholder="Caption for every video…"
                maxLength={2000}
                className="flex-1 min-w-[200px] h-11 bg-[#090909]/90 border border-white/20 focus:border-[#D1FE17] rounded-xl px-3 text-sm text-white placeholder:text-white/50 outline-none transition-colors"
              />
              <button
                type="button"
                onClick={() => void aiDraft()}
                disabled={aiWriting}
                className="px-3 py-2.5 rounded-xl border border-[#D1FE17]/50 bg-[#D1FE17]/10 text-[#D1FE17] text-xs font-black hover:bg-[#D1FE17]/20 transition-colors disabled:opacity-50"
              >
                {aiWriting ? 'Writing…' : '✨ Write with AI'}
              </button>
            </>
          )}
        </div>
        {captionMode === 'ai' && (
          <p className="text-white/65 text-[11px] leading-relaxed mt-2">
            Every video gets its own AI-written viral caption + hashtags, matched to the video's name and language.
          </p>
        )}
      </div>

      {/* Plan preview */}
      {plan && days > 0 && (
        <div className="mt-4 bg-[#D1FE17]/[0.06] border border-[#D1FE17]/25 rounded-2xl px-4 py-3.5 flex items-start gap-3">
          <Sparkles className="w-4 h-4 text-[#D1FE17] mt-0.5 shrink-0" />
          <div className="text-sm">
            <p className="font-black">{plan.toPost} video{plan.toPost === 1 ? '' : 's'} over {days} day{days === 1 ? '' : 's'} · {perDay}/day</p>
            <p className="text-white/70 text-xs mt-1">
              {plan.leftover > 0
                ? `${plan.leftover} more video${plan.leftover === 1 ? '' : 's'} stay in line — extend the end date (or edit later) to post them.`
                : 'The whole folder fits in this date range.'}
            </p>
          </div>
        </div>
      )}

      {error && (
        <div className="mt-4 rounded-2xl px-4 py-3 text-sm font-bold flex items-start gap-2.5 bg-red-500/10 text-red-300">
          <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
          <span className="min-w-0">{error}</span>
        </div>
      )}

      <button
        type="button"
        onClick={() => void submit()}
        disabled={submitting || accounts.length === 0}
        className="mt-6 w-full min-h-14 flex items-center justify-center gap-2 bg-[#D1FE17] text-black font-black text-[15px] py-4 rounded-2xl hover:bg-[#c5f010] hover:-translate-y-0.5 active:translate-y-0 active:scale-[0.99] transition-all disabled:opacity-40 disabled:cursor-not-allowed shadow-[0_16px_42px_-12px_rgba(209,254,23,0.75)]"
      >
        {submitting
          ? <><Loader2 className="w-4 h-4 animate-spin" /> Saving…</>
          : editing
            ? <><CheckCircle2 className="w-4 h-4" /> Save changes</>
            : <><Rocket className="w-4 h-4" /> Start Auto-Pilot</>}
      </button>
      {!editing && (
          <p className="text-center text-white/65 text-[11px] mt-3">
          Posting is automatic from then on — even when you're offline.
        </p>
      )}
    </div>
  );
}
