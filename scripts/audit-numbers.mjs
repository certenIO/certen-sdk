#!/usr/bin/env node
/**
 * Every number an audit document quotes, derived from the artefacts rather than remembered.
 *
 *   node scripts/audit-numbers.mjs
 *   node scripts/audit-numbers.mjs --json
 *
 * The consolidated friction audit stated 119 operations, 1225 gateway tests and 576 client tests.
 * The real figures at the time were 125, 1253 and 589. Nothing was wrong when it was written — the
 * document simply has no way to notice that the code moved, and a reader has no way to tell a
 * current number from a stale one.
 *
 * That is the same failure the coverage tool had, in prose instead of code: a measurement nobody
 * re-runs drifts, and it drifts in the flattering direction because the flattering version is the
 * one that gets quoted.
 *
 * So every figure here comes from a file on disk or a command that just ran. Paste the output into
 * the audit and name this script beside it; a number without a command that reproduces it is a
 * claim, not a measurement.
 *
 * Test counts are the one thing this cannot derive without running the suites — vitest does not
 * publish a count without executing — so they are OPTIONAL and clearly marked absent rather than
 * guessed. Pass `--tests` to actually run them.
 */
import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyse } from './coverage.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const GATEWAY_ROOT = resolve(REPO_ROOT, '..', 'api-gateway');
const WANT_TESTS = process.argv.includes('--tests');
const AS_JSON = process.argv.includes('--json');

/** Operations in a vendored OpenAPI document. */
function operationCount(specPath) {
  if (!existsSync(specPath)) return null;
  const spec = JSON.parse(readFileSync(specPath, 'utf8'));
  const METHODS = ['get', 'post', 'put', 'patch', 'delete'];
  let n = 0;
  for (const ops of Object.values(spec.paths ?? {})) {
    for (const m of Object.keys(ops)) if (METHODS.includes(m)) n += 1;
  }
  return n;
}

/**
 * Run a suite and read its own summary line.
 *
 * Parsed from vitest's output rather than counted from files: a file count is not a test count, and
 * reporting one as the other is exactly the substitution this script exists to stop.
 */
function testCount(cwd) {
  const vitest = join(REPO_ROOT, 'node_modules', 'vitest', 'vitest.mjs');
  if (!existsSync(vitest)) return null;
  const res = spawnSync(process.execPath, [vitest, 'run'], { cwd, encoding: 'utf8' });
  const out = `${res.stdout ?? ''}${res.stderr ?? ''}`;
  // `Tests  631 passed (631)` — take the total in parentheses, and record whether it was green.
  const m = /Tests\s+.*?\((\d+)\)/.exec(out.replace(/\[[0-9;]*m/g, ''));
  return m ? { total: Number(m[1]), green: res.status === 0 } : null;
}

const coverage = analyse();

const report = {
  measured_at: new Date().toISOString().slice(0, 10),
  operations: coverage.total,
  reachable_from_a_client: coverage.covered,
  unreachable: coverage.unreachable.length,
  gateway_operations_in_its_own_spec: operationCount(join(GATEWAY_ROOT, 'openapi.json')),
  vendored_spec_operations: operationCount(join(REPO_ROOT, 'spec', 'openapi.json')),
  error_codes: existsSync(join(REPO_ROOT, 'spec', 'errors.json'))
    ? JSON.parse(readFileSync(join(REPO_ROOT, 'spec', 'errors.json'), 'utf8')).errors.length
    : null,
  client_tests: null,
  gateway_tests: null,
};

if (WANT_TESTS) {
  report.client_tests = testCount(REPO_ROOT);
  if (existsSync(join(GATEWAY_ROOT, 'package.json'))) {
    report.gateway_tests = testCount(GATEWAY_ROOT);
  }
}

if (AS_JSON) {
  console.log(JSON.stringify(report, null, 2));
} else {
  const row = (k, v) => console.log(`  ${String(k).padEnd(34)} ${v}`);
  console.log(`\naudit numbers · ${report.measured_at}\n`);
  row('operations', report.operations);
  row('reachable from a client', report.reachable_from_a_client);
  row('unreachable (allow-listed)', report.unreachable);
  row('error codes published', report.error_codes ?? 'n/a');
  row('vendored spec operations', report.vendored_spec_operations ?? 'n/a');
  row('gateway spec operations', report.gateway_operations_in_its_own_spec ?? 'n/a');

  if (WANT_TESTS) {
    const fmt = (t) => (t ? `${t.total}${t.green ? '' : '  (NOT GREEN)'}` : 'could not read');
    row('client tests (sdk+cli+mcp)', fmt(report.client_tests));
    row('gateway tests', fmt(report.gateway_tests));
  } else {
    console.log('\n  test counts omitted — pass --tests to run both suites and read their totals.');
  }

  // Two documents derived from the same spec that disagree means one of them was refreshed and the
  // other was not, which is the drift this whole script exists to surface.
  if (
    report.vendored_spec_operations !== null
    && report.gateway_operations_in_its_own_spec !== null
    && report.vendored_spec_operations !== report.gateway_operations_in_its_own_spec
  ) {
    console.log('\n  WARNING: the vendored spec and the gateway\'s own spec disagree.');
    console.log('  Run `npm run spec:refresh` — one of them is stale.');
  }
  console.log('');
}
