import { describe, it, expect } from 'vitest';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import { CertenClient, READINESS_CHECKS, CONTEXT_CHECKS, type Readiness, type ReadinessParams } from '../src/index.js';

/**
 * `client.readiness()`.
 *
 * A real localhost gateway AND a real localhost Accumulate node, matching the rest of this suite: what matters is what the SDK does with
 * what each actually returns, and a mock would let a wrong interpretation pass.
 *
 * What is pinned is the JUDGEMENT each check makes, because each has a plausible wrong answer:
 *
 * - the check list is the same length however far the run got, so a skipped check is visibly skipped rather than absent;
 * - "unknown" is never "ready": a key page that could not be read, a balance nobody reported and a credential nobody could confirm all
 *   leave the list unconfirmed, whatever the other checks say;
 * - the gateway's word and Accumulate's word about the key page are two reads, and when they disagree that is a blocker with its own
 *   code, not a preference for either;
 * - only a certain failure fails: zero credits and an account that cannot cover what it is about to move. An estimate of gas is
 *   labelled as one, and a chain with no estimate says so instead of being given a number.
 */

const ID = '396f863c-879c-4046-8591-3f0405c5f6bd';
const ADI = 'acc://probe.acme';
const PAGE = `${ADI}/book/1`;
const ACCOUNT = '0xe293e95Ec1471155d977448B99B0922C2828cAcB';
const KEY = 'a'.repeat(64);
const OTHER_KEY = 'b'.repeat(64);

interface Stub { url: string; close: () => Promise<void>; hits: string[] }

async function serve(handler: (req: http.IncomingMessage, res: http.ServerResponse, body: string) => void): Promise<Stub> {
  const hits: string[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      hits.push(`${req.method} ${(req.url ?? '').split('?')[0]}`);
      res.setHeader('content-type', 'application/json');
      handler(req, res, Buffer.concat(chunks).toString('utf8'));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  return {
    hits,
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); }),
  };
}

const send = (res: http.ServerResponse, status: number, body: unknown): void => { res.statusCode = status; res.end(JSON.stringify(body)); };

const chainEntry = (id: string, chainId: number, extra: Record<string, unknown> = {}) => ({
  id, chainId, family: 'evm', displayName: id, environment: 'testnet', explorer: 'https://x', status: 'live', contracts: {}, enabled: true, ...extra,
});

interface World {
  registry?: (accumulateUrl: string) => unknown;
  /** Status and body for GET /v1/billing/balance. */
  balance?: [number, unknown];
  /** Status and body for GET /v1/identity/:id. */
  identity?: [number, unknown];
  portfolio?: [number, unknown];
  /** How the Accumulate node answers; a function so a case can answer differently or not at all. */
  accumulate?: (res: http.ServerResponse) => void;
}

const goodIdentity = (over: Record<string, unknown> = {}) => ({
  id: ID, adi_url: ADI, book_url: `${ADI}/book`, key_page_url: PAGE, status: 'active', can_sign: true, credit_balance: 500,
  chain_accounts: [{ chain_id: '84532', address: ACCOUNT, status: 'deployed' }],
  balances: [{ chain_id: 'base-sepolia', address: ACCOUNT, token: 'ETH', balance: '0.0021' }],
  created_at: '2026-10-15T00:00:00Z',
  ...over,
});
const goodBalance = { currency: 'USD', available_usd: '5.000000', held_usd: '0', credit_limit_usd: '0', spendable_usd: '5.000000', remaining_usd: '5.000000', pending_intents: 0, status: 'active' };
const keyPageReply = (res: http.ServerResponse, account: Record<string, unknown> = {}): void => {
  res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { account: { type: 'keyPage', url: PAGE, keys: [{ publicKeyHash: KEY }], creditBalance: 1240, version: 2, acceptThreshold: 1, ...account } } }));
};

async function world(w: World = {}): Promise<{ client: CertenClient; gateway: Stub; accumulate: Stub; close: () => Promise<void> }> {
  const accumulate = await serve((_req, res) => (w.accumulate ?? ((r) => keyPageReply(r)))(res));
  const accumulateUrl = `${accumulate.url}/v3`;
  const gateway = await serve((req, res) => {
    const url = (req.url ?? '').split('?')[0];
    if (url === '/v1/chains') {
      return send(res, 200, w.registry?.(accumulateUrl) ?? {
        version: '2026-10-15', last_updated: 'x', count: 3,
        accumulate: { network: 'kermit', environment: 'testnet', api: accumulateUrl, explorer: 'https://e' },
        chains: [chainEntry('ethereum-sepolia', 11155111), chainEntry('base-sepolia', 84532), chainEntry('arbitrum-sepolia', 421614)],
      });
    }
    if (url === '/v1/billing/balance') return send(res, ...(w.balance ?? [200, goodBalance]));
    if (url === `/v1/identity/${ID}`) return send(res, ...(w.identity ?? [200, goodIdentity()]));
    if (url === '/v1/portfolio') return send(res, ...(w.portfolio ?? [200, { identities: [], total_chains: 0 }]));
    return send(res, 404, { message: `no route ${url}` });
  });
  const client = new CertenClient({ apiKey: 'test-key', baseUrl: gateway.url, maxRetries: 0 });
  return { client, gateway, accumulate, close: async () => { await gateway.close(); await accumulate.close(); } };
}

const base: ReadinessParams = { identityId: ID, chain: 'base-sepolia', keyHash: KEY };
const byName = (r: Readiness, name: string) => r.checks.find((c) => c.name === name)!;

async function readiness(w: World, params: Partial<ReadinessParams> = {}): Promise<{ r: Readiness; gateway: Stub; accumulate: Stub }> {
  const x = await world(w);
  try {
    return { r: await x.client.readiness({ ...base, ...params }), gateway: x.gateway, accumulate: x.accumulate };
  } finally {
    await x.close();
  }
}

describe('client.readiness(): the healthy case', () => {
  it('is ready, with every check in dependency order and the facts in the context', async () => {
    const { r } = await readiness({});
    expect(r.checks.map((c) => c.name)).toEqual([...READINESS_CHECKS]);
    expect(r.checks.map((c) => c.status)).toEqual(['ok', 'ok', 'ok', 'ok', 'ok', 'ok', 'ok', 'ok']);
    expect(r).toMatchObject({ ready: true, state: 'ready', first_blocker: null });
    expect(r.context).toMatchObject({ identity_id: ID, adi_url: ADI, key_page_url: PAGE, chain: 'base-sepolia', abstract_account: ACCOUNT, key_hash: KEY });
    expect(r.context.accumulate_rpc).toMatch(/\/v3$/);
    expect(byName(r, 'key page').detail).toMatch(/read from Accumulate .* not the gateway/);
  });

  it('costs one read each of the registry, the balance and the identity, plus one read of Accumulate: no portfolio when balances came with the identity', async () => {
    const { gateway, accumulate } = await readiness({});
    expect([...gateway.hits].sort()).toEqual(['GET /v1/billing/balance', 'GET /v1/chains', `GET /v1/identity/${ID}`]);
    expect(accumulate.hits).toEqual(['POST /v3']);
  });

  it('sends the CERTEN key to the gateway and never to Accumulate', async () => {
    const seen: Array<http.IncomingHttpHeaders> = [];
    const accumulate = await serve((req, res) => { seen.push(req.headers); keyPageReply(res); });
    const gateway = await serve((req, res) => {
      const url = (req.url ?? '').split('?')[0];
      if (url === '/v1/chains') return send(res, 200, { version: 'v', last_updated: 'x', count: 1, accumulate: { network: 'k', environment: 't', api: `${accumulate.url}/v3`, explorer: '' }, chains: [chainEntry('base-sepolia', 84532)] });
      if (url === '/v1/billing/balance') return send(res, 200, goodBalance);
      return send(res, 200, goodIdentity());
    });
    try {
      await new CertenClient({ apiKey: 'secret-key', baseUrl: gateway.url, maxRetries: 0 }).readiness(base);
      expect(seen).toHaveLength(1);
      expect(seen[0]['x-api-key']).toBeUndefined();
      expect(seen[0].authorization).toBeUndefined();
    } finally { await gateway.close(); await accumulate.close(); }
  });
});

describe('client.readiness(): what the gateway and the credential gate', () => {
  it('reports an unreachable gateway and marks everything after it skipped, so the list is still the same length', async () => {
    const client = new CertenClient({ apiKey: 'k', baseUrl: 'http://127.0.0.1:1', maxRetries: 0 });
    const r = await client.readiness(base);
    expect(r.checks).toHaveLength(READINESS_CHECKS.length);
    expect(r.checks[0]).toMatchObject({ name: 'gateway', status: 'fail', code: 'GATEWAY_UNREACHABLE' });
    expect(r.checks.slice(1).every((c) => c.status === 'skipped')).toBe(true);
    expect(r).toMatchObject({ ready: false, state: 'blocked', first_blocker: { name: 'gateway' } });
  });

  it('fails the credential on a 401 and skips what needs it', async () => {
    const { r } = await readiness({ balance: [401, { code: 'UNAUTHORIZED', error: 'bad key' }], identity: [401, { code: 'UNAUTHORIZED', error: 'bad key' }] });
    expect(byName(r, 'credential')).toMatchObject({ status: 'fail', code: 'CREDENTIAL_REJECTED' });
    expect(r.checks.slice(2).every((c) => c.status === 'skipped')).toBe(true);
    expect(r.checks).toHaveLength(READINESS_CHECKS.length);
  });

  it('accepts a key without billing:read, and says the balance is unknown rather than ok', async () => {
    const { r } = await readiness({ balance: [403, { code: 'FORBIDDEN', error: 'no scope' }] });
    expect(byName(r, 'credential').status).toBe('ok');
    expect(byName(r, 'gateway balance')).toMatchObject({ status: 'unknown', code: 'GATEWAY_BALANCE_UNREADABLE' });
    expect(r).toMatchObject({ ready: false, state: 'unconfirmed' });
  });

  it('does not call a credential it could not confirm "ok"', async () => {
    const { r } = await readiness({ balance: [500, { code: 'INTERNAL_ERROR', error: 'down' }] });
    expect(byName(r, 'credential')).toMatchObject({ status: 'unknown', code: 'CREDENTIAL_UNCONFIRMED' });
    expect(r.ready).toBe(false);
  });
});

describe('client.readiness(): the identity and the chain', () => {
  it('fails an identity the gateway does not have, and skips what depends on it', async () => {
    const { r } = await readiness({ identity: [404, { code: 'NOT_FOUND', error: 'no such identity' }] });
    expect(byName(r, 'identity')).toMatchObject({ status: 'fail', code: 'IDENTITY_NOT_FOUND' });
    expect(r.checks.slice(3).filter((c) => c.name !== 'gateway balance').every((c) => c.status === 'skipped')).toBe(true);
  });

  it('fails an identity that is still provisioning, with the time it takes, and one that errored', async () => {
    const provisioning = (await readiness({ identity: [200, goodIdentity({ status: 'provisioning', can_sign: null })] })).r;
    expect(byName(provisioning, 'identity')).toMatchObject({ status: 'fail', code: 'IDENTITY_PROVISIONING' });
    expect(byName(provisioning, 'identity').fix?.text).toMatch(/45-90 seconds/);
    const errored = (await readiness({ identity: [200, goodIdentity({ status: 'error', error_message: 'sponsor dry' })] })).r;
    expect(byName(errored, 'identity')).toMatchObject({ status: 'fail', code: 'IDENTITY_PROVISIONING_FAILED' });
    expect(byName(errored, 'identity').detail).toMatch(/sponsor dry/);
  });

  it('fails a chain the identity is not linked to, and names the fix without naming a CLI command', async () => {
    const { r } = await readiness({ identity: [200, goodIdentity({ chain_accounts: [] })] });
    expect(byName(r, 'chain')).toMatchObject({ status: 'fail', code: 'CHAIN_NOT_LINKED' });
    expect(JSON.stringify(r)).not.toMatch(/certen /);
  });

  it('tells a chain the gateway does not list from one it lists and has switched off', async () => {
    const unlisted = (await readiness({}, { chain: 'optimism-sepolia' })).r;
    expect(byName(unlisted, 'chain').code).toBe('CHAIN_RETIRED');
    const noSuchChain = (await readiness({ registry: (api) => ({ version: 'v', last_updated: 'x', count: 1, accumulate: { network: 'k', environment: 't', api, explorer: '' }, chains: [chainEntry('ethereum-sepolia', 11155111)] }) })).r;
    expect(byName(noSuchChain, 'chain')).toMatchObject({ status: 'fail', code: 'CHAIN_NOT_SERVED' });
    const off = (await readiness({ registry: (api) => ({ version: 'v', last_updated: 'x', count: 1, accumulate: { network: 'k', environment: 't', api, explorer: '' }, chains: [chainEntry('base-sepolia', 84532, { enabled: false })] }) })).r;
    expect(byName(off, 'chain')).toMatchObject({ status: 'fail', code: 'CHAIN_DISABLED' });
  });

  it('honours the chains the caller has configured', async () => {
    const { r } = await readiness({}, { configuredChains: ['ethereum-sepolia'] });
    expect(byName(r, 'chain')).toMatchObject({ status: 'fail', code: 'CHAIN_NOT_ENABLED' });
  });

  it('accepts a numeric chain id for the same chain', async () => {
    const { r } = await readiness({}, { chain: '84532' });
    expect(r.context.chain).toBe('base-sepolia');
    expect(byName(r, 'chain').status).toBe('ok');
  });
});

describe('client.readiness(): the key page, read twice', () => {
  it('is ok when Accumulate lists the key and the gateway agrees', async () => {
    const { r } = await readiness({});
    expect(byName(r, 'key page')).toMatchObject({ status: 'ok', data: { independent: 'holds', gateway_can_sign: true, keys_on_page: 1, accept_threshold: 1 } });
  });

  it('is a BLOCKER with its own code when Accumulate shows the key but the gateway says it cannot sign', async () => {
    const { r } = await readiness({ identity: [200, goodIdentity({ can_sign: false })] });
    expect(byName(r, 'key page')).toMatchObject({ status: 'fail', code: 'KEY_PAGE_DISAGREES' });
    expect(r.state).toBe('blocked');
  });

  it('is a BLOCKER with its own code when the gateway says it can sign but Accumulate\'s page does not list the key', async () => {
    const { r } = await readiness({ accumulate: (res) => keyPageReply(res, { keys: [{ publicKeyHash: OTHER_KEY }] }) });
    expect(byName(r, 'key page')).toMatchObject({ status: 'fail', code: 'KEY_PAGE_DISAGREES' });
    expect(byName(r, 'key page').detail).toMatch(/different key/);
  });

  it('says the key is missing, without calling it a disagreement, when the gateway also says it cannot sign', async () => {
    const { r } = await readiness({ identity: [200, goodIdentity({ can_sign: false })], accumulate: (res) => keyPageReply(res, { keys: [{ publicKeyHash: OTHER_KEY }] }) });
    expect(byName(r, 'key page')).toMatchObject({ status: 'fail', code: 'KEY_PAGE_LACKS_KEY' });
  });

  it('is UNKNOWN, and the list unconfirmed, when Accumulate cannot be read: the gateway\'s word alone is not enough', async () => {
    const { r } = await readiness({ accumulate: (res) => { res.statusCode = 503; res.end('{}'); } });
    expect(byName(r, 'key page')).toMatchObject({ status: 'unknown', code: 'KEY_PAGE_UNCONFIRMED', data: { independent: 'unreadable', gateway_can_sign: true } });
    expect(byName(r, 'key page').detail).toMatch(/one party's word/);
    expect(r).toMatchObject({ ready: false, state: 'unconfirmed', first_blocker: { name: 'key page' } });
  });

  it('fails on the gateway\'s word when it says cannot sign and Accumulate cannot be read', async () => {
    const { r } = await readiness({ identity: [200, goodIdentity({ can_sign: false })], accumulate: (res) => { res.statusCode = 503; res.end('{}'); } });
    expect(byName(r, 'key page')).toMatchObject({ status: 'fail', code: 'IDENTITY_CANNOT_SIGN' });
  });

  it('reports a node with no record of the page as unreadable, not as the key being absent', async () => {
    const { r } = await readiness({ accumulate: (res) => res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -1, message: 'key page not found' } })) });
    expect(byName(r, 'key page')).toMatchObject({ status: 'unknown' });
    expect(byName(r, 'key page').fix?.text).toMatch(/no such account/);
  });

  it('is unknown when the gateway can say nothing either', async () => {
    const { r } = await readiness({ identity: [200, goodIdentity({ can_sign: null })], accumulate: (res) => { res.statusCode = 503; res.end('{}'); } });
    expect(byName(r, 'key page').status).toBe('unknown');
    expect(byName(r, 'key page').detail).toMatch(/could not say either/);
  });

  it('warns, and does not claim the page holds a key, when no key was given to compare', async () => {
    const { r, accumulate } = await readiness({}, { keyHash: undefined });
    expect(byName(r, 'key page')).toMatchObject({ status: 'warn', code: 'KEY_PAGE_NOT_INDEPENDENTLY_CHECKED', data: { independent: 'not_checked' } });
    expect(byName(r, 'key page').detail).not.toMatch(/holds your key/);
    expect(accumulate.hits).toEqual([]);
  });

  it('prefers the endpoint it was given over the one the registry advertises', async () => {
    const other = await serve((_req, res) => keyPageReply(res, { keys: [{ publicKeyHash: KEY }], creditBalance: 7 }));
    try {
      const { r, accumulate } = await readiness({}, { accumulateRpc: `${other.url}/v3` });
      expect(other.hits).toEqual(['POST /v3']);
      expect(accumulate.hits).toEqual([]);
      expect(r.context.accumulate_rpc).toBe(`${other.url}/v3`);
      expect(byName(r, 'accumulate credits').data).toMatchObject({ credits: 7, source: 'accumulate' });
    } finally { await other.close(); }
  });

  it('is unknown, not skipped, when a key was given and there is no endpoint anywhere', async () => {
    const { r } = await readiness({ registry: () => ({ version: 'v', last_updated: 'x', count: 1, accumulate: {}, chains: [chainEntry('base-sepolia', 84532)] }) });
    expect(byName(r, 'key page')).toMatchObject({ status: 'unknown' });
    expect(byName(r, 'key page').detail).toMatch(/advertises no Accumulate endpoint/);
  });

  it('mentions a multi-signature page, because the key alone will not execute', async () => {
    const { r } = await readiness({ accumulate: (res) => keyPageReply(res, { keys: [{ publicKeyHash: KEY }, { publicKeyHash: OTHER_KEY }], acceptThreshold: 2 }) });
    expect(byName(r, 'key page').status).toBe('ok');
    expect(byName(r, 'key page').detail).toMatch(/2 signatures are needed/);
  });

  it('fails an identity with no key page on record', async () => {
    const { r } = await readiness({ identity: [200, goodIdentity({ key_page_url: null })] });
    expect(byName(r, 'key page')).toMatchObject({ status: 'fail', code: 'KEY_PAGE_MISSING' });
  });
});

describe('client.readiness(): credits', () => {
  it('fails only on a page with none, and reads Accumulate\'s number before the gateway\'s', async () => {
    const empty = (await readiness({ accumulate: (res) => keyPageReply(res, { creditBalance: 0 }) })).r;
    expect(byName(empty, 'accumulate credits')).toMatchObject({ status: 'fail', code: 'ACCUMULATE_CREDITS_EMPTY' });
    const ok = (await readiness({ accumulate: (res) => keyPageReply(res, { creditBalance: 1240 }) })).r;
    expect(byName(ok, 'accumulate credits')).toMatchObject({ status: 'ok', data: { credits: 1240, source: 'accumulate', gateway_credits: 500 } });
    expect(byName(ok, 'accumulate credits').detail).toMatch(/gateway reports 500/);
  });

  it('falls back to the gateway\'s number, and says so, when Accumulate cannot be read', async () => {
    const { r } = await readiness({ accumulate: (res) => { res.statusCode = 503; res.end('{}'); } });
    expect(byName(r, 'accumulate credits')).toMatchObject({ status: 'ok', data: { credits: 500, source: 'gateway' } });
  });

  it('is unknown when neither says', async () => {
    const { r } = await readiness({ identity: [200, goodIdentity({ credit_balance: undefined })], accumulate: (res) => { res.statusCode = 503; res.end('{}'); } });
    expect(byName(r, 'accumulate credits')).toMatchObject({ status: 'unknown', code: 'CREDITS_UNREADABLE' });
  });
});

describe('client.readiness(): the organization\'s balance', () => {
  it('fails an empty or fully committed balance, and a suspended account', async () => {
    const committed = (await readiness({ balance: [200, { ...goodBalance, remaining_usd: '-0.2', pending_intents: 3 }] })).r;
    expect(byName(committed, 'gateway balance')).toMatchObject({ status: 'fail', code: 'GATEWAY_BALANCE_EMPTY' });
    expect(byName(committed, 'gateway balance').detail).toMatch(/3 pending intent/);
    const suspended = (await readiness({ balance: [200, { ...goodBalance, status: 'suspended', suspended_reason: 'unpaid' }] })).r;
    expect(byName(suspended, 'gateway balance')).toMatchObject({ status: 'fail', code: 'GATEWAY_ACCOUNT_INACTIVE' });
    const legacy = (await readiness({ balance: [200, { ...goodBalance, remaining_usd: undefined, spendable_usd: '0.000000' }] })).r;
    expect(byName(legacy, 'gateway balance').status).toBe('fail');
  });

  it('reads a balance it cannot parse as unknown', async () => {
    const { r } = await readiness({ balance: [200, { ...goodBalance, remaining_usd: 'lots' }] });
    expect(byName(r, 'gateway balance').status).toBe('unknown');
  });
});

describe('client.readiness(): gas', () => {
  it('is ok, and calls its gas share an estimate, when the balance covers the amount plus the reserve', async () => {
    const { r } = await readiness({}, { amount: '0.001' });
    const gas = byName(r, 'gas');
    expect(gas.status).toBe('ok');
    expect(gas.detail).toMatch(/an estimate/);
    expect(gas.data).toMatchObject({ balance: '0.0021', amount: '0.001', gas_reserve: '0.0001', needed: '0.0011', gas_reserve_is_estimate: true, abstract_account: ACCOUNT });
  });

  it('fails an account that holds nothing, with the address and the faucet, and the same code the funding guard uses', async () => {
    const { r } = await readiness({ identity: [200, goodIdentity({ balances: [{ chain_id: 'base-sepolia', address: ACCOUNT, token: 'ETH', balance: '0' }] })] }, { amount: '0.0005' });
    const gas = byName(r, 'gas');
    expect(gas).toMatchObject({ status: 'fail', code: 'ABSTRACT_ACCOUNT_UNFUNDED' });
    expect(gas.fix?.text).toContain(ACCOUNT);
    expect(gas.fix?.text).toMatch(/at least 0\.0006 ETH/);
    expect(gas.fix?.url).toMatch(/faucet/);
    expect(r.state).toBe('blocked');
  });

  it('fails an account that cannot cover the amount plus the reserve, and says how much more', async () => {
    const { r } = await readiness({ identity: [200, goodIdentity({ balances: [{ chain_id: 'base-sepolia', address: ACCOUNT, token: 'ETH', balance: '0.001' }] })] }, { amount: '0.001' });
    expect(byName(r, 'gas')).toMatchObject({ status: 'fail', code: 'ABSTRACT_ACCOUNT_UNDERFUNDED', data: { shortfall: '0.0001', shortfall_kind: 'gas' } });
    expect(byName(r, 'gas').fix?.text).toMatch(/at least 0\.0001 more ETH/);
  });

  it('fails an account that cannot cover the amount itself, as a fact and not an estimate', async () => {
    const { r } = await readiness({ identity: [200, goodIdentity({ balances: [{ chain_id: 'base-sepolia', address: ACCOUNT, token: 'ETH', balance: '0.0004' }] })] }, { amount: '0.001' });
    expect(byName(r, 'gas')).toMatchObject({ status: 'fail', data: { shortfall_kind: 'amount' } });
    expect(byName(r, 'gas').detail).toMatch(/less than the 0\.001 ETH to be moved/);
  });

  it('does not count a token amount against the gas balance', async () => {
    const { r } = await readiness({}, { amount: '5000', tokenSymbol: 'USDC' });
    expect(byName(r, 'gas').status).toBe('ok');
  });

  it('is UNKNOWN, never ok, for a balance the gateway could not read, and for an account it has no balance for yet', async () => {
    const unreadable = (await readiness({ identity: [200, goodIdentity({ balances: [{ chain_id: 'base-sepolia', address: ACCOUNT, token: '', balance: 'unavailable' }] })] })).r;
    expect(byName(unreadable, 'gas')).toMatchObject({ status: 'unknown', code: 'ABSTRACT_ACCOUNT_FUNDING_UNVERIFIABLE' });
    expect(unreadable).toMatchObject({ ready: false, state: 'unconfirmed' });
    const none = (await readiness({ identity: [200, goodIdentity({ balances: [] })] })).r;
    expect(byName(none, 'gas')).toMatchObject({ status: 'unknown' });
    expect(byName(none, 'gas').detail).toMatch(/not deployed or not indexed/);
  });

  it('warns that nothing was estimated on a chain with no estimate, and checks the amount alone', async () => {
    const { r } = await readiness({
      registry: (api) => ({ version: 'v', last_updated: 'x', count: 1, accumulate: { network: 'k', environment: 't', api, explorer: '' }, chains: [chainEntry('telcoin-adiri', 2017)] }),
      identity: [200, goodIdentity({ chain_accounts: [{ chain_id: 'telcoin-adiri', address: ACCOUNT, status: 'deployed' }], balances: [{ chain_id: 'telcoin-adiri', address: ACCOUNT, token: 'TEL', balance: '5' }] })],
    }, { chain: 'telcoin-adiri', amount: '1' });
    expect(byName(r, 'gas')).toMatchObject({ status: 'warn', code: 'GAS_NOT_ESTIMATED' });
    expect(r.ready).toBe(true);
  });

  it('takes the caller\'s reserve over the catalogue\'s', async () => {
    const { r } = await readiness({}, { amount: '0.001', gasReserve: '0.01' });
    expect(byName(r, 'gas')).toMatchObject({ status: 'fail', data: { gas_reserve: '0.01' } });
  });

  it('reads the portfolio only when the identity read carried no balances at all (an older gateway)', async () => {
    const portfolio = { identities: [{ id: ID, adi_url: ADI, status: 'active', credit_balance: 1, pending_actions: 0, chains: [{ chain_id: 'base-sepolia', address: ACCOUNT, deployed: true, balances: [{ token: 'ETH', balance: '0.5' }] }] }], total_chains: 1 };
    const { r, gateway } = await readiness({ identity: [200, goodIdentity({ balances: undefined })], portfolio: [200, portfolio] });
    expect(gateway.hits).toContain('GET /v1/portfolio');
    expect(byName(r, 'gas').status).toBe('ok');
    const { gateway: g2 } = await readiness({});
    expect(g2.hits).not.toContain('GET /v1/portfolio');
  });
});

describe('client.readiness(): scope and contract', () => {
  it('scope "context" returns only what depends on the identity and chain, and makes no billing read', async () => {
    const { r, gateway } = await readiness({}, { scope: 'context' });
    expect(r.checks.map((c) => c.name)).toEqual([...CONTEXT_CHECKS]);
    expect(gateway.hits).not.toContain('GET /v1/billing/balance');
    expect(r.ready).toBe(true);
  });

  it('never throws for a failed check, only for a malformed call', async () => {
    const client = new CertenClient({ apiKey: 'k', baseUrl: 'http://127.0.0.1:1', maxRetries: 0 });
    await expect(client.readiness(base)).resolves.toMatchObject({ ready: false });
    await expect(client.readiness({ ...base, identityId: '' })).rejects.toMatchObject({ code: 'MISSING_IDENTITY' });
    await expect(client.readiness({ ...base, chain: '' })).rejects.toMatchObject({ code: 'MISSING_CHAIN' });
  });

  it('is never ready over an unknown or skipped check, whatever else is ok', async () => {
    const { r } = await readiness({ accumulate: (res) => { res.statusCode = 500; res.end('{}'); } });
    expect(r.checks.filter((c) => c.status === 'ok').length).toBeGreaterThan(5);
    expect(r.ready).toBe(false);
    expect(r.state).toBe('unconfirmed');
  });

  it('puts the first failure, not the first unknown, in first_blocker', async () => {
    const { r } = await readiness({
      accumulate: (res) => { res.statusCode = 500; res.end('{}'); },
      identity: [200, goodIdentity({ balances: [{ chain_id: 'base-sepolia', address: ACCOUNT, token: 'ETH', balance: '0' }] })],
    });
    expect(byName(r, 'key page').status).toBe('unknown');
    expect(r.first_blocker?.name).toBe('gas');
    expect(r.state).toBe('blocked');
  });

  it('every non-ok check carries a machine-readable code, and every failed one a fix', async () => {
    const worlds: World[] = [
      { identity: [200, goodIdentity({ can_sign: false })] },
      { accumulate: (res) => { res.statusCode = 500; res.end('{}'); } },
      { balance: [403, {}] },
      { identity: [404, {}] },
      { identity: [200, goodIdentity({ chain_accounts: [] })] },
    ];
    for (const w of worlds) {
      const { r } = await readiness(w);
      for (const c of r.checks.filter((x) => x.status === 'fail' || x.status === 'unknown' || x.status === 'warn')) {
        expect(c.code, `${c.name}: ${c.detail}`).toMatch(/^[A-Z][A-Z0-9_]+$/);
        expect(c.fix?.text, c.name).toBeTruthy();
      }
    }
  });
});

describe('client.readiness(): a registry the caller already holds', () => {
  it('doctor() does not hand back the registry unless asked, so its report is exactly what it was', async () => {
    const x = await world({});
    try {
      const plain = await x.client.doctor();
      expect('registry' in plain).toBe(false);
      const asked = await x.client.doctor({ includeRegistry: true });
      expect(asked.registry?.accumulate.api).toMatch(/\/v3$/);
    } finally { await x.close(); }
  });

  it('is not read a second time in scope "context", and is always read in scope "full" (the gateway check IS that read)', async () => {
    const x = await world({});
    try {
      const registry = (await x.client.doctor({ includeRegistry: true })).registry!;
      const before = x.gateway.hits.filter((h) => h === 'GET /v1/chains').length;
      const ctx = await x.client.readiness({ ...base, scope: 'context', registry });
      expect(ctx.ready).toBe(true);
      expect(x.gateway.hits.filter((h) => h === 'GET /v1/chains').length).toBe(before);
      await x.client.readiness({ ...base, scope: 'full', registry });
      expect(x.gateway.hits.filter((h) => h === 'GET /v1/chains').length).toBe(before + 1);
    } finally { await x.close(); }
  });
});
