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
 * `certen balance` and `certen fund`.
 *
 * Run as a SUBPROCESS against a stub gateway, for the same reason as the
 * conformance suite: the two properties that matter are properties of a process —
 * exactly one JSON object on stdout, and the exit code. An expired deposit must
 * not exit 0, or a funding script treats it as paid.
 *
 * Each case gets its OWN server and its own request counter. A shared server with
 * a module-level counter couples the cases together, and "how many requests did
 * this command make" then depends on what ran before it.
 *
 * The CLI is spawned ASYNCHRONOUSLY, which is not a style preference. The stub
 * server runs in this same process, and `execFileSync` blocks the event loop for
 * its whole duration — so a synchronous spawn means the server can never answer
 * the request the CLI is making. It looks like a hung gateway: the CLI retries
 * with backoff, the case takes two minutes, and it fails for reasons that have
 * nothing to do with the code under test.
 *
 * The polling LOOP is tested in the SDK suite against a real server; repeating it
 * through a subprocess here would only add wall-clock. What this file uniquely
 * covers is what a process exposes: exit codes and the single-envelope contract.
 *
 * Nothing here touches a wallet or a signing key, because `fund` does not.
 */

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'index.js');
const HOME = mkdtempSync(join(tmpdir(), 'certen-billing-'));

type Handler = (req: http.IncomingMessage, res: http.ServerResponse, hit: number) => void;

interface Stub {
  url: string;
  hits: () => number;
  close: () => Promise<void>;
}

async function stubGateway(handler: Handler): Promise<Stub> {
  let hits = 0;
  const server = http.createServer((req, res) => {
    hits += 1;
    try {
      handler(req, res, hits);
    } catch {
      // Never let a handler bug become an uncaughtException in the worker: that
      // hangs the whole run instead of failing one assertion.
      res.statusCode = 500;
      res.end('{}');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    hits: () => hits,
    // closeAllConnections first: `close()` alone waits for keep-alive sockets to
    // drain, which turned this file from seconds into minutes.
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections?.();
      server.close(() => resolve());
    }),
  };
}

interface Run { stdout: string; stderr: string; code: number }

const run = promisify(execFile);

async function certen(args: string[], apiUrl?: string): Promise<Run> {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    HOME, USERPROFILE: HOME,
    // A key must be present or the command fails on auth before reaching the
    // logic under test. The stub does not check it.
    CERTEN_API_KEY: 'ck_live_test',
    // Pointed at the discard port when no stub is given, so a command that should
    // not reach the network fails locally and immediately.
    CERTEN_API_URL: apiUrl ?? 'http://127.0.0.1:9',
  };
  try {
    const { stdout, stderr } = await run(process.execPath, [CLI, ...args], {
      env, encoding: 'utf8',
    });
    return { stdout, stderr, code: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: number };
    return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', code: e.code ?? -1 };
  }
}

function soleJson(stdout: string): Record<string, unknown> {
  const trimmed = stdout.trim();
  expect(trimmed.length).toBeGreaterThan(0);
  return JSON.parse(trimmed) as Record<string, unknown>;
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body));
}

const BALANCE = {
  currency: 'USD', available_usd: '0.900000', held_usd: '0.350000',
  credit_limit_usd: '0.000000', spendable_usd: '0.900000', status: 'active',
};
const OBLIGATIONS = {
  pending_intents: 2, estimated_total_usd: '0.700000', uncovered_usd: '0.700000',
  spendable_usd: '0.900000', remaining_usd: '0.200000', shortfall_usd: '0.000000',
  enforcing: true, obligations: [],
};
const future = () => new Date(Date.now() + 3_600_000).toISOString();
const TARGET = () => ({
  chain: 'base', chain_id: 8453, token_symbol: 'USDC', token_address: '0xT',
  token_decimals: 6, deposit_address: '0xTreasury', min_confirmations: 3,
  deposit_intent: { reference: 'dep_abc', amount_usd: '25.000000', expires_at: future() },
  note: 'send only USDC',
});
const intentBody = (status: string, expiresAt = future()) => ({
  intent: {
    reference: 'dep_abc', status, amount_usd: '25.000000', expires_at: expiresAt,
    matched_at: status === 'matched' ? new Date().toISOString() : null,
    payment_id: status === 'matched' ? 'pay_1' : null,
  },
});

beforeAll(() => {
  if (!existsSync(CLI)) {
    throw new Error(`built CLI not found at ${CLI} — run \`npm run build\` before the CLI suite`);
  }
});

describe('certen balance', () => {
  it('reports what may be committed, not just the balance', async () => {
    const stub = await stubGateway((req, res) => {
      if ((req.url ?? '').includes('obligations')) return json(res, 200, OBLIGATIONS);
      return json(res, 200, BALANCE);
    });
    try {
      const r = await certen(['--json', 'balance'], stub.url);
      const env = soleJson(r.stdout);
      expect(r.code).toBe(0);
      expect(env.ok).toBe(true);
      const data = env.data as Record<string, unknown>;
      // 0.90 spendable with 0.70 already claimed leaves 0.20. Reporting spendable
      // alone would tell a caller they can afford committed work.
      expect(data.remaining_usd).toBe('0.200000');
      expect(data.spendable_usd).toBe('0.900000');
      expect(data.pending_intents).toBe(2);
    } finally { await stub.close(); }
  });

  it('tells a human what to do when nothing is left to commit', async () => {
    const stub = await stubGateway((req, res) => {
      if ((req.url ?? '').includes('obligations')) {
        return json(res, 200, { ...OBLIGATIONS, remaining_usd: '0.000000' });
      }
      return json(res, 200, BALANCE);
    });
    try {
      const r = await certen(['balance'], stub.url);
      expect(r.code).toBe(0);
      // A refusal has to carry its own fix, in the terminal the user is already in.
      expect(r.stderr).toContain('certen fund');
    } finally { await stub.close(); }
  });
});

describe('certen fund: validation before any network call', () => {
  // No stub at all — the discard port proves these never reach a gateway.
  it('rejects a non-numeric amount', async () => {
    const r = await certen(['--json', 'fund', 'abc', '--chain', 'base']);
    expect(r.code).toBe(2);
    expect((soleJson(r.stdout).error as Record<string, unknown>).code).toBe('INVALID_AMOUNT');
  });

  it('rejects zero, which would open a payment that can never match', async () => {
    const r = await certen(['--json', 'fund', '0', '--chain', 'base']);
    expect(r.code).toBe(2);
    expect((soleJson(r.stdout).error as Record<string, unknown>).code).toBe('INVALID_AMOUNT');
  });

  it('requires a chain rather than guessing one', async () => {
    const r = await certen(['--json', 'fund', '25']);
    expect(r.code).toBe(2);
    expect((soleJson(r.stdout).error as Record<string, unknown>).code).toBe('CHAIN_REQUIRED');
  });

  it('rejects a non-positive poll interval', async () => {
    const r = await certen(['--json', 'fund', '25', '--chain', 'base', '--poll-interval', '0']);
    expect(r.code).toBe(2);
    expect((soleJson(r.stdout).error as Record<string, unknown>).code).toBe('INVALID_POLL_INTERVAL');
  });
});

describe('certen fund: payment details', () => {
  it('prints the target, makes exactly one request, and exits 0 with --no-wait', async () => {
    const stub = await stubGateway((_req, res) => json(res, 200, TARGET()));
    try {
      const r = await certen(['--json', 'fund', '25', '--chain', 'base', '--no-wait'], stub.url);
      const data = soleJson(r.stdout).data as Record<string, unknown>;
      expect(r.code).toBe(0);
      expect(data.deposit_address).toBe('0xTreasury');
      expect(data.reference).toBe('dep_abc');
      expect(data.amount_usd).toBe('25.000000');
      // It must not begin polling when told not to wait.
      expect(stub.hits()).toBe(1);
    } finally { await stub.close(); }
  });

  it('shows the human the exact amount and the address', async () => {
    const stub = await stubGateway((_req, res) => json(res, 200, TARGET()));
    try {
      const r = await certen(['fund', '25', '--chain', 'base', '--no-wait'], stub.url);
      expect(r.stdout).toContain('0xTreasury');
      expect(r.stdout).toContain('25.000000 USDC');
      expect(r.stdout).toContain('exact amount');
    } finally { await stub.close(); }
  });
});

describe('certen fund: waiting', () => {
  it('exits non-zero when the payment expires, so a script cannot read it as paid', async () => {
    const stub = await stubGateway((req, res) => {
      if ((req.url ?? '').includes('/v1/billing/deposits/')) {
        return json(res, 200, intentBody('expired', new Date(Date.now() - 1000).toISOString()));
      }
      return json(res, 200, TARGET());
    });
    try {
      const r = await certen(
        ['--json', 'fund', '25', '--chain', 'base', '--poll-interval', '1'],
        stub.url,
      );
      expect(r.code).toBe(1);
      const err = soleJson(r.stdout).error as Record<string, unknown>;
      expect(err.code).toBe('DEPOSIT_NOT_CREDITED');
      // The customer needs to know their money is not sitting in limbo.
      expect(String(err.message)).toContain('Nothing was charged');
    } finally { await stub.close(); }
  });

});
