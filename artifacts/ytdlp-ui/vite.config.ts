import path from 'path';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

import runtimeErrorOverlay from '@replit/vite-plugin-runtime-error-modal';

// PORT and BASE_PATH are only needed for the dev server — they are not set
// during a production build, so we fall back to safe defaults here.
const rawPort = process.env.PORT ?? '5000';
const port = Number(rawPort);
const basePath = process.env.BASE_PATH ?? '/';

export default defineConfig({
  base: basePath,
  plugins: [
    react(),
    tailwindcss(),
    ...(process.env.NODE_ENV !== 'production' &&
    process.env.REPL_ID !== undefined
      ? [
          runtimeErrorOverlay(),
          await import('@replit/vite-plugin-cartographer').then((m) =>
            m.cartographer({
              root: path.resolve(import.meta.dirname, '..'),
            }),
          ),
          await import('@replit/vite-plugin-dev-banner').then((m) =>
            m.devBanner(),
          ),
        ]
      : []),
  ],
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, 'src'),
      '@assets': path.resolve(
        import.meta.dirname,
        '..',
        '..',
        'attached_assets',
      ),
    },
    dedupe: ['react', 'react-dom'],
  },
  root: path.resolve(import.meta.dirname),
  build: {
    outDir: path.resolve(import.meta.dirname, 'dist/public'),
    emptyOutDir: true,
    chunkSizeWarningLimit: 600,
    rollupOptions: {
      // Each sitemap URL gets its own server-deliverable document. The React
      // entry hydrates the same app after crawlers have received the route's
      // canonical metadata and meaningful HTML.
      input: {
        index: path.resolve(import.meta.dirname, 'index.html'),
        pricing: path.resolve(import.meta.dirname, 'pricing.html'),
        terms: path.resolve(import.meta.dirname, 'terms.html'),
        privacy: path.resolve(import.meta.dirname, 'privacy.html'),
      },
      output: {
        manualChunks: {
          // Split heavy deps into separate cacheable chunks
          'react-vendor': ['react', 'react-dom'],
          'router':        ['wouter'],
          'query':         ['@tanstack/react-query'],
        },
      },
    },
  },
  server: {
    port,
    strictPort: true,
    host: '0.0.0.0',
    allowedHosts: true,
    hmr: { overlay: false },
    fs: {
      strict: true,
    },
    proxy: {
      '/api': {
        target: 'http://localhost:8080',
        changeOrigin: true,
      },
    },
  },
  preview: {
    port,
    host: '0.0.0.0',
    allowedHosts: true,
  },
});
