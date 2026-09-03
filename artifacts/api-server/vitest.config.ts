import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Run tests in a Node environment (no browser DOM needed)
    environment: "node",
    // Each test file gets its own isolated module registry so vi.mock() works correctly
    isolate: true,
    // Strips real secrets (ZYLA_API_KEY) from the env so no unit test can ever
    // hit a paid external API — see src/__tests__/setup.ts
    setupFiles: ["src/__tests__/setup.ts"],
    // Inline source maps for readable stack traces
    includeSource: ["src/**/*.ts"],
  },
});
