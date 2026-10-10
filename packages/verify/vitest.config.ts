import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    exclude: ['node_modules', 'dist'],
    environment: 'node',
    // The release workflow runs `npm test` inside each package, where THIS config governs (the root config only governs a run from the
    // root). The same 20 s the root and the other packages use, so load on a runner is never read as a broken test.
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
