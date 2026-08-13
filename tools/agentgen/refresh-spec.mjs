#!/usr/bin/env node
/**
 * Fetch the gateway's OpenAPI document into `spec/openapi.json`.
 *
 * This is the ONLY step that touches the network. Everything else — the contract fixture, llms.txt,
 * llms-full.txt — is derived from the vendored copy, so tests and CI stay offline and deterministic.
 *
 *   npm run spec:refresh                                    # from the production gateway
 *   CERTEN_API_URL=https://staging npm run spec:refresh
 *   CERTEN_SPEC_FILE=../api-gateway/openapi.json npm run spec:refresh
 *
 * `CERTEN_SPEC_FILE` reads a document produced by the gateway's own
 * `node scripts/dump-openapi.mjs`, which builds the spec from the route definitions without a
 * server. That is the right source when the change being released has not been deployed yet:
 * fetching the live URL in that window silently re-vendors the OLD document, so the SDK ships types
 * describing an API its own release is changing. Deploy-then-refresh works too — this just removes
 * the ordering constraint.
 *
 * Then `npm run agentgen` to rebuild what depends on it, and commit both together. Reviewing the
 * spec diff alongside the regenerated docs is the point: an API change should be visible.
 */
import { writeFileSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { REPO_ROOT } from './lib/paths.mjs';

const out = join(REPO_ROOT, 'spec', 'openapi.json');
const file = process.env.CERTEN_SPEC_FILE;

let spec;
let source;
if (file) {
  source = resolve(file);
  spec = JSON.parse(readFileSync(source, 'utf8'));
} else {
  const base = process.env.CERTEN_API_URL ?? 'https://gateway.kompendium.co';
  source = `${base}/docs/json`;
  const res = await fetch(source);
  if (!res.ok) throw new Error(`GET ${source} -> ${res.status}`);
  spec = await res.json();
}

// A document with no paths would wipe everything derived from it, and the failure would show up
// later as "the SDK calls an endpoint that is not in the spec" rather than here.
if (!spec?.paths || Object.keys(spec.paths).length === 0) {
  throw new Error(`refusing to vendor a spec with no paths from ${source}`);
}

const opCount = Object.values(spec.paths ?? {}).reduce(
  (n, methods) =>
    n + Object.keys(methods).filter((m) => ['get', 'post', 'patch', 'put', 'delete'].includes(m)).length,
  0,
);

// Pretty-printed so the diff of an API change is reviewable rather than one enormous line.
writeFileSync(out, `${JSON.stringify(spec, null, 2)}\n`, 'utf8');
console.log(`wrote spec/openapi.json from ${source} — ${Object.keys(spec.paths ?? {}).length} paths, ${opCount} operations`);
console.log('next: npm run agentgen');
