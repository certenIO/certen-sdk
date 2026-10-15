import { describe, it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import { honestIntent, honestGovernance } from '../../sdk/test/helpers/honest-gateway.js';

/**
 * The commands, with the context wired in.
 *
 * `call`, `tx create`, `governance`, `identity`, `pending`, `portfolio` and `fund` used to make the person type `--identity`,
 * `--chain` and (for `call`) `--sign-with` every time, though the CLI had recorded the answer. These cases run the built CLI against a
 * stub gateway and pin four things:
 *
 *   1. what is derived, and that it is SAID: every value that came from context rather than a flag is echoed on stderr, in table and
 *      `--json` mode, before anything is signed;
 *   2. that the three identity spellings (UUID, ADI URL, name) all work in every command, each sent to the gateway in the form its
 *      route takes;
 *   3. that nothing is guessed: several candidates are a question that lists them, raised before any request;
 *   4. what is NOT defaulted: a signing key where leaving it out is a supported mode (`tx create`, `governance`, `pending sign`
 *      return signing data for an external signer, and silently signing there would start signing for people who rely on that),
 *      and a mainnet chain on a command that moves value.
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
const TO = `0x${'be'.repeat(20)}`;
const B32 = `0x${'cd'.repeat(32)}`;
const PKH = 'ee'.repeat(32);

interface Req { method: string; path: string; query: string; body?: any }
type Out = { status?: number; body?: unknown };

async function stub(handler: (e: Req) => Promise<Out> | Out) {
  const seen: Req[] = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const [path, query = ''] = (req.url ?? '').split('?');
      const e: Req = { method: req.method ?? 'GET', path: path!, query, body: raw ? JSON.parse(raw) : undefined };
      seen.push(e);
      Promise.resolve(handler(e))
        .then((out) => { res.writeHead(out.status ?? 200, { 'content-type': 'application/json' }).end(JSON.stringify(out.body ?? {})); })
        .catch(() => { res.statusCode = 500; res.end('{}'); });
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
async function certen(home: string, args: string[], url = 'http://127.0.0.1:1', env: Record<string, string> = {}): Promise<Run> {
  const base: Record<string, string> = {
    ...(process.env as Record<string, string>), HOME: home, USERPROFILE: home,
    CERTEN_API_URL: url, CERTEN_API_KEY: 'ck_live_test', NO_PROXY: '127.0.0.1,localhost',
  };
  for (const k of ['CERTEN_IDENTITY', 'CERTEN_KEY', 'CERTEN_CHAIN', 'CERTEN_PROFILE', 'CERTEN_ALLOW_ANY_CHAIN', 'CERTEN_ENABLED_CHAINS']) delete base[k];
  try {
    const { stdout, stderr } = await run(process.execPath, [CLI, ...args], { env: { ...base, ...env }, encoding: 'utf8', cwd: home, timeout: 60000 });
    return { stdout, stderr, code: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: number };
    return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', code: typeof e.code === 'number' ? e.code : -1 };
  }
}

const envelope = (r: Run): { ok: boolean; data?: any; error?: { code: string; message: string } } => {
  const t = r.stdout.trim();
  expect(t.length, `stdout was empty; stderr: ${r.stderr}`).toBeGreaterThan(0);
  expect(t.split('\n'), 'exactly one line on stdout').toHaveLength(1);
  return JSON.parse(t);
};

/** A home that has recorded these identities, and (optionally) holds local keys. Returns the first key's public key. */
async function homeWith(opts: {
  identities?: Array<{ id: string; adi_url: string; chains: string[]; name?: string }>;
  keys?: string[];
  config?: Record<string, unknown>;
} = {}): Promise<{ home: string; publicKey?: string }> {
  const home = mkdtempSync(join(tmpdir(), 'certen-wiring-'));
  mkdirSync(join(home, '.certen'), { recursive: true });
  writeFileSync(join(home, '.certen', 'config.json'), JSON.stringify({
    identities: (opts.identities ?? []).map((r) => ({ ...r, created_at: '2026-10-01T00:00:00Z' })),
    ...(opts.config ?? {}),
  }));
  let publicKey: string | undefined;
  for (const name of opts.keys ?? []) {
    const r = await certen(home, ['--json', 'keys', 'generate', '--name', name, '--no-passphrase']);
    const d = envelope(r).data;
    publicKey ??= d.public_key ?? d.publicKey;
  }
  return { home, publicKey };
}

const baseIdentity = (id: string, adi: string, over: Record<string, unknown> = {}) => ({
  id,
  adi_url: adi,
  book_url: `${adi}/book`,
  key_page_url: `${adi}/book/1`,
  status: 'active',
  can_sign: true,
  credit_balance: 500,
  chain_accounts: [{ chain_id: '84532', address: ABSTRACT, status: 'deployed' }],
  balances: [{ chain_id: 'base-sepolia', address: ABSTRACT, token: 'ETH', balance: '1000000000000000' }],
  created_at: '2026-01-01T00:00:00Z',
  ...over,
});

/** A gateway that serves the identity, opens intents honestly, and accepts signatures. */
function gateway(publicKey?: string) {
  return async (e: Req): Promise<Out> => {
    if (e.method === 'GET' && e.path === `/v1/identity/${ID_A}`) return { body: baseIdentity(ID_A, ADI_A) };
    if (e.method === 'GET' && e.path === `/v1/identity/${ID_B}`) return { body: baseIdentity(ID_B, ADI_B) };
    if (e.method === 'GET' && e.path === '/v1/portfolio') {
      return { body: { identities: [{ id: ID_A, adi_url: ADI_A, status: 'active', credit_balance: 500, pending_actions: 0, chains: [{ chain_id: 'base-sepolia', address: ABSTRACT, deployed: true, balances: [{ token: 'ETH', balance: '1000000000000000' }] }] }], total_chains: 1 } };
    }
    if (e.method === 'POST' && e.path === '/v1/transaction') {
      const h = await honestIntent(e.body, { adiUrl: ADI_A, keyPage: `${ADI_A}/book/1`, ...(publicKey ? { publicKey } : {}) });
      return { status: h.status, body: h.body };
    }
    if (e.method === 'POST' && e.path === '/v1/transaction/intent-1/signature') return { body: { ok: true } };
    if (e.method === 'GET' && e.path === '/v1/transaction/intent-1') return { body: { intent_id: 'intent-1', status: 'completed' } };
    if (e.method === 'POST' && e.path === '/v1/governance') {
      return honestGovernance(e.body.operations[0], e.body.identity, { publicKey });
    }
    if (e.method === 'GET' && e.path === '/v1/pending') return { body: { actions: [], total: 0 } };
    if (e.method === 'PATCH' && e.path === `/v1/identity/${ID_A}`) return { body: baseIdentity(ID_A, ADI_A) };
    return { status: 404, body: { message: 'not found' } };
  };
}

const ALPHA = { id: ID_A, adi_url: ADI_A, chains: ['base-sepolia'], name: 'alpha' };
const BETA = { id: ID_B, adi_url: ADI_B, chains: ['base-sepolia'], name: 'beta' };

describe('certen call', () => {
  const callArgs = ['call', '--to', TO, '--fn', 'confirm(bytes32)', '--arg', B32, '--dry-run'];

  it('takes the identity and the chain from context, says so on stderr, and sends one request', async () => {
    const { home } = await homeWith({ identities: [ALPHA] });
    const gw = await stub(gateway());
    try {
      for (const json of [false, true]) {
        gw.seen.length = 0;
        const r = await certen(home, json ? ['--json', ...callArgs] : callArgs, gw.url);
        expect(r.code, r.stderr).toBe(0);
        expect(r.stderr).toContain(`using identity ${ADI_A} (the only identity recorded on this machine)`);
        expect(r.stderr).toContain('using chain base-sepolia (the only chain this identity is linked to)');
        expect(gw.paths()).toEqual([`GET /v1/identity/${ID_A}`]);
        if (json) {
          expect(envelope(r).data).toMatchObject({ identity_id: ID_A, adi_url: ADI_A, chain: 'base-sepolia', from_address: ABSTRACT });
        } else {
          expect(r.stdout).toContain(ID_A);
        }
      }
    } finally { await gw.close(); }
  });

  it('says nothing about a value that was typed', async () => {
    const { home } = await homeWith({ identities: [ALPHA] });
    const gw = await stub(gateway());
    try {
      const r = await certen(home, [...callArgs, '--identity', ID_A, '--chain', 'base-sepolia'], gw.url);
      expect(r.code, r.stderr).toBe(0);
      expect(r.stderr).not.toMatch(/using (identity|chain|key)/);
    } finally { await gw.close(); }
  });

  it('takes a name, an ADI URL or a UUID as --identity, and asks the gateway only for the identity', async () => {
    const { home } = await homeWith({ identities: [ALPHA, BETA] });
    const gw = await stub(gateway());
    try {
      for (const ref of ['beta', 'BETA', ADI_B, 'ACC://Beta.acme/', ID_B]) {
        gw.seen.length = 0;
        const r = await certen(home, ['--json', ...callArgs, '--identity', ref, '--chain', 'base-sepolia'], gw.url);
        expect(r.code, `${ref}: ${r.stderr}`).toBe(0);
        expect(envelope(r).data).toMatchObject({ identity_id: ID_B, adi_url: ADI_B });
        expect(gw.paths(), ref).toEqual([`GET /v1/identity/${ID_B}`]);
      }
    } finally { await gw.close(); }
  });

  it('asks which identity when several are recorded and none is chosen, before any request', async () => {
    const { home } = await homeWith({ identities: [ALPHA, BETA] });
    const gw = await stub(gateway());
    try {
      const r = await certen(home, ['--json', ...callArgs, '--chain', 'base-sepolia'], gw.url);
      expect(r.code).toBe(2);
      const e = envelope(r).error!;
      expect(e.code).toBe('AMBIGUOUS_IDENTITY');
      expect(e.message).toContain('alpha');
      expect(e.message).toContain('beta');
      expect(gw.seen).toHaveLength(0);
    } finally { await gw.close(); }
  });

  it('uses the identity a profile chose, over several recorded', async () => {
    const { home } = await homeWith({ identities: [ALPHA, BETA], config: { profiles: { default: { identity: ID_B } } } });
    const gw = await stub(gateway());
    try {
      const r = await certen(home, ['--json', ...callArgs, '--chain', 'base-sepolia'], gw.url);
      expect(r.code, r.stderr).toBe(0);
      expect(envelope(r).data.identity_id).toBe(ID_B);
      expect(r.stderr).toContain('(from profile "default")');
    } finally { await gw.close(); }
  });

  it('names what is missing when there is no identity, then no chain, before any request', async () => {
    const gw = await stub(gateway());
    try {
      const none = await homeWith();
      const noId = await certen(none.home, ['--json', ...callArgs, '--chain', 'base-sepolia'], gw.url);
      expect(noId.code).toBe(2);
      expect(envelope(noId).error!.code).toBe('MISSING_IDENTITY');

      const noChain = await homeWith({ identities: [{ ...ALPHA, chains: [] }] });
      const r = await certen(noChain.home, ['--json', ...callArgs], gw.url);
      expect(r.code).toBe(2);
      expect(envelope(r).error!.code).toBe('MISSING_CHAIN');
      expect(gw.seen).toHaveLength(0);
    } finally { await gw.close(); }
  });

  it('refuses a chain that is not a known testnet when it comes from a default, and accepts it when typed or allowed', async () => {
    const { home } = await homeWith({ identities: [ALPHA], config: { profiles: { default: { chain: 'base' } } } });
    const gw = await stub(gateway());
    const any = { CERTEN_ALLOW_ANY_CHAIN: '1' };
    try {
      const fromDefault = await certen(home, ['--json', ...callArgs], gw.url, any);
      expect(fromDefault.code).toBe(2);
      expect(envelope(fromDefault).error!.code).toBe('MAINNET_DEFAULT_REFUSED');
      expect(gw.seen).toHaveLength(0);

      // Typed: it is the one the person means. It then fails for its own reason (this identity has no account on `base`).
      const typed = await certen(home, ['--json', ...callArgs, '--chain', 'base'], gw.url, any);
      expect(envelope(typed).error!.code).toBe('NO_ABSTRACT_ACCOUNT');

      await certen(home, ['use', 'allow-mainnet-default', 'on'], gw.url);
      const allowed = await certen(home, ['--json', ...callArgs], gw.url, any);
      expect(envelope(allowed).error!.code).toBe('NO_ABSTRACT_ACCOUNT');
    } finally { await gw.close(); }
  });

  it('blames the source of a chain that is not supported: CERTEN_CHAIN, not --chain', async () => {
    const { home } = await homeWith({ identities: [ALPHA] });
    const r = await certen(home, ['--json', ...callArgs], 'http://127.0.0.1:1', { CERTEN_CHAIN: 'basee' });
    expect(r.code).toBe(2);
    const e = envelope(r).error!;
    expect(e.code).toBe('UNSUPPORTED_CHAIN');
    expect(e.message).toContain('CERTEN_CHAIN');
  });

  it('signs with the only local key when --sign-with is omitted, and says which key before it shows what it signs', async () => {
    const { home, publicKey } = await homeWith({ identities: [ALPHA], keys: ['dev'] });
    const gw = await stub(gateway(publicKey));
    try {
      const r = await certen(home, ['call', '--to', TO, '--fn', 'confirm(bytes32)', '--arg', B32, '--no-wait'], gw.url);
      expect(r.code, r.stderr).toBe(0);
      expect(gw.paths()).toContain('POST /v1/transaction/intent-1/signature');
      const say = r.stderr.indexOf('using key dev (the only signing key on this machine)');
      expect(say).toBeGreaterThanOrEqual(0);
      const shows = r.stderr.search(/You are about to sign/);
      expect(shows).toBeGreaterThan(say);
    } finally { await gw.close(); }
  });

  it('does not choose between several local keys: it lists them, and sends nothing', async () => {
    const { home } = await homeWith({ identities: [ALPHA], keys: ['dev', 'prod'] });
    const gw = await stub(gateway());
    try {
      const r = await certen(home, ['--json', 'call', '--to', TO, '--fn', 'confirm(bytes32)', '--arg', B32], gw.url);
      expect(r.code).toBe(2);
      const e = envelope(r).error!;
      expect(e.code).toBe('MISSING_SIGNING_KEY');
      expect(e.message).toContain('dev');
      expect(e.message).toContain('prod');
      expect(e.message).toContain('certen use key');
      expect(gw.paths().filter((p) => p.startsWith('POST'))).toEqual([]);
    } finally { await gw.close(); }
  });

  it('uses the key a profile chose over the other local keys', async () => {
    const { home, publicKey } = await homeWith({ identities: [ALPHA], keys: ['dev', 'prod'], config: { profiles: { default: { key: 'dev' } } } });
    const gw = await stub(gateway(publicKey));
    try {
      const r = await certen(home, ['call', '--to', TO, '--fn', 'confirm(bytes32)', '--arg', B32, '--no-wait'], gw.url);
      expect(r.code, r.stderr).toBe(0);
      expect(r.stderr).toContain('using key dev (from profile "default")');
    } finally { await gw.close(); }
  });

  it('still says there is nothing to sign with when there is no key at all (the code is unchanged)', async () => {
    const { home } = await homeWith({ identities: [ALPHA] });
    const gw = await stub(gateway());
    try {
      const r = await certen(home, ['--json', 'call', '--to', TO, '--fn', 'confirm(bytes32)', '--arg', B32], gw.url);
      expect(r.code).toBe(2);
      expect(envelope(r).error!.code).toBe('MISSING_SIGNING_KEY');
    } finally { await gw.close(); }
  });

  it('takes units for --timeout, and refuses a bad one before any request', async () => {
    const { home } = await homeWith({ identities: [ALPHA] });
    const gw = await stub(gateway());
    try {
      const ok = await certen(home, [...callArgs, '--timeout', '6m', '--poll-interval', '2s'], gw.url);
      expect(ok.code, ok.stderr).toBe(0);
      gw.seen.length = 0;
      const bad = await certen(home, ['--json', ...callArgs, '--timeout', 'soon'], gw.url);
      expect(bad.code).toBe(2);
      expect(envelope(bad).error!.code).toBe('INVALID_TIMEOUT');
      expect(gw.seen).toHaveLength(0);
    } finally { await gw.close(); }
  });
});

describe('certen tx create', () => {
  const baseArgs = ['tx', 'create', '--to', TO, '--amount', '0.001'];

  it('derives --from from the identity, and reads the identity once for the ADI, the account and the funding guard', async () => {
    const { home, publicKey } = await homeWith({ identities: [ALPHA], keys: ['dev'] });
    const gw = await stub(gateway(publicKey));
    try {
      const r = await certen(home, [...baseArgs, '--sign-with', 'dev', '--no-wait'], gw.url);
      expect(r.code, r.stderr).toBe(0);
      expect(gw.paths()).toEqual([`GET /v1/identity/${ID_A}`, 'POST /v1/transaction', 'POST /v1/transaction/intent-1/signature']);
      const open = gw.seen.find((e) => e.path === '/v1/transaction')!;
      expect(open.body.identity_id).toBe(ID_A);
      expect(open.body.intent).toMatchObject({ fromAddress: ABSTRACT, toAddress: TO, toChain: 'base-sepolia', amount: '0.001' });
      expect(r.stderr).toContain(`using identity ${ADI_A} (the only identity recorded on this machine)`);
      expect(r.stderr).toContain('using chain base-sepolia (the only chain this identity is linked to)');
      expect(r.stderr).toContain(`using from ${ABSTRACT}`);
    } finally { await gw.close(); }
  });

  it('does not default a signing key: without --sign-with it opens the intent and returns signing data, as it always did', async () => {
    const { home, publicKey } = await homeWith({ identities: [ALPHA], keys: ['dev'] });
    const gw = await stub(gateway(publicKey));
    try {
      const r = await certen(home, ['--json', ...baseArgs], gw.url);
      expect(r.code, r.stderr).toBe(0);
      expect(envelope(r).data).toHaveProperty('signing_data');
      expect(gw.paths()).not.toContain('POST /v1/transaction/intent-1/signature');
      expect(r.stderr).not.toMatch(/using key/);
    } finally { await gw.close(); }
  });

  it('honours an explicit --from, and says nothing about a value that was typed', async () => {
    const { home } = await homeWith({ identities: [ALPHA] });
    const gw = await stub(gateway());
    const mine = `0x${'12'.repeat(20)}`;
    try {
      const r = await certen(home, [...baseArgs, '--identity', ID_A, '--to-chain', 'base-sepolia', '--from', mine], gw.url);
      expect(r.code, r.stderr).toBe(0);
      expect(gw.seen.find((e) => e.path === '/v1/transaction')!.body.intent.fromAddress).toBe(mine);
      expect(r.stderr).not.toMatch(/using (identity|chain|from)/);
    } finally { await gw.close(); }
  });

  it('still names --to-chain as missing when no context supplies a chain', async () => {
    const { home } = await homeWith({ identities: [{ ...ALPHA, chains: [] }] });
    const gw = await stub(gateway());
    try {
      const r = await certen(home, ['--json', ...baseArgs], gw.url);
      expect(r.code).toBe(2);
      const e = envelope(r).error!;
      expect(e.code).toBe('INCOMPLETE_INTENT');
      // --to-chain is what is missing. --from no longer is: it is derived, and the message says so rather than asking for it.
      expect(e.message).toMatch(/^A simple transfer needs --to-chain./);
      expect(gw.seen).toHaveLength(0);
    } finally { await gw.close(); }
  });

  it('takes the chain from the profile, and refuses one that is not a known testnet', async () => {
    const { home } = await homeWith({ identities: [{ ...ALPHA, chains: [] }], config: { profiles: { default: { chain: 'base-sepolia' } } } });
    const gw = await stub(gateway());
    try {
      const ok = await certen(home, [...baseArgs], gw.url);
      expect(ok.code, ok.stderr).toBe(0);
      expect(ok.stderr).toContain('using chain base-sepolia (from profile "default")');
    } finally { await gw.close(); }
    const bad = await homeWith({ identities: [ALPHA], config: { profiles: { default: { chain: 'base' } } } });
    const gw2 = await stub(gateway());
    try {
      const r = await certen(bad.home, ['--json', ...baseArgs], gw2.url, { CERTEN_ALLOW_ANY_CHAIN: '1' });
      expect(r.code).toBe(2);
      expect(envelope(r).error!.code).toBe('MAINNET_DEFAULT_REFUSED');
      expect(gw2.seen).toHaveLength(0);
    } finally { await gw2.close(); }
  });

  it('names the problem when the identity has no account on the chain', async () => {
    const { home } = await homeWith({ identities: [ALPHA] });
    const gw = await stub(gateway());
    try {
      const r = await certen(home, ['--json', ...baseArgs, '--to-chain', 'arbitrum-sepolia'], gw.url);
      expect(r.code).toBe(1);
      const e = envelope(r).error!;
      expect(e.code).toBe('NO_ABSTRACT_ACCOUNT');
      expect(e.message).toContain('certen identity link-chain');
    } finally { await gw.close(); }
  });

  it('takes a name or an ADI URL for --identity', async () => {
    const { home } = await homeWith({ identities: [ALPHA, BETA] });
    const gw = await stub(gateway());
    try {
      for (const ref of ['alpha', ADI_A]) {
        gw.seen.length = 0;
        const r = await certen(home, ['--json', ...baseArgs, '--identity', ref, '--to-chain', 'base-sepolia'], gw.url);
        expect(r.code, `${ref}: ${r.stderr}`).toBe(0);
        expect(gw.seen.find((e) => e.path === '/v1/transaction')!.body.identity_id).toBe(ID_A);
      }
    } finally { await gw.close(); }
  });

  it('leaves the --intent path as it was: no chain and no --from needed, the funding guard reads the portfolio', async () => {
    const { home } = await homeWith({ identities: [ALPHA] });
    const gw = await stub(gateway());
    try {
      const intent = JSON.stringify({ adiUrl: ADI_A, fromChain: 'accumulate', toChain: 'base-sepolia', fromAddress: ABSTRACT, toAddress: TO, amount: '0.001' });
      const r = await certen(home, ['--json', 'tx', 'create', '--identity', ID_A, '--intent', intent], gw.url);
      expect(r.code, r.stderr).toBe(0);
      expect(gw.paths()).toEqual(['GET /v1/portfolio', 'POST /v1/transaction']);
    } finally { await gw.close(); }
  });

  it('takes units for --timeout', async () => {
    const { home } = await homeWith({ identities: [ALPHA] });
    const gw = await stub(gateway());
    try {
      const bad = await certen(home, ['--json', ...baseArgs, '--timeout', '6 minutes'], gw.url);
      expect(bad.code).toBe(2);
      expect(envelope(bad).error!.code).toBe('INVALID_TIMEOUT');
      expect(gw.seen).toHaveLength(0);
    } finally { await gw.close(); }
  });
});

describe('certen identity', () => {
  it('get: takes a name, an ADI URL or a UUID, and with none takes the context identity and says so', async () => {
    const { home } = await homeWith({ identities: [ALPHA] });
    const gw = await stub(gateway());
    try {
      for (const ref of ['alpha', ADI_A, ID_A]) {
        gw.seen.length = 0;
        const r = await certen(home, ['--json', 'identity', 'get', ref], gw.url);
        expect(r.code, `${ref}: ${r.stderr}`).toBe(0);
        expect(envelope(r).data.id).toBe(ID_A);
        expect(gw.paths(), ref).toEqual([`GET /v1/identity/${ID_A}`]);
      }
      gw.seen.length = 0;
      const ctx = await certen(home, ['--json', 'identity', 'get'], gw.url);
      expect(ctx.code, ctx.stderr).toBe(0);
      expect(ctx.stderr).toContain(`using identity ${ADI_A} (the only identity recorded on this machine)`);
    } finally { await gw.close(); }
  });

  it('retire: takes a name, but never defaults: destroying the identity of the day is not a thing to infer', async () => {
    const { home } = await homeWith({ identities: [ALPHA] });
    const gw = await stub(async (e) => {
      if (e.method === 'DELETE') return { body: { id: ID_A, status: 'retired' } };
      return gateway()(e);
    });
    try {
      const none = await certen(home, ['--json', 'identity', 'retire', '--yes'], gw.url);
      expect(none.code).toBe(2);
      expect(gw.paths()).not.toContain(`DELETE /v1/identity/${ID_A}`);

      const named = await certen(home, ['--json', 'identity', 'retire', 'alpha', '--yes'], gw.url);
      expect(named.code, named.stderr).toBe(0);
      expect(gw.paths()).toContain(`DELETE /v1/identity/${ID_A}`);
    } finally { await gw.close(); }
  });

  it('link-chain: takes the context identity and the context chain', async () => {
    const { home } = await homeWith({ identities: [ALPHA], config: { profiles: { default: { chain: 'arbitrum-sepolia' } } } });
    const gw = await stub(gateway());
    try {
      const r = await certen(home, ['--json', 'identity', 'link-chain'], gw.url);
      expect(r.code, r.stderr).toBe(0);
      const patch = gw.seen.find((e) => e.method === 'PATCH')!;
      expect(patch.path).toBe(`/v1/identity/${ID_A}`);
      expect(JSON.stringify(patch.body)).toContain('arbitrum-sepolia');
      expect(r.stderr).toContain('using chain arbitrum-sepolia (from profile "default")');
    } finally { await gw.close(); }
  });

  it('create: records the name it was created with, so --identity <name> finds it', async () => {
    const { home, publicKey } = await homeWith({ keys: ['dev'] });
    const gw = await stub(async (e) => {
      if (e.method === 'POST' && e.path === '/v1/identity') return { status: 202, body: { id: ID_A, adi_url: 'acc://mybot.acme', status: 'provisioning', can_sign: null } };
      if (e.method === 'GET' && e.path === `/v1/identity/${ID_A}`) return { body: baseIdentity(ID_A, 'acc://mybot.acme') };
      return { status: 404, body: {} };
    });
    try {
      const made = await certen(home, ['--json', 'identity', 'create', '--name', 'mybot', '--sign-with', 'dev', '--chains', 'base-sepolia', '--no-wait'], gw.url);
      expect(made.code, made.stderr).toBe(0);
      void publicKey;
      gw.seen.length = 0;
      const got = await certen(home, ['--json', 'identity', 'get', 'mybot'], gw.url);
      expect(got.code, got.stderr).toBe(0);
      expect(gw.paths()).toEqual([`GET /v1/identity/${ID_A}`]);
    } finally { await gw.close(); }
  });
});

describe('certen governance', () => {
  it('takes the identity from context, sends the ADI the route wants, and does not default a signing key', async () => {
    const { home, publicKey } = await homeWith({ identities: [ALPHA], keys: ['dev'] });
    const gw = await stub(gateway(publicKey));
    try {
      const r = await certen(home, ['--json', 'governance', 'add-key', '--public-key-hash', PKH], gw.url);
      expect(r.code, r.stderr).toBe(0);
      expect(r.stderr).toContain(`using identity ${ADI_A} (the only identity recorded on this machine)`);
      expect(gw.seen.find((e) => e.path === '/v1/governance')!.body.identity).toBe(ADI_A);
      // Omitting --sign-with is the external-signer mode: nothing is signed here.
      expect(gw.paths().filter((p) => p.includes('/signature'))).toEqual([]);
      expect(r.stderr).not.toMatch(/using key/);
    } finally { await gw.close(); }
  });

  it('turns a UUID or a name into the ADI, from the local record, without asking the gateway', async () => {
    const { home, publicKey } = await homeWith({ identities: [ALPHA, BETA], keys: ['dev'] });
    const gw = await stub(gateway(publicKey));
    try {
      for (const ref of [ID_B, 'beta', ADI_B]) {
        gw.seen.length = 0;
        const r = await certen(home, ['--json', 'governance', 'add-key', '--identity', ref, '--public-key-hash', PKH], gw.url);
        expect(r.code, `${ref}: ${r.stderr}`).toBe(0);
        expect(gw.paths(), ref).toEqual(['POST /v1/governance']);
        expect(gw.seen[0]!.body.identity).toBe(ADI_B);
      }
    } finally { await gw.close(); }
  });

  it('asks the gateway for the ADI of a UUID this machine has no record of', async () => {
    const { home, publicKey } = await homeWith({ keys: ['dev'] });
    const gw = await stub(gateway(publicKey));
    try {
      const r = await certen(home, ['--json', 'governance', 'add-key', '--identity', ID_A, '--public-key-hash', PKH], gw.url);
      expect(r.code, r.stderr).toBe(0);
      expect(gw.paths()).toEqual([`GET /v1/identity/${ID_A}`, 'POST /v1/governance']);
      expect(gw.seen[1]!.body.identity).toBe(ADI_A);
    } finally { await gw.close(); }
  });

  it('builds `--account book` from the resolved ADI, not from what was typed', async () => {
    const { home, publicKey } = await homeWith({ identities: [ALPHA], keys: ['dev'] });
    const gw = await stub(gateway(publicKey));
    try {
      const r = await certen(home, ['--json', 'governance', 'add-authority', '--identity', 'alpha', '--authority', 'acc://policy.acme/book', '--account', 'book'], gw.url);
      expect(r.code, r.stderr).toBe(0);
      expect(gw.seen.find((e) => e.path === '/v1/governance')!.body.operations[0].account_url).toBe(`${ADI_A}/book`);
    } finally { await gw.close(); }
  });

  it('asks which identity when there are several and none is chosen', async () => {
    const { home } = await homeWith({ identities: [ALPHA, BETA] });
    const gw = await stub(gateway());
    try {
      const r = await certen(home, ['--json', 'governance', 'set-threshold', '--threshold', '2'], gw.url);
      expect(r.code).toBe(2);
      expect(envelope(r).error!.code).toBe('AMBIGUOUS_IDENTITY');
      expect(gw.seen).toHaveLength(0);
    } finally { await gw.close(); }
  });
});

describe('certen pending / portfolio', () => {
  it('pending list and portfolio: --identity is a filter, so it takes any spelling and is never filled in from context', async () => {
    const { home } = await homeWith({ identities: [ALPHA] });
    const gw = await stub(gateway());
    try {
      await certen(home, ['--json', 'pending', 'list'], gw.url);
      await certen(home, ['--json', 'pending', 'list', '--identity', 'alpha'], gw.url);
      await certen(home, ['--json', 'portfolio'], gw.url);
      await certen(home, ['--json', 'portfolio', '--identity', ADI_A], gw.url);
      const q = gw.seen.map((e) => `${e.path}?${e.query}`);
      expect(q[0]).toBe('/v1/pending?');
      expect(q[1]).toContain(`identity=${ID_A}`);
      expect(q[2]).toBe('/v1/portfolio?');
      // axios leaves ':' unescaped in a query; compare what the gateway decodes.
      expect(decodeURIComponent(q[3]!)).toContain(`identity=${ADI_A}`);
    } finally { await gw.close(); }
  });

  it('pending sign by transaction hash: the identity comes from context, so only the details nobody can derive are missing', async () => {
    const { home } = await homeWith({ identities: [ALPHA] });
    const gw = await stub(gateway());
    try {
      const r = await certen(home, ['--json', 'pending', 'sign', 'ab'.repeat(32)], gw.url);
      expect(r.code).toBe(2);
      const e = envelope(r).error!;
      expect(e.code).toBe('MISSING_SIGNER_DETAILS');
      expect(e.message).toContain('--signer-url');
      expect(e.message).toContain('--public-key');
      expect(e.message).not.toContain('--identity');
      expect(gw.seen).toHaveLength(0);
    } finally { await gw.close(); }
  });

  it('pending sign by transaction hash: a name is sent as the identity the route accepts', async () => {
    const { home, publicKey } = await homeWith({ identities: [ALPHA], keys: ['dev'] });
    const gw = await stub(async (e) => {
      if (e.method === 'POST' && e.path === '/v1/sign') return { status: 200, body: { sign_request_id: 'sr-1', signing_data: { data_for_signature: 'ab'.repeat(32) } } };
      return gateway(publicKey)(e);
    });
    try {
      await certen(home, ['--json', 'pending', 'sign', 'ab'.repeat(32), '--identity', 'alpha', '--signer-url', `${ADI_A}/book/1`, '--public-key', publicKey!], gw.url);
      const sign = gw.seen.find((e) => e.path === '/v1/sign')!;
      expect(sign.body.identity).toBe(ID_A);
    } finally { await gw.close(); }
  });
});

describe('certen fund', () => {
  it('keeps CHAIN_REQUIRED when nothing supplies a chain', async () => {
    const { home } = await homeWith({ identities: [ALPHA] });
    const gw = await stub(gateway());
    try {
      // The identity's only linked chain is NOT a default here: what is funded is the organization's balance, not an identity.
      const r = await certen(home, ['--json', 'fund', '25'], gw.url);
      expect(r.code).toBe(2);
      expect(envelope(r).error!.code).toBe('CHAIN_REQUIRED');
      expect(gw.seen).toHaveLength(0);
    } finally { await gw.close(); }
  });

  it('takes the chain from the profile and says so; refuses one that is not a known testnet', async () => {
    const { home } = await homeWith({ config: { profiles: { default: { chain: 'base-sepolia' } } } });
    const gw = await stub(gateway());
    try {
      const r = await certen(home, ['--json', 'fund', '25', '--no-wait'], gw.url);
      expect(r.stderr).toContain('using chain base-sepolia (from profile "default")');
      expect(envelope(r).error?.code).not.toBe('CHAIN_REQUIRED');
    } finally { await gw.close(); }

    const bad = await homeWith({ config: { profiles: { default: { chain: 'base' } } } });
    const gw2 = await stub(gateway());
    try {
      const r = await certen(bad.home, ['--json', 'fund', '25'], gw2.url, { CERTEN_ALLOW_ANY_CHAIN: '1' });
      expect(r.code).toBe(2);
      expect(envelope(r).error!.code).toBe('MAINNET_DEFAULT_REFUSED');
      expect(gw2.seen).toHaveLength(0);
    } finally { await gw2.close(); }
  });
});
