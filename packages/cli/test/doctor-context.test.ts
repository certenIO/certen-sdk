import { describe, it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { AddressInfo } from 'node:net';

/**
 * `certen doctor`, scoped to the context.
 *
 * `doctor` answered organization-wide questions and named one hardcoded testnet in its fixes, whoever the person was and whatever chain
 * they used: a person on another chain was told to fund the wrong one, and a person on a mainnet context was told to pay on a testnet.
 * Now a fix names the context's chain, or a placeholder when there is none, and when the context names an identity and a chain the five
 * checks about THAT pair are added (the chain, the key page read from Accumulate, its credits, the gas). What is pinned:
 *
 * - no fix and no hint names a chain nobody chose;
 * - the list is the same length however far the run got: with a context, the five checks are always there, skipped when they cannot run;
 * - what could not be confirmed is a warning that says so, never a pass.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, '..', 'dist', 'index.js');
const run = promisify(execFile);

const ID = '11111111-1111-4111-8111-111111111111';
const ADI = 'acc://alpha.acme';
const ABSTRACT = `0x${'ab'.repeat(20)}`;
const CONTEXT_CHECKS = ['identity', 'chain', 'key page', 'accumulate credits', 'gas'];

interface Req { path: string; headers: http.IncomingHttpHeaders }
async function stub(handler: (e: Req) => { status?: number; body?: unknown }) {
  const seen: Req[] = [];
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      const e: Req = { path: (req.url ?? '').split('?')[0]!, headers: req.headers };
      seen.push(e);
      const out = handler(e);
      res.writeHead(out.status ?? 200, { 'content-type': 'application/json' }).end(JSON.stringify(out.body ?? {}));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  return { seen, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => new Promise<void>((r) => { server.closeAllConnections?.(); server.close(() => r()); }) };
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

const envelope = (r: Run): { ok: boolean; data?: any; error?: { code: string; details?: any } } => {
  const t = r.stdout.trim();
  expect(t.length, `stdout was empty; stderr: ${r.stderr}`).toBeGreaterThan(0);
  expect(t.split('\n'), 'exactly one line on stdout').toHaveLength(1);
  return JSON.parse(t);
};

async function homeWith(opts: { recorded?: boolean; chain?: string; keys?: string[] }): Promise<{ home: string; hash?: string }> {
  const home = mkdtempSync(join(tmpdir(), 'certen-doctor-ctx-'));
  mkdirSync(join(home, '.certen'), { recursive: true });
  writeFileSync(join(home, '.certen', 'config.json'), JSON.stringify({
    identities: opts.recorded ? [{ id: ID, adi_url: ADI, chains: [opts.chain ?? 'base-sepolia'], name: 'alpha', created_at: '2026-10-01T00:00:00Z' }] : [],
  }));
  let hash: string | undefined;
  for (const name of opts.keys ?? ['dev']) {
    const r = await certen(home, ['--json', 'keys', 'generate', '--name', name, '--no-passphrase'], 'http://127.0.0.1:1');
    hash ??= envelope(r).data.public_key_hash;
  }
  return { home, hash };
}

const entry = (id: string, chainId: number) => ({ id, chainId, family: 'evm', displayName: id, environment: 'testnet', explorer: 'https://x', status: 'live', contracts: {}, enabled: true });

/** A healthy gateway and Accumulate node, wired to each other. `balance` overrides the org balance (to make an org-level check fail). */
async function world(o: { hash?: string; chain?: string; balance?: Record<string, unknown>; gas?: string } = {}) {
  const chain = o.chain ?? 'base-sepolia';
  const accumulate = await stub(() => ({ body: { jsonrpc: '2.0', id: 1, result: { account: { type: 'keyPage', keys: [{ publicKeyHash: o.hash }], creditBalance: 1240 } } } }));
  const gateway = await stub((e) => {
    if (e.path === '/v1/chains') {
      return { body: { version: 'v1', last_updated: 'x', count: 3, accumulate: { network: 'kermit', environment: 'testnet', api: `${accumulate.url}/v3`, explorer: '' }, chains: [entry('ethereum-sepolia', 11155111), entry('base-sepolia', 84532), entry('arbitrum-sepolia', 421614)] } };
    }
    if (e.path === '/v1/health/ready') return { body: { status: 'ready', reasons: [] } };
    if (e.path === '/v1/errors') return { body: { errors: [] } };
    if (e.path === '/v1/billing/balance') return { body: { currency: 'USD', available_usd: '5', held_usd: '0', credit_limit_usd: '0', spendable_usd: '5', remaining_usd: '5', pending_intents: 0, status: 'active', ...(o.balance ?? {}) } };
    if (e.path === '/v1/portfolio') {
      return { body: { identities: [{ id: ID, adi_url: ADI, status: 'active', credit_balance: 500, pending_actions: 0, chains: [{ chain_id: chain, address: ABSTRACT, deployed: true, balances: [{ token: 'ETH', balance: o.gas ?? '0.0021' }] }] }], total_chains: 1 } };
    }
    if (e.path === '/v1/transactions') return { body: { transactions: [] } };
    if (e.path === `/v1/identity/${ID}`) {
      return { body: { id: ID, adi_url: ADI, book_url: `${ADI}/book`, key_page_url: `${ADI}/book/1`, status: 'active', can_sign: true, credit_balance: 500, chain_accounts: [{ chain_id: chain, address: ABSTRACT, status: 'deployed' }], balances: [{ chain_id: chain, address: ABSTRACT, token: 'ETH', balance: o.gas ?? '0.0021' }], created_at: 'x' } };
    }
    return { status: 404, body: {} };
  });
  return { gateway, accumulate, close: async () => { await gateway.close(); await accumulate.close(); } };
}

describe('certen doctor: no fix or hint names a chain nobody chose', () => {
  it('names the context\'s chain in a fix', async () => {
    const { home, hash } = await homeWith({ recorded: true, chain: 'arbitrum-sepolia' });
    const w = await world({ hash, chain: 'arbitrum-sepolia', balance: { status: 'suspended', suspended_reason: 'unpaid' } });
    try {
      const r = await certen(home, ['--json', 'doctor'], w.gateway.url);
      expect(r.code).toBe(1);
      const fix = envelope(r).error!.details.checks.find((c: any) => c.name === 'billing balance').fix as string;
      expect(fix).toBe('certen fund <amount> --chain arbitrum-sepolia');
    } finally { await w.close(); }
  });

  it('uses a placeholder, never a chain, when there is no context to say which', async () => {
    const { home } = await homeWith({ recorded: false });
    const w = await world({ balance: { status: 'suspended', suspended_reason: 'unpaid' } });
    try {
      const r = await certen(home, ['--json', 'doctor'], w.gateway.url);
      const checks = envelope(r).error!.details.checks;
      expect(checks.find((c: any) => c.name === 'billing balance').fix).toBe('certen fund <amount> --chain <chain>');
      expect(JSON.stringify(checks)).not.toMatch(/-sepolia/);
    } finally { await w.close(); }
  });

  it('gives a next step that works as printed: only what the context does not supply is left to type, and the chain is spelled out', async () => {
    const withCtx = await homeWith({ recorded: true });
    const w = await world({ hash: withCtx.hash });
    try {
      const r = await certen(withCtx.home, ['doctor'], w.gateway.url);
      expect(r.code, r.stderr).toBe(0);
      expect(r.stderr).toContain('Next: certen send <amount> <asset> --chain base-sepolia --to <addr>');
      // Two keys and no choice made: nothing in the context names one, so the key is left for the person to type.
      const none = await homeWith({ recorded: false, keys: ['dev', 'ops'] });
      const r2 = await certen(none.home, ['doctor'], w.gateway.url);
      expect(r2.stderr).toContain('Next: certen send <amount> <asset> --identity <id> --chain <chain> --to <addr> --sign-with <key>');
    } finally { await w.close(); }
  });

  it('has no hardcoded chain in the command\'s source', () => {
    const source = readFileSync(join(HERE, '..', 'src', 'commands', 'doctor.ts'), 'utf8');
    expect(source).not.toMatch(/['"`][a-z]+-sepolia['"`]/);
  });
});

describe('certen doctor: the checks about the context\'s identity and chain', () => {
  it('adds the five when a context names an identity and a chain, all ok when all is well', async () => {
    const { home, hash } = await homeWith({ recorded: true });
    const w = await world({ hash });
    try {
      const r = await certen(home, ['--json', 'doctor'], w.gateway.url);
      expect(r.code, r.stdout + r.stderr).toBe(0);
      const checks = envelope(r).data.checks as Array<{ name: string; status: string; detail: string }>;
      expect(checks.slice(-5).map((c) => c.name)).toEqual(CONTEXT_CHECKS);
      expect(checks.slice(-5).every((c) => c.status === 'ok')).toBe(true);
      expect(checks.find((c) => c.name === 'key page')!.detail).toMatch(/read from Accumulate/);
      expect(r.stderr).toMatch(/using identity acc:\/\/alpha\.acme \(the only identity recorded on this machine\)/);
    } finally { await w.close(); }
  });

  it('adds nothing when there is no context to scope to, so the list is unchanged for everyone who had none', async () => {
    const { home } = await homeWith({ recorded: false });
    const w = await world({});
    try {
      const r = await certen(home, ['--json', 'doctor'], w.gateway.url);
      const checks = envelope(r).data.checks as Array<{ name: string }>;
      expect(checks.map((c) => c.name)).not.toContain('key page');
    } finally { await w.close(); }
  });

  it('turns what it could not confirm into a warning that says so, never a pass', async () => {
    const { home, hash } = await homeWith({ recorded: true });
    const w = await world({ hash });
    await w.accumulate.close();
    try {
      const r = await certen(home, ['--json', 'doctor'], w.gateway.url);
      expect(r.code, r.stderr).toBe(0);
      const kp = (envelope(r).data.checks as Array<{ name: string; status: string; detail: string }>).find((c) => c.name === 'key page')!;
      expect(kp.status).toBe('warn');
      expect(kp.detail).toMatch(/^could not confirm: /);
    } finally { await w.gateway.close(); }
  });

  it('fails when the key page does not list the key, and says what to do', async () => {
    const { home } = await homeWith({ recorded: true });
    const w = await world({ hash: 'ff'.repeat(32) });
    try {
      const r = await certen(home, ['--json', 'doctor'], w.gateway.url);
      expect(r.code).toBe(1);
      const kp = envelope(r).error!.details.checks.find((c: any) => c.name === 'key page');
      expect(kp.status).toBe('fail');
      expect(kp.fix).toMatch(/Use the key this identity was created with/);
    } finally { await w.close(); }
  });

  it('reports an unfunded abstract account as a warning, as doctor always has: it is asked with no amount in mind, and a call that forwards no value is unaffected', async () => {
    const { home, hash } = await homeWith({ recorded: true });
    const w = await world({ hash, gas: '0' });
    try {
      const r = await certen(home, ['--json', 'doctor'], w.gateway.url);
      expect(r.code, r.stdout + r.stderr).toBe(0);
      const checks = envelope(r).data.checks as Array<{ name: string; status: string; detail: string; fix?: string }>;
      const gas = checks.find((c) => c.name === 'gas')!;
      expect(gas.status).toBe('warn');
      expect(gas.detail).toMatch(/holds 0 ETH/);
      expect(gas.fix).toMatch(/Send at least 0\.0001 ETH to 0xabab/);
      // The organization-wide check says the same thing, in the same words doctor has always used.
      expect(checks.find((c) => c.name === 'abstract accounts funded')!.status).toBe('warn');
    } finally { await w.close(); }
  });

  it('keeps the same length when the gateway is unreachable: the five are there, skipped', async () => {
    const { home } = await homeWith({ recorded: true });
    const r = await certen(home, ['--json', 'doctor'], 'http://127.0.0.1:1');
    expect(r.code).toBe(3);
    const checks = envelope(r).error!.details.checks as Array<{ name: string; status: string; detail: string }>;
    expect(checks.slice(-5).map((c) => [c.name, c.status])).toEqual(CONTEXT_CHECKS.map((n) => [n, 'skipped']));
    expect(checks.slice(-5)[0]!.detail).toBe('gateway unreachable');
  });

  it('takes --identity and --chain over the context', async () => {
    const { home, hash } = await homeWith({ recorded: true, chain: 'base-sepolia' });
    const w = await world({ hash });
    try {
      const r = await certen(home, ['--json', 'doctor', '--identity', ID, '--chain', 'arbitrum-sepolia'], w.gateway.url);
      const chain = (envelope(r).error?.details?.checks ?? envelope(r).data.checks).find((c: any) => c.name === 'chain');
      // The identity has no account on arbitrum in this world: the check is about the chain that was asked for.
      expect(chain.status).toBe('fail');
      expect(chain.detail).toMatch(/arbitrum-sepolia/);
    } finally { await w.close(); }
  });
});
