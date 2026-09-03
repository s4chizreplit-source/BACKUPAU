/**
 * Public site origin — used wherever we build links that get SHARED outside
 * the app (referral links, social share text). Falls back to the production
 * domain so dev/preview environments never leak their temporary URLs into
 * shared links. Self-hosters can override with VITE_SITE_URL.
 */
export const SITE_ORIGIN: string =
  (import.meta.env.VITE_SITE_URL as string | undefined)?.replace(/\/+$/, '') ||
  'https://autocliper.pro';
