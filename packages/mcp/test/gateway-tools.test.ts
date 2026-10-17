import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import Ajv2020 from 'ajv/dist/2020.js';
import { CertenClient } from '@certen.io/sdk';
import { dispatch } from '../src/protocol.js';
import { createHandlers } from '../src/server.js';
import { DESTINATION_NOTE } from '../src/destination.js';
import { outputSchemaFor } from '../src/output-schemas.js';
import { INTENT, completedTx, startWorld, type AgentWorld } from './agent-world.js';

/**
 * The tools for the gateway's newer operations, through the real server and the real SDK against a localhost gateway that records exactly what it was sent:
 * `certen_chain_balance`, `certen_identity_readiness`, `certen_intent_quote` (read) and `certen_credits_topup`, `certen_gas_drip` (write, and they spend the
 * PLATFORM's funds), and the destination transaction on the tools that return a transaction.
 *
 * What is pinned is what keeps a spend from happening twice or by mistake: the spending tools do not exist unless writes are on, a bad address or credit count
 * sends nothing, the Idempotency-Key is returned and reused, a feature the operator has not switched on is said plainly and not retried, an outcome nobody knows is
 * never shown as done, and a destination is always labelled the validators' word. Nothing here uses a real key or a real gateway.
 */

const SECRET = 'ck_live_SENTINEL_never_in_any_output_0123456789';
const IDENTITY = '396f863c-879c-4046-8591-3f0405c5f6bd';
const ADDRESS = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed'; // an EIP-55 test vector: valid, and mixed-case so the checksum is checked
const WRITES = { CERTEN_MCP_ALLOW_WRITES: '1' };
const PV = 'io.modelcontextprotocol/protocolVersion';
const CAPS = 'io.modelcontextprotocol/clientCapabilities';

interface Seen { method: string; path: string; url: string; headers: http.IncomingHttpHeaders; raw: string }
interface Reply { status: number; body?: unknown }
interface Called { isError: boolean; body: any; structured: any; text: string; rpcError?: { code: number; message: string }; wire: string }

const failure = (code: string, status: number, error = `${code} happened`): Reply => ({ status, body: { error, code } });
const BALANCE = { chain: 'base-sepolia', chain_id: 84532, address: ADDRESS, balance: '0', symbol: 'ETH', read_at: '2026-10-16T00:00:00Z' };
const TOPUP = {
  topup_id: 't-1', identity_id: IDENTITY, key_page_url: 'acc://probe.acme/book/1', credits: 300, status: 'submitted', tx_id: 'acc://abc@probe.acme/tx', credits_before: 12, note: 'submitted',
};
const DRIP = {
  drip_id: 'd-1', identity_id: IDENTITY, chain: 'base-sepolia', chain_id: 84532, address: ADDRESS, status: 'sent', tx_hash: `0x${'ab'.repeat(32)}`, amount: '0.01', symbol: 'ETH',
  explorer_url: 'https://sepolia.basescan.org/tx/0xabab', note: 'sent',
};
const DESTINATION = { chain_id: 84532, tx_hash: `0x${'cd'.repeat(32)}`, settlement: 'settled', source: 'validators' };

const closers: Array<() => Promise<void>> = [];
const worlds: AgentWorld[] = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
  for (const w of worlds.splice(0)) await w.close();
});

/** A gateway that answers each request with `handler(request)` and records every one. */
async function gateway(handler: (r: Seen, n: number) => Reply) {
  const seen: Seen[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const url = req.url ?? '';
      const entry: Seen = { method: req.method ?? 'GET', url, path: url.split('?')[0]!, headers: req.headers, raw: Buffer.concat(chunks).toString('utf8') };
      seen.push(entry);
      const reply = handler(entry, seen.length);
      res.writeHead(reply.status, { 'content-type': 'application/json' }).end(JSON.stringify(reply.body ?? {}));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const close = () => new Promise<void>((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); });
  closers.push(close);
  return { url, seen, close };
}

/** The server as a client sees it, over a gateway the test controls. `clientOptions` is the SDK client's (its own retries are its own tested behaviour, so they default to none). */
async function harness(handler: (r: Seen, n: number) => Reply, clientOptions: Record<string, unknown> = {}) {
  const gw = await gateway(handler);
  const client = new CertenClient({ apiKey: SECRET, baseUrl: gw.url, maxRetries: 0, baseBackoffMs: 1, maxBackoffMs: 5, ...clientOptions });
  const rpc = async (method: string, params: Record<string, unknown>, env: Record<string, string>) => {
    const handlers = createHandlers({ env: { CERTEN_API_KEY: SECRET, CERTEN_API_URL: gw.url, ...env } as NodeJS.ProcessEnv, client });
    return dispatch({ jsonrpc: '2.0', id: 1, method, params: { ...params, _meta: { [PV]: '2026-07-28', [CAPS]: {} } } }, handlers) as Promise<any>;
  };
  const call = async (name: string, args: Record<string, unknown>, env: Record<string, string> = WRITES): Promise<Called> => {
    const response = await rpc('tools/call', { name, arguments: args }, env);
    const text: string = response?.result?.content?.[0]?.text ?? '';
    let body: unknown = null;
    try { body = JSON.parse(text); } catch { body = null; }
    return { isError: response?.result?.isError === true, body, structured: response?.result?.structuredContent, text, rpcError: response?.error, wire: JSON.stringify(response) };
  };
  const list = async (env: Record<string, string> = {}): Promise<any[]> => (await rpc('tools/list', {}, env)).result.tools;
  return { ...gw, call, list };
}

const REQUEST_TOPUP = { identity_id: IDENTITY, credits: 300, confirm: true };
const REQUEST_DRIP = { identity_id: IDENTITY, chain: 'base-sepolia', confirm: true };

// ── the gate ──────────────────────────────────────────────────────────────────────────────────────────────

describe('the two tools that spend the platform\'s funds are behind CERTEN_MCP_ALLOW_WRITES=1', () => {
  it('are not listed by default, and are listed with readOnlyHint:false when writes are on', async () => {
    const h = await harness(() => ({ status: 200 }));
    const names = (tools: any[]) => tools.map((t) => t.name);
    const readOnly = await h.list({});
    expect(names(readOnly)).not.toContain('certen_credits_topup');
    expect(names(readOnly)).not.toContain('certen_gas_drip');
    // the three that only look are always there, and read-only
    for (const name of ['certen_chain_balance', 'certen_identity_readiness', 'certen_intent_quote']) {
      expect(readOnly.find((t) => t.name === name)?.annotations.readOnlyHint, name).toBe(true);
    }
    const writes = await h.list(WRITES);
    for (const name of ['certen_credits_topup', 'certen_gas_drip']) {
      const tool = writes.find((t) => t.name === name);
      expect(tool, name).toBeDefined();
      expect(tool.annotations, name).toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true });
      expect(tool.outputSchema?.type, name).toBe('object');
    }
  });

  it('cannot be called by default: refused as disabled by configuration, and nothing reaches the gateway', async () => {
    const h = await harness(() => ({ status: 202, body: TOPUP }));
    for (const [name, args] of [['certen_credits_topup', REQUEST_TOPUP], ['certen_gas_drip', REQUEST_DRIP]] as const) {
      const r = await h.call(name, args, {});
      expect(r.rpcError?.message, name).toMatch(/write tool and this server is running read-only/);
      expect(r.rpcError?.message, name).toMatch(/CERTEN_MCP_ALLOW_WRITES=1/);
      expect(r.structured, name).toBeUndefined();
    }
    // "true" and "yes" are things people type meaning to enable it: neither does
    for (const near of ['true', 'yes', '0']) {
      expect((await h.call('certen_credits_topup', REQUEST_TOPUP, { CERTEN_MCP_ALLOW_WRITES: near })).rpcError, near).toBeDefined();
    }
    expect(h.seen).toHaveLength(0);
  });

  it('tells a client, in the server\'s instructions, that two write tools spend the platform\'s funds, and only when writes are on', async () => {
    const withWrites = createHandlers({ env: { CERTEN_API_KEY: SECRET, ...WRITES } as NodeJS.ProcessEnv });
    const readOnly = createHandlers({ env: { CERTEN_API_KEY: SECRET } as NodeJS.ProcessEnv });
    const ask = async (handlers: ReturnType<typeof createHandlers>): Promise<string> =>
      ((await dispatch({ jsonrpc: '2.0', id: 1, method: 'server/discover', params: { _meta: { [PV]: '2026-07-28', [CAPS]: {} } } }, handlers)) as any).result.instructions;
    expect(await ask(withWrites)).toMatch(/certen_credits_topup and certen_gas_drip spend the PLATFORM's funds/);
    expect(await ask(readOnly)).not.toMatch(/certen_credits_topup/);
  });

  it('asks for confirm:true even when writes are on, and sends nothing until it has it', async () => {
    const h = await harness(() => ({ status: 202, body: TOPUP }));
    for (const [name, args] of [['certen_credits_topup', { identity_id: IDENTITY, credits: 300 }], ['certen_gas_drip', { identity_id: IDENTITY, chain: 'base-sepolia' }]] as const) {
      const r = await h.call(name, args);
      expect(r.isError, name).toBe(true);
      expect(r.body.status, name).toBe('confirmation_required');
      expect(r.structured, name).toBeUndefined();
    }
    expect(h.seen).toHaveLength(0);
  });
});

// ── certen_chain_balance ──────────────────────────────────────────────────────────────────────────────────────

describe('certen_chain_balance', () => {
  it('reads the address on the chain with the key header, and returns "0" as the string "0" (an empty account is a successful read)', async () => {
    const h = await harness(() => ({ status: 200, body: BALANCE }));
    const r = await h.call('certen_chain_balance', { chain: 'base-sepolia', address: ADDRESS }, {});
    expect(r.isError, r.text).toBe(false);
    expect(h.seen).toHaveLength(1);
    expect(h.seen[0]).toMatchObject({ method: 'GET', path: `/v1/chains/base-sepolia/addresses/${ADDRESS}/balance` });
    expect(h.seen[0]!.headers['x-api-key']).toBe(SECRET); // the key does go on the wire to the gateway (and the last describe checks it comes back in no output)
    expect(r.body).toEqual(BALANCE);
    expect(r.body.balance).toBe('0');
    expect(typeof r.body.balance).toBe('string');
    expect(r.structured).toEqual(BALANCE);
  });

  it('refuses a bad address BEFORE any request: a wrong checksum (naming the right capitalisation), the wrong length, a name, a number, nothing', async () => {
    const h = await harness(() => ({ status: 200, body: BALANCE }));
    const wrongCase = ADDRESS.replace('5aA', '5AA');
    const bad: unknown[] = [wrongCase, '0x123', `${ADDRESS}00`, 'vitalik.eth', '', 12345, null, undefined];
    for (const address of bad) {
      const r = await h.call('certen_chain_balance', { chain: 'base-sepolia', address }, {});
      expect(r.isError, String(address)).toBe(true);
      expect(r.body.error, String(address)).toMatchObject({ code: 'INVALID_ADDRESS', status: 0 });
    }
    expect((await h.call('certen_chain_balance', { chain: 'base-sepolia', address: wrongCase }, {})).body.error.message).toContain(ADDRESS);
    expect(h.seen).toHaveLength(0);
  });

  it('never turns a balance it could not read into a zero: BALANCE_UNREADABLE is an error, retryable', async () => {
    const h = await harness(() => failure('BALANCE_UNREADABLE', 503));
    const r = await h.call('certen_chain_balance', { chain: 'base-sepolia', address: ADDRESS }, {});
    expect(r.isError).toBe(true);
    expect(r.body.error).toMatchObject({ code: 'BALANCE_UNREADABLE', status: 503, retryable: true });
    expect(r.structured).toBeUndefined();
    expect(r.text).not.toMatch(/"balance"/);
  });

  it('refuses a chain this server does not enable, and an argument it does not have, before any request', async () => {
    const h = await harness(() => ({ status: 200, body: BALANCE }));
    expect((await h.call('certen_chain_balance', { chain: 'nowhere', address: ADDRESS }, {})).body.error.code).toBe('UNSUPPORTED_CHAIN');
    expect((await h.call('certen_chain_balance', { address: ADDRESS }, {})).body.error.code).toBe('MISSING_CHAIN');
    const named = await h.call('certen_chain_balance', { chain: 'base-sepolia', address: ADDRESS, rpc: 'http://127.0.0.1:1' }, {});
    expect(named.body.error.code).toBe('NODE_ARGUMENT_REFUSED');
    expect((await h.call('certen_chain_balance', { chain: 'base-sepolia', address: ADDRESS, block: 'latest' }, {})).body.error.code).toBe('UNKNOWN_ARGUMENT');
    expect(h.seen).toHaveLength(0);
  });
});

// ── certen_identity_readiness ───────────────────────────────────────────────────────────────────────────────

describe('certen_identity_readiness', () => {
  const FACTS = {
    identity: { id: IDENTITY, adi_url: 'acc://probe.acme', key_page_url: 'acc://probe.acme/book/1', status: 'active', error_message: null },
    can_sign: { state: 'unreadable', value: null },
    credits: { value: 50000, source: 'recorded' },
    chain: { chain: 'base-sepolia', chain_id: 84532, account: { state: 'deployed', address: ADDRESS }, balance: { state: 'unreadable', code: 'BALANCE_UNREADABLE' } },
    org: { state: 'not_permitted', scope: 'billing:read' },
    read_at: '2026-10-16T00:00:00Z',
  };

  it('is one GET, asks for the chain only when given one, and returns the facts as they came: an unreadable section stays unreadable, and nothing says "ready"', async () => {
    const h = await harness(() => ({ status: 200, body: FACTS }));
    const plain = await h.call('certen_identity_readiness', { identity_id: IDENTITY }, {});
    const withChain = await h.call('certen_identity_readiness', { identity_id: IDENTITY, chain: 'base-sepolia' }, {});
    expect(h.seen.map((s) => `${s.method} ${s.url}`)).toEqual([`GET /v1/identity/${IDENTITY}/readiness`, `GET /v1/identity/${IDENTITY}/readiness?chain=base-sepolia`]);
    expect(withChain.body).toEqual(FACTS);
    expect(withChain.body.can_sign).toEqual({ state: 'unreadable', value: null }); // unknown is not a soft yes
    expect(withChain.body.chain.balance).toEqual({ state: 'unreadable', code: 'BALANCE_UNREADABLE' }); // and not a zero
    for (const r of [plain, withChain]) {
      expect(r.isError, r.text).toBe(false);
      expect(r.body).not.toHaveProperty('ready');
      expect(r.body).not.toHaveProperty('state');
      expect(r.structured).toEqual(r.body);
    }
  });

  it('refuses an id that is not a UUID (an acc:// URL included), a chain it does not enable, and unknown arguments, before any request', async () => {
    const h = await harness(() => ({ status: 200, body: FACTS }));
    for (const identity_id of ['acc://probe.acme', '..', '', 12, undefined]) {
      expect((await h.call('certen_identity_readiness', { identity_id }, {})).body.error.code, String(identity_id)).toBe('INVALID_IDENTITY_ID');
    }
    expect((await h.call('certen_identity_readiness', { identity_id: IDENTITY, chain: 'nowhere' }, {})).body.error.code).toBe('UNSUPPORTED_CHAIN');
    expect((await h.call('certen_identity_readiness', { identity_id: IDENTITY, accumulateRpc: 'http://127.0.0.1:1' }, {})).body.error.code).toBe('NODE_ARGUMENT_REFUSED');
    expect(h.seen).toHaveLength(0);
  });
});

// ── certen_intent_quote ─────────────────────────────────────────────────────────────────────────────────────

describe('certen_intent_quote', () => {
  const INTENT_BODY = { fromChain: 'base-sepolia', toChain: 'base-sepolia', amount: '1000', fromAddress: ADDRESS, toAddress: ADDRESS, tokenSymbol: 'ETH' };
  const ESTIMATE = {
    estimate: true, evaluated_at: '2026-10-16T00:00:00Z', request: { chains: ['base-sepolia'], chain: 'base-sepolia', leg_count: 1, proof_class: 'on_demand' },
    checked: ['chain_enabled', 'price'], not_checked: ['identity_key_page', 'destination_gas', 'quota'],
    billing: { state: 'priced', enforcing: false, price: { sku: 'proof.execute', total_usd: '0.15' }, funds: { state: 'ok', covered: false, shortfall_usd: '0.15', gate: 'passes' } },
  };

  it('POSTs { intent, proof_class } to the preflight and nothing else: no transaction is created, and the answer is an estimate that lists what it did not check', async () => {
    const h = await harness(() => ({ status: 200, body: ESTIMATE }));
    const r = await h.call('certen_intent_quote', { intent: INTENT_BODY, proof_class: 'on_demand' }, {});
    expect(r.isError, r.text).toBe(false);
    expect(h.seen.map((s) => `${s.method} ${s.path}`)).toEqual(['POST /v1/transaction/quote']);
    expect(JSON.parse(h.seen[0]!.raw)).toEqual({ intent: INTENT_BODY, proof_class: 'on_demand' });
    expect(r.body).toEqual(ESTIMATE);
    expect(r.body.estimate).toBe(true);
    expect(r.body.not_checked.length).toBeGreaterThan(0);
    expect(r.body).not.toHaveProperty('quote_id');
    expect(r.structured).toEqual(ESTIMATE);
    // proof_class is sent only when given
    await h.call('certen_intent_quote', { intent: INTENT_BODY }, {});
    expect(JSON.parse(h.seen[1]!.raw)).toEqual({ intent: INTENT_BODY });
  });

  it('refuses a chain this server does not enable, a bad proof_class and an intent that is not an object, before any request', async () => {
    const h = await harness(() => ({ status: 200, body: ESTIMATE }));
    expect((await h.call('certen_intent_quote', { intent: { ...INTENT_BODY, toChain: 'nowhere' } }, {})).body.error.code).toBe('UNSUPPORTED_CHAIN');
    expect((await h.call('certen_intent_quote', { intent: INTENT_BODY, proof_class: 'soon' }, {})).body.error.code).toBe('INVALID_PROOF_CLASS');
    for (const intent of ['send it', 7, null, [], undefined]) {
      expect((await h.call('certen_intent_quote', { intent }, {})).body.error.code, String(intent)).toBe('INVALID_INTENT');
    }
    expect(h.seen).toHaveLength(0);
  });

  it('a key without the scope the gateway wants is refused, and that is an error, not an estimate', async () => {
    const h = await harness(() => failure('FORBIDDEN', 403, 'requires transaction:write'));
    const r = await h.call('certen_intent_quote', { intent: INTENT_BODY }, {});
    expect(r.isError).toBe(true);
    expect(r.body.error).toMatchObject({ code: 'FORBIDDEN', status: 403, retryable: false });
    expect(r.structured).toBeUndefined();
  });
});

// ── certen_credits_topup ────────────────────────────────────────────────────────────────────────────────────

describe('certen_credits_topup', () => {
  it('POSTs { credits } to the identity with an Idempotency-Key, and returns that key and the status in words: submitted is not applied', async () => {
    const h = await harness(() => ({ status: 202, body: TOPUP }));
    const r = await h.call('certen_credits_topup', REQUEST_TOPUP);
    expect(r.isError, r.text).toBe(false);
    expect(h.seen).toHaveLength(1);
    expect(h.seen[0]).toMatchObject({ method: 'POST', path: `/v1/identity/${IDENTITY}/credits` });
    expect(JSON.parse(h.seen[0]!.raw)).toEqual({ credits: 300 });
    const sent = h.seen[0]!.headers['idempotency-key'];
    expect(sent).toMatch(/^[0-9a-f-]{36}$/);
    expect(r.body.idempotency_key).toBe(sent); // the key the gateway saw is the key the agent was given
    expect(r.body).toMatchObject({ ...TOPUP, idempotency_key: sent });
    expect(r.body.next_step).toMatch(/^SUBMITTED, NOT CONFIRMED/);
    expect(r.body.next_step).toContain('certen_identity_readiness');
    expect(r.body.next_step).toContain('were 12 before');
    expect(r.structured).toEqual(r.body);
  });

  it('sends the caller\'s key exactly, returns it, and a retry with the same key sends the same key (while a call without one makes a new key)', async () => {
    const h = await harness(() => ({ status: 202, body: TOPUP }));
    const first = await h.call('certen_credits_topup', { ...REQUEST_TOPUP, idempotency_key: 'order-4411' });
    const again = await h.call('certen_credits_topup', { ...REQUEST_TOPUP, idempotency_key: 'order-4411' });
    expect(first.body.idempotency_key).toBe('order-4411');
    expect(again.body.idempotency_key).toBe('order-4411');
    expect(h.seen.map((s) => s.headers['idempotency-key'])).toEqual(['order-4411', 'order-4411']);

    // made by the server when none is given, handed back, and reusable: that is the retry an agent makes after a timeout
    const made = await h.call('certen_credits_topup', REQUEST_TOPUP);
    const retried = await h.call('certen_credits_topup', { ...REQUEST_TOPUP, idempotency_key: made.body.idempotency_key });
    const another = await h.call('certen_credits_topup', REQUEST_TOPUP);
    expect(made.body.idempotency_key).not.toBe('order-4411');
    expect(h.seen[3]!.headers['idempotency-key']).toBe(made.body.idempotency_key);
    expect(retried.body.idempotency_key).toBe(made.body.idempotency_key);
    expect(another.body.idempotency_key).not.toBe(made.body.idempotency_key); // a new call without a key is a new draw
  });

  it('refuses credits that are not a whole number of at least 1 BEFORE any request, in words about credits', async () => {
    const h = await harness(() => ({ status: 202, body: TOPUP }));
    const bad: unknown[] = [0, -1, 1.5, 0.99, NaN, Infinity, 2 ** 60, 1e21, '100', '', null, undefined, true, [], {}];
    for (const credits of bad) {
      const r = await h.call('certen_credits_topup', { identity_id: IDENTITY, credits, confirm: true });
      expect(r.isError, String(credits)).toBe(true);
      expect(r.body.error, String(credits)).toMatchObject({ code: 'INVALID_CREDITS', status: 0 });
      expect(r.body.error.message, String(credits)).toMatch(/1 credit = \$0\.01/);
      expect(r.body.error.message, String(credits)).toMatch(/never an amount of ACME/);
    }
    expect(h.seen).toHaveLength(0);
  });

  it('refuses a bad identity id, a key that is not a usable key, and any argument it does not have, before any request', async () => {
    const h = await harness(() => ({ status: 202, body: TOPUP }));
    expect((await h.call('certen_credits_topup', { ...REQUEST_TOPUP, identity_id: 'acc://probe.acme' })).body.error.code).toBe('INVALID_IDENTITY_ID');
    for (const idempotency_key of ['has space', 'new\nline', 'x'.repeat(129), 7, {}]) {
      expect((await h.call('certen_credits_topup', { ...REQUEST_TOPUP, idempotency_key })).body.error.code, String(idempotency_key)).toBe('INVALID_IDEMPOTENCY_KEY');
    }
    expect((await h.call('certen_credits_topup', { ...REQUEST_TOPUP, acme: 3 })).body.error.code).toBe('UNKNOWN_ARGUMENT');
    expect((await h.call('certen_credits_topup', { ...REQUEST_TOPUP, url: 'http://127.0.0.1:1' })).body.error.code).toBe('NODE_ARGUMENT_REFUSED');
    expect(h.seen).toHaveLength(0);
  });

  it('shows unconfirmed as unconfirmed, never as done: the credits MAY have been applied, so it says to read them back and not to ask again with a new key', async () => {
    const h = await harness(() => ({ status: 202, body: { ...TOPUP, status: 'unconfirmed', tx_id: null, credits_before: null } }));
    const r = await h.call('certen_credits_topup', { ...REQUEST_TOPUP, idempotency_key: 'order-9' });
    expect(r.isError, r.text).toBe(false); // an answer, not a failure of the call...
    expect(r.body.status).toBe('unconfirmed');
    expect(r.body.next_step).toMatch(/^UNCONFIRMED: /); // ...and the first word of what to do next is not "done"
    expect(r.body.next_step).toMatch(/MAY have been applied/);
    expect(r.body.next_step).toMatch(/Do NOT top up again with a new idempotency_key/);
    expect(r.body.next_step).toContain('certen_identity_readiness');
    expect(r.body.next_step).toContain('"order-9"'); // the key to repeat it with
    expect(r.body.next_step).not.toMatch(/SUBMITTED|\bsuccess/i);
    expect(r.body.idempotency_key).toBe('order-9');
    expect(r.structured.status).toBe('unconfirmed');
  });

  it('treats a status it does not know as not confirmed, because the one thing it must not do is guess "done"', async () => {
    const h = await harness(() => ({ status: 202, body: { ...TOPUP, status: 'applied' } }));
    const r = await h.call('certen_credits_topup', REQUEST_TOPUP);
    expect(r.body.next_step).toMatch(/^NOT CONFIRMED \(the gateway answered status "applied"\)/);
    expect(r.body.next_step).toMatch(/Do NOT top up again with a new idempotency_key/);
  });

  it('says plainly that a switched-off top-up is the operator\'s setting, does not retry it, and still returns the key', async () => {
    const h = await harness(() => failure('CREDIT_TOPUP_DISABLED', 503), { maxRetries: 3 });
    const r = await h.call('certen_credits_topup', REQUEST_TOPUP);
    expect(r.isError).toBe(true);
    expect(h.seen).toHaveLength(1); // not retried, whatever the 503 says
    expect(r.body.error).toMatchObject({ code: 'CREDIT_TOPUP_DISABLED', status: 503, retryable: false });
    expect(r.body.error.guidance).toMatch(/not switched on/);
    expect(r.body.error.guidance).toMatch(/operator/);
    expect(r.body.error.guidance).toMatch(/Nothing was drawn/);
    expect(r.body.error.guidance).toMatch(/do not retry/);
    expect(r.body.error.idempotency_key).toBe(h.seen[0]!.headers['idempotency-key']);
    expect(r.body.note).toMatch(/Not retryable/);
    expect(r.structured).toBeUndefined();
  });

  it('reports a limit as a limit, with the figures the gateway gave, and tells the agent not to vary the key to get around it', async () => {
    const h = await harness(() => failure('CREDIT_TOPUP_LIMIT', 429, 'daily limit reached: 40 credits remain'));
    const r = await h.call('certen_credits_topup', { ...REQUEST_TOPUP, idempotency_key: 'order-4411' });
    expect(r.isError).toBe(true);
    expect(r.body.error).toMatchObject({ code: 'CREDIT_TOPUP_LIMIT', status: 429, idempotency_key: 'order-4411' });
    expect(r.body.error.message).toContain('40 credits remain');
    expect(r.body.error.guidance).toMatch(/do not change the key or the amount/);
  });

  it('when the call may have been made (a dropped connection, a 5xx), the failure carries the key and says to repeat THAT request, never to start a new one', async () => {
    const server = await gateway(() => ({ status: 200 }));
    await server.close(); // nothing is listening: the SDK reports NETWORK_ERROR, and whether the request was seen is not knowable
    const dead = new CertenClient({ apiKey: SECRET, baseUrl: server.url, maxRetries: 0 });
    const handlers = createHandlers({ env: { CERTEN_API_KEY: SECRET, CERTEN_MCP_ALLOW_WRITES: '1' } as NodeJS.ProcessEnv, client: dead });
    const response = await dispatch({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'certen_credits_topup', arguments: REQUEST_TOPUP, _meta: { [PV]: '2026-07-28', [CAPS]: {} } } }, handlers) as any;
    const body = JSON.parse(response.result.content[0].text);
    expect(response.result.isError).toBe(true);
    expect(body.error.code).toBe('NETWORK_ERROR');
    expect(body.error.idempotency_key).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.error.guidance).toMatch(/outcome is not known/);
    expect(body.error.guidance).toMatch(/same idempotency_key/);

    const h = await harness(() => failure('INTERNAL_ERROR', 500));
    const r = await h.call('certen_credits_topup', { ...REQUEST_TOPUP, idempotency_key: 'order-4411' });
    expect(r.body.error).toMatchObject({ status: 500, idempotency_key: 'order-4411' });
    expect(r.body.error.guidance).toMatch(/same idempotency_key/);
  });

  it('a refusal the gateway made carries the key but no claim that the outcome is unknown', async () => {
    const h = await harness(() => failure('NOT_FOUND', 404));
    const r = await h.call('certen_credits_topup', { ...REQUEST_TOPUP, idempotency_key: 'order-4411' });
    expect(r.body.error).toMatchObject({ code: 'NOT_FOUND', status: 404, idempotency_key: 'order-4411' });
    expect(r.body.error).not.toHaveProperty('guidance');
  });
});

// ── certen_gas_drip ─────────────────────────────────────────────────────────────────────────────────────

describe('certen_gas_drip', () => {
  it('POSTs to the identity\'s chain account with no body at all, and reports a sent drip with its hash, its link and where to check it', async () => {
    const h = await harness(() => ({ status: 200, body: DRIP }));
    const r = await h.call('certen_gas_drip', REQUEST_DRIP);
    expect(r.isError, r.text).toBe(false);
    expect(h.seen[0]).toMatchObject({ method: 'POST', path: `/v1/identity/${IDENTITY}/chain-accounts/base-sepolia/drip`, raw: '' });
    expect(r.body).toMatchObject({ ...DRIP, idempotency_key: h.seen[0]!.headers['idempotency-key'] });
    expect(r.body.next_step).toMatch(/^SENT: /);
    expect(r.body.next_step).toContain(DRIP.tx_hash);
    expect(r.body.next_step).toContain(DRIP.explorer_url);
    expect(r.body.next_step).toContain(`certen_chain_balance { chain: "base-sepolia", address: "${ADDRESS}" }`);
    expect(r.structured).toEqual(r.body);
  });

  it('reports skipped as nothing sent, and unconfirmed (202) as not confirmed: the drip MAY have been sent, so do not drip again with a new key', async () => {
    const skipped = await harness(() => ({ status: 200, body: { ...DRIP, status: 'skipped', tx_hash: null, amount: null, explorer_url: null } }));
    const s = await skipped.call('certen_gas_drip', REQUEST_DRIP);
    expect(s.isError, s.text).toBe(false);
    expect(s.body.status).toBe('skipped');
    expect(s.body.next_step).toMatch(/^SKIPPED, NOTHING WAS SENT/);

    const unconfirmed = await harness(() => ({ status: 202, body: { ...DRIP, status: 'unconfirmed', tx_hash: null, explorer_url: null } }));
    const u = await unconfirmed.call('certen_gas_drip', { ...REQUEST_DRIP, idempotency_key: 'drip-77' });
    expect(u.isError, u.text).toBe(false);
    expect(u.body.status).toBe('unconfirmed');
    expect(u.body.next_step).toMatch(/^UNCONFIRMED: /);
    expect(u.body.next_step).toMatch(/MAY have been sent/);
    expect(u.body.next_step).toMatch(/Do NOT drip again with a new idempotency_key/);
    expect(u.body.next_step).toContain('certen_chain_balance');
    expect(u.body.next_step).toContain('"drip-77"');
    expect(u.body.next_step).not.toMatch(/^SENT|\bsuccess/i);

    const unknown = await harness(() => ({ status: 200, body: { ...DRIP, status: 'delivered' } }));
    expect((await unknown.call('certen_gas_drip', REQUEST_DRIP)).body.next_step).toMatch(/^NOT CONFIRMED \(the gateway answered status "delivered"\)/);
  });

  it('returns the caller\'s key, reuses the same key on a retry, and makes a fresh one when none is given', async () => {
    const h = await harness(() => ({ status: 200, body: DRIP }));
    const a = await h.call('certen_gas_drip', { ...REQUEST_DRIP, idempotency_key: 'drip-77' });
    const b = await h.call('certen_gas_drip', { ...REQUEST_DRIP, idempotency_key: 'drip-77' });
    const c = await h.call('certen_gas_drip', REQUEST_DRIP);
    expect([a.body.idempotency_key, b.body.idempotency_key]).toEqual(['drip-77', 'drip-77']);
    expect(h.seen.slice(0, 2).map((s) => s.headers['idempotency-key'])).toEqual(['drip-77', 'drip-77']);
    expect(c.body.idempotency_key).toBe(h.seen[2]!.headers['idempotency-key']);
    expect(c.body.idempotency_key).not.toBe('drip-77');
  });

  it('says plainly that a switched-off drip is the operator\'s setting, does not retry it, and points at a faucet', async () => {
    const h = await harness(() => failure('DRIP_DISABLED', 503), { maxRetries: 3 });
    const r = await h.call('certen_gas_drip', REQUEST_DRIP);
    expect(r.isError).toBe(true);
    expect(h.seen).toHaveLength(1);
    expect(r.body.error).toMatchObject({ code: 'DRIP_DISABLED', status: 503, retryable: false });
    expect(r.body.error.guidance).toMatch(/not switched on/);
    expect(r.body.error.guidance).toMatch(/operator/);
    expect(r.body.error.guidance).toMatch(/faucet/);
    expect(r.body.error.idempotency_key).toBeDefined();
  });

  it('keeps the other refusals as refusals: testnets only, a cooldown, an account that cannot receive', async () => {
    for (const [code, status, guidance] of [['DRIP_TESTNET_ONLY', 422, /testnets only/], ['DRIP_LIMIT', 429, /cooldown/], ['DRIP_RECIPIENT_REJECTS', 422, /cannot be dripped/]] as const) {
      const h = await harness(() => failure(code, status));
      const r = await h.call('certen_gas_drip', REQUEST_DRIP);
      expect(r.isError, code).toBe(true);
      expect(r.body.error, code).toMatchObject({ code, status });
      expect(r.body.error.guidance, code).toMatch(guidance);
    }
  });

  it('has no destination and no amount to choose: an argument naming either is refused by name, and nothing is sent', async () => {
    const h = await harness(() => ({ status: 200, body: DRIP }));
    for (const extra of [{ address: ADDRESS }, { to: ADDRESS }, { recipient: ADDRESS }, { destination: ADDRESS }, { amount: '1' }, { value: '1' }, { wei: '1' }]) {
      const r = await h.call('certen_gas_drip', { ...REQUEST_DRIP, ...extra });
      expect(r.body.error.code, JSON.stringify(extra)).toBe('UNKNOWN_ARGUMENT');
      expect(r.body.error.message, JSON.stringify(extra)).toMatch(/Neither is the caller's to choose/);
    }
    expect((await h.call('certen_gas_drip', { ...REQUEST_DRIP, rpc: 'http://127.0.0.1:1' })).body.error.code).toBe('NODE_ARGUMENT_REFUSED');
    expect(h.seen).toHaveLength(0);
  });

  it('refuses a bad identity id, a chain this server does not enable and a bad key before any request', async () => {
    const h = await harness(() => ({ status: 200, body: DRIP }));
    expect((await h.call('certen_gas_drip', { ...REQUEST_DRIP, identity_id: 'probe' })).body.error.code).toBe('INVALID_IDENTITY_ID');
    expect((await h.call('certen_gas_drip', { ...REQUEST_DRIP, chain: 'nowhere' })).body.error.code).toBe('UNSUPPORTED_CHAIN');
    expect((await h.call('certen_gas_drip', { identity_id: IDENTITY, confirm: true })).body.error.code).toBe('MISSING_CHAIN');
    expect((await h.call('certen_gas_drip', { ...REQUEST_DRIP, idempotency_key: 'a b' })).body.error.code).toBe('INVALID_IDEMPOTENCY_KEY');
    expect(h.seen).toHaveLength(0);
  });
});

// ── the destination transaction ─────────────────────────────────────────────────────────────────────────────

describe('destination: the validators\' record, never presented as proof', () => {
  const NOTE_PHRASE = 'as recorded by the validators; not verified by the gateway';
  const tx = (over: Record<string, unknown> = {}) => ({ intent_id: INTENT, identity_id: IDENTITY, status: 'completed', created_at: '2026-10-15T00:00:00Z', ...over });

  it('certen_transaction_get returns the destination with its note, in the text and in the structured output', async () => {
    const h = await harness(() => ({ status: 200, body: tx({ destination: DESTINATION }) }));
    const r = await h.call('certen_transaction_get', { intentId: INTENT }, {});
    expect(r.isError, r.text).toBe(false);
    expect(r.body.destination).toEqual(DESTINATION);
    expect(r.body.destination.source).toBe('validators');
    expect(r.body.destination_note).toContain(NOTE_PHRASE);
    expect(r.body.destination_note).toBe(DESTINATION_NOTE);
    expect(r.structured.destination_note).toBe(DESTINATION_NOTE);
    expect(r.structured.destination).toEqual(DESTINATION);
    expect(JSON.parse(r.text)).toEqual(r.structured);
  });

  it('passes a reverted settlement through as the validators said it', async () => {
    const h = await harness(() => ({ status: 200, body: tx({ destination: { ...DESTINATION, settlement: 'reverted' } }) }));
    const r = await h.call('certen_transaction_get', { intentId: INTENT }, {});
    expect(r.body.destination.settlement).toBe('reverted');
    expect(r.body.destination_note).toContain(NOTE_PHRASE);
  });

  it('renders no destination cleanly: null and absent carry no note, because a note on nothing reads as a warning about something that is not there', async () => {
    for (const body of [tx({ destination: null }), tx()]) {
      const h = await harness(() => ({ status: 200, body }));
      const r = await h.call('certen_transaction_get', { intentId: INTENT }, {});
      expect(r.isError, r.text).toBe(false);
      expect(r.body).not.toHaveProperty('destination_note');
      expect(r.text).not.toContain('not verified by the gateway');
      expect(r.body.destination ?? null).toBeNull();
    }
  });

  it('certen_execute_wait returns it with the note too, beside its outcome', async () => {
    const h = await harness(() => ({ status: 200, body: tx({ destination: DESTINATION }) }));
    const r = await h.call('certen_execute_wait', { intentId: INTENT }, {});
    expect(r.isError, r.text).toBe(false);
    expect(r.body.outcome.outcome).toBe('completed');
    expect(r.body.destination).toEqual(DESTINATION);
    expect(r.body.destination_note).toContain(NOTE_PHRASE);
    expect(r.structured.destination_note).toContain(NOTE_PHRASE);
  });

  it('certen_transaction_list notes each row that carries a destination, and no other', async () => {
    const rows = [tx({ intent_id: 'a', destination: DESTINATION }), tx({ intent_id: 'b', destination: null }), tx({ intent_id: 'c' })];
    const h = await harness(() => ({ status: 200, body: { transactions: rows, total: 3, limit: 50, offset: 0 } }));
    const r = await h.call('certen_transaction_list', {}, {});
    expect(r.isError, r.text).toBe(false);
    const [a, b, c] = r.body.transactions;
    expect(a.destination_note).toContain(NOTE_PHRASE);
    expect(b).not.toHaveProperty('destination_note');
    expect(c).not.toHaveProperty('destination_note');
    expect(r.body.total).toBe(3);
  });

  it('certen_transaction_open notes a destination on the intent it returns (an idempotent replay can echo one)', async () => {
    const h = await harness(() => ({ status: 202, body: { intent_id: INTENT, status: 'submitted', destination: DESTINATION } }));
    const r = await h.call('certen_transaction_open', { identityId: IDENTITY, intent: { toChain: 'base-sepolia', amount: '1', toAddress: ADDRESS }, confirm: true });
    expect(r.isError, r.text).toBe(false);
    expect(r.body.destination_note).toContain(NOTE_PHRASE);
  });

  describe('certen_receipt', () => {
    const ajv = new Ajv2020({ strict: false, allErrors: true });
    const world = async (transaction: Record<string, unknown>): Promise<AgentWorld> => { const w = await startWorld({ tx: transaction }); worlds.push(w); return w; };

    it('adds the gateway\'s destination and the note, and the receipt\'s verdict does not rest on it', async () => {
      const w = await world({ ...completedTx, destination: DESTINATION });
      const r = await w.call('certen_receipt', { intentId: INTENT });
      expect(r.isError, r.text).toBe(false);
      expect(r.body.destination).toEqual(DESTINATION);
      expect(r.body.destination_note).toContain(NOTE_PHRASE);
      expect(r.structured.destination_note).toContain(NOTE_PHRASE);
      expect(r.body.ids).toHaveProperty('destination_tx_source'); // where the receipt's own hash came from is still said
      expect(r.body.verdict).toBe('partial'); // a destination the validators recorded does not make a receipt verified
      expect(ajv.compile(outputSchemaFor('certen_receipt')!)(r.structured)).toBe(true);
    });

    it('has destination:null and no note when the gateway recorded none', async () => {
      const w = await world({ ...completedTx });
      const r = await w.call('certen_receipt', { intentId: INTENT });
      expect(r.isError, r.text).toBe(false);
      expect(r.body.destination).toBeNull();
      expect(r.body).not.toHaveProperty('destination_note');
      const validate = ajv.compile(outputSchemaFor('certen_receipt')!);
      expect(validate(r.structured), JSON.stringify(validate.errors)).toBe(true);
    });
  });
});

// ── nothing secret ────────────────────────────────────────────────────────────────────────────────────────

describe('no API key or secret appears in any tool output', () => {
  it('not in a result, an error, a refusal, a confirmation stop or a gated call, for any of the five tools', async () => {
    const answers: Record<string, Reply> = {
      balance: { status: 200, body: BALANCE },
      readiness: { status: 200, body: { identity: {}, can_sign: {}, credits: {}, chain: null, org: {}, read_at: 'x' } },
      quote: { status: 200, body: { estimate: true, evaluated_at: 'x', request: null, checked: [], not_checked: [], billing: {} } },
      topup: { status: 202, body: TOPUP },
      drip: { status: 200, body: DRIP },
    };
    let mode: 'ok' | 'refused' | 'broken' = 'ok';
    const h = await harness((r) => {
      if (mode === 'refused') return failure('FORBIDDEN', 403, 'not allowed');
      if (mode === 'broken') return failure('INTERNAL_ERROR', 500, 'boom');
      if (r.path.endsWith('/balance')) return answers.balance!;
      if (r.path.endsWith('/readiness')) return answers.readiness!;
      if (r.path.endsWith('/quote')) return answers.quote!;
      if (r.path.endsWith('/credits')) return answers.topup!;
      return answers.drip!;
    });
    const calls: Array<[string, Record<string, unknown>]> = [
      ['certen_chain_balance', { chain: 'base-sepolia', address: ADDRESS }],
      ['certen_identity_readiness', { identity_id: IDENTITY, chain: 'base-sepolia' }],
      ['certen_intent_quote', { intent: { toChain: 'base-sepolia', amount: '1', toAddress: ADDRESS } }],
      ['certen_credits_topup', REQUEST_TOPUP],
      ['certen_gas_drip', REQUEST_DRIP],
    ];
    const outputs: string[] = [];
    for (const m of ['ok', 'refused', 'broken'] as const) {
      mode = m;
      for (const [name, args] of calls) {
        outputs.push((await h.call(name, args)).wire); // success, and the gateway refusing, and the gateway failing
        outputs.push((await h.call(name, args, {})).wire); // gated (the spending two) or served (the reads)
        outputs.push((await h.call(name, { ...args, confirm: undefined, address: 'nope', credits: 0, idempotency_key: 'bad key', rpc: 'x' })).wire); // refused locally
      }
    }
    outputs.push((await h.call('certen_credits_topup', { identity_id: IDENTITY, credits: 300 })).wire); // the confirmation stop
    expect(outputs.length).toBeGreaterThan(40);
    // not vacuous: the key WAS used, on the wire, to reach the gateway
    expect(h.seen.length).toBeGreaterThan(5);
    expect(h.seen.every((s) => s.headers['x-api-key'] === SECRET)).toBe(true);
    for (const output of outputs) expect(output).not.toContain(SECRET);
    for (const output of outputs) expect(output).not.toMatch(/ck_live_/);
  });
});
