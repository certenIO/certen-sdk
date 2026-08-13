#!/usr/bin/env node
/**
 * Build every package, in dependency order.
 *
 *   node scripts/build-all.mjs      # reliable everywhere
 *   npm run build                   # same thing; see the Windows caveat below
 *
 * Replaces `npm run build --workspaces`, which does not work on Windows npm: it stops after the
 * first workspace and exits non-zero, so a repo-root build left `cli` and `mcp` uncompiled while
 * reporting failure with no indication of what failed. Combined with the old per-package script —
 * which deleted `dist/` and then never ran `tsc` because of an `&&` chain — a plain `npm run build`
 * on Windows destroyed all three builds and explained none of it.
 *
 * The order is not alphabetical and matters: `cli` and `mcp` compile against `sdk`'s emitted `.d.ts`,
 * so building them first typechecks against whatever happened to be on disk from last time. That is
 * the failure mode where a breaking SDK change looks fine locally and breaks in CI.
 *
 * WINDOWS CAVEAT, measured rather than assumed: running this THROUGH npm (`npm run build`) on
 * Windows dies partway through the second package and exits 1, leaving `cli` and `mcp` unbuilt, with
 * its console output truncated mid-line and no error reported. Running the same script directly
 * (`node scripts/build-all.mjs`) builds all three and exits 0, every time. Reducing the process
 * nesting did not help, so the fault is in npm's own wrapper rather than anything here.
 *
 * Use the direct invocation on Windows. `npm run build` is kept because it is what CI and every
 * other platform call, and it delegates here — but do not trust its exit code on Windows, and do not
 * read a truncated log as a build that succeeded.
 */
import { spawnSync } from 'node:child_process';
import { rmSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// sdk first: the other two compile against its declarations.
const PACKAGES = ['sdk', 'cli', 'mcp'];

for (const name of PACKAGES) {
  const cwd = join(ROOT, 'packages', name);
  process.stdout.write(`building ${name}…\n`);
  const built = spawnSync(process.execPath, [join(ROOT, 'scripts', 'build-package.mjs')], {
    cwd,
    stdio: 'inherit',
  });
  if (built.status !== 0) {
    console.error(`\n${name} failed to build — stopping, because what follows compiles against it`);
    process.exit(built.status ?? 1);
  }
}

process.stdout.write('all packages built\n');
