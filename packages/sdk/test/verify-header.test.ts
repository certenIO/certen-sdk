import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { CertenClient, CertenError, type ReceiptRequest } from '../src/index.js';
import { assertComparableHeader, buildReceipt, loadProofEvidence, verifyEvidence } from '../src/verify.js';
import { executionComponentOf } from '../src/execution-proof.js';

/**
 * A block header the caller fetched from their OWN node and hands in, instead of a URL for the SDK to call.
 *
 * `rpc` makes the SDK fetch the header, which is right for a CLI on someone's machine and wrong for a server an agent drives: a server that
 * calls whatever address it is given is a way to make it probe a network it sits in. The MCP server therefore takes the header itself, as
 * `certen_proof_verify` already did - and that path had a hole this file closes. A header with nothing to compare (`{}`, or only a block
 * number the bundle itself supplied) passed `verifyBundle`'s comparison because there was nothing in it to disagree about, so the execution
 * layer read VERIFIED having compared nothing. Phase 4 closed the same hole for the CLI's node fallback; this is the one entry the others
 * share. Unknown is not ok: a header is a comparison only if it carries the receipts root the proof commits to.
 *
 * Run against a real localhost gateway serving the repo's real proof fixtures. Nothing is mocked.
 */

const confDir = new URL('../../verify/test/fixtures/proofv2/', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('manifest.json', confDir), 'utf8'));
const portable = JSON.parse(gunzipSync(readFileSync(new URL(manifest.base, confDir))).toString('utf8'));
const execBundle = JSON.parse(readFileSync(new URL('./fixtures/execution-proof-base-46437431.json', import.meta.url), 'utf8'));
const component = executionComponentOf(execBundle)!;

const INTENT = '99999999-2222-4333-8444-555555555555';
const PROOF = '11111111-2222-4333-8444-555555555555';
const ACCUM = 'ab'.repeat(32);
const BLOCK = Number(component.block_number);
const RECIPIENT = `0x${'cd'.repeat(20)}`;

const GOOD = { number: `0x${BLOCK.toString(16)}`, hash: component.block_hash, receiptsRoot: component.receipts_root };
const WRONG_ROOT = { ...GOOD, receiptsRoot: `0x${'00'.repeat(32)}` };

const TRANSFER: ReceiptRequest = {
  kind: 'transfer', chain: 'base-sepolia', chain_id: 84532, identity_id: 'id-1', adi_url: null,
  from: null, to: RECIPIENT, amount: '0.001', asset: 'ETH', contract_call: null,
};

const completedTx = { intent_id: INTENT, identity_id: 'id-1', status: 'completed', proof_id: PROOF, accum_tx_hash: `acc://${ACCUM}@jason-dev.acme/data`, created_at: '2026-10-15T00:00:00Z' };

async function gateway(tx: Record<string, unknown> = completedTx) {
  const seen: string[] = [];
  const registry = {
    version: '1', last_updated: 'x', count: 1,
    accumulate: { network: 'kermit', environment: 'testnet', api: 'http://x/v3', explorer: 'https://explorer.accumulatenetwork.io' },
    chains: [{ id: 'base-sepolia', chainId: 84532, family: 'evm', displayName: 'Base Sepolia', environment: 'testnet', explorer: 'https://sepolia.basescan.org', status: 'live', contracts: {}, enabled: true }],
  };
  const server = http.createServer((req, res) => {
    const path = (req.url ?? '').split('?')[0]!;
    seen.push(`${req.method} ${path}`);
    const json = (status: number, body: unknown, type = 'application/json'): void => void res.writeHead(status, { 'content-type': type }).end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
    if (path === `/v1/transaction/${INTENT}`) return json(200, tx);
    if (path === '/v1/chains') return json(200, registry);
    if (path === `/v1/proof/${PROOF}/bundle`) return json(200, Buffer.from(JSON.stringify(execBundle)), 'application/octet-stream');
    if (path === `/v1/proof/${PROOF}/v2`) return json(200, portable);
    if (path.startsWith('/v1/proof/tx/') && path.endsWith('/receipt')) return json(200, { tx_hash: ACCUM, status: 'delivered', anchored: true });
    json(404, { message: `no route ${path}` });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    client: new CertenClient({ apiKey: 'ck_live_test', baseUrl: url, maxRetries: 0 }),
    seen,
    close: () => new Promise<void>((r) => { server.closeAllConnections?.(); server.close(() => r()); }),
  };
}

const codes = (r: { gaps: Array<{ code: string }> }): string[] => r.gaps.map((g) => g.code);
const refusal = (fn: () => unknown): CertenError => {
  try { fn(); } catch (e) { return e as CertenError; }
  throw new Error('expected a CertenError, got none');
};

describe('assertComparableHeader', () => {
  it('accepts a full header and returns only the three fields it compares', () => {
    expect(assertComparableHeader({ ...GOOD, extra: 'x', miner: '0x00' })).toEqual(GOOD);
  });

  it('accepts a header that carries only the receipts root: that is the comparison that matters', () => {
    expect(assertComparableHeader({ receiptsRoot: component.receipts_root })).toEqual({ receiptsRoot: component.receipts_root });
  });

  it('accepts the block number as hex, as a node sends it, or as a plain non-negative integer, and returns it as a string', () => {
    expect(assertComparableHeader({ receiptsRoot: component.receipts_root, number: '0x2c4a0b7' }).number).toBe('0x2c4a0b7');
    expect(assertComparableHeader({ receiptsRoot: component.receipts_root, number: 46437431 }).number).toBe('46437431');
    expect(assertComparableHeader({ receiptsRoot: component.receipts_root, number: '46437431' }).number).toBe('46437431');
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a string', '0xb7c0'],
    ['an array', [GOOD]],
    ['an empty object', {}],
    ['a block number alone, which the bundle itself supplies and so compares nothing', { number: `0x${BLOCK.toString(16)}` }],
    ['a block hash alone', { hash: component.block_hash }],
    ['an empty receipts root', { receiptsRoot: '' }],
    ['a receipts root that is not 32 bytes of hex', { receiptsRoot: '0x12' }],
    ['a receipts root with no 0x prefix', { receiptsRoot: component.receipts_root.slice(2) }],
    ['a receipts root that is a number', { receiptsRoot: 12345 }],
  ])('refuses %s, with INVALID_HEADER, because it compares nothing', (_name, header) => {
    const err = refusal(() => assertComparableHeader(header));
    expect(err).toBeInstanceOf(CertenError);
    expect(err.code).toBe('INVALID_HEADER');
    expect(err.status).toBe(0);
  });

  it.each([
    ['a block hash that is not 32 bytes', { ...GOOD, hash: '0xabc' }],
    ['a block number that is not a number', { ...GOOD, number: 'latest' }],
    ['a negative block number', { ...GOOD, number: -1 }],
    ['a fractional block number', { ...GOOD, number: 1.5 }],
    ['an unsafe integer block number', { ...GOOD, number: 2 ** 60 }],
  ])('refuses a receipts root that is right beside %s: half a header is not trusted', (_name, header) => {
    expect(refusal(() => assertComparableHeader(header)).code).toBe('INVALID_HEADER');
  });

  it('names the missing field, so the caller knows what to fetch', () => {
    expect(refusal(() => assertComparableHeader({ number: '0x1' })).message).toMatch(/receiptsRoot/);
  });
});

describe('verifyEvidence with a header the caller fetched', () => {
  it('closes the execution layer against the proof, and says a header was compared', async () => {
    const g = await gateway();
    try {
      const evidence = await loadProofEvidence(g.client, INTENT);
      const v = await verifyEvidence(evidence, { header: GOOD });
      expect(v.layers.find((l) => l.id === 'outcome')).toMatchObject({ verdict: 'verified' });
      expect(v.headerCheck).toMatchObject({ ok: true });
      expect(v.nodeConsulted).toBe(true);
    } finally { await g.close(); }
  });

  it('a header that carries only the receipts root is enough, and is compared', async () => {
    const g = await gateway();
    try {
      const evidence = await loadProofEvidence(g.client, INTENT);
      const v = await verifyEvidence(evidence, { header: { receiptsRoot: component.receipts_root } });
      expect(v.layers.find((l) => l.id === 'outcome')).toMatchObject({ verdict: 'verified' });
      expect(v.nodeConsulted).toBe(true);
    } finally { await g.close(); }
  });

  it('a header whose receipts root differs FAILS the execution layer and names the difference', async () => {
    const g = await gateway();
    try {
      const evidence = await loadProofEvidence(g.client, INTENT);
      const v = await verifyEvidence(evidence, { header: WRONG_ROOT });
      expect(v.layers.find((l) => l.id === 'outcome')).toMatchObject({ verdict: 'failed' });
      expect(v.layers.find((l) => l.id === 'outcome')?.reason).toMatch(/disagrees/);
      expect(v.overall).toBe('failed');
    } finally { await g.close(); }
  });

  it('a header with nothing to compare is refused instead of reading as a comparison that passed', async () => {
    const g = await gateway();
    try {
      const evidence = await loadProofEvidence(g.client, INTENT);
      for (const header of [{}, { number: `0x${BLOCK.toString(16)}` }, { hash: component.block_hash }]) {
        await expect(verifyEvidence(evidence, { header })).rejects.toMatchObject({ code: 'INVALID_HEADER' });
      }
    } finally { await g.close(); }
  });

  it('a header and a node together are refused: which one decided would be a guess', async () => {
    const g = await gateway();
    try {
      const evidence = await loadProofEvidence(g.client, INTENT);
      await expect(verifyEvidence(evidence, { header: GOOD, rpc: 'http://127.0.0.1:1/' })).rejects.toMatchObject({ code: 'CONFLICTING_OPTIONS' });
    } finally { await g.close(); }
  });

  it('with no execution component in the evidence, a valid header compared nothing and does not say it did', async () => {
    const g = await gateway();
    try {
      const evidence = await loadProofEvidence(g.client, INTENT);
      const v = await verifyEvidence({ bundle: null, portable: evidence.portable }, { header: GOOD });
      expect(v.nodeConsulted).toBe(false);
      expect(v.headerCheck).toBeNull();
    } finally { await g.close(); }
  });
});

describe('buildReceipt with a header the caller fetched', () => {
  it('closes the proof\'s execution layer with no node anywhere, and drops the node gap', async () => {
    const g = await gateway();
    try {
      const r = await buildReceipt(g.client, INTENT, { header: GOOD });
      expect(r.proof.layers.find((l) => l.id === 'outcome')).toMatchObject({ verdict: 'verified' });
      expect(r.proof.node_checked).toBe(true);
      expect(codes(r)).not.toContain('NODE_NOT_CONSULTED');
      // The requests are the same five a receipt always needs: a header is data, not another call.
      expect(g.seen.sort()).toEqual([
        'GET /v1/chains', `GET /v1/proof/${PROOF}/bundle`, `GET /v1/proof/${PROOF}/v2`, `GET /v1/proof/tx/${ACCUM}/receipt`, `GET /v1/transaction/${INTENT}`,
      ].sort());
    } finally { await g.close(); }
  });

  it('a header closes the PROOF and never the effect: a described transfer is still unchecked, and still not verified', async () => {
    const g = await gateway();
    try {
      const r = await buildReceipt(g.client, INTENT, { header: GOOD, request: TRANSFER });
      expect(r.effect.state).toBe('unchecked');
      expect(codes(r)).toContain('EFFECT_UNCHECKED');
      expect(r.verdict).not.toBe('verified');
    } finally { await g.close(); }
  });

  it('a header that disagrees with the proof makes the receipt FAIL, naming the header', async () => {
    const g = await gateway();
    try {
      const r = await buildReceipt(g.client, INTENT, { header: WRONG_ROOT });
      expect(r.verdict).toBe('failed');
      expect(r.proof.verdict).toBe('failed');
      expect(r.headline).toMatch(/disagrees/);
    } finally { await g.close(); }
  });

  it('refuses a header with no receipts root before a single request is made', async () => {
    const g = await gateway();
    try {
      await expect(buildReceipt(g.client, INTENT, { header: { number: '0x1' } })).rejects.toMatchObject({ code: 'INVALID_HEADER' });
      expect(g.seen).toEqual([]);
    } finally { await g.close(); }
  });

  it('refuses a header together with a node before a single request is made', async () => {
    const g = await gateway();
    try {
      await expect(buildReceipt(g.client, INTENT, { header: GOOD, rpc: 'http://127.0.0.1:1/' })).rejects.toMatchObject({ code: 'CONFLICTING_OPTIONS' });
      expect(g.seen).toEqual([]);
    } finally { await g.close(); }
  });

  it('an intent that has not finished has no proof to compare a header with, and stays pending', async () => {
    const g = await gateway({ ...completedTx, status: 'anchoring', proof_id: null });
    try {
      const r = await buildReceipt(g.client, INTENT, { header: GOOD });
      expect(r.verdict).toBe('pending');
      expect(r.proof.node_checked).toBe(false);
    } finally { await g.close(); }
  });
});
