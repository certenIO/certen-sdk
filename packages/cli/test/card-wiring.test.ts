import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import { honestIntent, honestGovernance, honestCosign } from '../../sdk/test/helpers/honest-gateway.js';
import type { Prompter } from '../src/prompt.js';

/**
 * The confirmation before a signature, on the four commands that have always signed straight away.
 *
 * `call`, `tx create --sign-with`, `governance <op> --sign-with` and `pending sign --sign-with` now show the card and, where a person is at a
 * terminal, ask. A test cannot sit at a TTY, so these run in-process with a scripted prompter standing in for the person. Piped runs are the
 * existing suites (signing.test.ts and the rest), which are unchanged and green: that is the evidence a script that signs unattended today still does.
 *
 * What is pinned:
 *  - a person who says NO signs nothing: no signature reaches the gateway, the failure is SIGNING_DECLINED (exit 1) and names the intent that will expire;
 *  - a person who says YES signs, once;
 *  - `--yes` shows the card and asks nothing, even where the person would have said no;
 *  - with nobody to ask (a pipe) the card is shown and the command goes on, as it always has.
 */

let scratch = '';
vi.mock('os', async (orig) => ({ ...(await orig<typeof import('os')>()), homedir: () => scratch }));
vi.mock('node:os', async (orig) => ({ ...(await orig<typeof import('node:os')>()), homedir: () => scratch }));

const HERE = dirname(fileURLToPath(import.meta.url));
const ID = '11111111-2222-4333-8444-555555555555';
const ADI = 'acc://sign-test.acme';
const ABSTRACT = `0x${'ab'.repeat(20)}`;
const TO = `0x${'be'.repeat(20)}`;
const vectors = JSON.parse(readFileSync(join(HERE, '..', '..', 'verify', 'test', 'fixtures', 'signing-vectors.json'), 'utf8')).vectors;
const real = vectors.find((v: any) => v.label === 'four-leg');
const TXID = real.txid.match(/[0-9a-f]{64}/)[0];

const identity = {
  id: ID, adi_url: ADI, book_url: `${ADI}/book`, key_page_url: `${ADI}/book/1`, status: 'active', can_sign: true, credit_balance: 500,
  chain_accounts: [{ chain_id: '11155111', address: ABSTRACT, status: 'deployed' }], created_at: '2026-01-01T00:00:00Z',
};

interface Req { method: string; path: string; body?: any }
async function stub(handler: (e: Req) => { status?: number; body?: unknown } | Promise<{ status?: number; body?: unknown }>) {
  const seen: Req[] = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const e: Req = { method: req.method ?? 'GET', path: (req.url ?? '').split('?')[0]!, body: raw ? JSON.parse(raw) : undefined };
      seen.push(e);
      Promise.resolve(handler(e)).then((out) => { res.writeHead(out.status ?? 200, { 'content-type': 'application/json' }).end(JSON.stringify(out.body ?? {})); })
        .catch(() => { res.statusCode = 500; res.end('{}'); });
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  return { seen, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => new Promise<void>((r) => { server.closeAllConnections?.(); server.close(() => r()); }) };
}
const sigPosts = (g: { seen: Req[] }) => g.seen.filter((e) => e.path.endsWith('/signature') && e.method === 'POST');

function scripted(answer: boolean, interactive = true): Prompter & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked, interactive,
    async ask(_q, fallback) { return fallback; },
    async confirm(q) { asked.push(q); return answer; },
    async choose() { return undefined; },
  };
}

let gw: Awaited<ReturnType<typeof stub>> | undefined;
let err: string[] = [];
let out: string[] = [];
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'certen-card-wiring-'));
  for (const v of Object.keys(process.env)) if (v.startsWith('CERTEN_')) delete process.env[v];
  process.env.CERTEN_API_KEY = 'ck_live_test';
  vi.resetModules();
  err = []; out = [];
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { err.push(a.join(' ')); });
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { out.push(a.join(' ')); });
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => { out.push(String(chunk)); return true; });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await gw?.close();
  gw = undefined;
  try { rmSync(scratch, { recursive: true, force: true }); } catch { /* noop */ }
});

/** Make a key in the scratch home, put the prompter in place, and run the CLI in this process. */
async function drive(url: string, prompter: Prompter, args: (publicKey: string) => string[]): Promise<{ code: number; errorCode?: string }> {
  process.env.CERTEN_API_URL = url;
  const prompt = await import('../src/prompt.js');
  prompt.setPrompterOverride(prompter);
  const keystore = await import('../src/keystore.js');
  const info = keystore.keyExists('dev') ? keystore.getKeyInfo('dev') : keystore.generateKey('dev', null);
  const { run } = await import('../src/index.js');
  // Whether to wait is read from process.argv (so that "no flag" and "--wait" can be told apart), and in-process that is vitest's. Say what was typed.
  const argv = ['node', 'certen', ...args(info.publicKey)];
  const saved = process.argv;
  process.argv = argv;
  let code: number;
  try { code = await run(argv); } finally { process.argv = saved; }
  // Not --json: the question is only asked of a person, and a machine caller is never asked. The failure is read from what a person sees.
  const failure = err.map((l) => /^Error \[([A-Z_]+)\]/.exec(l)).find(Boolean);
  return { code, errorCode: failure?.[1] };
}

type Case = {
  name: string;
  /** The command, as a person types it (no --json: a machine caller is never asked). */
  args: (publicKey: string) => string[];
  handler: (publicKey: string) => (e: Req) => { status?: number; body?: unknown } | Promise<{ status?: number; body?: unknown }>;
  /** What the card says it is about. */
  card: RegExp;
};

const CASES: Case[] = [
  {
    name: 'tx create --sign-with',
    args: () => ['tx', 'create', '--identity', ID, '--to-chain', 'ethereum-sepolia', '--from', ABSTRACT, '--to', TO, '--amount', '0.001', '--sign-with', 'dev', '--no-wait', '--force'],
    handler: (publicKey) => async (e) => {
      if (e.path === `/v1/identity/${ID}`) return { body: identity };
      if (e.path === '/v1/transaction' && e.method === 'POST') return honestIntent(e.body, { adiUrl: ADI });
      return { body: { status: 'submitted' } };
    },
    card: /Send 0\.001 on ethereum-sepolia/,
  },
  {
    name: 'governance add-key --sign-with',
    args: () => ['governance', 'add-key', '--identity', ADI, '--public-key-hash', 'cc'.repeat(32), '--sign-with', 'dev'],
    handler: (publicKey) => (e) => (e.path === '/v1/governance' && e.method === 'POST'
      ? honestGovernance(e.body.operations[0], ADI, { publicKey }) : { body: { status: 'submitted' } }),
    card: /Change who may sign for acc:\/\/sign-test\.acme/,
  },
  {
    name: 'pending sign --sign-with',
    args: (publicKey) => ['pending', 'sign', TXID, '--identity', 'acc://panel.acme', '--signer-url', 'acc://panel.acme/book/1', '--public-key', publicKey, '--sign-with', 'dev'],
    handler: (publicKey) => (e) => (e.path === '/v1/sign' ? honestCosign(real, { publicKey, signer: 'acc://panel.acme/book/1' }) : { body: { status: 'submitted' } }),
    card: /Cast a vote \(approve\) on pending transaction/,
  },
  {
    name: 'call',
    args: () => ['call', '--identity', ID, '--chain', 'ethereum-sepolia', '--to', TO, '--fn', 'confirm(bytes32)', '--arg', `0x${'00'.repeat(32)}`, '--sign-with', 'dev', '--no-wait'],
    handler: (publicKey) => async (e) => {
      if (e.path === `/v1/identity/${ID}`) return { body: identity };
      if (e.path === '/v1/transaction' && e.method === 'POST') return honestIntent(e.body);
      return { body: { status: 'submitted' } };
    },
    card: /Call confirm\(bytes32\) on ethereum-sepolia/,
  },
];

describe.each(CASES)('$name asks before it signs', (c) => {
  it('signs nothing when a person says no, fails SIGNING_DECLINED, and has shown the card first', async () => {
    const keyed = await keyOf();
    gw = await stub(c.handler(keyed));
    const person = scripted(false);
    const r = await drive(gw.url, person, c.args);
    expect(r.code).toBe(1);
    expect(r.errorCode).toBe('SIGNING_DECLINED');
    expect(err.join('\n')).toMatch(/was opened and will expire unsigned|Not signed./);
    expect(person.asked).toEqual(['  Sign with "dev"?']);
    expect(sigPosts(gw)).toHaveLength(0);
    const shown = err.join('\n');
    expect(shown).toMatch(c.card);
    expect(shown).toMatch(/You are about to sign/);
    expect(shown).toMatch(/The signature authorises exactly this/);
  });

  it('signs once when a person says yes', async () => {
    const keyed = await keyOf();
    gw = await stub(c.handler(keyed));
    const person = scripted(true);
    const r = await drive(gw.url, person, c.args);
    expect(r.code, err.join('\n')).toBe(0);
    expect(person.asked).toHaveLength(1);
    expect(sigPosts(gw)).toHaveLength(1);
  });

  it('--yes shows the card, asks nothing and signs, even where the person would have said no', async () => {
    const keyed = await keyOf();
    gw = await stub(c.handler(keyed));
    const person = scripted(false);
    const r = await drive(gw.url, person, (k) => [...c.args(k), '--yes']);
    expect(r.code, err.join('\n')).toBe(0);
    expect(person.asked).toEqual([]);
    expect(sigPosts(gw)).toHaveLength(1);
    expect(err.join('\n')).toMatch(c.card);
  });

  it('with nobody to ask (a pipe) shows the card and signs, as it always has', async () => {
    const keyed = await keyOf();
    gw = await stub(c.handler(keyed));
    const pipe = scripted(false, false);
    const r = await drive(gw.url, pipe, c.args);
    expect(r.code, err.join('\n')).toBe(0);
    expect(pipe.asked).toEqual([]);
    expect(sigPosts(gw)).toHaveLength(1);
    expect(err.join('\n')).toMatch(/You are about to sign/);
  });
});

/** The public key of the key `drive` will make, known before the gateway stub is built (the stub signs its data for that key). */
async function keyOf(): Promise<string> {
  // `drive` generates the key; the stub needs its public key up front. Generate it here, and `drive` reuses the file by name.
  const keystore = await import('../src/keystore.js');
  const info = keystore.generateKey('dev', null);
  return info.publicKey;
}
