import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import { assembleReceipt } from '@certen.io/sdk';
import { ALL_TOOLS, READ_TOOLS, annotationsFor } from '../src/tools.js';
import { outputSchemaFor } from '../src/output-schemas.js';
import {
  startWorld, serve, INTENT, PROOF, ACCUM, RECIPIENT, EVENT, GOOD_HEADER, WRONG_ROOT_HEADER, BLOCK, component, completedTx,
  type AgentWorld, type Stub,
} from './agent-world.js';

/**
 * `certen_receipt`: everything known about one intent, in one call, with what is NOT established named.
 *
 * Before it an agent made four calls (certen_transaction_get, certen_proof_get, certen_proof_verify, certen_proof_receipt) and then compared what came back
 * with what it had asked for, by hand, on its own. The judgement is the SDK's (`buildReceipt`, `assembleReceipt`: 150 tests of their own, and the same
 * document `certen receipt` prints); what is pinned HERE is what this tool adds and the rules of this server:
 *
 * - it never calls a node you name. The execution layer is closed with a block header YOU fetched (`header`), and a header with nothing to compare is
 *   refused rather than read as a comparison that passed;
 * - it cannot read a recipient's balance, so a transfer it was told about is `unchecked` and the receipt is not VERIFIED - and it says which;
 * - PARTIAL and NO EVIDENCE are never shown as verified, and a proof service having a bad moment is not "no evidence";
 * - it signs nothing and writes nothing (the CLI keeps receipts in ~/.certen; this server keeps no state).
 *
 * Run against a real localhost gateway that serves the repo's real proof fixtures (a real Base Sepolia execution receipt and a real proof v2 document).
 */

const worlds: AgentWorld[] = [];
const extra: Stub[] = [];
afterEach(async () => {
  for (const w of worlds.splice(0)) await w.close();
  for (const s of extra.splice(0)) await s.close();
});
const world = async (...a: Parameters<typeof startWorld>): Promise<AgentWorld> => { const w = await startWorld(...a); worlds.push(w); return w; };

const gapCodes = (body: { gaps: Array<{ code: string }> }): string[] => body.gaps.map((g) => g.code);
const layer = (body: any, id: string) => body.proof.layers.find((l: { id: string }) => l.id === id);

describe('certen_receipt: a completed intent, with no header', () => {
  it('checks the proof HERE and is PARTIAL, naming the execution layer it could not close', async () => {
    const w = await world();
    const r = await w.call('certen_receipt', { intentId: INTENT });
    expect(r.isError, r.text).toBe(false);
    expect(r.body.receipt_version).toBe(1);
    expect(r.body.verdict).toBe('partial');
    expect(r.body.verdict).not.toBe('verified');
    expect(r.body.proof).toMatchObject({ checked_here: true, node_checked: false });
    expect(layer(r.body, 'outcome')).toMatchObject({ verdict: 'not_checked' });
    expect(gapCodes(r.body)).toContain('NODE_NOT_CONSULTED');
    expect(r.body.headline).toMatch(/^PARTIAL: /);
  });

  it('takes the ids from the verified bytes, and links the destination transaction on the chain\'s explorer', async () => {
    const w = await world();
    const r = await w.call('certen_receipt', { intentId: INTENT });
    expect(r.body.ids).toMatchObject({
      intent_id: INTENT, accumulate_tx_hash: ACCUM, proof_id: PROOF,
      destination_tx: component.tx_hash, destination_tx_source: 'proof', destination_block: BLOCK, destination_chain: 'base-sepolia',
    });
    expect(r.body.links.destination_tx).toBe(`https://sepolia.basescan.org/tx/${component.tx_hash}`);
    expect(r.body.stages.map((s: { id: string; state: string }) => `${s.id}:${s.state}`)).toEqual(['signed:done', 'anchored:done', 'executed:done', 'proof_verified:unknown']);
  });

  it('treats an optional argument sent as null as not provided: no header, no request on record', async () => {
    const w = await world();
    const r = await w.call('certen_receipt', { intentId: INTENT, header: null, transfer: null, call: null });
    expect(r.isError, r.text).toBe(false);
    expect(r.body.request).toBeNull();
    expect(r.body.proof.node_checked).toBe(false);
    const withNullExpect = await w.call('certen_receipt', { intentId: INTENT, call: { chain: 'base-sepolia', expect: null } });
    expect(withNullExpect.isError, withNullExpect.text).toBe(false);
    expect(withNullExpect.body.request).toMatchObject({ kind: 'contract_call' });
  });

  it('is ONE tool call for the four an agent made, and five requests behind it, each once', async () => {
    const w = await world();
    await w.call('certen_receipt', { intentId: INTENT });
    expect([...w.gateway.hits].sort()).toEqual([
      'GET /v1/chains', `GET /v1/proof/${PROOF}/bundle`, `GET /v1/proof/${PROOF}/v2`, `GET /v1/proof/tx/${ACCUM}/receipt`, `GET /v1/transaction/${INTENT}`,
    ].sort());
  });

  it('a bundle that says "verified" about itself is never read as a verdict', async () => {
    const w = await world();
    const r = await w.call('certen_receipt', { intentId: INTENT });
    // Whatever the bundle claims about itself, the receipt\'s verdict came from the layers checked here.
    expect(r.body.proof.checked_here).toBe(true);
    expect(r.body.proof.layers_verified).toBeLessThan(r.body.proof.layers_total);
  });
});

describe('certen_receipt: a header you fetched from your own node', () => {
  it('closes the execution layer with no node anywhere, and drops the node gap', async () => {
    const w = await world();
    const r = await w.call('certen_receipt', { intentId: INTENT, header: GOOD_HEADER });
    expect(layer(r.body, 'outcome')).toMatchObject({ verdict: 'verified' });
    expect(r.body.proof.node_checked).toBe(true);
    expect(gapCodes(r.body)).not.toContain('NODE_NOT_CONSULTED');
    expect(w.gateway.hits).toHaveLength(5); // a header is data, not another call
  });

  it('a header that disagrees with the proof makes the receipt FAIL, naming the header', async () => {
    const w = await world();
    const r = await w.call('certen_receipt', { intentId: INTENT, header: WRONG_ROOT_HEADER });
    expect(r.body.verdict).toBe('failed');
    expect(r.body.headline).toMatch(/disagrees/);
  });

  it('a header with nothing to compare is refused before a single request, not read as a comparison that passed', async () => {
    const w = await world();
    for (const header of [{}, { number: GOOD_HEADER.number }, { hash: GOOD_HEADER.hash }, { receiptsRoot: '0x12' }]) {
      const r = await w.call('certen_receipt', { intentId: INTENT, header });
      expect(r.isError, JSON.stringify(header)).toBe(true);
      expect(r.body.error.code).toBe('INVALID_HEADER');
    }
    expect(w.gateway.hits).toEqual([]);
  });

  it('an rpc (or url, node...) in the ARGUMENTS is refused by name and never contacted - not silently ignored - and points at the header instead', async () => {
    const w = await world();
    const node = await serve((_req, res) => res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x14a34' })));
    extra.push(node);
    for (const key of ['rpc', 'rpcUrl', 'url', 'endpoint', 'node', 'accumulateRpc']) {
      const r = await w.call('certen_receipt', { intentId: INTENT, [key]: node.url });
      expect(r.isError, key).toBe(true);
      expect(r.body.error.code, key).toBe('NODE_ARGUMENT_REFUSED');
      expect(r.body.error.message, key).toContain(`"${key}"`);
      expect(r.body.error.message, key).toMatch(/never calls a node you name/);
      expect(r.body.error.message, key).toMatch(/header/);
    }
    // The same inside the objects it takes.
    for (const args of [
      { transfer: { chain: 'base-sepolia', to: RECIPIENT, amount: '0.001', rpc: node.url } },
      { call: { chain: 'base-sepolia', rpc: node.url } },
      { call: { chain: 'base-sepolia', expect: { ...EVENT, url: node.url } } },
    ]) {
      const r = await w.call('certen_receipt', { intentId: INTENT, ...args });
      expect(r.isError, JSON.stringify(args)).toBe(true);
      expect(r.body.error.code).toBe('NODE_ARGUMENT_REFUSED');
    }
    expect(node.hits).toEqual([]);
    expect(w.gateway.hits, 'nothing was sent').toEqual([]);
    const tool = ALL_TOOLS.find((t) => t.name === 'certen_receipt')!;
    expect(Object.keys(tool.inputSchema.properties).sort()).toEqual(['call', 'header', 'intentId', 'transfer']);
    expect(tool.inputSchema.additionalProperties).toBe(false);
  });
});

describe('certen_receipt: the effect', () => {
  const TRANSFER = { chain: 'base-sepolia', to: RECIPIENT, amount: '0.001' };

  it('a transfer it was told about is UNCHECKED - it cannot read a recipient - and that keeps the receipt from being VERIFIED, even with a header', async () => {
    const w = await world();
    const r = await w.call('certen_receipt', { intentId: INTENT, header: GOOD_HEADER, transfer: TRANSFER });
    expect(r.body.request).toMatchObject({ kind: 'transfer', chain: 'base-sepolia', chain_id: 84532, to: RECIPIENT, amount: '0.001', asset: 'ETH' });
    expect(r.body.effect).toMatchObject({ kind: 'native_transfer', state: 'unchecked', amount: '0.001', symbol: 'ETH' });
    expect(gapCodes(r.body)).toContain('EFFECT_UNCHECKED');
    expect(r.body.verdict).not.toBe('verified');
    // And no node was called to find out: there is nothing in the result that came from one.
    expect(r.body.effect.recipient).toBeUndefined();
  });

  it('without a transfer or a call there is no request on record, and the effect says so instead of being silently absent', async () => {
    const w = await world();
    const r = await w.call('certen_receipt', { intentId: INTENT });
    expect(r.body.request).toBeNull();
    expect(r.body.effect).toMatchObject({ kind: 'none', state: 'not_applicable' });
    expect(r.body.effect.detail).toMatch(/no request on record/i);
  });

  it('a contract call with an expected event is judged from the proof\'s own execution receipt, and an event it does not carry is not observed', async () => {
    const w = await world();
    const found = await w.call('certen_receipt', { intentId: INTENT, header: GOOD_HEADER, call: { chain: 'base-sepolia', expect: EVENT } });
    expect(found.isError, found.text).toBe(false);
    expect(found.body.request).toMatchObject({ kind: 'contract_call', chain: 'base-sepolia' });
    expect(found.body.effect).toMatchObject({ kind: 'contract_call', state: 'confirmed', expected_event: { found: true } });
    expect(gapCodes(found.body)).not.toContain('EFFECT_UNCHECKED');

    const missing = await w.call('certen_receipt', { intentId: INTENT, header: GOOD_HEADER, call: { chain: 'base-sepolia', expect: { address: EVENT.address, topic0: `0x${'11'.repeat(32)}` } } });
    expect(missing.body.effect.state).toBe('not_observed');
    expect(missing.body.verdict).not.toBe('verified');
  });

  it('a call without an expected event has no balance to compare, and says to pass one', async () => {
    const w = await world();
    const r = await w.call('certen_receipt', { intentId: INTENT, call: { chain: 'base-sepolia' } });
    expect(r.body.effect).toMatchObject({ kind: 'none', state: 'not_applicable' });
    expect(r.body.effect.detail).toMatch(/expected event/i);
  });

  describe('is checked before any request', () => {
    const refused = async (args: Record<string, unknown>, code: string): Promise<void> => {
      const w = await world();
      const r = await w.call('certen_receipt', { intentId: INTENT, ...args });
      expect(r.isError, JSON.stringify(r.body)).toBe(true);
      expect(r.body.error.code).toBe(code);
      expect(w.gateway.hits, 'nothing was sent').toEqual([]);
    };

    it('a chain the catalogue does not know, or this server does not enable', async () => {
      await refused({ transfer: { ...TRANSFER, chain: 'base-sepoli' } }, 'UNSUPPORTED_CHAIN');
      await refused({ call: { chain: 'telcoin-adiri' } }, 'UNSUPPORTED_CHAIN');
    });
    it('a recipient that is not an address, or whose checksum is wrong', async () => {
      await refused({ transfer: { ...TRANSFER, to: 'bob' } }, 'INVALID_ADDRESS');
      await refused({ transfer: { ...TRANSFER, to: '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed'.replace('aAeb', 'AAeb') } }, 'INVALID_ADDRESS');
    });
    it('an amount that looks like wei, is not a number, or is zero', async () => {
      await refused({ transfer: { ...TRANSFER, amount: '1000000000000000' } }, 'INVALID_AMOUNT');
      await refused({ transfer: { ...TRANSFER, amount: 'lots' } }, 'INVALID_AMOUNT');
      await refused({ transfer: { ...TRANSFER, amount: '0' } }, 'INVALID_AMOUNT');
    });
    it('a transfer and a call together: an intent is one or the other', async () => {
      await refused({ transfer: TRANSFER, call: { chain: 'base-sepolia', expect: EVENT } }, 'CONFLICTING_OPTIONS');
    });
    it('an incomplete transfer', async () => {
      await refused({ transfer: { chain: 'base-sepolia', to: RECIPIENT } }, 'INVALID_TRANSFER');
      await refused({ transfer: { chain: 'base-sepolia', amount: '0.001' } }, 'INVALID_TRANSFER');
    });
    it('an event with no contract address or topic', async () => {
      await refused({ call: { chain: 'base-sepolia', expect: { address: EVENT.address } } }, 'INVALID_EXPECTATION');
    });
    it('an intent id that is not a UUID', async () => {
      await refused({ intentId: 'acc://probe.acme' }, 'INVALID_INTENT_ID');
    });
    it('an argument it does not have, instead of ignoring it (an agent would read "ignored" as "done")', async () => {
      await refused({ wait: true }, 'UNKNOWN_ARGUMENT');
      await refused({ transfer: { ...TRANSFER, memo: 'lunch' } }, 'UNKNOWN_ARGUMENT');
      await refused({ call: { chain: 'base-sepolia', expect: { ...EVENT, topic2: `0x${'11'.repeat(32)}` } } }, 'UNKNOWN_ARGUMENT');
    });
  });
});

describe('certen_receipt: an intent that is not (or will not be) complete', () => {
  it('one still in flight is PENDING with the reason, and asks the proof service nothing', async () => {
    const w = await world({ tx: { ...completedTx, status: 'anchoring', proof_id: null } });
    const r = await w.call('certen_receipt', { intentId: INTENT, header: GOOD_HEADER });
    expect(r.body).toMatchObject({ verdict: 'pending', status: { outcome: 'pending', terminal: false } });
    expect(gapCodes(r.body)).toEqual(['INTENT_NOT_TERMINAL']);
    expect(w.gateway.hits.filter((h) => h.includes('/v1/proof/'))).toEqual([]);
  });

  it('one that executed and is waiting for its proof is PENDING, naming the proof', async () => {
    const w = await world({ tx: { ...completedTx, status: 'executed', proof_id: null } });
    const r = await w.call('certen_receipt', { intentId: INTENT });
    expect(r.body.verdict).toBe('pending');
    expect(gapCodes(r.body)).toEqual(['PROOF_PENDING']);
  });

  it('one that failed is FAILED, with the gateway\'s reason in plain words', async () => {
    const w = await world({ tx: { ...completedTx, status: 'failed', proof_id: null, reason_code: 'expired' } });
    const r = await w.call('certen_receipt', { intentId: INTENT });
    expect(r.body.verdict).toBe('failed');
    expect(r.body.status).toMatchObject({ outcome: 'failed', reason_code: 'expired', terminal: true });
    expect(r.body.headline).toMatch(/^FAILED: /);
    expect(r.body.proof.verdict).toBe('not_applicable');
  });

  it('one that executed and can never be proven is UNPROVEN: nothing is verified, and it says so', async () => {
    const w = await world({ tx: { ...completedTx, status: 'completed_unproven', proof_id: null } });
    const r = await w.call('certen_receipt', { intentId: INTENT });
    expect(r.body.verdict).toBe('unproven');
    expect(r.body.headline).toMatch(/NOT PROVABLE/);
  });

  it('an unknown intent is an error the agent can read', async () => {
    const w = await world();
    const r = await w.call('certen_receipt', { intentId: '00000000-0000-4000-8000-000000000000' });
    expect(r.isError).toBe(true);
    expect(r.body.error.status).toBe(404);
  });
});

describe('certen_receipt: the proof not being there is told apart from the proof service having a bad moment', () => {
  it('a gateway that serves neither the bundle nor the proof v2 document is NO EVIDENCE, and PARTIAL, never verified', async () => {
    const w = await world({ portable: '404', bundle: '404' });
    const r = await w.call('certen_receipt', { intentId: INTENT });
    expect(r.body.proof.verdict).toBe('no_evidence');
    expect(gapCodes(r.body)).toContain('PROOF_NO_EVIDENCE');
    expect(r.body.verdict).toBe('partial');
    expect(r.body.headline).toMatch(/^NO EVIDENCE/);
  });

  it('a gateway that serves the bundle but no proof v2 document is PARTIAL: what the bundle carries is checked, and the Accumulate side is named as not established', async () => {
    const w = await world({ portable: '404' });
    const r = await w.call('certen_receipt', { intentId: INTENT, header: GOOD_HEADER });
    expect(r.body.proof.verdict).toBe('partial');
    expect(r.body.verdict).toBe('partial');
    expect(r.body.proof.evidence).toMatchObject({ found: false });
    expect(r.body.proof.not_established.length).toBeGreaterThan(0);
    expect(gapCodes(r.body)).toContain('PROOF_LAYER_NOT_ESTABLISHED');
  });

  it('a proof service that answers 5xx is UNAVAILABLE - "try again" - and not "no evidence"', async () => {
    const w = await world({ bundle: '500', portable: '500' });
    const r = await w.call('certen_receipt', { intentId: INTENT });
    expect(r.body.proof.verdict).toBe('unavailable');
    expect(gapCodes(r.body)).toContain('PROOF_NOT_FETCHED');
    expect(gapCodes(r.body)).not.toContain('PROOF_NO_EVIDENCE');
    expect(r.body.verdict).toBe('partial');
  });
});

describe('certen_receipt: it signs nothing and writes nothing', () => {
  it('leaves the home directory untouched (the CLI keeps receipts in ~/.certen/receipts; this server keeps no state)', async () => {
    const home = mkdtempSync(join(tmpdir(), 'certen-mcp-home-'));
    const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    try {
      const w = await world();
      await w.call('certen_receipt', { intentId: INTENT, header: GOOD_HEADER, transfer: { chain: 'base-sepolia', to: RECIPIENT, amount: '0.001' } });
      expect(readdirSync(home)).toEqual([]);
    } finally {
      if (saved.HOME === undefined) delete process.env.HOME; else process.env.HOME = saved.HOME;
      if (saved.USERPROFILE === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = saved.USERPROFILE;
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('only reads: every request it makes is a GET', async () => {
    const w = await world();
    await w.call('certen_receipt', { intentId: INTENT, header: GOOD_HEADER });
    expect(w.gateway.hits.every((h) => h.startsWith('GET '))).toBe(true);
  });
});

describe('certen_receipt: how a client sees it', () => {
  it('is a read-tier tool that mutates nothing, with read-only annotations and no confirmation gate', () => {
    const tool = ALL_TOOLS.find((t) => t.name === 'certen_receipt')!;
    expect(tool.tier).toBe('read');
    expect(tool.mutates).toBe(false);
    expect(READ_TOOLS).toContain(tool);
    expect(tool.inputSchema.properties).not.toHaveProperty('confirm');
    expect(annotationsFor(tool)).toMatchObject({ readOnlyHint: true, openWorldHint: true });
    expect(tool.inputSchema.required).toEqual(['intentId']);
  });

  it('declares an outputSchema that every kind of receipt conforms to', async () => {
    const validate = new Ajv2020({ strict: false, allErrors: true }).compile(outputSchemaFor('certen_receipt')!);
    const transfer = { chain: 'base-sepolia', to: RECIPIENT, amount: '0.001' };
    const seen = new Set<string>();
    const cases: Array<[World_, Record<string, unknown>]> = [
      [{}, {}],
      [{}, { header: GOOD_HEADER }],
      [{}, { header: GOOD_HEADER, transfer }],
      [{}, { header: GOOD_HEADER, call: { chain: 'base-sepolia', expect: EVENT } }],
      [{}, { header: WRONG_ROOT_HEADER }],
      [{ tx: { ...completedTx, status: 'anchoring', proof_id: null } }, {}],
      [{ tx: { ...completedTx, status: 'executed', proof_id: null } }, {}],
      [{ tx: { ...completedTx, status: 'failed', proof_id: null, reason_code: 'expired' } }, {}],
      [{ tx: { ...completedTx, status: 'completed_unproven', proof_id: null } }, {}],
      [{ tx: { ...completedTx, status: 'a_status_nobody_has_heard_of', proof_id: null } }, {}],
      [{ portable: '404' }, {}],
      [{ bundle: '500', portable: '500' }, {}],
    ];
    for (const [w_, args] of cases) {
      const w = await world(w_);
      const r = await w.call('certen_receipt', { intentId: INTENT, ...args });
      expect(r.isError, r.text).toBe(false);
      expect(validate(r.structured), `${JSON.stringify(args)} ${JSON.stringify(w_)}: ${JSON.stringify(validate.errors)}`).toBe(true);
      seen.add(r.structured.verdict);
    }
    // A verified receipt cannot be reached with the repo's one proof capture (its page chains are unbound), so it is assembled from constructed
    // inputs: the shape is what is pinned.
    const verified = assembleReceipt({
      intentId: INTENT, transaction: completedTx as never,
      proof: {
        verification: {
          overall: 'verified', evidenceFound: true, layers: [{ id: 'L1', title: 'Genesis pin', verdict: 'verified' }],
          execution: { ok: true, txHash: component.tx_hash, blockNumber: BLOCK, chainId: '84532' }, headerCheck: { ok: true },
        },
        nodeConsulted: true,
      },
    });
    expect(verified.verdict).toBe('verified');
    expect(validate(verified), JSON.stringify(validate.errors)).toBe(true);
    seen.add(verified.verdict);
    expect([...seen].sort()).toEqual(['failed', 'partial', 'pending', 'unproven', 'verified']);
  });

  it('says in its description what a client must not infer: PARTIAL and NO EVIDENCE are not verified, an unchecked effect, and that it calls no node you name', () => {
    const d = ALL_TOOLS.find((t) => t.name === 'certen_receipt')!.description;
    expect(d).toMatch(/PARTIAL/);
    expect(d).toMatch(/NO EVIDENCE/);
    expect(d).toMatch(/unchecked/);
    expect(d).toMatch(/header/);
    expect(d).toMatch(/your own node/);
    expect(d).toMatch(/keeps no state|writes nothing/);
    expect(d).toMatch(/certen_execute_wait/);
  });
});

type World_ = NonNullable<Parameters<typeof startWorld>[0]>;
