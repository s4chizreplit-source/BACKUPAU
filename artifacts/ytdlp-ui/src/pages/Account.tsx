/**
 * Account & billing — plan status, credit balances, pending billing requests
 * and recent credit activity for the signed-in user.
 */
import { useEffect, useState, type ReactNode } from 'react';
import { Link, useLocation } from 'wouter';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Zap, Loader2, LogOut, Clock, CreditCard, ArrowUpRight, User as UserIcon, Gift, Copy, Check, Upload } from 'lucide-react';
import { AppHeader } from '../components/AppHeader';
import { apiFetch, useAuth, type CreditBalance } from '../lib/auth';
import { SITE_ORIGIN } from '../lib/site';
import {
  type BillingRequest,
  type Catalog,
  type LedgerEntry,
  type UpiOrder,
  fmtDate,
  fmtDateTime,
  fmtInr,
  PLAN_NAMES,
  reasonLabel,
  requestLabel,
} from '../lib/billingTypes';

const STATUS_STYLES: Record<string, string> = {
  pending: 'bg-amber-400/10 text-amber-300 border-amber-400/25',
  approved: 'bg-[#D1FE17]/10 text-[#D1FE17] border-[#D1FE17]/25',
  rejected: 'bg-red-500/10 text-red-400 border-red-500/25',
  cancelled: 'bg-white/5 text-white/40 border-white/10',
};

function StatusChip({ status }: { status: string }) {
  return (
    <span className={`text-[10px] font-black uppercase tracking-wide px-2 py-0.5 rounded-full border ${STATUS_STYLES[status] ?? STATUS_STYLES.cancelled}`}>
      {status}
    </span>
  );
}

function TopupCard({
  title, icon, value, onChange, rate, quantity, available, busy, onBuy,
}: {
  title: string; icon: ReactNode; value: string; onChange: (value: string) => void;
  rate: number; quantity: number | null; available: boolean; busy: boolean; onBuy: () => void;
}) {
  const amount = quantity ? quantity * rate : null;
  return (
    <div className="rounded-2xl border border-white/10 bg-[#111] p-4">
      <p className="flex items-center gap-2 font-black text-sm">{icon}{title}</p>
      <p className="text-white/50 text-xs mt-1">{fmtInr(rate)} per credit</p>
      <label className="block text-white/55 text-xs mt-4 mb-1.5" htmlFor={`topup-${title}`}>Credits to add</label>
      <input id={`topup-${title}`} inputMode="numeric" min="1" step="1" type="number" value={value}
        onChange={event => onChange(event.target.value)}
        className="w-full rounded-xl border border-white/15 bg-black/30 px-3 py-2 text-white outline-none focus:border-[#D1FE17]"
        aria-invalid={value !== '' && !quantity} />
      <button disabled={!available || !quantity || busy} onClick={onBuy}
        className="mt-3 w-full rounded-xl bg-[#D1FE17] px-3 py-2.5 text-sm font-black text-black hover:bg-[#c2ef0e] disabled:cursor-not-allowed disabled:opacity-50">
        {busy ? 'Creating UPI order…' : amount ? `Pay ${fmtInr(amount)} with UPI` : 'Enter a whole number'}
      </button>
    </div>
  );
}

function BalanceCard({ title, icon, balance, tone }: {
  title: string; icon: ReactNode; balance: CreditBalance; tone: string;
}) {
  return (
    <div className="bg-[#111] border border-white/8 rounded-2xl px-4 py-3">
      <p className={`text-2xl font-black flex items-center gap-2 ${tone}`}>{icon}{balance.total}</p>
      <p className="text-white/65 text-xs mt-0.5">{title}</p>
      <div className="mt-3 pt-3 border-t border-white/8 grid grid-cols-3 gap-2 text-[11px]">
        <div><p className="font-bold text-white/80">{balance.subscription}</p><p className="text-white/40">Plan</p></div>
        <div><p className="font-bold text-white/80">{balance.topup}</p><p className="text-white/40">Top-up</p></div>
        <div><p className="font-bold text-white/80">{balance.legacy}</p><p className="text-white/40">Legacy</p></div>
      </div>
    </div>
  );
}

// ─── Refer & earn ─────────────────────────────────────────────────────────────
interface ReferralInfo {
  code: string;
  reward: number;
  stats: { joined: number; rewarded: number; creditsEarned: number };
}

function ReferralSection() {
  const [copied, setCopied] = useState(false);
  const { data } = useQuery({
    queryKey: ['referral-me'],
    queryFn: () => apiFetch<ReferralInfo>('/referral/me'),
  });
  if (!data) return null;

  const link = `${SITE_ORIGIN}/?ref=${data.code}`;
  const shareMsg = `I'm turning long videos into short clips with AutoCliper 🔥 Join with my link:`;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* clipboard unavailable — user can select the text */ }
  };

  return (
    <section id="refer" className="relative overflow-hidden bg-[#1a1a1a] border border-[#D1FE17]/30 rounded-3xl p-6">
      <div className="absolute -top-20 -right-20 w-56 h-56 bg-[#D1FE17]/10 rounded-full blur-3xl pointer-events-none" />

      <div className="flex items-center gap-2 mb-2">
        <Gift className="w-4 h-4 text-[#D1FE17]" />
        <p className="text-white/40 text-xs font-bold uppercase tracking-widest">Refer &amp; earn</p>
      </div>
      <h2 className="text-2xl font-black leading-tight">
        Get <span className="text-[#D1FE17]">{data.reward.toLocaleString()} cutting credits</span> for every friend 🎉
      </h2>
      <p className="text-white/40 text-sm mt-1.5">
        Share your link → your friend signs up → they buy any plan → your cutting-credit reward is added automatically.
        No limit — refer as many friends as you like.
      </p>

      {/* Link + copy */}
      <div className="flex flex-col sm:flex-row gap-2 mt-5">
        <div className="flex-1 bg-[#111] border border-white/10 rounded-xl px-4 py-3 text-sm text-white/70 font-mono truncate select-all">
          {link}
        </div>
        <button
          onClick={copy}
          className="bg-[#D1FE17] text-black text-sm font-black px-5 py-3 rounded-xl hover:bg-[#c2ef0e] active:scale-95 transition-all flex items-center justify-center gap-2 shrink-0"
        >
          {copied ? <><Check className="w-4 h-4" /> Copied!</> : <><Copy className="w-4 h-4" /> Copy link</>}
        </button>
      </div>

      {/* One-tap share */}
      <div className="flex flex-wrap gap-2 mt-3">
        <a
          href={`https://wa.me/?text=${encodeURIComponent(`${shareMsg} ${link}`)}`}
          target="_blank" rel="noreferrer"
          className="bg-white/8 border border-white/10 text-white text-xs font-bold px-4 py-2 rounded-xl hover:bg-white/12 transition-all"
        >WhatsApp</a>
        <a
          href={`https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent(shareMsg)}`}
          target="_blank" rel="noreferrer"
          className="bg-white/8 border border-white/10 text-white text-xs font-bold px-4 py-2 rounded-xl hover:bg-white/12 transition-all"
        >Telegram</a>
        <a
          href={`https://twitter.com/intent/tweet?text=${encodeURIComponent(`${shareMsg} ${link}`)}`}
          target="_blank" rel="noreferrer"
          className="bg-white/8 border border-white/10 text-white text-xs font-bold px-4 py-2 rounded-xl hover:bg-white/12 transition-all"
        >X / Twitter</a>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-3 mt-5">
        <div className="bg-[#111] border border-white/8 rounded-2xl px-4 py-3">
          <p className="text-2xl font-black">{data.stats.joined}</p>
          <p className="text-white/35 text-xs mt-0.5">Friends joined</p>
        </div>
        <div className="bg-[#111] border border-white/8 rounded-2xl px-4 py-3">
          <p className="text-2xl font-black">{data.stats.rewarded}</p>
          <p className="text-white/35 text-xs mt-0.5">Bought a plan</p>
        </div>
        <div className="bg-[#111] border border-white/8 rounded-2xl px-4 py-3">
            <p className="text-2xl font-black text-[#D1FE17]">{data.stats.creditsEarned.toLocaleString()}</p>
            <p className="text-white/35 text-xs mt-0.5">Cutting credits earned</p>
        </div>
      </div>
    </section>
  );
}

export default function Account() {
  const { user, loading, logout, refresh } = useAuth();
  const [, setLocation] = useLocation();
  const qc = useQueryClient();
  const [cuttingQuantity, setCuttingQuantity] = useState('10');
  const [uploadingQuantity, setUploadingQuantity] = useState('10');

  // Latest balances every time the page opens
  useEffect(() => { void refresh(); }, [refresh]);

  useEffect(() => {
    if (!loading && !user) setLocation('/login?next=/account');
  }, [loading, user, setLocation]);

  const { data: reqData } = useQuery({
    queryKey: ['billing-requests'],
    queryFn: () => apiFetch<{ requests: BillingRequest[] }>('/billing/requests'),
    enabled: !!user,
  });
  const { data: ledgerData } = useQuery({
    queryKey: ['billing-ledger'],
    queryFn: () => apiFetch<{ entries: LedgerEntry[] }>('/billing/ledger'),
    enabled: !!user,
  });
  const { data: catalog } = useQuery({
    queryKey: ['billing-catalog'],
    queryFn: () => apiFetch<Catalog>('/billing/catalog'),
    enabled: !!user,
    staleTime: 5 * 60 * 1000,
  });

  const cancelReq = useMutation({
    mutationFn: (id: number) => apiFetch(`/billing/requests/${id}/cancel`, { method: 'POST' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['billing-requests'] }),
  });
  const topUp = useMutation({
    mutationFn: (value: { creditType: 'cutting' | 'uploading'; quantity: number }) =>
      apiFetch<UpiOrder>('/pay/upi/order', {
        method: 'POST',
        body: JSON.stringify({ kind: 'topup', ...value }),
      }),
    onSuccess: (order) => {
      try { localStorage.setItem('autocliper_upi_last_order', order.orderId); } catch { /* ignore */ }
      if (order.paymentUrl) window.location.assign(order.paymentUrl);
      else setLocation(`/pay/upi/return?order_id=${encodeURIComponent(order.orderId)}`);
    },
  });

  if (loading) {
    return (
      <div className="min-h-screen bg-[#0d0d0d] flex items-center justify-center">
        <Loader2 className="w-8 h-8 text-white/30 animate-spin" />
      </div>
    );
  }
  if (!user) return null;

  const requests = (reqData?.requests ?? []).slice(0, 6);
  const entries = (ledgerData?.entries ?? []).slice(0, 12);
  const planActive = user.planStatus === 'active' && user.plan !== 'none' &&
    (!user.paidUntil || new Date(user.paidUntil).getTime() > Date.now());
  const planExpired = user.plan !== 'none' && !planActive;
  const parseQuantity = (value: string) => {
    const quantity = Number(value);
    return Number.isInteger(quantity) && quantity > 0 ? quantity : null;
  };
  const cuttingQty = parseQuantity(cuttingQuantity);
  const uploadingQty = parseQuantity(uploadingQuantity);
  const upiAvailable = !!catalog?.upi?.available;

  return (
    <div className="min-h-screen bg-[#0d0d0d] text-white font-sans">
      <AppHeader />

      <main className="max-w-3xl mx-auto px-4 sm:px-6 py-10 space-y-5">
        <div>
          <h1 className="text-3xl font-black tracking-tight">Account &amp; billing</h1>
          <p className="text-white/40 text-sm mt-1">{user.email}</p>
        </div>

        {/* ── Separate balances ── */}
        <section className="bg-[#1a1a1a] border border-white/10 rounded-3xl p-6">
          <p className="text-white/40 text-xs font-bold uppercase tracking-widest mb-4">Your balances</p>
          <div className="grid grid-cols-2 gap-3 mt-6">
            <BalanceCard title="Cutting credits" icon={<Zap className="w-5 h-5" />} balance={user.credits.cutting} tone="text-[#D1FE17]" />
            <BalanceCard title="Uploading credits" icon={<Upload className="w-5 h-5" />} balance={user.credits.uploading} tone="text-sky-300" />
          </div>
          <p className="text-white/50 text-xs mt-4">Unused cutting and uploading balances are retained when your plan renews or expires. Plans add their included monthly allowances; top-ups are added to the matching balance.</p>
        </section>

        <ReferralSection />

        {/* ── Plan ── */}
        <section className="bg-[#1a1a1a] border border-white/10 rounded-3xl p-6">
          <p className="text-white/40 text-xs font-bold uppercase tracking-widest mb-3">Your plan</p>
          {planActive ? (
            <div className="flex items-center justify-between gap-4 flex-wrap">
              <div>
                <p className="text-2xl font-black">
                  {PLAN_NAMES[user.plan]}{' '}
                  <span className="text-white/40 text-sm font-bold">
                    · {user.planInterval === 'yearly' ? 'Yearly' : 'Monthly'}
                  </span>
                </p>
                <p className="text-white/45 text-sm mt-1">
                  Active until <span className="text-white font-bold">{fmtDate(user.paidUntil)}</span>
                  {user.planInterval === 'yearly' && ' — credits refill every month'}
                </p>
              </div>
              <span className="bg-[#D1FE17]/10 border border-[#D1FE17]/25 text-[#D1FE17] text-xs font-black uppercase tracking-wide px-3 py-1.5 rounded-full">
                Active
              </span>
            </div>
          ) : (
            <div className="flex items-center justify-between gap-4 flex-wrap">
              <div>
                <p className="text-2xl font-black">{planExpired ? 'Plan expired' : 'Free account'}</p>
                <p className="text-white/45 text-sm mt-1">
                  {planExpired
                    ? 'Renew to receive your plan’s cutting and uploading allowances again.'
                    : 'Choose a plan for monthly cutting credits and included uploads.'}
                </p>
              </div>
              <Link
                href="/pricing"
                className="flex items-center gap-1.5 bg-white text-black text-sm font-black px-4 py-2.5 rounded-xl hover:bg-white/90 active:scale-95 transition-all"
              >
                See plans <ArrowUpRight className="w-4 h-4" />
              </Link>
            </div>
          )}
        </section>

        {/* ── Credit top-ups ── */}
        <section className="bg-[#1a1a1a] border border-white/10 rounded-3xl p-6">
          <p className="text-white/40 text-xs font-bold uppercase tracking-widest mb-1">Top up balances</p>
          <p className="text-white/50 text-sm mb-5">Buy only what you need. Enter a whole number of credits; balances are retained.</p>
          {topUp.error && <p className="mb-4 text-sm text-red-300">{(topUp.error as Error).message}</p>}
          <div className="grid sm:grid-cols-2 gap-4">
            <TopupCard title="Cutting credits" icon={<Zap className="w-4 h-4" />} value={cuttingQuantity} onChange={setCuttingQuantity}
              rate={catalog?.upi?.cuttingRateInr ?? 6} quantity={cuttingQty} available={upiAvailable} busy={topUp.isPending}
              onBuy={() => cuttingQty && topUp.mutate({ creditType: 'cutting', quantity: cuttingQty })} />
            <TopupCard title="Uploading credits" icon={<Upload className="w-4 h-4" />} value={uploadingQuantity} onChange={setUploadingQuantity}
              rate={catalog?.upi?.uploadingRateInr ?? 3} quantity={uploadingQty} available={upiAvailable} busy={topUp.isPending}
              onBuy={() => uploadingQty && topUp.mutate({ creditType: 'uploading', quantity: uploadingQty })} />
          </div>
          {!upiAvailable && <p className="text-amber-200 text-xs mt-4">UPI top-ups are temporarily unavailable.</p>}
        </section>

        {/* ── Requests ── */}
        {requests.length > 0 && (
          <section className="bg-[#1a1a1a] border border-white/10 rounded-3xl p-6">
            <p className="text-white/40 text-xs font-bold uppercase tracking-widest mb-1">Billing requests</p>
            <p className="text-white/35 text-xs mb-4 flex items-center gap-1.5">
              <Clock className="w-3.5 h-3.5" /> We activate requests manually — usually within a few hours.
            </p>
            <div className="divide-y divide-white/5">
              {requests.map(r => (
                <div key={r.id} className="py-3 flex items-center justify-between gap-3 flex-wrap">
                  <div className="min-w-0">
                    <p className="text-sm font-bold truncate">{requestLabel(r)}</p>
                    <p className="text-white/35 text-xs mt-0.5">{fmtDateTime(r.created_at)}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <StatusChip status={r.status} />
                    {r.status === 'pending' && (
                      <button
                        onClick={() => cancelReq.mutate(r.id)}
                        disabled={cancelReq.isPending}
                        className="text-xs text-white/40 hover:text-red-400 transition-colors disabled:opacity-50"
                      >
                        Cancel
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* ── Activity ── */}
        <section className="bg-[#1a1a1a] border border-white/10 rounded-3xl p-6">
          <p className="text-white/40 text-xs font-bold uppercase tracking-widest mb-4">Recent activity</p>
          {entries.length === 0 ? (
            <p className="text-white/35 text-sm">Nothing yet — make your first clips!</p>
          ) : (
            <div className="divide-y divide-white/5">
              {entries.map(e => (
                <div key={e.id} className="py-2.5 flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-white/80 capitalize truncate">{reasonLabel(e.reason)}</p>
                    <p className="text-white/30 text-xs">{fmtDateTime(e.created_at)}</p>
                  </div>
                  <span className={`text-sm font-black shrink-0 ${e.delta >= 0 ? 'text-[#D1FE17]' : 'text-white/60'}`}>
                    {e.delta >= 0 ? '+' : ''}{e.delta}
                  </span>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* ── Social auto-post ── */}

        {/* ── Profile ── */}
        <section className="bg-[#1a1a1a] border border-white/10 rounded-3xl p-6">
          <p className="text-white/40 text-xs font-bold uppercase tracking-widest mb-4">Profile</p>
          <div className="space-y-2 text-sm">
            <p className="flex items-center gap-2 text-white/70">
              <UserIcon className="w-4 h-4 text-white/30" /> {user.name || '—'}
            </p>
            <p className="flex items-center gap-2 text-white/70">
              <CreditCard className="w-4 h-4 text-white/30" /> {user.email}
            </p>
            <p className="text-white/35 text-xs">Member since {fmtDate(user.createdAt)}</p>
          </div>
          <button
            onClick={async () => { await logout(); setLocation('/'); }}
            className="mt-5 flex items-center gap-2 text-sm font-bold text-red-400/70 hover:text-red-400 transition-colors"
          >
            <LogOut className="w-4 h-4" /> Log out
          </button>
        </section>
      </main>
    </div>
  );
}
