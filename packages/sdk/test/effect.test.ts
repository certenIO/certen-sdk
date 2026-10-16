import { describe, it, expect } from 'vitest';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import { checkNativeTransferEffect, snapshotRecipient, noEffectToCheck, type RecipientSnapshot } from '../src/index.js';

/**
 * Did the value arrive?
 *
 * A proof says an execution happened as the bundle shows; it does not say the person on the other end can spend the money. The check here
 * compares the recipient's balance before and after, from a node the CALLER chose, and what is pinned is how honest it is about what it saw:
 *
 * - a rise of the amount is `confirmed`, a rise of more is `confirmed` ("at least"), a smaller one is `not_observed` with a possible benign
 *   reason, and none of these is ever produced by a node that could not be read: that is `unreadable`;
 * - without a node of the caller's the recipient is `unchecked`, and the gateway's report of the SENDER never upgrades it to `confirmed`;
 * - the node's URL carries its key, so no detail ever repeats it.
 */

const KEY = 'SECRETKEY_0123456789';
const RECIPIENT = `0x${'cd'.repeat(20)}`;
const OTHER = `0x${'ef'.repeat(20)}`;
const BASE = 84532;
const ETH = (n: string): bigint => BigInt(Math.round(Number(n) * 1e6)) * 10n ** 12n; // exact enough for the whole numbers used here

interface NodeOpts {
  chainId?: number;
  /** Balance by block tag: `latest` or a hex number. A missing tag answers a state-pruned error. */
  balances: Record<string, bigint>;
  /** Everything fails with this HTTP status. */
  status?: number;
}

async function node(opts: NodeOpts) {
  const seen: Array<{ method: string; params: unknown[] }> = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const call = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      seen.push({ method: call.method, params: call.params });
      if (opts.status) { res.statusCode = opts.status; res.end('nope'); return; }
      res.setHeader('content-type', 'application/json');
      if (call.method === 'eth_chainId') return void res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: `0x${(opts.chainId ?? BASE).toString(16)}` }));
      if (call.method === 'eth_getBalance') {
        const value = opts.balances[String(call.params[1])];
        if (value === undefined) return void res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'missing trie node' } }));
        return void res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: `0x${value.toString(16)}` }));
      }
      res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'method not found' } }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/v2/${KEY}`,
    host: `127.0.0.1:${port}`,
    seen,
    close: () => new Promise<void>((r) => { server.closeAllConnections?.(); server.close(() => r()); }),
  };
}

const tag = (block: number): string => `0x${block.toString(16)}`;

const snapshot = (wei: bigint, over: Partial<RecipientSnapshot> = {}): RecipientSnapshot => ({
  address: RECIPIENT, wei: wei.toString(), host: '127.0.0.1', chain_id: BASE, taken_at: '2026-10-15T00:00:00.000Z', ...over,
});

describe('snapshotRecipient', () => {
  it('checks the node is on the chain FIRST, then takes the balance, and records where and when', async () => {
    const n = await node({ balances: { latest: ETH('0.005') } });
    try {
      const s = await snapshotRecipient({ rpc: n.url, chain: 'base-sepolia', address: RECIPIENT, now: () => new Date('2026-10-15T12:00:00Z') });
      expect(s).toEqual({ address: RECIPIENT, wei: ETH('0.005').toString(), host: n.host, chain_id: BASE, taken_at: '2026-10-15T12:00:00.000Z' });
      expect(n.seen.map((c) => c.method)).toEqual(['eth_chainId', 'eth_getBalance']);
      // The saved snapshot names the host, never the URL (which carries a key).
      expect(JSON.stringify(s)).not.toContain(KEY);
    } finally { await n.close(); }
  });

  it('refuses a node on another network and reads no balance from it', async () => {
    const n = await node({ chainId: 11155111, balances: { latest: 1n } });
    try {
      await expect(snapshotRecipient({ rpc: n.url, chain: 'base-sepolia', address: RECIPIENT })).rejects.toMatchObject({ code: 'EVM_RPC_WRONG_CHAIN' });
      expect(n.seen.map((c) => c.method)).toEqual(['eth_chainId']);
    } finally { await n.close(); }
  });
});

describe('checkNativeTransferEffect', () => {
  const base = { chain: 'base-sepolia', recipient: RECIPIENT, amount: '0.001' };

  it('confirms a rise of exactly the amount, and shows the balances it compared', async () => {
    const n = await node({ balances: { latest: ETH('0.006') } });
    try {
      const e = await checkNativeTransferEffect({ ...base, rpc: n.url, before: snapshot(ETH('0.005')) });
      expect(e).toMatchObject({ kind: 'native_transfer', state: 'confirmed', amount: '0.001', symbol: 'ETH' });
      expect(e.detail).toMatch(/exactly 0\.001 ETH/);
      expect(e.recipient).toEqual({
        source: 'rpc', host: n.host, address: RECIPIENT, symbol: 'ETH', before: '0.005', after: '0.006', delta: '0.001', at_block: 'latest',
      });
    } finally { await n.close(); }
  });

  it('confirms a larger rise as "at least", saying other transfers may be included', async () => {
    const n = await node({ balances: { latest: ETH('0.0075') } });
    try {
      const e = await checkNativeTransferEffect({ ...base, rpc: n.url, before: snapshot(ETH('0.005')) });
      expect(e.state).toBe('confirmed');
      expect(e.detail).toMatch(/at least the 0\.001 sent/);
      expect(e.detail).toMatch(/other transfers/);
      expect(e.recipient?.delta).toBe('0.0025');
    } finally { await n.close(); }
  });

  it('calls a smaller rise not_observed, and offers a benign reason without calling the proof wrong', async () => {
    const n = await node({ balances: { latest: ETH('0.0055') } });
    try {
      const e = await checkNativeTransferEffect({ ...base, rpc: n.url, before: snapshot(ETH('0.005')) });
      expect(e.state).toBe('not_observed');
      expect(e.detail).toMatch(/not the 0\.001 sent/);
      expect(e.detail).toMatch(/spent from that address/);
      expect(e.detail).toMatch(/the proof is what says what executed/);
    } finally { await n.close(); }
  });

  it('treats a balance that FELL as not_observed too, with the signed delta', async () => {
    const n = await node({ balances: { latest: ETH('0.004') } });
    try {
      const e = await checkNativeTransferEffect({ ...base, rpc: n.url, before: snapshot(ETH('0.005')) });
      expect(e.state).toBe('not_observed');
      expect(e.recipient?.delta).toBe('-0.001');
    } finally { await n.close(); }
  });

  it('is unchecked without a node of the caller\'s, and the sender\'s balance never makes it confirmed', async () => {
    const e = await checkNativeTransferEffect({ ...base, sender: { address: `0x${'ab'.repeat(20)}`, before: '0.01', after: '0.0089' } });
    expect(e.state).toBe('unchecked');
    expect(e.detail).toMatch(/no node of yours was given/);
    expect(e.detail).toMatch(/gateway cannot read another address/);
    // Supporting evidence, labelled as the gateway's report.
    expect(e.detail).toMatch(/fell by 0\.0011 ETH \(as the gateway reports it\)/);
    expect(e.sender).toMatchObject({ source: 'gateway', before: '0.01', after: '0.0089', delta: '-0.0011', at_block: null });
    expect(e.recipient).toBeUndefined();
  });

  it('says so when the sender\'s balance fell by LESS than the amount', async () => {
    const e = await checkNativeTransferEffect({ ...base, sender: { address: `0x${'ab'.repeat(20)}`, before: '0.01', after: '0.0095' } });
    expect(e.state).toBe('unchecked');
    expect(e.detail).toMatch(/fell by 0\.0005 ETH, less than 0\.001/);
  });

  it('leaves the sender note out when a reading is missing, instead of computing from nothing', async () => {
    const e = await checkNativeTransferEffect({ ...base, sender: { address: `0x${'ab'.repeat(20)}`, before: null, after: '0.0089' } });
    expect(e.detail).not.toMatch(/fell by/);
    expect(e.sender).toMatchObject({ before: null, after: '0.0089', delta: null });
  });

  it('is unreadable, never not_observed, when the node cannot be read', async () => {
    const n = await node({ status: 503, balances: {} });
    try {
      const e = await checkNativeTransferEffect({ ...base, rpc: n.url, before: snapshot(ETH('0.005')) });
      expect(e.state).toBe('unreadable');
      expect(e.detail).toMatch(/HTTP 503/);
    } finally { await n.close(); }
  });

  it('is unreadable when the node is on another chain', async () => {
    const n = await node({ chainId: 11155111, balances: { latest: ETH('0.006') } });
    try {
      const e = await checkNativeTransferEffect({ ...base, rpc: n.url, before: snapshot(ETH('0.005')) });
      expect(e.state).toBe('unreadable');
      expect(e.detail).toMatch(/11155111/);
      expect(e.detail).toMatch(/base-sepolia/);
      // No balance was taken from the wrong network.
      expect(n.seen.map((c) => c.method)).toEqual(['eth_chainId']);
    } finally { await n.close(); }
  });

  it('is unreadable when the saved balance is for another address or another chain', async () => {
    const n = await node({ balances: { latest: ETH('0.006') } });
    try {
      const wrongAddress = await checkNativeTransferEffect({ ...base, rpc: n.url, before: snapshot(ETH('0.005'), { address: OTHER }) });
      const wrongChain = await checkNativeTransferEffect({ ...base, rpc: n.url, before: snapshot(ETH('0.005'), { chain_id: 11155111 }) });
      for (const e of [wrongAddress, wrongChain]) {
        expect(e.state).toBe('unreadable');
        expect(e.detail).toMatch(/another address or chain/);
      }
    } finally { await n.close(); }
  });

  it('accepts the saved balance whatever the case of the address', async () => {
    const n = await node({ balances: { latest: ETH('0.006') } });
    try {
      const e = await checkNativeTransferEffect({ ...base, recipient: RECIPIENT.toUpperCase().replace('0X', '0x'), rpc: n.url, before: snapshot(ETH('0.005')) });
      expect(e.state).toBe('confirmed');
    } finally { await n.close(); }
  });

  it('is unreadable with no earlier balance and no block to measure from', async () => {
    const n = await node({ balances: { latest: ETH('0.006') } });
    try {
      const e = await checkNativeTransferEffect({ ...base, rpc: n.url });
      expect(e.state).toBe('unreadable');
      expect(e.detail).toMatch(/no balance from before the transfer and no block/);
    } finally { await n.close(); }
  });

  it('with no snapshot but a block, compares the balance one block earlier with the balance at the block', async () => {
    const block = 46437431;
    const n = await node({ balances: { [tag(block - 1)]: ETH('0.005'), [tag(block)]: ETH('0.006'), latest: ETH('0.009') } });
    try {
      const e = await checkNativeTransferEffect({ ...base, rpc: n.url, atBlock: block });
      expect(e.state).toBe('confirmed');
      expect(e.recipient).toMatchObject({ before: '0.005', after: '0.006', delta: '0.001', at_block: block });
      const tags = n.seen.filter((c) => c.method === 'eth_getBalance').map((c) => c.params[1]);
      expect(tags).toEqual([tag(block - 1), tag(block)]);
    } finally { await n.close(); }
  });

  it('measures a saved balance against the execution block when the node still has it', async () => {
    const block = 100;
    const n = await node({ balances: { [tag(block)]: ETH('0.006'), latest: ETH('0.02') } });
    try {
      const e = await checkNativeTransferEffect({ ...base, rpc: n.url, atBlock: block, before: snapshot(ETH('0.005')) });
      expect(e.recipient).toMatchObject({ after: '0.006', at_block: block });
      expect(e.detail).toMatch(new RegExp(`at block ${block}`));
    } finally { await n.close(); }
  });

  it('falls back to the latest balance, and says so, when the node no longer has the state at the block', async () => {
    const block = 100;
    const n = await node({ balances: { latest: ETH('0.006') } }); // block 100 is pruned: that tag answers an error
    try {
      const e = await checkNativeTransferEffect({ ...base, rpc: n.url, atBlock: block, before: snapshot(ETH('0.005')) });
      expect(e.state).toBe('confirmed');
      expect(e.recipient?.at_block).toBe('latest');
      expect(e.detail).toMatch(/now on the node/);
    } finally { await n.close(); }
  });

  it('is unreadable when neither the block nor the latest state can be read', async () => {
    const n = await node({ balances: {} });
    try {
      const e = await checkNativeTransferEffect({ ...base, rpc: n.url, atBlock: 100, before: snapshot(ETH('0.005')) });
      expect(e.state).toBe('unreadable');
      expect(e.detail).toMatch(/missing trie node/);
    } finally { await n.close(); }
  });

  it('is unchecked for a chain this client does not know, and for an amount it cannot compare', async () => {
    const unknown = await checkNativeTransferEffect({ chain: 'mystery-chain', recipient: RECIPIENT, amount: '1' });
    expect(unknown.state).toBe('unchecked');
    expect(unknown.detail).toMatch(/not a chain this client knows/);

    // More decimals than the token has: refused rather than rounded into a different amount.
    const tooFine = await checkNativeTransferEffect({ ...base, amount: '0.0000000000000000001' });
    expect(tooFine.state).toBe('unchecked');
    expect(tooFine.detail).toMatch(/not one this client can compare/);

    const junk = await checkNativeTransferEffect({ ...base, amount: 'abc' });
    expect(junk.state).toBe('unchecked');
  });

  it('never repeats the node\'s URL, and so its key, in any outcome', async () => {
    const good = await node({ balances: { latest: ETH('0.006') } });
    const wrong = await node({ chainId: 1, balances: { latest: 1n } });
    const down = await node({ status: 500, balances: {} });
    const pruned = await node({ balances: {} });
    try {
      const outcomes = [
        await checkNativeTransferEffect({ ...base, rpc: good.url, before: snapshot(ETH('0.005')) }),
        await checkNativeTransferEffect({ ...base, rpc: good.url, before: snapshot(ETH('0.0059')) }),
        await checkNativeTransferEffect({ ...base, rpc: wrong.url, before: snapshot(ETH('0.005')) }),
        await checkNativeTransferEffect({ ...base, rpc: down.url, before: snapshot(ETH('0.005')) }),
        await checkNativeTransferEffect({ ...base, rpc: pruned.url, before: snapshot(ETH('0.005')) }),
        await checkNativeTransferEffect({ ...base, rpc: `http://user:pw@127.0.0.1:1/v2/${KEY}`, before: snapshot(ETH('0.005')) }),
      ];
      // (the second rose by 0.0001, a tenth of the amount: the not_observed detail is a place a URL could leak too)
      expect(outcomes.map((o) => o.state)).toEqual(['confirmed', 'not_observed', 'unreadable', 'unreadable', 'unreadable', 'unreadable']);
      for (const o of outcomes) {
        expect(JSON.stringify(o)).not.toContain(KEY);
        expect(JSON.stringify(o)).not.toContain('/v2/');
        expect(JSON.stringify(o)).not.toContain('user:pw');
      }
    } finally { await good.close(); await wrong.close(); await down.close(); await pruned.close(); }
  });
});

describe('noEffectToCheck', () => {
  it('says nothing applies, in words, and is not mistaken for a confirmed or unchecked effect', () => {
    expect(noEffectToCheck('A call has no balance to compare.')).toEqual({ kind: 'none', state: 'not_applicable', detail: 'A call has no balance to compare.' });
  });
});
