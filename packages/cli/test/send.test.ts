import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { envelope, type RunResult } from './helpers/run-cli.js';
import {
  sendEnv, savedReceipts, readSavedReceipt, RECIPIENT, ABSTRACT_ACCOUNT, INTENT_ID, IDENTITY_ID, ADI, type SendEnv,
} from './helpers/send-env.js';

/**
 * `certen send`, end to end: the REAL built CLI as a subprocess, a throwaway HOME, and the in-process fake gateway.
 *
 * The fake builds the signing data the way the bridge does, so `checkIntentSigning` has something real to rebuild and match: a test that
 * passes here proves the CLI signed what it was asked to sign, not merely that it signed. It also records EVERY request, so each case can
 * assert what did NOT reach the gateway (a refusal must cost a message, not a round trip), and what the caller's own node was asked.
 *
 * The proof the fake serves is the repo's conformance capture, whose pages' chain histories were not captured. `proof verify` gives it an honest
 * PARTIAL, and so does `send`: that is why a successful send exits 4 here, and why "VERIFIED" is exercised in the unit tests (receipt.test.ts,
 * receipt-render.test.ts) and not in a subprocess. An honest PARTIAL naming the missing layers is the product working, not failing.
 */

type Req = { method: string; path: string; status: number; unrouted: boolean };

const SEND = ['send', '0.0001', 'ETH', '--to', RECIPIENT];
const isIntentPost = (r: Req): boolean => r.method === 'POST' && r.path === '/v1/transaction';
const isSignaturePost = (r: Req): boolean => r.method === 'POST' && /^\/v1\/transaction\/[^/]+\/signature$/.test(r.path);
const intentPosts = (reqs: Req[]): Req[] => reqs.filter(isIntentPost);
const signaturePosts = (reqs: Req[]): Req[] => reqs.filter(isSignaturePost);
const intentGets = (reqs: Req[]): Req[] => reqs.filter((r) => r.method === 'GET' && r.path === `/v1/transaction/${INTENT_ID}`);

/** A request nothing in the fake answers is a gap in the fake, not a fact about the gateway: no case may rely on one. */
function expectRouted(reqs: Req[]): void {
  expect(reqs.filter((r) => r.unrouted), 'requests the fake gateway has no route for').toEqual([]);
}

/** Exactly one line on stdout, which parses: nothing human leaked onto the machine channel. */
function oneLine(r: RunResult): Record<string, any> {
  const lines = r.stdout.split('\n').filter((l) => l.trim().length > 0);
  expect(lines, `stdout was:\n${r.stdout}\n--- stderr ---\n${r.stderr}`).toHaveLength(1);
  return JSON.parse(lines[0]!);
}

const sendJson = (e: SendEnv, extra: string[] = [], opts: { env?: Record<string, string> } = {}): Promise<RunResult> =>
  e.run(['--json', ...SEND, ...extra], opts);

let env: SendEnv | undefined;
afterEach(async () => { await env?.close(); env = undefined; });

// ── the whole flow, once, asserted from every side ──────────────────────────────────────────────────

describe('certen send --json --wait: derives everything, signs what it was asked to, waits, and writes a receipt', () => {
  let e: SendEnv;
  let r: RunResult;
  let reqs: Req[];
  let nodeCalls: Array<{ method: string; params: unknown[] }>;
  let intent: ReturnType<SendEnv['gateway']['lastIntent']>;
  let env1: Record<string, any>;
  let receipt: Record<string, any>;

  beforeAll(async () => {
    e = await sendEnv();
    r = await sendJson(e, ['--wait']);
    reqs = e.gateway.take();
    nodeCalls = e.gateway.takeNodeCalls();
    intent = e.gateway.lastIntent();
    env1 = oneLine(r);
    receipt = env1.data?.receipt;
  });
  afterAll(async () => { await e.close(); });

  it('exits 4 with ONE envelope on stdout: the proof fixture has unbound page chains, so an honest PARTIAL, never a quiet pass', () => {
    expect(r.code, r.stderr).toBe(4);
    expect(env1.ok).toBe(true);
    expect(Object.keys(env1.data).sort()).toEqual(['receipt', 'saved_to']);
    expect(receipt.verdict).toBe('partial');
    expect(receipt.headline).toMatch(/^PARTIAL: /);
    // The human lines are on stderr, not on the machine channel.
    expect(r.stderr).toContain('The signature authorises exactly this');
    expect(r.stdout).not.toContain('Sign with');
  });

  it('records what was asked: the identity, the abstract account it derived, the chain, the amount and the asset', () => {
    expect(receipt.receipt_version).toBe(1);
    expect(receipt.kind).toBe('transfer');
    expect(receipt.intent_id).toBe(INTENT_ID);
    expect(receipt.request).toEqual({
      kind: 'transfer', chain: 'base-sepolia', chain_id: 84532, identity_id: IDENTITY_ID, adi_url: ADI, from: ABSTRACT_ACCOUNT, to: RECIPIENT,
      amount: '0.0001', asset: 'ETH', contract_call: null,
    });
    expect(receipt.signed_with).toEqual({ key: 'dev', public_key_hash: e.keyHash });
    expect(receipt.gateway).toBe(e.gateway.url);
  });

  it('keeps the ids: the Accumulate transaction, the destination transaction FROM THE PROOF, the proof, and an explorer link', () => {
    expect(receipt.ids.accumulate_tx_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(receipt.ids.accumulate_tx).toMatch(/^acc:\/\/[0-9a-f]{64}@journey-probe\.acme\/data$/);
    expect(receipt.ids.destination_tx).toBe(e.gateway.execution.txHash);
    expect(receipt.ids.destination_tx_source).toBe('proof');
    expect(receipt.ids.destination_chain).toBe('base-sepolia');
    expect(receipt.ids.destination_block).toBe(e.gateway.execution.blockNumber);
    expect(receipt.ids.proof_id).toBe('11111111-2222-4333-8444-555555555555');
    expect(receipt.links.destination_tx).toBe(`https://sepolia.basescan.org/tx/${e.gateway.execution.txHash}`);
  });

  it('shows four stages, the last one unknown (not done) because the proof is only partly established', () => {
    expect(receipt.stages.map((s: any) => [s.id, s.state])).toEqual([
      ['signed', 'done'], ['anchored', 'done'], ['executed', 'done'], ['proof_verified', 'unknown'],
    ]);
    expect(receipt.stages[2].label).toBe('executed on base-sepolia');
  });

  it('names the layers it could not establish, and does not call a PARTIAL proof verified', () => {
    const layer = (id: string) => receipt.proof.layers.find((l: any) => l.id === id);
    expect(layer('G1_chains').verdict).toBe('not_checked');
    expect(layer('outcome').verdict).toBe('not_checked');
    expect(layer('L1').verdict).toBe('verified');
    expect(receipt.proof).toMatchObject({ verdict: 'partial', checked_here: true, node_checked: false });
    expect(receipt.proof.not_established.map((l: any) => l.id)).toEqual(['G1_chains', 'outcome']);
    expect(receipt.proof.layers_verified).toBeLessThan(receipt.proof.layers_total);
  });

  it('lists each gap once: the unbound chains, the node never consulted, the recipient never checked', () => {
    const codes = receipt.gaps.map((g: any) => g.code);
    expect(codes).toEqual(['PROOF_LAYER_NOT_ESTABLISHED', 'NODE_NOT_CONSULTED', 'EFFECT_UNCHECKED']);
    expect(receipt.gaps[0].text).toContain('G1_chains');
    // The execution layer's own reason is the node gap, not a second line saying the same thing.
    expect(receipt.gaps.filter((g: any) => g.code === 'PROOF_LAYER_NOT_ESTABLISHED')).toHaveLength(1);
    expect(receipt.effect.state).toBe('unchecked');
    expect(receipt.effect.detail).toMatch(/no node of yours was given/);
  });

  it('saves the receipt it printed, byte for byte, where it says it did', () => {
    expect(env1.data.saved_to).toBe(join(e.home, '.certen', 'receipts', `${INTENT_ID}.json`));
    expect(savedReceipts(e.home)).toEqual([`${INTENT_ID}.json`]);
    expect(readSavedReceipt(e.home)).toEqual(receipt);
  });

  it('opens exactly one intent and submits exactly one signature, in that order, for what was asked and no more', () => {
    expect(intentPosts(reqs)).toHaveLength(1);
    expect(signaturePosts(reqs)).toHaveLength(1);
    expect(reqs.findIndex(isIntentPost)).toBeLessThan(reqs.findIndex(isSignaturePost));
    const sent = intent.body!.intent;
    expect(sent).toMatchObject({ toAddress: RECIPIENT, amount: '0.0001', fromAddress: ABSTRACT_ACCOUNT, adiUrl: ADI, toChain: 'base-sepolia', fromChain: 'accumulate' });
    // The native token is implied by the chain: naming it would be a second thing to disagree about.
    expect(sent).not.toHaveProperty('tokenSymbol');
    expect(intent.body!.identity_id).toBe(IDENTITY_ID);
    expectRouted(reqs);
  });

  it('checks readiness before the intent exists, and asks the caller\'s node nothing when none was given', () => {
    const chains = reqs.findIndex((x) => x.path === '/v1/chains');
    const identity = reqs.findIndex((x) => x.path === `/v1/identity/${IDENTITY_ID}`);
    const keyPage = reqs.findIndex((x) => x.path === '/acc/v3');
    const billing = reqs.findIndex((x) => x.path === '/v1/billing/balance');
    const open = reqs.findIndex(isIntentPost);
    for (const read of [chains, identity, keyPage, billing]) {
      expect(read).toBeGreaterThanOrEqual(0);
      expect(read).toBeLessThan(open);
    }
    expect(reqs.some((x) => x.path === '/rpc')).toBe(false);
    expect(nodeCalls).toEqual([]);
  });

  it('echoes what came from context BEFORE the card, and shows the card BEFORE it says it signed', () => {
    const at = (s: string): number => r.stderr.indexOf(s);
    expect(r.stderr).toContain('using identity acc://journey-probe.acme (the only identity recorded on this machine)');
    expect(r.stderr).toContain('using chain base-sepolia (the only chain this identity is linked to)');
    expect(r.stderr).toContain('using key dev (the only signing key on this machine)');
    expect(at('using identity')).toBeLessThan(at('Send 0.0001 ETH on base-sepolia'));
    expect(at('using key')).toBeLessThan(at('Send 0.0001 ETH on base-sepolia'));
    expect(at('Send 0.0001 ETH on base-sepolia')).toBeLessThan(at('You are about to sign: cross-chain intent'));
    expect(at('You are about to sign: cross-chain intent')).toBeLessThan(at('The signature authorises exactly this'));
    expect(at('The signature authorises exactly this')).toBeLessThan(at(`Signed. Intent ${INTENT_ID}.`));
  });

  it('puts the recipient in full, the price-book fee as an estimate, and the values it took from context on the card', () => {
    // The labels are padded to the widest one on the card (the context row is wider than `to`), so match the columns, not the spaces.
    expect(r.stderr).toMatch(new RegExp(`\\n\\s+to\\s+${RECIPIENT}\\n`));
    expect(r.stderr).toMatch(new RegExp(`\\n\\s+from\\s+${ADI}  ->  ${ABSTRACT_ACCOUNT} \\(abstract account on base-sepolia\\)\\n`));
    expect(r.stderr).toMatch(/fee\s+about \$0\.040000 CERTEN fee · gas up to about 0\.0001 ETH \(an estimate, not a quote; gas is priced when it executes\)/);
    expect(r.stderr).toMatch(/context\s+not typed by you: identity acc:\/\/journey-probe\.acme \(the only identity recorded on this machine\); chain base-sepolia/);
    expect(r.stderr).toContain('written to        acc://journey-probe.acme/data');
  });
});

describe('certen send (human mode)', () => {
  it('prints the receipt on stdout and the card on stderr, and names what to do next', async () => {
    env = await sendEnv();
    const r = await env.run([...SEND, '--yes']);
    const reqs = env.gateway.take();
    expect(r.code, r.stderr).toBe(4);
    // stdout is the answer: the stage line, the ids, the proof's verdict (never "VERIFIED" for a PARTIAL), what is not established.
    expect(r.stdout).toContain('[done] signed  [done] anchored on Accumulate  [done] executed on base-sepolia  [ ?? ] proof verified locally');
    expect(r.stdout).toContain(`Receipt   intent          ${INTENT_ID}`);
    expect(r.stdout).toContain('(from the verified proof)');
    expect(r.stdout).toMatch(/Proof     PARTIAL: /);
    expect(r.stdout).not.toMatch(/VERIFIED/);
    expect(r.stdout).toContain('Not established:');
    expect(r.stdout).toContain('Saved     ');
    expect(r.stdout).toContain(join(env.home, '.certen', 'receipts', `${INTENT_ID}.json`));
    expect(r.stdout).toContain(`Next: certen receipt ${INTENT_ID} --rpc <a node you trust on base-sepolia>`);
    // The card and the question are not the answer; none of it is on stdout. (Progress lines are ordinary human output, so they are.)
    expect(r.stdout).not.toContain('You are about to sign');
    expect(r.stdout).not.toContain('Sign with');
    expect(r.stderr).toContain('You are about to sign: cross-chain intent');
    expect(r.stdout).toContain('Waiting for the proof cycle');
    expect(intentPosts(reqs)).toHaveLength(1);
    expect(signaturePosts(reqs)).toHaveLength(1);
  });

  it('says exactly what the signature authorises, with the recipient in full and the value in both units', async () => {
    env = await sendEnv({ gateway: { statuses: ['anchoring'] } });
    const r = await env.run([...SEND, '--yes', '--no-wait']);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stderr).toContain(`plain transfer to ${RECIPIENT}, value 100000000000000 wei`);
    expect(r.stderr).toContain('Send 0.0001 ETH on base-sepolia');
  });
});

// ── the caller's own node ───────────────────────────────────────────────────────────────────────────

describe('certen send --rpc: the caller\'s own node closes the execution layer and reads the recipient', () => {
  it('takes the recipient\'s balance BEFORE the intent exists, and compares the block header and the rise AFTER', async () => {
    env = await sendEnv({ gateway: { debitSender: true } });
    const r = await sendJson(env, ['--wait', '--rpc', env.gateway.rpcUrl]);
    const reqs = env.gateway.take();
    const node = env.gateway.takeNodeCalls();
    const e1 = oneLine(r);
    const receipt = e1.data.receipt;
    expect(r.code, r.stderr).toBe(4);

    // Before the value moves: the node was asked its chain, then the balance, and only then was an intent opened.
    expect(node[0]).toEqual({ method: 'eth_chainId', params: [] });
    expect(node[1]).toEqual({ method: 'eth_getBalance', params: [RECIPIENT, 'latest'] });
    expect(reqs.findIndex((x) => x.path === '/rpc')).toBeLessThan(reqs.findIndex(isIntentPost));
    expect(receipt.recipient_snapshot).toMatchObject({ address: RECIPIENT, wei: '0', chain_id: 84532, host: new URL(env.gateway.rpcUrl).host });

    // After: the header of the block the proof names, and the rise.
    expect(node.map((c) => c.method)).toContain('eth_getBlockByNumber');
    expect(receipt.proof.node_checked).toBe(true);
    expect(receipt.proof.layers.find((l: any) => l.id === 'outcome').verdict).toBe('verified');
    expect(receipt.effect.state).toBe('confirmed');
    expect(receipt.effect.recipient).toMatchObject({ source: 'rpc', address: RECIPIENT, before: '0', after: '0.0001', delta: '0.0001', symbol: 'ETH' });
    expect(receipt.effect.detail).toMatch(/rose by exactly 0\.0001 ETH/);
    // The sender's side is supporting evidence from the gateway, and says so.
    expect(receipt.effect.sender).toMatchObject({ source: 'gateway', address: ABSTRACT_ACCOUNT, before: '0.001', after: '0.0009', delta: '-0.0001' });

    // Still PARTIAL, for the one reason that is left: the fixture's page chains. No node gap, no effect gap.
    expect(receipt.gaps.map((g: any) => g.code)).toEqual(['PROOF_LAYER_NOT_ESTABLISHED']);
    expect(receipt.gaps[0].text).toContain('G1_chains');
    expect(receipt.verdict).toBe('partial');
  });

  it('never writes the node\'s URL into the receipt or the envelope: only its host', async () => {
    env = await sendEnv();
    const url = `${env.gateway.rpcUrl}`;
    const r = await sendJson(env, ['--wait', '--rpc', url]);
    expect(r.code, r.stderr).toBe(4);
    const file = readFileSync(join(env.home, '.certen', 'receipts', `${INTENT_ID}.json`), 'utf8');
    for (const text of [file, r.stdout, r.stderr]) expect(text).not.toContain(url);
    expect(file).toContain(new URL(url).host);
  });

  it('CERTEN_RPC_URL does what --rpc does', async () => {
    env = await sendEnv();
    const r = await sendJson(env, ['--wait'], { env: { CERTEN_RPC_URL: env.gateway.rpcUrl } });
    const receipt = oneLine(r).data.receipt;
    expect(r.code, r.stderr).toBe(4);
    expect(receipt.proof.node_checked).toBe(true);
    expect(receipt.effect.state).toBe('confirmed');
    expect(receipt.recipient_snapshot.wei).toBe('0');
  });

  it('refuses a node on the wrong chain BEFORE signing: exit 1, nothing opened, no receipt', async () => {
    env = await sendEnv({ gateway: { fault: 'rpc-wrong-chain' } });
    const r = await sendJson(env, ['--wait', '--rpc', env.gateway.rpcUrl]);
    const reqs = env.gateway.take();
    expect(r.code).toBe(1);
    const e1 = oneLine(r);
    expect(e1.ok).toBe(false);
    expect(e1.error.code).toBe('EVM_RPC_WRONG_CHAIN');
    expect(e1.error.message).toMatch(/Not sending: the node you gave/);
    expect(e1.error.message).toMatch(/Nothing was signed or charged/);
    expect(intentPosts(reqs)).toHaveLength(0);
    expect(signaturePosts(reqs)).toHaveLength(0);
    expect(savedReceipts(env.home)).toEqual([]);
  });

  it('refuses a node that cannot be reached BEFORE signing, and never repeats a key that is in its URL', async () => {
    env = await sendEnv();
    // Port 9 (discard) refuses at once and locally. The path stands for the API key a hosted node puts there.
    const r = await sendJson(env, ['--wait', '--rpc', 'http://127.0.0.1:9/v2/SUPERSECRETAPIKEY']);
    const reqs = env.gateway.take();
    expect(r.code).toBe(1);
    const e1 = oneLine(r);
    expect(e1.error.code).toBe('EVM_RPC_UNREADABLE');
    expect(JSON.stringify(e1)).not.toContain('SUPERSECRETAPIKEY');
    expect(r.stderr).not.toContain('SUPERSECRETAPIKEY');
    expect(e1.error.message).toContain('127.0.0.1:9');
    expect(intentPosts(reqs)).toHaveLength(0);
    expect(savedReceipts(env.home)).toEqual([]);
  });

  it('a node that says the value never arrived makes the effect NOT_OBSERVED, and the receipt says so', async () => {
    env = await sendEnv({ gateway: { fault: 'value-never-arrives' } });
    const r = await sendJson(env, ['--wait', '--rpc', env.gateway.rpcUrl]);
    const receipt = oneLine(r).data.receipt;
    expect(r.code, r.stderr).toBe(4);
    expect(receipt.effect.state).toBe('not_observed');
    expect(receipt.effect.recipient).toMatchObject({ before: '0', after: '0', delta: '0' });
    expect(receipt.effect.detail).toMatch(/not the 0\.0001 sent/);
    expect(receipt.gaps.map((g: any) => g.code)).toContain('EFFECT_NOT_OBSERVED');
    expect(receipt.verdict).toBe('partial');
  });

  it('refuses a username and password in the URL, a scheme that is not http(s) and a non-URL, as a usage error before any request, never repeating the URL', async () => {
    env = await sendEnv();
    for (const bad of ['http://user:hunter2@127.0.0.1:1/x', 'ftp://127.0.0.1/x', 'not a url']) {
      const r = await sendJson(env, ['--rpc', bad]);
      expect(r.code, bad).toBe(2);
      const e1 = oneLine(r);
      expect(e1.error.code, bad).toBe('INVALID_RPC');
      expect(e1.error.message).toMatch(/^--rpc is not usable: /);
      for (const secret of ['hunter2', 'user:', bad]) expect(e1.error.message).not.toContain(secret);
      expect(r.stderr).not.toContain('hunter2');
      expect(env.gateway.take(), bad).toEqual([]);
    }
  });

  it('CERTEN_RPC_URL is held to the same rule, and the refusal names the variable', async () => {
    env = await sendEnv();
    const r = await sendJson(env, [], { env: { CERTEN_RPC_URL: 'http://user:hunter2@127.0.0.1:1/x' } });
    expect(r.code).toBe(2);
    const e1 = oneLine(r);
    expect(e1.error.code).toBe('INVALID_RPC');
    expect(e1.error.message).toMatch(/^CERTEN_RPC_URL is not usable: /);
    expect(e1.error.message).not.toContain('hunter2');
    expect(env.gateway.take()).toEqual([]);
  });
});

// ── a refusal costs a message, not a round trip ─────────────────────────────────────────────────────

describe('certen send refuses before any request', () => {
  // One machine serves every refusal that needs the default one: a refusal changes nothing, so sharing it cannot hide a request (each case
  // asserts the gateway saw NOTHING). A case that needs a different machine (no key, two keys) makes its own.
  let shared: SendEnv;
  beforeAll(async () => { shared = await sendEnv(); });
  afterAll(async () => { await shared.close(); });

  const refused = async (args: string[], code: string, opts: { env?: Record<string, string>; envOptions?: Parameters<typeof sendEnv>[0] } = {}): Promise<RunResult> => {
    const own = opts.envOptions ? await sendEnv(opts.envOptions) : undefined;
    const e = own ?? shared;
    try {
      const r = await e.run(args, { env: opts.env });
      expect(r.code, r.stderr).toBe(2);
      expect(envelope(r).error!.code).toBe(code);
      expect(e.gateway.take(), 'a refusal must not reach the gateway').toEqual([]);
      expect(savedReceipts(e.home)).toEqual([]);
      return r;
    } finally {
      await own?.close();
    }
  };

  it('an amount that looks like wei, with the hint', async () => {
    const r = await refused(['--json', 'send', '1000000000000000000', 'ETH', '--to', RECIPIENT], 'INVALID_AMOUNT');
    expect(envelope(r).error!.message).toMatch(/looks like wei/);
  });

  it.each(['abc', '1e3', '0x10', '1,5'])('an amount that is not a decimal: %s', async (amount) => {
    await refused(['--json', 'send', amount, 'ETH', '--to', RECIPIENT], 'INVALID_AMOUNT');
  });

  it.each(['0', '0.000', '00.0'])('an amount that is zero: %s', async (amount) => {
    const r = await refused(['--json', 'send', amount, 'ETH', '--to', RECIPIENT], 'INVALID_AMOUNT');
    expect(envelope(r).error!.message).toBe('The amount must be greater than zero.');
  });

  it('a recipient that is not an address', async () => {
    const r = await refused(['--json', 'send', '0.0001', 'ETH', '--to', 'vitalik.eth'], 'INVALID_ADDRESS');
    expect(envelope(r).error!.message).toMatch(/^--to: .*is not an EVM address\. Expected 0x followed by 40 hex characters\./);
  });

  it('a mixed-case recipient whose checksum fails, naming the correct capitalisation and never correcting it silently', async () => {
    // One letter's case flipped from the EIP-55 test vector 0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed.
    const r = await refused(['--json', 'send', '0.0001', 'ETH', '--to', '0x5AAeb6053F3E94C9b9A09f33669435E7Ef1BeAed'], 'INVALID_ADDRESS');
    const message = envelope(r).error!.message as string;
    expect(message).toMatch(/capital letters that do not match its checksum \(EIP-55\)/);
    expect(message).toContain('The correctly capitalised address would be 0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed');
  });

  it('an asset the chain does not move: names the native symbol and the command that does work', async () => {
    const r = await refused(['--json', 'send', '0.0001', 'USDC', '--to', RECIPIENT], 'UNSUPPORTED_ASSET');
    const message = envelope(r).error!.message as string;
    expect(message).toContain('base-sepolia moves ETH, and you asked to send USDC');
    expect(message).toContain('native token only');
    expect(message).toContain('certen call');
    expect(message).toContain(`certen send 0.0001 ETH --to ${RECIPIENT}`);
  });

  it('a chain this client does not know the native token of (a typed chain is not a mainnet-default refusal)', async () => {
    const r = await refused(['--json', 'send', '0.0001', 'ETH', '--to', RECIPIENT, '--chain', 'ethereum'], 'UNSUPPORTED_CHAIN', { env: { CERTEN_ALLOW_ANY_CHAIN: '1' } });
    expect(envelope(r).error!.code).not.toBe('MAINNET_DEFAULT_REFUSED');
    expect(envelope(r).error!.message).toMatch(/not a chain this client knows the native token of/);
  });

  it('a mainnet name is never swapped for a testnet, even from a default', async () => {
    const r = await refused(['--json', ...SEND], 'UNSUPPORTED_CHAIN', { env: { CERTEN_CHAIN: 'ethereum' } });
    expect(envelope(r).error!.message).toMatch(/ethereum/);
  });

  it('a chain that is not a known testnet never comes from a default on a command that moves value', async () => {
    const r = await refused(['--json', ...SEND], 'MAINNET_DEFAULT_REFUSED', { env: { CERTEN_CHAIN: 'ethereum', CERTEN_ALLOW_ANY_CHAIN: '1' } });
    expect(envelope(r).error!.message).toMatch(/comes from CERTEN_CHAIN, and it is not a known testnet/);
    expect(envelope(r).error!.message).toMatch(/--chain ethereum/);
  });

  it('nobody to confirm it: no --yes, no --json and no terminal, before the passphrase is read', async () => {
    env = await sendEnv({ passphrase: 'correct horse' });
    // The passphrase is deliberately missing: if the refusal came after the unlock, this would fail with PASSPHRASE_REQUIRED instead.
    const r = await env.run(SEND, { env: { CERTEN_KEY_PASSPHRASE: '' } });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('Error [CONFIRMATION_REQUIRED]');
    expect(r.stderr).toMatch(/there is no one at a terminal to confirm it/);
    expect(r.stderr).toMatch(/--yes skips the question, never the check/);
    expect(r.stdout).toBe('');
    expect(env.gateway.take()).toEqual([]);
    expect(savedReceipts(env.home)).toEqual([]);
  });

  it('no signing key on the machine', async () => {
    const r = await refused(['--json', ...SEND], 'MISSING_SIGNING_KEY', { envOptions: { noKey: true } });
    expect(envelope(r).error!.message).toMatch(/Nothing would sign this\. Pass --sign-with <key>.*certen keys generate --name dev/);
  });

  it('two keys and none chosen: a question that lists them, never a guess', async () => {
    const r = await refused(['--json', ...SEND], 'MISSING_SIGNING_KEY', { envOptions: { extraKeys: ['alt'] } });
    const message = envelope(r).error!.message as string;
    expect(message).toMatch(/Which key signs this\?/);
    expect(message).toContain('dev');
    expect(message).toContain('alt');
    expect(message).toMatch(/certen use key <name>/);
  });

  it('a bad --expires-in, a bad --timeout and a bad --poll-interval', async () => {
    await refused(['--json', ...SEND, '--expires-in', 'banana'], 'INVALID_EXPIRES_IN');
    await refused(['--json', ...SEND, '--wait', '--timeout', '6x'], 'INVALID_TIMEOUT');
    await refused(['--json', ...SEND, '--wait', '--poll-interval', 'soon'], 'INVALID_POLL_INTERVAL');
  });

  it('a gas reserve and an Accumulate URL that are malformed', async () => {
    await refused(['--json', ...SEND, '--gas-reserve', 'lots'], 'INVALID_AMOUNT');
    await refused(['--json', ...SEND, '--accumulate-rpc', 'ftp://x'], 'INVALID_ACCUMULATE_RPC');
  });

  it('accepts the native symbol in any case, and an address that is all lower case (it carries no checksum to fail)', async () => {
    env = await sendEnv();
    const r = await env.run(['--json', 'send', '0.0001', 'eth', '--to', RECIPIENT, '--dry-run']);
    expect(r.code, r.stderr).toBe(0);
    expect(oneLine(r).data.request.asset).toBe('ETH');
  });

  it('accepts a correctly checksummed address', async () => {
    env = await sendEnv();
    const r = await env.run(['--json', 'send', '0.0001', 'ETH', '--to', '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed', '--dry-run']);
    expect(r.code, r.stderr).toBe(0);
    expect(oneLine(r).data.request.to).toBe('0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed');
  });
});

// ── readiness runs before anything is unlocked ──────────────────────────────────────────────────────

describe('certen send checks readiness BEFORE the passphrase', () => {
  const blocked = (r: RunResult): Record<string, any> => {
    expect(r.code, r.stderr).toBe(1);
    const e1 = oneLine(r);
    expect(e1.ok).toBe(false);
    expect(e1.error.code).toBe('NOT_READY');
    expect(e1.error.message).toMatch(/Nothing was signed or charged\.$/);
    return e1.error;
  };

  it('an unfunded account is refused with the gas as the first blocker, and nothing is opened or saved', async () => {
    env = await sendEnv({ funded: false });
    const r = await sendJson(env, ['--wait']);
    const reqs = env.gateway.take();
    const error = blocked(r);
    expect(error.details.readiness.first_blocker).toMatchObject({ name: 'gas', status: 'fail', code: 'ABSTRACT_ACCOUNT_UNFUNDED' });
    expect(error.details.readiness.state).toBe('blocked');
    expect(error.message).toMatch(/^Not sending: gas is failing on base-sepolia\. /);
    expect(intentPosts(reqs)).toHaveLength(0);
    expect(signaturePosts(reqs)).toHaveLength(0);
    expect(savedReceipts(env.home)).toEqual([]);
    // The card is not shown for a send that will not happen.
    expect(r.stderr).not.toContain('You are about to sign');
  });

  it('is refused for the gas even when the key is encrypted and its passphrase was never given: the passphrase is never asked for in order to fail', async () => {
    env = await sendEnv({ funded: false, passphrase: 'correct horse' });
    const r = await sendJson(env, ['--wait'], { env: { CERTEN_KEY_PASSPHRASE: '' } });
    const error = blocked(r);
    expect(error.details.readiness.first_blocker.code).toBe('ABSTRACT_ACCOUNT_UNFUNDED');
    expect(r.stderr).not.toMatch(/PASSPHRASE_REQUIRED|passphrase/i);
  });

  it('--force excuses the gas checks and nothing else: it says so, and sends', async () => {
    env = await sendEnv({ funded: false });
    const r = await sendJson(env, ['--wait', '--force']);
    const reqs = env.gateway.take();
    expect(r.code, r.stderr).toBe(4);
    expect(r.stderr).toMatch(/--force: sending although gas is failing\./);
    expect(intentPosts(reqs)).toHaveLength(1);
    expect(signaturePosts(reqs)).toHaveLength(1);
    expect(oneLine(r).data.receipt.intent_id).toBe(INTENT_ID);
  });

  it('--force does not excuse a key page that does not list the key', async () => {
    env = await sendEnv({ funded: false, gateway: { fault: 'key-page-lacks-key' } });
    const r = await sendJson(env, ['--wait', '--force']);
    const error = blocked(r);
    // Accumulate shows the page without the key while the gateway says it can sign: two reads that disagree, and the check does not choose.
    expect(error.details.readiness.first_blocker).toMatchObject({ name: 'key page', status: 'fail', code: 'KEY_PAGE_DISAGREES' });
    expect(intentPosts(env.gateway.take())).toHaveLength(0);
    expect(savedReceipts(env.home)).toEqual([]);
  });

  it('a gateway that says the identity cannot sign, over a page that holds the key, is a disagreement and blocks', async () => {
    env = await sendEnv({ gateway: { fault: 'cannot-sign' } });
    const r = await sendJson(env, ['--wait']);
    const error = blocked(r);
    expect(error.details.readiness.first_blocker).toMatchObject({ name: 'key page', code: 'KEY_PAGE_DISAGREES' });
    expect(error.details.readiness.first_blocker.detail).toMatch(/holding your key, but the gateway says this identity cannot sign/);
    expect(intentPosts(env.gateway.take())).toHaveLength(0);
  });

  it('an amount bigger than the balance is refused as underfunded, naming the shortfall', async () => {
    env = await sendEnv();
    const r = await env.run(['--json', 'send', '0.01', 'ETH', '--to', RECIPIENT, '--wait']);
    const reqs = env.gateway.take();
    const error = blocked(r);
    const gas = error.details.readiness.first_blocker;
    expect(gas).toMatchObject({ name: 'gas', code: 'ABSTRACT_ACCOUNT_UNDERFUNDED' });
    expect(gas.data).toMatchObject({ balance: '0.001', amount: '0.01', shortfall_kind: 'amount', shortfall: '0.0091' });
    expect(intentPosts(reqs)).toHaveLength(0);
  });

  it('a key that is not on this machine is a blocker that names it', async () => {
    env = await sendEnv();
    const r = await sendJson(env, ['--wait', '--sign-with', 'nokey']);
    const error = blocked(r);
    expect(error.details.readiness.first_blocker).toMatchObject({ name: 'signing key', code: 'UNKNOWN_KEY' });
    expect(intentPosts(env.gateway.take())).toHaveLength(0);
  });

  it('a check that could not be answered is SHOWN and does not block: an unknown is not a failure', async () => {
    env = await sendEnv({ gateway: { accumulateDown: true } });
    const r = await sendJson(env, ['--wait']);
    const reqs = env.gateway.take();
    expect(r.stderr).toMatch(/not confirmed: key page: Could not confirm from Accumulate that the key page holds your key/);
    expect(intentPosts(reqs)).toHaveLength(1);
    expect(signaturePosts(reqs)).toHaveLength(1);
    const receipt = oneLine(r).data.receipt;
    expect(receipt.intent_id).toBe(INTENT_ID);
    expect(r.code, r.stderr).toBe(4);
  });

  it('with the values typed there is nothing to echo and no context row on the card', async () => {
    env = await sendEnv();
    const r = await sendJson(env, ['--wait', '--chain', 'base-sepolia', '--identity', IDENTITY_ID, '--sign-with', 'dev']);
    expect(r.code, r.stderr).toBe(4);
    expect(r.stderr).not.toMatch(/^using /m);
    expect(r.stderr).not.toContain('not typed by you');
    expect(r.stderr).toContain(`to    ${RECIPIENT}`);
  });
});

describe('certen send with an encrypted key', () => {
  it('unlocks it with CERTEN_KEY_PASSPHRASE and signs', async () => {
    env = await sendEnv({ passphrase: 'correct horse' });
    const r = await sendJson(env, ['--wait']);
    expect(r.code, r.stderr).toBe(4);
    expect(oneLine(r).data.receipt.signed_with.key).toBe('dev');
    expect(signaturePosts(env.gateway.take())).toHaveLength(1);
  });

  it('a key that is encrypted with no passphrase and nobody to ask fails by name', async () => {
    env = await sendEnv({ passphrase: 'correct horse' });
    const r = await sendJson(env, ['--wait'], { env: { CERTEN_KEY_PASSPHRASE: '' } });
    expect(r.code).toBe(2);
    expect(oneLine(r).error.code).toBe('PASSPHRASE_REQUIRED');
    expect(signaturePosts(env.gateway.take())).toHaveLength(0);
    expect(savedReceipts(env.home)).toEqual([]);
  });

  it('a WRONG passphrase signs nothing and saves no receipt', async () => {
    env = await sendEnv({ passphrase: 'correct horse' });
    const r = await sendJson(env, ['--wait'], { env: { CERTEN_KEY_PASSPHRASE: 'battery staple' } });
    const reqs = env.gateway.take();
    expect(r.code).toBe(1);
    const e1 = oneLine(r);
    expect(e1.ok).toBe(false);
    expect(e1.error.code).toBe('WRONG_PASSPHRASE');
    expect(e1.error.message).toMatch(/Could not decrypt key "dev" - wrong passphrase, or the file has been modified|Could not decrypt key "dev" — wrong passphrase/);
    // The key is unlocked when it is opened, BEFORE the intent: a wrong passphrase must not leave an unsigned intent behind.
    expect(intentPosts(reqs)).toHaveLength(0);
    expect(signaturePosts(reqs)).toHaveLength(0);
    expect(savedReceipts(env.home)).toEqual([]);
    expect(JSON.stringify(e1)).not.toContain('battery staple');
    expect(r.stderr).not.toContain('battery staple');
  });
});

// ── a dry run ───────────────────────────────────────────────────────────────────────────────────────

describe('certen send --dry-run', () => {
  it('checks everything and opens nothing: one envelope, no intent, no signature, no receipt', async () => {
    env = await sendEnv();
    const r = await sendJson(env, ['--dry-run']);
    const reqs = env.gateway.take();
    expect(r.code, r.stderr).toBe(0);
    const e1 = oneLine(r);
    expect(e1.ok).toBe(true);
    expect(Object.keys(e1.data).sort()).toEqual(['dry_run', 'fee', 'readiness', 'request']);
    expect(e1.data.dry_run).toBe(true);
    expect(e1.data.request).toEqual({
      kind: 'transfer', chain: 'base-sepolia', chain_id: 84532, identity_id: IDENTITY_ID, adi_url: ADI, from: ABSTRACT_ACCOUNT, to: RECIPIENT,
      amount: '0.0001', asset: 'ETH', contract_call: null,
    });
    expect(e1.data.fee).toMatchObject({ state: 'estimated', sku: 'proof.execute', platform_fee_usd: '0.040000', mode: 'quoted' });
    expect(e1.data.readiness).toMatchObject({ ready: true, state: 'ready' });
    expect(r.stderr).toContain('Would send 0.0001 ETH on base-sepolia');
    expect(r.stderr).toContain('Nothing was signed or sent');
    expect(intentPosts(reqs)).toHaveLength(0);
    expect(signaturePosts(reqs)).toHaveLength(0);
    expect(savedReceipts(env.home)).toEqual([]);
    expectRouted(reqs);
  });

  it('in human mode prints the plan on stdout and asks nothing of a pipe', async () => {
    env = await sendEnv();
    const r = await env.run([...SEND, '--dry-run']);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain('Would send 0.0001 ETH on base-sepolia');
    expect(r.stdout).toContain(`to    ${RECIPIENT}`);
    expect(r.stdout).toMatch(/fee   about \$0\.040000 CERTEN fee/);
    expect(r.stderr).toContain('Nothing was signed or sent');
    expect(env.gateway.take().filter(isIntentPost)).toHaveLength(0);
  });

  it('is still refused when the account is not ready: a plan that would not go through says so', async () => {
    env = await sendEnv({ funded: false });
    const r = await sendJson(env, ['--dry-run']);
    expect(r.code).toBe(1);
    expect(oneLine(r).error.code).toBe('NOT_READY');
    expect(intentPosts(env.gateway.take())).toHaveLength(0);
  });

  it('needs the key to exist to judge the key page, so with no key it reports the missing key as the blocker', async () => {
    env = await sendEnv({ noKey: true });
    const r = await sendJson(env, ['--dry-run']);
    expect(r.code).toBe(1);
    const error = oneLine(r).error;
    expect(error.code).toBe('NOT_READY');
    expect(error.details.readiness.first_blocker).toMatchObject({ name: 'signing key', code: 'MISSING_SIGNING_KEY' });
    expect(intentPosts(env.gateway.take())).toHaveLength(0);
  });
});

// ── waiting, and every way the wait can end ─────────────────────────────────────────────────────────

describe('certen send: the wait', () => {
  it('polls through anchoring and executed to completed, and the receipt is the completed one', async () => {
    env = await sendEnv({ gateway: { statuses: ['anchoring', 'executed', 'completed'] } });
    const r = await sendJson(env, ['--wait', '--poll-interval', '1s']);
    const receipt = oneLine(r).data.receipt;
    expect(r.code, r.stderr).toBe(4);
    // Three reads, no more: the receipt is built from the last one, and the proof is fetched without reading the intent again.
    expect(env.gateway.intentReads()).toBe(3);
    expect(receipt.status).toMatchObject({ gateway_status: 'completed', outcome: 'completed', terminal: true });
    expect(receipt.stages.map((s: any) => s.state)).toEqual(['done', 'done', 'done', 'unknown']);
    expect(readSavedReceipt(env.home).status.gateway_status).toBe('completed');
    // `--json` is a machine channel: the wait is silent on it, and nothing human reached stdout.
    expect(r.stderr).not.toContain('Status: anchoring.');
  });

  it('says where the intent is as it changes, once each, in human mode', async () => {
    env = await sendEnv({ gateway: { statuses: ['anchoring', 'anchoring', 'executed', 'completed'] } });
    const r = await env.run([...SEND, '--yes', '--poll-interval', '1s']);
    expect(r.code, r.stderr).toBe(4);
    const said = (s: string): number => r.stdout.split(s).length - 1;
    expect(said('Status: anchoring.')).toBe(1);
    expect(said('Status: executed. The action ran on its chain; its proof is still being produced.')).toBe(1);
    expect(said('Status: completed.')).toBe(1);
    expect(env.gateway.intentReads()).toBe(4);
  });

  it('--json WITHOUT --wait returns once the signature is in: exit 0, a PENDING receipt, one read of the intent, and the way to pick it up', async () => {
    env = await sendEnv({ gateway: { statuses: ['anchoring'] } });
    const r = await sendJson(env);
    const reqs = env.gateway.take();
    expect(r.code, r.stderr).toBe(0);
    const receipt = oneLine(r).data.receipt;
    expect(receipt.verdict).toBe('pending');
    expect(receipt.status).toMatchObject({ gateway_status: 'anchoring', class: 'in_flight', terminal: false });
    expect(receipt.stages.map((s: any) => s.state)).toEqual(['done', 'pending', 'pending', 'pending']);
    expect(receipt.gaps.map((g: any) => g.code)).toEqual(['INTENT_NOT_TERMINAL']);
    expect(intentGets(reqs)).toHaveLength(1);
    expect(readSavedReceipt(env.home).verdict).toBe('pending');
    expect(r.stderr).toContain(`Next: certen watch ${INTENT_ID}`);
    // No proof was asked for: there is nothing to prove yet.
    expect(reqs.some((x) => x.path.startsWith('/v1/proof/'))).toBe(false);
  });

  it('--no-wait in human mode is the same: the plain-words receipt on stdout, exit 0, and the watch command', async () => {
    env = await sendEnv({ gateway: { statuses: ['anchoring'] } });
    const r = await env.run([...SEND, '--yes', '--no-wait']);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain('[done] signed  [wait] anchored on Accumulate  [wait] executed on base-sepolia  [ -- ] proof verified locally'.replace('[ -- ]', '[wait]'));
    expect(r.stdout).toContain('Result    PENDING: the intent is anchoring');
    expect(r.stdout).toContain(`Next: certen watch ${INTENT_ID}`);
    expect(intentGets(env.gateway.take())).toHaveLength(1);
  });

  it('a failed intent: exit 1, a failure envelope that CARRIES the receipt and the way back, and a failed receipt on disk', async () => {
    env = await sendEnv({ gateway: { fault: 'intent-fails' } });
    const r = await sendJson(env, ['--wait']);
    expect(r.code).toBe(1);
    const e1 = oneLine(r);
    expect(e1.ok).toBe(false);
    expect(e1.error.code).toBe('TX_FAILED');
    expect(e1.error.details).toMatchObject({ intent_id: INTENT_ID, reason_code: 'target_reverted', resume: `certen watch ${INTENT_ID}` });
    expect(e1.error.details.receipt.verdict).toBe('failed');
    expect(e1.error.details.receipt.status).toMatchObject({ gateway_status: 'failed', reason_code: 'target_reverted' });
    expect(e1.error.details.receipt_path).toBe(join(env.home, '.certen', 'receipts', `${INTENT_ID}.json`));
    expect(readSavedReceipt(env.home).verdict).toBe('failed');
    expect(readSavedReceipt(env.home)).toEqual(e1.error.details.receipt);
  });

  it('a failed intent in human mode shows the receipt with the stage that failed', async () => {
    env = await sendEnv({ gateway: { fault: 'intent-fails' } });
    const r = await env.run([...SEND, '--yes', '--wait']);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain('[FAIL] executed on base-sepolia');
    expect(r.stdout).toMatch(/Result    FAILED: the intent failed/);
    expect(r.stderr).toContain('Error [TX_FAILED]');
    expect(r.stdout).toContain('Proof     The intent failed, so there is no execution to prove.');
    expect(r.stdout).not.toMatch(/VERIFIED/);
  });

  it('a wait that runs out is neither success nor failure: TX_WAIT_TIMEOUT, exit 1, a pending receipt saved, and the command to resume', async () => {
    env = await sendEnv({ gateway: { statuses: ['anchoring'] } });
    const r = await sendJson(env, ['--wait', '--timeout', '3s', '--poll-interval', '1s']);
    expect(r.code).toBe(1);
    const e1 = oneLine(r);
    expect(e1.error.code).toBe('TX_WAIT_TIMEOUT');
    expect(e1.error.message).toMatch(/It may yet complete/);
    expect(e1.error.details).toMatchObject({ intent_id: INTENT_ID, last_status: 'anchoring', timeout_ms: 3000, resume: `certen watch ${INTENT_ID}` });
    expect(e1.error.details.receipt.verdict).toBe('pending');
    expect(readSavedReceipt(env.home).verdict).toBe('pending');
    expect(r.stderr).toContain(`Pick it back up: certen watch ${INTENT_ID}`);
  });

  it('a proof service that is down is a gap in a PARTIAL receipt, never a thrown error and never a pass', async () => {
    env = await sendEnv({ gateway: { fault: 'proof-service-down', statuses: ['completed'] } });
    const r = await sendJson(env, ['--no-wait']);
    const reqs = env.gateway.take();
    // 4, not 5: the service answered 503, which is "could not fetch" (UNAVAILABLE), not "there is no proof" (NO EVIDENCE). Not 0, not an exception.
    expect(r.code).toBe(4);
    const receipt = oneLine(r).data.receipt;
    expect(receipt.verdict).toBe('partial');
    expect(receipt.proof.verdict).toBe('unavailable');
    expect(receipt.proof.layers_verified).toBe(0);
    expect(receipt.gaps.map((g: any) => g.code)).toEqual(['PROOF_NOT_FETCHED', 'EFFECT_UNCHECKED']);
    expect(receipt.gaps[0].text).toMatch(/the proof service answered 503/);
    // The destination transaction is the validators' own record, and says so: nothing proved it.
    expect(receipt.ids.destination_tx).toBe(env.gateway.execution.txHash);
    expect(receipt.ids.destination_tx_source).toBe('validators');
    expect(receipt.stages[3].state).toBe('unknown');
    expect(readSavedReceipt(env.home).verdict).toBe('partial');
    expect(reqs.some((x) => x.path.endsWith('/v2') && x.status === 503)).toBe(true);
  });
});

// ── what else reaches the intent ────────────────────────────────────────────────────────────────────

describe('certen send passes through what the person asked for, and the check sees it', () => {
  it('--proof-class and --expires-in are in the intent, and the deadline is on the card the signature was checked against', async () => {
    env = await sendEnv({ gateway: { statuses: ['anchoring'] } });
    const before = Date.now();
    const r = await sendJson(env, ['--proof-class', 'on_cadence', '--expires-in', '30m']);
    expect(r.code, r.stderr).toBe(0);
    const body = env.gateway.lastIntent().body!;
    expect(body.proof_class).toBe('on_cadence');
    const deadline = Date.parse(body.expires_at);
    expect(deadline).toBeGreaterThan(before + 29 * 60_000);
    expect(deadline).toBeLessThan(Date.now() + 31 * 60_000);
    // The rebuilt transaction carries the same deadline: a mismatch would have ended the command before a signature existed.
    expect(r.stderr).toMatch(/expires\s+20\d\d-\d\d-\d\dT/);
  });

  it('an unknown proof class is refused by the parser, before any request', async () => {
    env = await sendEnv();
    const r = await sendJson(env, ['--proof-class', 'whenever']);
    expect(r.code).toBe(2);
    expect(oneLine(r).error.code).toBe('USAGE_ERROR');
    expect(env.gateway.take()).toEqual([]);
  });

  it('every run leaves exactly the receipts it made: one file per intent, no temporary files', async () => {
    env = await sendEnv({ gateway: { statuses: ['anchoring'] } });
    await sendJson(env);
    const dir = join(env.home, '.certen', 'receipts');
    expect(existsSync(dir)).toBe(true);
    expect(savedReceipts(env.home)).toEqual([`${INTENT_ID}.json`]);
  });
});

// ── never sign blind ────────────────────────────────────────────────────────────────────────────────

describe('certen send signs only what it can match to the request', () => {
  it('a gateway that builds the transaction for ANOTHER recipient gets no signature: the intent was opened, nothing was signed, no receipt', async () => {
    // The fake builds internally consistent signing data (every hash recomputes) for a recipient the person never named. Only matching it to
    // the request catches that, and `--yes` skips the question, never the check.
    env = await sendEnv({ gateway: { fault: 'swapped-recipient', statuses: ['anchoring'] } });
    const r = await sendJson(env, ['--wait']);
    expect(r.code).toBe(1);
    const e1 = oneLine(r);
    expect(e1.ok).toBe(false);
    expect(e1.error.code).toBe('SIGNING_DATA_MISMATCH');
    const reqs = env.gateway.take();
    expect(intentPosts(reqs)).toHaveLength(1);
    expect(signaturePosts(reqs)).toHaveLength(0);
    expect(savedReceipts(env.home)).toEqual([]);
    // The card is never shown for a transaction that does not match: there is nothing true to ask a person to confirm.
    expect(r.stderr).not.toContain('The signature authorises exactly this');
  });
});
