#!/usr/bin/env node
/**
 * Does the DEPLOYED gateway serve the operations this build calls?
 *
 * The 2026-08 release moves paths: `/v1/admin/webhooks/*` becomes `/v1/webhooks/*`, and
 * `/v1/admin/oauth-clients` becomes `/v1/oauth-clients`. Publishing a client that calls the new
 * paths against a gateway still serving the old ones is not a subtle incompatibility — every
 * webhook and OAuth-client call 404s, and it looks to the user like the feature does not exist.
 *
 * Nothing prevented that. The vendored `spec/openapi.json` is generated from the gateway's SOURCE
 * (`npm run spec:refresh` with `CERTEN_SPEC_FILE=`), which is the right choice — it lets the SDK be
 * built before the gateway deploys — but it means the vendored spec describes a gateway that may
 * not exist yet, and every offline test passes against it happily.
 *
 * This is the one check that has to touch the network, so it is deliberately NOT part of the
 * offline test suite. Run it before publishing:
 *
 *   node scripts/check-gateway-serves.mjs                     # against production
 *   CERTEN_API_URL=https://staging node scripts/check-gateway-serves.mjs
 *
 * It compares the LIVE document against the vendored one and reports operations the vendored spec
 * has that the deployment does not. Extra operations on the deployment are fine — a gateway ahead
 * of the SDK breaks nothing.
 *
 * Exits 0 when the deployment can serve this build, 1 when it cannot, and 2 when the answer could
 * not be determined. Two rather than one, because "the gateway did not respond" is a different
 * situation from "the gateway is behind", and only the second is a reason not to publish.
 */
import { readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const base = (process.env.CERTEN_API_URL ?? 'https://gateway.kompendium.co').replace(/\/+$/, '');
const url = `${base}/docs/json`;

const METHODS = ['get', 'post', 'put', 'patch', 'delete'];

/** `{ 'GET /v1/x': true }` for every operation in an OpenAPI document. */
function operations(spec) {
  const out = new Set();
  for (const [path, ops] of Object.entries(spec.paths ?? {})) {
    for (const method of Object.keys(ops)) {
      if (METHODS.includes(method)) out.add(`${method.toUpperCase()} ${path}`);
    }
  }
  return out;
}

const vendored = operations(JSON.parse(readFileSync(join(repoRoot, 'spec', 'openapi.json'), 'utf8')));

let live;
try {
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) {
    console.error(`gateway-check: GET ${url} -> ${res.status}. Could not determine what is deployed.`);
    process.exit(2);
  }
  live = operations(await res.json());
} catch (err) {
  console.error(`gateway-check: could not reach ${url} — ${err.message}`);
  console.error('gateway-check: this says nothing about whether the deployment is current.');
  process.exit(2);
}

const missing = [...vendored].filter((op) => !live.has(op)).sort();
const ahead = [...live].filter((op) => !vendored.has(op)).length;

console.log(`gateway-check: ${base}`);
console.log(`  vendored spec: ${vendored.size} operations`);
console.log(`  deployed:      ${live.size} operations`);

if (missing.length === 0) {
  // Extra operations on the deployment are reported but never fatal: a gateway ahead of the SDK is
  // the normal state between a deploy and a release.
  if (ahead > 0) console.log(`  ${ahead} operation(s) deployed that this build does not call — fine.`);
  console.log('gateway-check: the deployment can serve this build.');
  process.exit(0);
}

console.error('');
console.error(`gateway-check: ${missing.length} operation(s) this build calls are NOT deployed:`);
for (const op of missing) console.error(`    ${op}`);
console.error('');
console.error('Publishing now would ship a client whose calls 404 against the live gateway.');
console.error('Deploy the gateway first, then re-run this check.');
process.exit(1);
