/**
 * The five gateway operations added for the CLI UX plan (PLAN section 6), as the SDK exposes them:
 * `chains.balance`, `identity.readiness`, `identity.topUpCredits`, `identity.drip` and `transaction.quote`.
 *
 * Two of them spend the platform's funds, so most of what is pinned here is what keeps a repeat from being a second draw and keeps bad input
 * off the network: the Idempotency-Key is ALWAYS sent (even with the client's automatic stamping off), it is the SAME key on every internal
 * retry, a feature the operator has not switched on is not retried, and an outcome nobody knows (202 `unconfirmed`) is returned, not thrown.
 * Against a real local HTTP server, so what is checked is what goes on the wire.
 */
import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import { CertenClient, CertenError } from '../src/index.js';

interface Seen { method: string; url: string; path: string; headers: http.IncomingHttpHeaders; body?: any; raw: string }
type Reply = { status: number; body?: unknown };

const servers: http.Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => { s.close(() => r()); })));
});

/** A gateway that answers every request with `replies[n]` (the last one repeats) and records what it was sent. */
async function gateway(replies: Reply[], options: Record<string, unknown> = {}) {
  const seen: Seen[] = [];
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    const url = req.url ?? '';
    seen.push({ method: req.method ?? 'GET', url, path: url.split('?')[0]!, headers: req.headers, raw, body: raw ? JSON.parse(raw) : undefined });
    const reply = replies[Math.min(seen.length - 1, replies.length - 1)]!;
    res.writeHead(reply.status, { 'content-type': 'application/json' }).end(JSON.stringify(reply.body ?? {}));
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const client = new CertenClient({ apiKey: 'ck_live_test', baseUrl, maxRetries: 0, baseBackoffMs: 1, maxBackoffMs: 5, ...options });
  return { client, seen };
}

const ADDRESS = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed'; // EIP-55 vector: valid and mixed-case
/** The gateway's flat error body: `{ error: <message>, code: <CODE> }`. */
const err = (code: string, status: number) => ({ status, body: { error: `${code} happened`, code } });

describe('chains.balance', () => {
  const ok = { chain: 'base-sepolia', chain_id: 84532, address: ADDRESS, balance: '0.25', symbol: 'ETH', read_at: '2026-10-16T00:00:00Z' };

  it('reads GET /v1/chains/{id}/addresses/{address}/balance with the key header, and returns the answer untouched', async () => {
    const { client, seen } = await gateway([{ status: 200, body: ok }]);
    expect(await client.chains.balance('base-sepolia', ADDRESS)).toEqual(ok);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.method).toBe('GET');
    expect(seen[0]!.path).toBe(`/v1/chains/base-sepolia/addresses/${ADDRESS}/balance`);
    expect(seen[0]!.headers['x-api-key']).toBe('ck_live_test');
  });

  it('keeps "0" as the string "0": an empty account is a successful read, and is not coerced', async () => {
    const { client } = await gateway([{ status: 200, body: { ...ok, balance: '0' } }]);
    const r = await client.chains.balance('base-sepolia', ADDRESS);
    expect(r.balance).toBe('0');
    expect(typeof r.balance).toBe('string');
  });

  it('takes a numeric chain id, and an all-lower-case address (which carries no checksum)', async () => {
    const { client, seen } = await gateway([{ status: 200, body: ok }]);
    await client.chains.balance(84532, ADDRESS.toLowerCase());
    expect(seen[0]!.path).toBe(`/v1/chains/84532/addresses/${ADDRESS.toLowerCase()}/balance`);
  });

  it('refuses a mistyped address BEFORE any request, with the gateway\'s own code and the correct capitalisation', async () => {
    const { client, seen } = await gateway([{ status: 200, body: ok }]);
    const wrongCase = ADDRESS.replace('5aA', '5AA'); // one letter's case flipped: the checksum no longer holds
    const failure = await client.chains.balance('base-sepolia', wrongCase).catch((e) => e);
    expect(failure).toBeInstanceOf(CertenError);
    expect(failure.code).toBe('INVALID_ADDRESS');
    expect(failure.status).toBe(0);
    expect(failure.message).toContain(ADDRESS); // names the capitalisation it would accept
    for (const bad of ['', '0x123', 'vitalik.eth', `${ADDRESS}00`, undefined as unknown as string]) {
      await expect(client.chains.balance('base-sepolia', bad)).rejects.toMatchObject({ code: 'INVALID_ADDRESS', status: 0 });
    }
    expect(seen).toHaveLength(0);
  });

  it('a node that did not answer is a BALANCE_UNREADABLE error that may be retried, never a zero', async () => {
    const { client, seen } = await gateway([err('BALANCE_UNREADABLE', 503), { status: 200, body: ok }], { maxRetries: 1 });
    const r = await client.chains.balance('base-sepolia', ADDRESS);
    expect(r.balance).toBe('0.25');
    expect(seen).toHaveLength(2); // the 503 was retried and then the real answer came
    const { client: once } = await gateway([err('BALANCE_UNREADABLE', 503)]);
    const failure = await once.chains.balance('base-sepolia', ADDRESS).catch((e) => e);
    expect(failure.code).toBe('BALANCE_UNREADABLE');
    expect(failure.isRetryable).toBe(true);
  });

  it('an unknown chain is the gateway\'s UNKNOWN_CHAIN, passed through', async () => {
    const { client } = await gateway([err('UNKNOWN_CHAIN', 400)]);
    await expect(client.chains.balance('nowhere', ADDRESS)).rejects.toMatchObject({ code: 'UNKNOWN_CHAIN', status: 400 });
  });
});

describe('identity.readiness', () => {
  const answer = {
    identity: { id: 'id-1', adi_url: 'acc://a.acme', key_page_url: 'acc://a.acme/book/1', status: 'active', error_message: null },
    can_sign: { state: 'unreadable', value: null },
    credits: { value: 50000, source: 'recorded' },
    chain: null,
    org: { state: 'billing_disabled' },
    read_at: '2026-10-16T00:00:00Z',
  };

  it('is one GET with no query when no chain is asked for', async () => {
    const { client, seen } = await gateway([{ status: 200, body: answer }]);
    await client.identity.readiness('id-1');
    expect(seen).toHaveLength(1);
    expect(seen[0]!.method).toBe('GET');
    expect(seen[0]!.url).toBe('/v1/identity/id-1/readiness');
  });

  it('sends the chain as a query parameter, for a registry id or a numeric chain id', async () => {
    const { client, seen } = await gateway([{ status: 200, body: answer }]);
    await client.identity.readiness('id-1', { chain: 'base-sepolia' });
    await client.identity.readiness('id-1', { chain: 84532 });
    expect(seen.map((s) => s.url)).toEqual(['/v1/identity/id-1/readiness?chain=base-sepolia', '/v1/identity/id-1/readiness?chain=84532']);
  });

  it('returns an unreadable section as data: it is a fact about that section, not a failure of the call', async () => {
    const { client } = await gateway([{ status: 200, body: answer }]);
    const r = await client.identity.readiness('id-1');
    expect(r.can_sign).toEqual({ state: 'unreadable', value: null });
    expect(r.credits.source).toBe('recorded');
    expect(r.chain).toBeNull();
  });

  it('an id that cannot name one resource is refused before any request', async () => {
    const { client, seen } = await gateway([{ status: 200, body: answer }]);
    await expect(client.identity.readiness('..')).rejects.toBeInstanceOf(CertenError);
    expect(seen).toHaveLength(0);
  });
});

describe('identity.topUpCredits', () => {
  const accepted = {
    topup_id: 't-1', identity_id: 'id-1', key_page_url: 'acc://a.acme/book/1', credits: 300,
    status: 'submitted', tx_id: 'acc://abc@a.acme/tx', credits_before: 12, note: 'submitted',
  };

  it('POSTs { credits } to the identity and returns the 202 answer', async () => {
    const { client, seen } = await gateway([{ status: 202, body: accepted }]);
    const r = await client.identity.topUpCredits('id-1', { credits: 300 });
    expect(r).toEqual(accepted);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.method).toBe('POST');
    expect(seen[0]!.path).toBe('/v1/identity/id-1/credits');
    expect(seen[0]!.body).toEqual({ credits: 300 });
  });

  it('sends the caller\'s Idempotency-Key exactly as given', async () => {
    const { client, seen } = await gateway([{ status: 202, body: accepted }]);
    await client.identity.topUpCredits('id-1', { credits: 300, idempotencyKey: 'order-4411' });
    expect(seen[0]!.headers['idempotency-key']).toBe('order-4411');
  });

  it('ALWAYS sends a key, even when none was given and the client\'s own automatic stamping is off (the gateway refuses without one)', async () => {
    const { client, seen } = await gateway([{ status: 202, body: accepted }], { autoIdempotencyKey: false });
    await client.identity.topUpCredits('id-1', { credits: 300 });
    const key = seen[0]!.headers['idempotency-key'];
    expect(typeof key).toBe('string');
    expect(String(key).length).toBeGreaterThan(8);
  });

  it('uses a different generated key for a different call, and the SAME key on every internal retry of one call', async () => {
    const { client, seen } = await gateway([err('DRIP_UNAVAILABLE', 503), err('DRIP_UNAVAILABLE', 503), { status: 202, body: accepted }], { maxRetries: 2 });
    await client.identity.topUpCredits('id-1', { credits: 300 });
    expect(seen).toHaveLength(3);
    const keys = seen.map((s) => s.headers['idempotency-key']);
    expect(new Set(keys).size).toBe(1); // a retry is the same draw, so it carries the same key
    await client.identity.topUpCredits('id-1', { credits: 300 });
    expect(seen[3]!.headers['idempotency-key']).not.toBe(keys[0]); // a new call is a new draw
  });

  it('refuses anything that is not a whole number of at least 1 BEFORE any request (the gateway would coerce "100" and truncate nothing)', async () => {
    const { client, seen } = await gateway([{ status: 202, body: accepted }]);
    for (const bad of [0, -1, 1.5, NaN, Infinity, '100', null, undefined, 2 ** 60]) {
      await expect(client.identity.topUpCredits('id-1', { credits: bad as number }), String(bad)).rejects.toMatchObject({ code: 'INVALID_CREDITS', status: 0 });
    }
    await expect(client.identity.topUpCredits('id-1', undefined as never)).rejects.toMatchObject({ code: 'INVALID_CREDITS' });
    expect(seen).toHaveLength(0);
  });

  it('returns an unconfirmed outcome as data, not an error: the credits MAY have been applied', async () => {
    const { client } = await gateway([{ status: 202, body: { ...accepted, status: 'unconfirmed', tx_id: null, credits_before: null } }]);
    const r = await client.identity.topUpCredits('id-1', { credits: 300 });
    expect(r.status).toBe('unconfirmed');
    expect(r.tx_id).toBeNull();
  });

  it('a top-up the operator has not switched on is NOT retried, whatever the 503 says', async () => {
    const { client, seen } = await gateway([err('CREDIT_TOPUP_DISABLED', 503), { status: 202, body: accepted }], { maxRetries: 3 });
    const failure = await client.identity.topUpCredits('id-1', { credits: 300 }).catch((e) => e);
    expect(failure.code).toBe('CREDIT_TOPUP_DISABLED');
    expect(failure.isRetryable).toBe(false);
    expect(seen).toHaveLength(1);
  });

  it('the daily limit and a missing key come through with their codes', async () => {
    const { client } = await gateway([err('CREDIT_TOPUP_LIMIT', 429)]);
    await expect(client.identity.topUpCredits('id-1', { credits: 300 })).rejects.toMatchObject({ code: 'CREDIT_TOPUP_LIMIT', status: 429 });
    const { client: other } = await gateway([err('IDEMPOTENCY_KEY_REQUIRED', 400)]);
    await expect(other.identity.topUpCredits('id-1', { credits: 300 })).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REQUIRED', isRetryable: false });
  });
});

describe('identity.drip', () => {
  const sent = {
    drip_id: 'd-1', identity_id: 'id-1', chain: 'base-sepolia', chain_id: 84532, address: ADDRESS,
    status: 'sent', tx_hash: '0xabc', amount: '0.01', symbol: 'ETH', explorer_url: 'https://sepolia.basescan.org/tx/0xabc', note: 'sent',
  };

  it('POSTs to the chain account with no body at all: the destination and the amount are not the caller\'s to choose', async () => {
    const { client, seen } = await gateway([{ status: 200, body: sent }]);
    const r = await client.identity.drip('id-1', 'base-sepolia');
    expect(r).toEqual(sent);
    expect(seen[0]!.method).toBe('POST');
    expect(seen[0]!.path).toBe('/v1/identity/id-1/chain-accounts/base-sepolia/drip');
    expect(seen[0]!.raw).toBe('');
  });

  it('takes a numeric chain id', async () => {
    const { client, seen } = await gateway([{ status: 200, body: sent }]);
    await client.identity.drip('id-1', 84532);
    expect(seen[0]!.path).toBe('/v1/identity/id-1/chain-accounts/84532/drip');
  });

  it('always carries an Idempotency-Key: the caller\'s when given, otherwise a generated one, even with automatic stamping off', async () => {
    const { client, seen } = await gateway([{ status: 200, body: sent }], { autoIdempotencyKey: false });
    await client.identity.drip('id-1', 'base-sepolia', { idempotencyKey: 'drip-77' });
    await client.identity.drip('id-1', 'base-sepolia');
    expect(seen[0]!.headers['idempotency-key']).toBe('drip-77');
    expect(String(seen[1]!.headers['idempotency-key']).length).toBeGreaterThan(8);
  });

  it('reuses the same key across its own retries', async () => {
    const { client, seen } = await gateway([err('DRIP_UNAVAILABLE', 503), { status: 200, body: sent }], { maxRetries: 1 });
    await client.identity.drip('id-1', 'base-sepolia');
    expect(seen).toHaveLength(2);
    expect(seen[0]!.headers['idempotency-key']).toBe(seen[1]!.headers['idempotency-key']);
  });

  it('skipped (the account already held enough) and unconfirmed (202) are both answers, not errors', async () => {
    const { client } = await gateway([{ status: 200, body: { ...sent, status: 'skipped', tx_hash: null, amount: null } }, { status: 202, body: { ...sent, status: 'unconfirmed' } }]);
    expect((await client.identity.drip('id-1', 'base-sepolia')).status).toBe('skipped');
    expect((await client.identity.drip('id-1', 'base-sepolia')).status).toBe('unconfirmed');
  });

  it('off by design on most deployments: DRIP_DISABLED is not retried, and the other refusals keep their codes', async () => {
    const { client, seen } = await gateway([err('DRIP_DISABLED', 503), { status: 200, body: sent }], { maxRetries: 3 });
    const failure = await client.identity.drip('id-1', 'base-sepolia').catch((e) => e);
    expect(failure).toMatchObject({ code: 'DRIP_DISABLED', status: 503, isRetryable: false });
    expect(seen).toHaveLength(1);
    for (const [code, status] of [['DRIP_TESTNET_ONLY', 422], ['DRIP_RECIPIENT_REJECTS', 422], ['DRIP_LIMIT', 429]] as const) {
      const { client: c } = await gateway([err(code, status)]);
      await expect(c.identity.drip('id-1', 'base-sepolia'), code).rejects.toMatchObject({ code, status });
    }
  });
});

describe('transaction.quote', () => {
  const intent = { type: 'contractCall', chain: 'base-sepolia', contractAddress: ADDRESS, data: '0x' } as never;
  const priced = {
    estimate: true, evaluated_at: '2026-10-16T00:00:00Z', request: { chains: ['base-sepolia'], chain: 'base-sepolia', leg_count: 1, proof_class: null },
    checked: ['chain_enabled'], not_checked: ['signature'],
    billing: { state: 'priced', enforcing: false, price: { sku: 'proof.execute', total_usd: '0.15' }, funds: { state: 'ok', covered: false, shortfall_usd: '0.15', gate: 'passes' } },
  };

  it('POSTs { intent } and, only when given, proof_class (mapped from proofClass)', async () => {
    const { client, seen } = await gateway([{ status: 200, body: priced }]);
    await client.transaction.quote({ intent });
    await client.transaction.quote({ intent, proofClass: 'on_demand' });
    expect(seen.map((s) => s.path)).toEqual(['/v1/transaction/quote', '/v1/transaction/quote']);
    expect(seen[0]!.body).toEqual({ intent });
    expect(seen[1]!.body).toEqual({ intent, proof_class: 'on_demand' });
  });

  it('returns the estimate whole, including a shortfall reported as a fact (200) and what was not checked', async () => {
    const { client } = await gateway([{ status: 200, body: priced }]);
    const q = await client.transaction.quote({ intent });
    expect(q.estimate).toBe(true);
    expect(q.not_checked).toEqual(['signature']);
    expect(q.billing.funds?.covered).toBe(false);
    expect(q.billing.price?.total_usd).toBe('0.15');
  });

  it('does not call the endpoint that creates a transaction', async () => {
    const { client, seen } = await gateway([{ status: 200, body: priced }]);
    await client.transaction.quote({ intent });
    expect(seen.some((s) => s.path === '/v1/transaction')).toBe(false);
  });

  it('a bad intent is the gateway\'s 400, passed through', async () => {
    const { client } = await gateway([err('BAD_REQUEST', 400)]);
    await expect(client.transaction.quote({ intent })).rejects.toMatchObject({ code: 'BAD_REQUEST', status: 400 });
  });
});

describe('the codes this adds to the SDK\'s knowledge', () => {
  it('retry exactly as the catalogue says: the limits and an unreadable balance may be, a switched-off feature may not', () => {
    const e = (code: string, status: number) => new CertenError('x', status, code);
    expect(e('BALANCE_UNREADABLE', 503).isRetryable).toBe(true);
    expect(e('DRIP_UNAVAILABLE', 503).isRetryable).toBe(true);
    expect(e('CREDIT_TOPUP_LIMIT', 429).isRetryable).toBe(true);
    expect(e('DRIP_LIMIT', 429).isRetryable).toBe(true);
    expect(e('CREDIT_TOPUP_DISABLED', 503).isRetryable).toBe(false);
    expect(e('DRIP_DISABLED', 503).isRetryable).toBe(false);
    expect(e('INVALID_ADDRESS', 400).isRetryable).toBe(false);
    expect(e('IDEMPOTENCY_KEY_REQUIRED', 400).isRetryable).toBe(false);
    expect(e('DRIP_TESTNET_ONLY', 422).isRetryable).toBe(false);
    expect(e('DRIP_RECIPIENT_REJECTS', 422).isRetryable).toBe(false);
  });
});
