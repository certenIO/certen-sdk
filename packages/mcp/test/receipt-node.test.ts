import { describe, it, expect, afterEach } from 'vitest';
import { ALL_TOOLS } from '../src/tools.js';
import { outputSchemaFor } from '../src/output-schemas.js';
import Ajv2020 from 'ajv/dist/2020.js';
import {
  startWorld, evmNode, serve, INTENT, RECIPIENT, GOOD_HEADER, WRONG_ROOT_HEADER, BLOCK, NODE_KEY, RISE_BALANCES, FLAT_BALANCES, completedTx,
  type AgentWorld, type NodeStub, type Stub,
} from './agent-world.js';

/**
 * A transfer receipt that can be `confirmed`: the operator's node.
 *
 * Over MCP a transfer's receipt used to stay PARTIAL for ever, because reading a recipient needs a node and this server never calls one a caller names. An
 * agent's own claim of the balance is not a reading and was deliberately not allowed to upgrade a verdict. What can be trusted is a node the OPERATOR chose,
 * read by this server: `CERTEN_RPC_URL_<CHAIN>` (e.g. `CERTEN_RPC_URL_BASE_SEPOLIA`), server configuration beside `CERTEN_ENABLED_CHAINS`, never an argument.
 *
 * With one, for the chain the caller described: the recipient is read before the execution block and at it (the chain id checked first), and, unless the
 * caller handed over a block header, the node also closes the proof's execution layer. Whatever goes wrong with the node is a named gap, never a pass, and its
 * URL (which carries a key) is never in anything returned: only its host.
 */

const worlds: AgentWorld[] = [];
const nodes: NodeStub[] = [];
const stubs: Stub[] = [];
afterEach(async () => {
  for (const w of worlds.splice(0)) await w.close();
  for (const n of nodes.splice(0)) await n.close();
  for (const s of stubs.splice(0)) await s.close();
});
const world = async (...a: Parameters<typeof startWorld>): Promise<AgentWorld> => { const w = await startWorld(...a); worlds.push(w); return w; };
const node = async (...a: Parameters<typeof evmNode>): Promise<NodeStub> => { const n = await evmNode(...a); nodes.push(n); return n; };

const TRANSFER = { chain: 'base-sepolia', to: RECIPIENT, amount: '0.001' };
const ENV_BASE = (n: { url: string }) => ({ CERTEN_RPC_URL_BASE_SEPOLIA: n.url });
const gapCodes = (b: { gaps: Array<{ code: string }> }): string[] => b.gaps.map((g) => g.code);
const outcome = (b: any) => b.proof.layers.find((l: { id: string }) => l.id === 'outcome');

describe('certen_receipt with a node the operator configured for the chain', () => {
  it('reads the recipient and closes the proof\'s execution layer: the transfer is CONFIRMED, from a node the server read', async () => {
    const w = await world();
    const n = await node({ balances: RISE_BALANCES });
    const r = await w.call('certen_receipt', { intentId: INTENT, transfer: TRANSFER }, ENV_BASE(n));
    expect(r.isError, r.text).toBe(false);
    expect(r.body.effect).toMatchObject({
      kind: 'native_transfer', state: 'confirmed', amount: '0.001', symbol: 'ETH',
      recipient: { source: 'rpc', host: n.host, before: '0.005', after: '0.006', delta: '0.001', at_block: BLOCK },
    });
    expect(outcome(r.body)).toMatchObject({ verdict: 'verified' });
    expect(r.body.proof.node_checked).toBe(true);
    expect(gapCodes(r.body)).not.toContain('EFFECT_UNCHECKED');
    expect(gapCodes(r.body)).not.toContain('NODE_NOT_CONSULTED');
    // The fixture's page chains are unbound, so this one proof capture can never be VERIFIED overall; the node closed everything the node can close.
    expect(gapCodes(r.body)).toEqual(['PROOF_LAYER_NOT_ESTABLISHED']);
    expect(r.body.verdict).toBe('partial');
    expect(n.seen).toEqual(expect.arrayContaining(['eth_chainId', 'eth_getBlockByNumber', 'eth_getBalance']));
  });

  it('never shows the node\'s URL, only its host: the key in the path is in nothing the tool returns', async () => {
    const w = await world();
    const n = await node({ balances: RISE_BALANCES });
    const r = await w.call('certen_receipt', { intentId: INTENT, transfer: TRANSFER }, ENV_BASE(n));
    expect(r.text).not.toContain(NODE_KEY);
    expect(r.text).not.toContain(n.url);
    expect(r.text).toContain(n.host);
  });

  it('a caller\'s block header still decides the proof layer; the node then reads only the recipient', async () => {
    const w = await world();
    const n = await node({ balances: RISE_BALANCES });
    const r = await w.call('certen_receipt', { intentId: INTENT, transfer: TRANSFER, header: GOOD_HEADER }, ENV_BASE(n));
    expect(outcome(r.body)).toMatchObject({ verdict: 'verified' });
    expect(r.body.effect.state).toBe('confirmed');
    expect(n.seen).not.toContain('eth_getBlockByNumber');
  });

  it('a caller\'s header that disagrees with the proof FAILS the receipt even though the node would have agreed', async () => {
    const w = await world();
    const n = await node({ balances: RISE_BALANCES });
    const r = await w.call('certen_receipt', { intentId: INTENT, transfer: TRANSFER, header: WRONG_ROOT_HEADER }, ENV_BASE(n));
    expect(r.body.verdict).toBe('failed');
    expect(r.body.effect.state).toBe('confirmed'); // what the node saw is reported as seen; the proof is what failed
    expect(n.seen).not.toContain('eth_getBlockByNumber');
  });

  it('a balance that did not rise is NOT_OBSERVED and the receipt is not verified', async () => {
    const w = await world();
    const n = await node({ balances: FLAT_BALANCES });
    const r = await w.call('certen_receipt', { intentId: INTENT, transfer: TRANSFER }, ENV_BASE(n));
    expect(r.body.effect.state).toBe('not_observed');
    expect(gapCodes(r.body)).toContain('EFFECT_NOT_OBSERVED');
    expect(r.body.verdict).not.toBe('verified');
  });

  it('a contract call with the node configured: the proof layer is closed by it, and an expected event is still judged from the proof', async () => {
    const w = await world();
    const n = await node({ balances: RISE_BALANCES });
    const r = await w.call('certen_receipt', { intentId: INTENT, call: { chain: 'base-sepolia' } }, ENV_BASE(n));
    expect(outcome(r.body)).toMatchObject({ verdict: 'verified' });
    expect(r.body.effect).toMatchObject({ kind: 'none', state: 'not_applicable' });
    expect(n.seen).not.toContain('eth_getBalance'); // a call has no balance to compare
  });
});

describe('a node that cannot be trusted never produces `confirmed`', () => {
  it('a node on another chain: the recipient is unreadable (the chain id is asked first, so no balance is read from it)', async () => {
    const w = await world();
    const n = await node({ chainId: 1, balances: RISE_BALANCES });
    const r = await w.call('certen_receipt', { intentId: INTENT, transfer: TRANSFER }, ENV_BASE(n));
    expect(r.isError, r.text).toBe(false);
    expect(r.body.effect.state).toBe('unreadable');
    expect(gapCodes(r.body)).toContain('EFFECT_UNREADABLE');
    expect(r.body.verdict).not.toBe('verified');
    expect(n.seen).not.toContain('eth_getBalance');
  });

  it('a node with no history for the block before the transfer: unreadable, never "the balance did not rise"', async () => {
    const w = await world();
    const n = await node({ balances: { latest: 6n } });
    const r = await w.call('certen_receipt', { intentId: INTENT, transfer: TRANSFER }, ENV_BASE(n));
    expect(r.body.effect.state).toBe('unreadable');
    expect(gapCodes(r.body)).toContain('EFFECT_UNREADABLE');
    expect(gapCodes(r.body)).not.toContain('EFFECT_NOT_OBSERVED');
  });

  it('a node that does not have the proof\'s block: the proof layer stays unchecked and the gap says why; the receipt is still produced', async () => {
    const w = await world();
    const n = await node({ header: 'none', balances: RISE_BALANCES });
    const r = await w.call('certen_receipt', { intentId: INTENT, transfer: TRANSFER }, ENV_BASE(n));
    expect(r.isError, r.text).toBe(false);
    expect(outcome(r.body)).toMatchObject({ verdict: 'not_checked' });
    expect(gapCodes(r.body)).toContain('NODE_NOT_CONSULTED');
    expect(r.body.verdict).not.toBe('verified');
  });

  it('a node that is down: a receipt is still produced, with the gaps named, and the URL is nowhere in it', async () => {
    const w = await world();
    const dead = await evmNode();
    const url = dead.url;
    await dead.close();
    const r = await w.call('certen_receipt', { intentId: INTENT, transfer: TRANSFER }, { CERTEN_RPC_URL_BASE_SEPOLIA: url });
    expect(r.isError, r.text).toBe(false);
    expect(r.body.effect.state).toBe('unreadable');
    expect(r.body.verdict).not.toBe('verified');
    expect(r.text).not.toContain(NODE_KEY);
  });

  it('a setting that is not a usable node URL is a gap, never a pass, and nothing is fetched from it', async () => {
    const w = await world();
    for (const bad of ['file:///etc/passwd', 'not a url', 'http://user:hunter2@127.0.0.1:1/', 'ftp://127.0.0.1/']) {
      const r = await w.call('certen_receipt', { intentId: INTENT, transfer: TRANSFER }, { CERTEN_RPC_URL_BASE_SEPOLIA: bad });
      expect(r.isError, bad).toBe(false);
      expect(r.body.effect.state, bad).toBe('unreadable');
      expect(r.body.verdict, bad).not.toBe('verified');
      expect(r.text, bad).not.toContain('hunter2');
    }
  });

  it('an empty setting is the same as none', async () => {
    const w = await world();
    const r = await w.call('certen_receipt', { intentId: INTENT, transfer: TRANSFER }, { CERTEN_RPC_URL_BASE_SEPOLIA: '  ' });
    expect(r.body.effect.state).toBe('unchecked');
    expect(gapCodes(r.body)).toContain('NODE_NOT_CONSULTED');
  });
});

describe('which chain\'s node is used', () => {
  it('only the described chain\'s: a node configured for another chain is never contacted', async () => {
    const w = await world();
    const other = await node({ balances: RISE_BALANCES });
    const r = await w.call('certen_receipt', { intentId: INTENT, transfer: TRANSFER }, { CERTEN_RPC_URL_ETHEREUM_SEPOLIA: other.url });
    expect(other.seen).toEqual([]);
    expect(r.body.effect.state).toBe('unchecked');
  });

  it('with nothing described, the chain the intent executed on (from the validators\' record) picks the node, for the PROOF layer only', async () => {
    const tx = { ...completedTx, validator: { state: 'settled', members: [{ chain_id: 84532, recorded: true }] } };
    const w = await world({ tx });
    const n = await node({ balances: RISE_BALANCES });
    const r = await w.call('certen_receipt', { intentId: INTENT }, ENV_BASE(n));
    expect(outcome(r.body)).toMatchObject({ verdict: 'verified' });
    expect(r.body.effect).toMatchObject({ kind: 'none', state: 'not_applicable' }); // no request on record: nothing to compare a balance with
    expect(n.seen).not.toContain('eth_getBalance');
  });

  it('with nothing described and nothing in the validators\' record, no node is used (it would be a guess which)', async () => {
    const w = await world();
    const n = await node({ balances: RISE_BALANCES });
    const r = await w.call('certen_receipt', { intentId: INTENT }, ENV_BASE(n));
    expect(n.seen).toEqual([]);
    expect(gapCodes(r.body)).toContain('NODE_NOT_CONSULTED');
  });

  it('a chain slug maps to its variable the way the README says: upper case, anything else an underscore', async () => {
    const w = await world();
    const n = await node({ balances: RISE_BALANCES });
    const r = await w.call('certen_receipt', { intentId: INTENT, transfer: TRANSFER }, { CERTEN_RPC_URL_base_sepolia: n.url, 'CERTEN_RPC_URL_BASE-SEPOLIA': n.url });
    expect(n.seen).toEqual([]); // wrong spellings of the name are not read
    expect(r.body.effect.state).toBe('unchecked');
  });
});

describe('a caller still cannot name a node', () => {
  it('rpc and friends are refused by name, and the operator\'s node is not contacted for a refused call', async () => {
    const w = await world();
    const n = await node({ balances: RISE_BALANCES });
    const trap = await serve((_req, res) => res.end('{}'));
    stubs.push(trap);
    const r = await w.call('certen_receipt', { intentId: INTENT, transfer: TRANSFER, rpc: trap.url }, ENV_BASE(n));
    expect(r.isError).toBe(true);
    expect(r.body.error.code).toBe('NODE_ARGUMENT_REFUSED');
    expect(trap.hits).toEqual([]);
    expect(n.seen).toEqual([]);
  });
});

describe('what a client is told', () => {
  it('certen_chains_enabled says which enabled chains have a node the server can read, so an agent knows whether to fetch a header', async () => {
    const w = await world();
    const n = await node({ balances: RISE_BALANCES });
    const r = await w.call('certen_chains_enabled', {}, ENV_BASE(n));
    expect(r.isError, r.text).toBe(false);
    const by = Object.fromEntries(r.body.enabled.map((c: { slug: string; receiptNode: boolean }) => [c.slug, c.receiptNode]));
    expect(by['base-sepolia']).toBe(true);
    expect(by['ethereum-sepolia']).toBe(false);
    expect(r.text).not.toContain(NODE_KEY);
    const validate = new Ajv2020({ strict: false, allErrors: true }).compile(outputSchemaFor('certen_chains_enabled')!);
    expect(validate(r.structured), JSON.stringify(validate.errors)).toBe(true);
  });

  it('the receipt tool\'s description explains the operator\'s node, and what an agent should do without one', () => {
    const d = ALL_TOOLS.find((t) => t.name === 'certen_receipt')!.description;
    expect(d).toMatch(/CERTEN_RPC_URL_/);
    expect(d).toMatch(/receiptNode/);
  });
});
