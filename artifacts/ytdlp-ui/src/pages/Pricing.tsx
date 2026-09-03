import { AppHeader } from '../components/AppHeader';
import { Footer } from '../components/Footer';
import PricingCards from '../components/PricingCards';

export default function Pricing() {
  return (
    <div className="min-h-screen bg-[#0d0d0d] text-white font-sans flex flex-col">
      <AppHeader />

      <main className="flex-1 px-4 sm:px-6 py-14 sm:py-20">
        <section className="max-w-5xl mx-auto">
          <div className="text-center mb-12">
            <p className="text-[#D1FE17] text-xs font-black uppercase tracking-[0.25em] mb-3">
              Pricing &amp; credits
            </p>
            <h1 className="text-4xl sm:text-5xl font-black tracking-tight leading-tight">
              Simple pricing. <span className="text-[#D1FE17]">Viral results.</span>
            </h1>
            <p className="text-white/60 text-base sm:text-lg mt-4 max-w-2xl mx-auto">
              Every plan includes separate cutting credits and upload processing allowances.
              Pay securely in INR with UPI.
            </p>
          </div>

          <PricingCards initialInterval="yearly" signupNext="/pricing" />
        </section>
      </main>

      <Footer />
    </div>
  );
}