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
  chain: 'base-sepolia', chain_id: 84532, token_symbol: 'USDC', token_address: '0xT',
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
    const r = await certen(['--json', 'fund', 'abc', '--chain', 'base-sepolia']);
    expect(r.code).toBe(2);
    expect((soleJson(r.stdout).error as Record<string, unknown>).code).toBe('INVALID_AMOUNT');
  });

  it('rejects zero, which would open a payment that can never match', async () => {
    const r = await certen(['--json', 'fund', '0', '--chain', 'base-sepolia']);
    expect(r.code).toBe(2);
    expect((soleJson(r.stdout).error as Record<string, unknown>).code).toBe('INVALID_AMOUNT');
  });

  it('requires a chain rather than guessing one', async () => {
    const r = await certen(['--json', 'fund', '25']);
    expect(r.code).toBe(2);
    expect((soleJson(r.stdout).error as Record<string, unknown>).code).toBe('CHAIN_REQUIRED');
  });

  it('rejects a non-positive poll interval', async () => {
    const r = await certen(['--json', 'fund', '25', '--chain', 'base-sepolia', '--poll-interval', '0']);
    expect(r.code).toBe(2);
    expect((soleJson(r.stdout).error as Record<string, unknown>).code).toBe('INVALID_POLL_INTERVAL');
  });
});

describe('certen fund: payment details', () => {
  it('prints the target, makes exactly one request, and exits 0 with --no-wait', async () => {
    const stub = await stubGateway((_req, res) => json(res, 200, TARGET()));
    try {
      const r = await certen(['--json', 'fund', '25', '--chain', 'base-sepolia', '--no-wait'], stub.url);
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
      const r = await certen(['fund', '25', '--chain', 'base-sepolia', '--no-wait'], stub.url);
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
        ['--json', 'fund', '25', '--chain', 'base-sepolia', '--poll-interval', '1'],
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

describe('certen fund: flag surface', () => {
  it('accepts --wait even though waiting is already the default', async () => {
    // Every other long-running command takes `--wait`. Rejecting it here met someone who had
    // learned the flag elsewhere with "unknown option", on a command that was about to do exactly
    // what they asked. Pointed at the discard port so nothing is opened: reaching the network at
    // all proves the flag parsed.
    const r = await certen(['--json', 'fund', '1', '--chain', 'base-sepolia', '--wait']);
    expect(r.code).not.toBe(2);
    expect(r.stdout).not.toContain('USAGE_ERROR');
  });

  it('still rejects a genuinely unknown flag', async () => {
    const r = await certen(['--json', 'fund', '1', '--chain', 'base-sepolia', '--wiat']);
    expect(r.code).toBe(2);
  });
});

describe('certen pricing', () => {
  const CATALOG = {
    price_book_version: '2026-08-10.1',
    price_book_hash: 'abc123',
    currency: 'USD',
    items: [
      {
        sku: 'identity.provision', chain: '*', mode: 'flat',
        platform_fee_usd: '5.000000', gas_buffer_bps: 0,
        min_charge_usd: '0.000000', max_charge_usd: '7.500000',
      },
      {
        sku: 'proof.execute', chain: 'base-sepolia', mode: 'quoted',
        platform_fee_usd: '0.350000', gas_buffer_bps: 1500,
        min_charge_usd: '0.000000', max_charge_usd: null,
      },
      {
        sku: 'proof.execute', chain: 'ethereum-sepolia', mode: 'flat',
        platform_fee_usd: '1.000000', gas_buffer_bps: 0,
        min_charge_usd: '0.000000', max_charge_usd: null,
      },
    ],
  };

  it('prints the whole catalogue in ONE call', async () => {
    // The count is the point. Answering "what does CERTEN cost" used to mean one `quote` per sku
    // per chain, against sku names nothing published.
    const s = await stubGateway((req, res) => json(res, 200, CATALOG));
    try {
      const r = await certen(['pricing', '--json'], s.url);
      expect(r.code).toBe(0);
      expect(s.hits()).toBe(1);
      const out = soleJson(r.stdout).data as { items: unknown[] };
      expect(out.items.length).toBe(3);
    } finally {
      await s.close();
    }
  });

  it('names the skus in human output, since guessing them is the problem', async () => {
    const s = await stubGateway((req, res) => json(res, 200, CATALOG));
    try {
      const r = await certen(['pricing'], s.url);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain('identity.provision');
      expect(r.stdout).toContain('$5.00');
    } finally {
      await s.close();
    }
  });

  it('marks gas-priced entries so a floor is not read as a total', async () => {
    const s = await stubGateway((req, res) => json(res, 200, CATALOG));
    try {
      const r = await certen(['pricing'], s.url);
      expect(r.stdout).toMatch(/proof\.execute\s+base-sepolia\s+\$0\.35 \+ gas/);
      // The flat one must NOT be marked, or the distinction carries no information.
      expect(r.stdout).toMatch(/proof\.execute\s+ethereum-sepolia\s+\$1\.00\s*$/m);
    } finally {
      await s.close();
    }
  });

  it('keeps the "*" fallback when filtering by chain', async () => {
    // Dropping it would hide the price that actually applies to that chain — the filter would
    // report identity provisioning as unpriced on base-sepolia when it costs $5.
    const s = await stubGateway((req, res) => json(res, 200, CATALOG));
    try {
      const r = await certen(['pricing', '--chain', 'base-sepolia', '--json'], s.url);
      expect(r.code).toBe(0);
      const { items } = soleJson(r.stdout).data as
        { items: Array<{ sku: string; chain: string }> };
      expect(items.map((i) => i.chain).sort()).toEqual(['*', 'base-sepolia']);
      expect(items.map((i) => i.sku)).toContain('identity.provision');
    } finally {
      await s.close();
    }
  });

  it('shows ONE price per sku on a chain, resolving the "*" fallback', async () => {
    // Observed against the real gateway on the real price book: base-sepolia carries its own
    // proof.execute entry at $0.35 AND inherits a "*" entry at $0.50, and the filter listed both.
    // Two prices for one operation on one chain, with nothing to say which would be billed. The
    // "*" entry does not apply where a specific entry exists, so it is not shown.
    const WITH_OVERRIDE = {
      ...CATALOG,
      items: [
        ...CATALOG.items,
        {
          sku: 'proof.execute', chain: '*', mode: 'flat',
          platform_fee_usd: '0.500000', gas_buffer_bps: 1500,
          min_charge_usd: '0.000000', max_charge_usd: null,
        },
      ],
    };
    const s = await stubGateway((req, res) => json(res, 200, WITH_OVERRIDE));
    try {
      const r = await certen(['pricing', '--chain', 'base-sepolia', '--json'], s.url);
      const { items } = soleJson(r.stdout).data as
        { items: Array<{ sku: string; chain: string; platform_fee_usd: string }> };
      const execute = items.filter((i) => i.sku === 'proof.execute');
      expect(execute).toHaveLength(1);
      expect(execute[0].chain).toBe('base-sepolia');
      expect(execute[0].platform_fee_usd).toBe('0.350000');
      // The fallback is still shown for skus that have no entry of their own.
      expect(items.find((i) => i.sku === 'identity.provision')?.chain).toBe('*');
    } finally {
      await s.close();
    }
  });

  it('exits non-zero when pricing is not configured', async () => {
    // A script that treats a 503 as "free" would go on to run work it cannot pay for.
    const s = await stubGateway((req, res) =>
      json(res, 503, { error: 'No price book is in effect', code: 'NO_PRICE_BOOK' }));
    try {
      const r = await certen(['pricing', '--json'], s.url);
      expect(r.code).not.toBe(0);
    } finally {
      await s.close();
    }
  });
});

describe('certen balance', () => {
  const BALANCE = {
    currency: 'USD',
    available_usd: '100.000000',
    held_usd: '0.000000',
    credit_limit_usd: '0.000000',
    spendable_usd: '100.000000',
    remaining_usd: '10.000000',
    pending_intents: 3,
    uncovered_usd: '90.000000',
    status: 'active',
    suspended_reason: null,
  };

  it('answers affordability in ONE request', async () => {
    // It used to take two — the balance, then /v1/billing/obligations for `remaining_usd`, the
    // number that actually decides whether new work is accepted. The gateway now sends both.
    const paths: string[] = [];
    const s = await stubGateway((req, res) => {
      paths.push((req.url ?? '').split('?')[0]);
      json(res, 200, BALANCE);
    });
    try {
      const r = await certen(['balance', '--json'], s.url);
      expect(r.code).toBe(0);
      expect(paths).toEqual(['/v1/billing/balance']);
      const out = soleJson(r.stdout).data as Record<string, unknown>;
      expect(out.remaining_usd).toBe('10.000000');
      expect(out.pending_intents).toBe(3);
    } finally {
      await s.close();
    }
  });

  it('still asks obligations when the gateway is too old to send it', async () => {
    // The SDK and CLI ship separately from the gateway and are regularly pointed at an older one.
    // Falling back costs a round trip; NOT falling back would print `spendable_usd` in the
    // "left to commit" slot, reporting committed money as available.
    const paths: string[] = [];
    const s = await stubGateway((req, res) => {
      const path = (req.url ?? '').split('?')[0];
      paths.push(path);
      if (path === '/v1/billing/balance') {
        const { remaining_usd, pending_intents, uncovered_usd, ...old } = BALANCE;
        return json(res, 200, old);
      }
      return json(res, 200, {
        pending_intents: 2, estimated_total_usd: '40.000000', uncovered_usd: '40.000000',
        spendable_usd: '100.000000', remaining_usd: '60.000000', shortfall_usd: '0.000000',
        enforcing: false, obligations: [], note: '',
      });
    });
    try {
      const r = await certen(['balance', '--json'], s.url);
      expect(r.code).toBe(0);
      expect(paths).toEqual(['/v1/billing/balance', '/v1/billing/obligations']);
      const out = soleJson(r.stdout).data as Record<string, unknown>;
      expect(out.remaining_usd).toBe('60.000000');
    } finally {
      await s.close();
    }
  });

  it('says work cannot start when nothing is left to commit', async () => {
    // A healthy-looking $100 spendable with $100 committed. Reporting only spendable here would
    // tell someone to go ahead with work the gateway will refuse.
    const s = await stubGateway((req, res) =>
      json(res, 200, { ...BALANCE, remaining_usd: '0.000000', uncovered_usd: '100.000000' }));
    try {
      const r = await certen(['balance'], s.url);
      expect(r.stdout).toContain('Left to commit     $0.00');
      expect(r.stdout).toContain('cannot start new work');
    } finally {
      await s.close();
    }
  });
});

describe('certen payers', () => {
  const ADDR = '0x' + 'b'.repeat(40);
  const RECORD = {
    id: 'da_1', chain: 'base-sepolia', address: ADDR, label: 'treasury',
    is_active: true, verified_at: null, created_at: '2026-08-14T00:00:00.000Z',
  };

  it('registers a wallet so future deposits credit without an intent', async () => {
    const s = await stubGateway((req, res) => json(res, 201, RECORD));
    try {
      const r = await certen(
        ['payers', 'add', ADDR, '--chain', 'base-sepolia', '--label', 'treasury', '--json'],
        s.url,
      );
      expect(r.code).toBe(0);
      expect(soleJson(r.stdout).data).toMatchObject({ address: ADDR, chain: 'base-sepolia' });
    } finally {
      await s.close();
    }
  });

  it('rejects a malformed address before opening a connection', async () => {
    // The gateway's pattern would reject it too, but from here the message can say which of the
    // two arguments was wrong. `certen` with no stub points at the discard port, so reaching the
    // network at all would hang rather than exit 2.
    const r = await certen(['payers', 'add', 'not-an-address', '--chain', 'base-sepolia']);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/not an EVM address/);
  });

  it('says plainly when nothing is registered, and how to fix it', async () => {
    // An empty list is the state where every deposit needs an exact-amount intent first — worth
    // naming, because it looks identical to "everything is fine" otherwise.
    const s = await stubGateway((req, res) => json(res, 200, { addresses: [] }));
    try {
      const r = await certen(['payers'], s.url);
      expect(r.code).toBe(0);
      expect(r.stdout).toMatch(/No wallets registered/);
      expect(r.stdout + r.stderr).toMatch(/certen payers add/);
    } finally {
      await s.close();
    }
  });

  it('lists registered wallets', async () => {
    const s = await stubGateway((req, res) => json(res, 200, { addresses: [RECORD] }));
    try {
      const r = await certen(['payers', 'list'], s.url);
      expect(r.stdout).toContain(ADDR);
      expect(r.stdout).toContain('base-sepolia');
    } finally {
      await s.close();
    }
  });

  it('exits non-zero when the address is already registered elsewhere', async () => {
    // Exiting 0 would leave a funding script believing attribution is set up when it is not.
    const s = await stubGateway((req, res) =>
      json(res, 409, { error: 'Already registered on this chain', code: 'CONFLICT' }));
    try {
      const r = await certen(['payers', 'add', ADDR, '--chain', 'base-sepolia', '--json'], s.url);
      expect(r.code).not.toBe(0);
    } finally {
      await s.close();
    }
  });
});
