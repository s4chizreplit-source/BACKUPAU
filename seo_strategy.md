# SEO Strategy — AutoCliper (autocliper.com)

## Product
AutoCliper turns long YouTube/Kick/Twitch/Drive/Dropbox videos into short viral clips using AI. Live at autocliper.com.

## Rendering Architecture
Pure React SPA (Vite + Wouter). All routes are client-rendered. The Express backend serves the Vite build via a wildcard SPA fallback. **Googlebot, social preview bots, and AI crawlers see only the static `artifacts/ytdlp-ui/index.html` shell for every URL.**

## In Scope
- `/` — main clipper / landing page (ClipperPage.tsx) — primary public-facing page
- `/pricing` — pricing page (Pricing.tsx)
- `/terms`, `/privacy` — legal pages
- `/login`, `/signup`, `/reset-password` — auth pages (low SEO value, but should not be noindexed unintentionally)

## Out of Scope
- `/account` — authenticated user dashboard
- `/admin` — admin panel (should be disallowed in robots.txt)

## Target Audience
Video creators, social media managers, and content studios wanting quick AI-powered clip generation from long-form videos.

## Primary Keywords
- AI video clip generator
- YouTube video to short clips
- viral clip maker
- auto clip generator

## Dismissed Categories
- (None yet)
