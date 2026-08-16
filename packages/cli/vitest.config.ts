import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    exclude: ['node_modules', 'dist'],
    environment: 'node',
    /**
     * Every test in this package spawns the CLI as a real subprocess.
     *
     * Vitest's 5s default is sized for in-process unit tests. Measured here, the slowest case runs
     * 4353ms — roughly 13% headroom — because each test pays a full Node startup (~320ms) plus HTTP
     * round trips, and files run in parallel. That margin is thin enough that ordinary load tips a
     * passing test over, which is exactly what `doctor.test.ts` did: it failed in a full run and
     * passed alone.
     *
     * 20s is ~4.5x the measured worst case, so a genuine slowdown still fails rather than hanging
     * the suite, but scheduling noise no longer reads as a broken test. A flaky suite is worse than
     * a slow one: it trains people to re-run instead of read.
     */
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
