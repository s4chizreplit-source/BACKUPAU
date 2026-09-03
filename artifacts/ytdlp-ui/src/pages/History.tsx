/**
 * My videos — full-screen history page (replaces the old slide-in drawer).
 *
 * Account-scoped: signing in is required, and every section only shows clips
 * made by the signed-in account.
 * Section 1: this account's clips saved on this device (localStorage) —
 *            always-open big grid, playable + downloadable immediately.
 * Section 2: sessions saved to the account (server history) — reuses the same
 *            HistoryPanel the drawer used (dedupes twins of section 1,
 *            regenerate / delete / expired states).
 *
 * "Regenerate" hands the job settings back to the clipper via sessionStorage
 * (`autocliper_rerun`) and navigates home — ClipperPage picks it up on mount.
 */
import { useEffect, useState } from 'react';
import { Link, useLocation } from 'wouter';
import { ArrowLeft, Download, History as HistoryIcon, Plus, Scissors, X } from 'lucide-react';
import { apiFetch, useAuth } from '../lib/auth';
import {
  API,
  ClipCard,
  HistoryPanel,
  SourceBadge,
  VideoModal,
  clearRecentJobs,
  deleteRecentJob,
  fmtDateTime,
  loadRecentJobs,
  sourceInfo,
  useClipPostStatuses,
} from './ClipperPage';
import { toUiAccounts, type ApiSocialAccount, type Clip, type RecentJob, type SocialAccount } from './ClipperPage';

export default function HistoryPage() {
  const { user, loading } = useAuth();
  const [, setLocation] = useLocation();
  const [recentJobs, setRecentJobs] = useState<RecentJob[]>([]);
  const [playingClip, setPlayingClip] = useState<Clip | null>(null);
  // Live "Posted ✓ / Publishing…" badges for this device's clips.
  const deviceClipIds = recentJobs.flatMap(j => j.clips).map(c => c.id);
  const { statuses: devicePostStatuses } = useClipPostStatuses(deviceClipIds, !!user && deviceClipIds.length > 0);

  // Device history is account-scoped — (re)load it once we know who's signed
  // in. Signed out → always empty, no matter what this browser stored.
  useEffect(() => {
    setRecentJobs(loadRecentJobs(user?.id));
  }, [user?.id]);

  // Connected social accounts — lets every clip card open the platform picker
  // so old clips can be posted to selected platforms any time. Posting stays
  // locked until discovery resolves so a fast click can never blind-post to
  // every account, and late responses after a user switch are dropped.
  const [socialAccounts, setSocialAccounts] = useState<SocialAccount[]>([]);
  const [socialReady, setSocialReady] = useState(false);
  useEffect(() => {
    setSocialAccounts([]);
    setSocialReady(false);
    if (!user) return;
    let stale = false;
    (async () => {
      try {
        const s = await apiFetch<{ hasAccounts: boolean }>('/social/status');
        if (stale) return;
        if (s.hasAccounts) {
          const d = await apiFetch<{ accounts: ApiSocialAccount[] }>('/social/accounts');
          if (stale) return;
          setSocialAccounts(toUiAccounts(d.accounts));
        }
        setSocialReady(true);
      } catch { /* discovery failed — keep posting locked instead of blind-posting */ }
    })();
    return () => { stale = true; };
  }, [user?.id]);

  const totalDeviceClips = recentJobs.reduce((n, j) => n + j.clips.length, 0);

  const handleRerun = (url: string, platform: string, clipDuration: number, clipCount: number) => {
    try {
      sessionStorage.setItem('autocliper_rerun', JSON.stringify({ url, platform, clipDuration, clipCount }));
    } catch { /* storage full/blocked — user just lands on an empty form */ }
    setLocation('/');
    window.scrollTo({ top: 0 });
  };

  return (
    <div className="min-h-screen bg-[#0d0d0d] text-white font-sans">
      {playingClip && (
        <VideoModal clip={playingClip} onClose={() => setPlayingClip(null)} />
      )}

      {/* ── Top bar ───────────────────────────────────────────────────────── */}
      <nav className="sticky top-0 z-40 border-b border-white/5 bg-[#0d0d0d]/90 backdrop-blur-xl">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 h-14 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3 min-w-0">
            <Link
              href="/"
              className="flex items-center gap-2 text-sm font-semibold text-white/60 hover:text-white transition-colors shrink-0"
            >
              <ArrowLeft className="w-4 h-4" />
              <span className="hidden sm:inline">Back</span>
            </Link>
            <span className="w-px h-5 bg-white/10 shrink-0" />
            <Link href="/" className="flex items-center gap-2 min-w-0">
              <div className="w-7 h-7 rounded-lg bg-[#D1FE17] flex items-center justify-center shrink-0">
                <Scissors className="w-4 h-4 text-black" strokeWidth={2.5} />
              </div>
              <span className="font-black text-lg tracking-tight truncate">AutoCliper</span>
            </Link>
          </div>
          <div className="flex items-center gap-3 shrink-0">
            {user ? (
              <>
                <div className="hidden md:flex items-center gap-0.5 px-1.5 py-1.5 rounded-full border border-white/[0.07] bg-white/[0.03] text-sm font-semibold text-white/50">
                  <Link href="/" className="px-4 py-1.5 rounded-full hover:text-white hover:bg-white/[0.06] transition-all duration-150">Home</Link>
                  <Link href="/history" className="px-4 py-1.5 rounded-full text-white bg-white/[0.08] transition-all duration-150">My videos</Link>
                  <Link href="/autopilot" className="px-4 py-1.5 rounded-full hover:text-white hover:bg-white/[0.06] transition-all duration-150">Auto-Pilot</Link>
                  <Link href="/social" className="px-4 py-1.5 rounded-full hover:text-white hover:bg-white/[0.06] transition-all duration-150">Social</Link>
                </div>
                {/* Credits chip removed from navs — credits live in the avatar
                    menu on Home / inner pages (user request). */}
              </>
            ) : !loading && (
              <Link
                href="/login"
                className="text-sm font-semibold text-white/60 hover:text-white transition-colors"
              >Sign in</Link>
            )}
          </div>
        </div>
      </nav>

      <main className="max-w-6xl mx-auto px-4 sm:px-6 py-8 sm:py-10">
        {/* ── Page header ─────────────────────────────────────────────────── */}
        <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4 mb-8">
          <div>
            <h1 className="text-3xl sm:text-4xl font-black tracking-tight">My videos</h1>
            <p className="text-white/40 text-sm mt-2">
              {user
                ? 'Saved on this device & to your account · clips saved permanently'
                : 'Sign in to see the clips saved to your account'}
            </p>
          </div>
          <Link
            href="/"
            className="inline-flex items-center justify-center gap-2 bg-[#D1FE17] text-black text-sm font-black px-4 py-2.5 rounded-xl hover:bg-[#c5f010] active:scale-95 transition-all shrink-0"
          >
            <Plus className="w-4 h-4" strokeWidth={3} />
            New clips
          </Link>
        </div>

        {/* ── Section 1: this account's clips on this device ──────────────── */}
        {user && recentJobs.length > 0 && (
          <section className="mb-10">
            <div className="flex items-center justify-between mb-3 px-1">
              <p className="text-white/40 text-[11px] font-black uppercase tracking-widest">
                On this device · ready to download
                {totalDeviceClips > 0 && <span className="ml-2 text-[#D1FE17]">{totalDeviceClips} clips</span>}
              </p>
              <button
                onClick={() => { clearRecentJobs(user.id); setRecentJobs([]); }}
                className="text-white/30 hover:text-red-400 text-xs font-semibold transition-colors"
              >Clear all</button>
            </div>

            <div className="space-y-8">
              {recentJobs.map(job => {
                const info = sourceInfo(job.url);
                const meta = [
                  `${job.clips.length} ${job.clips.length === 1 ? 'clip' : 'clips'}`,
                  job.totalDuration ? `${job.totalDuration} video` : undefined,
                  job.date > 0 ? fmtDateTime(job.date) : undefined,
                  info.sub ?? undefined,
                ].filter(Boolean).join(' · ');
                return (
                  <div key={job.id}>
                    {/* Job header row */}
                    <div className="flex items-center gap-3 mb-3">
                      <SourceBadge kind={info.kind} />
                      <div className="flex-1 min-w-0">
                        <p className="text-white/90 text-sm font-bold truncate">{info.label}</p>
                        <p className="text-white/35 text-xs mt-0.5 truncate">{meta}</p>
                      </div>
                      <a
                        href={`${API}/video/zip?ids=${job.clips.map(c => c.id).join(',')}`}
                        download="clips.zip"
                        className="shrink-0 flex items-center gap-2 bg-[#D1FE17] text-black text-xs font-black px-3.5 py-2 rounded-xl hover:bg-[#c5f010] active:scale-95 transition-all"
                      >
                        <Download className="w-3.5 h-3.5" />
                        <span className="hidden sm:inline">Download all</span> ({job.clips.length})
                      </a>
                      <button
                        onClick={() => setRecentJobs(deleteRecentJob(job.id, user.id))}
                        className="shrink-0 w-8 h-8 flex items-center justify-center rounded-lg text-white/20 hover:text-red-400 hover:bg-white/5 transition-colors"
                        aria-label="Delete this video's clips"
                      >
                        <X className="w-4 h-4" />
                      </button>
                    </div>
                    {/* Big clip grid */}
                    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3 sm:gap-4">
                      {job.clips.map((clip, i) => (
                        <ClipCard key={clip.id} clip={clip} index={i} onPlay={() => setPlayingClip(clip)} socialAccounts={socialAccounts} socialAccountsReady={socialReady} postStatus={devicePostStatuses[clip.id]} />
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        )}

        {/* ── Section 2: account history ──────────────────────────────────── */}
        {user && (
          <section>
            <HistoryPanel
              onRerun={handleRerun}
              onPlay={clip => setPlayingClip(clip)}
              localJobs={recentJobs}
              socialAccounts={socialAccounts}
              socialAccountsReady={socialReady}
            />
          </section>
        )}

        {/* ── Signed out — history is private to each account ─────────────── */}
        {!user && !loading && (
          <div className="text-center py-20">
            <div className="w-14 h-14 mx-auto mb-4 rounded-2xl bg-white/[0.05] border border-white/10 flex items-center justify-center">
              <HistoryIcon className="w-6 h-6 text-white/30" />
            </div>
            <p className="text-white/70 font-bold">Sign in to see your videos</p>
            <p className="text-white/40 text-sm mt-1 mb-6 max-w-sm mx-auto">
              Clips are saved to the account that made them — sign in and they'll
              be right here on any device.
            </p>
            <div className="flex flex-wrap items-center justify-center gap-3">
              <Link
                href="/login"
                className="inline-flex items-center gap-2 bg-[#D1FE17] text-black text-sm font-black px-5 py-3 rounded-xl hover:bg-[#c5f010] active:scale-95 transition-all"
              >
                Sign in
              </Link>
              <Link
                href="/signup"
                className="inline-flex items-center gap-2 border border-white/15 text-white text-sm font-black px-5 py-3 rounded-xl hover:border-[#D1FE17]/60 hover:text-[#D1FE17] transition-colors"
              >
                Create free account
              </Link>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
