import { describe, it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { AddressInfo } from 'node:net';

/**
 * `certen status`.
 *
 * Runs the built CLI against a stub gateway and a stub Accumulate node. What is pinned is the verdict each situation gets, because each
 * has a plausible wrong answer:
 *
 * - "ready" only when nothing failed AND nothing could not be answered: a key page that could not be read from Accumulate is
 *   `NOT_CONFIRMED` (exit 1), never a pass on the gateway's word alone;
 * - the gateway's word and Accumulate's about the key page disagreeing is a blocker with its own code;
 * - the identity, chain and key come from the context and are SAID on stderr, in table and `--json` mode, with one envelope on stdout;
 * - a local mistake (a wei-looking amount, a bad Accumulate URL, two identities and no choice) is a usage error raised before any request;
 * - the CERTEN credential never reaches the Accumulate node.
 *
 * Both HOME and USERPROFILE are set on every spawn (`os.homedir()` reads USERPROFILE on Windows).
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, '..', 'dist', 'index.js');
const run = promisify(execFile);

const ID_A = '11111111-1111-4111-8111-111111111111';
const ID_B = '22222222-2222-4222-8222-222222222222';
const ADI_A = 'acc://alpha.acme';
const ADI_B = 'acc://beta.acme';
const ABSTRACT = `0x${'ab'.repeat(20)}`;
const OTHER_HASH = 'ff'.repeat(32);

interface Req { method: string; path: string; headers: http.IncomingHttpHeaders; body?: any }
type Out = { status?: number; body?: unknown; raw?: string };

async function stub(handler: (e: Req) => Out) {
  const seen: Req[] = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const e: Req = { method: req.method ?? 'GET', path: (req.url ?? '').split('?')[0]!, headers: req.headers, body: raw ? JSON.parse(raw) : undefined };
      seen.push(e);
      const out = handler(e);
      res.writeHead(out.status ?? 200, { 'content-type': 'application/json' }).end(out.raw ?? JSON.stringify(out.body ?? {}));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  return {
    seen,
    paths: () => seen.map((e) => `${e.method} ${e.path}`),
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => new Promise<void>((r) => { server.closeAllConnections?.(); server.close(() => r()); }),
  };
}

interface Run { stdout: string; stderr: string; code: number }
async function certen(home: string, args: string[], url: string, env: Record<string, string | undefined> = {}): Promise<Run> {
  const base: Record<string, string> = {
    ...(process.env as Record<string, string>), HOME: home, USERPROFILE: home,
    CERTEN_API_URL: url, CERTEN_API_KEY: 'ck_live_test', NO_PROXY: '127.0.0.1,localhost',
  };
  for (const k of ['CERTEN_IDENTITY', 'CERTEN_KEY', 'CERTEN_CHAIN', 'CERTEN_PROFILE', 'CERTEN_ALLOW_ANY_CHAIN', 'CERTEN_ENABLED_CHAINS']) delete base[k];
  for (const [k, v] of Object.entries(env)) { if (v === undefined) delete base[k]; else base[k] = v; }
  try {
    const { stdout, stderr } = await run(process.execPath, [CLI, ...args], { env: base, encoding: 'utf8', cwd: home, timeout: 60000 });
    return { stdout, stderr, code: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: number };
    return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', code: typeof e.code === 'number' ? e.code : -1 };
  }
}

const envelope = (r: Run): { ok: boolean; data?: any; error?: { code: string; message: string; details?: any } } => {
  const t = r.stdout.trim();
  expect(t.length, `stdout was empty; stderr: ${r.stderr}`).toBeGreaterThan(0);
  expect(t.split('\n'), 'exactly one line on stdout').toHaveLength(1);
  return JSON.parse(t);
};

async function homeWith(opts: { identities?: Array<{ id: string; adi_url: string; chains: string[]; name?: string }>; keys?: string[] } = {}): Promise<{ home: string; hash?: string }> {
  const home = mkdtempSync(join(tmpdir(), 'certen-status-'));
  mkdirSync(join(home, '.certen'), { recursive: true });
  writeFileSync(join(home, '.certen', 'config.json'), JSON.stringify({
    identities: (opts.identities ?? []).map((r) => ({ ...r, created_at: '2026-10-01T00:00:00Z' })),
  }));
  let hash: string | undefined;
  for (const name of opts.keys ?? []) {
    const r = await certen(home, ['--json', 'keys', 'generate', '--name', name, '--no-passphrase'], 'http://127.0.0.1:1');
    hash ??= envelope(r).data.public_key_hash;
  }
  return { home, hash };
}

const identityBody = (id: string, adi: string, over: Record<string, unknown> = {}) => ({
  id, adi_url: adi, book_url: `${adi}/book`, key_page_url: `${adi}/book/1`, status: 'active', can_sign: true, credit_balance: 500,
  chain_accounts: [{ chain_id: '84532', address: ABSTRACT, status: 'deployed' }],
  balances: [{ chain_id: 'base-sepolia', address: ABSTRACT, token: 'ETH', balance: '0.0021' }],
  created_at: '2026-01-01T00:00:00Z',
  ...over,
});
const balanceBody = { currency: 'USD', available_usd: '5.000000', held_usd: '0', credit_limit_usd: '0', spendable_usd: '5.000000', remaining_usd: '5.000000', pending_intents: 0, status: 'active' };
const chainEntry = (id: string, chainId: number) => ({ id, chainId, family: 'evm', displayName: id, environment: 'testnet', explorer: 'https://x', status: 'live', contracts: {}, enabled: true });

interface Rig { hash: string; identity?: (id: string) => Record<string, unknown> | undefined; balance?: Out; accumulate?: (e: Req) => Out; accumulateUp?: boolean }

/** A gateway and an Accumulate node, wired to each other: the registry advertises the node. */
async function rig(r: Rig) {
  const accumulate = await stub((e) => (r.accumulate
    ? r.accumulate(e)
    : { body: { jsonrpc: '2.0', id: 1, result: { account: { type: 'keyPage', keys: [{ publicKeyHash: r.hash }], creditBalance: 1240, version: 2, acceptThreshold: 1 } } } }));
  const gateway = await stub((e) => {
    if (e.path === '/v1/chains') {
      return { body: { version: 'v1', last_updated: 'x', count: 3, accumulate: { network: 'kermit', environment: 'testnet', api: `${accumulate.url}/v3`, explorer: '' }, chains: [chainEntry('ethereum-sepolia', 11155111), chainEntry('base-sepolia', 84532), chainEntry('arbitrum-sepolia', 421614)] } };
    }
    if (e.path === '/v1/billing/balance') return r.balance ?? { body: balanceBody };
    const m = /^\/v1\/identity\/([^/]+)$/.exec(e.path);
    if (m) {
      const body = (r.identity ?? ((id) => (id === ID_A ? identityBody(ID_A, ADI_A) : id === ID_B ? identityBody(ID_B, ADI_B) : undefined)))(m[1]!);
      return body ? { body } : { status: 404, body: { code: 'NOT_FOUND', error: 'no such identity' } };
    }
    return { status: 404, body: { message: `no route ${e.path}` } };
  });
  return { gateway, accumulate, close: async () => { await gateway.close(); await accumulate.close(); } };
}

describe('certen status: ready', () => {
  it('is exit 0 with one envelope on stdout, the context said on stderr, and the card absent in --json mode', async () => {
    const { home, hash } = await homeWith({ identities: [{ id: ID_A, adi_url: ADI_A, chains: ['base-sepolia'], name: 'alpha' }], keys: ['dev'] });
    const x = await rig({ hash: hash! });
    try {
      const r = await certen(home, ['--json', 'status'], x.gateway.url);
      expect(r.code, r.stderr).toBe(0);
      const e = envelope(r);
      expect(e.ok).toBe(true);
      expect(e.data.readiness).toMatchObject({ ready: true, state: 'ready', first_blocker: null });
      expect(e.data.readiness.checks.map((c: any) => c.name)).toEqual(
        ['gateway', 'credential', 'signing key', 'identity', 'chain', 'key page', 'accumulate credits', 'gateway balance', 'gas']);
      expect(e.data.readiness.context).toMatchObject({ identity_id: ID_A, chain: 'base-sepolia', abstract_account: ABSTRACT, key_hash: hash });
      expect(r.stderr).toMatch(/using identity acc:\/\/alpha\.acme \(the only identity recorded on this machine\)/);
      expect(r.stderr).toMatch(/using chain base-sepolia \(the only chain this identity is linked to\)/);
      expect(r.stderr).toMatch(/using key dev \(the only signing key on this machine\)/);
      expect(r.stderr).not.toMatch(/Ready to transact/);
    } finally { await x.close(); }
  });

  it('prints the readiness card in table mode, with the key page read from Accumulate', async () => {
    const { home, hash } = await homeWith({ identities: [{ id: ID_A, adi_url: ADI_A, chains: ['base-sepolia'] }], keys: ['dev'] });
    const x = await rig({ hash: hash! });
    try {
      const r = await certen(home, ['status'], x.gateway.url);
      expect(r.code, r.stderr).toBe(0);
      expect(r.stdout).toMatch(/Ready to transact on base-sepolia/);
      expect(r.stdout).toMatch(/\[ ok \] key page\s+acc:\/\/alpha\.acme\/book\/1 holds your key .* read from Accumulate .*, not the gateway/);
      expect(r.stdout).toMatch(/\[ ok \] gas\s+0xabab/);
    } finally { await x.close(); }
  });

  it('sends the CERTEN credential to the gateway and never to the Accumulate node', async () => {
    const { home, hash } = await homeWith({ identities: [{ id: ID_A, adi_url: ADI_A, chains: ['base-sepolia'] }], keys: ['dev'] });
    const x = await rig({ hash: hash! });
    try {
      await certen(home, ['--json', 'status'], x.gateway.url);
      expect(x.gateway.seen.every((e) => e.headers['x-api-key'] === 'ck_live_test')).toBe(true);
      expect(x.accumulate.seen).toHaveLength(1);
      expect(x.accumulate.seen[0]!.headers['x-api-key']).toBeUndefined();
      expect(x.accumulate.seen[0]!.headers.authorization).toBeUndefined();
    } finally { await x.close(); }
  });

  it('reads the Accumulate node it was told to, over the one the gateway advertises', async () => {
    const { home, hash } = await homeWith({ identities: [{ id: ID_A, adi_url: ADI_A, chains: ['base-sepolia'] }], keys: ['dev'] });
    const x = await rig({ hash: hash! });
    const mine = await stub(() => ({ body: { jsonrpc: '2.0', id: 1, result: { account: { type: 'keyPage', keys: [{ publicKeyHash: hash }], creditBalance: 9 } } } }));
    try {
      const r = await certen(home, ['--json', 'status', '--accumulate-rpc', `${mine.url}/v3`], x.gateway.url);
      expect(r.code, r.stderr).toBe(0);
      expect(mine.seen).toHaveLength(1);
      expect(x.accumulate.seen).toHaveLength(0);
      expect(envelope(r).data.readiness.context.accumulate_rpc).toBe(`${mine.url}/v3`);
    } finally { await mine.close(); await x.close(); }
  });
});

describe('certen status: not ready', () => {
  it('is NOT_READY (exit 1) when the page does not list the key but the gateway says it can sign: a disagreement, named', async () => {
    const { home, hash } = await homeWith({ identities: [{ id: ID_A, adi_url: ADI_A, chains: ['base-sepolia'] }], keys: ['dev'] });
    const x = await rig({ hash: hash!, accumulate: () => ({ body: { jsonrpc: '2.0', id: 1, result: { account: { type: 'keyPage', keys: [{ publicKeyHash: OTHER_HASH }], creditBalance: 5 } } } }) });
    try {
      const r = await certen(home, ['--json', 'status'], x.gateway.url);
      expect(r.code).toBe(1);
      const e = envelope(r);
      expect(e.ok).toBe(false);
      expect(e.error!.code).toBe('NOT_READY');
      expect(e.error!.details.readiness).toMatchObject({ ready: false, state: 'blocked', first_blocker: { name: 'key page', code: 'KEY_PAGE_DISAGREES' } });
    } finally { await x.close(); }
  });

  it('is NOT_CONFIRMED (exit 1), not ready, when Accumulate cannot be read: the gateway\'s word alone is not enough', async () => {
    const { home, hash } = await homeWith({ identities: [{ id: ID_A, adi_url: ADI_A, chains: ['base-sepolia'] }], keys: ['dev'] });
    const x = await rig({ hash: hash!, accumulate: () => ({ status: 503, raw: 'down' }) });
    try {
      const r = await certen(home, ['--json', 'status'], x.gateway.url);
      expect(r.code).toBe(1);
      const e = envelope(r);
      expect(e.error!.code).toBe('NOT_CONFIRMED');
      expect(e.error!.details.readiness).toMatchObject({ ready: false, state: 'unconfirmed', first_blocker: { name: 'key page', status: 'unknown', code: 'KEY_PAGE_UNCONFIRMED' } });
      // Everything else was fine: it is the gap that makes it not ready.
      expect(e.error!.details.readiness.checks.filter((c: any) => c.status === 'ok').length).toBeGreaterThan(5);
    } finally { await x.close(); }
  });

  it('names the account, the amount to send and the faucet when there is no gas, and puts the command on the fixes that have one', async () => {
    const { home, hash } = await homeWith({ identities: [{ id: ID_A, adi_url: ADI_A, chains: ['base-sepolia'] }], keys: ['dev'] });
    const x = await rig({ hash: hash!, identity: (id) => (id === ID_A ? identityBody(ID_A, ADI_A, { balances: [{ chain_id: 'base-sepolia', address: ABSTRACT, token: 'ETH', balance: '0' }] }) : undefined) });
    try {
      const r = await certen(home, ['status', '--amount', '0.0005'], x.gateway.url);
      expect(r.code).toBe(1);
      expect(r.stdout).toMatch(/Not ready on base-sepolia: gas is failing/);
      expect(r.stdout).toMatch(/\[FAIL\] gas\s+0xabab.* holds 0 ETH/);
      expect(r.stdout).toMatch(/fix: Send at least 0\.0006 ETH to 0xabab/);
      expect(r.stdout).toMatch(/see: https:\/\/www\.alchemy\.com\/faucets\/base-sepolia/);
      // The command that does it, now that one exists: not the gateway balance (`fund`), which is a different thing that has been called funding.
      expect(r.stdout).toContain('run: certen gas --chain base-sepolia --wait');
      expect(r.stdout).not.toContain('certen fund');
      expect(r.stderr).toMatch(/NOT_READY/);
    } finally { await x.close(); }
  });

  it('puts the exact command on a fix that has one: link the chain the identity lacks', async () => {
    const { home, hash } = await homeWith({ identities: [{ id: ID_A, adi_url: ADI_A, chains: ['base-sepolia'] }], keys: ['dev'] });
    const x = await rig({ hash: hash!, identity: (id) => (id === ID_A ? identityBody(ID_A, ADI_A, { chain_accounts: [] }) : undefined) });
    try {
      const r = await certen(home, ['status'], x.gateway.url);
      expect(r.code).toBe(1);
      expect(r.stdout).toContain(`run: certen identity link-chain ${ID_A} --chain base-sepolia`);
    } finally { await x.close(); }
  });

  it('reports a machine with no signing key as a failed check, and still compares nothing with a key it does not have', async () => {
    const { home } = await homeWith({ identities: [{ id: ID_A, adi_url: ADI_A, chains: ['base-sepolia'] }] });
    const x = await rig({ hash: 'aa'.repeat(32) });
    try {
      const r = await certen(home, ['--json', 'status'], x.gateway.url);
      expect(r.code).toBe(1);
      const rd = envelope(r).error!.details.readiness;
      expect(rd.checks.find((c: any) => c.name === 'signing key')).toMatchObject({ status: 'fail', code: 'MISSING_SIGNING_KEY', fix: { command: 'certen keys generate --name dev' } });
      expect(rd.checks.find((c: any) => c.name === 'key page').status).toBe('warn');
      expect(x.accumulate.seen).toHaveLength(0);
    } finally { await x.close(); }
  });

  it('reports a machine with no API key as a failed credential, with the way to sign in, rather than refusing to run', async () => {
    const { home } = await homeWith({ identities: [{ id: ID_A, adi_url: ADI_A, chains: ['base-sepolia'] }], keys: ['dev'] });
    const x = await rig({ hash: 'aa'.repeat(32) });
    try {
      const r = await certen(home, ['status'], x.gateway.url, { CERTEN_API_KEY: undefined });
      expect(r.code).toBe(1);
      expect(r.stdout).toMatch(/\[ ok \] gateway/);
      expect(r.stdout).toMatch(/\[FAIL\] credential\s+No API key is configured on this machine\./);
      expect(r.stdout).toContain('run: certen login');
      expect(r.stdout).toMatch(/\[ -- \] gas\s+needs a working API key/);
    } finally { await x.close(); }
  });

  it('exits 3 and says the gateway could not be reached, with every other check skipped', async () => {
    const { home } = await homeWith({ identities: [{ id: ID_A, adi_url: ADI_A, chains: ['base-sepolia'] }], keys: ['dev'] });
    const r = await certen(home, ['--json', 'status'], 'http://127.0.0.1:1');
    expect(r.code).toBe(3);
    const e = envelope(r);
    expect(e.error!.code).toBe('NETWORK_ERROR');
    const checks = e.error!.details.readiness.checks;
    expect(checks.map((c: any) => c.status)).toEqual(['fail', 'skipped', 'ok', ...Array(6).fill('skipped')]);
  });
});

describe('certen status: usage errors, before any request', () => {
  it('asks which identity when several are recorded and none is chosen', async () => {
    const { home } = await homeWith({
      identities: [{ id: ID_A, adi_url: ADI_A, chains: ['base-sepolia'] }, { id: ID_B, adi_url: ADI_B, chains: ['base-sepolia'] }], keys: ['dev'],
    });
    const x = await rig({ hash: 'aa'.repeat(32) });
    try {
      const r = await certen(home, ['--json', 'status'], x.gateway.url);
      expect(r.code).toBe(2);
      expect(envelope(r).error!.code).toBe('AMBIGUOUS_IDENTITY');
      expect(x.gateway.seen).toHaveLength(0);
    } finally { await x.close(); }
  });

  it('refuses an amount that looks like wei, a bad Accumulate URL and a bad gas reserve', async () => {
    const { home } = await homeWith({ identities: [{ id: ID_A, adi_url: ADI_A, chains: ['base-sepolia'] }], keys: ['dev'] });
    const x = await rig({ hash: 'aa'.repeat(32) });
    try {
      const wei = await certen(home, ['--json', 'status', '--amount', '1000000000000000'], x.gateway.url);
      expect(wei.code).toBe(2);
      expect(envelope(wei).error).toMatchObject({ code: 'INVALID_AMOUNT' });
      expect(envelope(wei).error!.message).toMatch(/looks like wei/);
      const rpc = await certen(home, ['--json', 'status', '--accumulate-rpc', 'not a url'], x.gateway.url);
      expect(rpc.code).toBe(2);
      expect(envelope(rpc).error!.code).toBe('INVALID_ACCUMULATE_RPC');
      const creds = await certen(home, ['--json', 'status', '--accumulate-rpc', 'https://user:pw@node/v3'], x.gateway.url);
      expect(envelope(creds).error!.code).toBe('INVALID_ACCUMULATE_RPC');
      const reserve = await certen(home, ['--json', 'status', '--gas-reserve', 'lots'], x.gateway.url);
      expect(envelope(reserve).error!.code).toBe('INVALID_AMOUNT');
      expect(x.gateway.seen).toHaveLength(0);
    } finally { await x.close(); }
  });

  it('says there is no identity to check when none is recorded and none is given', async () => {
    const { home } = await homeWith({ keys: ['dev'] });
    const r = await certen(home, ['--json', 'status'], 'http://127.0.0.1:1');
    expect(r.code).toBe(2);
    expect(envelope(r).error!.code).toBe('MISSING_IDENTITY');
  });
});

describe('certen status: gas reserve and amounts', () => {
  it('treats --gas-reserve none as "no estimate", and a larger reserve as a reason to fail', async () => {
    const { home, hash } = await homeWith({ identities: [{ id: ID_A, adi_url: ADI_A, chains: ['base-sepolia'] }], keys: ['dev'] });
    const x = await rig({ hash: hash!, identity: (id) => (id === ID_A ? identityBody(ID_A, ADI_A, { balances: [{ chain_id: 'base-sepolia', address: ABSTRACT, token: 'ETH', balance: '0.0003' }] }) : undefined) });
    try {
      const big = await certen(home, ['--json', 'status', '--gas-reserve', '0.01'], x.gateway.url);
      expect(big.code).toBe(1);
      expect(envelope(big).error!.details.readiness.first_blocker).toMatchObject({ name: 'gas', code: 'ABSTRACT_ACCOUNT_UNDERFUNDED' });
      const none = await certen(home, ['--json', 'status', '--gas-reserve', 'none'], x.gateway.url);
      expect(none.code, none.stderr).toBe(0);
      const gas = envelope(none).data.readiness.checks.find((c: any) => c.name === 'gas');
      expect(gas.status).toBe('warn');
      expect(gas.code).toBe('GAS_NOT_ESTIMATED');
    } finally { await x.close(); }
  });
});

describe('certen status --all', () => {
  it('checks every recorded identity on each linked chain, and compares the key only with the identity the context names', async () => {
    const { home, hash } = await homeWith({
      identities: [{ id: ID_A, adi_url: ADI_A, chains: ['base-sepolia'], name: 'alpha' }, { id: ID_B, adi_url: ADI_B, chains: ['base-sepolia'], name: 'beta' }], keys: ['dev'],
    });
    const x = await rig({ hash: hash! });
    try {
      const r = await certen(home, ['--json', 'status', '--all', '--identity', 'alpha'], x.gateway.url);
      // beta's key page was not compared with a key that may not be its own, so it is a warning, and the whole is still ready.
      expect(r.code, r.stderr).toBe(0);
      const contexts = envelope(r).data.contexts;
      expect(contexts.map((c: any) => [c.adi_url, c.chain, c.readiness.state])).toEqual([[ADI_A, 'base-sepolia', 'ready'], [ADI_B, 'base-sepolia', 'ready']]);
      expect(contexts[1].readiness.checks.find((c: any) => c.name === 'key page').status).toBe('warn');
      // The organization-wide checks were made once, with the first pair.
      expect(contexts[0].readiness.checks.map((c: any) => c.name)).toContain('gateway balance');
      expect(contexts[1].readiness.checks.map((c: any) => c.name)).not.toContain('gateway balance');
      expect(x.gateway.paths().filter((p) => p === 'GET /v1/billing/balance')).toHaveLength(1);
    } finally { await x.close(); }
  });

  it('is not ready when any one context is not, and says how many', async () => {
    const { home, hash } = await homeWith({
      identities: [{ id: ID_A, adi_url: ADI_A, chains: ['base-sepolia'], name: 'alpha' }, { id: ID_B, adi_url: ADI_B, chains: ['base-sepolia'], name: 'beta' }], keys: ['dev'],
    });
    const x = await rig({ hash: hash!, identity: (id) => (id === ID_A ? identityBody(ID_A, ADI_A) : id === ID_B ? identityBody(ID_B, ADI_B, { status: 'error', error_message: 'sponsor dry' }) : undefined) });
    try {
      const r = await certen(home, ['--json', 'status', '--all', '--identity', 'alpha'], x.gateway.url);
      expect(r.code).toBe(1);
      const e = envelope(r);
      expect(e.error!.message).toMatch(/^1 of 2 context\(s\) are not ready/);
      expect(e.error!.details.contexts).toHaveLength(2);
    } finally { await x.close(); }
  });

  it('has nothing to check when nothing is recorded', async () => {
    const { home } = await homeWith({ keys: ['dev'] });
    const r = await certen(home, ['--json', 'status', '--all'], 'http://127.0.0.1:1');
    expect(r.code).toBe(2);
    expect(envelope(r).error!.code).toBe('NO_IDENTITIES');
  });
});
