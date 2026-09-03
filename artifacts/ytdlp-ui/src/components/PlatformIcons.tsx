/**
 * Real brand SVG icon components for all supported social platforms.
 * Each icon renders a rounded-square with the brand's color/gradient
 * and a white icon mark inside. Uses useId() for Instagram gradient
 * to avoid SVG defs ID collisions when rendered multiple times.
 */
import { useId } from 'react';

// ── Icon wrapper ──────────────────────────────────────────────────────────────
type WrapProps = { size: number; fill: string; children: React.ReactNode };
function Wrap({ size, fill, children }: WrapProps) {
  const r = Math.round(size * 0.24);
  const icon = Math.round(size * 0.58);
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} xmlns="http://www.w3.org/2000/svg">
      {fill.startsWith('url') ? (
        children   /* gradient child handles its own rect + defs */
      ) : (
        <>
          <rect width={size} height={size} rx={r} fill={fill} />
          <g transform={`translate(${(size - icon) / 2}, ${(size - icon) / 2})`}>
            <svg width={icon} height={icon} viewBox="0 0 24 24">{children}</svg>
          </g>
        </>
      )}
    </svg>
  );
}

// ── Instagram ──────────────────────────────────────────────────────────────────
export function InstagramIcon({ size = 36 }: { size?: number }) {
  const uid = useId().replace(/:/g, '');
  const id  = `ig${uid}`;
  const r   = Math.round(size * 0.24);
  const pad = Math.round(size * 0.17);
  const inner = size - pad * 2;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} xmlns="http://www.w3.org/2000/svg">
      <defs>
        <radialGradient id={id} cx="30%" cy="107%" r="150%" fx="30%" fy="107%">
          <stop offset="0%"   stopColor="#fdf497" />
          <stop offset="5%"   stopColor="#fdf497" />
          <stop offset="45%"  stopColor="#fd5949" />
          <stop offset="60%"  stopColor="#d6249f" />
          <stop offset="90%"  stopColor="#285AEB" />
        </radialGradient>
      </defs>
      <rect width={size} height={size} rx={r} fill={`url(#${id})`} />
      {/* Camera body */}
      <rect x={pad} y={pad} width={inner} height={inner} rx={Math.round(inner * 0.28)} stroke="white" strokeWidth={Math.max(1, size * 0.055)} fill="none" />
      {/* Lens */}
      <circle cx={size / 2} cy={size / 2} r={inner * 0.29} stroke="white" strokeWidth={Math.max(1, size * 0.055)} fill="none" />
      {/* Flash dot */}
      <circle cx={size * 0.72} cy={size * 0.28} r={size * 0.058} fill="white" />
    </svg>
  );
}

// ── TikTok ────────────────────────────────────────────────────────────────────
export function TikTokIcon({ size = 36 }: { size?: number }) {
  return (
    <Wrap size={size} fill="#010101">
      <path d="M19.59 6.69a4.83 4.83 0 0 1-3.77-4.25V2h-3.45v13.67a2.89 2.89 0 0 1-2.88 2.5 2.89 2.89 0 0 1-2.89-2.89 2.89 2.89 0 0 1 2.89-2.89c.28 0 .54.04.79.1V9.01a6.27 6.27 0 0 0-.79-.05 6.34 6.34 0 0 0-6.34 6.34 6.34 6.34 0 0 0 6.34 6.34 6.34 6.34 0 0 0 6.33-6.34V8.93a8.2 8.2 0 0 0 4.78 1.52V7c0-.01-1-.04-2-.31z" fill="white" />
    </Wrap>
  );
}

// ── YouTube ───────────────────────────────────────────────────────────────────
export function YouTubeIcon({ size = 36 }: { size?: number }) {
  return (
    <Wrap size={size} fill="#FF0000">
      <path d="M19.615 3.184c-3.604-.246-11.631-.245-15.23 0C.488 3.45.029 5.804 0 12c.029 6.185.484 8.549 4.385 8.816 3.6.245 11.626.246 15.23 0C23.512 20.55 23.971 18.196 24 12c-.029-6.185-.484-8.549-4.385-8.816zM9 16V8l8 3.993L9 16z" fill="white" />
    </Wrap>
  );
}

// ── X (Twitter) ───────────────────────────────────────────────────────────────
export function XIcon({ size = 36 }: { size?: number }) {
  return (
    <Wrap size={size} fill="#000000">
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-4.714-6.231-5.401 6.231H2.744l7.73-8.835L1.254 2.25H8.08l4.261 5.635L18.243 2.25zm-1.161 17.52h1.833L7.084 4.126H5.117L17.083 19.77z" fill="white" />
    </Wrap>
  );
}

// ── Facebook ──────────────────────────────────────────────────────────────────
export function FacebookIcon({ size = 36 }: { size?: number }) {
  return (
    <Wrap size={size} fill="#1877F2">
      <path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z" fill="white" />
    </Wrap>
  );
}

// ── LinkedIn ──────────────────────────────────────────────────────────────────
export function LinkedInIcon({ size = 36 }: { size?: number }) {
  return (
    <Wrap size={size} fill="#0A66C2">
      <path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 0 1-2.063-2.065 2.064 2.064 0 1 1 2.063 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z" fill="white" />
    </Wrap>
  );
}

// ── Threads ───────────────────────────────────────────────────────────────────
export function ThreadsIcon({ size = 36 }: { size?: number }) {
  return (
    <Wrap size={size} fill="#101010">
      {/* Threads official icon path */}
      <path d="M12.186 24h-.007c-3.581-.024-6.334-1.205-8.184-3.509C2.35 18.44 1.5 15.586 1.5 12.068c0-3.636.865-6.49 2.576-8.518C5.784 1.427 8.27.237 11.536.012c.327-.022.65-.012.975-.012h.105c3.14 0 5.62 1.133 7.37 3.37 1.524 1.97 2.364 4.655 2.514 8.006v.027c-.005 1.618-.25 3.17-.724 4.608-.09.26-.187.513-.283.76-.516 1.213-1.24 2.285-2.154 3.186-1.527 1.49-3.481 2.261-5.682 2.287L12.186 24zm-.16-6.6c.13 0 .258-.005.386-.017 1.52-.128 2.748-.85 3.548-2.036.624-.923.967-2.12 1.023-3.562v-.125a10.9 10.9 0 0 0-.05-1.059c-.213-1.97-.965-3.475-2.242-4.49C13.45 5.054 12.143 4.6 10.57 4.6h-.09c-1.98.017-3.527.8-4.597 2.327-1.03 1.47-1.552 3.418-1.552 5.79 0 2.32.508 4.213 1.512 5.633.994 1.405 2.553 2.155 4.56 2.155l.623-.105z" fill="white" />
    </Wrap>
  );
}

// ── Pinterest ─────────────────────────────────────────────────────────────────
export function PinterestIcon({ size = 36 }: { size?: number }) {
  return (
    <Wrap size={size} fill="#E60023">
      <path d="M12.017 0C5.396 0 .029 5.367.029 11.987c0 5.079 3.158 9.417 7.618 11.162-.105-.949-.2-2.405.042-3.441.218-.937 1.407-5.965 1.407-5.965s-.359-.719-.359-1.782c0-1.668.967-2.914 2.171-2.914 1.023 0 1.518.769 1.518 1.69 0 1.029-.655 2.568-.994 3.995-.283 1.194.599 2.169 1.777 2.169 2.133 0 3.772-2.249 3.772-5.495 0-2.873-2.064-4.882-5.012-4.882-3.414 0-5.418 2.561-5.418 5.207 0 1.031.397 2.138.893 2.738a.36.36 0 0 1 .083.345l-.333 1.36c-.053.22-.174.267-.402.161-1.499-.698-2.436-2.889-2.436-4.649 0-3.785 2.75-7.262 7.929-7.262 4.163 0 7.398 2.967 7.398 6.931 0 4.136-2.607 7.464-6.227 7.464-1.216 0-2.359-.632-2.75-1.378l-.748 2.853c-.271 1.043-1.002 2.35-1.492 3.146C9.57 23.812 10.763 24 12.017 24c6.624 0 11.99-5.367 11.99-11.987C24.007 5.367 18.641 0 12.017 0z" fill="white" />
    </Wrap>
  );
}

// ── Reddit ────────────────────────────────────────────────────────────────────
export function RedditIcon({ size = 36 }: { size?: number }) {
  return (
    <Wrap size={size} fill="#FF4500">
      <path d="M12 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0zm5.01 4.744c.688 0 1.25.561 1.25 1.249a1.25 1.25 0 0 1-2.498.056l-2.597-.547-.8 3.747c1.824.07 3.48.632 4.674 1.488.308-.309.73-.491 1.207-.491.968 0 1.754.786 1.754 1.754 0 .716-.435 1.333-1.01 1.614a3.111 3.111 0 0 1 .042.52c0 2.694-3.13 4.87-7.004 4.87-3.874 0-7.004-2.176-7.004-4.87 0-.183.015-.366.043-.534A1.748 1.748 0 0 1 4.028 12c0-.968.786-1.754 1.754-1.754.463 0 .898.196 1.207.49 1.207-.883 2.878-1.43 4.744-1.487l.885-4.182a.342.342 0 0 1 .14-.197.35.35 0 0 1 .238-.042l2.906.617a1.214 1.214 0 0 1 1.108-.701zM9.25 12C8.561 12 8 12.562 8 13.25c0 .687.561 1.248 1.25 1.248.687 0 1.248-.561 1.248-1.249 0-.688-.561-1.249-1.249-1.249zm5.5 0c-.687 0-1.248.561-1.248 1.25 0 .687.561 1.248 1.249 1.248.688 0 1.249-.561 1.249-1.249 0-.687-.562-1.249-1.25-1.249zm-5.466 3.99a.327.327 0 0 0-.231.094.33.33 0 0 0 0 .463c.842.842 2.484.913 2.961.913.477 0 2.105-.056 2.961-.913a.361.361 0 0 0 .029-.463.33.33 0 0 0-.464 0c-.547.533-1.684.73-2.512.73-.828 0-1.979-.196-2.512-.73a.326.326 0 0 0-.232-.095z" fill="white" />
    </Wrap>
  );
}

// ── Bluesky ───────────────────────────────────────────────────────────────────
export function BlueskyIcon({ size = 36 }: { size?: number }) {
  return (
    <Wrap size={size} fill="#0085FF">
      <path d="M12 10.8c-1.087-2.114-4.046-6.053-6.798-7.995C2.566.944 1.561 1.266 1.061 1.61c-.5.344-.715 1.094-.706 1.669.01.575.03 5.475 1.14 6.275 1.112.8 3.427 2.25 7.14 2.53C5.4 12.5 1.34 13.25.7 14.3c-.64 1.058.5 2.3 1.5 2.5.5.1.95.1 1.5.05L12 14.3l8.3 2.55c.55.05 1 .05 1.5-.05 1-.2 2.14-1.442 1.5-2.5-.64-1.05-4.7-1.8-7.94-2.22 3.71-.28 6.025-1.73 7.14-2.53 1.112-.8 1.13-5.7 1.14-6.275.009-.575-.203-1.325-.702-1.665-.499-.344-1.504-.666-4.141 1.195C16.046 4.747 13.087 8.686 12 10.8z" fill="white" />
    </Wrap>
  );
}

// ── Master dispatcher ─────────────────────────────────────────────────────────
export function PlatformIcon({ type, size = 36 }: { type: string; size?: number }) {
  switch (type.toUpperCase()) {
    case 'INSTAGRAM': return <InstagramIcon size={size} />;
    case 'TIKTOK':    return <TikTokIcon    size={size} />;
    case 'TIKTOK_BUSINESS': return <TikTokIcon size={size} />;
    case 'YOUTUBE':   return <YouTubeIcon   size={size} />;
    case 'TWITTER':   return <XIcon         size={size} />;
    case 'X':         return <XIcon         size={size} />;
    case 'FACEBOOK':  return <FacebookIcon  size={size} />;
    case 'LINKEDIN':  return <LinkedInIcon  size={size} />;
    case 'THREADS':   return <ThreadsIcon   size={size} />;
    case 'PINTEREST': return <PinterestIcon size={size} />;
    case 'REDDIT':    return <RedditIcon    size={size} />;
    case 'BLUESKY':   return <BlueskyIcon   size={size} />;
    default:
      return (
        <div style={{ width: size, height: size, borderRadius: Math.round(size * 0.24), background: '#333', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: size * 0.5 }}>
          📱
        </div>
      );
  }
}

/** Platform metadata — brand colors + labels for pill / list display */
export const PLATFORM_META: Record<string, { label: string; color: string }> = {
  INSTAGRAM: { label: 'Instagram', color: '#E1306C' },
  TIKTOK:    { label: 'TikTok',    color: '#69C9D0' },
  TIKTOK_BUSINESS: { label: 'TikTok Business', color: '#69C9D0' },
  YOUTUBE:   { label: 'YouTube',   color: '#FF0000' },
  TWITTER:   { label: 'X',         color: '#FFFFFF' },
  X:         { label: 'X',         color: '#FFFFFF' },
  FACEBOOK:  { label: 'Facebook',  color: '#1877F2' },
  LINKEDIN:  { label: 'LinkedIn',  color: '#0A66C2' },
  THREADS:   { label: 'Threads',   color: '#FFFFFF' },
  PINTEREST: { label: 'Pinterest', color: '#E60023' },
  REDDIT:    { label: 'Reddit',    color: '#FF4500' },
  BLUESKY:   { label: 'Bluesky',   color: '#0085FF' },
};

/** Platforms connectable through the posting provider (Post for Me). */
export const ALL_PLATFORM_KEYS = [
  'INSTAGRAM','TIKTOK','YOUTUBE','X','FACEBOOK',
  'LINKEDIN','THREADS','PINTEREST','BLUESKY',
];
