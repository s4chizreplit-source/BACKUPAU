import type { ReactNode } from 'react';
import { Link } from 'wouter';
import { Scissors, ArrowLeft } from 'lucide-react';
import { Footer } from './Footer';

// ─── Shared shell for Terms / Privacy pages ───────────────────────────────────

export function LegalSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mb-8">
      <h2 className="text-white font-black text-lg mb-3">{title}</h2>
      <div className="text-white/55 text-sm leading-relaxed space-y-3">{children}</div>
    </section>
  );
}

export function LegalLayout({ title, updated, children }: {
  title: string;
  updated: string;
  children: ReactNode;
}) {
  return (
    <div className="min-h-screen bg-[#0d0d0d] text-white font-sans flex flex-col">
      <nav className="sticky top-0 z-50 border-b border-white/5 bg-[#0d0d0d]/90 backdrop-blur-xl">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 h-14 flex items-center justify-between gap-4">
          <Link href="/" className="flex items-center gap-2 shrink-0">
            <div className="w-7 h-7 rounded-lg bg-[#D1FE17] flex items-center justify-center">
              <Scissors className="w-4 h-4 text-black" strokeWidth={2.5} />
            </div>
            <span className="font-black text-lg tracking-tight">AutoCliper</span>
          </Link>
          <Link
            href="/"
            className="flex items-center gap-2 text-sm font-semibold text-white/60 hover:text-white transition-colors"
          >
            <ArrowLeft className="w-4 h-4" />
            Back to app
          </Link>
        </div>
      </nav>

      <main className="flex-1 max-w-3xl mx-auto w-full px-4 sm:px-6 py-12">
        <h1 className="text-3xl sm:text-4xl font-black tracking-tight">{title}</h1>
        <p className="text-white/30 text-xs font-semibold mt-2 mb-10">Last updated: {updated}</p>
        {children}
      </main>

      <Footer />
    </div>
  );
}
