import type { ReactNode } from 'react';
import { Link } from 'wouter';
import { Scissors, Zap, Gift } from 'lucide-react';

// ─── Footer — sitewide, OpusClip-style link columns + socials ─────────────────
// Every link here must point somewhere real: app routes, landing anchors, or
// the support mailbox. Social handles are placeholders until the user shares
// real ones (same @autocliper name on every network).

function Column({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <h4 className="text-white/40 text-[11px] font-black uppercase tracking-widest mb-4">{title}</h4>
      <ul className="space-y-3">{children}</ul>
    </div>
  );
}

const BASE = import.meta.env.BASE_URL.replace(/\/$/, '');
/** Hash/anchor links must carry the base path themselves — wouter Link handles it for routes. */
const withBase = (p: string) => `${BASE}${p}`;

const ITEM_CLS = 'text-white/55 hover:text-white text-sm font-medium transition-colors';

function RouteItem({ href, children }: { href: string; children: ReactNode }) {
  return <li><Link href={href} className={ITEM_CLS}>{children}</Link></li>;
}

function AnchorItem({ href, children }: { href: string; children: ReactNode }) {
  return <li><a href={href} className={ITEM_CLS}>{children}</a></li>;
}

function SocialIcon({ label, href, path }: { label: string; href: string; path: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={label}
      title={label}
      className="w-9 h-9 rounded-xl bg-white/5 border border-white/8 flex items-center justify-center text-white/50 hover:text-[#D1FE17] hover:border-[#D1FE17]/40 hover:bg-[#D1FE17]/5 transition-all"
    >
      <svg viewBox="0 0 24 24" className="w-4 h-4" fill="currentColor" aria-hidden="true">
        <path d={path} />
      </svg>
    </a>
  );
}

const SOCIALS = [
  {
    label: 'AutoCliper on YouTube', href: 'https://youtube.com/@autocliper',
    path: 'M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z',
  },
  {
    label: 'AutoCliper on X (Twitter)', href: 'https://x.com/autocliper',
    path: 'M18.901 1.153h3.68l-8.04 9.19L24 22.846h-7.406l-5.8-7.584-6.638 7.584H.474l8.6-9.83L0 1.154h7.594l5.243 6.932ZM17.61 20.644h2.039L6.486 3.24H4.298Z',
  },
  {
    label: 'AutoCliper on Instagram', href: 'https://www.instagram.com/autocliper.pro?igsh=MTJheXVvZGYwM2toZg==',
    path: 'M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zm0-2.163c-3.259 0-3.667.014-4.947.072-4.358.2-6.78 2.618-6.98 6.98-.059 1.281-.073 1.689-.073 4.948 0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98 1.281.058 1.689.072 4.948.072 3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98-1.281-.059-1.69-.073-4.949-.073zm0 5.838a6.162 6.162 0 1 0 0 12.324 6.162 6.162 0 0 0 0-12.324zm0 10.162a4 4 0 1 1 0-8 4 4 0 0 1 0 8zm6.406-11.845a1.44 1.44 0 1 0 0 2.881 1.44 1.44 0 0 0 0-2.881z',
  },
  {
    label: 'AutoCliper on TikTok', href: 'https://www.tiktok.com/@autocliperofficial?lang=en-GB',
    path: 'M12.525.02c1.31-.02 2.61-.01 3.91-.02.08 1.53.63 3.09 1.75 4.17 1.12 1.11 2.7 1.62 4.24 1.79v4.03c-1.44-.05-2.89-.35-4.2-.97-.57-.26-1.1-.59-1.62-.93-.01 2.92.01 5.84-.02 8.75-.08 1.4-.54 2.79-1.35 3.94-1.31 1.92-3.58 3.17-5.91 3.21-1.43.08-2.86-.31-4.08-1.03-2.02-1.19-3.44-3.37-3.65-5.71-.02-.5-.03-1-.01-1.49.18-1.9 1.12-3.72 2.58-4.96 1.66-1.44 3.98-2.13 6.15-1.72.02 1.48-.04 2.96-.04 4.44-.99-.32-2.15-.23-3.02.37-.63.41-1.11 1.04-1.36 1.75-.21.51-.15 1.07-.14 1.61.24 1.64 1.82 3.02 3.5 2.87 1.12-.01 2.19-.66 2.77-1.61.19-.33.4-.67.41-1.06.1-1.79.06-3.57.07-5.36.01-4.03-.01-8.05.02-12.07z',
  },
];

export function Footer() {
  return (
    <footer className="border-t border-white/5 bg-[#0a0a0a]">
      <div className="max-w-6xl mx-auto px-4 sm:px-6 pt-14 pb-8">
        {/* Top: brand + link columns */}
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-x-8 gap-y-10">
          {/* Brand */}
          <div className="col-span-2 sm:col-span-3 lg:col-span-1">
            <Link href="/" className="flex items-center gap-2">
              <div className="w-7 h-7 rounded-lg bg-[#D1FE17] flex items-center justify-center">
                <Scissors className="w-4 h-4 text-black" strokeWidth={2.5} />
              </div>
              <span className="font-black text-lg tracking-tight text-white">AutoCliper</span>
            </Link>
            <p className="text-white/40 text-sm leading-relaxed mt-4">
              1 long video → many viral clips. AI finds the loudest, best moments and cuts
              them ready for Shorts, Reels &amp; TikTok.
            </p>
            <div className="flex flex-wrap gap-2 mt-5">
              <span className="inline-flex items-center gap-1.5 text-[11px] font-black text-[#D1FE17] bg-[#D1FE17]/10 border border-[#D1FE17]/25 rounded-full px-3 py-1.5 tracking-wide">
                <Zap className="w-3 h-3" />AI-powered
              </span>
              <span className="inline-flex items-center gap-1.5 text-[11px] font-black text-white/70 bg-white/[0.05] border border-white/10 rounded-full px-3 py-1.5 tracking-wide">
                <Gift className="w-3 h-3 text-[#D1FE17]" />150 free credits
              </span>
            </div>
          </div>

          {/* Product */}
          <Column title="Product">
            <AnchorItem href={withBase('/#features')}>Features</AnchorItem>
            <RouteItem href="/pricing">Pricing &amp; credits</RouteItem>
            <RouteItem href="/">Start clipping</RouteItem>
          </Column>

          {/* Platforms */}
          <Column title="Works with">
            <RouteItem href="/">YouTube</RouteItem>
            <RouteItem href="/">Kick</RouteItem>
            <RouteItem href="/">Twitch</RouteItem>
            <RouteItem href="/">Google Drive</RouteItem>
            <RouteItem href="/">Dropbox</RouteItem>
          </Column>

          {/* Account */}
          <Column title="Account">
            <RouteItem href="/login">Sign in</RouteItem>
            <RouteItem href="/signup">Get started — Free</RouteItem>
            <RouteItem href="/account">Account &amp; credits</RouteItem>
            <RouteItem href="/pricing">Buy credits</RouteItem>
          </Column>

          {/* Legal & support */}
          <Column title="Legal & support">
            <RouteItem href="/terms">Terms of Service</RouteItem>
            <RouteItem href="/privacy">Privacy Policy</RouteItem>
            <RouteItem href="/refund">Refund Policy</RouteItem>
            <RouteItem href="/contact">Contact Us</RouteItem>
          </Column>
        </div>

        {/* Bottom bar */}
        <div className="mt-12 pt-6 border-t border-white/5 flex flex-col sm:flex-row items-center justify-between gap-4">
          <p className="text-white/25 text-xs font-medium">© 2026 AutoCliper. All rights reserved.</p>
          <div className="flex items-center gap-2">
            {SOCIALS.map(s => (
              <SocialIcon key={s.label} label={s.label} href={s.href} path={s.path} />
            ))}
          </div>
        </div>
      </div>
    </footer>
  );
}

export default Footer;
