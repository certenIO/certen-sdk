import { describe, it, expect, afterEach } from 'vitest';
import { certen, envelope } from './helpers/run-cli.js';
import { startStub, homeFor, WHO, API_KEY, type Stub, type Seen } from './helpers/stub-gateway.js';

/**
 * `certen quote <amount> <asset> --to <address>`: the gateway's ESTIMATE for a send.
 *
 * `quote --chain --sku` is the binding price of an operation and is untouched; given the inputs of `send`, the same command asks the gateway
 * what admission would do with that send, creating nothing. What is pinned: it asks for exactly the request `send` would make, it never opens or
 * signs anything, a shortfall is an answer and not a failure, every printed figure is labelled an estimate with the gates it did not look at, and
 * a bad invocation costs a message and no request.
 */

const TO = '0x1111111111111111111111111111111111111111';
const QUOTE = {
  estimate: true, evaluated_at: '2026-10-16T00:00:00Z',
  request: { chains: ['base-sepolia'], chain: 'base-sepolia', leg_count: 1, proof_class: null },
  checked: ['chain_enabled', 'price_book'], not_checked: ['the identity and its key page', 'destination-chain gas'],
  billing: {
    state: 'priced', enforcing: false,
    price: { sku: 'proof.execute', total_usd: '0.350000', platform_fee_usd: '0.150000', gas_usd: '0.200000', max_total_usd: '0.500000' },
    funds: { state: 'ok', spendable_usd: '5.000000', remaining_usd: '4.650000', shortfall_usd: '0.000000', covered: true, gate: 'passes' },
  },
};
const IDENTITY = {
  id: WHO.id, adi_url: WHO.adi, status: 'active', can_sign: true, key_page_url: WHO.keyPage, credit_balance: 500,
  chain_accounts: [{ chain_id: String(WHO.chainId), address: WHO.account, status: 'deployed' }], created_at: '2026-10-15T00:00:00Z',
};

let stub: Stub | undefined;
afterEach(async () => { await stub?.close(); stub = undefined; });

async function serve(opts: { quote?: (r: Seen) => { status?: number; body?: unknown }; identity?: unknown } = {}): Promise<Stub> {
  stub = await startStub((r) => {
    if (r.method === 'GET' && r.path === `/v1/identity/${WHO.id}`) return { body: opts.identity ?? IDENTITY };
    if (r.method === 'POST' && r.path === '/v1/transaction/quote') return opts.quote ? opts.quote(r) : { body: QUOTE };
    if (r.method === 'POST' && r.path === '/v1/quote') {
      return { body: {
        quote_id: 'q-1', chain: 'base-sepolia', proof_class: 'on_cadence', leg_count: 1, platform_fee_usd: '0.150000', gas_usd: '0.200000',
        total_usd: '0.350000', max_total_usd: '0.500000', expires_at: '2099-01-01T00:00:00Z',
      } };
    }
    return undefined;
  });
  return stub;
}
const quotes = (s: Stub): Seen[] => s.calls().filter((r) => r.path === '/v1/transaction/quote');

describe('an estimate for a send', () => {
  it('asks for the transfer send would open, and opens, charges and signs nothing', async () => {
    const g = await serve();
    const r = await certen(['quote', '0.0001', 'ETH', '--to', TO], { home: homeFor(g.url), apiUrl: g.url });
    expect(r.code, r.stderr).toBe(0);
    expect(quotes(g)).toHaveLength(1);
    const body = quotes(g)[0]!.body;
    expect(Object.keys(body)).toEqual(['intent']); // no proof class unless one was given
    expect(body.intent).toMatchObject({
      adiUrl: WHO.adi, initiatedBy: WHO.adi, fromChain: 'accumulate', toChain: 'base-sepolia', fromAddress: WHO.account, toAddress: TO,
      amount: '0.0001',
    });
    expect(typeof body.intent.id).toBe('string');
    expect(typeof body.intent.timestamp).toBe('number');
    // Only reads, and the one estimate: nothing that creates an intent, signs, or moves a balance.
    expect(g.calls().map((c) => `${c.method} ${c.path}`)).toEqual([`GET /v1/identity/${WHO.id}`, 'POST /v1/transaction/quote']);
    expect(quotes(g)[0]!.headers['x-api-key']).toBe(API_KEY);
  });

  it('labels every figure an estimate, with what was and was not checked', async () => {
    const g = await serve();
    const r = await certen(['quote', '0.0001', 'ETH', '--to', TO], { home: homeFor(g.url), apiUrl: g.url });
    expect(r.stdout).toContain('Estimate for sending 0.0001 ETH on base-sepolia');
    expect(r.stdout).toContain('about $0.35 to open this now (platform fee $0.15 + gas $0.20; capped at $0.50)');
    expect(r.stdout).toContain('AN ESTIMATE as of 2026-10-16T00:00:00Z: it creates, charges and signs nothing, and promises nothing');
    expect(r.stdout).toContain('checked: chain_enabled, price_book');
    expect(r.stdout).toContain('NOT checked: the identity and its key page, destination-chain gas');
    expect(r.stdout).toContain(`To send it: certen send 0.0001 ETH --to ${TO}`);
    expect(r.stdout + r.stderr).not.toContain(API_KEY);
  });

  it('--json is the gateway\'s estimate whole, in the envelope', async () => {
    const g = await serve();
    const r = await certen(['--json', 'quote', '0.0001', 'ETH', '--to', TO], { home: homeFor(g.url), apiUrl: g.url });
    expect(r.code, r.stderr).toBe(0);
    expect(envelope(r)).toEqual({ ok: true, data: QUOTE });
  });

  it('--proof-class is sent when given, and --identity and --chain come from the flags', async () => {
    const g = await serve();
    const r = await certen(['quote', '0.0001', 'ETH', '--to', TO, '--proof-class', 'on_demand', '--identity', WHO.id, '--chain', 'base-sepolia'], { home: homeFor(g.url), apiUrl: g.url });
    expect(r.code, r.stderr).toBe(0);
    expect(quotes(g)[0]!.body.proof_class).toBe('on_demand');
  });

  it('a shortfall is an answer, not a failure: exit 0, and it says the balance does NOT cover it', async () => {
    const short = { ...QUOTE, billing: { ...QUOTE.billing, enforcing: true, funds: { state: 'ok', covered: false, shortfall_usd: '0.350000', gate: 'PAYMENT_REQUIRED' } } };
    const g = await serve({ quote: () => ({ body: short }) });
    const r = await certen(['quote', '0.0001', 'ETH', '--to', TO], { home: homeFor(g.url), apiUrl: g.url });
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain('does NOT cover it: short by $0.35 and admission would answer PAYMENT_REQUIRED now');
  });

  it('a gateway that does not serve the route is a failure of this command, with its code and a command that helps', async () => {
    const g = await serve({ quote: (r) => ({ status: 404, body: { message: `Route ${r.method}:${r.path} not found`, error: 'Not Found', statusCode: 404 } }) });
    const r = await certen(['--json', 'quote', '0.0001', 'ETH', '--to', TO], { home: homeFor(g.url), apiUrl: g.url });
    expect(r.code).toBe(1);
    expect(envelope(r).error).toMatchObject({ code: 'ENDPOINT_NOT_ON_GATEWAY', next: 'certen doctor' });
  });

  it('an identity with no account on the chain cannot be quoted, and nothing is asked', async () => {
    const g = await serve({ identity: { ...IDENTITY, chain_accounts: [] } });
    const r = await certen(['--json', 'quote', '0.0001', 'ETH', '--to', TO], { home: homeFor(g.url), apiUrl: g.url });
    expect(r.code).toBe(1);
    expect(envelope(r).error).toMatchObject({ code: 'CHAIN_NOT_LINKED' });
    expect(quotes(g)).toHaveLength(0);
  });
});

describe('a bad invocation costs a message and no request', () => {
  it.each([
    ['an amount of zero', ['quote', '0', 'ETH', '--to', TO], 'INVALID_AMOUNT'],
    ['an amount that looks like wei', ['quote', '100000000000000', 'ETH', '--to', TO], 'INVALID_AMOUNT'],
    ['an address that is not one', ['quote', '0.1', 'ETH', '--to', '0x123'], 'INVALID_ADDRESS'],
    ['an asset the chain does not move', ['quote', '0.1', 'USDC', '--to', TO], 'UNSUPPORTED_ASSET'],
    ['no recipient', ['quote', '0.1', 'ETH'], 'MISSING_VALUE'],
    ['no asset', ['quote', '0.1', '--to', TO], 'MISSING_VALUE'],
    ['a send mixed with a price by sku', ['quote', '0.1', 'ETH', '--to', TO, '--sku', 'proof.execute'], 'CONFLICTING_QUOTE_ARGS'],
    ['a send mixed with --id', ['quote', '0.1', 'ETH', '--to', TO, '--id', 'q-1'], 'CONFLICTING_QUOTE_ARGS'],
    ['a chain this CLI does not target', ['quote', '0.1', 'ETH', '--to', TO, '--chain', 'nowhere'], 'UNSUPPORTED_CHAIN'],
  ])('%s: exit 2, nothing reached the gateway', async (_label, args, code) => {
    const g = await serve();
    const r = await certen(['--json', ...args], { home: homeFor(g.url), apiUrl: g.url });
    expect(r.code, r.stderr).toBe(2);
    expect(envelope(r).error).toMatchObject({ code });
    expect(g.seen).toHaveLength(0);
  });
});

describe('quote by sku is what it always was', () => {
  it('still prices an operation with --chain and --sku, and still demands --chain', async () => {
    const g = await serve();
    const home = homeFor(g.url);
    const priced = await certen(['quote', '--chain', 'base-sepolia', '--sku', 'proof.execute'], { home, apiUrl: g.url });
    expect(priced.code, priced.stderr).toBe(0);
    expect(g.calls().map((c) => `${c.method} ${c.path}`)).toEqual(['POST /v1/quote']);
    expect(g.calls()[0]!.body).toMatchObject({ chain: 'base-sepolia', sku: 'proof.execute', proof_class: 'on_cadence', leg_count: 1 });
    expect(priced.stdout).toContain('Platform fee');

    const bare = await certen(['--json', 'quote'], { home, apiUrl: g.url });
    expect(bare.code).toBe(2);
    expect(envelope(bare).error).toMatchObject({ code: 'MISSING_CHAIN' });

    const badClass = await certen(['--json', 'quote', '--chain', 'base-sepolia', '--proof-class', 'sometimes'], { home, apiUrl: g.url });
    expect(envelope(badClass).error).toMatchObject({ code: 'INVALID_PROOF_CLASS' });
  }, 60_000);

  it('a proof class that is not one is refused for an estimate too', async () => {
    const g = await serve();
    const r = await certen(['--json', 'quote', '0.1', 'ETH', '--to', TO, '--proof-class', 'sometimes'], { home: homeFor(g.url), apiUrl: g.url });
    expect(r.code).toBe(2);
    expect(envelope(r).error).toMatchObject({ code: 'INVALID_PROOF_CLASS' });
    expect(g.seen).toHaveLength(0);
  });
});
