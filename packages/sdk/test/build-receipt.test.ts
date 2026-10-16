import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { CertenClient, CertenError, type ReceiptRequest, type RecipientSnapshot } from '../src/index.js';
import { buildReceipt, loadProofEvidence, verifyEvidence, bundleInputOf, verifyBundle } from '../src/verify.js';
import { executionComponentOf } from '../src/execution-proof.js';

/**
 * `buildReceipt`: fetch, verify here, check the effect, assemble.
 *
 * Run against a real localhost gateway that serves the repo's own proof fixtures (a real Base Sepolia execution receipt and a real proof v2
 * portable document), and a real localhost EVM node for the caller's `rpc`. Nothing is mocked; what is pinned is what the receipt does
 * when the world is less than perfect, because that is when its honesty matters:
 *
 * - without a node of the caller's the execution layer is NOT checked, and the receipt is PARTIAL and says which gap that is;
 * - a node that is down, has no such block, or is not on the chain never makes anything look verified, and never stops the proof being checked
 *   without it;
 * - a proof the gateway could not serve is a gap, never a pass;
 * - the requests are the ones that were needed and no more (a wait ends holding the intent; it is not read again).
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

// The fixture's own events: the contract that emitted them and the first topic of one of them.
const EVENT = { address: '0x5886F366a555f4F6C451b73727Fb709dA6c005F8', topic0: '0x74b66e509fa5263d4932860a2e1f6d187381ae68dee216710283b8677703ff12' };

const TRANSFER: ReceiptRequest = {
  kind: 'transfer', chain: 'base-sepolia', chain_id: 84532, identity_id: 'id-1', adi_url: 'acc://jason-dev.acme',
  from: `0x${'aa'.repeat(20)}`, to: RECIPIENT, amount: '0.001', asset: 'ETH', contract_call: null,
};
const CALL: ReceiptRequest = {
  kind: 'contract_call', chain: 'base-sepolia', chain_id: 84532, identity_id: 'id-1', adi_url: 'acc://jason-dev.acme',
  from: `0x${'aa'.repeat(20)}`, to: EVENT.address, amount: null, asset: null,
  contract_call: { target: EVENT.address, function_signature: 'confirm(bytes32)', value_wei: '0' },
};

const completedTx = { intent_id: INTENT, identity_id: 'id-1', status: 'completed', proof_id: PROOF, accum_tx_hash: `acc://${ACCUM}@jason-dev.acme/data`, created_at: '2026-10-15T00:00:00Z' };

interface GatewayOptions {
  tx?: Record<string, unknown>;
  bundle?: 'ok' | '404' | '500' | 'drop';
  portable?: 'ok' | '404' | '500';
  chains?: 'ok' | '500';
}

async function gateway(o: GatewayOptions = {}) {
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
    if (path === `/v1/transaction/${INTENT}`) return json(200, o.tx ?? completedTx);
    if (path === '/v1/chains') return o.chains === '500' ? json(500, { message: 'down' }) : json(200, registry);
    if (path === `/v1/proof/${PROOF}/bundle`) {
      if (o.bundle === 'drop') { req.socket.destroy(); return; }
      if (o.bundle === '404') return json(404, { message: 'no such bundle' });
      return o.bundle === '500' ? json(500, { message: 'proof service down' }) : json(200, Buffer.from(JSON.stringify(execBundle)), 'application/octet-stream');
    }
    if (path === `/v1/proof/${PROOF}/v2`) return o.portable === '404' ? json(404, { message: 'none' }) : o.portable === '500' ? json(500, { message: 'down' }) : json(200, portable);
    if (path.startsWith('/v1/proof/tx/') && path.endsWith('/receipt')) return json(200, { tx_hash: ACCUM, status: 'delivered', anchored: true });
    json(404, { message: `no route ${path}` });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    client: new CertenClient({ apiKey: 'ck_live_test', baseUrl: url, maxRetries: 0 }),
    seen,
    count: (what: string) => seen.filter((s) => s === what).length,
    close: () => new Promise<void>((r) => { server.closeAllConnections?.(); server.close(() => r()); }),
  };
}

interface NodeOptions { header?: 'good' | 'none' | 'noroot' | 'wrongroot'; chainId?: number; balances?: Record<string, bigint> }

/** The caller's EVM node: the header of the fixture's block (or a wrong one), the chain id, and balances by block tag. */
async function evmNode(o: NodeOptions = {}) {
  const seen: Array<{ method: string; params: unknown[] }> = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const call = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      seen.push({ method: call.method, params: call.params });
      const reply = (result: unknown): void => void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: 1, result }));
      const err = (message: string): void => void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32000, message } }));
      if (call.method === 'eth_chainId') return reply(`0x${(o.chainId ?? 84532).toString(16)}`);
      if (call.method === 'eth_getBlockByNumber') {
        if (o.header === 'none') return reply(null);
        if (o.header === 'noroot') return reply({ number: call.params[0] });
        return reply({
          number: call.params[0], hash: component.block_hash,
          receiptsRoot: o.header === 'wrongroot' ? `0x${'00'.repeat(32)}` : component.receipts_root,
        });
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
  return {
    url: `http://127.0.0.1:${port}/v2/${KEY}`, host: `127.0.0.1:${port}`, seen,
    close: () => new Promise<void>((r) => { server.closeAllConnections?.(); server.close(() => r()); }),
  };
}

/** A URL nothing listens on: the node being down. */
async function deadUrl(): Promise<string> {
  const server = http.createServer();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((r) => server.close(() => r()));
  return `http://127.0.0.1:${port}/v2/${KEY}`;
}

const tag = (n: number): string => `0x${n.toString(16)}`;
const ETH = (n: string): bigint => BigInt(Math.round(Number(n) * 1e6)) * 10n ** 12n;
const snapshot = (wei: bigint): RecipientSnapshot => ({ address: RECIPIENT, wei: wei.toString(), host: 'rpc.example', chain_id: 84532, taken_at: '2026-10-15T00:00:00.000Z' });
const codes = (r: { gaps: Array<{ code: string }> }): string[] => r.gaps.map((g) => g.code);

describe('buildReceipt: a completed transfer', () => {
  it('without a node of the caller\'s, checks the proof here and is PARTIAL, naming the execution layer and the unchecked recipient', async () => {
    const g = await gateway();
    try {
      const r = await buildReceipt(g.client, INTENT, { request: TRANSFER, gateway: 'https://gw.example' });
      expect(r.verdict).toBe('partial');
      expect(r.proof.checked_here).toBe(true);
      expect(r.proof.node_checked).toBe(false);
      expect(r.proof.layers.find((l) => l.id === 'outcome')).toMatchObject({ verdict: 'not_checked' });
      expect(codes(r)).toContain('NODE_NOT_CONSULTED');
      expect(codes(r)).toContain('EFFECT_UNCHECKED');
      expect(r.effect.state).toBe('unchecked');
      // The ids come from the verified bytes: the destination transaction is the proof's, not a field the gateway merely sent.
      expect(r.ids).toMatchObject({
        destination_tx: component.tx_hash, destination_tx_source: 'proof', destination_block: BLOCK, destination_chain: 'base-sepolia',
        accumulate_tx_hash: ACCUM, proof_id: PROOF,
      });
      expect(r.links.destination_tx).toBe(`https://sepolia.basescan.org/tx/${component.tx_hash}`);
      expect(r.gateway).toBe('https://gw.example');
      expect(r.headline).toMatch(/^PARTIAL: /);
      // The bundle's own `verified` flag was reported to nobody as a verdict: nothing in the receipt says verified here.
      expect(r.verdict).not.toBe('verified');
    } finally { await g.close(); }
  });

  it('reads the intent once, the registry once, and fetches the evidence (bundle, portable document, the Accumulate receipt) once each', async () => {
    const g = await gateway();
    try {
      await buildReceipt(g.client, INTENT, { request: TRANSFER });
      expect(g.seen.sort()).toEqual([
        'GET /v1/chains',
        `GET /v1/proof/${PROOF}/bundle`,
        `GET /v1/proof/${PROOF}/v2`,
        `GET /v1/proof/tx/${ACCUM}/receipt`,
        `GET /v1/transaction/${INTENT}`,
      ].sort());
    } finally { await g.close(); }
  });

  it('with a node that answers the proof\'s block header, closes the execution layer and says a node was consulted', async () => {
    const g = await gateway();
    const n = await evmNode({ balances: { [tag(BLOCK)]: ETH('0.006'), latest: ETH('0.006') } });
    try {
      const r = await buildReceipt(g.client, INTENT, { request: TRANSFER, rpc: n.url, snapshot: snapshot(ETH('0.005')) });
      expect(r.proof.layers.find((l) => l.id === 'outcome')).toMatchObject({ verdict: 'verified' });
      expect(r.proof.node_checked).toBe(true);
      expect(codes(r)).not.toContain('NODE_NOT_CONSULTED');
      // The recipient was read from the same node: a rise of exactly the amount, measured at the proof's block.
      expect(r.effect).toMatchObject({ state: 'confirmed', recipient: { before: '0.005', after: '0.006', at_block: BLOCK } });
      expect(codes(r)).not.toContain('EFFECT_UNCHECKED');
      // The URL, which carries the node's key, is nowhere in what a receipt stores.
      expect(JSON.stringify(r)).not.toContain(KEY);
      expect(n.seen.map((c) => c.method)).toContain('eth_getBlockByNumber');
    } finally { await g.close(); await n.close(); }
  });

  it('a node that disagrees with the bundle\'s block makes the receipt FAIL, naming the header', async () => {
    const g = await gateway();
    const n = await evmNode({ header: 'wrongroot', balances: { [tag(BLOCK)]: ETH('0.006'), latest: ETH('0.006') } });
    try {
      const r = await buildReceipt(g.client, INTENT, { request: TRANSFER, rpc: n.url, snapshot: snapshot(ETH('0.005')) });
      expect(r.verdict).toBe('failed');
      expect(r.proof.verdict).toBe('failed');
      expect(r.proof.layers.find((l) => l.id === 'outcome')).toMatchObject({ verdict: 'failed' });
      expect(r.headline).toMatch(/disagrees/);
    } finally { await g.close(); await n.close(); }
  });

  it('a node that is DOWN does not stop the proof being checked: it is checked without it, and the gap names why', async () => {
    const g = await gateway();
    const dead = await deadUrl();
    try {
      const r = await buildReceipt(g.client, INTENT, { request: TRANSFER, rpc: dead, snapshot: snapshot(ETH('0.005')) });
      expect(r.proof.checked_here).toBe(true);
      expect(r.proof.node_checked).toBe(false);
      expect(r.verdict).toBe('partial');
      const gap = r.gaps.find((x) => x.code === 'NODE_NOT_CONSULTED')!;
      expect(gap.text).toMatch(/The node you gave could not be used/);
      expect(gap.text).toMatch(/could not be reached/);
      // And the recipient is unreadable, which is not the same as the balance not having risen.
      expect(r.effect.state).toBe('unreadable');
      expect(JSON.stringify(r)).not.toContain(KEY);
    } finally { await g.close(); }
  });

  it('a node with no such block is an error for the check, never a pass: the proof is checked without it and the gap says the block is missing', async () => {
    const g = await gateway();
    const n = await evmNode({ header: 'none', balances: { latest: ETH('0.006') } });
    try {
      const r = await buildReceipt(g.client, INTENT, { request: TRANSFER, rpc: n.url, snapshot: snapshot(ETH('0.005')) });
      expect(r.proof.layers.find((l) => l.id === 'outcome')?.verdict).toBe('not_checked');
      expect(r.proof.node_checked).toBe(false);
      expect(r.gaps.find((x) => x.code === 'NODE_NOT_CONSULTED')!.text).toMatch(/has no block 46437431/);
      expect(r.verdict).toBe('partial');
    } finally { await g.close(); await n.close(); }
  });

  it('a node whose header carries no receipts root compared nothing, and is treated the same way', async () => {
    const g = await gateway();
    const n = await evmNode({ header: 'noroot', balances: { latest: ETH('0.006') } });
    try {
      const r = await buildReceipt(g.client, INTENT, { request: TRANSFER, rpc: n.url, snapshot: snapshot(ETH('0.005')) });
      expect(r.proof.layers.find((l) => l.id === 'outcome')?.verdict).toBe('not_checked');
      expect(r.gaps.find((x) => x.code === 'NODE_NOT_CONSULTED')!.text).toMatch(/without a receipts root/);
    } finally { await g.close(); await n.close(); }
  });

  it('a recipient whose balance did not rise leaves the receipt partial even with a node that agrees with the proof', async () => {
    const g = await gateway();
    const n = await evmNode({ balances: { [tag(BLOCK)]: ETH('0.005'), latest: ETH('0.005') } });
    try {
      const r = await buildReceipt(g.client, INTENT, { request: TRANSFER, rpc: n.url, snapshot: snapshot(ETH('0.005')) });
      expect(r.effect.state).toBe('not_observed');
      expect(codes(r)).toContain('EFFECT_NOT_OBSERVED');
      expect(r.verdict).toBe('partial');
    } finally { await g.close(); await n.close(); }
  });

  it('measures the rise from the block before when no balance was saved, and keeps one that was saved in a previous receipt', async () => {
    const g = await gateway();
    const n = await evmNode({ balances: { [tag(BLOCK - 1)]: ETH('0.005'), [tag(BLOCK)]: ETH('0.006'), latest: ETH('0.02') } });
    try {
      const noSnapshot = await buildReceipt(g.client, INTENT, { request: TRANSFER, rpc: n.url });
      expect(noSnapshot.effect).toMatchObject({ state: 'confirmed', recipient: { before: '0.005', after: '0.006', at_block: BLOCK } });

      // A saved snapshot (here the receipt's own `recipient_snapshot`) is the baseline instead, and is kept.
      const first = await buildReceipt(g.client, INTENT, { request: TRANSFER, snapshot: snapshot(ETH('0.0055')) });
      expect(first.recipient_snapshot).toMatchObject({ wei: ETH('0.0055').toString() });
      const refreshed = await buildReceipt(g.client, INTENT, { previous: first, rpc: n.url });
      expect(refreshed.recipient_snapshot).toMatchObject({ wei: ETH('0.0055').toString() });
      expect(refreshed.effect.recipient).toMatchObject({ before: '0.0055', after: '0.006' });
      expect(refreshed.created_at).toBe(first.created_at);
      expect(refreshed.request).toEqual(TRANSFER);
    } finally { await g.close(); await n.close(); }
  });
});

describe('buildReceipt: what it does not fetch', () => {
  it('an intent still in flight makes no proof request at all', async () => {
    const g = await gateway({ tx: { ...completedTx, status: 'anchoring', proof_id: null } });
    try {
      const r = await buildReceipt(g.client, INTENT, { request: TRANSFER });
      expect(r.verdict).toBe('pending');
      expect(r.effect).toMatchObject({ kind: 'native_transfer', state: 'unchecked', detail: 'Not checked yet: the transfer has not completed.' });
      expect(g.seen.filter((s) => s.includes('/v1/proof'))).toEqual([]);
    } finally { await g.close(); }
  });

  it('an executed intent (proof pending) makes no proof request either, and says the proof is pending', async () => {
    const g = await gateway({ tx: { ...completedTx, status: 'executed', proof_id: null } });
    try {
      const r = await buildReceipt(g.client, INTENT, { request: TRANSFER });
      expect(r.verdict).toBe('pending');
      expect(codes(r)).toEqual(['PROOF_PENDING']);
      expect(g.seen.filter((s) => s.includes('/v1/proof'))).toEqual([]);
    } finally { await g.close(); }
  });

  it('a failed intent makes no proof request and is failed', async () => {
    const g = await gateway({ tx: { ...completedTx, status: 'failed', reason_code: 'target_reverted', proof_id: null } });
    try {
      const r = await buildReceipt(g.client, INTENT, { request: TRANSFER });
      expect(r.verdict).toBe('failed');
      expect(g.seen.filter((s) => s.includes('/v1/proof'))).toEqual([]);
    } finally { await g.close(); }
  });

  it('an intent the caller already holds is not read again, and a registry the caller holds (or none) is not fetched', async () => {
    const g = await gateway();
    try {
      const withTx = await buildReceipt(g.client, INTENT, { request: TRANSFER, transaction: completedTx as never, registry: null });
      expect(g.count(`GET /v1/transaction/${INTENT}`)).toBe(0);
      expect(g.count('GET /v1/chains')).toBe(0);
      // No registry means no explorer link, not a made-up one.
      expect(withTx.links).toEqual({ destination_tx: null, accumulate_explorer: null });
      // The proof was still fetched and checked.
      expect(withTx.proof.checked_here).toBe(true);
    } finally { await g.close(); }
  });

  it('a registry that cannot be read costs the links and nothing else', async () => {
    const g = await gateway({ chains: '500' });
    try {
      const r = await buildReceipt(g.client, INTENT, { request: TRANSFER });
      expect(r.links.destination_tx).toBeNull();
      expect(r.proof.checked_here).toBe(true);
      expect(g.count('GET /v1/chains')).toBe(1);
    } finally { await g.close(); }
  });
});

describe('buildReceipt: evidence the gateway could not serve', () => {
  it('a proof service that answers 5xx is UNAVAILABLE (not "no evidence": a bad moment is not the absence of a proof), a gap and a partial receipt, never a throw and never a pass', async () => {
    const g = await gateway({ bundle: '500', portable: '500' });
    try {
      const r = await buildReceipt(g.client, INTENT, { request: TRANSFER });
      expect(r.verdict).toBe('partial');
      expect(r.proof.verdict).toBe('unavailable');
      expect(r.proof.detail).toMatch(/the proof service answered 500/);
      expect(codes(r)).toContain('PROOF_NOT_FETCHED');
      expect(codes(r)).not.toContain('PROOF_NO_EVIDENCE');
      expect(r.ids.destination_tx).toBeNull();
    } finally { await g.close(); }
  });

  it('a proof the service cannot serve for good (a 404 on the document) IS no evidence, and says it once, not once per layer', async () => {
    const g = await gateway({ bundle: '404', portable: '404' });
    try {
      const r = await buildReceipt(g.client, INTENT, { request: TRANSFER });
      expect(r.verdict).toBe('partial');
      expect(r.proof.verdict).toBe('no_evidence');
      expect(codes(r).filter((c) => c === 'PROOF_NO_EVIDENCE')).toHaveLength(1);
      expect(codes(r)).not.toContain('PROOF_LAYER_NOT_ESTABLISHED');
    } finally { await g.close(); }
  });

  it('a bundle that cannot be fetched at all (the connection drops) makes the proof UNAVAILABLE, a gap that names the cause', async () => {
    const g = await gateway({ bundle: 'drop' });
    try {
      const r = await buildReceipt(g.client, INTENT, { request: TRANSFER });
      expect(r.verdict).toBe('partial');
      expect(r.proof.verdict).toBe('unavailable');
      expect(r.proof.checked_here).toBe(false);
      expect(codes(r)).toContain('PROOF_NOT_FETCHED');
    } finally { await g.close(); }
  });

  it('a completed intent with neither a proof id nor an Accumulate transaction has nothing to verify, and says so', async () => {
    const g = await gateway({ tx: { ...completedTx, proof_id: null, accum_tx_hash: null } });
    try {
      const r = await buildReceipt(g.client, INTENT, { request: TRANSFER });
      expect(r.proof.verdict).toBe('unavailable');
      expect(r.proof.detail).toMatch(/Nothing to verify/);
      expect(r.verdict).toBe('partial');
    } finally { await g.close(); }
  });

  it('a gateway that serves no portable document still has its bundle checked, and carries why the Accumulate side could not be', async () => {
    const g = await gateway({ portable: '404' });
    try {
      const r = await buildReceipt(g.client, INTENT, { request: TRANSFER });
      expect(r.proof.evidence).toMatchObject({ found: false, code: 'PROOF_V2_EVIDENCE_NOT_SERVED' });
      expect(r.verdict).toBe('partial');
      // The execution component is in the bundle, so that part is still checked (and awaits a node).
      expect(r.ids.destination_tx_source).toBe('proof');
      expect(r.proof.layers.find((l) => l.id === 'outcome')?.verdict).toBe('not_checked');
    } finally { await g.close(); }
  });
});

describe('buildReceipt: a contract call', () => {
  it('with the event the proof carries, the effect is confirmed from the proof\'s own receipt', async () => {
    const g = await gateway();
    try {
      const r = await buildReceipt(g.client, INTENT, { request: CALL, expect: EVENT });
      expect(r.effect).toMatchObject({ kind: 'contract_call', state: 'confirmed', expected_event: { found: true } });
    } finally { await g.close(); }
  });

  it('with an event the receipt does not carry, the effect is not_observed AND the proof\'s execution layer fails: the receipt fails', async () => {
    const g = await gateway();
    try {
      const r = await buildReceipt(g.client, INTENT, { request: CALL, expect: { address: EVENT.address, topic0: `0x${'ee'.repeat(32)}` } });
      expect(r.effect).toMatchObject({ state: 'not_observed', expected_event: { found: false } });
      expect(r.verdict).toBe('failed');
      expect(r.proof.layers.find((l) => l.id === 'outcome')).toMatchObject({ verdict: 'failed', reason: expect.stringMatching(/expected event is not in the receipt/) });
    } finally { await g.close(); }
  });

  it('without an expected event there is no effect to check, and it says so', async () => {
    const g = await gateway();
    try {
      const r = await buildReceipt(g.client, INTENT, { request: CALL });
      expect(r.effect).toMatchObject({ kind: 'none', state: 'not_applicable' });
      expect(r.effect.detail).toMatch(/expected event/);
    } finally { await g.close(); }
  });

  it('with an expected event but no execution receipt in the bundle, the effect is unchecked, never confirmed', async () => {
    const g = await gateway({ bundle: '500' });
    try {
      const r = await buildReceipt(g.client, INTENT, { request: CALL, expect: EVENT });
      expect(r.effect.state).toBe('unchecked');
      expect(r.effect.expected_event).toEqual({ found: null });
    } finally { await g.close(); }
  });
});

describe('buildReceipt: a receipt for an intent made elsewhere', () => {
  it('has no request, still has the ids and the proof, and no effect to check', async () => {
    const g = await gateway();
    try {
      const r = await buildReceipt(g.client, INTENT);
      expect(r.request).toBeNull();
      expect(r.kind).toBe('unknown');
      expect(r.ids.destination_chain).toBe('base-sepolia');
      expect(r.effect).toMatchObject({ kind: 'none', state: 'not_applicable' });
      expect(r.proof.checked_here).toBe(true);
    } finally { await g.close(); }
  });
});

describe('verifyEvidence', () => {
  const evidence = { bundle: execBundle as Record<string, unknown>, portable };

  it('without a node does not consult one', async () => {
    const v = await verifyEvidence(evidence);
    expect(v.nodeConsulted).toBe(false);
    expect(v.layers.find((l) => l.id === 'outcome')?.verdict).toBe('not_checked');
  });

  it('with a node that agrees, closes the outcome layer and says a node was consulted', async () => {
    const n = await evmNode();
    try {
      const v = await verifyEvidence(evidence, { rpc: n.url });
      expect(v.nodeConsulted).toBe(true);
      expect(v.layers.find((l) => l.id === 'outcome')?.verdict).toBe('verified');
      // It asked for the block the BUNDLE names, by number.
      expect(n.seen.find((c) => c.method === 'eth_getBlockByNumber')?.params).toEqual([tag(BLOCK), false]);
    } finally { await n.close(); }
  });

  it('rejects, rather than silently skipping the check, when the node cannot be reached', async () => {
    const dead = await deadUrl();
    const err = await verifyEvidence(evidence, { rpc: dead }).then(() => null, (e: unknown) => e as CertenError);
    expect(err).toBeInstanceOf(CertenError);
    expect(err!.code).toBe('EVM_RPC_UNREADABLE');
    expect(err!.message).not.toContain(KEY);
  });

  it('rejects when the node has no such block: a bare { number } would have matched what was asked and read VERIFIED', async () => {
    const n = await evmNode({ header: 'none' });
    try {
      const err = await verifyEvidence(evidence, { rpc: n.url }).then(() => null, (e: unknown) => e as CertenError);
      expect(err).toBeInstanceOf(CertenError);
      expect(err!.code).toBe('EVM_RPC_NO_BLOCK');
      expect(err!.message).toMatch(/has no block 46437431/);
      expect(err!.message).not.toContain(KEY);
      expect(err!.details).toMatchObject({ block: BLOCK });
    } finally { await n.close(); }
  });

  it('rejects when the node\'s header has no receipts root, for the same reason', async () => {
    const n = await evmNode({ header: 'noroot' });
    try {
      await expect(verifyEvidence(evidence, { rpc: n.url })).rejects.toMatchObject({ code: 'EVM_RPC_NO_BLOCK' });
    } finally { await n.close(); }
  });

  it('a node whose root differs fails the layer; it does not throw (that is the proof disagreeing, not the node failing)', async () => {
    const n = await evmNode({ header: 'wrongroot' });
    try {
      const v = await verifyEvidence(evidence, { rpc: n.url });
      expect(v.layers.find((l) => l.id === 'outcome')?.verdict).toBe('failed');
      expect(v.overall).toBe('failed');
    } finally { await n.close(); }
  });

  it('asks a node nothing when the bundle has no execution component to compare', async () => {
    const n = await evmNode();
    try {
      const v = await verifyEvidence({ bundle: null, portable }, { rpc: n.url });
      expect(v.nodeConsulted).toBe(false);
      expect(n.seen).toEqual([]);
    } finally { await n.close(); }
  });

  it('agrees with verifyBundle called by hand, so the CLI and the SDK cannot give two answers', async () => {
    const n = await evmNode();
    try {
      const viaHelper = await verifyEvidence(evidence, { rpc: n.url, expect: EVENT });
      const byHand = verifyBundle(bundleInputOf(evidence), {
        expect: EVENT, header: { hash: component.block_hash, receiptsRoot: component.receipts_root, number: tag(BLOCK) },
      });
      expect(viaHelper.overall).toBe(byHand.overall);
      expect(viaHelper.layers.map((l) => [l.id, l.verdict])).toEqual(byHand.layers.map((l) => [l.id, l.verdict]));
    } finally { await n.close(); }
  });
});

describe('loadProofEvidence with an intent already in hand', () => {
  it('does not read the intent a second time, and loads the evidence its proof id names', async () => {
    const g = await gateway();
    try {
      const loaded = await loadProofEvidence(g.client, INTENT, { proof_id: PROOF, accum_tx_hash: `acc://${ACCUM}@jason-dev.acme/data` });
      expect(g.count(`GET /v1/transaction/${INTENT}`)).toBe(0);
      expect(loaded.bundleError).toBeNull();
      expect(loaded.portable).toBeTruthy();
      expect(loaded.gateway).toMatchObject({ anchored: true });
    } finally { await g.close(); }
  });

  it('without it, still reads the intent once, as before', async () => {
    const g = await gateway();
    try {
      await loadProofEvidence(g.client, INTENT);
      expect(g.count(`GET /v1/transaction/${INTENT}`)).toBe(1);
    } finally { await g.close(); }
  });

  it('an intent in hand with an Accumulate transaction and no proof id is "not served", not an error, and the gateway\'s receipt is still fetched for information', async () => {
    const g = await gateway();
    try {
      const loaded = await loadProofEvidence(g.client, INTENT, { proof_id: null, accum_tx_hash: `acc://${ACCUM}@jason-dev.acme/data` });
      expect(loaded.notServed?.code).toBe('PROOF_V2_EVIDENCE_NOT_SERVED');
      expect(loaded.bundle).toBeNull();
      expect(loaded.gateway).toMatchObject({ anchored: true });
      expect(g.seen.filter((s) => s.includes('/bundle') || s.endsWith('/v2'))).toEqual([]);
    } finally { await g.close(); }
  });
});
