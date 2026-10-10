import { readFileSync } from 'node:fs';
import { gunzipSync, gzipSync } from 'node:zlib';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { CertenClient } from '../src/index.js';
import { loadProofEvidence, verifyBundle } from '../src/verify.js';
import { executionComponentOf } from '../src/execution-proof.js';

/**
 * loadProofEvidence reads a bundle by its bytes. The deployed gateway serves a JSON bundle as application/octet-stream, and a bundle
 * may be gzip-compressed: a loader that went by the content type dropped the execution component from a bundle that had one, so the
 * outcome layer was reported unchecked for the wrong reason (found on the first live proof, RB7b-F48).
 */
const confDir = new URL('../../verify/test/fixtures/proofv2/', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('manifest.json', confDir), 'utf8'));
const portable = JSON.parse(gunzipSync(readFileSync(new URL(manifest.base, confDir))).toString('utf8'));
const execBundle = JSON.parse(readFileSync(new URL('./fixtures/execution-proof-base-46437431.json', import.meta.url), 'utf8'));
const component = executionComponentOf(execBundle)!;
const PROOF = '11111111-2222-4333-8444-555555555555';
const INTENT = '99999999-2222-4333-8444-555555555555';

async function gateway(bundle: () => { type: string; body: Buffer }) {
  const server = http.createServer((req, res) => {
    const path = (req.url ?? '').split('?')[0];
    if (path === `/v1/transaction/${INTENT}`) return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id: INTENT, proof_id: PROOF, accum_tx_hash: `acc://${'ab'.repeat(32)}@x.acme/data` }));
    if (path === `/v1/proof/${PROOF}/bundle`) { const b = bundle(); return void res.writeHead(200, { 'content-type': b.type }).end(b.body); }
    if (path === `/v1/proof/${PROOF}/v2`) return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(portable));
    res.writeHead(404, { 'content-type': 'application/json' }).end('{}');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { client: new CertenClient({ apiKey: 'ck_live_test', baseUrl: url, maxRetries: 0 }), close: () => server.close() };
}

const json = Buffer.from(JSON.stringify(execBundle));
const header = () => ({ hash: component.block_hash, receiptsRoot: component.receipts_root, number: '0x' + Number(component.block_number).toString(16) });

describe('loadProofEvidence reads the bundle by its bytes', () => {
  for (const [name, type, body] of [
    ['JSON served as application/octet-stream (what the gateway does)', 'application/octet-stream', json],
    ['JSON served as application/json', 'application/json', json],
    ['gzip-compressed JSON served as application/octet-stream', 'application/octet-stream', gzipSync(json)],
  ] as const) {
    it(name, async () => {
      const g = await gateway(() => ({ type, body }));
      try {
        const loaded = await loadProofEvidence(g.client, INTENT);
        expect(loaded.bundleError).toBeNull();
        expect(executionComponentOf(loaded.bundle)).not.toBeNull();
        // and the outcome layer is then checked against a header, instead of being reported as having no execution proof
        const v = verifyBundle({ ...loaded.bundle, proof_v2: loaded.portable }, { header: header() });
        expect(v.layers.find((l) => l.id === 'outcome')?.verdict).toBe('verified');
      } finally { g.close(); }
    });
  }

  it('bytes that are not a JSON bundle are reported as such, with the content type, and no bundle is invented', async () => {
    const g = await gateway(() => ({ type: 'application/octet-stream', body: Buffer.from([1, 2, 3, 4]) }));
    try {
      const loaded = await loadProofEvidence(g.client, INTENT);
      expect(loaded.bundle).toBeNull();
      expect(loaded.bundleError).toMatch(/application\/octet-stream.*not a JSON proof bundle/);
    } finally { g.close(); }
  });
});
