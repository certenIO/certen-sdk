import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { CertenClient, type ReceiptRequest } from '../src/index.js';
import { buildReceipt } from '../src/verify.js';
import { executionComponentOf } from '../src/execution-proof.js';

/**
 * `effectRpc`: a node used ONLY to read the recipient's balance.
 *
 * `rpc` makes the SDK do two things with one node: compare the proof's block header (closing the execution layer) and read the recipient. A server an agent
 * drives cannot take `rpc` from a caller, but its operator can configure a node, and the caller may also hand over a block `header` it fetched itself. Then
 * the two jobs have two sources: the header decides the proof layer, and the operator's node reads the recipient. `header` together with `rpc` stays an error
 * (which one decided the proof layer would be a guess); `header` together with `effectRpc` is exactly this case.
 *
 * The rules that must not move: `effectRpc` never closes the proof's execution layer by itself, a node on the wrong chain or without history never produces
 * `confirmed`, and the node's URL (which can carry a key) is never in the receipt.
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
const KEY = 'SECRETKEY_0123456789';
const GOOD_HEADER = { number: `0x${BLOCK.toString(16)}`, hash: component.block_hash, receiptsRoot: component.receipts_root };

const TRANSFER: ReceiptRequest = {
  kind: 'transfer', chain: 'base-sepolia', chain_id: 84532, identity_id: 'id-1', adi_url: null,
  from: null, to: RECIPIENT, amount: '0.001', asset: 'ETH', contract_call: null,
};
const completedTx = { intent_id: INTENT, identity_id: 'id-1', status: 'completed', proof_id: PROOF, accum_tx_hash: `acc://${ACCUM}@jason-dev.acme/data`, created_at: '2026-10-15T00:00:00Z' };

async function gateway() {
  const registry = {
    version: '1', last_updated: 'x', count: 1,
    accumulate: { network: 'kermit', environment: 'testnet', api: 'http://x/v3', explorer: 'https://explorer.accumulatenetwork.io' },
    chains: [{ id: 'base-sepolia', chainId: 84532, family: 'evm', displayName: 'Base Sepolia', environment: 'testnet', explorer: 'https://sepolia.basescan.org', status: 'live', contracts: {}, enabled: true }],
  };
  const server = http.createServer((req, res) => {
    const path = (req.url ?? '').split('?')[0]!;
    const json = (status: number, body: unknown, type = 'application/json'): void => void res.writeHead(status, { 'content-type': type }).end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
    if (path === `/v1/transaction/${INTENT}`) return json(200, completedTx);
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
    close: () => new Promise<void>((r) => { server.closeAllConnections?.(); server.close(() => r()); }),
  };
}

interface NodeOptions { chainId?: number; balances?: Record<string, bigint>; header?: 'good' | 'wrongroot' }
async function evmNode(o: NodeOptions = {}) {
  const seen: string[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const call = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      seen.push(call.method);
      const reply = (result: unknown): void => void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: 1, result }));
      const err = (message: string): void => void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32000, message } }));
      if (call.method === 'eth_chainId') return reply(`0x${(o.chainId ?? 84532).toString(16)}`);
      if (call.method === 'eth_getBlockByNumber') {
        return reply({ number: call.params[0], hash: component.block_hash, receiptsRoot: o.header === 'wrongroot' ? `0x${'00'.repeat(32)}` : component.receipts_root });
      }
      if (call.method === 'eth_getBalance') {
        const v = o.balances?.[String(call.params[1])];
        return v === undefined ? err('missing trie node') : reply(`0x${v.toString(16)}`);
      }
      err('method not found');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as AddressInfo).port;
  return { url: `http://127.0.0.1:${port}/v2/${KEY}`, seen, close: () => new Promise<void>((r) => { server.closeAllConnections?.(); server.close(() => r()); }) };
}

const tag = (n: number): string => `0x${n.toString(16)}`;
const ETH = (n: string): bigint => BigInt(Math.round(Number(n) * 1e6)) * 10n ** 12n;
const RISE = { [tag(BLOCK - 1)]: ETH('0.005'), [tag(BLOCK)]: ETH('0.006'), latest: ETH('0.006') };
const codes = (r: { gaps: Array<{ code: string }> }): string[] => r.gaps.map((g) => g.code);

describe('buildReceipt with a header for the proof and a node for the recipient', () => {
  it('the header decides the proof layer and the node reads the recipient: the node is never asked for a block header', async () => {
    const g = await gateway();
    const n = await evmNode({ balances: RISE });
    try {
      const r = await buildReceipt(g.client, INTENT, { request: TRANSFER, header: GOOD_HEADER, effectRpc: n.url });
      expect(r.proof.layers.find((l) => l.id === 'outcome')).toMatchObject({ verdict: 'verified' });
      expect(r.proof.node_checked).toBe(true);
      expect(r.effect).toMatchObject({ state: 'confirmed', recipient: { before: '0.005', after: '0.006', at_block: BLOCK, source: 'rpc' } });
      expect(codes(r)).not.toContain('EFFECT_UNCHECKED');
      expect(codes(r)).not.toContain('NODE_NOT_CONSULTED');
      expect(n.seen).not.toContain('eth_getBlockByNumber');
      expect(JSON.stringify(r)).not.toContain(KEY);
    } finally { await g.close(); await n.close(); }
  });

  it('a node given only as effectRpc NEVER closes the proof\'s execution layer: that gap stays, and says so', async () => {
    const g = await gateway();
    const n = await evmNode({ balances: RISE });
    try {
      const r = await buildReceipt(g.client, INTENT, { request: TRANSFER, effectRpc: n.url });
      expect(r.proof.layers.find((l) => l.id === 'outcome')).toMatchObject({ verdict: 'not_checked' });
      expect(r.proof.node_checked).toBe(false);
      expect(codes(r)).toContain('NODE_NOT_CONSULTED');
      expect(r.effect.state).toBe('confirmed');
      expect(n.seen).not.toContain('eth_getBlockByNumber');
    } finally { await g.close(); await n.close(); }
  });

  it('with both rpc and effectRpc, rpc decides the proof layer and effectRpc reads the recipient', async () => {
    const g = await gateway();
    const proofNode = await evmNode({ balances: { latest: 0n } }); // would make the recipient unreadable if it were asked
    const recipientNode = await evmNode({ balances: RISE });
    try {
      const r = await buildReceipt(g.client, INTENT, { request: TRANSFER, rpc: proofNode.url, effectRpc: recipientNode.url });
      expect(r.proof.layers.find((l) => l.id === 'outcome')).toMatchObject({ verdict: 'verified' });
      expect(r.effect.state).toBe('confirmed');
      expect(proofNode.seen).toContain('eth_getBlockByNumber');
      expect(proofNode.seen).not.toContain('eth_getBalance');
      expect(recipientNode.seen).not.toContain('eth_getBlockByNumber');
    } finally { await g.close(); await proofNode.close(); await recipientNode.close(); }
  });

  it('rpc alone still does both jobs, exactly as it always did', async () => {
    const g = await gateway();
    const n = await evmNode({ balances: RISE });
    try {
      const r = await buildReceipt(g.client, INTENT, { request: TRANSFER, rpc: n.url });
      expect(r.proof.node_checked).toBe(true);
      expect(r.effect.state).toBe('confirmed');
    } finally { await g.close(); await n.close(); }
  });

  it('header together with rpc is still refused before any request', async () => {
    const g = await gateway();
    try {
      await expect(buildReceipt(g.client, INTENT, { header: GOOD_HEADER, rpc: 'http://127.0.0.1:1/' })).rejects.toMatchObject({ code: 'CONFLICTING_OPTIONS' });
    } finally { await g.close(); }
  });
});

describe('a recipient node that cannot be trusted never produces `confirmed`', () => {
  it('a node on another chain: the recipient is unreadable, the proof (closed by the header) is untouched, and the receipt is not verified', async () => {
    const g = await gateway();
    const n = await evmNode({ chainId: 1, balances: RISE });
    try {
      const r = await buildReceipt(g.client, INTENT, { request: TRANSFER, header: GOOD_HEADER, effectRpc: n.url });
      expect(r.effect.state).toBe('unreadable');
      expect(r.effect.detail).toMatch(/chain/i);
      expect(codes(r)).toContain('EFFECT_UNREADABLE');
      expect(r.proof.node_checked).toBe(true);
      expect(r.verdict).not.toBe('verified');
      expect(n.seen).not.toContain('eth_getBalance'); // the chain id is checked first
    } finally { await g.close(); await n.close(); }
  });

  it('a node with no history for the block before the transfer: unreadable, not "the balance did not rise"', async () => {
    const g = await gateway();
    const n = await evmNode({ balances: { latest: ETH('0.006') } }); // no state at the blocks asked for
    try {
      const r = await buildReceipt(g.client, INTENT, { request: TRANSFER, header: GOOD_HEADER, effectRpc: n.url });
      expect(r.effect.state).toBe('unreadable');
      expect(codes(r)).toContain('EFFECT_UNREADABLE');
      expect(codes(r)).not.toContain('EFFECT_NOT_OBSERVED');
    } finally { await g.close(); await n.close(); }
  });

  it('a node that is down: unreadable, and the host is named but never the URL', async () => {
    const g = await gateway();
    const dead = await evmNode();
    const url = dead.url;
    await dead.close();
    try {
      const r = await buildReceipt(g.client, INTENT, { request: TRANSFER, header: GOOD_HEADER, effectRpc: url });
      expect(r.effect.state).toBe('unreadable');
      expect(JSON.stringify(r)).not.toContain(KEY);
    } finally { await g.close(); }
  });

  it('a balance that did not rise is not_observed, and keeps the receipt from being verified', async () => {
    const g = await gateway();
    const n = await evmNode({ balances: { [tag(BLOCK - 1)]: ETH('0.005'), [tag(BLOCK)]: ETH('0.005'), latest: ETH('0.005') } });
    try {
      const r = await buildReceipt(g.client, INTENT, { request: TRANSFER, header: GOOD_HEADER, effectRpc: n.url });
      expect(r.effect.state).toBe('not_observed');
      expect(codes(r)).toContain('EFFECT_NOT_OBSERVED');
      expect(r.verdict).not.toBe('verified');
    } finally { await g.close(); await n.close(); }
  });
});
