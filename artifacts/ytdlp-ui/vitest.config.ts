import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'happy-dom',
    globals: true,
    setupFiles: ['./src/__tests__/setup.ts'],
    // Each test file gets an isolated module registry so vi.mock() works correctly
    isolate: true,
    // Inline source maps for readable stack traces
    includeSource: ['src/**/*.tsx', 'src/**/*.ts'],
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
});
