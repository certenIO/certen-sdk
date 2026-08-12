import { describe, it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { AddressInfo } from 'node:net';

/**
 * `certen auth login`.
 *
 * Two regressions are pinned here, both of which shipped:
 *
 * 1. **A saved key was never checked.** Login wrote whatever it was handed and reported success,
 *    so a typo'd or revoked key sat on disk until some later, unrelated command returned 401.
 *    The distance between the mistake and its symptom was the whole problem.
 *
 * 2. **A storage failure called `process.exit(1)`**, bypassing the envelope writer entirely: the
 *    process exited non-zero with empty stdout, which no `--json` consumer can interpret.
 *
 * Spawned as a subprocess against a stub gateway — exit codes and "what landed on stdout" are
 * properties of a process, not of a function. Each case gets its own HOME, so a key written by
 * one case cannot satisfy another.
 */

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'index.js');
const run = promisify(execFile);

type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => void;

interface Stub { url: string; close: () => Promise<void> }

async function stubGateway(handler: Handler): Promise<Stub> {
  const server = http.createServer((req, res) => {
    try { handler(req, res); } catch { res.statusCode = 500; res.end('{}'); }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections?.();
      server.close(() => resolve());
    }),
  };
}

interface Run { stdout: string; stderr: string; code: number; home: string }

async function certen(args: string[], apiUrl: string, stdin?: string): Promise<Run> {
  const home = mkdtempSync(join(tmpdir(), 'certen-login-'));
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    HOME: home,
    USERPROFILE: home,
    CERTEN_API_URL: apiUrl,
  };
  delete env.CERTEN_API_KEY;

  try {
    const child = run(process.execPath, [CLI, ...args], { env, encoding: 'utf8' });
    if (stdin !== undefined) {
      child.child.stdin?.write(stdin);
      child.child.stdin?.end();
    }
    const { stdout, stderr } = await child;
    return { stdout, stderr, code: 0, home };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: number };
    return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', code: e.code ?? -1, home };
  }
}

function configOf(home: string): Record<string, unknown> | null {
  const file = join(home, '.certen', 'config.json');
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf-8')) : null;
}

function soleJson(stdout: string): Record<string, unknown> {
  const trimmed = stdout.trim();
  expect(trimmed.length).toBeGreaterThan(0);
  return JSON.parse(trimmed) as Record<string, unknown>;
}

const BALANCE = {
  currency: 'USD', available_usd: '10.000000', held_usd: '0.000000',
  credit_limit_usd: '0.000000', spendable_usd: '10.000000', status: 'active',
};

describe('the key is verified before it is saved', () => {
  it('saves a key the gateway accepts', async () => {
    const stub = await stubGateway((_req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(BALANCE));
    });
    try {
      const r = await certen(['--json', 'auth', 'login', '--api-key', 'ck_live_good', '--no-keyring'], stub.url);
      expect(r.code).toBe(0);
      const env = soleJson(r.stdout);
      expect(env.ok).toBe(true);
      expect(env.data).toMatchObject({ storage: 'file', verified: true });
      expect(configOf(r.home)).toMatchObject({ api_key: 'ck_live_good' });
    } finally {
      await stub.close();
    }
  });

  it('refuses a key the gateway rejects, and writes NOTHING', async () => {
    const stub = await stubGateway((_req, res) => {
      res.statusCode = 401;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ error: { code: 'UNAUTHORIZED', message: 'bad key' } }));
    });
    try {
      const r = await certen(['--json', 'auth', 'login', '--api-key', 'ck_live_bad', '--no-keyring'], stub.url);
      expect(r.code).toBe(2);
      expect((soleJson(r.stdout).error as { code: string }).code).toBe('INVALID_API_KEY');
      // The whole point: a rejected key never reaches disk, so the next command does not trip
      // over a credential this one already knew was dead.
      expect(configOf(r.home)?.api_key).toBeUndefined();
    } finally {
      await stub.close();
    }
  });

  it('accepts a real key that merely lacks billing:read, rather than rejecting a good credential', async () => {
    const stub = await stubGateway((_req, res) => {
      res.statusCode = 403;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ error: { code: 'FORBIDDEN', message: 'scope missing' } }));
    });
    try {
      const r = await certen(['auth', 'login', '--api-key', 'ck_live_scoped', '--no-keyring'], stub.url);
      expect(r.code).toBe(0);
      expect(configOf(r.home)).toMatchObject({ api_key: 'ck_live_scoped' });
      // 403 means the gateway recognised the credential. Saying so is the honest report; calling
      // it "verified" without qualification would not be.
      expect(r.stderr).toContain('billing:read');
    } finally {
      await stub.close();
    }
  });

  it('--no-verify skips the check entirely, for offline setup', async () => {
    // Discard port: any attempt to reach a gateway fails immediately and locally.
    const r = await certen(
      ['--json', 'auth', 'login', '--api-key', 'ck_live_offline', '--no-keyring', '--no-verify'],
      'http://127.0.0.1:9',
    );
    expect(r.code).toBe(0);
    expect(soleJson(r.stdout).ok).toBe(true);
    expect((soleJson(r.stdout).data as { verified: boolean }).verified).toBe(false);
    expect(configOf(r.home)).toMatchObject({ api_key: 'ck_live_offline' });
  });

  it('an unreachable gateway exits 3 — not "your key is bad"', async () => {
    const r = await certen(
      ['--json', 'auth', 'login', '--api-key', 'ck_live_x', '--no-keyring'],
      'http://127.0.0.1:9',
    );
    // Nothing was verified and nothing was learned about the key. Reporting it as invalid would
    // send the user to mint a replacement for a key that is very likely fine.
    expect(r.code).toBe(3);
    expect((soleJson(r.stdout).error as { code: string }).code).toBe('NETWORK_ERROR');
    expect(configOf(r.home)?.api_key).toBeUndefined();
  });
});

describe('the key can arrive without touching shell history', () => {
  it('reads the key from stdin with --api-key -', async () => {
    const stub = await stubGateway((_req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(BALANCE));
    });
    try {
      const r = await certen(
        ['--json', 'auth', 'login', '--api-key', '-', '--no-keyring'],
        stub.url,
        'ck_live_piped\n',
      );
      expect(r.code).toBe(0);
      expect(configOf(r.home)).toMatchObject({ api_key: 'ck_live_piped' });
    } finally {
      await stub.close();
    }
  });

  it('suggests the stdin form when the key was passed as an argument', async () => {
    const stub = await stubGateway((_req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(BALANCE));
    });
    try {
      const r = await certen(['auth', 'login', '--api-key', 'ck_live_good', '--no-keyring'], stub.url);
      expect(r.stderr).toContain('--api-key -');
    } finally {
      await stub.close();
    }
  });

  it('fails with an envelope, not a silent exit, when no key can be obtained', async () => {
    const r = await certen(['--json', 'auth', 'login', '--api-key', '-', '--no-keyring'], 'http://127.0.0.1:9', '');
    expect(r.code).toBe(2);
    expect((soleJson(r.stdout).error as { code: string }).code).toBe('NO_API_KEY');
  });
});

describe('next step', () => {
  it('names the command that follows, on stderr', async () => {
    const stub = await stubGateway((_req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(BALANCE));
    });
    try {
      const r = await certen(['auth', 'login', '--api-key', 'ck_live_good', '--no-keyring'], stub.url);
      expect(r.stderr).toContain('certen keys generate');
    } finally {
      await stub.close();
    }
  });
});
