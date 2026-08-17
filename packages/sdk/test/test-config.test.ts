import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/**
 * The test configuration has to apply to the process that actually runs the tests.
 *
 * `packages/cli/vitest.config.ts` raised the timeout to 20s for a suite where every test spawns the
 * CLI as a subprocess. It was never in effect: `scripts/test-all.mjs` runs ONE vitest process from
 * the repository root, and a per-package config only applies when that package is vitest's root.
 * The script's own comment claimed "the root config already globs them" while no root config
 * existed, so every run used the 5s default against a measured worst case of 4353ms.
 *
 * The fix was inert for a whole phase and nothing noticed, because a config that does not apply
 * fails the same way as one that does — until load tips a test over. That is the argument for
 * asserting on it here rather than trusting the file to exist.
 */
describe('the configuration that governs this run', () => {
  it('has a root config, because the root is where vitest is invoked', () => {
    const rootConfig = join(REPO_ROOT, 'vitest.config.ts');
    expect(existsSync(rootConfig), 'vitest.config.ts missing at the repo root').toBe(true);

    const src = readFileSync(rootConfig, 'utf8');
    // The number matters, not merely the key: a root config that set 5s would satisfy a
    // presence-only check while changing nothing.
    const match = /testTimeout:\s*([\d_]+)/.exec(src);
    expect(match, 'root config declares no testTimeout').not.toBeNull();
    expect(Number(match![1].replace(/_/g, ''))).toBeGreaterThanOrEqual(15_000);
  });

  it('leaves discovery to vitest, so no test file can vanish silently', () => {
    // Declaring `include` at the root is the one change here with a downside worse than the problem:
    // a glob subtly narrower than the default drops files with no failure anywhere. A suite that
    // quietly stops running part of itself is worse than a slow one.
    const src = readFileSync(join(REPO_ROOT, 'vitest.config.ts'), 'utf8');
    expect(src).not.toMatch(/^\s*include:/m);
    expect(src).not.toMatch(/^\s*exclude:/m);
  });

  it('still finds every test file across all three packages', () => {
    // The count is the actual protection. If a future config narrows discovery, this fails with a
    // number rather than by a suite silently shrinking.
    const found: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        if (entry === 'node_modules' || entry === 'dist') continue;
        const p = join(dir, entry);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.test\.ts$/.test(entry)) found.push(p);
      }
    };
    walk(join(REPO_ROOT, 'packages'));

    // Grows as tests are added; this asserts the floor, so a collapse is caught while an addition
    // does not need a matching edit here.
    expect(found.length).toBeGreaterThanOrEqual(36);
    // All three packages must be represented — the original bug was a run that covered one.
    for (const pkg of ['sdk', 'cli', 'mcp']) {
      expect(
        found.some((f) => f.includes(join('packages', pkg))),
        `no test files discovered for packages/${pkg}`,
      ).toBe(true);
    }
  });
});
