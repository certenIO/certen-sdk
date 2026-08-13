#!/usr/bin/env node
/**
 * Clean `dist/` and compile, for whichever package invokes it.
 *
 *   "build": "node ../../scripts/build-package.mjs"
 *
 * It replaces the shell-chained form:
 *
 *   "build": "node -e \"require('fs').rmSync('dist',{recursive:true,force:true})\" && tsc"
 *
 * What this buys is small and real: the clean and the compile are one step that cannot half-run, and
 * a build is failed if it somehow leaves no `dist/` behind. No shell chaining, so it behaves the
 * same wherever it runs.
 *
 * **It is NOT here because `&&` is broken.** That was claimed during a long debugging session in
 * August 2026 and it was wrong: `&&` in an npm script works fine. The scripts appeared to stop after
 * their first command because a corrupt global npm install was returning early from every `npm run`
 * on that machine — see AGENTS.md for the signature and the fix. Once npm was repaired, the original
 * `&&` form worked. Keep this script for the reasons above, not out of fear of a shell operator.
 */
import { rmSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve, join } from 'node:path';

const pkg = process.cwd();
const dist = join(pkg, 'dist');

rmSync(dist, { recursive: true, force: true });

// Resolve tsc from the workspace root's node_modules — packages here do not each carry a copy.
const root = resolve(pkg, '..', '..');
const tsc = join(root, 'node_modules', 'typescript', 'bin', 'tsc');
if (!existsSync(tsc)) {
  console.error(`cannot find tsc at ${tsc} — run npm install at the repo root`);
  process.exit(1);
}

const built = spawnSync(process.execPath, [tsc], { cwd: pkg, stdio: 'inherit' });
if (built.status !== 0) process.exit(built.status ?? 1);

// A build that reports success while leaving nothing behind is the failure this script was written
// to end, so it is checked rather than assumed.
if (!existsSync(dist)) {
  console.error('build reported success but produced no dist/ — refusing to pass');
  process.exit(1);
}
