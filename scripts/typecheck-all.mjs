#!/usr/bin/env node
/**
 * Typecheck every package.
 *
 *   npm run typecheck
 *   node scripts/typecheck-all.mjs
 *
 * Replaces `npm run typecheck --workspaces --if-present`, which stops at the first workspace that
 * reports failure — and on Windows every npm script reports failure regardless of outcome, so the
 * root command checked one package and skipped the rest. See AGENTS.md.
 *
 * Unlike the build, this does NOT stop at the first failure: type errors in `sdk` and in `cli` are
 * independent facts, and finding out about them one release at a time is how a "quick typecheck"
 * turns into four rounds. Every package is checked, and the run fails if any did.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGES = ['sdk', 'cli', 'mcp'];

const tsc = join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
if (!existsSync(tsc)) {
  console.error(`cannot find tsc at ${tsc} — run npm install at the repo root`);
  process.exit(1);
}

const failed = [];
for (const name of PACKAGES) {
  process.stdout.write(`typechecking ${name}\n`);
  const res = spawnSync(process.execPath, [tsc, '--noEmit', '-p', join(ROOT, 'packages', name)], {
    cwd: ROOT,
    stdio: 'inherit',
  });
  if (res.status !== 0) failed.push(name);
}

if (failed.length > 0) {
  console.error(`\ntype errors in: ${failed.join(', ')}`);
  process.exit(1);
}
process.stdout.write('all packages typecheck\n');
