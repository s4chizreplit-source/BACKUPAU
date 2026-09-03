/**
 * Admin panel — stats, manual billing-request approvals, and user management.
 * The API guards every /admin route with requireAdmin; this page additionally
 * only renders for signed-in admins.
 */
import { useEffect, useState } from 'react';
import { useLocation } from 'wouter';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Loader2, Shield, Users, Inbox, Zap, Search, Check, X, ChevronLeft, RefreshCw, Share2, Plus,
  Upload,
} from 'lucide-react';
import { AppHeader } from '../components/AppHeader';
import { apiFetch, useAuth, type AuthUser } from '../lib/auth';
import {
  type BillingRequest,
  type BillingInterval,
  type Catalog,
  type CatalogPlan,
  type LedgerEntry,
  type UpiOrder,
  fmtDate,
  fmtDateTime,
  fmtInr,
  PLAN_NAMES,
  reasonLabel,
  requestLabel,
} from '../lib/billingTypes';

interface AdminStats {
  users: number;
  activeSubscriptions: number;
  pendingRequests: number;
  creditsUsed30d: number;
}
interface AdminUserDetail {
  user: AuthUser;
  ledger: LedgerEntry[];
  requests: BillingRequest[];
}

const REQ_STATUS_STYLES: Record<string, string> = {
  pending: 'bg-amber-400/10 text-amber-300 border-amber-400/25',
  approved: 'bg-[#D1FE17]/10 text-[#D1FE17] border-[#D1FE17]/25',
  rejected: 'bg-red-500/10 text-red-400 border-red-500/25',
  cancelled: 'bg-white/5 text-white/40 border-white/10',
};

function Chip({ children, tone = 'neutral' }: { children: React.ReactNode; tone?: string }) {
  const styles: Record<string, string> = {
    neutral: 'bg-white/5 text-white/50 border-white/10',
    lime: 'bg-[#D1FE17]/10 text-[#D1FE17] border-[#D1FE17]/25',
    red: 'bg-red-500/10 text-red-400 border-red-500/25',
    amber: 'bg-amber-400/10 text-amber-300 border-amber-400/25',
  };
  return (
    <span className={`text-[10px] font-black uppercase tracking-wide px-2 py-0.5 rounded-full border ${styles[tone] ?? styles.neutral}`}>
      {children}
    </span>
  );
}

const inputCls =
  'bg-[#111] border border-white/10 rounded-xl px-3 py-2 text-sm text-white placeholder-white/25 focus:outline-none focus:border-[#D1FE17]/50 w-full';
const btnCls =
  'px-3 py-2 rounded-xl text-sm font-black transition-all disabled:opacity-50 disabled:cursor-not-allowed';

interface YoutubeCookieStatus {
  configured: boolean;
  source: string;
  youtubeCookieCount: number;
  updatedAt: string | null;
}

function YoutubeCookiesCard() {
  const [status, setStatus] = useState<YoutubeCookieStatus | null>(null);
  const [cookieText, setCookieText] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);

  const refreshStatus = () => {
    apiFetch<YoutubeCookieStatus>('/ytdlp/cookies/status')
      .then(setStatus)
      .catch(() => setMessage({ tone: 'error', text: 'Could not check cookie status.' }));
  };

  useEffect(() => {
    refreshStatus();
  }, []);

  const saveCookieText = async (contents: string) => {
    setMessage(null);
    if (new Blob([contents]).size > 1024 * 1024) {
      setMessage({ tone: 'error', text: 'That cookie text is too large. Paste less than 1 MB.' });
      return;
    }
    setBusy(true);
    try {
      const result = await apiFetch<{ status: YoutubeCookieStatus }>('/ytdlp/cookies', {
        method: 'POST',
        body: JSON.stringify({ cookies: contents }),
      });
      setStatus(result.status);
      setCookieText('');
      setMessage({
        tone: 'ok',
        text: 'YouTube cookies saved. Retry the 1080p clip now.',
      });
    } catch (err) {
      setMessage({
        tone: 'error',
        text: err instanceof Error ? err.message : 'Could not save those cookies.',
      });
    } finally {
      setBusy(false);
    }
  };

  const uploadCookies = async (file: File) => {
    if (file.size > 1024 * 1024) {
      setMessage({ tone: 'error', text: 'That file is too large. Choose a cookies.txt file under 1 MB.' });
      return;
    }
    await saveCookieText(await file.text());
  };

  return (
    <section className="mt-6 rounded-2xl border border-[#D1FE17]/20 bg-[#D1FE17]/[0.04] p-5 sm:p-6">
      <div className="flex items-start gap-3">
        <span className="w-10 h-10 shrink-0 rounded-xl bg-[#D1FE17]/10 border border-[#D1FE17]/20 flex items-center justify-center">
          <Shield className="w-5 h-5 text-[#D1FE17]" />
        </span>
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h2 className="text-base font-black">YouTube HD cookies</h2>
            {status?.configured && (
              <Chip tone="lime">Active · {status.youtubeCookieCount} cookies</Chip>
            )}
          </div>
          <p className="text-white/55 text-sm mt-1 leading-relaxed">
             Use this only when YouTube limits a video to 360p. Paste the cookie text directly below, or upload a file. Cookie values are never shown back.
          </p>
        </div>
      </div>

      <textarea
        value={cookieText}
        onChange={e => setCookieText(e.target.value)}
        placeholder={'# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tTRUE\t...\t...\t...'}
        aria-label="YouTube Netscape cookies text"
        spellCheck={false}
        disabled={busy}
        rows={7}
        className={`${inputCls} mt-4 min-h-32 resize-y font-mono text-xs leading-relaxed`}
      />
      <button
        type="button"
        disabled={busy || !cookieText.trim()}
        onClick={() => void saveCookieText(cookieText)}
        className={`mt-2 ${btnCls} bg-[#D1FE17] text-black hover:bg-[#e1ff62]`}
      >
        {busy ? 'Saving securely…' : 'Save pasted cookies'}
      </button>

      <div className="flex items-center gap-3 my-4 text-[11px] text-white/30">
        <span className="h-px flex-1 bg-white/10" />
        <span>OR UPLOAD FILE</span>
        <span className="h-px flex-1 bg-white/10" />
      </div>

      <label
        className={`mt-4 flex items-center justify-center gap-2 rounded-xl border border-dashed px-4 py-4 text-sm font-black transition-colors ${
          busy
            ? 'cursor-wait border-white/10 text-white/35'
            : 'cursor-pointer border-[#D1FE17]/35 text-[#D1FE17] hover:bg-[#D1FE17]/10'
        }`}
      >
        <Upload className="w-4 h-4" />
         {busy ? 'Saving securely…' : status?.configured ? 'Replace cookies.txt' : 'Choose cookies.txt'}
        <input
          type="file"
          accept=".txt,text/plain"
          className="hidden"
          disabled={busy}
          onChange={e => {
            const file = e.target.files?.[0];
            e.target.value = '';
            if (file) void uploadCookies(file);
          }}
        />
      </label>
      <p className="text-white/35 text-[11px] mt-2">
        Format: <span className="text-white/60 font-bold">Netscape</span> · Max 1 MB · Copy all lines, including the `# Netscape` header. Use only your own signed-in YouTube cookies.
      </p>
      {message && (
        <p className={`mt-3 text-xs font-bold ${message.tone === 'ok' ? 'text-[#D1FE17]' : 'text-red-300'}`}>
          {message.text}
        </p>
      )}
    </section>
  );
}

// ─── Page shell ─────────────────────────────────────────────────────────────────
export default function Admin() {
  const { user, loading } = useAuth();
  const [, setLocation] = useLocation();
  const initialTab = (): 'requests' | 'users' | 'social' => {
    const p = new URLSearchParams(window.location.search).get('tab');
    if (p === 'social' || p === 'users') return p;
    return 'requests';
  };
  const [tab, setTab] = useState<'requests' | 'users' | 'social'>(initialTab);

  useEffect(() => {
    if (!loading && !user) setLocation('/login?next=/admin');
  }, [loading, user, setLocation]);

  if (loading) {
    return (
      <div className="min-h-screen bg-[#0d0d0d] flex items-center justify-center">
        <Loader2 className="w-8 h-8 text-white/30 animate-spin" />
      </div>
    );
  }
  if (!user) return null;
  if (user.role !== 'admin') {
    return (
      <div className="min-h-screen bg-[#0d0d0d] text-white font-sans">
        <AppHeader />
        <div className="max-w-md mx-auto mt-24 bg-[#1a1a1a] border border-white/10 rounded-3xl p-8 text-center">
          <Shield className="w-10 h-10 text-white/20 mx-auto mb-4" />
          <h1 className="text-xl font-black mb-2">Admins only</h1>
          <p className="text-white/40 text-sm mb-6">This area is for the AutoCliper team.</p>
          <button
            onClick={() => setLocation('/')}
            className="bg-white text-black text-sm font-black px-5 py-2.5 rounded-xl hover:bg-white/90 transition-all"
          >
            Back to the app
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#0d0d0d] text-white font-sans">
      <AppHeader />
      <main className="max-w-5xl mx-auto px-4 sm:px-6 py-10">
        <h1 className="text-3xl font-black tracking-tight mb-6 flex items-center gap-2.5">
          <Shield className="w-7 h-7 text-[#D1FE17]" /> Admin panel
        </h1>

        <StatsRow />
        <YoutubeCookiesCard />

        <div className="flex gap-2 mt-8 mb-5 flex-wrap">
          {([['requests', 'Requests', Inbox], ['users', 'Users', Users], ['social', 'Social', Share2]] as const).map(([id, label, Icon]) => (
            <button
              key={id}
              onClick={() => setTab(id)}
              className={`flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-black transition-all ${
                tab === id ? 'bg-[#D1FE17] text-black' : 'bg-white/5 text-white/50 hover:text-white border border-white/10'
              }`}
            >
              <Icon className="w-4 h-4" /> {label}
            </button>
          ))}
        </div>

        {tab === 'requests' ? <RequestsTab /> : tab === 'users' ? <UsersTab /> : <SocialTab />}
      </main>
    </div>
  );
}

// ─── Stats ──────────────────────────────────────────────────────────────────────
function StatsRow() {
  const { data } = useQuery({
    queryKey: ['admin-stats'],
    queryFn: () => apiFetch<AdminStats>('/admin/stats'),
  });
  const items = [
    { label: 'Users', value: data?.users },
    { label: 'Active plans', value: data?.activeSubscriptions },
    { label: 'Pending requests', value: data?.pendingRequests },
    { label: 'Credits used · 30d', value: data?.creditsUsed30d },
  ];
  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
      {items.map(s => (
        <div key={s.label} className="bg-[#1a1a1a] border border-white/10 rounded-2xl px-4 py-3.5">
          <p className="text-2xl font-black">{s.value ?? '—'}</p>
          <p className="text-white/35 text-xs mt-0.5">{s.label}</p>
        </div>
      ))}
    </div>
  );
}

// ─── Requests tab ───────────────────────────────────────────────────────────────
function RequestsTab() {
  const qc = useQueryClient();
  const [status, setStatus] = useState<'pending' | 'approved' | 'rejected' | 'cancelled' | 'all'>('pending');
  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ['admin-requests', status],
    queryFn: () => apiFetch<{ requests: BillingRequest[] }>(`/admin/requests?status=${status}`),
  });

  const invalidateAll = () => {
    qc.invalidateQueries({ queryKey: ['admin-requests'] });
    qc.invalidateQueries({ queryKey: ['admin-stats'] });
    qc.invalidateQueries({ queryKey: ['admin-users'] });
    qc.invalidateQueries({ queryKey: ['admin-user'] });
  };
  const approve = useMutation({
    mutationFn: (id: number) => apiFetch(`/admin/requests/${id}/approve`, { method: 'POST' }),
    onSuccess: invalidateAll,
  });
  const reject = useMutation({
    mutationFn: (id: number) => apiFetch(`/admin/requests/${id}/reject`, { method: 'POST' }),
    onSuccess: invalidateAll,
  });
  const actionError = (approve.error as Error | null)?.message || (reject.error as Error | null)?.message || '';

  return (
    <section>
      <div className="flex items-center gap-2 mb-4 flex-wrap">
        {(['pending', 'approved', 'rejected', 'cancelled', 'all'] as const).map(s => (
          <button
            key={s}
            onClick={() => setStatus(s)}
            className={`px-3 py-1.5 rounded-full text-xs font-black capitalize transition-all ${
              status === s ? 'bg-white text-black' : 'bg-white/5 text-white/45 hover:text-white border border-white/10'
            }`}
          >
            {s}
          </button>
        ))}
        <button
          onClick={() => refetch()}
          className="ml-auto text-white/40 hover:text-white transition-colors"
          title="Refresh"
        >
          <RefreshCw className={`w-4 h-4 ${isFetching ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {actionError && (
        <div className="mb-4 bg-red-500/10 border border-red-500/25 rounded-2xl px-4 py-3 text-sm text-red-300">
          {actionError}
        </div>
      )}

      {isLoading ? (
        <div className="flex justify-center py-16"><Loader2 className="w-7 h-7 text-white/30 animate-spin" /></div>
      ) : error ? (
        <p className="text-red-400 text-sm">{(error as Error).message}</p>
      ) : (data?.requests ?? []).length === 0 ? (
        <div className="bg-[#1a1a1a] border border-white/10 rounded-3xl p-10 text-center text-white/35 text-sm">
          No {status === 'all' ? '' : status} requests right now.
        </div>
      ) : (
        <div className="bg-[#1a1a1a] border border-white/10 rounded-3xl overflow-hidden divide-y divide-white/5">
          {(data?.requests ?? []).map(r => (
            <div key={r.id} className="px-5 py-4 flex items-center gap-4 flex-wrap">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-bold truncate">{r.user_email}</p>
                <p className="text-white/40 text-xs mt-0.5">
                  {requestLabel(r)} · +{r.credits} credits
                </p>
                <p className="text-white/25 text-[11px] mt-0.5">#{r.id} · {fmtDateTime(r.created_at)}</p>
              </div>
              <span className={`text-[10px] font-black uppercase tracking-wide px-2 py-0.5 rounded-full border ${REQ_STATUS_STYLES[r.status]}`}>
                {r.status}
              </span>
              {r.status === 'pending' && (
                <div className="flex gap-2">
                  <button
                    disabled={approve.isPending || reject.isPending}
                    onClick={() => approve.mutate(r.id)}
                    className={`${btnCls} bg-[#D1FE17] text-black hover:bg-[#c2ef0e] flex items-center gap-1.5`}
                  >
                    {approve.isPending && approve.variables === r.id
                      ? <Loader2 className="w-4 h-4 animate-spin" />
                      : <Check className="w-4 h-4" strokeWidth={3} />}
                    Approve
                  </button>
                  <button
                    disabled={approve.isPending || reject.isPending}
                    onClick={() => reject.mutate(r.id)}
                    className={`${btnCls} bg-red-500/10 border border-red-500/25 text-red-400 hover:bg-red-500/20 flex items-center gap-1.5`}
                  >
                    <X className="w-4 h-4" strokeWidth={3} /> Reject
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      <UpiOrdersSection />
    </section>
  );
}

// ─── UPI payments (instant, ZapUPI) ─────────────────────────────────────────────
const UPI_STATUS_STYLES: Record<string, string> = {
  paid: 'bg-[#D1FE17]/10 text-[#D1FE17] border-[#D1FE17]/25',
  pending: 'bg-amber-400/10 text-amber-300 border-amber-400/25',
  failed: 'bg-red-500/10 text-red-400 border-red-500/25',
  review: 'bg-orange-500/15 text-orange-300 border-orange-400/40',
};

function UpiOrdersSection() {
  const { data, isLoading, error } = useQuery({
    queryKey: ['admin-upi-orders'],
    queryFn: () => apiFetch<{ orders: UpiOrder[] }>('/admin/upi-orders'),
  });
  const orders = data?.orders ?? [];
  const needReview = orders.filter(o => o.status === 'review').length;

  return (
    <div className="mt-10">
      <div className="flex items-center gap-3 mb-4">
        <p className="text-white/40 text-xs font-bold uppercase tracking-widest">UPI payments (instant)</p>
        {needReview > 0 && (
          <span className="text-[10px] font-black uppercase tracking-wide px-2 py-0.5 rounded-full border bg-orange-500/15 text-orange-300 border-orange-400/40">
            {needReview} need review
          </span>
        )}
      </div>
      {isLoading ? (
        <div className="flex justify-center py-8"><Loader2 className="w-6 h-6 text-white/30 animate-spin" /></div>
      ) : error ? (
        <p className="text-red-400 text-sm">{(error as Error).message}</p>
      ) : orders.length === 0 ? (
        <div className="bg-[#1a1a1a] border border-white/10 rounded-3xl p-8 text-center text-white/35 text-sm">
          No UPI payments yet. They appear here the moment someone pays from the pricing page.
        </div>
      ) : (
        <div className="bg-[#1a1a1a] border border-white/10 rounded-3xl overflow-hidden divide-y divide-white/5">
          {orders.map(o => (
            <div key={o.orderId} className="px-5 py-4 flex items-center gap-4 flex-wrap">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-bold truncate">{o.user_email}</p>
                <p className="text-white/40 text-xs mt-0.5">
                  {o.kind === 'topup'
                    ? `${o.quantity ?? 0} ${o.creditType ?? ''} credits`
                    : (o.plan ? (PLAN_NAMES[o.plan] ?? o.plan) : 'Plan')} · {fmtInr(o.amountInr)}
                  {o.utr ? ` · UTR ${o.utr}` : ''}
                </p>
                <p className="text-white/25 text-[11px] mt-0.5">
                  {o.orderId} · {fmtDateTime(o.createdAt)}
                  {o.failReason ? ` · ${o.failReason}` : ''}
                </p>
              </div>
              <span className={`text-[10px] font-black uppercase tracking-wide px-2 py-0.5 rounded-full border ${UPI_STATUS_STYLES[o.status] ?? UPI_STATUS_STYLES.pending}`}>
                {o.status}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Users tab ──────────────────────────────────────────────────────────────────
function UsersTab() {
  const [q, setQ] = useState('');
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const { data, isLoading, error } = useQuery({
    queryKey: ['admin-users', search],
    queryFn: () => apiFetch<{ total: number; users: AuthUser[] }>(`/admin/users?q=${encodeURIComponent(search)}&limit=50`),
  });

  if (selectedId) {
    return <UserDetail id={selectedId} onBack={() => setSelectedId(null)} />;
  }

  return (
    <section>
      <form
        onSubmit={e => { e.preventDefault(); setSearch(q.trim()); }}
        className="flex gap-2 mb-4"
      >
        <div className="relative flex-1">
          <Search className="w-4 h-4 text-white/25 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            value={q}
            onChange={e => setQ(e.target.value)}
            placeholder="Search by email or name…"
            className={`${inputCls} pl-9`}
          />
        </div>
        <button type="submit" className={`${btnCls} bg-white text-black hover:bg-white/90`}>Search</button>
      </form>

      {isLoading ? (
        <div className="flex justify-center py-16"><Loader2 className="w-7 h-7 text-white/30 animate-spin" /></div>
      ) : error ? (
        <p className="text-red-400 text-sm">{(error as Error).message}</p>
      ) : (
        <>
          <p className="text-white/30 text-xs mb-2">{data?.total ?? 0} user{(data?.total ?? 0) === 1 ? '' : 's'}</p>
          <div className="bg-[#1a1a1a] border border-white/10 rounded-3xl overflow-hidden divide-y divide-white/5">
            {(data?.users ?? []).map(u => (
              <button
                key={u.id}
                onClick={() => setSelectedId(u.id)}
                className="w-full text-left px-5 py-3.5 flex items-center gap-4 hover:bg-white/[0.03] transition-colors"
              >
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-bold truncate">{u.email}</p>
                  <p className="text-white/35 text-xs mt-0.5 truncate">
                    {u.name || '—'} · joined {fmtDate(u.createdAt)}
                  </p>
                </div>
                <div className="flex items-center gap-1.5 shrink-0 flex-wrap justify-end">
                  {u.role === 'admin' && <Chip tone="lime">admin</Chip>}
                  {u.status === 'disabled' && <Chip tone="red">disabled</Chip>}
                  {u.planStatus === 'active' && u.plan !== 'none' && <Chip tone="amber">{PLAN_NAMES[u.plan]}</Chip>}
                  <span className="flex items-center gap-1 text-sm font-black text-white/70">
                    <Zap className="w-3.5 h-3.5 text-[#D1FE17]" /> {u.credits.cutting.total} cut · {u.credits.uploading.total} upload
                  </span>
                </div>
              </button>
            ))}
            {(data?.users ?? []).length === 0 && (
              <p className="px-5 py-10 text-center text-white/35 text-sm">No users match that search.</p>
            )}
          </div>
        </>
      )}
    </section>
  );
}

// ─── User detail ────────────────────────────────────────────────────────────────
function UserDetail({ id, onBack }: { id: string; onBack: () => void }) {
  const qc = useQueryClient();
  const { user: me } = useAuth();
  const { data, isLoading, error } = useQuery({
    queryKey: ['admin-user', id],
    queryFn: () => apiFetch<AdminUserDetail>(`/admin/users/${id}`),
  });
  const { data: catalog, isLoading: catalogLoading, error: catalogError } = useQuery<Catalog>({
    queryKey: ['billing-catalog'],
    queryFn: () => apiFetch<Catalog>('/billing/catalog'),
    staleTime: 5 * 60 * 1000,
  });

  const [msg, setMsg] = useState('');
  const [delta, setDelta] = useState('');
  const [note, setNote] = useState('');
  const [planSel, setPlanSel] = useState<CatalogPlan['id']>('100');
  const [intervalSel, setIntervalSel] = useState<BillingInterval>('monthly');
  const [newPassword, setNewPassword] = useState('');

  const act = useMutation({
    mutationFn: ({ path, body }: { path: string; body: unknown }) =>
      apiFetch(`/admin/users/${id}/${path}`, { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: () => {
      setMsg('Saved ✓');
      qc.invalidateQueries({ queryKey: ['admin-user', id] });
      qc.invalidateQueries({ queryKey: ['admin-users'] });
      qc.invalidateQueries({ queryKey: ['admin-stats'] });
    },
    onError: (e: Error) => setMsg(e.message),
  });
  const run = (path: string, body: unknown) => { setMsg(''); act.mutate({ path, body }); };

  if (isLoading) {
    return <div className="flex justify-center py-16"><Loader2 className="w-7 h-7 text-white/30 animate-spin" /></div>;
  }
  if (error || !data) {
    return (
      <div>
        <button onClick={onBack} className="flex items-center gap-1 text-sm text-white/40 hover:text-white mb-4">
          <ChevronLeft className="w-4 h-4" /> All users
        </button>
        <p className="text-red-400 text-sm">{(error as Error | null)?.message ?? 'Could not load this user.'}</p>
      </div>
    );
  }

  const u = data.user;
  const isSelf = me?.id === u.id;
  const plans = catalog?.plans ?? [];
  const selectedPlan = plans.find(plan => plan.id === planSel);

  return (
    <section>
      <button onClick={onBack} className="flex items-center gap-1 text-sm text-white/40 hover:text-white mb-4 transition-colors">
        <ChevronLeft className="w-4 h-4" /> All users
      </button>

      {/* Header */}
      <div className="bg-[#1a1a1a] border border-white/10 rounded-3xl p-6 mb-4">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div className="min-w-0">
            <h2 className="text-xl font-black truncate">{u.email}</h2>
            <p className="text-white/40 text-sm mt-0.5">{u.name || '—'} · joined {fmtDate(u.createdAt)}</p>
            <p className="text-white/25 text-xs mt-1 font-mono">{u.id}</p>
          </div>
          <div className="flex items-center gap-1.5 flex-wrap">
            {u.role === 'admin' && <Chip tone="lime">admin</Chip>}
            <Chip tone={u.status === 'disabled' ? 'red' : 'neutral'}>{u.status}</Chip>
            {u.planStatus === 'active' && u.plan !== 'none'
              ? <Chip tone="amber">{PLAN_NAMES[u.plan]} · {u.planInterval}</Chip>
              : <Chip>free</Chip>}
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3 mt-5">
          <div className="bg-[#111] border border-white/8 rounded-2xl px-4 py-3">
            <p className="text-xl font-black text-[#D1FE17]">{u.credits.cutting.total}</p>
            <p className="text-white/35 text-xs">Cutting credits</p>
          </div>
          <div className="bg-[#111] border border-white/8 rounded-2xl px-4 py-3">
            <p className="text-xl font-black text-sky-300">{u.credits.uploading.total}</p>
            <p className="text-white/35 text-xs">Uploading credits</p>
          </div>
        </div>
        {u.planStatus === 'active' && u.paidUntil && (
          <p className="text-white/35 text-xs mt-3">Plan active until {fmtDate(u.paidUntil)}</p>
        )}
        {msg && (
          <p className={`text-sm font-bold mt-4 ${msg === 'Saved ✓' ? 'text-[#D1FE17]' : 'text-red-400'}`}>{msg}</p>
        )}
      </div>

      {/* Actions */}
      <div className="grid md:grid-cols-3 gap-4 mb-4">
        {/* Credits */}
        <div className="bg-[#1a1a1a] border border-white/10 rounded-3xl p-5">
          <p className="text-white/40 text-xs font-bold uppercase tracking-widest mb-3">Adjust credits</p>
          <input
            value={delta}
            onChange={e => setDelta(e.target.value)}
            placeholder="e.g. 50 or -10"
            className={`${inputCls} mb-2`}
            inputMode="numeric"
          />
          <input
            value={note}
            onChange={e => setNote(e.target.value)}
            placeholder="Note (optional)"
            className={`${inputCls} mb-3`}
          />
          <button
            disabled={act.isPending || !delta.trim() || !Number.isInteger(Number(delta)) || Number(delta) === 0}
            onClick={() => { run('credits', { delta: Number(delta), note: note.trim() || undefined }); setDelta(''); setNote(''); }}
            className={`${btnCls} w-full bg-[#D1FE17] text-black hover:bg-[#c2ef0e]`}
          >
            Apply
          </button>
          <p className="text-white/25 text-[11px] mt-2">Positive adds top-up credits; negative removes.</p>
        </div>

        {/* Plan */}
        <div className="bg-[#1a1a1a] border border-white/10 rounded-3xl p-5">
          <p className="text-white/40 text-xs font-bold uppercase tracking-widest mb-3">Plan</p>
          <div className="flex gap-2 mb-2">
            <select
              value={planSel}
              onChange={e => setPlanSel(e.target.value as CatalogPlan['id'])}
              disabled={catalogLoading || plans.length === 0}
              className={inputCls}
            >
              {plans.map(plan => (
                <option key={plan.id} value={plan.id}>
                  {plan.name} credits · {fmtInr(plan.priceMonthlyInr)}/mo · {fmtInr(plan.priceYearlyInr)}/yr
                </option>
              ))}
            </select>
            <select value={intervalSel} onChange={e => setIntervalSel(e.target.value as BillingInterval)} className={inputCls}>
              <option value="monthly">Monthly</option>
              <option value="yearly">Yearly</option>
            </select>
          </div>
          <p className="text-white/35 text-[11px] mb-3">
            {selectedPlan
              ? `${selectedPlan.cuttingCredits.toLocaleString()} cutting + ${selectedPlan.uploadingCredits.toLocaleString()} uploading credits · ${fmtInr(intervalSel === 'monthly' ? selectedPlan.priceMonthlyInr : selectedPlan.priceYearlyInr)}`
              : catalogLoading
                ? 'Loading current plan catalog…'
                : catalogError
                  ? 'Could not load the current plan catalog.'
                  : 'No plans available.'}
          </p>
          <button
            disabled={act.isPending || catalogLoading || !selectedPlan}
            onClick={() => run('plan', { action: 'activate', plan: planSel, interval: intervalSel })}
            className={`${btnCls} w-full bg-white text-black hover:bg-white/90 mb-2`}
          >
            Activate plan
          </button>
          <button
            disabled={act.isPending || u.plan === 'none'}
            onClick={() => {
              if (window.confirm(`Remove ${u.email}'s plan? Their plan credits go to zero.`)) run('plan', { action: 'remove' });
            }}
            className={`${btnCls} w-full bg-red-500/10 border border-red-500/25 text-red-400 hover:bg-red-500/20`}
          >
            Remove plan
          </button>
        </div>

        {/* Access */}
        <div className="bg-[#1a1a1a] border border-white/10 rounded-3xl p-5">
          <p className="text-white/40 text-xs font-bold uppercase tracking-widest mb-3">Access</p>
          <button
            disabled={act.isPending || isSelf}
            onClick={() => {
              const next = u.role === 'admin' ? 'user' : 'admin';
              if (window.confirm(`Make ${u.email} ${next === 'admin' ? 'an admin' : 'a normal user'}?`)) run('role', { role: next });
            }}
            className={`${btnCls} w-full bg-white/8 border border-white/10 text-white hover:bg-white/12 mb-2`}
          >
            {u.role === 'admin' ? 'Remove admin' : 'Make admin'}
          </button>
          <button
            disabled={act.isPending || isSelf}
            onClick={() => {
              const next = u.status === 'disabled' ? 'active' : 'disabled';
              if (window.confirm(`${next === 'disabled' ? 'Disable' : 'Re-enable'} ${u.email}?`)) run('status', { status: next });
            }}
            className={`${btnCls} w-full mb-3 ${
              u.status === 'disabled'
                ? 'bg-[#D1FE17]/10 border border-[#D1FE17]/25 text-[#D1FE17] hover:bg-[#D1FE17]/20'
                : 'bg-red-500/10 border border-red-500/25 text-red-400 hover:bg-red-500/20'
            }`}
          >
            {u.status === 'disabled' ? 'Re-enable account' : 'Disable account'}
          </button>
          <input
            value={newPassword}
            onChange={e => setNewPassword(e.target.value)}
            placeholder="New password (min 8)"
            type="text"
            className={`${inputCls} mb-2`}
          />
          <button
            disabled={act.isPending || newPassword.length < 8}
            onClick={() => {
              if (window.confirm(`Set a new password for ${u.email}?`)) { run('password', { password: newPassword }); setNewPassword(''); }
            }}
            className={`${btnCls} w-full bg-white/8 border border-white/10 text-white hover:bg-white/12`}
          >
            Set password
          </button>
        </div>
      </div>

      {/* Ledger + requests */}
      <div className="grid md:grid-cols-2 gap-4">
        <div className="bg-[#1a1a1a] border border-white/10 rounded-3xl p-5">
          <p className="text-white/40 text-xs font-bold uppercase tracking-widest mb-3">Credit activity</p>
          {data.ledger.length === 0 ? (
            <p className="text-white/35 text-sm">No activity yet.</p>
          ) : (
            <div className="divide-y divide-white/5">
              {data.ledger.map(e => (
                <div key={e.id} className="py-2 flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm text-white/75 capitalize truncate">{reasonLabel(e.reason)}</p>
                    <p className="text-white/25 text-xs">{fmtDateTime(e.created_at)} · {e.bucket}</p>
                  </div>
                  <span className={`text-sm font-black shrink-0 ${e.delta >= 0 ? 'text-[#D1FE17]' : 'text-white/55'}`}>
                    {e.delta >= 0 ? '+' : ''}{e.delta}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="bg-[#1a1a1a] border border-white/10 rounded-3xl p-5">
          <p className="text-white/40 text-xs font-bold uppercase tracking-widest mb-3">Billing requests</p>
          {data.requests.length === 0 ? (
            <p className="text-white/35 text-sm">No requests yet.</p>
          ) : (
            <div className="divide-y divide-white/5">
              {data.requests.map(r => (
                <div key={r.id} className="py-2 flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm text-white/75 truncate">{requestLabel(r)}</p>
                    <p className="text-white/25 text-xs">{fmtDateTime(r.created_at)}</p>
                  </div>
                  <span className={`text-[10px] font-black uppercase tracking-wide px-2 py-0.5 rounded-full border shrink-0 ${REQ_STATUS_STYLES[r.status]}`}>
                    {r.status}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

// ─── Social tab (Post for Me) ─────────────────────────────────────────────────
interface SocialConnRow { user_id: string; username: string | null; account_count: number; platforms: string[]; first_connected: string; }

function SocialTab() {
  const qc = useQueryClient();

  const { data, isLoading, isFetching } = useQuery({
    queryKey: ['admin-social-connections'],
    queryFn: () => apiFetch<{ configured: boolean; users: SocialConnRow[] }>('/admin/social/connections'),
    retry: false,
  });

  const configured = data?.configured ?? false;
  const users = data?.users ?? [];

  return (
    <div className="space-y-5 max-w-2xl">
      {/* Status card */}
      <div className={`border rounded-2xl p-5 flex items-center gap-4 ${configured ? 'border-[#D1FE17]/25 bg-[#D1FE17]/5' : 'border-white/10 bg-[#1a1a1a]'}`}>
        <div className={`w-11 h-11 rounded-xl flex items-center justify-center shrink-0 ${configured ? 'bg-[#D1FE17]/15' : 'bg-white/5'}`}>
          <Share2 className={`w-5 h-5 ${configured ? 'text-[#D1FE17]' : 'text-white/25'}`} />
        </div>
        <div className="flex-1 min-w-0">
          {isLoading ? (
            <div className="h-4 w-32 bg-white/10 rounded animate-pulse" />
          ) : (
            <>
              <p className="font-black text-sm">
                {configured ? 'Post for Me active ✓' : 'Post for Me not configured'}
              </p>
              <p className="text-white/40 text-xs mt-0.5">
                {configured
                  ? `${users.length} user${users.length !== 1 ? 's' : ''} with connected accounts — clips auto-post on generation`
                  : 'Add POSTFORME_API_KEY secret to enable'}
              </p>
            </>
          )}
        </div>
        <button
          onClick={() => { void qc.invalidateQueries({ queryKey: ['admin-social-connections'] }); }}
          disabled={isFetching}
          title="Refresh"
          className="text-white/30 hover:text-white transition-colors shrink-0"
        >
          <RefreshCw className={`w-4 h-4 ${isFetching ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {/* Connected users */}
      {configured && users.length > 0 && (
        <div>
          <p className="text-[11px] font-black text-white/30 uppercase tracking-widest mb-3">
            Connected users ({users.length})
          </p>
          <div className="space-y-2">
            {users.map((u) => (
              <div key={u.user_id} className="bg-[#1a1a1a] border border-white/8 rounded-2xl px-4 py-3 flex items-center gap-3">
                <div className="w-8 h-8 rounded-xl bg-white/5 flex items-center justify-center shrink-0 text-sm">
                  👤
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-black truncate">{u.username ?? u.user_id}</p>
                  <p className="text-white/25 text-xs truncate">{u.platforms.join(' · ')}</p>
                </div>
                <span className="text-[10px] font-black uppercase tracking-wide px-2 py-0.5 rounded-full border border-white/10 bg-white/5 text-white/50 shrink-0">
                  {u.account_count} account{u.account_count !== 1 ? 's' : ''}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {configured && !isLoading && users.length === 0 && (
        <p className="text-white/30 text-sm">No users have connected social accounts yet.</p>
      )}
    </div>
  );
}
