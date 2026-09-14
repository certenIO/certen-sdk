import { describe, it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import { collect, parseAuthorityFlags, parseExpiresIn, withOutcomeFields } from '../src/header-flags.js';
import { UsageError, EXIT } from '../src/errors.js';
import { emitFailure, resetOutput, setJsonMode } from '../src/output.js';
import { CertenError } from '@certen.io/sdk';

/**
 * `--authority` and `--expires-in` on `certen call` / `certen tx create`, the outcome fields on
 * `certen tx status`, and the rendering of the gateway's default refusal of header authorities.
 *
 * Everything runs against a local stub gateway with a throwaway HOME — never the stored config and
 * never a live gateway. Every party name is FICTIONAL.
 */

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'index.js');
const run = promisify(execFile);

const ID = '396f863c-879c-4046-8591-3f0405c5f6bd';
const ADDR = `0x${'11'.repeat(20)}`;
const B32 = `0x${'ab'.repeat(32)}`;
const ABSTRACT = '0xe293e95Ec1471155d977448B99B0922C2828cAcB';
const FIRM = 'acc://fictional-firm.acme/book';
const BANK = 'acc://fictional-bank.acme/book';

interface Seen { method: string; path: string; body: any }
interface Stub { url: string; seen: Seen[]; close: () => Promise<void> }

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body));
}

type Over = Record<string, (res: http.ServerResponse) => void>;

async function stubGateway(over: Over = {}, opts: { identityDelayMs?: number; identityAnsweredAt?: number[] } = {}): Promise<Stub> {
  const seen: Seen[] = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const path = (req.url ?? '').split('?')[0];
      seen.push({ method: req.method ?? 'GET', path, body: raw ? JSON.parse(raw) : undefined });
      const key = `${req.method} ${path}`;
      if (over[key]) return over[key](res);
      if (path === `/v1/identity/${ID}`) {
        const body = {
          id: ID, adi_url: 'acc://fictional-customer.acme', key_page_url: 'acc://fictional-customer.acme/book/1',
          status: 'active', can_sign: true, chain_accounts: [{ chain_id: '11155111', address: ABSTRACT, status: 'deployed' }],
          created_at: '2026-01-01T00:00:00Z',
        };
        return void setTimeout(() => { opts.identityAnsweredAt?.push(Date.now()); json(res, 200, body); }, opts.identityDelayMs ?? 0);
      }
      if (key === 'POST /v1/transaction') {
        return json(res, 201, { intent_id: 'intent-1', signing_data: { hash_to_sign: 'ab'.repeat(32) } });
      }
      if (key === 'POST /v1/transaction/intent-1/signature') return json(res, 200, { intent_id: 'intent-1', status: 'submitted' });
      return json(res, 404, { code: 'NOT_FOUND', error: 'not stubbed' });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    seen,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); }),
  };
}

interface Run { stdout: string; stderr: string; code: number }

async function certen(args: string[], apiUrl: string, opts: { withKey?: string } = {}): Promise<Run> {
  const home = mkdtempSync(join(tmpdir(), 'certen-hdr-'));
  // Both: os.homedir() reads USERPROFILE on Windows, so HOME alone would target the real ~/.certen.
  const env = {
    ...(process.env as Record<string, string>),
    HOME: home, USERPROFILE: home, CERTEN_API_URL: apiUrl, CERTEN_API_KEY: 'ck_live_test',
  };
  const spawn = async (a: string[]): Promise<Run> => {
    try {
      const { stdout, stderr } = await run(process.execPath, [CLI, ...a], { env, encoding: 'utf8', cwd: home });
      return { stdout, stderr, code: 0 };
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; code?: number };
      return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', code: e.code ?? -1 };
    }
  };
  if (opts.withKey) await spawn(['keys', 'generate', '--name', opts.withKey, '--no-passphrase']);
  return spawn(args);
}

const envelope = (stdout: string) => JSON.parse(stdout.trim()) as { ok: boolean; data?: any; error?: any };
const opens = (s: Stub) => s.seen.filter((e) => e.method === 'POST' && e.path === '/v1/transaction');

const CALL = ['call', '--identity', ID, '--chain', 'ethereum-sepolia', '--to', ADDR, '--fn', 'confirm(bytes32)', '--arg', B32];

describe('flag parsing', () => {
  it('--authority is repeatable and collects in order', () => {
    expect(collect(BANK, collect(FIRM, undefined))).toEqual([FIRM, BANK]);
  });

  it('normalises authorities the way the gateway does', () => {
    expect(parseAuthorityFlags([FIRM.toUpperCase(), FIRM])).toEqual([FIRM]);
    expect(parseAuthorityFlags(undefined)).toBeUndefined();
  });

  it('refuses a non-acc authority and more than eight, as usage errors', () => {
    expect(() => parseAuthorityFlags(['https://fictional-firm.example'])).toThrow(UsageError);
    const nine = Array.from({ length: 9 }, (_, i) => `acc://f${i}.acme/book`);
    try { parseAuthorityFlags(nine); expect.unreachable(); } catch (err) {
      expect(err).toBeInstanceOf(UsageError);
      expect((err as UsageError).code).toBe('INVALID_AUTHORITY');
      expect((err as UsageError).exitCode).toBe(2);
    }
  });

  it('--expires-in accepts s, m, h and d and resolves to now + duration', () => {
    const now = Date.UTC(2026, 8, 14, 12, 0, 0);
    expect(parseExpiresIn('90s', now)).toBe('2026-09-14T12:01:30.000Z');
    expect(parseExpiresIn('30m', now)).toBe('2026-09-14T12:30:00.000Z');
    expect(parseExpiresIn('2h', now)).toBe('2026-09-14T14:00:00.000Z');
    expect(parseExpiresIn('1d', now)).toBe('2026-09-15T12:00:00.000Z');
    expect(parseExpiresIn(undefined, now)).toBeUndefined();
  });

  it('--expires-in refuses anything that is not a positive whole duration', () => {
    // 60s is the gateway minimum and 8d exceeds its 7-day maximum; the CLI keeps a 90s floor.
    for (const bad of ['30', '0m', '-1h', '1.5h', 'soon', '10w', '', '60s', '89s', '8d']) {
      try { parseExpiresIn(bad); expect.unreachable(bad); } catch (err) {
        expect(err, bad).toBeInstanceOf(UsageError);
        expect((err as UsageError).code).toBe('INVALID_EXPIRES_IN');
      }
    }
  });

  it('tx status output always carries the outcome fields', () => {
    expect(withOutcomeFields({ intent_id: 'i', status: 'pending' })).toEqual({
      intent_id: 'i', status: 'pending', reason_code: null, completion_basis: null, expires_at: null, additional_authorities: null,
    });
    expect(withOutcomeFields({ reason_code: 'expired' }).reason_code).toBe('expired');
  });
});

describe('certen call --authority / --expires-in', () => {
  it('maps both flags into the intent request body', async () => {
    const stub = await stubGateway();
    try {
      const before = Date.now();
      const r = await certen(
        ['--json', ...CALL, '--authority', FIRM, '--authority', BANK, '--expires-in', '30m', '--sign-with', 'dev', '--no-wait'],
        stub.url, { withKey: 'dev' },
      );
      expect(r.code, r.stdout + r.stderr).toBe(0);
      const body = opens(stub)[0].body;
      expect(body.additional_authorities).toEqual([FIRM, BANK]);
      const at = Date.parse(body.expires_at);
      expect(at).toBeGreaterThanOrEqual(before + 30 * 60_000);
      expect(at).toBeLessThan(Date.now() + 30 * 60_000 + 1);
    } finally { await stub.close(); }
  });

  it('sends neither field when neither flag is given', async () => {
    const stub = await stubGateway();
    try {
      const r = await certen(['--json', ...CALL, '--sign-with', 'dev', '--no-wait'], stub.url, { withKey: 'dev' });
      expect(r.code, r.stdout + r.stderr).toBe(0);
      expect(opens(stub)[0].body).not.toHaveProperty('additional_authorities');
      expect(opens(stub)[0].body).not.toHaveProperty('expires_at');
    } finally { await stub.close(); }
  });

  it('--dry-run shows the values that would be sent', async () => {
    const stub = await stubGateway();
    try {
      const r = await certen(['--json', ...CALL, '--authority', FIRM, '--expires-in', '1h', '--dry-run'], stub.url);
      expect(r.code).toBe(0);
      const data = envelope(r.stdout).data;
      expect(data.additional_authorities).toEqual([FIRM]);
      expect(typeof data.expires_at).toBe('string');
      expect(opens(stub)).toHaveLength(0);
    } finally { await stub.close(); }
  });

  it('an invalid --expires-in is a usage error (exit 2) and nothing reaches the gateway', async () => {
    const stub = await stubGateway();
    try {
      const r = await certen(['--json', ...CALL, '--expires-in', '30minutes', '--dry-run'], stub.url);
      expect(r.code).toBe(2);
      expect(envelope(r.stdout).error.code).toBe('INVALID_EXPIRES_IN');
      expect(stub.seen).toHaveLength(0);
    } finally { await stub.close(); }
  });

  it('an invalid --authority is a usage error (exit 2) and nothing reaches the gateway', async () => {
    const stub = await stubGateway();
    try {
      const r = await certen(['--json', ...CALL, '--authority', 'fictional-firm.acme/book', '--dry-run'], stub.url);
      expect(r.code).toBe(2);
      expect(envelope(r.stdout).error.code).toBe('INVALID_AUTHORITY');
      expect(stub.seen).toHaveLength(0);
    } finally { await stub.close(); }
  });

  it('documents the default refusal in --help', async () => {
    const r = await certen(['call', '--help'], 'http://127.0.0.1:9');
    expect(r.stdout).toContain('--authority <acc-url>');
    expect(r.stdout).toContain('--expires-in <duration>');
    expect(r.stdout).toContain('HEADER_AUTHORITY_NOT_EXECUTABLE');
  });
});

describe('local header-field refusals are usage errors, never "gateway unreachable"', () => {
  // The SDK raises these with status 0 because no request was made — the same status it uses for a
  // gateway that could not be reached. Without the mapping, a deadline that passed during a
  // passphrase prompt exited 3 and invited a retry.
  for (const code of ['INVALID_EXPIRES_AT', 'INVALID_ADDITIONAL_AUTHORITIES', 'INVALID_DURATION']) {
    it(`${code} from the SDK exits 2`, () => {
      resetOutput();
      setJsonMode(true);
      const write = process.stdout.write;
      let out = '';
      process.stdout.write = ((chunk: string) => { out += chunk; return true; }) as typeof process.stdout.write;
      try {
        expect(emitFailure(new CertenError('expiresAt is in the past', 0, code))).toBe(EXIT.USAGE);
      } finally {
        process.stdout.write = write;
        resetOutput();
      }
      expect(JSON.parse(out).error).toMatchObject({ code, retryable: false });
    });
  }

  it('a real network failure still exits 3', () => {
    resetOutput();
    setJsonMode(true);
    const write = process.stdout.write;
    process.stdout.write = (() => true) as typeof process.stdout.write;
    try {
      expect(emitFailure(new CertenError('connect ECONNREFUSED', 0, 'NETWORK_ERROR'))).toBe(EXIT.UNREACHABLE);
    } finally {
      process.stdout.write = write;
      resetOutput();
    }
  });

  it('--expires-in under the 90s floor exits 2 and names the gateway minimum', async () => {
    const stub = await stubGateway();
    try {
      const r = await certen(['--json', ...CALL, '--expires-in', '60s', '--dry-run'], stub.url);
      expect(r.code).toBe(2);
      const err = envelope(r.stdout).error;
      expect(err.code).toBe('INVALID_EXPIRES_IN');
      expect(err.message).toContain('60s');
      expect(stub.seen).toHaveLength(0);
    } finally { await stub.close(); }
  });

  it('measures --expires-in when the intent is opened, not when the command started', async () => {
    // A slow step between parsing and opening — here the identity lookup, in real use the
    // passphrase prompt — must not come out of the deadline.
    const answered: number[] = [];
    const stub = await stubGateway({}, { identityDelayMs: 1_500, identityAnsweredAt: answered });
    try {
      const r = await certen(['--json', ...CALL, '--expires-in', '90s', '--sign-with', 'dev', '--no-wait'], stub.url, { withKey: 'dev' });
      expect(r.code, r.stdout + r.stderr).toBe(0);
      const at = Date.parse(opens(stub)[0].body.expires_at);
      expect(at).toBeGreaterThanOrEqual(answered[0] + 90_000);
    } finally { await stub.close(); }
  });
});

describe('HEADER_AUTHORITY_NOT_EXECUTABLE rendering', () => {
  const refuse: Over = {
    'POST /v1/transaction': (res) => json(res, 422, {
      error: 'additional_authorities cannot be executed by CERTEN validators yet', code: 'HEADER_AUTHORITY_NOT_EXECUTABLE',
    }),
  };

  it('--json: exit 1, the code, not retryable, with guidance — and nothing was signed', async () => {
    const stub = await stubGateway(refuse);
    try {
      const r = await certen(['--json', ...CALL, '--authority', FIRM, '--sign-with', 'dev', '--no-wait'], stub.url, { withKey: 'dev' });
      expect(r.code).toBe(1);
      const out = envelope(r.stdout);
      expect(out.ok).toBe(false);
      expect(out.error).toMatchObject({ code: 'HEADER_AUTHORITY_NOT_EXECUTABLE', status: 422, retryable: false });
      expect(out.error.guidance).toMatch(/account/);
      expect(stub.seen.some((e) => e.path.endsWith('/signature'))).toBe(false);
    } finally { await stub.close(); }
  });

  it('human mode: prints the code and what to do instead on stderr', async () => {
    const stub = await stubGateway(refuse);
    try {
      const r = await certen([...CALL, '--authority', FIRM, '--sign-with', 'dev', '--no-wait'], stub.url, { withKey: 'dev' });
      expect(r.code).toBe(1);
      expect(r.stderr).toContain('Error [HEADER_AUTHORITY_NOT_EXECUTABLE]');
      expect(r.stderr).toMatch(/authorities instead|on the account/);
    } finally { await stub.close(); }
  });

  it('tx create maps the flags and renders the same refusal', async () => {
    const stub = await stubGateway(refuse);
    try {
      const r = await certen(
        ['--json', 'tx', 'create', '--identity', ID, '--intent', '{"adiUrl":"acc://fictional-customer.acme","legs":[]}',
          '--authority', FIRM, '--expires-in', '2h', '--force'],
        stub.url,
      );
      expect(r.code).toBe(1);
      expect(envelope(r.stdout).error.code).toBe('HEADER_AUTHORITY_NOT_EXECUTABLE');
      expect(opens(stub)[0].body.additional_authorities).toEqual([FIRM]);
      expect(typeof opens(stub)[0].body.expires_at).toBe('string');
    } finally { await stub.close(); }
  });
});

describe('certen tx status surfaces the outcome fields', () => {
  const failed = {
    intent_id: 'intent-1', identity_id: ID, status: 'failed', reason_code: 'expired',
    additional_authorities: [FIRM], expires_at: '2026-09-14T12:30:00Z', completion_basis: null,
    created_at: '2026-09-14T12:00:00Z',
  };

  it('--json carries reason_code, completion_basis, expires_at and additional_authorities', async () => {
    const stub = await stubGateway({ 'GET /v1/transaction/intent-1': (res) => json(res, 200, failed) });
    try {
      const r = await certen(['--json', 'tx', 'status', 'intent-1'], stub.url);
      expect(r.code).toBe(0);
      expect(envelope(r.stdout).data).toMatchObject({
        reason_code: 'expired', completion_basis: null, expires_at: '2026-09-14T12:30:00Z', additional_authorities: [FIRM],
      });
    } finally { await stub.close(); }
  });

  it('--json fills the fields with null for a gateway that does not send them', async () => {
    const stub = await stubGateway({
      'GET /v1/transaction/intent-1': (res) => json(res, 200, { intent_id: 'intent-1', status: 'completed', created_at: 'x' }),
    });
    try {
      const r = await certen(['--json', 'tx', 'status', 'intent-1'], stub.url);
      expect(envelope(r.stdout).data).toMatchObject({ reason_code: null, completion_basis: null, expires_at: null, additional_authorities: null });
    } finally { await stub.close(); }
  });

  it('human mode explains the reason', async () => {
    const stub = await stubGateway({ 'GET /v1/transaction/intent-1': (res) => json(res, 200, failed) });
    try {
      const r = await certen(['tx', 'status', 'intent-1'], stub.url);
      expect(r.code).toBe(0);
      expect(r.stdout).toMatch(/reason_code\s+expired/);
      expect(r.stderr).toContain('Reason: expired');
      expect(r.stderr).toContain('no fee or gas');
    } finally { await stub.close(); }
  });

  it('--wait on a failed intent reports expectation_unmet in the error details', async () => {
    const stub = await stubGateway({
      'GET /v1/transaction/intent-1': (res) => json(res, 200, { ...failed, reason_code: 'expectation_unmet' }),
    });
    try {
      const r = await certen(['--json', 'tx', 'status', 'intent-1', '--wait', '--poll-interval', '1'], stub.url);
      expect(r.code).toBe(1);
      const err = envelope(r.stdout).error;
      expect(err.code).toBe('TX_FAILED');
      expect(err.details).toMatchObject({ intent_id: 'intent-1', reason_code: 'expectation_unmet' });
      expect(err.details.reason).toMatch(/not a success/);
    } finally { await stub.close(); }
  });
});
