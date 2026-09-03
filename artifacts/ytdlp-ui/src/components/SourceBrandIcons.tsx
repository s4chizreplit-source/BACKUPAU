import type { ComponentType } from 'react';
import { Film } from 'lucide-react';

// Tiny brand icons for video SOURCES (where clips come FROM: YouTube, Kick,
// Twitch, Drive, Dropbox, direct .mp4). Kept as a shared component so pages
// don't import each other's lazy-loaded chunks just to reuse an icon.

type IconProps = { className?: string };

const YouTubeIcon = ({ className }: IconProps) => (
  <svg viewBox="0 0 24 24" className={className} fill="currentColor">
    <path d="M23.5 6.19a3.02 3.02 0 0 0-2.12-2.14C19.54 3.5 12 3.5 12 3.5s-7.54 0-9.38.55A3.02 3.02 0 0 0 .5 6.19C0 8.04 0 12 0 12s0 3.96.5 5.81a3.02 3.02 0 0 0 2.12 2.14C4.46 20.5 12 20.5 12 20.5s7.54 0 9.38-.55a3.02 3.02 0 0 0 2.12-2.14C24 15.96 24 12 24 12s0-3.96-.5-5.81zM9.75 15.5v-7l6.5 3.5-6.5 3.5z" />
  </svg>
);

const KickIcon = ({ className }: IconProps) => (
  <svg viewBox="0 0 24 24" className={className} fill="currentColor">
    <path d="M3 2h4v8l5-8h5l-6 9 6 11h-5l-5-9v9H3V2z" />
  </svg>
);

const TwitchIcon = ({ className }: IconProps) => (
  <svg viewBox="0 0 24 24" className={className} fill="currentColor">
    <path d="M11.571 4.714h1.715v5.143H11.57zm4.715 0H18v5.143h-1.714zM6 0L1.714 4.286v15.428h5.143V24l4.286-4.286h3.428L22.286 12V0zm14.571 11.143l-3.428 3.428h-3.429l-3 3v-3H6.857V1.714h13.714z" />
  </svg>
);

const GDriveIcon = ({ className }: IconProps) => (
  <svg viewBox="0 0 24 24" className={className} fill="currentColor">
    <path d="M6.28 3L1 12.36l3.72 6.44L10 9.44zm11.44 0L12 9.44l3.28 5.68h6.44zM9.72 11.8L6 18.8h12l-3.72-7z" style={{ fill: '#4285F4' }} />
    <path d="M1 12.36L6.28 3h5.44L6 12.36z" style={{ fill: '#34A853' }} />
    <path d="M12 9.44l5.72-6.44H18l-6.28 10.88L9.72 9.44z" style={{ fill: '#FBBC04' }} />
  </svg>
);

const DropboxIcon = ({ className }: IconProps) => (
  <svg viewBox="0 0 24 24" className={className} fill="currentColor">
    <path d="M6 2L0 6l6 4-6 4 6 4 6-4-6-4 6-4zm12 0l-6 4 6 4-6 4 6 4 6-4-6-4 6-4zM6 16.5L12 20.5l6-4-6-4z" />
  </svg>
);

const InstagramIcon = ({ className }: IconProps) => (
  <svg viewBox="0 0 24 24" className={className} fill="currentColor">
    <path d="M12 2.16c3.2 0 3.58.01 4.85.07 3.25.15 4.77 1.69 4.92 4.92.06 1.27.07 1.65.07 4.85s-.01 3.58-.07 4.85c-.15 3.23-1.66 4.77-4.92 4.92-1.27.06-1.64.07-4.85.07s-3.58-.01-4.85-.07c-3.26-.15-4.77-1.7-4.92-4.92C2.17 15.58 2.16 15.2 2.16 12s.01-3.58.07-4.85C2.38 3.92 3.9 2.38 7.15 2.23 8.42 2.17 8.8 2.16 12 2.16zM12 0C8.74 0 8.33.01 7.05.07 2.7.27.27 2.69.07 7.05.01 8.33 0 8.74 0 12s.01 3.67.07 4.95c.2 4.36 2.62 6.78 6.98 6.98C8.33 23.99 8.74 24 12 24s3.67-.01 4.95-.07c4.35-.2 6.78-2.62 6.98-6.98.06-1.28.07-1.69.07-4.95s-.01-3.67-.07-4.95C23.73 2.7 21.31.27 16.95.07 15.67.01 15.26 0 12 0zm0 5.84A6.16 6.16 0 1 0 18.16 12 6.16 6.16 0 0 0 12 5.84zM12 16a4 4 0 1 1 4-4 4 4 0 0 1-4 4zm6.41-11.85a1.44 1.44 0 1 0 1.44 1.44 1.44 1.44 0 0 0-1.44-1.44z" />
  </svg>
);

const TikTokIcon = ({ className }: IconProps) => (
  <svg viewBox="0 0 24 24" className={className} fill="currentColor">
    <path d="M16.7 2c.3 2.7 1.8 4.4 4.3 4.6v3.4c-1.5.1-2.9-.3-4.2-1.1v6.8a6.3 6.3 0 1 1-5.4-6.2v3.5a2.9 2.9 0 1 0 1.9 2.7V2h3.4z" />
  </svg>
);

export type SourceBrandId = 'youtube' | 'kick' | 'twitch' | 'gdrive' | 'dropbox' | 'mp4' | 'instagram' | 'tiktok';

export const SOURCE_BRANDS: { id: SourceBrandId; label: string; color: string; Icon: ComponentType<IconProps> }[] = [
  { id: 'youtube', label: 'YouTube', color: '#FF0000', Icon: YouTubeIcon },
  { id: 'kick',    label: 'Kick',    color: '#53FC18', Icon: KickIcon },
  { id: 'twitch',  label: 'Twitch',  color: '#9146FF', Icon: TwitchIcon },
  { id: 'gdrive',  label: 'Drive',   color: '#4285F4', Icon: GDriveIcon },
  { id: 'dropbox', label: 'Dropbox', color: '#0061FF', Icon: DropboxIcon },
  { id: 'mp4',     label: '.mp4',    color: '#D1FE17', Icon: Film },
  { id: 'instagram', label: 'Instagram', color: '#E4405F', Icon: InstagramIcon },
  { id: 'tiktok', label: 'TikTok', color: '#69C9D0', Icon: TikTokIcon },
];

/** A compact "works with these platforms" chip row for under link inputs. */
export function SourceBrandRow({ ids, note }: { ids: SourceBrandId[]; note?: string }) {
  return (
    <div className="flex items-center gap-1.5 flex-wrap">
      {note && <span className="text-[10px] font-bold text-white/30 mr-0.5">{note}</span>}
      {ids.map(id => {
        const b = SOURCE_BRANDS.find(x => x.id === id);
        if (!b) return null;
        return (
          <span
            key={id}
            className="flex items-center gap-1.5 px-2 py-1 rounded-lg bg-white/[0.04] border border-white/[0.08] text-[10px] font-bold text-white/60"
          >
            <span style={{ color: b.color }} className="flex items-center"><b.Icon className="w-3.5 h-3.5" /></span>
            {b.label}
          </span>
        );
      })}
    </div>
  );
}
