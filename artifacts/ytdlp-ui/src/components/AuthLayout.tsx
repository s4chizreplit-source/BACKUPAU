/**
 * Premium shared shell for the auth pages (Login / SignUp).
 * Left: the form column with logo + legal footer.
 * Right (desktop only): brand showcase — matches the landing's lime/dark
 * design language (gradient-border cards, glows, hairlines) so signing in
 * feels like part of the product, not a template.
 */
import { type ReactNode } from 'react';
import { Link } from 'wouter';
import { Scissors, Rocket, Film, Check, Sparkles } from 'lucide-react';

const MOCK_CLIPS = [
  { name: 'stream-highlight-01', dur: '0:31' },
  { name: 'loudest-moment-02', dur: '0:28' },
  { name: 'viral-hook-03', dur: '0:34' },
] as const;

export function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-[#0a0a0a] text-white flex">
      {/* ── Left: form column ─────────────────────────────────────────────── */}
      <div className="relative flex flex-col w-full lg:w-[540px] shrink-0 min-h-screen px-6 sm:px-12 py-7">
        {/* Soft lime glow bleeding in from the corner */}
        <div className="absolute -top-28 -left-28 w-80 h-80 bg-[#D1FE17]/[0.06] blur-[110px] rounded-full pointer-events-none" />

        <Link href="/" className="relative flex items-center gap-2.5 w-fit">
          <div className="w-9 h-9 rounded-xl bg-[#D1FE17] flex items-center justify-center shadow-[0_0_20px_rgba(209,254,23,0.35)]">
            <Scissors className="w-5 h-5 text-black" strokeWidth={2.5} />
          </div>
          <span className="font-black text-xl tracking-tight">AutoCliper</span>
        </Link>

        <div className="relative flex-1 flex items-center py-10">
          <div className="w-full max-w-[400px] mx-auto lg:mx-0">{children}</div>
        </div>

        <div className="relative flex items-center gap-4 text-white/25 text-xs font-semibold">
          <span>© {new Date().getFullYear()} AutoCliper</span>
          <Link href="/terms" className="hover:text-white/60 transition-colors">Terms</Link>
          <Link href="/privacy" className="hover:text-white/60 transition-colors">Privacy</Link>
        </div>
      </div>

      {/* ── Right: brand showcase (desktop) ───────────────────────────────── */}
      <div className="hidden lg:flex flex-1 relative overflow-hidden items-center justify-center">
        {/* Hairline separator + ambient glows */}
        <div className="absolute left-0 inset-y-0 w-px bg-gradient-to-b from-transparent via-[#D1FE17]/20 to-transparent" />
        <div className="absolute -top-32 right-0 w-[480px] h-[380px] bg-[#D1FE17]/[0.05] blur-[130px] rounded-full pointer-events-none" />
        <div className="absolute bottom-0 -left-20 w-[380px] h-[300px] bg-[#D1FE17]/[0.04] blur-[120px] rounded-full pointer-events-none" />

        <div className="relative max-w-[440px] px-10 py-16">
          <p className="flex items-center gap-2 text-[#D1FE17] text-[11px] font-black uppercase tracking-[0.25em] mb-4">
            <span className="w-5 h-px bg-[#D1FE17]/60" />Clip · Caption · Post · Repeat
          </p>
          <h2 className="text-4xl xl:text-[44px] font-black leading-[1.05] tracking-tight">
            1 long video.<br />
            <span className="text-[#D1FE17]">Clips that post themselves.</span>
          </h2>
          <p className="text-white/40 text-sm leading-relaxed mt-4 mb-10 max-w-sm">
            AI cuts the loudest moments, burns word-by-word subtitles, writes the
            caption and posts to TikTok, Reels &amp; Shorts — even while you sleep.
          </p>

          {/* Mock Auto-Pilot card */}
          <div className="relative">
            <div className="absolute -inset-4 bg-[#D1FE17]/[0.06] blur-3xl rounded-full pointer-events-none" />
            <div className="relative rounded-3xl p-px bg-gradient-to-b from-[#D1FE17]/50 via-white/10 to-white/5">
              <div className="rounded-[calc(1.5rem-1px)] bg-gradient-to-b from-[#151a0b] via-[#111111] to-[#0e0e0e] p-5">
                <div className="flex items-center justify-between mb-4">
                  <div className="flex items-center gap-2.5">
                    <div className="w-9 h-9 rounded-xl bg-[#D1FE17] text-black flex items-center justify-center shadow-[0_0_18px_rgba(209,254,23,0.35)]">
                      <Rocket className="w-[18px] h-[18px]" />
                    </div>
                    <div>
                      <p className="text-white text-[13px] font-black">Auto-Pilot · running</p>
                      <p className="text-white/35 text-[10px] font-semibold mt-0.5">posts daily · 7:30 PM</p>
                    </div>
                  </div>
                  <div className="w-10 h-[22px] rounded-full bg-[#D1FE17] relative shrink-0" title="On">
                    <span className="absolute right-0.5 top-0.5 w-[18px] h-[18px] rounded-full bg-black" />
                  </div>
                </div>

                {MOCK_CLIPS.map((c, i) => (
                  <div key={c.name} className="flex items-center gap-3 rounded-xl border border-white/[0.06] bg-white/[0.03] px-3 py-2.5 mb-2">
                    <span className="w-8 h-8 rounded-lg bg-[#D1FE17]/10 border border-[#D1FE17]/25 text-[#D1FE17] flex items-center justify-center shrink-0">
                      <Film className="w-4 h-4" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="text-white/80 text-xs font-bold truncate">{c.name}.mp4</p>
                      <p className="text-white/30 text-[10px] font-semibold">{c.dur} · 9:16 · captions on</p>
                    </div>
                    {i < 2 ? (
                      <span className="flex items-center gap-1 text-[#D1FE17] text-[10px] font-black shrink-0">
                        <Check className="w-3.5 h-3.5" strokeWidth={3} />Posted
                      </span>
                    ) : (
                      <span className="flex items-center gap-1.5 text-white/40 text-[10px] font-black shrink-0">
                        <span className="w-1.5 h-1.5 rounded-full bg-[#D1FE17] animate-pulse" />Queued
                      </span>
                    )}
                  </div>
                ))}

                <div className="flex items-center text-[10px] font-bold mt-3">
                  <span className="text-white/35 flex items-center gap-1.5">
                    <Sparkles className="w-3 h-3 text-[#D1FE17]" />AI captions on every post
                  </span>
                </div>
              </div>
            </div>

            {/* Floating "posted" toast */}
            <div className="absolute -bottom-5 -right-4 rounded-2xl border border-white/10 bg-[#161616]/95 backdrop-blur px-3.5 py-2.5 shadow-2xl shadow-black/60 flex items-center gap-2.5">
              <span className="w-7 h-7 rounded-lg bg-[#D1FE17] text-black flex items-center justify-center">
                <Check className="w-4 h-4" strokeWidth={3} />
              </span>
              <div>
                <p className="text-white text-[11px] font-black leading-tight">Posted to TikTok</p>
                <p className="text-white/35 text-[10px] font-semibold">while you were sleeping 😴</p>
              </div>
            </div>
          </div>

          {/* Platform belt */}
          <div className="flex flex-wrap items-center gap-1.5 mt-12">
            {['TikTok', 'Instagram', 'YouTube', 'X', 'Facebook'].map(p => (
              <span key={p} className="px-2.5 py-1 rounded-full bg-white/[0.04] border border-white/[0.08] text-white/45 text-[11px] font-bold">{p}</span>
            ))}
            <span className="px-2.5 py-1 rounded-full bg-[#D1FE17]/10 border border-[#D1FE17]/25 text-[#D1FE17] text-[11px] font-black">+5 more</span>
          </div>
        </div>
      </div>
    </div>
  );
}
