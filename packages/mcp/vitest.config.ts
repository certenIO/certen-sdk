import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    exclude: ['node_modules', 'dist'],
    environment: 'node',
    // The release workflow runs `npm test` inside each package, where THIS config governs (the root config only governs a run from the root).
    // 5 s, vitest's default, failed `accepts until: "executed"` on a GitHub runner: it waits on two real polls.
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
