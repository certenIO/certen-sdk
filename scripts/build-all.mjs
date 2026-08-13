#!/usr/bin/env node
/**
 * Build every package, in dependency order.
 *
 *   npm run build
 *   node scripts/build-all.mjs
 *
 * Replaces `npm run build --workspaces`, which does not work on Windows npm: it stops after the
 * first workspace and exits non-zero, so a repo-root build left `cli` and `mcp` uncompiled while
 * reporting a failure that named nothing.
 *
 * The order is not alphabetical and matters: `cli` and `mcp` compile against `sdk`'s emitted
 * `.d.ts`, so building them first typechecks against whatever happened to be on disk from last
 * time. That is the failure mode where a breaking SDK change looks fine locally and breaks in CI.
 *
 * **It spawns `tsc` directly — one level of nesting, never two.** An earlier version of this file
 * called the per-package script, which then spawned `tsc`: npm -> node -> node -> tsc. Under Windows
 * npm that died partway through, non-deterministically, leaving one or more packages unbuilt with
 * its log truncated mid-line and no error reported — sometimes after the first package, sometimes
 * before any. Reproduced repeatedly at three levels and never once at two. So the rule is the
 * nesting depth, not npm as such: keep this loop spawning the compiler itself.
 *
 * For the same reason, do not reintroduce `"build": "… && …"` in any package.json here. The `&&`
 * never runs its second command under Windows npm — the per-package scripts used to be
 * `node -e "rmSync('dist')" && tsc`, so `npm run build` deleted `dist/` and compiled nothing,
 * leaving the package unimportable and every later test run failing against a missing build.
 */
import { spawnSync } from 'node:child_process';
import { rmSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// sdk first: the other two compile against its declarations.
const PACKAGES = ['sdk', 'cli', 'mcp'];

const tsc = join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
if (!existsSync(tsc)) {
  console.error(`cannot find tsc at ${tsc} — run npm install at the repo root`);
  process.exit(1);
}

for (const name of PACKAGES) {
  const cwd = join(ROOT, 'packages', name);
  const dist = join(cwd, 'dist');
  process.stdout.write(`building ${name}\n`);

  // Clean here rather than in a child process: a stale `dist` is how a deleted or renamed export
  // keeps resolving locally long after it stopped existing.
  rmSync(dist, { recursive: true, force: true });

  const built = spawnSync(process.execPath, [tsc], { cwd, stdio: 'inherit' });
  if (built.status !== 0) {
    console.error(`\n${name} failed to build — stopping, because what follows compiles against it`);
    process.exit(built.status ?? 1);
  }
  // A build that reports success while leaving nothing behind is the exact failure the old `&&`
  // script produced, so it is checked rather than trusted.
  if (!existsSync(dist)) {
    console.error(`\n${name} reported success but produced no dist/ — refusing to pass`);
    process.exit(1);
  }
}

process.stdout.write('all packages built\n');
