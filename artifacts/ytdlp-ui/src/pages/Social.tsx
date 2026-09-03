/**
 * Social accounts page — connect accounts via Post for Me OAuth links,
 * manage per-account auto-posting, disconnect, and jump to the scheduler.
 *
 * Multiple accounts per platform are first-class: each platform card lists
 * every connected account and always offers "+ Connect another". The OAuth
 * flow leaves the app (window.location = provider URL) and lands back on
 * /social?connected=1&added=N or /social?error=… via the API callback.
 */
import { useEffect, useMemo, useState } from 'react';
import { Link, useLocation } from 'wouter';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, Share2, CalendarClock, Plus, X, Check, CheckCircle2, ArrowRight, Zap } from 'lucide-react';
import { apiFetch, useAuth } from '../lib/auth';
import { AppHeader } from '../components/AppHeader';
import { PlatformIcon, PLATFORM_META, ALL_PLATFORM_KEYS } from '../components/PlatformIcons';

interface ApiAccount {
  id: string;
  platform: string;               // lowercase from the API
  username?: string | null;
  displayName?: string | null;
  profileImage?: string | null;
  status: string;
  autopostEnabled: boolean;
}
interface StatusData {
  configured: boolean; hasAccounts: boolean;
  accountCount: number; activeCount: number; autoPostEnabled: boolean;
}

function Toggle({ on, busy, onClick, title }: { on: boolean; busy?: boolean; onClick: () => void; title?: string }) {
  return (
    <button
      onClick={onClick}
      disabled={busy}
      title={title}
      className={`relative shrink-0 w-10 h-5 rounded-full transition-colors ${on ? 'bg-[#D1FE17]' : 'bg-white/15'} ${busy ? 'opacity-50' : ''}`}
    >
      <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow-sm transition-transform ${on ? 'translate-x-[22px]' : 'translate-x-0.5'}`} />
    </button>
  );
}

export default function Social() {
  const { user, loading } = useAuth();
  const [, setLocation] = useLocation();
  const qc = useQueryClient();

  // ── OAuth-return banner (?connected=1&added=N or ?error=…) ─────────────────
  const [banner, setBanner] = useState<{ kind: 'success' | 'error'; msg: string } | null>(null);
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('connected')) {
      const added = Number(params.get('added') ?? '0');
      setBanner({
        kind: 'success',
        msg: added > 0
          ? `Connected ${added} account${added !== 1 ? 's' : ''} 🎉 New clips can now auto-post here.`
          : 'Connection completed.',
      });
    } else if (params.get('error')) {
      setBanner({ kind: 'error', msg: params.get('error') ?? 'Connection failed' });
    }
    if (params.get('connected') || params.get('error')) {
      window.history.replaceState(null, '', window.location.pathname);
    }
  }, []);

  // ── Data ────────────────────────────────────────────────────────────────────
  const { data: status } = useQuery({
    queryKey: ['social-status'],
    queryFn: () => apiFetch<StatusData>('/social/status'),
    enabled: !!user,
    retry: false,
  });
  const { data: accountsData, isLoading: accountsLoading } = useQuery({
    queryKey: ['social-accounts'],
    queryFn: () => apiFetch<{ accounts: ApiAccount[] }>('/social/accounts'),
    enabled: !!user,
    retry: false,
  });
  const accounts = useMemo(
    () => (accountsData?.accounts ?? []).filter(a => a.status === 'connected'),
    [accountsData],
  );

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['social-accounts'] });
    void qc.invalidateQueries({ queryKey: ['social-status'] });
  };

  // ── Mutations ───────────────────────────────────────────────────────────────
  const [connecting, setConnecting] = useState<string | null>(null);
  // Coming BACK from the OAuth screen (phone back-gesture / cancel) restores
  // this page from the browser's back-forward cache with `connecting` still
  // set — which left EVERY Connect button disabled. Reset on every pageshow.
  useEffect(() => {
    const reset = () => setConnecting(null);
    window.addEventListener('pageshow', reset);
    return () => window.removeEventListener('pageshow', reset);
  }, []);
  // connectionType picks the login variant where a platform has two
  // (Instagram: direct login vs via Facebook — mirrors the provider's options).
  async function connect(platformKey: string, connectionType?: string) {
    if (connecting) return;
    setConnecting(connectionType ? `${platformKey}:${connectionType}` : platformKey);
    setBanner(null);
    try {
      const r = await apiFetch<{ url: string }>('/social/connect', {
        method: 'POST',
        body: JSON.stringify({
          platform: platformKey.toLowerCase(),
          ...(connectionType ? { connectionType } : {}),
        }),
      });
      window.location.href = r.url; // off to the platform's OAuth screen
      // Safety: if the navigation is blocked or slow, don't leave the
      // buttons dead — re-enable after a moment.
      window.setTimeout(() => setConnecting(null), 12000);
    } catch (e) {
      setBanner({ kind: 'error', msg: e instanceof Error ? e.message : 'Could not start the connection — try again.' });
      setConnecting(null);
    }
  }

  const toggleAccount = useMutation({
    mutationFn: ({ id, autopostEnabled }: { id: string; autopostEnabled: boolean }) =>
      apiFetch(`/social/accounts/${id}`, { method: 'PATCH', body: JSON.stringify({ autopostEnabled }) }),
    onSuccess: invalidate,
  });
  const disconnect = useMutation({
    mutationFn: (accountId: string) =>
      apiFetch('/social/disconnect', { method: 'POST', body: JSON.stringify({ accountId }) }),
    onSuccess: invalidate,
    onError: (e) => setBanner({ kind: 'error', msg: e instanceof Error ? e.message : 'Disconnect failed — try again.' }),
  });
  const masterToggle = useMutation({
    mutationFn: (autoPostEnabled: boolean) =>
      apiFetch('/social/prefs', { method: 'PATCH', body: JSON.stringify({ autoPostEnabled }) }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['social-status'] }),
  });

  // ── Signed-out view ─────────────────────────────────────────────────────────
  if (!loading && !user) {
    return (
      <div className="min-h-screen bg-[#0d0d0d] text-white overflow-x-hidden">
        <AppHeader />
        <div className="max-w-lg mx-auto px-4 pt-24 text-center">
          <div className="w-14 h-14 rounded-2xl bg-[#D1FE17]/10 border border-[#D1FE17]/25 flex items-center justify-center mx-auto mb-5">
            <Share2 className="w-6 h-6 text-[#D1FE17]" />
          </div>
          <h1 className="text-2xl font-black">Auto-post your clips</h1>
          <p className="text-white/40 text-sm mt-2 leading-relaxed">
            Connect Instagram, TikTok, YouTube and more — every clip you generate
            can go straight to your accounts, hands-free.
          </p>
          <button
            onClick={() => setLocation('/login?next=/social')}
            className="mt-6 inline-flex items-center gap-2 bg-[#D1FE17] text-black font-black text-sm px-6 py-3 rounded-xl hover:bg-[#c5f010] active:scale-95 transition-all"
          >
            Sign in to connect <ArrowRight className="w-4 h-4" />
          </button>
        </div>
      </div>
    );
  }

  const byPlatform = new Map<string, ApiAccount[]>();
  for (const a of accounts) {
    const key = (a.platform || '').toUpperCase();
    byPlatform.set(key, [...(byPlatform.get(key) ?? []), a]);
  }
  const autoPostOn = status?.autoPostEnabled ?? true;
  // When the server has no posting key, Connect buttons are disabled — make
  // that VISIBLE (dim + tooltip) instead of leaving bright buttons that
  // silently ignore taps.
  const notConfigured = status?.configured === false;

  return (
    <div className="min-h-screen bg-[#0d0d0d] text-white overflow-x-hidden">
      <AppHeader />
      <div className="max-w-3xl mx-auto px-4 pt-8 pb-24">

        {/* Title */}
        <div className="mb-6">
          <h1 className="text-2xl sm:text-3xl font-black">Social accounts</h1>
          <p className="text-white/40 text-sm mt-1.5">
            Connect once — new clips auto-post to every account with auto-post on.
            You can also pick accounts per clip when posting manually.
          </p>
        </div>

        {/* OAuth-return / error banner */}
        {banner && (
          <div className={`flex items-start gap-3 rounded-2xl border px-4 py-3.5 mb-6 ${
            banner.kind === 'success'
              ? 'bg-[#D1FE17]/10 border-[#D1FE17]/25 text-[#D1FE17]'
              : 'bg-red-500/10 border-red-400/25 text-red-300'
          }`}>
            {banner.kind === 'success' ? <Check className="w-4 h-4 mt-0.5 shrink-0" /> : <X className="w-4 h-4 mt-0.5 shrink-0" />}
            <p className="text-sm font-semibold flex-1">{banner.msg}</p>
            <button onClick={() => setBanner(null)} className="text-current/50 hover:text-current shrink-0">
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        )}

        {/* Not configured on the server */}
        {status && !status.configured && (
          <div className="bg-[#1a1a1a] border border-white/10 rounded-2xl px-4 py-3.5 mb-6">
            <p className="text-sm text-white/50">
              Social posting isn't configured on this server yet — check back soon.
            </p>
          </div>
        )}

        {/* Master auto-post toggle + account picker */}
        <div className="bg-[#161616] border border-white/8 rounded-2xl p-5 mb-6">
          <div className="flex items-center gap-4">
            <div className={`w-11 h-11 rounded-xl flex items-center justify-center shrink-0 ${autoPostOn ? 'bg-[#D1FE17]/15' : 'bg-white/5'}`}>
              <Zap className={`w-5 h-5 ${autoPostOn ? 'text-[#D1FE17]' : 'text-white/25'}`} />
            </div>
            <div className="flex-1 min-w-0">
              <p className="font-black text-sm">Auto-post new clips</p>
              <p className="text-white/40 text-xs mt-0.5">
                {autoPostOn
                  ? 'Every clip you generate — from YouTube, Drive, uploads, anywhere — is posted automatically to the ticked accounts. Manual posting still works too.'
                  : 'Off — clips only post when you tap "Post to social"'}
              </p>
            </div>
            <Toggle
              on={autoPostOn}
              busy={masterToggle.isPending}
              onClick={() => masterToggle.mutate(!autoPostOn)}
              title={autoPostOn ? 'Turn auto-posting off' : 'Turn auto-posting on'}
            />
          </div>

          {/* Which accounts get every new clip — tap to tick/untick */}
          {autoPostOn && accounts.length > 0 && (
            <div className="mt-4 pt-4 border-t border-white/[0.06]">
              <p className="text-[10px] font-black text-white/30 uppercase tracking-widest mb-2">Auto-posts to</p>
              <div className="flex flex-wrap gap-2">
                {accounts.map((acc) => {
                  const handle = acc.username
                    ? (acc.username.startsWith('@') ? acc.username : `@${acc.username}`)
                    : (acc.displayName ?? 'Account');
                  const busy = toggleAccount.isPending && toggleAccount.variables?.id === acc.id;
                  return (
                    <button
                      key={acc.id}
                      type="button"
                      disabled={busy}
                      onClick={() => toggleAccount.mutate({ id: acc.id, autopostEnabled: !acc.autopostEnabled })}
                      title={acc.autopostEnabled ? 'Auto-post on — tap to exclude' : 'Excluded — tap to include'}
                      className={`flex items-center gap-2 px-3 py-2 rounded-xl border text-xs font-bold transition-colors ${
                        acc.autopostEnabled
                          ? 'bg-[#D1FE17]/10 border-[#D1FE17]/50 text-white'
                          : 'bg-[#0f0f0f] border-white/[0.07] text-white/45 hover:border-white/20'
                      } ${busy ? 'opacity-50' : ''}`}
                    >
                      <PlatformIcon type={acc.platform} size={14} />
                      <span className="truncate max-w-[140px]">{handle}</span>
                      {busy
                        ? <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0" />
                        : acc.autopostEnabled
                          ? <CheckCircle2 className="w-3.5 h-3.5 text-[#D1FE17] shrink-0" />
                          : <span className="w-3.5 h-3.5 rounded-full border border-white/20 shrink-0" />}
                    </button>
                  );
                })}
              </div>
              {accounts.every((a) => !a.autopostEnabled) && (
                <p className="text-amber-300/80 text-[11px] font-bold mt-2.5">
                  No accounts ticked — new clips won't auto-post anywhere until you tick one.
                </p>
              )}
            </div>
          )}
        </div>

        {/* Platform cards */}
        <p className="text-[11px] font-black text-white/30 uppercase tracking-widest mb-3">
          Platforms
        </p>
        <div className="space-y-3">
          {ALL_PLATFORM_KEYS.map((key) => {
            const list = byPlatform.get(key) ?? [];
            const meta = PLATFORM_META[key];
            const isConnecting = connecting === key;
            return (
              <div key={key} className="bg-[#161616] border border-white/8 rounded-2xl p-4">
                <div className="flex flex-wrap items-center gap-3">
                  <PlatformIcon type={key} size={34} />
                  <div className="flex-1 min-w-0">
                    <p className="font-black text-sm">{meta?.label ?? key}</p>
                    <p className="text-white/30 text-xs mt-0.5">
                      {list.length === 0
                        ? 'Not connected'
                        : `${list.length} account${list.length !== 1 ? 's' : ''} connected`}
                    </p>
                  </div>
                  {key === 'INSTAGRAM' ? (
                    /* Instagram has two login variants, same as the provider:
                       direct Instagram login, or via a linked Facebook Page. */
                    <div className="flex flex-col sm:flex-row gap-2 shrink-0">
                      {([['instagram', 'Instagram login'], ['facebook', 'Facebook login']] as const).map(([ct, label]) => {
                        const busy = connecting === `${key}:${ct}`;
                        return (
                          <button
                            key={ct}
                            onClick={() => void connect(key, ct)}
                            disabled={!!connecting || notConfigured}
                            title={notConfigured ? "Social posting isn't set up on this server yet" : undefined}
                            className={`flex items-center justify-center gap-1.5 text-xs font-black px-3.5 py-2 rounded-xl transition-all active:scale-95 ${
                              list.length === 0 && ct === 'instagram'
                                ? 'bg-[#D1FE17] text-black hover:bg-[#c5f010]'
                                : 'bg-white/5 text-white/70 hover:bg-white/10'
                            } ${(connecting && !busy) || notConfigured ? 'opacity-40 cursor-not-allowed' : ''}`}
                          >
                            {busy
                              ? <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Opening…</>
                              : list.length === 0
                                ? <>{label}</>
                                : <><Plus className="w-3.5 h-3.5" /> {label}</>}
                          </button>
                        );
                      })}
                    </div>
                  ) : (
                    <button
                      onClick={() => void connect(key)}
                      disabled={!!connecting || notConfigured}
                      title={notConfigured ? "Social posting isn't set up on this server yet" : undefined}
                      className={`flex items-center gap-1.5 text-xs font-black px-3.5 py-2 rounded-xl transition-all active:scale-95 shrink-0 ${
                        list.length === 0
                          ? 'bg-[#D1FE17] text-black hover:bg-[#c5f010]'
                          : 'bg-white/5 text-white/70 hover:bg-white/10'
                      } ${(connecting && !isConnecting) || notConfigured ? 'opacity-40 cursor-not-allowed' : ''}`}
                    >
                      {isConnecting
                        ? <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Opening…</>
                        : list.length === 0
                          ? <>Connect</>
                          : <><Plus className="w-3.5 h-3.5" /> Connect another</>}
                    </button>
                  )}
                </div>

                {/* Connected accounts for this platform */}
                {list.length > 0 && (
                  <div className="mt-3 space-y-2">
                    {list.map((acc) => {
                      const handle = acc.username
                        ? (acc.username.startsWith('@') ? acc.username : `@${acc.username}`)
                        : (acc.displayName ?? 'Connected account');
                      const toggling = toggleAccount.isPending && toggleAccount.variables?.id === acc.id;
                      const disconnecting = disconnect.isPending && disconnect.variables === acc.id;
                      return (
                        <div key={acc.id} className="flex items-center gap-3 bg-[#0f0f0f] border border-white/5 rounded-xl px-3 py-2.5">
                          {acc.profileImage ? (
                            <img src={acc.profileImage} alt="" className="w-7 h-7 rounded-full object-cover shrink-0" />
                          ) : (
                            <div className="w-7 h-7 rounded-full bg-white/5 flex items-center justify-center text-[11px] shrink-0">👤</div>
                          )}
                          <div className="flex-1 min-w-0">
                            <p className="text-xs font-bold truncate">{handle}</p>
                            {acc.displayName && acc.username && acc.displayName !== acc.username && (
                              <p className="text-white/25 text-[11px] truncate">{acc.displayName}</p>
                            )}
                          </div>
                          <div className="flex items-center gap-2.5 shrink-0">
                            <span className="text-[10px] text-white/25 font-bold uppercase tracking-wide">
                              Auto-post
                            </span>
                            <Toggle
                              on={acc.autopostEnabled}
                              busy={toggling}
                              onClick={() => toggleAccount.mutate({ id: acc.id, autopostEnabled: !acc.autopostEnabled })}
                              title={acc.autopostEnabled ? 'Exclude from auto-posting' : 'Include in auto-posting'}
                            />
                            <button
                              onClick={() => {
                                if (window.confirm(`Disconnect ${handle}? Scheduled posts to this account will stop.`)) {
                                  disconnect.mutate(acc.id);
                                }
                              }}
                              disabled={disconnecting}
                              title="Disconnect this account"
                              className="text-white/25 hover:text-red-300 transition-colors"
                            >
                              {disconnecting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <X className="w-3.5 h-3.5" />}
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {accountsLoading && (
          <div className="flex items-center gap-2 text-white/30 text-xs mt-4">
            <Loader2 className="w-3.5 h-3.5 animate-spin" /> Syncing accounts…
          </div>
        )}

        {/* Bulk scheduler link */}
        <Link
          href="/schedule"
          className="mt-6 flex items-center gap-4 bg-[#161616] border border-white/8 rounded-2xl p-5 hover:border-[#D1FE17]/30 transition-colors group"
        >
          <div className="w-11 h-11 rounded-xl bg-[#D1FE17]/10 flex items-center justify-center shrink-0">
            <CalendarClock className="w-5 h-5 text-[#D1FE17]" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="font-black text-sm">Bulk scheduler</p>
            <p className="text-white/40 text-xs mt-0.5">
              Paste a Drive/Dropbox folder — we spread the videos across posting slots automatically
            </p>
          </div>
          <ArrowRight className="w-4 h-4 text-white/25 group-hover:text-[#D1FE17] group-hover:translate-x-0.5 transition-all shrink-0" />
        </Link>

        {/* Honest platform notes */}
        <div className="mt-6 bg-[#131313] border border-white/5 rounded-2xl p-4">
          <p className="text-[11px] font-black text-white/30 uppercase tracking-widest mb-2">Good to know</p>
          <ul className="text-white/35 text-xs leading-relaxed space-y-1 list-disc list-inside">
            <li>Instagram needs a <span className="text-white/55">Professional (Creator/Business)</span> account.</li>
            <li>Facebook &amp; LinkedIn: connecting imports every page you manage — disconnect the ones you don't want.</li>
            <li>X and Bluesky have short video-length limits; long clips may be rejected by the platform.</li>
            <li>Each connect link is single-use — tap Connect again if you cancel midway.</li>
            <li>Instagram: use <b>Facebook login</b> if your Instagram is linked to a Facebook Page; otherwise the direct <b>Instagram login</b> works.</li>
          </ul>
        </div>
      </div>
    </div>
  );
}
