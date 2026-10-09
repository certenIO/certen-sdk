import { describe, it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import { reconstructSigning } from '@certen.io/proof-verify';
import { honestIntent, honestGovernance, honestCosign } from '../../sdk/test/helpers/honest-gateway.js';

/**
 * Sign what you see, through the CLI.
 *
 * Every command that signs locally rebuilds the transaction the gateway returned, matches it to the request, prints what the signature
 * will authorise, and only then signs. A gateway that returns anything else gets no signature and the command exits 1 with
 * SIGNING_DATA_MISMATCH. A bare hash is never signed: `--sign-with` + `--hash` is refused by name (exit 2), with no option to override.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, '..', 'dist', 'index.js');
const run = promisify(execFile);
const ID = '11111111-2222-4333-8444-555555555555';
const ADI = 'acc://sign-test.acme';
const ABSTRACT = `0x${'ab'.repeat(20)}`;
const TO = `0x${'be'.repeat(20)}`;
const real = JSON.parse(readFileSync(join(HERE, '..', '..', 'verify', 'test', 'fixtures', 'signing-vectors.json'), 'utf8')).vectors.find((v: any) => v.label === 'four-leg');
const TXID = real.txid.match(/[0-9a-f]{64}/)[0];

interface Req { method: string; path: string; body?: any }
type Out = { status?: number; body?: unknown };
async function stub(handler: (e: Req) => Promise<Out> | Out) {
  const seen: Req[] = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const e: Req = { method: req.method ?? 'GET', path: (req.url ?? '').split('?')[0], body: raw ? JSON.parse(raw) : undefined };
      seen.push(e);
      Promise.resolve(handler(e)).then((out) => { res.writeHead(out.status ?? 200, { 'content-type': 'application/json' }).end(JSON.stringify(out.body ?? {})); })
        .catch(() => { res.statusCode = 500; res.end('{}'); });
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  return { seen, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => new Promise<void>((r) => { server.closeAllConnections?.(); server.close(() => r()); }) };
}

interface Run { stdout: string; stderr: string; code: number }
async function certen(args: string[], url: string, home: string): Promise<Run> {
  const env = { ...(process.env as Record<string, string>), HOME: home, USERPROFILE: home, CERTEN_API_URL: url, CERTEN_API_KEY: 'ck_live_test' };
  try {
    const { stdout, stderr } = await run(process.execPath, [CLI, ...args], { env, encoding: 'utf8', cwd: home, timeout: 60000 });
    return { stdout, stderr, code: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: number };
    return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', code: e.code ?? -1 };
  }
}
/** A home with a key called `dev`, and that key's public key. */
async function homeWithKey(): Promise<{ home: string; publicKey: string }> {
  const home = mkdtempSync(join(tmpdir(), 'certen-sign-'));
  const r = await certen(['--json', 'keys', 'generate', '--name', 'dev', '--no-passphrase'], 'http://127.0.0.1:1', home);
  const out = JSON.parse(r.stdout.trim()).data as { public_key?: string; publicKey?: string };
  return { home, publicKey: (out.public_key ?? out.publicKey)! };
}
const errorOf = (r: Run) => (JSON.parse(r.stdout.trim()) as { error?: { code: string; details?: any } }).error;

const identity = { id: ID, adi_url: ADI, book_url: `${ADI}/book`, key_page_url: `${ADI}/book/1`, status: 'active', can_sign: true, credit_balance: 500, chain_accounts: [{ chain_id: '11155111', address: ABSTRACT, status: 'deployed' }], created_at: '2026-01-01T00:00:00Z' };
const blobs = (tx: any) => tx.body.entry.data.map((h: string) => JSON.parse(Buffer.from(h, 'hex').toString()));
const setBlobs = (tx: any, b: unknown[]) => { tx.body.entry.data = b.map((x) => Buffer.from(JSON.stringify(x)).toString('hex')); };

const CREATE = ['--json', 'tx', 'create', '--identity', ID, '--to-chain', 'ethereum-sepolia', '--from', ABSTRACT, '--to', TO, '--amount', '0.001', '--sign-with', 'dev', '--no-wait', '--force'];
const isOpen = (e: Req) => e.path === '/v1/transaction' && e.method === 'POST';
const sigPosts = (g: { seen: Req[] }) => g.seen.filter((e) => e.path.endsWith('/signature') && e.method === 'POST');

describe('tx create --sign-with', () => {
  it('signs the transaction it asked for, and shows what the signature authorises before signing', async () => {
    const { home } = await homeWithKey();
    const g = await stub((e) => {
      if (e.path === `/v1/identity/${ID}`) return { body: identity };
      if (isOpen(e)) return honestIntent(e.body, { adiUrl: ADI });
      return { body: { ok: true, intent_id: 'intent-1', status: 'submitted' } };
    });
    try {
      const r = await certen(CREATE, g.url, home);
      expect(r.code, r.stdout + r.stderr).toBe(0);
      expect(r.stderr).toMatch(/You are about to sign: cross-chain intent \(intent intent-1\)/);
      expect(r.stderr).toMatch(/plain transfer to 0xbebebebebebebebebebebebebebebebebebebebe, value 1000000000000000 wei/i);
      expect(sigPosts(g)).toHaveLength(1);
    } finally { await g.close(); }
  }, 120000);

  it('refuses a transaction whose recipient was swapped, even with every hash recomputed to match: exit 1, nothing signed', async () => {
    const { home } = await homeWithKey();
    const g = await stub(async (e) => {
      if (e.path === `/v1/identity/${ID}`) return { body: identity };
      if (!isOpen(e)) return { body: { ok: true } };
      const h = await honestIntent(e.body, { adiUrl: ADI });
      const sd = (h.body as any).signing_data;
      const b = blobs(sd.transaction);
      b[1].legs[0].executionPayload.target = `0x${'dd'.repeat(20)}`;
      setBlobs(sd.transaction, b);
      const { initiator, ...header } = sd.transaction.header;
      const r = reconstructSigning({ header, body: sd.transaction.body }, sd.signature_metadata);
      sd.transaction.header = { ...header, initiator: r.signatureMetadataHash };
      sd.transaction_hash = r.transactionHash;
      sd.hash_to_sign = r.hashToSign;
      return h;
    });
    try {
      const r = await certen(CREATE, g.url, home);
      expect(r.code).toBe(1);
      expect(errorOf(r)).toMatchObject({ code: 'SIGNING_DATA_MISMATCH', details: { field: 'legs[0].target' } });
      expect(sigPosts(g)).toHaveLength(0);
    } finally { await g.close(); }
  }, 120000);

  it('refuses a gateway that returns only a hash, as every gateway did before: nothing to check, nothing signed', async () => {
    const { home } = await homeWithKey();
    const g = await stub((e) => {
      if (e.path === `/v1/identity/${ID}`) return { body: identity };
      if (isOpen(e)) return { status: 201, body: { intent_id: 'intent-1', signing_data: { hash_to_sign: 'ab'.repeat(32) } } };
      return { body: { ok: true } };
    });
    try {
      const r = await certen(CREATE, g.url, home);
      expect(r.code).toBe(1);
      expect(errorOf(r)?.code).toBe('SIGNING_DATA_ABSENT');
      expect(sigPosts(g)).toHaveLength(0);
    } finally { await g.close(); }
  }, 120000);
});

describe('a bare hash is never signed', () => {
  it('tx sign --sign-with --hash is refused by name, exit 2, and contacts no gateway', async () => {
    const { home } = await homeWithKey();
    const g = await stub(() => ({ body: {} }));
    try {
      const r = await certen(['--json', 'tx', 'sign', 'intent-1', '--sign-with', 'dev', '--hash', 'ab'.repeat(32)], g.url, home);
      expect(r.code).toBe(2);
      expect(errorOf(r)?.code).toBe('BLIND_SIGNING_REFUSED');
      expect(g.seen).toHaveLength(0);
    } finally { await g.close(); }
  }, 120000);

  it('pending submit and governance sign refuse it too', async () => {
    const { home } = await homeWithKey();
    const g = await stub(() => ({ body: {} }));
    try {
      for (const args of [['pending', 'submit', 'sr-1'], ['governance', 'sign', 'gov-1']]) {
        const r = await certen(['--json', ...args, '--sign-with', 'dev', '--hash', 'ab'.repeat(32)], g.url, home);
        expect(r.code, args.join(' ')).toBe(2);
        expect(errorOf(r)?.code).toBe('BLIND_SIGNING_REFUSED');
      }
      expect(g.seen).toHaveLength(0);
    } finally { await g.close(); }
  }, 120000);

  it('a signature made elsewhere is still accepted (--signature, --public-key)', async () => {
    const { home } = await homeWithKey();
    const g = await stub(() => ({ body: { status: 'submitted' } }));
    try {
      const r = await certen(['--json', 'tx', 'sign', 'intent-1', '--signature', 'ab'.repeat(64), '--public-key', '11'.repeat(32)], g.url, home);
      expect(r.code).toBe(0);
      expect(g.seen[0].path).toBe('/v1/transaction/intent-1/signature');
    } finally { await g.close(); }
  }, 120000);
});

describe('tx inspect', () => {
  it('recomputes every hash and prints what a signature would authorise, signing nothing', async () => {
    const { home } = await homeWithKey();
    const opened = await honestIntent({ intent: { adiUrl: ADI, toChain: 'ethereum-sepolia', toAddress: TO, amount: '0.001' }, signer_public_key: '11'.repeat(32) }, { intentId: 'intent-1' });
    const g = await stub((e) => (e.path === '/v1/transaction/intent-1' ? { body: { intent_id: 'intent-1', status: 'signing_required', signing_data: (opened.body as any).signing_data } } : { body: {} }));
    try {
      const r = await certen(['--json', 'tx', 'inspect', 'intent-1'], g.url, home);
      expect(r.code, r.stdout + r.stderr).toBe(0);
      expect(r.stderr).toMatch(/You are about to sign/);
      expect(JSON.parse(r.stdout.trim()).data).toMatchObject({ intent_id: 'intent-1', matched_to_request: false });
      expect(sigPosts(g)).toHaveLength(0);
      // with the request, it is matched too: another recipient is refused
      const wrong = await certen(['--json', 'tx', 'inspect', 'intent-1', '--intent', JSON.stringify({ adiUrl: ADI, toChain: 'ethereum-sepolia', toAddress: `0x${'dd'.repeat(20)}`, amount: '0.001' })], g.url, home);
      expect(wrong.code).toBe(1);
      expect(errorOf(wrong)?.code).toBe('SIGNING_DATA_MISMATCH');
    } finally { await g.close(); }
  }, 120000);
});

describe('governance <operation> --sign-with', () => {
  const ADD = ['--json', 'governance', 'add-key', '--identity', ADI, '--public-key-hash', 'cc'.repeat(32), '--sign-with', 'dev'];

  it('signs the key change it asked for', async () => {
    const { home, publicKey } = await homeWithKey();
    const g = await stub((e) => (e.path === '/v1/governance' && e.method === 'POST' ? honestGovernance(e.body.operations[0], ADI, { publicKey }) : { body: { status: 'submitted' } }));
    try {
      const r = await certen(ADD, g.url, home);
      expect(r.code, r.stdout + r.stderr).toBe(0);
      expect(r.stderr).toMatch(/You are about to sign: updateKeyPage/);
      expect(g.seen.filter((x) => x.path.endsWith('/signature'))).toHaveLength(1);
    } finally { await g.close(); }
  }, 120000);

  it('refuses a transaction that adds a different key: exit 1, nothing signed', async () => {
    const { home, publicKey } = await homeWithKey();
    const g = await stub((e) => (e.path === '/v1/governance' && e.method === 'POST'
      ? honestGovernance({ type: 'add_key', public_key_hash: 'ee'.repeat(32) }, ADI, { publicKey }) : { body: {} }));
    try {
      const r = await certen(ADD, g.url, home);
      expect(r.code).toBe(1);
      expect(errorOf(r)).toMatchObject({ code: 'SIGNING_DATA_MISMATCH', details: { field: 'transaction.body.operation' } });
      expect(g.seen.filter((x) => x.path.endsWith('/signature'))).toHaveLength(0);
    } finally { await g.close(); }
  }, 120000);
});

describe('pending sign --sign-with', () => {
  const SIGN = (key: string) => ['--json', 'pending', 'sign', TXID, '--identity', 'acc://panel.acme', '--signer-url', 'acc://panel.acme/book/1', '--public-key', key, '--sign-with', 'dev'];

  it('co-signs the transaction it named, after rebuilding it', async () => {
    const { home, publicKey } = await homeWithKey();
    const g = await stub((e) => (e.path === '/v1/sign' ? honestCosign(real, { publicKey, signer: 'acc://panel.acme/book/1' }) : { body: { status: 'submitted' } }));
    try {
      const r = await certen(SIGN(publicKey), g.url, home);
      expect(r.code, r.stdout + r.stderr).toBe(0);
      expect(sigPosts(g)).toHaveLength(1);
    } finally { await g.close(); }
  }, 120000);

  it('refuses when the gateway returns a different transaction than the hash named', async () => {
    const other = JSON.parse(readFileSync(join(HERE, '..', '..', 'verify', 'test', 'fixtures', 'signing-vectors.json'), 'utf8')).vectors.find((v: any) => v.label === 'two-leg');
    const { home, publicKey } = await homeWithKey();
    const g = await stub((e) => (e.path === '/v1/sign' ? honestCosign(other, { publicKey, signer: 'acc://panel.acme/book/1' }) : { body: { status: 'submitted' } }));
    try {
      const r = await certen(SIGN(publicKey), g.url, home);
      expect(r.code).toBe(1);
      expect(errorOf(r)).toMatchObject({ code: 'SIGNING_DATA_MISMATCH', details: { field: 'transaction_hash' } });
      expect(sigPosts(g)).toHaveLength(0);
    } finally { await g.close(); }
  }, 120000);

  it('without --sign-with it creates the request and warns, in the output, that the data was NOT checked when the gateway returned nothing to check', async () => {
    const { home, publicKey } = await homeWithKey();
    const g = await stub((e) => (e.path === '/v1/sign'
      ? { status: 201, body: { sign_request_id: 'sr-1', status: 'signing_required', signing_data: { data_for_signature: 'cd'.repeat(32), transaction_hash: TXID } } }
      : { body: {} }));
    try {
      const args = SIGN(publicKey).filter((a) => a !== '--sign-with' && a !== 'dev');
      const r = await certen(args, g.url, home);
      expect(r.code).toBe(0);
      expect(r.stderr).toMatch(/WARNING: the signing data was NOT checked \(SIGNING_DATA_ABSENT\)/);
      expect(JSON.parse(r.stdout.trim()).data.signing_unchecked.code).toBe('SIGNING_DATA_ABSENT');
    } finally { await g.close(); }
  }, 120000);

  it('refuses --sign-with for an inbox id, which does not name the transaction', async () => {
    const { home, publicKey } = await homeWithKey();
    const g = await stub(() => ({ body: {} }));
    try {
      const r = await certen(['--json', 'pending', 'sign', '046db52f-3828-4116-93ce-ce0aea04a244', '--sign-with', 'dev', '--public-key', publicKey], g.url, home);
      expect(r.code).toBe(2);
      expect(errorOf(r)?.code).toBe('SIGN_WITH_NEEDS_TRANSACTION');
      expect(g.seen).toHaveLength(0);
    } finally { await g.close(); }
  }, 120000);
});

describe('keys sign', () => {
  it('refuses a bare hash by name, exit 2', async () => {
    const { home } = await homeWithKey();
    const r = await certen(['--json', 'keys', 'sign', '--name', 'dev', '--hash', 'ab'.repeat(32)], 'http://127.0.0.1:1', home);
    expect(r.code).toBe(2);
    expect(errorOf(r)?.code).toBe('BLIND_SIGNING_REFUSED');
  }, 120000);

  it('needs signing data when given nothing', async () => {
    const { home } = await homeWithKey();
    const r = await certen(['--json', 'keys', 'sign', '--name', 'dev'], 'http://127.0.0.1:1', home);
    expect(r.code).toBe(2);
    expect(errorOf(r)?.code).toBe('MISSING_SIGNING_DATA');
  }, 120000);

  it('rebuilds the signing data offline, shows what it authorises, and signs exactly the recomputed hash', async () => {
    const { home, publicKey } = await homeWithKey();
    const open = await honestIntent({ intent: { adiUrl: ADI, legs: [{ chainId: 11155111, toAddress: TO, amount: '0', contractCall: { target: TO } }] } }, { publicKey });
    const sd = (open.body as any).signing_data;
    const file = join(home, 'sd.json');
    writeFileSync(file, JSON.stringify(sd));
    const r = await certen(['--json', 'keys', 'sign', '--name', 'dev', '--signing-data', `@${file}`], 'http://127.0.0.1:1', home);
    expect(r.code, r.stdout + r.stderr).toBe(0);
    const data = JSON.parse(r.stdout.trim()).data;
    expect(data.hash_signed).toBe(sd.hash_to_sign);
    expect(r.stderr).toMatch(/You are about to sign/);
  }, 120000);

  it('signs nothing when the hash the gateway sent is not the one the transaction hashes to', async () => {
    const { home, publicKey } = await homeWithKey();
    const open = await honestIntent({ intent: { adiUrl: ADI, legs: [{ chainId: 11155111, toAddress: TO, amount: '0', contractCall: { target: TO } }] } }, { publicKey });
    const sd = { ...(open.body as any).signing_data, hash_to_sign: 'cd'.repeat(32) };
    const file = join(home, 'sd.json');
    writeFileSync(file, JSON.stringify(sd));
    const r = await certen(['--json', 'keys', 'sign', '--name', 'dev', '--signing-data', `@${file}`], 'http://127.0.0.1:1', home);
    expect(r.code).toBe(1);
    expect(errorOf(r)?.code).toBe('SIGNING_DATA_MISMATCH');
  }, 120000);
});
