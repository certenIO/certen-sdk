#!/usr/bin/env node
/**
 * Exercise an INSTALLED @certen.io/proof-verify: verify the recorded conformance document offline, and require that a tampered copy
 * is refused at the layer the tamper is in.
 *
 *   node scripts/verify-serves-conformance.mjs <directory where the tarball was installed>
 *
 * The packaging jobs call this after `npm install <tarball>` in a scratch project, so what runs is the artefact that would be
 * published, not the workspace. A package that installs cleanly and throws on first import is the failure this exists for.
 */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const consume = resolve(process.argv[2] ?? '.');
const here = dirname(fileURLToPath(import.meta.url));
const confDir = join(here, '..', 'packages', 'verify', 'test', 'fixtures', 'proofv2');

const require = createRequire(join(consume, 'noop.js'));
const entry = require.resolve('@certen.io/proof-verify');
const v = await import(pathToFileURL(entry).href);

const manifest = JSON.parse(readFileSync(join(confDir, 'manifest.json'), 'utf8'));
const doc = JSON.parse(gunzipSync(readFileSync(join(confDir, manifest.base))).toString('utf8'));

const ok = v.verifyProofDocument(doc);
const layers = Object.fromEntries(ok.layers.map((l) => [l.id, l.verdict]));
for (const id of ['trust_base', 'L4', 'L1', 'L2', 'L3', 'G0', 'G1', 'L4_set', 'govRootV3']) {
  if (layers[id] !== 'verified') throw new Error(`packed verifier: layer ${id} is ${layers[id]}, not verified`);
}
if (ok.report?.certifiedBlock !== manifest.cases[0].report.certifiedBlock) throw new Error('packed verifier: certified block differs from the manifest');
if (ok.govRootV3 !== manifest.cases[0].report.govRootV3) throw new Error('packed verifier: govRoot v3 differs from the manifest');

const bad = JSON.parse(JSON.stringify(doc));
bad.evidence.receipt.entries[0].hash = 'ab'.repeat(32);
const refused = v.verifyProofDocument(bad);
if (refused.overall !== 'failed' || refused.failure?.layer !== 'L1') throw new Error(`packed verifier: a tampered receipt was ${refused.overall} at ${refused.failure?.layer}, not failed at L1`);
if (v.verifyProofDocument({ verified: true }).overall !== 'failed') throw new Error('packed verifier: a bare flag was not refused');

console.log(`packed verifier: conformance document verified layer by layer (certified block ${ok.report.certifiedBlock}); a tampered copy failed at L1`);
