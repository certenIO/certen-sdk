import { describe, it, expect, beforeAll } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { AddressInfo } from 'node:net';

/**
 * How the CLI reports a 402.
 *
 * A refusal for lack of funds is the one failure that arrives with its own fix, so
 * the terminal has to show it. This is a SUBPROCESS test because the properties
 * are properties of a process: guidance must land on stderr, stdout in JSON mode
 * must stay exactly one envelope, and the exit code must not say success.
 *
 * The regression it guards is subtle. `handleError` used to flatten the SDK error
 * into an object literal before reporting it — same field values, but the class
 * identity was gone, so the reporter could no longer recognise a payment error and
 * silently dropped the payment target. Everything looked fine: a code, a message,
 * the right exit code, and no fix. Only an end-to-end run catches that, which is
 * why this exercises the built binary rather than calling the reporter directly.
 *
 * Spawned ASYNCHRONOUSLY: the stub server shares this process, and a synchronous
 * spawn blocks the event loop so the server could never answer.
 */

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'index.js');
const HOME = mkdtempSync(join(tmpdir(), 'certen-402-'));
const run = promisify(execFile);

const RESOLVE = {
  payment_intent: 'dep_9f2',
  chain: 'base',
  to_address: '0xTreasuryAddress',
  amount_usd: '0.230000',
  expires_at: '2026-08-10T15:30:00Z',
  reused_existing: false,
  portal_url: 'https://gateway.example/portal#funding?intent=dep_9f2',
  cli_command: 'certen fund 0.230000 --chain base',
  note: 'Send exactly 0.230000 USDC on base.',
};

const BODY = {
  error: 'Payment required',
  code: 'PAYMENT_REQUIRED',
  quote: { id: 'q-77', expires_at: '2026-08-10T15:00:00Z' },
  balance: {
    available_usd: '0.120000', held_usd: '0.000000',
    spendable_usd: '0.120000', shortfall_usd: '0.230000',
  },
  resolve: RESOLVE,
};

async function stub402(body: unknown): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((_req, res) => {
    res.statusCode = 402;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(body));
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

interface Run { stdout: string; stderr: string; code: number }

async function certen(args: string[], apiUrl: string): Promise<Run> {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    HOME, USERPROFILE: HOME,
    CERTEN_API_KEY: 'ck_live_test',
    CERTEN_API_URL: apiUrl,
  };
  try {
    const { stdout, stderr } = await run(process.execPath, [CLI, ...args], { env, encoding: 'utf8' });
    return { stdout, stderr, code: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: number };
    return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', code: e.code ?? -1 };
  }
}

beforeAll(() => {
  if (!existsSync(CLI)) {
    throw new Error(`built CLI not found at ${CLI} — run \`npm run build\` before the CLI suite`);
  }
});

describe('402 in human mode', () => {
  it('prints the shortfall, the payment target, and both ways to settle', async () => {
    const stub = await stub402(BODY);
    try {
      const r = await certen(['portfolio'], stub.url);

      expect(r.code).toBe(1);
      expect(r.stderr).toContain('0.230000');
      expect(r.stderr).toContain('0xTreasuryAddress');
      expect(r.stderr).toContain('dep_9f2');
      // Both idioms, because the developer may prefer either.
      expect(r.stderr).toContain('certen fund 0.230000 --chain base');
      expect(r.stderr).toContain(RESOLVE.portal_url);
      // Keeping the quoted price is the difference between paying twice and once.
      expect(r.stderr).toContain('--quote-id q-77');
      // The reassurance is load-bearing: a refused request must not leave someone
      // wondering whether they were charged.
      expect(r.stderr).toContain('Nothing was charged');
    } finally { await stub.close(); }
  });

  it('keeps stdout clean so a pipe is unaffected', async () => {
    const stub = await stub402(BODY);
    try {
      const r = await certen(['portfolio'], stub.url);
      // Guidance is not the result of the command.
      expect(r.stdout.trim()).toBe('');
    } finally { await stub.close(); }
  });

  it('still explains itself when no payment target was offered', async () => {
    const stub = await stub402({ ...BODY, resolve: null });
    try {
      const r = await certen(['portfolio'], stub.url);

      expect(r.code).toBe(1);
      expect(r.stderr).toContain('0.230000');
      expect(r.stderr).toContain('Nothing was charged');
      // Nothing to send to, so no address section is invented.
      expect(r.stderr).not.toContain('Send exactly');
    } finally { await stub.close(); }
  });

  it('tells a commitment shortfall apart from an empty balance', async () => {
    const stub = await stub402({
      error: 'Payment required',
      code: 'COMMITMENT_EXCEEDED',
      quote: { id: 'q-78' },
      commitments: { pending_intents: 3, uncovered_usd: '1.050000', shortfall_usd: '0.150000' },
      resolve: { ...RESOLVE, amount_usd: '0.150000' },
    }, );
    try {
      const r = await certen(['portfolio'], stub.url);

      expect(r.code).toBe(1);
      // Waiting frees the same capacity, so the advice must say so.
      expect(r.stderr).toContain('wait');
      expect(r.stderr).toContain('3 intents');
    } finally { await stub.close(); }
  });
});

describe('402 in JSON mode', () => {
  it('carries the resolution in the envelope, on stdout, exactly once', async () => {
    const stub = await stub402(BODY);
    try {
      const r = await certen(['--json', 'portfolio'], stub.url);

      expect(r.code).toBe(1);
      // Throws if stdout is not exactly one JSON value.
      const env = JSON.parse(r.stdout.trim()) as {
        ok: boolean;
        error: {
          code: string; status: number; retryable: boolean;
          shortfall_usd?: string; quote_id?: string;
          resolve?: { payment_intent: string; cli_command: string };
        };
      };

      expect(env.ok).toBe(false);
      expect(env.error.code).toBe('PAYMENT_REQUIRED');
      expect(env.error.status).toBe(402);
      // Money is the only thing that changes this outcome, so a caller must not
      // read it as worth another attempt.
      expect(env.error.retryable).toBe(false);
      expect(env.error.shortfall_usd).toBe('0.230000');
      expect(env.error.quote_id).toBe('q-77');
      expect(env.error.resolve?.payment_intent).toBe('dep_9f2');
      expect(env.error.resolve?.cli_command).toBe('certen fund 0.230000 --chain base');
    } finally { await stub.close(); }
  });

  it('omits the payment keys entirely for an unrelated failure', async () => {
    // The envelope must not sprout null fields on every error just because one
    // kind of failure can carry a fix.
    const server = http.createServer((_req, res) => {
      res.statusCode = 400;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ error: 'bad chain', code: 'VALIDATION_FAILED' }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const r = await certen(['--json', 'portfolio'], url);
      const env = JSON.parse(r.stdout.trim()) as { error: Record<string, unknown> };

      expect(env.error.code).toBe('VALIDATION_FAILED');
      expect(env.error).not.toHaveProperty('resolve');
      expect(env.error).not.toHaveProperty('shortfall_usd');
    } finally {
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => { server.close(() => resolve()); });
    }
  });
});
