#!/usr/bin/env node
/**
 * The gate that runs before a package is published: typecheck-and-build, then tests.
 *
 * It exists as a script rather than as `npm run build && npm test` in
 * `prepublishOnly`, and that is not a style preference — the npm form blocks good
 * publishes on Windows.
 *
 * What was observed, on npm 10.9.2 / Node 22.14 / Windows, in this repo:
 *
 *   node node_modules/vitest/vitest.mjs run   →  6/6 exit 0, 119/119 tests passing
 *   npm test                                  →  1/6 exit 0, 119/119 tests passing
 *   npm test, with 4 CPU hogs running         →  0/6 exit 0, 119/119 tests passing
 *
 * Every run passed every test and printed a clean summary; npm then exited 1 with
 * no error output at all. The same npm is fine in a scratch package and in a
 * scratch workspaces monorepo (6/6), and adding `--loglevel=silly` makes it stop
 * reproducing — a load-sensitive race in npm's script runner, not a fault in the
 * tests, the tools, or this repo's code. It is Windows-only: CI runs on
 * ubuntu-latest and is unaffected.
 *
 * The failure mode mattered because it was a FALSE NEGATIVE: `npm publish` aborted
 * with a 105-byte log ending mid-build, so a release was blocked by a gate that had
 * not actually failed. Diagnosing that from the output alone was impossible.
 *
 * So this spawns each tool's own JS entrypoint and propagates its real exit code.
 * The gate is not weakened — it runs the same two checks, and now reports which one
 * failed rather than exiting silently.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkgDir = process.cwd();

/** Tool entrypoints, resolved from the monorepo root where the install lives. */
const TSC = join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc');
const VITEST = join(repoRoot, 'node_modules', 'vitest', 'vitest.mjs');

function must(path, what) {
  if (!existsSync(path)) {
    console.error(`prepublish: cannot find ${what} at ${path} — run \`npm ci\` at the repo root.`);
    process.exit(1);
  }
}
must(TSC, 'typescript');
must(VITEST, 'vitest');

/**
 * Run one gate. `node <entry>` directly: no npm, no .cmd shim, no nested shell —
 * those are the layers that lose the exit code.
 */
function gate(name, entry, args) {
  console.log(`prepublish: ${name}`);
  const r = spawnSync(process.execPath, [entry, ...args], { cwd: pkgDir, stdio: 'inherit' });

  if (r.error) {
    console.error(`prepublish: ${name} could not start — ${r.error.message}`);
    process.exit(1);
  }
  // A tool killed by a signal has not passed, and `status` is null in that case,
  // so it must be handled rather than treated as success.
  if (r.signal) {
    console.error(`prepublish: ${name} was terminated by ${r.signal}`);
    process.exit(1);
  }
  if (r.status !== 0) {
    console.error(`prepublish: ${name} FAILED (exit ${r.status}) — nothing was published.`);
    process.exit(r.status ?? 1);
  }
}

gate('build (tsc)', TSC, []);
gate('tests (vitest run)', VITEST, ['run']);

/**
 * Everything above is offline, and that is the gap this closes.
 *
 * The vendored spec is generated from the gateway's SOURCE, so the whole suite can pass against a
 * document describing a gateway that has not been deployed. The 2026-08 release moves paths — a
 * client calling `/v1/webhooks/*` against a gateway still serving `/v1/admin/webhooks/*` 404s on
 * every call, and looks to the user like the feature was never built.
 *
 * Exit 2 means the gateway could not be reached, which says nothing about whether it is current —
 * so it warns rather than blocking. Only exit 1, a deployment provably behind this build, stops a
 * publish. Set CERTEN_SKIP_GATEWAY_CHECK=1 to publish anyway; it is deliberately an explicit act.
 */
if (process.env.CERTEN_SKIP_GATEWAY_CHECK === '1') {
  console.log('prepublish: gateway check SKIPPED by CERTEN_SKIP_GATEWAY_CHECK=1');
} else {
  const check = join(repoRoot, 'scripts', 'check-gateway-serves.mjs');
  console.log('prepublish: deployed gateway serves this build');
  const r = spawnSync(process.execPath, [check], { cwd: repoRoot, stdio: 'inherit' });
  if (r.status === 1) {
    console.error('prepublish: the live gateway cannot serve this build — nothing was published.');
    process.exit(1);
  }
  if (r.status !== 0) {
    console.warn('prepublish: could not verify the deployed gateway; continuing.');
  }
}

console.log('prepublish: build and tests passed');
