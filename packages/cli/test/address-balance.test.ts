import { describe, it, expect, afterEach } from 'vitest';
import { certen, envelope, newHome } from './helpers/run-cli.js';
import { startStub, homeFor, API_KEY, type Stub, type Seen } from './helpers/stub-gateway.js';

/**
 * `certen balance <address> [--chain <chain>]`: the native balance of any EVM address, as the gateway's node answers it.
 *
 * `balance` with no argument is the organization's balance at the gateway and is untouched. What is pinned for the new reading:
 *
 * - a mistyped address, or no chain to read it on, costs a message and NOTHING reaches the gateway;
 * - a node that did not answer is a failure the caller can retry, and is never drawn as a balance of zero;
 * - an empty account IS a zero, and is shown as one: the two are different things and stay different;
 * - the API key is sent to the gateway and printed nowhere.
 */

const ADDRESS = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed'; // an EIP-55 vector: valid and mixed-case
const read = (extra: Record<string, unknown> = {}) => ({
  chain: 'base-sepolia', chain_id: 84532, address: ADDRESS, balance: '0.25', symbol: 'ETH', read_at: '2026-10-16T00:00:00Z', ...extra,
});

let stub: Stub | undefined;
afterEach(async () => { await stub?.close(); stub = undefined; });

const balancePath = (chain: string, address = ADDRESS): string => `/v1/chains/${chain}/addresses/${address}/balance`;
const reads = (s: Stub): Seen[] => s.calls().filter((r) => r.path.endsWith('/balance') && r.path.startsWith('/v1/chains/'));

async function serve(reply: (r: Seen) => { status?: number; body?: unknown } | undefined = () => ({ body: read() })): Promise<Stub> {
  stub = await startStub((r) => (r.path.startsWith('/v1/chains/') ? reply(r) : r.path === '/v1/billing/balance' ? {
    body: {
      currency: 'USD', available_usd: '5.000000', held_usd: '0.000000', credit_limit_usd: '0.000000', spendable_usd: '5.000000',
      remaining_usd: '5.000000', pending_intents: 0, status: 'active',
    },
  } : undefined));
  return stub;
}

describe('a balance read', () => {
  it('asks the gateway for exactly that address on that chain, with the key, and shows the balance and the unit', async () => {
    const g = await serve();
    const home = homeFor(g.url);
    const r = await certen(['balance', ADDRESS, '--chain', 'base-sepolia'], { home, apiUrl: g.url });
    expect(r.code, r.stderr).toBe(0);
    expect(reads(g)).toHaveLength(1);
    expect(reads(g)[0]!.method).toBe('GET');
    expect(reads(g)[0]!.path).toBe(balancePath('base-sepolia'));
    expect(reads(g)[0]!.headers['x-api-key']).toBe(API_KEY);
    expect(r.stdout).toContain(`${ADDRESS} on base-sepolia`);
    expect(r.stdout).toMatch(/balance\s+0\.25 ETH/);
    expect(r.stdout).toContain('read at  2026-10-16T00:00:00Z');
    // The reading is the gateway's, and says so.
    expect(r.stdout).toContain('the gateway\'s reading through its own node');
  });

  it('--json is the gateway\'s answer in the envelope, and nothing human on stdout', async () => {
    const g = await serve();
    const r = await certen(['--json', 'balance', ADDRESS, '--chain', 'base-sepolia'], { home: homeFor(g.url), apiUrl: g.url });
    expect(r.code, r.stderr).toBe(0);
    expect(envelope(r)).toEqual({ ok: true, data: read() });
  });

  it('an empty account is a zero, shown as a zero (a successful read of nothing)', async () => {
    const g = await serve(() => ({ body: read({ balance: '0' }) }));
    const home = homeFor(g.url);
    const human = await certen(['balance', ADDRESS, '--chain', 'base-sepolia'], { home, apiUrl: g.url });
    expect(human.code, human.stderr).toBe(0);
    expect(human.stdout).toMatch(/balance\s+0 ETH/);
    const json = await certen(['--json', 'balance', ADDRESS, '--chain', 'base-sepolia'], { home, apiUrl: g.url });
    expect(envelope(json).data!.balance).toBe('0');
  });

  it('a lower-case address is sent as typed (it carries no checksum to get wrong), and the answer names the checksummed one', async () => {
    const g = await serve();
    const lower = ADDRESS.toLowerCase();
    const r = await certen(['balance', lower, '--chain', 'base-sepolia'], { home: homeFor(g.url), apiUrl: g.url });
    expect(r.code, r.stderr).toBe(0);
    expect(reads(g)[0]!.path).toBe(balancePath('base-sepolia', lower));
    expect(r.stdout).toContain(ADDRESS);
  });

  it('never prints the API key, on either channel', async () => {
    const g = await serve();
    const home = homeFor(g.url);
    for (const args of [['balance', ADDRESS, '--chain', 'base-sepolia'], ['--json', 'balance', ADDRESS, '--chain', 'base-sepolia']]) {
      const r = await certen(args, { home, apiUrl: g.url });
      expect(r.stdout + r.stderr).not.toContain(API_KEY);
      expect(r.stdout + r.stderr).not.toContain('ck_live');
    }
  });
});

describe('the chain', () => {
  it('defaults from the context, and says so', async () => {
    const g = await serve();
    const home = homeFor(g.url, { contextChain: 'base-sepolia', chains: ['base-sepolia', 'arbitrum-sepolia'] });
    const r = await certen(['balance', ADDRESS], { home, apiUrl: g.url });
    expect(r.code, r.stderr).toBe(0);
    expect(reads(g)[0]!.path).toBe(balancePath('base-sepolia'));
    expect(r.stderr).toContain('using chain base-sepolia (from profile "default")');
  });

  it('is the identity\'s only chain when nothing else names one', async () => {
    const g = await serve();
    const r = await certen(['balance', ADDRESS], { home: homeFor(g.url), apiUrl: g.url });
    expect(r.code, r.stderr).toBe(0);
    expect(reads(g)[0]!.path).toBe(balancePath('base-sepolia'));
  });

  it('a flag wins over the context', async () => {
    const g = await serve(() => ({ body: read({ chain: 'arbitrum-sepolia', chain_id: 421614 }) }));
    const home = homeFor(g.url, { contextChain: 'base-sepolia' });
    const r = await certen(['balance', ADDRESS, '--chain', 'arbitrum-sepolia'], { home, apiUrl: g.url });
    expect(r.code, r.stderr).toBe(0);
    expect(reads(g)[0]!.path).toBe(balancePath('arbitrum-sepolia'));
  });

  it('with none to use is a usage error and sends nothing', async () => {
    const g = await serve();
    const r = await certen(['--json', 'balance', ADDRESS], { home: homeFor(g.url, { identity: false }), apiUrl: g.url });
    expect(r.code).toBe(2);
    expect(envelope(r).error).toMatchObject({ code: 'MISSING_CHAIN' });
    expect(g.seen).toHaveLength(0);
  });

  it('a chain this CLI does not target is refused before any request', async () => {
    const g = await serve();
    const r = await certen(['--json', 'balance', ADDRESS, '--chain', 'nowhere'], { home: homeFor(g.url), apiUrl: g.url });
    expect(r.code).toBe(2);
    expect(g.seen).toHaveLength(0);
  });
});

describe('bad input costs a message and no request', () => {
  const wrongCase = ADDRESS.replace('5aA', '5AA'); // one letter flipped: the checksum no longer holds
  it.each([
    ['a checksum that does not hold', wrongCase],
    ['too short', '0x123'],
    ['a name, not an address', 'vitalik.eth'],
    ['two characters too long', `${ADDRESS}00`],
    ['not hex', `0x${'zz'.repeat(20)}`],
  ])('%s: exit 2, INVALID_ADDRESS, nothing reached the gateway', async (_label, address) => {
    const g = await serve();
    const home = homeFor(g.url);
    const r = await certen(['--json', 'balance', address, '--chain', 'base-sepolia'], { home, apiUrl: g.url });
    expect(r.code).toBe(2);
    const e = envelope(r);
    expect(e.ok).toBe(false);
    expect(e.error).toMatchObject({ code: 'INVALID_ADDRESS', retryable: false });
    expect(e.error!.next).toBe('certen balance --help');
    expect(g.seen).toHaveLength(0);
  });

  it('a checksum error names the capitalisation that would be accepted', async () => {
    const g = await serve();
    const r = await certen(['--json', 'balance', wrongCase, '--chain', 'base-sepolia'], { home: homeFor(g.url), apiUrl: g.url });
    expect(envelope(r).error!.message).toContain(ADDRESS);
    expect(g.seen).toHaveLength(0);
  });

  it('bad input is refused before the credential is even read', async () => {
    const g = await serve();
    // A home with no credential at all: reading it would be NO_API_KEY.
    const bare = newHome();
    const bad = await certen(['--json', 'balance', '0x123', '--chain', 'base-sepolia'], { home: bare, apiUrl: g.url });
    expect(envelope(bad).error!.code).toBe('INVALID_ADDRESS');
    const good = await certen(['--json', 'balance', ADDRESS, '--chain', 'base-sepolia'], { home: bare, apiUrl: g.url });
    expect(envelope(good).error!.code).toBe('NO_API_KEY');
    expect(g.seen).toHaveLength(0);
  });
});

describe('a node that did not answer', () => {
  it('is a failure that may be retried, and is never a balance of zero', async () => {
    const g = await serve(() => ({ status: 503, body: { error: 'the node did not answer', code: 'BALANCE_UNREADABLE' } }));
    const home = homeFor(g.url);
    const json = await certen(['--json', 'balance', ADDRESS, '--chain', 'base-sepolia'], { home, apiUrl: g.url });
    expect(json.code).toBe(1);
    const e = envelope(json);
    expect(e.ok).toBe(false);
    expect(e.data).toBeUndefined();
    expect(e.error).toMatchObject({ code: 'BALANCE_UNREADABLE', retryable: true, status: 503, next: 'certen balance <address> --chain <chain>' });

    const human = await certen(['balance', ADDRESS, '--chain', 'base-sepolia'], { home, apiUrl: g.url });
    expect(human.code).toBe(1);
    expect(human.stderr).toContain('NOT a balance of zero');
    expect(human.stdout).not.toMatch(/balance\s+0/);
    expect(human.stdout).not.toContain('ETH');
  }, 60_000);

  it('a gateway older than this CLI is said to be, with the command that diagnoses it', async () => {
    const g = await serve(() => ({ status: 404, body: { message: `Route GET:${balancePath('base-sepolia')} not found`, error: 'Not Found', statusCode: 404 } }));
    const r = await certen(['--json', 'balance', ADDRESS, '--chain', 'base-sepolia'], { home: homeFor(g.url), apiUrl: g.url });
    expect(r.code).toBe(1);
    expect(envelope(r).error).toMatchObject({ code: 'ENDPOINT_NOT_ON_GATEWAY', next: 'certen doctor' });
  });
});

describe('balance with no address is what it always was', () => {
  it('still reads the gateway balance, in dollars, from the billing route', async () => {
    const g = await serve();
    const r = await certen(['balance'], { home: homeFor(g.url), apiUrl: g.url });
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain('Available          $5.00');
    expect(g.calls().map((c) => c.path)).toEqual(['/v1/billing/balance']);
  });

  it('--chain with no address is a usage error: it says where to read an address, and there is none', async () => {
    const g = await serve();
    const r = await certen(['--json', 'balance', '--chain', 'base-sepolia'], { home: homeFor(g.url), apiUrl: g.url });
    expect(r.code).toBe(2);
    expect(envelope(r).error!.message).toContain('certen balance <address> --chain <chain>');
    expect(g.seen).toHaveLength(0);
  });
});
