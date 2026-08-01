#!/usr/bin/env node
/**
 * Fetch the gateway's live OpenAPI document into `spec/openapi.json`.
 *
 * This is the ONLY step that touches the network. Everything else — the contract fixture, llms.txt,
 * llms-full.txt — is derived from the vendored copy, so tests and CI stay offline and deterministic.
 *
 *   npm run spec:refresh                          # from the production gateway
 *   CERTEN_API_URL=https://staging npm run spec:refresh
 *
 * Then `npm run agentgen` to rebuild what depends on it, and commit both together. Reviewing the
 * spec diff alongside the regenerated docs is the point: an API change should be visible.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from './lib/paths.mjs';

const base = process.env.CERTEN_API_URL ?? 'https://gateway.kompendium.co';
const url = `${base}/docs/json`;
const out = join(REPO_ROOT, 'spec', 'openapi.json');

const res = await fetch(url);
if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
const spec = await res.json();

const opCount = Object.values(spec.paths ?? {}).reduce(
  (n, methods) =>
    n + Object.keys(methods).filter((m) => ['get', 'post', 'patch', 'put', 'delete'].includes(m)).length,
  0,
);

// Pretty-printed so the diff of an API change is reviewable rather than one enormous line.
writeFileSync(out, `${JSON.stringify(spec, null, 2)}\n`, 'utf8');
console.log(`wrote spec/openapi.json from ${url} — ${Object.keys(spec.paths ?? {}).length} paths, ${opCount} operations`);
console.log('next: npm run agentgen');
