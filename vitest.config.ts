import { defineConfig } from 'vitest/config';

/**
 * Root test configuration — the one that actually applies.
 *
 * `scripts/test-all.mjs` runs a SINGLE vitest process from the repository root, and its own comment
 * said "the root config already globs them". There was no root config. So every run through
 * `npm test`, and every direct `vitest run` from here, used vitest's defaults — including the **5
 * second** default timeout — while `packages/cli/vitest.config.ts` raised it to 20s for a suite
 * where every test spawns the CLI as a real subprocess.
 *
 * A per-package config only applies when vitest is invoked with that package as its root. It never
 * was. The flake fix was therefore inert from the day it was written: the CLI suite has been running
 * against 5s against a measured worst case of 4353ms, which is 13% headroom, and it flaked twice in
 * one session — `doctor.test.ts` once and `call-init.test.ts` once, both timing out at exactly
 * 5000ms.
 *
 * This deliberately sets ONLY the timeouts.
 *
 * `include` and `exclude` are left to vitest's defaults on purpose. Declaring them here would change
 * test DISCOVERY, and a root glob that is subtly narrower than the default makes files vanish
 * silently — a suite that quietly stops running part of itself is far worse than a slow one. The
 * default discovery currently finds 36 files across the three packages, and
 * `packages/sdk/test/test-config.test.ts` asserts that both this file exists and that the count has
 * not moved.
 */
export default defineConfig({
  test: {
    /**
     * ~4.5x the slowest measured case.
     *
     * Every test in the CLI package pays a full Node startup (~320ms) plus HTTP round trips, and
     * files run in parallel, so scheduling load moves these numbers by more than the 13% of headroom
     * the default allowed. Generous enough that noise no longer reads as a broken test, tight enough
     * that a genuine hang still fails rather than stalling the run.
     *
     * A flaky suite is worse than a slow one: it teaches people to re-run instead of read.
     */
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
