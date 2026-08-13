#!/usr/bin/env node
/**
 * Run every test in the monorepo, in one vitest process.
 *
 *   npm test
 *   node scripts/test-all.mjs
 *
 * Replaces `npm run test --workspaces`, which was wrong in two ways at once. It stops at the first
 * workspace that reports a failure — and on Windows every npm script "fails" regardless of outcome
 * (see AGENTS.md), so the root command silently ran the SDK suite and skipped CLI and MCP entirely
 * while reporting a failure that named nothing. A test command that quietly tests a third of the
 * repo is worse than one that does not run.
 *
 * One vitest process covers all three packages — the root config already globs them — and it is
 * both simpler and faster than three sequential runs.
 *
 * vitest is spawned directly rather than through npm, so the exit code is real. That matters more
 * here than anywhere else: this is the signal CI gates on.
 */
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const vitest = join(ROOT, 'node_modules', 'vitest', 'vitest.mjs');

if (!existsSync(vitest)) {
  console.error(`cannot find vitest at ${vitest} — run npm install at the repo root`);
  process.exit(1);
}

// Anything after `--` on the command line is handed through, so `npm test -- --reporter=verbose`
// and a single-file run both still work.
const passthrough = process.argv.slice(2);

const res = spawnSync(process.execPath, [vitest, 'run', ...passthrough], {
  cwd: ROOT,
  stdio: 'inherit',
});
process.exit(res.status ?? 1);
