/**
 * INR plan selection and ZapUPI checkout.
 */
import { useState } from 'react';
import { useLocation } from 'wouter';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Check, Loader2, Zap, Building2 } from 'lucide-react';
import { apiFetch, useAuth } from '../lib/auth';
import { type BillingInterval, type Catalog, type CatalogPlan, type UpiOrder, fmtInr } from '../lib/billingTypes';

interface Props {
  initialInterval?: BillingInterval;
  signupNext?: string;
}

function planFeatures(plan: CatalogPlan): string[] {
  return [
    `${plan.cuttingCredits.toLocaleString()} cutting credits each month`,
    'Free auto-uploading included',
    'YouTube, Kick, Twitch, Vimeo & more',
    'AI finds the strongest moments',
    'Ready for Shorts, Reels & TikTok',
  ];
}

export default function PricingCards({ initialInterval = 'yearly', signupNext = '/pricing' }: Props) {
  const { user, loading: authLoading } = useAuth();
  const [, setLocation] = useLocation();
  const [billingInterval, setBillingInterval] = useState<BillingInterval>(initialInterval);
  const { data: catalog, error } = useQuery({
    queryKey: ['billing-catalog'],
    queryFn: () => apiFetch<Catalog>('/billing/catalog'),
    staleTime: 5 * 60 * 1000,
  });

  const checkout = useMutation({
    mutationFn: (value: { plan: string; interval: BillingInterval }) =>
      apiFetch<UpiOrder>('/pay/upi/order', {
        method: 'POST',
        body: JSON.stringify({ kind: 'plan', ...value }),
      }),
    onSuccess: (order) => {
      try { localStorage.setItem('autocliper_upi_last_order', order.orderId); } catch { /* ignore */ }
      if (order.paymentUrl) window.location.assign(order.paymentUrl);
      else setLocation(`/pay/upi/return?order_id=${encodeURIComponent(order.orderId)}`);
    },
  });

  const requireAccount = () => setLocation(`/signup?next=${encodeURIComponent(signupNext)}`);
  const upiAvailable = !!catalog?.upi?.available;

  return (
    <>
      <div className="flex justify-center mb-8">
        <div className="inline-flex items-center bg-[#1a1a1a] border border-white/10 rounded-full p-1">
          {(['monthly', 'yearly'] as const).map(interval => (
            <button key={interval} onClick={() => setBillingInterval(interval)}
              className={`px-5 py-2 rounded-full text-sm font-bold transition-all ${billingInterval === interval ? 'bg-[#D1FE17] text-black' : 'text-white/60 hover:text-white'}`}>
              {interval === 'monthly' ? 'Monthly' : 'Yearly · 2 months free'}
            </button>
          ))}
        </div>
      </div>

      {checkout.error && <p className="mb-6 rounded-xl border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-200">{(checkout.error as Error).message}</p>}
      {error && <p className="mb-6 rounded-xl border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-200">Pricing is unavailable right now. Please try again shortly.</p>}
      {!catalog ? <div className="flex justify-center py-20"><Loader2 className="w-8 h-8 text-white/30 animate-spin" /></div> : (
        <>
          {!upiAvailable && <p className="mb-6 rounded-xl border border-amber-400/30 bg-amber-400/10 p-4 text-sm text-amber-100">UPI checkout is temporarily unavailable. Please check back shortly.</p>}
          <div className="grid md:grid-cols-3 gap-5 items-stretch">
            {catalog.plans.map((plan, index) => {
              const highlighted = index === 1;
              const isCurrent = user?.plan === plan.id && user.planStatus === 'active' && user.planInterval === billingInterval;
              const price = billingInterval === 'monthly' ? plan.priceMonthlyInr : plan.priceYearlyInr;
              return <div key={plan.id} className={`relative flex flex-col rounded-3xl border p-7 ${highlighted ? 'bg-[#161a0d] border-[#D1FE17]/50' : 'bg-[#1a1a1a] border-white/10'}`}>
                {highlighted && <span className="absolute -top-3 left-1/2 -translate-x-1/2 bg-[#D1FE17] text-black text-[11px] font-black uppercase tracking-widest px-4 py-1 rounded-full">Most popular</span>}
                <p className="text-white/55 text-sm mt-1">{plan.tagline}</p>
                <div className="mt-5"><span className="text-5xl font-black">{fmtInr(price)}</span><span className="text-white/45 text-sm font-semibold">/{billingInterval === 'monthly' ? 'month' : 'year'}</span></div>
                <p className={`text-xs mb-6 mt-1 ${billingInterval === 'yearly' ? 'text-[#D1FE17]' : 'text-white/45'}`}>{billingInterval === 'yearly' ? `≈ ${fmtInr(price / 12)}/month · 2 months free` : 'Billed monthly · pay by UPI'}</p>
                <button disabled={!upiAvailable || authLoading || checkout.isPending || isCurrent}
                  onClick={() => !user ? requireAccount() : checkout.mutate({ plan: plan.id, interval: billingInterval })}
                  className={`w-full py-3 rounded-xl font-black text-sm disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2 ${highlighted ? 'bg-[#D1FE17] text-black hover:bg-[#c2ef0e]' : 'bg-white text-black hover:bg-white/90'}`}>
                  {checkout.isPending && checkout.variables?.plan === plan.id ? <Loader2 className="w-4 h-4 animate-spin" /> : <Zap className="w-4 h-4" strokeWidth={3} />}
                  {isCurrent ? 'Your current plan' : !user ? 'Get started with UPI' : `Pay ${fmtInr(price)} with UPI`}
                </button>
                <p className="text-center text-[11px] text-white/45 mt-2">Secure ZapUPI checkout · activates after payment</p>
                <ul className="mt-7 space-y-3 text-sm">{planFeatures(plan).map(feature => <li key={feature} className="flex gap-2.5"><Check className="w-4 h-4 text-[#D1FE17] shrink-0 mt-0.5" strokeWidth={3} /><span className="text-white/75">{feature}</span></li>)}</ul>
              </div>;
            })}
            <div className="relative flex flex-col rounded-3xl border bg-[#1a1a1a] border-white/10 p-7">
              <h3 className="text-xl font-black flex items-center gap-2"><Building2 className="w-5 h-5 text-white/50" /> Business</h3>
              <p className="text-white/55 text-sm mt-1">For agencies &amp; big channels</p>
              <div className="mt-5 mb-1 text-5xl font-black">Custom</div>
              <p className="text-xs text-white/45 mb-6">tailored to your volume</p>
              <a href="mailto:support@autocliper.com?subject=AutoCliper%20Business%20plan" className="w-full py-3 rounded-xl font-black text-sm text-center bg-white/10 border border-white/15 text-white hover:bg-white/15">Contact us</a>
            </div>
          </div>
        </>
      )}
    </>
  );
}