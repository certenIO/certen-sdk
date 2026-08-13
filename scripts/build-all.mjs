#!/usr/bin/env node
/**
 * Build every package, in dependency order.
 *
 *   npm run build
 *   node scripts/build-all.mjs
 *
 * Replaces `npm run build --workspaces`. That form also works — it is NOT broken, despite a claim to
 * the contrary made while chasing a corrupt global npm install (see AGENTS.md). What this adds is
 * modest and deliberate: the dependency order is stated here rather than depending on the order of
 * the `workspaces` array, and a package that compiles to nothing fails instead of passing quietly.
 *
 * The order matters and is not alphabetical: `cli` and `mcp` compile against `sdk`'s emitted
 * `.d.ts`, so building them first typechecks against whatever happened to be on disk from last time.
 * That is the failure mode where a breaking SDK change looks fine locally and breaks in CI. The
 * `workspaces` array currently happens to be in the right order; this does not depend on it staying
 * that way.
 *
 * It spawns `tsc` directly rather than delegating to the per-package script, which would put another
 * node process in the chain. That is a simplicity choice, not a workaround: fewer processes, one
 * place that decides the order, and the exit code comes straight back.
 *
 * (An earlier revision of this comment blamed process nesting for builds that died partway through.
 * That was wrong. The real cause was a corrupt global npm install capturing every `npm run` — see
 * AGENTS.md. The nesting was never the problem, and the correlation that suggested it was an
 * accident of which npm copy each probe happened to invoke.)
 *
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
