/**
 * Bulk scheduler — paste public Google Drive / Dropbox links, pick platforms
 * and times-of-day, and the videos post themselves day by day.
 *
 * Everything heavy happens on the posting provider's side: their servers
 * fetch each video straight from Drive/Dropbox, store it, and publish at the
 * scheduled moment. Our server keeps only tiny metadata rows — zero video
 * storage, zero posting cron.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'wouter';
import {
  AlertCircle, CalendarClock, CheckCircle2, ChevronDown, ChevronUp,
  Link2, Loader2, Plus, Share2, Sparkles, X,
} from 'lucide-react';
import { apiFetch, useAuth } from '../lib/auth';
import { AppHeader } from '../components/AppHeader';
import { PlatformIcon, PLATFORM_META } from '../components/PlatformIcons';

// ── Types ─────────────────────────────────────────────────────────────────────
interface SocialAccount {
  id: string; type: string; name: string;
  username?: string; avatarUrl?: string; enabled: boolean;
}
interface SchedRow {
  id: string; batch_id: string; source_url: string; file_name: string;
  caption: string; platforms: string[]; post_at: string; status: string;
  error: string | null; created_at: string;
}
interface CreateResult {
  ok: boolean; batchId: string; scheduled: number;
  skipped: { url: string; reason: string }[];
  firstAt: string; lastAt: string;
}

const fmtAt = (iso: string | Date) =>
  new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const fmtDay = (d: Date) =>
  d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });

// ── Status chip ───────────────────────────────────────────────────────────────
function StatusChip({ row }: { row: SchedRow }) {
  const pastDue = row.status === 'scheduled' && new Date(row.post_at).getTime() <= Date.now();
  if (row.status === 'queued' || row.status === 'creating')
    return <span className="text-[10px] font-black uppercase tracking-wider text-white/40 bg-white/5 px-2 py-1 rounded-lg">Waiting</span>;
  if (row.status === 'processing')
    return <span className="text-[10px] font-black uppercase tracking-wider text-[#D1FE17]/80 bg-[#D1FE17]/10 px-2 py-1 rounded-lg animate-pulse">Posting…</span>;
  if (row.status === 'posted')
    return <span className="text-[10px] font-black uppercase tracking-wider text-black bg-[#D1FE17] px-2 py-1 rounded-lg">Posted</span>;
  if (row.status === 'scheduled')
    return pastDue
      ? <span className="text-[10px] font-black uppercase tracking-wider text-black bg-[#D1FE17] px-2 py-1 rounded-lg">Posted</span>
      : <span className="text-[10px] font-black uppercase tracking-wider text-[#D1FE17] bg-[#D1FE17]/10 px-2 py-1 rounded-lg">Scheduled ✓</span>;
  if (row.status === 'failed')
    return <span title={row.error ?? undefined} className="text-[10px] font-black uppercase tracking-wider text-red-300 bg-red-500/10 px-2 py-1 rounded-lg">Failed</span>;
  if (row.status === 'deleted')
    return <span className="text-[10px] font-black uppercase tracking-wider text-white/25 bg-white/5 px-2 py-1 rounded-lg">Removed</span>;
  return <span className="text-[10px] font-black uppercase tracking-wider text-white/25 bg-white/5 px-2 py-1 rounded-lg">Cancelled</span>;
}

const cancellable = (r: SchedRow) =>
  r.status === 'queued' || r.status === 'creating' || r.status === 'failed' ||
  (r.status === 'scheduled' && new Date(r.post_at).getTime() > Date.now());

// ── Step heading ──────────────────────────────────────────────────────────────
function StepTitle({ n, title, hint }: { n: number; title: string; hint?: string }) {
  return (
    <div className="mb-3">
      <div className="flex items-center gap-2.5">
        <span className="w-6 h-6 rounded-full bg-[#D1FE17] text-black text-xs font-black flex items-center justify-center shrink-0">{n}</span>
        <h3 className="text-base font-black">{title}</h3>
      </div>
      {hint && <p className="text-white/40 text-xs mt-1.5 ml-[34px]">{hint}</p>}
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────
export default function SchedulePage() {
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
            <CalendarClock className="w-6 h-6 text-white/30" />
          </div>
          <p className="text-white/70 font-bold">Sign in to schedule posts</p>
          <p className="text-white/40 text-sm mt-1 mb-6">Bulk-schedule videos from Google Drive or Dropbox.</p>
          <Link href="/login" className="inline-block bg-[#D1FE17] text-black text-sm font-black px-6 py-3 rounded-xl hover:bg-[#c5f010] transition-colors">Sign in</Link>
        </div>
      </div>
    );
  }
  return <SchedulerView />;
}

function SchedulerView() {
  // Connected accounts
  const [accounts, setAccounts] = useState<SocialAccount[]>([]);
  const [accountsReady, setAccountsReady] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  useEffect(() => {
    let stale = false;
    (async () => {
      try {
        const s = await apiFetch<{ hasAccounts: boolean }>('/social/status');
        if (stale) return;
        if (s.hasAccounts) {
          const d = await apiFetch<{ accounts: {
            id: string; platform: string; username?: string | null;
            displayName?: string | null; profileImage?: string | null;
            status: string; autopostEnabled: boolean;
          }[] }>('/social/accounts');
          if (stale) return;
          // Every CONNECTED account is schedulable (auto-post pref doesn't gate manual scheduling)
          const connected = d.accounts.filter(a => a.status === 'connected').map(a => ({
            id: a.id,
            type: (a.platform || '').toUpperCase(),
            name: a.displayName || a.username || a.platform,
            username: a.username ?? undefined,
            avatarUrl: a.profileImage ?? undefined,
            enabled: a.autopostEnabled,
          }));
          setAccounts(connected);
          setSelectedIds(connected.map(a => a.id));
        }
        setAccountsReady(true);
      } catch { if (!stale) setAccountsReady(true); }
    })();
    return () => { stale = true; };
  }, []);

  // Form state
  const [linksText, setLinksText] = useState('');
  const [startDate, setStartDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [times, setTimes] = useState<string[]>(['18:00']);
  const [newTime, setNewTime] = useState('12:00');
  const [captionMode, setCaptionMode] = useState<'filename' | 'custom'>('filename');
  const [customCaption, setCustomCaption] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [banner, setBanner] = useState<{ kind: 'success' | 'error'; msg: string; skipped?: { url: string; reason: string }[] } | null>(null);
  const [showSkipped, setShowSkipped] = useState(false);

  // Scheduled list
  const [rows, setRows] = useState<SchedRow[]>([]);
  const [listLoading, setListLoading] = useState(true);
  const loadList = useCallback(async () => {
    try {
      const d = await apiFetch<{ posts: SchedRow[] }>('/social/schedule');
      setRows(d.posts);
    } catch { /* list stays as-is */ }
    setListLoading(false);
  }, []);
  useEffect(() => { void loadList(); }, [loadList]);

  // Poll while anything is still being handed to the provider
  const hasActive = rows.some(r => r.status === 'queued' || r.status === 'creating' || r.status === 'processing');
  useEffect(() => {
    if (!hasActive) return;
    const t = setInterval(() => { void loadList(); }, 15_000);
    return () => clearInterval(t);
  }, [hasActive, loadList]);

  const timezone = useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone, []);
  const linkCount = useMemo(
    () => linksText.split('\n').map(s => s.trim()).filter(Boolean).length,
    [linksText],
  );

  // Live plan preview — same day-by-day logic as the server, in local time.
  // (Folder links may expand to more videos, so this is a minimum estimate.)
  const plan = useMemo(() => {
    if (linkCount === 0 || times.length === 0) return null;
    const sorted = [...times].sort();
    const minStart = Date.now() + 5 * 60_000;
    const [y, mo, d] = startDate.split('-').map(Number);
    if (!y || !mo || !d) return null;
    let first: Date | null = null, last: Date | null = null, placed = 0;
    for (let day = 0; placed < linkCount && day < 4000; day++) {
      for (const t of sorted) {
        if (placed >= linkCount) break;
        const [hh, mm] = t.split(':').map(Number);
        const at = new Date(y, mo - 1, d + day, hh, mm);
        if (at.getTime() < minStart) continue;
        if (!first) first = at;
        last = at;
        placed++;
      }
    }
    if (!first || !last) return null;
    const days = Math.max(1, Math.round((last.getTime() - first.getTime()) / 86_400_000) + 1);
    return { first, last, days };
  }, [linkCount, times, startDate]);

  async function submit() {
    if (submitting) return;
    setBanner(null);
    const sources = linksText.split('\n').map(s => s.trim()).filter(Boolean);
    if (sources.length === 0) { setBanner({ kind: 'error', msg: 'Paste at least one video link first (step 1).' }); return; }
    if (selectedIds.length === 0) { setBanner({ kind: 'error', msg: 'Select at least one account to post to (step 2).' }); return; }
    if (times.length === 0) { setBanner({ kind: 'error', msg: 'Add at least one posting time (step 3).' }); return; }
    setSubmitting(true);
    try {
      const r = await apiFetch<CreateResult>('/social/schedule', {
        method: 'POST',
        body: JSON.stringify({
          sources,
          accountIds: selectedIds,
          times,
          startDate,
          timezone,
          caption: captionMode === 'custom' ? customCaption : undefined,
        }),
      });
      setBanner({
        kind: 'success',
        msg: `Done! ${r.scheduled} video${r.scheduled === 1 ? '' : 's'} scheduled. First post: ${fmtAt(r.firstAt)} · last: ${fmtAt(r.lastAt)}. You can close this page — posting is automatic.`,
        skipped: r.skipped?.length ? r.skipped : undefined,
      });
      setLinksText('');
      void loadList();
    } catch (err) {
      setBanner({ kind: 'error', msg: (err as Error).message || 'Could not schedule.' });
    }
    setSubmitting(false);
  }

  async function cancelOne(id: string) {
    try {
      await apiFetch(`/social/schedule/${id}`, { method: 'DELETE' });
      void loadList();
    } catch (err) {
      setBanner({ kind: 'error', msg: (err as Error).message || 'Could not cancel.' });
    }
  }
  async function cancelBatch(batchId: string) {
    try {
      await apiFetch(`/social/schedule/batch/${batchId}/cancel`, { method: 'POST' });
      void loadList();
    } catch (err) {
      setBanner({ kind: 'error', msg: (err as Error).message || 'Could not cancel batch.' });
    }
  }

  // Group rows by batch, newest first
  const batches = useMemo(() => {
    const map = new Map<string, SchedRow[]>();
    for (const r of rows) {
      const arr = map.get(r.batch_id) ?? [];
      arr.push(r);
      map.set(r.batch_id, arr);
    }
    return [...map.entries()].sort((a, b) =>
      new Date(b[1][0].created_at).getTime() - new Date(a[1][0].created_at).getTime());
  }, [rows]);

  return (
    <div className="min-h-screen bg-[#0d0d0d] text-white font-sans">
      <AppHeader />
      <main className="max-w-3xl mx-auto px-4 pb-24 pt-8">
        <div className="flex items-center gap-3 mb-2">
          <div className="w-10 h-10 rounded-xl bg-[#D1FE17]/10 flex items-center justify-center">
            <CalendarClock className="w-5 h-5 text-[#D1FE17]" />
          </div>
          <h1 className="text-2xl font-black">Bulk scheduler</h1>
        </div>
        <p className="text-white/40 text-sm mb-6">
          Paste your video links once — they get posted automatically, day by day.
        </p>

        {/* How it works */}
        <div className="grid grid-cols-3 gap-2 mb-8">
          {[
            { icon: Link2, label: 'Paste video links' },
            { icon: Share2, label: 'Pick accounts' },
            { icon: CalendarClock, label: 'Set times — done' },
          ].map((s, i) => (
            <div key={i} className="bg-[#161616] border border-white/[0.06] rounded-2xl px-3 py-3 text-center">
              <s.icon className="w-4 h-4 text-[#D1FE17] mx-auto mb-1.5" />
              <p className="text-[11px] font-bold text-white/60 leading-tight">{s.label}</p>
            </div>
          ))}
        </div>

        {/* ── Step 1: videos ────────────────────────────────────────────────── */}
        <div className="bg-[#161616] border border-white/[0.07] rounded-3xl p-5 sm:p-6 mb-4">
          <StepTitle
            n={1}
            title="Add your videos"
            hint="One link per line. Paste a Google Drive folder link and every video inside gets added automatically. Each video posted uses 50 credits — if you run out, posts wait and resume after a top-up."
          />
          <textarea
            value={linksText}
            onChange={e => setLinksText(e.target.value)}
            rows={5}
            placeholder={`https://drive.google.com/drive/folders/…   ← whole folder\nhttps://drive.google.com/file/d/…/view\nhttps://www.dropbox.com/scl/fi/…/video.mp4?rlkey=…`}
            className="w-full bg-[#0d0d0d] border border-white/10 focus:border-[#D1FE17]/50 rounded-2xl px-4 py-3 text-sm text-white/90 placeholder:text-white/20 outline-none resize-y font-mono"
          />
          {linkCount > 0 && (
            <p className="text-[#D1FE17] text-xs font-black mt-2 flex items-center gap-1.5">
              <CheckCircle2 className="w-3.5 h-3.5" /> {linkCount} link{linkCount === 1 ? '' : 's'} added
            </p>
          )}
        </div>

        {/* ── Step 2: accounts ──────────────────────────────────────────────── */}
        <div className="bg-[#161616] border border-white/[0.07] rounded-3xl p-5 sm:p-6 mb-4">
          <StepTitle n={2} title="Where should they be posted?" hint="Tap to select. Every video goes to all selected accounts." />
          {!accountsReady ? (
            <div className="flex items-center gap-2 text-white/40 text-sm"><Loader2 className="w-4 h-4 animate-spin" /> Loading your accounts…</div>
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
                    className={`flex items-center gap-2 px-3 py-2 rounded-xl border text-xs font-bold transition-all ${on ? 'bg-[#D1FE17]/10 border-[#D1FE17]/50 text-white' : 'bg-white/[0.03] border-white/10 text-white/40 hover:border-white/25'}`}
                  >
                    <PlatformIcon type={acc.type} size={18} />
                    {PLATFORM_META[acc.type]?.label ?? acc.type}
                    {acc.username ? <span className="text-white/30 font-medium">@{acc.username.replace(/^@/, '')}</span> : null}
                    {on && <CheckCircle2 className="w-3.5 h-3.5 text-[#D1FE17]" />}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* ── Step 3: when ──────────────────────────────────────────────────── */}
        <div className="bg-[#161616] border border-white/[0.07] rounded-3xl p-5 sm:p-6 mb-4">
          <StepTitle
            n={3}
            title="When should they go out?"
            hint={`One video is posted at each time, every day, until all videos are done. Times are in your timezone (${timezone}).`}
          />
          <div className="grid sm:grid-cols-2 gap-5">
            <div>
              <label className="text-[10px] font-black text-white/30 uppercase tracking-widest">Start date</label>
              <input
                type="date"
                value={startDate}
                min={new Date().toISOString().slice(0, 10)}
                onChange={e => setStartDate(e.target.value)}
                className="mt-2 w-full bg-[#0d0d0d] border border-white/10 focus:border-[#D1FE17]/50 rounded-2xl px-4 py-3 text-sm outline-none [color-scheme:dark]"
              />
            </div>
            <div>
              <label className="text-[10px] font-black text-white/30 uppercase tracking-widest">Posting times ({times.length}× per day)</label>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                {times.map(t => (
                  <span key={t} className="flex items-center gap-1.5 bg-[#D1FE17]/10 border border-[#D1FE17]/30 text-white text-xs font-black px-2.5 py-1.5 rounded-xl">
                    {t}
                    {times.length > 1 && (
                      <button type="button" onClick={() => setTimes(ts => ts.filter(x => x !== t))} className="text-white/40 hover:text-red-300" aria-label={`Remove ${t}`}>
                        <X className="w-3 h-3" />
                      </button>
                    )}
                  </span>
                ))}
                <input
                  type="time"
                  value={newTime}
                  onChange={e => setNewTime(e.target.value)}
                  className="bg-[#0d0d0d] border border-white/10 rounded-xl px-2 py-1.5 text-xs outline-none [color-scheme:dark]"
                />
                <button
                  type="button"
                  onClick={() => { if (newTime && !times.includes(newTime) && times.length < 12) setTimes(ts => [...ts, newTime].sort()); }}
                  className="flex items-center gap-1 text-xs font-black text-[#D1FE17] hover:bg-[#D1FE17]/10 px-2 py-1.5 rounded-xl transition-colors"
                >
                  <Plus className="w-3.5 h-3.5" /> Add time
                </button>
              </div>
            </div>
          </div>

          {/* Caption (optional) */}
          <div className="mt-5 pt-5 border-t border-white/[0.06]">
            <p className="text-[10px] font-black text-white/30 uppercase tracking-widest mb-2">Caption (optional)</p>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => setCaptionMode('filename')}
                className={`px-3 py-2 rounded-xl border text-xs font-bold transition-all ${captionMode === 'filename' ? 'bg-[#D1FE17]/10 border-[#D1FE17]/50' : 'bg-white/[0.03] border-white/10 text-white/40'}`}
              >
                Video's file name
              </button>
              <button
                type="button"
                onClick={() => setCaptionMode('custom')}
                className={`px-3 py-2 rounded-xl border text-xs font-bold transition-all ${captionMode === 'custom' ? 'bg-[#D1FE17]/10 border-[#D1FE17]/50' : 'bg-white/[0.03] border-white/10 text-white/40'}`}
              >
                Same text for all
              </button>
              {captionMode === 'custom' && (
                <input
                  value={customCaption}
                  onChange={e => setCustomCaption(e.target.value)}
                  placeholder="Caption for every video…"
                  maxLength={2000}
                  className="flex-1 min-w-[200px] bg-[#0d0d0d] border border-white/10 focus:border-[#D1FE17]/50 rounded-xl px-3 py-2 text-sm outline-none"
                />
              )}
            </div>
            {captionMode === 'filename' && (
              <p className="text-white/30 text-[11px] mt-2">e.g. "my_best_clip.mp4" becomes the caption "my best clip"</p>
            )}
          </div>
        </div>

        {/* ── Plan preview + submit ─────────────────────────────────────────── */}
        {plan && (
          <div className="bg-[#D1FE17]/[0.06] border border-[#D1FE17]/25 rounded-2xl px-4 py-3.5 mb-4 flex items-start gap-3">
            <Sparkles className="w-4 h-4 text-[#D1FE17] mt-0.5 shrink-0" />
            <div className="text-sm">
              <p className="font-black">
                {linkCount} video{linkCount === 1 ? '' : 's'} · {times.length}× per day · runs ~{plan.days} day{plan.days === 1 ? '' : 's'}
              </p>
              <p className="text-white/50 text-xs mt-0.5">
                First post {fmtAt(plan.first)} → last around {fmtDay(plan.last)}. Folder links may add more videos.
              </p>
            </div>
          </div>
        )}

        <button
          type="button"
          onClick={() => void submit()}
          disabled={submitting || accounts.length === 0}
          className="w-full flex items-center justify-center gap-2 bg-[#D1FE17] text-black font-black py-4 rounded-2xl hover:bg-[#c5f010] active:scale-[0.99] transition-all disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {submitting
            ? <><Loader2 className="w-4 h-4 animate-spin" /> Scheduling…</>
            : <><CalendarClock className="w-4 h-4" /> Schedule {linkCount > 0 ? `${linkCount} video${linkCount === 1 ? '' : 's'}` : 'videos'}</>}
        </button>
        <p className="text-center text-white/30 text-[11px] mt-2 mb-6">
          After this you can close the page — posting happens automatically, even when you're offline.
        </p>

        {banner && (
          <div className={`mb-8 rounded-2xl px-4 py-3 text-sm font-bold flex items-start gap-2.5 ${banner.kind === 'success' ? 'bg-[#D1FE17]/10 text-[#D1FE17]' : 'bg-red-500/10 text-red-300'}`}>
            {banner.kind === 'success' ? <CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0" /> : <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />}
            <div className="min-w-0">
              {banner.msg}
              {banner.skipped && (
                <button type="button" onClick={() => setShowSkipped(s => !s)} className="block mt-1 text-xs text-white/50 hover:text-white/80 font-bold">
                  {banner.skipped.length} link{banner.skipped.length === 1 ? '' : 's'} skipped {showSkipped ? <ChevronUp className="inline w-3 h-3" /> : <ChevronDown className="inline w-3 h-3" />}
                </button>
              )}
              {banner.skipped && showSkipped && (
                <ul className="mt-2 space-y-1 text-xs text-white/50 font-medium">
                  {banner.skipped.map((s, i) => (
                    <li key={i} className="truncate"><span className="text-white/70">{s.url}</span> — {s.reason}</li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        )}

        {/* ── Scheduled list ────────────────────────────────────────────────── */}
        <h2 className="text-lg font-black mb-1 mt-10">Your scheduled posts</h2>
        <p className="text-white/35 text-xs mb-4">Everything below posts automatically at its time. Cancel anything that hasn't gone out yet.</p>
        {listLoading ? (
          <div className="flex justify-center py-10"><Loader2 className="w-5 h-5 animate-spin text-white/30" /></div>
        ) : batches.length === 0 ? (
          <div className="bg-[#161616] border border-white/[0.06] rounded-2xl px-4 py-8 text-center">
            <p className="text-white/40 text-sm font-bold">Nothing scheduled yet</p>
            <p className="text-white/25 text-xs mt-1">Add links above and hit Schedule — your queue will show up here.</p>
          </div>
        ) : (
          <div className="space-y-6">
            {batches.map(([batchId, batchRows]) => (
              <BatchCard key={batchId} batchId={batchId} rows={batchRows} onCancelOne={cancelOne} onCancelBatch={cancelBatch} />
            ))}
          </div>
        )}
      </main>
    </div>
  );
}

// ── Batch card ────────────────────────────────────────────────────────────────
function BatchCard({ batchId, rows, onCancelOne, onCancelBatch }: {
  batchId: string;
  rows: SchedRow[];
  onCancelOne: (id: string) => void;
  onCancelBatch: (batchId: string) => void;
}) {
  const [showAll, setShowAll] = useState(false);
  const remaining = rows.filter(cancellable).length;
  const visible = showAll ? rows : rows.slice(0, 12);
  const now = Date.now();
  const posted = rows.filter(r => r.status === 'posted' || r.status === 'processing' || (r.status === 'scheduled' && new Date(r.post_at).getTime() <= now)).length;
  const upcoming = rows.filter(r => (r.status === 'queued' || r.status === 'creating' || r.status === 'scheduled') && new Date(r.post_at).getTime() > now).length;
  const failed = rows.filter(r => r.status === 'failed').length;

  const parts: string[] = [];
  if (posted > 0) parts.push(`${posted} posted`);
  if (upcoming > 0) parts.push(`${upcoming} scheduled`);
  if (failed > 0) parts.push(`${failed} failed`);

  return (
    <div className="bg-[#161616] border border-white/[0.07] rounded-3xl p-4 sm:p-5">
      <div className="flex items-center gap-3 mb-3">
        <div className="flex-1 min-w-0">
          <p className="text-sm font-black">{rows.length} video{rows.length === 1 ? '' : 's'}</p>
          <p className="text-white/35 text-xs mt-0.5">
            {fmtAt(rows[0].post_at)} → {fmtAt(rows[rows.length - 1].post_at)}
            {parts.length > 0 && ` · ${parts.join(' · ')}`}
          </p>
        </div>
        {remaining > 0 && (
          <button
            type="button"
            onClick={() => onCancelBatch(batchId)}
            className="shrink-0 text-xs font-black text-white/40 hover:text-red-300 border border-white/10 hover:border-red-400/40 px-3 py-2 rounded-xl transition-colors"
          >
            Cancel remaining ({remaining})
          </button>
        )}
      </div>
      <div className="space-y-1.5">
        {visible.map(r => (
          <div key={r.id} className={`flex items-center gap-3 bg-[#1a1a1a] rounded-xl px-3 py-2.5 ${r.status === 'cancelled' ? 'opacity-40' : ''}`}>
            <div className="flex-1 min-w-0">
              <p className={`text-xs font-bold truncate ${r.status === 'cancelled' ? 'line-through' : ''}`}>{r.file_name}</p>
              <p className="text-white/35 text-[11px] mt-0.5 truncate">
                {fmtAt(r.post_at)}
                {r.platforms.length > 0 && ` · ${r.platforms.join(', ')}`}
                {r.status === 'failed' && r.error ? ` · ${r.error}` : ''}
              </p>
            </div>
            <StatusChip row={r} />
            {cancellable(r) && (
              <button
                type="button"
                onClick={() => onCancelOne(r.id)}
                aria-label="Cancel this post"
                className="shrink-0 w-7 h-7 flex items-center justify-center rounded-lg text-white/25 hover:text-red-300 hover:bg-white/5 transition-colors"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        ))}
        {rows.length > 12 && (
          <button type="button" onClick={() => setShowAll(s => !s)} className="w-full text-center text-xs font-black text-white/40 hover:text-white/70 py-2">
            {showAll ? 'Show less' : `Show all ${rows.length}`}
          </button>
        )}
      </div>
    </div>
  );
}
