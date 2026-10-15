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
 * `identity create` and `identity mnemonic`, with the context.
 *
 * `identity create` cannot run without a key: leaving `--sign-with` out was always `MISSING_SIGNING_KEY`. That is exactly where a context
 * key is safe to default (no invocation that worked changes meaning), so it fills the gap, says which key it chose before the
 * passphrase prompt, and never chooses between several. The key it picks owns the identity, so the echo matters most here.
 *
 * `identity mnemonic <id> <token>` collects a one-time seed. The id part may be any spelling of the identity; the token stays the
 * token. A retrieval URL is left exactly as it was.
 */
const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'index.js');
const run = promisify(execFile);

const ID_A = '11111111-1111-4111-8111-111111111111';
const ADI_A = 'acc://alpha.acme';

interface Req { method: string; path: string; body?: any }
type Out = { status?: number; body?: unknown };

async function stub(handler: (e: Req) => Out) {
  const seen: Req[] = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const e: Req = { method: req.method ?? 'GET', path: (req.url ?? '').split('?')[0]!, body: raw ? JSON.parse(raw) : undefined };
      seen.push(e);
      const out = handler(e);
      res.writeHead(out.status ?? 200, { 'content-type': 'application/json' }).end(JSON.stringify(out.body ?? {}));
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
async function certen(home: string, args: string[], url = 'http://127.0.0.1:1'): Promise<Run> {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>), HOME: home, USERPROFILE: home,
    CERTEN_API_URL: url, CERTEN_API_KEY: 'ck_live_test', NO_PROXY: '127.0.0.1,localhost',
  };
  for (const k of ['CERTEN_IDENTITY', 'CERTEN_KEY', 'CERTEN_CHAIN', 'CERTEN_PROFILE', 'CERTEN_ALLOW_ANY_CHAIN']) delete env[k];
  try {
    const { stdout, stderr } = await run(process.execPath, [CLI, ...args], { env, encoding: 'utf8', cwd: home, timeout: 60000 });
    return { stdout, stderr, code: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: number };
    return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', code: typeof e.code === 'number' ? e.code : -1 };
  }
}

const envelope = (r: Run): { ok: boolean; data?: any; error?: { code: string; message: string } } => {
  const t = r.stdout.trim();
  expect(t.length, `stdout was empty; stderr: ${r.stderr}`).toBeGreaterThan(0);
  return JSON.parse(t);
};

async function homeWith(keys: string[], config: Record<string, unknown> = {}): Promise<{ home: string; hashes: Record<string, string> }> {
  const home = mkdtempSync(join(tmpdir(), 'certen-idcreate-'));
  mkdirSync(join(home, '.certen'), { recursive: true });
  writeFileSync(join(home, '.certen', 'config.json'), JSON.stringify({
    identities: [{ id: ID_A, adi_url: ADI_A, chains: [], name: 'alpha', created_at: '2026-10-01T00:00:00Z' }],
    ...config,
  }));
  const hashes: Record<string, string> = {};
  for (const name of keys) {
    const d = envelope(await certen(home, ['--json', 'keys', 'generate', '--name', name, '--no-passphrase'])).data;
    hashes[name] = d.public_key_hash;
  }
  return { home, hashes };
}

const created = { id: ID_A, adi_url: 'acc://mybot.acme', status: 'provisioning', can_sign: null };
const gateway = (e: Req): Out => (e.method === 'POST' && e.path === '/v1/identity' ? { status: 202, body: created } : { status: 404, body: {} });

describe('certen identity create: the key', () => {
  it('uses the only local key when none is given, and says so before it creates anything', async () => {
    const { home, hashes } = await homeWith(['dev']);
    const gw = await stub(gateway);
    try {
      const r = await certen(home, ['--json', 'identity', 'create', '--name', 'mybot', '--no-wait'], gw.url);
      expect(r.code, r.stderr).toBe(0);
      expect(r.stderr).toContain('using key dev (the only signing key on this machine)');
      expect(gw.seen.find((e) => e.path === '/v1/identity')!.body.public_key_hash).toBe(hashes.dev);
    } finally { await gw.close(); }
  });

  it('uses the key a profile chose over the others', async () => {
    const { home, hashes } = await homeWith(['dev', 'prod'], { profiles: { default: { key: 'prod' } } });
    const gw = await stub(gateway);
    try {
      const r = await certen(home, ['--json', 'identity', 'create', '--name', 'mybot', '--no-wait'], gw.url);
      expect(r.code, r.stderr).toBe(0);
      expect(r.stderr).toContain('using key prod (from profile "default")');
      expect(gw.seen.find((e) => e.path === '/v1/identity')!.body.public_key_hash).toBe(hashes.prod);
    } finally { await gw.close(); }
  });

  it('does not choose between several keys: it lists them, and creates nothing (the identity slot is quota)', async () => {
    const { home } = await homeWith(['dev', 'prod']);
    const gw = await stub(gateway);
    try {
      const r = await certen(home, ['--json', 'identity', 'create', '--name', 'mybot'], gw.url);
      expect(r.code).toBe(2);
      const e = envelope(r).error!;
      expect(e.code).toBe('MISSING_SIGNING_KEY');
      expect(e.message).toContain('dev');
      expect(e.message).toContain('prod');
      expect(gw.seen).toHaveLength(0);
    } finally { await gw.close(); }
  });

  it('keeps MISSING_SIGNING_KEY when there is no key at all (the code and the fix are unchanged)', async () => {
    const { home } = await homeWith([]);
    const r = await certen(home, ['--json', 'identity', 'create', '--name', 'mybot']);
    expect(r.code).toBe(2);
    const e = envelope(r).error!;
    expect(e.code).toBe('MISSING_SIGNING_KEY');
    expect(e.message).toContain('certen keys generate');
  });

  it('does not touch the context key when the key material is given explicitly', async () => {
    const { home } = await homeWith(['dev']);
    const gw = await stub(gateway);
    try {
      const pub = 'ab'.repeat(32);
      const r = await certen(home, ['--json', 'identity', 'create', '--name', 'mybot', '--public-key', pub, '--no-wait'], gw.url);
      expect(r.code, r.stderr).toBe(0);
      expect(r.stderr).not.toMatch(/using key/);
    } finally { await gw.close(); }
  });

  it('says what the key is when a profile names one that is not on this machine', async () => {
    const { home } = await homeWith(['dev'], { profiles: { default: { key: 'gone' } } });
    const r = await certen(home, ['--json', 'identity', 'create', '--name', 'mybot']);
    expect(r.code).toBe(2);
    const e = envelope(r).error!;
    expect(e.code).toBe('UNKNOWN_KEY');
    expect(e.message).toContain('profile "default"');
  });
});

describe('certen identity mnemonic: any spelling of the id', () => {
  const TOKEN = 'one-time-token';
  const phrase = { mnemonic: 'abandon ability able about above absent absorb abstract absurd abuse access accident' };
  const serve = (e: Req): Out => (e.method === 'GET' && e.path === `/v1/identity/${ID_A}/mnemonic/${TOKEN}` ? { body: phrase } : { status: 404, body: {} });

  it('takes a name or an ADI URL with the token, and asks the gateway for the UUID\'s route', async () => {
    const { home } = await homeWith([]);
    const gw = await stub(serve);
    try {
      for (const ref of ['alpha', ADI_A, ID_A]) {
        gw.seen.length = 0;
        const r = await certen(home, ['--json', 'identity', 'mnemonic', ref, TOKEN], gw.url);
        expect(r.code, `${ref}: ${r.stderr}`).toBe(0);
        expect(envelope(r).data).toEqual(phrase);
        expect(gw.paths(), ref).toEqual([`GET /v1/identity/${ID_A}/mnemonic/${TOKEN}`]);
      }
    } finally { await gw.close(); }
  });

  it('leaves a retrieval URL exactly as it was', async () => {
    const { home } = await homeWith([]);
    const gw = await stub(serve);
    try {
      const r = await certen(home, ['--json', 'identity', 'mnemonic', `${gw.url}/v1/identity/${ID_A}/mnemonic/${TOKEN}`], gw.url);
      expect(r.code, r.stderr).toBe(0);
      expect(envelope(r).data).toEqual(phrase);
    } finally { await gw.close(); }
  });

  it('refuses a name nobody has BEFORE spending the token: a one-time read must not be sent to a guess', async () => {
    const { home } = await homeWith([]);
    const gw = await stub(serve);
    try {
      const r = await certen(home, ['--json', 'identity', 'mnemonic', 'nobody', TOKEN], gw.url);
      expect(r.code).toBe(2);
      expect(envelope(r).error!.code).toBe('UNKNOWN_IDENTITY_ALIAS');
      expect(gw.seen).toHaveLength(0);
    } finally { await gw.close(); }
  });
});
