#!/usr/bin/env node
/**
 * Which gateway operations are reachable from a client — measured from CALL SITES, not substrings.
 *
 * The first version of this matched any occurrence of a path anywhere in client source, so a path
 * mentioned in a code COMMENT counted as implemented. That is how `POST /v1/oauth/token` was
 * reported as covered while the SDK had no OAuth surface at all: the string appeared in a comment
 * about idempotency. Every number it produced overstated coverage, and a whole phase was planned
 * from those numbers.
 *
 * Its replacement then had a blind spot of its own. Requiring `.post(` missed `oauth.ts`, which
 * routes every request through a local `post()` helper — so the fix for a substring bug shipped
 * with an indirection bug. Both failure modes point the same way: **a coverage tool errs toward
 * good news, and nobody double-checks a number that says the work is done.**
 *
 * So this one extracts paths only from positions where a request is issued, strips comments first,
 * and follows one level of helper indirection:
 *
 *   - `this.http.get('/v1/x')` and template forms `` `/v1/x/${id}` ``
 *   - `post('/v1/x', body)` — a bare call, for resources that wrap axios in a local helper
 *   - `axios.post(`${base}/v1/x`, …)` for the standalone functions
 *   - MCP `endpoint:` / `alsoReaches:` declarations, which name `METHOD /path` outright
 *
 * Run it:
 *
 *   node scripts/coverage.mjs            # summary + what is unreachable
 *   node scripts/coverage.mjs --json     # machine-readable
 *
 * `packages/sdk/test/coverage.test.ts` runs the same analysis against an explicit allow-list of the
 * operations that are unreachable ON PURPOSE, each with a reason. A newly unreachable operation
 * fails that test; adding one to the list is a deliberate act with a written justification.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The client packages a customer can actually call the API through. */
export const CLIENT_ROOTS = [
  join(REPO_ROOT, 'packages', 'sdk', 'src'),
  join(REPO_ROOT, 'packages', 'cli', 'src'),
  join(REPO_ROOT, 'packages', 'mcp', 'src'),
];

export const SPEC_PATH = join(REPO_ROOT, 'spec', 'openapi.json');

const SKIP_DIRS = ['node_modules', 'dist', '.git', 'test', 'fixtures'];

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.includes(entry)) continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.(ts|mjs|js)$/.test(entry) && !/\.d\.ts$/.test(entry)) out.push(p);
  }
  return out;
}

/** Remove line and block comments, so prose can never register as a call site again. */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const METHODS = 'get|post|put|patch|delete';
// The leading dot is OPTIONAL, which is the fix for the indirection blind spot described above.
const HTTP_CALL = new RegExp(`\\b\\.?(${METHODS})\\s*(?:<[^>]*>)?\\s*\\(\\s*([\`'"])([^\`'"]*?)\\2`, 'g');
// MCP tool declarations: `endpoint: 'GET /v1/x'` and the entries inside `alsoReaches: [...]`.
const DECLARED = /['"`](GET|POST|PUT|PATCH|DELETE)\s+(\/v1\/[^'"`]*)['"`]/g;

/** `${encodeURIComponent(id)}` and `{id}` both become `{}`, so shapes compare. */
function normalise(path) {
  return path
    .replace(/\$\{[^}]*\}/g, '{}')
    .replace(/\{[^}]*\}/g, '{}')
    .replace(/\/+$/, '');
}

/** Every `METHOD /path` the client packages actually issue a request to. */
export function reachableOperations(roots = CLIENT_ROOTS) {
  const reached = new Set();
  for (const root of roots) {
    for (const file of walk(root)) {
      const src = stripComments(readFileSync(file, 'utf8'));

      for (const m of src.matchAll(HTTP_CALL)) {
        // `${base}/v1/x` -> `/v1/x`; drop a leading interpolation.
        const path = m[3].replace(/^\$\{[^}]*\}/, '');
        if (!path.startsWith('/v1/') && !path.startsWith('/internal/')) continue;
        reached.add(`${m[1].toUpperCase()} ${normalise(path)}`);
      }

      for (const m of src.matchAll(DECLARED)) {
        reached.add(`${m[1]} ${normalise(m[2])}`);
      }
    }
  }
  return reached;
}

/** Every `METHOD /path` in the vendored spec, in declaration order. */
export function specOperations(specPath = SPEC_PATH) {
  const spec = JSON.parse(readFileSync(specPath, 'utf8'));
  const ops = [];
  for (const [path, methods] of Object.entries(spec.paths)) {
    for (const method of Object.keys(methods)) {
      if (!['get', 'post', 'put', 'patch', 'delete'].includes(method)) continue;
      ops.push({ key: `${method.toUpperCase()} ${normalise(path)}`, method, path });
    }
  }
  return ops;
}

export function analyse({ specPath = SPEC_PATH, roots = CLIENT_ROOTS } = {}) {
  const reached = reachableOperations(roots);
  const all = specOperations(specPath);
  const unreachable = all.filter((op) => !reached.has(op.key));
  return {
    total: all.length,
    covered: all.length - unreachable.length,
    // The `{}`-normalised key is what an allow-list entry must match, so it is what is returned.
    unreachable: unreachable.map((op) => op.key).sort(),
  };
}

// ── CLI ────────────────────────────────────────────────────────────────────────────────────────

const invokedDirectly = process.argv[1]
  && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  const report = analyse();

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`\nreachable from a client: ${report.covered}/${report.total}`
      + `  (unreachable: ${report.unreachable.length})\n`);
    const groups = new Map();
    for (const key of report.unreachable) {
      const area = key.split(' ')[1].split('/').filter(Boolean).slice(0, 2).join('/');
      groups.set(area, [...(groups.get(area) ?? []), key]);
    }
    for (const [area, keys] of [...groups].sort((a, b) => b[1].length - a[1].length)) {
      console.log(`${area}  ${keys.length} unreachable`);
      for (const k of keys) console.log(`    ${k}`);
    }
    console.log('');
  }
}
