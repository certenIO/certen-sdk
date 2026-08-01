/**
 * Map SDK methods to the gateway operations they call, by reading the SDK source.
 *
 * This is derived rather than hand-maintained on purpose. A hand-written map is a third copy of
 * the truth, and the whole point of this generator is that there are only two: the vendored spec
 * and the code. If a method moves to a different endpoint, the map moves with it.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { SDK_ROOT } from './paths.mjs';
import { opId } from './spec.mjs';

const RESOURCE_DIR = join(SDK_ROOT, 'src', 'resources');

/** `/v1/transaction/${intentId}` -> `/v1/transaction/{id}`, matching how the spec names params. */
function normalizePath(raw, specPaths) {
  const templated = raw.replace(/\$\{[^}]+\}/g, '{}');
  if (!templated.includes('{}')) return templated;
  // The spec's param names (`{id}`, `{txHash}`, `{token}`) rarely match the local variable name,
  // so match structurally: same segment count, literals equal, placeholders wild.
  const want = templated.split('/');
  for (const candidate of specPaths) {
    const got = candidate.split('/');
    if (got.length !== want.length) continue;
    const ok = want.every((seg, i) => (seg === '{}' ? /^\{.+\}$/.test(got[i]) : seg === got[i]));
    if (ok) return candidate;
  }
  return templated;
}

/**
 * Two calls in execute.ts post to a URL the gateway handed back (`submit_url`), with a literal
 * fallback in the same expression. A source regex cannot see through the variable, so they are
 * declared here. Both fallbacks are visible in resources/execute.ts a line or two above the call.
 */
const DYNAMIC_CALLS = [
  { file: 'execute.ts', in: 'cosign', method: 'POST', path: '/v1/sign/{id}/signature', via: 'submit_url' },
  { file: 'execute.ts', in: 'open', method: 'POST', path: '/v1/transaction/{id}/signature', via: 'submit_url' },
];

/**
 * Public methods of a resource class, with the endpoints reachable from each.
 *
 * Method bodies are sliced between `async name(` markers. That is crude, but these files are flat
 * classes with no nested async functions, and the alternative is a TypeScript parse for a mapping
 * that a test verifies anyway.
 */
function methodsIn(source) {
  const marks = [...source.matchAll(/^ {2}(?:private\s+)?async\s+([A-Za-z_$][\w$]*)\s*\(/gm)].map((m) => ({
    name: m[1],
    start: m.index,
    private: m[0].includes('private'),
  }));
  return marks.map((mark, i) => ({
    name: mark.name,
    private: mark.private,
    doc: docBefore(source, mark.start),
    body: source.slice(mark.start, i + 1 < marks.length ? marks[i + 1].start : source.length),
  }));
}

/**
 * First sentence of the JSDoc immediately above a method.
 *
 * The endpoint summary from the spec describes the ROUTE, which is the wrong altitude for the
 * composite helpers: `execute.contractCall` and `execute.transfer` both POST /v1/transaction, so
 * the spec summary makes them read as the same method. The SDK's own doc comment is what actually
 * distinguishes them.
 */
function docBefore(source, start) {
  // Scan backwards for the NEAREST block, not the first — a lazy regex anchored at the end matches
  // the file's opening class-level comment and gives every method the same summary.
  const before = source.slice(0, start).trimEnd();
  if (!before.endsWith('*/')) return '';
  const open = before.lastIndexOf('/**');
  if (open === -1) return '';
  const text = before
    .slice(open + 3, before.length - 2)
    .split('\n')
    .map((line) => line.replace(/^\s*\*\s?/, '').trim())
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  // Stop at the first tag — @param prose is not a summary.
  const untagged = text.split(/\s@\w+/)[0].trim();
  const sentence = untagged.match(/^(.*?[.!?])(\s|$)/);
  return (sentence ? sentence[1] : untagged).trim();
}

const CALL_RE = /this\.http\.(get|post|patch|put|delete)\s*[<(][^)]*?['"`]([^'"`]+)['"`]/g;

export function sdkMap(spec) {
  const specPaths = Object.keys(spec.paths ?? {});
  const resources = [];

  for (const file of readdirSync(RESOURCE_DIR).filter((f) => f.endsWith('.ts')).sort()) {
    const source = readFileSync(join(RESOURCE_DIR, file), 'utf8');
    const resource = file.replace(/\.ts$/, '');
    const methods = [];

    for (const m of methodsIn(source)) {
      if (m.private) continue;
      const calls = [];
      for (const c of m.body.matchAll(CALL_RE)) {
        const path = normalizePath(c[2], specPaths);
        if (!path.startsWith('/')) continue; // a variable, not a literal path
        calls.push({ method: c[1].toUpperCase(), path, id: opId(c[1], path) });
      }
      // Fold in whatever the private helpers this method delegates to actually call. `open()` is
      // shared by contractCall/transfer and holds their real endpoints.
      for (const helper of methodsIn(source).filter((h) => h.private)) {
        if (!new RegExp(`this\\.${helper.name}\\s*\\(`).test(m.body)) continue;
        for (const c of helper.body.matchAll(CALL_RE)) {
          const path = normalizePath(c[2], specPaths);
          if (!path.startsWith('/')) continue;
          calls.push({ method: c[1].toUpperCase(), path, id: opId(c[1], path) });
        }
        for (const d of DYNAMIC_CALLS.filter((d) => d.file === file && d.in === helper.name)) {
          if (helper.body.includes(d.via)) {
            calls.push({ method: d.method, path: d.path, id: opId(d.method, d.path), inferred: d.via });
          }
        }
      }
      for (const d of DYNAMIC_CALLS.filter((d) => d.file === file && d.in === m.name)) {
        if (m.body.includes(d.via)) {
          calls.push({ method: d.method, path: d.path, id: opId(d.method, d.path), inferred: d.via });
        }
      }

      if (calls.length === 0) continue;
      const seen = new Set();
      methods.push({
        name: m.name,
        doc: m.doc,
        calls: calls.filter((c) => !seen.has(c.id) && seen.add(c.id)),
      });
    }

    if (methods.length > 0) resources.push({ resource, methods });
  }

  return resources;
}

/** Every spec operation id the SDK can reach. */
export function coveredIds(map) {
  const ids = new Set();
  for (const r of map) for (const m of r.methods) for (const c of m.calls) ids.add(c.id);
  return ids;
}
