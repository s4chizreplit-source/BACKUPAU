/**
 * UPI payment return page — the buyer lands here after paying on ZapUPI
 * (or cancelling). Polls our own order endpoint until the payment is
 * confirmed server-side, then shows the plan as active.
 *
 * The poll itself triggers a server-side confirm, so this page works even if
 * the gateway's webhook is delayed or never arrives.
 */
import { useEffect, useMemo, useState, type ReactElement, type ReactNode } from 'react';
import { Link, useLocation } from 'wouter';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Clock, Loader2, ShieldAlert, XCircle } from 'lucide-react';
import { AppHeader } from '../components/AppHeader';
import { apiFetch, useAuth, ApiError } from '../lib/auth';
import { fmtInr, PLAN_NAMES, type UpiOrder } from '../lib/billingTypes';

const LAST_ORDER_KEY = 'autocliper_upi_last_order';

export default function PayUpiReturn() {
  const { user, loading: authLoading, refresh } = useAuth();
  const qc = useQueryClient();
  const [, setLocation] = useLocation();
  const [slowHint, setSlowHint] = useState(false);

  const orderId = useMemo(() => {
    const fromUrl = new URLSearchParams(window.location.search).get('order_id')?.trim() ?? '';
    if (fromUrl) return fromUrl;
    try { return localStorage.getItem(LAST_ORDER_KEY) ?? ''; } catch { return ''; }
  }, []);

  const { data, error } = useQuery({
    queryKey: ['upi-order', orderId],
    queryFn: () => apiFetch<{ order: UpiOrder }>(`/pay/upi/order/${orderId}`),
    enabled: !!orderId && !!user,
    refetchInterval: (query) =>
      query.state.data?.order.status === 'pending' || query.state.data?.order.verificationRetryable ? 3000 : false,
    retry: (count, err) =>
      err instanceof ApiError && (err.status === 401 || err.status === 404) ? false : count < 3,
  });
  const order = data?.order;

  // Plan badge + credits everywhere update the moment the payment lands —
  // then a short celebratory pause and straight to the billing page.
  useEffect(() => {
    if (order?.status === 'paid') {
      refresh();
      qc.invalidateQueries({ queryKey: ['billing-requests'] });
      try { localStorage.removeItem(LAST_ORDER_KEY); } catch { /* ignore */ }
      const t = setTimeout(() => setLocation('/account'), 2500);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [order?.status, refresh, qc, setLocation]);

  // After ~90s of pending, soften expectations (UPI can take a minute).
  useEffect(() => {
    const t = setTimeout(() => setSlowHint(true), 90_000);
    return () => clearTimeout(t);
  }, []);

  const productName = !order ? '' : order.kind === 'topup'
    ? `${order.quantity ?? 0} ${order.creditType ?? ''} credits`
    : (order.plan ? (PLAN_NAMES[order.plan] ?? order.plan) : 'Plan');

  let body: ReactElement;
  if (!orderId) {
    body = (
      <StatusCard
        icon={<XCircle className="w-10 h-10 text-red-400" />}
        title="We couldn't find this payment"
        text="The link is missing its order id. If you just paid, your plan will still activate automatically — check your account in a minute."
        cta={<Cta href="/pricing" label="Back to pricing" />}
      />
    );
  } else if (!authLoading && !user) {
    body = (
      <StatusCard
        icon={<Clock className="w-10 h-10 text-[#D1FE17]" />}
        title="Log in to see your payment status"
        text="Your payment is being processed. Log in with the same account you paid from to watch it activate."
        cta={<Cta href={`/login?next=/pay/upi/return?order_id=${orderId}`} label="Log in" />}
      />
    );
  } else if (error instanceof ApiError && error.status === 404) {
    body = (
      <StatusCard
        icon={<XCircle className="w-10 h-10 text-red-400" />}
        title="Payment not found"
        text="This payment doesn't belong to this account. Make sure you're logged in with the account you paid from."
        cta={<Cta href="/account" label="Go to my account" />}
      />
    );
  } else if (!order) {
    body = (
      <StatusCard
        icon={<Loader2 className="w-10 h-10 text-[#D1FE17] animate-spin" />}
        title="Checking your payment…"
        text="One moment — confirming with the payment gateway."
      />
    );
  } else if (order.status === 'paid') {
    body = (
      <StatusCard
        icon={<CheckCircle2 className="w-10 h-10 text-[#D1FE17]" />}
        title={order.kind === 'topup' ? 'Top-up added! 🎉' : `${productName} plan is ACTIVE! 🎉`}
        text={`Payment of ${fmtInr(order.amountInr)} received${order.utr ? ` (UTR ${order.utr})` : ''}. Your ${order.kind === 'topup' ? productName : 'included monthly allowances'} are already in your account. Taking you to your billing page…`}
        cta={
          <div className="flex gap-3 justify-center flex-wrap">
            <Cta href="/account" label="Go to billing now" primary />
            <Cta href="/" label="Start clipping" />
          </div>
        }
      />
    );
  } else if (order.status === 'failed') {
    body = (
      <StatusCard
        icon={<XCircle className="w-10 h-10 text-red-400" />}
        title="Payment didn't go through"
        text={order.failReason || 'The payment failed or was cancelled. No money should have left your account — if it did, it will auto-refund via UPI.'}
        cta={<Cta href="/pricing" label="Try again" primary />}
      />
    );
  } else if (order.status === 'review') {
    body = (
      <StatusCard
        icon={<ShieldAlert className="w-10 h-10 text-amber-400" />}
        title="Payment received — quick check in progress"
        text="Your payment reached us but needs a quick manual confirmation. Your plan will be activated shortly — no action needed from you."
        cta={<Cta href="/account" label="Go to my account" />}
      />
    );
  } else {
    body = (
      <StatusCard
        icon={<Loader2 className="w-10 h-10 text-[#D1FE17] animate-spin" />}
        title="Waiting for your payment…"
        text={
          slowHint
            ? 'Still waiting — UPI can take a minute or two. Keep this page open; your plan activates automatically the moment the payment lands. If you closed the UPI app without paying, you can try again.'
            : `Complete the ${fmtInr(order.amountInr)} payment in your UPI app. This page updates automatically.`
        }
        cta={
          <div className="flex gap-3 justify-center flex-wrap">
            {order.paymentUrl && (
              <a
                href={order.paymentUrl}
                className="px-5 py-2.5 rounded-xl font-black text-sm bg-[#D1FE17] text-black hover:bg-[#c2ef0e] transition-all"
              >
                Reopen payment page
              </a>
            )}
            <Cta href="/pricing" label="Cancel & go back" />
          </div>
        }
      />
    );
  }

  return (
    <div className="min-h-screen bg-[#0d0d0d] text-white font-sans">
      <AppHeader />
      <main className="max-w-lg mx-auto px-4 pt-20 pb-24">{body}</main>
    </div>
  );
}

function StatusCard({ icon, title, text, cta }: { icon: ReactNode; title: string; text: string; cta?: ReactNode }) {
  return (
    <div className="bg-[#1a1a1a] border border-white/10 rounded-3xl p-8 text-center">
      <div className="flex justify-center mb-4">{icon}</div>
      <h1 className="text-2xl font-black tracking-tight mb-2">{title}</h1>
      <p className="text-white/50 text-sm leading-relaxed mb-6">{text}</p>
      {cta}
    </div>
  );
}

function Cta({ href, label, primary }: { href: string; label: string; primary?: boolean }) {
  return (
    <Link
      href={href}
      className={`inline-block px-5 py-2.5 rounded-xl font-black text-sm transition-all ${
        primary
          ? 'bg-[#D1FE17] text-black hover:bg-[#c2ef0e]'
          : 'bg-white/10 border border-white/15 text-white hover:bg-white/15'
      }`}
    >
      {label}
    </Link>
  );
}
