#!/usr/bin/env node
/**
 * Clean `dist/` and compile, for whichever package invokes it.
 *
 *   "build": "node ../../scripts/build-package.mjs"
 *
 * This exists because the obvious form does not work:
 *
 *   "build": "node -e \"require('fs').rmSync('dist',{recursive:true,force:true})\" && tsc"
 *
 * On Windows npm the `&&` never runs the second command. The script therefore DELETED dist/ and
 * exited 1 without compiling anything — so `npm run build` did not merely fail, it destroyed the
 * build output and left the package unimportable. Every later `vitest run` then executed against a
 * missing or half-written dist and reported dozens of failures that had nothing to do with the code,
 * which is a very expensive way to learn that a build script is broken.
 *
 * The same trap has now cost this repo three times: the prepublish gate (fixed by routing through
 * node), the gateway's `spec:dump`, and this. The rule is simple — never chain commands with `&&`
 * inside an npm script in this repo. Spawn them from node, where the exit code and the sequencing
 * are both real, on every platform.
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
