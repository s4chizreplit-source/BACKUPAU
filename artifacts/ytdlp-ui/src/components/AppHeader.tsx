/**
 * Shared dark header for the secondary pages (Pricing, Account, Admin).
 */
import { useEffect, useState, type ReactNode } from 'react';
import { Link, useLocation } from 'wouter';
import { Scissors, Zap, LogOut, Shield, CreditCard, Share2, ChevronDown, Gift, Rocket, Film } from 'lucide-react';
import { useAuth } from '../lib/auth';

function MenuRow({ icon, label, onSelect }: { icon: ReactNode; label: string; onSelect: () => void }) {
  return (
    <button
      onClick={onSelect}
      className="group w-full flex items-center gap-3 px-2.5 py-2 rounded-xl text-white/70 hover:text-white hover:bg-white/[0.05] text-sm font-semibold transition-colors"
    >
      <span className="w-7 h-7 shrink-0 rounded-lg bg-white/[0.05] border border-white/[0.07] flex items-center justify-center text-white/50 group-hover:text-[#D1FE17] group-hover:border-[#D1FE17]/25 group-hover:bg-[#D1FE17]/10 transition-colors">
        {icon}
      </span>
      <span className="flex-1 text-left truncate">{label}</span>
    </button>
  );
}

export function AppHeader() {
  const { user, logout } = useAuth();
  const [location, setLocation] = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    if (!menuOpen) return;
    const handler = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest('[data-app-user-menu]')) setMenuOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [menuOpen]);

  return (
    <nav className="sticky top-0 z-50 bg-[#0a0a0a]/80 backdrop-blur-2xl">
      {/* Lime hairline bottom */}
      <div className="absolute bottom-0 inset-x-0 h-px bg-gradient-to-r from-transparent via-[#D1FE17]/20 to-transparent" />
      <div className="max-w-6xl mx-auto px-4 sm:px-6 h-[60px] flex items-center justify-between gap-4">

        {/* Logo */}
        <Link href="/" className="flex items-center gap-2.5 shrink-0">
          <div className="w-8 h-8 rounded-xl bg-[#D1FE17] flex items-center justify-center shadow-[0_0_20px_rgba(209,254,23,0.35)]">
            <Scissors className="w-4 h-4 text-black" strokeWidth={2.5} />
          </div>
          <span className="font-black text-[17px] tracking-tight text-white">AutoCliper</span>
        </Link>

        {/* Center nav — slim frosted pill. Logged in = app links (the
            marketing anchors only confuse someone who's already inside). */}
        {user ? (
          <div className="hidden md:flex items-center gap-0.5 px-1.5 py-1.5 rounded-full border border-white/[0.07] bg-white/[0.03] text-sm font-semibold text-white/50">
            {([
              ['/', 'Home'],
              ['/history', 'My videos'],
              ['/autopilot', 'Auto-Pilot'],
              ['/social', 'Social'],
            ] as const).map(([href, label]) => (
              <Link
                key={href}
                href={href}
                className={`px-4 py-1.5 rounded-full transition-all duration-150 ${location === href ? 'text-white bg-white/[0.08]' : 'hover:text-white hover:bg-white/[0.06]'}`}
              >
                {label}
              </Link>
            ))}
            <Link href="/#refer" className="flex items-center gap-1.5 px-4 py-1.5 rounded-full text-[#D1FE17]/80 hover:text-[#D1FE17] hover:bg-[#D1FE17]/8 transition-all duration-150">
              <Gift className="w-3.5 h-3.5" />Refer
            </Link>
          </div>
        ) : (
          <div className="hidden md:flex items-center gap-0.5 px-1.5 py-1.5 rounded-full border border-white/[0.07] bg-white/[0.03] text-sm font-semibold text-white/50">
            <Link href="/#features" className="px-3.5 py-1.5 rounded-full hover:text-white hover:bg-white/[0.06] transition-all duration-150 whitespace-nowrap">Features</Link>
            <Link href="/#autopilot" className="px-3.5 py-1.5 rounded-full hover:text-white hover:bg-white/[0.06] transition-all duration-150 whitespace-nowrap">Auto-Pilot</Link>
            <Link href="/pricing" className="px-3.5 py-1.5 rounded-full hover:text-white hover:bg-white/[0.06] transition-all duration-150">Pricing</Link>
            <Link href="/#refer" className="flex items-center gap-1.5 px-4 py-1.5 rounded-full text-[#D1FE17]/80 hover:text-[#D1FE17] hover:bg-[#D1FE17]/8 transition-all duration-150">
              <Gift className="w-3.5 h-3.5" />Refer
            </Link>
          </div>
        )}

        {/* Right */}
        <div className="flex items-center gap-2.5 shrink-0">
          {user ? (
            <>
              {/* No standalone chips — pill nav covers navigation, credits live
                  in the avatar menu (user request). */}
              <div className="relative" data-app-user-menu>
                <button
                  onClick={() => setMenuOpen(o => !o)}
                  className={`flex items-center gap-2 rounded-xl pl-1.5 pr-2.5 py-1.5 border transition-all ${
                    menuOpen
                      ? 'bg-[#D1FE17]/10 border-[#D1FE17]/30'
                      : 'bg-white/[0.05] border-white/[0.08] hover:bg-white/10'
                  }`}
                >
                  <span className="w-7 h-7 rounded-lg bg-[#D1FE17] text-black text-sm font-black flex items-center justify-center shadow-[0_0_14px_rgba(209,254,23,0.35)]">
                    {(user.name || user.email)[0].toUpperCase()}
                  </span>
                  <span className="hidden sm:block text-[13px] font-semibold text-white/80 max-w-[120px] truncate">
                    {user.name || user.email.split('@')[0]}
                  </span>
                  <ChevronDown className={`hidden sm:block w-3.5 h-3.5 text-white/40 transition-transform ${menuOpen ? 'rotate-180' : ''}`} />
                </button>
                {menuOpen && (
                  <div className="absolute right-0 top-full mt-2 w-[17rem] rounded-2xl border border-white/10 bg-gradient-to-b from-[#161616] to-[#0e0e0e] shadow-2xl shadow-black/70 overflow-hidden z-50">
                    <div className="h-px bg-gradient-to-r from-transparent via-[#D1FE17]/70 to-transparent" />
                    <div className="relative px-4 pt-4 pb-3">
                      <div className="absolute -top-10 right-0 w-36 h-20 bg-[#D1FE17]/10 blur-2xl pointer-events-none" />
                      <div className="relative flex items-center gap-3">
                        <span className="w-10 h-10 shrink-0 rounded-xl bg-[#D1FE17] text-black text-lg font-black flex items-center justify-center shadow-[0_0_20px_rgba(209,254,23,0.3)]">
                          {(user.name || user.email)[0].toUpperCase()}
                        </span>
                        <div className="min-w-0">
                          <p className="text-white text-sm font-black truncate">{user.name || 'Creator'}</p>
                          <p className="text-white/35 text-[11px] truncate mt-0.5">{user.email}</p>
                        </div>
                      </div>
                      <button
                        onClick={() => { setMenuOpen(false); setLocation('/account'); }}
                        className="relative mt-3 w-full flex items-center justify-between rounded-xl border border-[#D1FE17]/20 bg-[#D1FE17]/[0.06] hover:bg-[#D1FE17]/[0.12] px-3 py-2 transition-colors"
                      >
                        <span className="flex items-center gap-1.5 text-[#D1FE17] text-sm font-black">
                          <Zap className="w-4 h-4" />{user.credits.cutting.total} cutting · {user.credits.uploading.total} uploads
                        </span>
                        <span className="text-[10px] font-black uppercase tracking-wider text-[#D1FE17]/70">Top up →</span>
                      </button>
                    </div>
                    <div className="p-2 pt-0">
                      <MenuRow icon={<Film className="w-4 h-4" />} label="My videos" onSelect={() => { setMenuOpen(false); setLocation('/history'); }} />
                      <MenuRow icon={<CreditCard className="w-4 h-4" />} label="Account & billing" onSelect={() => { setMenuOpen(false); setLocation('/account'); }} />
                      <MenuRow icon={<Share2 className="w-4 h-4" />} label="Social auto-post" onSelect={() => { setMenuOpen(false); setLocation('/social'); }} />
                      <MenuRow icon={<Rocket className="w-4 h-4" />} label="Auto-Pilot" onSelect={() => { setMenuOpen(false); setLocation('/autopilot'); }} />
                      {user.role === 'admin' && (
                        <MenuRow icon={<Shield className="w-4 h-4" />} label="Admin panel" onSelect={() => { setMenuOpen(false); setLocation('/admin'); }} />
                      )}
                    </div>
                    <div className="mx-3 h-px bg-white/[0.06]" />
                    <div className="p-2">
                      <button
                        onClick={async () => { setMenuOpen(false); await logout(); setLocation('/'); }}
                        className="group w-full flex items-center gap-3 px-2.5 py-2 rounded-xl text-red-400/70 hover:text-red-400 hover:bg-red-500/[0.07] text-sm font-semibold transition-colors"
                      >
                        <span className="w-7 h-7 shrink-0 rounded-lg bg-white/[0.05] border border-white/[0.07] flex items-center justify-center group-hover:bg-red-500/10 group-hover:border-red-500/25 transition-colors">
                          <LogOut className="w-4 h-4" />
                        </span>
                        Log out
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </>
          ) : (
            <>
              <Link href="/login" className="text-[13px] font-semibold text-white/50 hover:text-white transition-colors">
                Sign in
              </Link>
              <Link href="/signup" className="bg-[#D1FE17] text-black text-[13px] font-black px-4 py-2 rounded-full hover:bg-[#c5f010] active:scale-95 transition-all shadow-[0_0_18px_rgba(209,254,23,0.25)]">
                Get started — Free
              </Link>
            </>
          )}
        </div>
      </div>
    </nav>
  );
}
