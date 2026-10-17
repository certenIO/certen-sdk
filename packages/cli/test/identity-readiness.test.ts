import { describe, it, expect, afterEach } from 'vitest';
import { certen, envelope } from './helpers/run-cli.js';
import { startStub, homeFor, WHO, API_KEY, type Stub, type Seen } from './helpers/stub-gateway.js';
import { factsLines } from '../src/identity-facts.js';

/**
 * `certen identity readiness [ref] [--chain <chain>]`: the gateway's facts about an identity, from one read, section by section.
 *
 * It is NOT `certen status`. That command reaches a verdict from several reads and the key page on Accumulate itself; this one prints what the
 * gateway states and judges nothing. What is pinned is what a verdict smuggled in would cost: a section that could not be read shown as a yes
 * or a zero, or the word "ready" appearing where a fact should be.
 */

const FACTS = {
  identity: { id: WHO.id, adi_url: WHO.adi, key_page_url: WHO.keyPage, status: 'active', error_message: null },
  can_sign: { state: 'ok', value: true },
  credits: { value: 50000, source: 'key_page' },
  chain: null,
  org: { state: 'ok', spendable_usd: '5.000000', remaining_usd: '4.250000', enforcing: false, status: 'active' },
  read_at: '2026-10-16T00:00:00Z',
};
const WITH_CHAIN = {
  ...FACTS,
  chain: {
    chain: 'base-sepolia', chain_id: 84532,
    account: { state: 'deployed', address: WHO.account },
    balance: { state: 'ok', balance: '0', symbol: 'ETH', read_at: '2026-10-16T00:00:00Z' },
  },
};

let stub: Stub | undefined;
afterEach(async () => { await stub?.close(); stub = undefined; });

async function serve(body: unknown = FACTS, status = 200): Promise<Stub> {
  stub = await startStub((r) => (r.path === `/v1/identity/${WHO.id}/readiness` ? { status, body } : undefined));
  return stub;
}
const reads = (s: Stub): Seen[] => s.calls().filter((r) => r.path.endsWith('/readiness'));
const text = (r: { stdout: string; stderr: string }): string => `${r.stdout}\n${r.stderr}`;

describe('one read, the identity from the context', () => {
  it('makes exactly one request, without a chain unless one is asked for', async () => {
    const g = await serve();
    const r = await certen(['identity', 'readiness'], { home: homeFor(g.url), apiUrl: g.url });
    expect(r.code, r.stderr).toBe(0);
    expect(g.calls()).toHaveLength(1);
    expect(reads(g)[0]!.method).toBe('GET');
    expect(reads(g)[0]!.path).toBe(`/v1/identity/${WHO.id}/readiness`);
    expect(reads(g)[0]!.query).toBe('');
    expect(reads(g)[0]!.headers['x-api-key']).toBe(API_KEY);
    expect(r.stderr).toContain(`using identity ${WHO.adi}`);
  });

  it('--chain asks for that chain\'s account and balance, and the section is printed', async () => {
    const g = await serve(WITH_CHAIN);
    const r = await certen(['identity', 'readiness', '--chain', 'base-sepolia'], { home: homeFor(g.url), apiUrl: g.url });
    expect(r.code, r.stderr).toBe(0);
    expect(reads(g)[0]!.query).toBe('chain=base-sepolia');
    expect(r.stdout).toContain(`account deployed at ${WHO.account}`);
    // An empty account is an empty account: a zero that was read.
    expect(r.stdout).toContain('balance 0 ETH');
  });

  it('takes the identity as an argument, and the chain from the profile when one is set there', async () => {
    const g = await serve(WITH_CHAIN);
    const home = homeFor(g.url, { contextChain: 'base-sepolia', identity: false });
    const r = await certen(['identity', 'readiness', WHO.id], { home, apiUrl: g.url });
    expect(r.code, r.stderr).toBe(0);
    expect(reads(g)[0]!.query).toBe('chain=base-sepolia');
    expect(r.stderr).toContain('using chain base-sepolia (from profile "default")');
  });

  it('a chain is not worked out from the identity\'s links: the facts it was not asked for are not read', async () => {
    const g = await serve();
    const r = await certen(['identity', 'readiness'], { home: homeFor(g.url, { chains: ['base-sepolia'] }), apiUrl: g.url });
    expect(reads(g)[0]!.query).toBe('');
    expect(r.code, r.stderr).toBe(0);
  });

  it('--json is the gateway\'s answer, whole', async () => {
    const g = await serve(WITH_CHAIN);
    const r = await certen(['--json', 'identity', 'readiness', '--chain', 'base-sepolia'], { home: homeFor(g.url), apiUrl: g.url });
    expect(r.code, r.stderr).toBe(0);
    expect(envelope(r)).toEqual({ ok: true, data: WITH_CHAIN });
  });

  it('a chain this CLI does not target is refused before any request', async () => {
    const g = await serve();
    const r = await certen(['--json', 'identity', 'readiness', '--chain', 'nowhere'], { home: homeFor(g.url), apiUrl: g.url });
    expect(r.code).toBe(2);
    expect(g.seen).toHaveLength(0);
  });

  it('never prints the API key', async () => {
    const g = await serve(WITH_CHAIN);
    const r = await certen(['identity', 'readiness', '--chain', 'base-sepolia'], { home: homeFor(g.url), apiUrl: g.url });
    expect(text(r)).not.toContain(API_KEY);
  });
});

describe('facts, and no verdict', () => {
  it('states each section and never says the identity is "ready" or that you can send', async () => {
    const g = await serve(WITH_CHAIN);
    const r = await certen(['identity', 'readiness', '--chain', 'base-sepolia'], { home: homeFor(g.url), apiUrl: g.url });
    expect(r.stdout).toContain(`Facts about ${WHO.adi}`);
    expect(r.stdout).toContain('status active');
    expect(r.stdout).toContain('the identity\'s key is on its key page: yes');
    expect(r.stdout).toContain('50000   (read from the key page)');
    expect(r.stdout).toContain('spendable $5.00, remaining $4.25');
    expect(r.stdout).toContain('a shortfall is only recorded');
    expect(r.stdout).toContain('These are facts, not a verdict');
    expect(text(r)).not.toMatch(/\bready\b/i);
    expect(text(r)).not.toMatch(/\bcan sign\b/i);
  });

  it('a key that is NOT on the key page is NO, in capitals', () => {
    const lines = factsLines({ ...FACTS, can_sign: { state: 'ok', value: false } } as never).join('\n');
    expect(lines).toContain('the identity\'s key is on its key page: NO');
  });

  it('a key page that could not be read is unknown: not a yes, not a no', () => {
    const lines = factsLines({ ...FACTS, can_sign: { state: 'unreadable', value: null } } as never).join('\n');
    expect(lines).toContain('unknown: the key page could not be read');
    expect(lines).not.toContain('on its key page: yes');
    expect(lines).not.toContain('on its key page: NO');
  });

  it('credits recorded at provisioning are said to be possibly out of date', () => {
    const lines = factsLines({ ...FACTS, credits: { value: 50000, source: 'recorded' } } as never).join('\n');
    expect(lines).toContain('recorded at provisioning');
    expect(lines).toContain('may be out of date');
  });

  it('a balance that could not be read is NOT a zero, and says so', () => {
    const chain = { ...WITH_CHAIN.chain, balance: { state: 'unreadable', code: 'BALANCE_UNREADABLE' } };
    const lines = factsLines({ ...WITH_CHAIN, chain } as never).join('\n');
    expect(lines).toContain('balance unreadable (BALANCE_UNREADABLE)');
    expect(lines).toContain('NOT a balance of zero');
    expect(lines).not.toMatch(/balance 0\b/);
  });

  it('a chain the identity is not linked to is said, with no balance invented', () => {
    const chain = { chain: 'base-sepolia', chain_id: 84532, account: { state: 'not_linked', address: null }, balance: { state: 'not_applicable', reason: 'no account on this chain' } };
    const lines = factsLines({ ...FACTS, chain } as never).join('\n');
    expect(lines).toContain('no account on this chain: the identity is not linked to it');
    expect(lines).toContain('balance not applicable: no account on this chain');
  });

  it('each organisation state is named as it is', () => {
    const org = (o: unknown): string => factsLines({ ...FACTS, org: o } as never).join('\n');
    expect(org({ state: 'billing_disabled' })).toContain('billing is off on this gateway');
    expect(org({ state: 'not_permitted', scope: 'billing:read' })).toContain('this API key lacks the scope that reads it (billing:read)');
    expect(org({ state: 'unreadable' })).toContain('unknown: the balance could not be read');
    expect(org({ state: 'ok', enforcing: true, spendable_usd: '1.000000', remaining_usd: '0.002000', status: 'active' })).toContain('a shortfall is refused');
    // Not rounded to cents: $0.002 is not free.
    expect(org({ state: 'ok', enforcing: true, spendable_usd: '1.000000', remaining_usd: '0.002000', status: 'active' })).toContain('remaining $0.002');
  });

  it('a failed provisioning says why', () => {
    const lines = factsLines({ ...FACTS, identity: { ...FACTS.identity, status: 'error', error_message: 'the key page could not be created' } } as never).join('\n');
    expect(lines).toContain('status error');
    expect(lines).toContain('provisioning failed: the key page could not be created');
  });

  it('an unreadable section does not fail the command: exit 0, and the other sections are still printed', async () => {
    const g = await serve({ ...FACTS, can_sign: { state: 'unreadable', value: null }, org: { state: 'unreadable' } });
    const r = await certen(['identity', 'readiness'], { home: homeFor(g.url), apiUrl: g.url });
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain('unknown: the key page could not be read');
    expect(r.stdout).toContain('50000');
  });

  it('control characters in what the gateway wrote cannot repaint the terminal', () => {
    const ESC = String.fromCharCode(27);
    const lines = factsLines({ ...FACTS, identity: { ...FACTS.identity, status: `active${ESC}[2K${ESC}[1;32mALL CLEAR` } } as never).join('\n');
    // eslint-disable-next-line no-control-regex
    expect(lines).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/);
  });
});

describe('failures', () => {
  it('an identity the gateway does not know is a failure with the gateway\'s code', async () => {
    stub = await startStub((r) => (r.path.endsWith('/readiness') ? { status: 404, body: { error: 'no such identity', code: 'IDENTITY_NOT_FOUND' } } : undefined));
    const r = await certen(['--json', 'identity', 'readiness'], { home: homeFor(stub.url), apiUrl: stub.url });
    expect(r.code).toBe(1);
    expect(envelope(r).error).toMatchObject({ code: 'IDENTITY_NOT_FOUND', next: 'certen identity list' });
  });

  it('it is its own command: the client-side status and doctor are untouched and the help says how they differ', async () => {
    const g = await serve();
    const r = await certen(['identity', 'readiness', '--help'], { home: homeFor(g.url), apiUrl: g.url });
    expect(r.stdout).toContain('Facts only, no verdict');
    expect(r.stdout).toContain('status / doctor');
    expect(r.stdout).toContain('check the key page against Accumulate itself');
  });
});
