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

  /**
   * A credit account reads its balance as a NEGATIVE `available_usd`. That is the drawdown, not an
   * error — but "Available -$72.35" as the first line of the money command reads as a fault, and
   * the thresholds that decide when service stops were printed with no statement of how close the
   * account actually was to them. The reader had to find `available_usd`, negate it, and compare
   * by hand, on the question of whether their work is about to be refused.
   */
  const CREDIT_BALANCE = {
    currency: 'USD', available_usd: '-72.355716', held_usd: '0.000000',
    credit_limit_usd: '250.000000', spendable_usd: '177.644284',
    remaining_usd: '144.431871', pending_intents: 40, uncovered_usd: '33.212413',
    status: 'active',
    credit: {
      kind: 'terms', label: 'Acme — invoiced account', granted_limit_usd: '250.000000',
      expires_at: null, expired: false, warns_at_usd: '125.000000', suspends_at_usd: '250.000000',
    },
  };

  it('calls a negative balance a drawdown, and says how close the stop is', async () => {
    const stub = await stubGateway((_req, res) => json(res, 200, CREDIT_BALANCE));
    try {
      const r = await certen(['balance'], stub.url);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain('Drawn on credit    $72.36');
      // Never the bare negative, which is what made this read as a fault.
      expect(r.stdout).not.toContain('Available          -$72.36');
      // The threshold stated as a distance from where the account actually is.
      expect(r.stdout).toContain('Drawn $72.36 of $250.00');
      expect(r.stdout).toContain('first warning at $125.00');
    } finally { await stub.close(); }
  });

  it('escalates once the warning threshold is passed', async () => {
    const stub = await stubGateway((_req, res) => json(res, 200, {
      ...CREDIT_BALANCE, available_usd: '-200.000000',
    }));
    try {
      const r = await certen(['balance'], stub.url);
      // The number that matters when service is close to stopping is the headroom, not the total.
      expect(r.stdout).toContain('$50.00 before service stops');
      expect(r.stderr).toContain('certen fund');
    } finally { await stub.close(); }
  });

  it('does not print the payload twice to a human', async () => {
    const stub = await stubGateway((_req, res) => json(res, 200, CREDIT_BALANCE));
    try {
      const r = await certen(['balance'], stub.url);
      // The raw key/value table used to print alongside the readable summary, so every figure
      // appeared twice and `credit` — a nested object — rendered as a line of raw JSON above it.
      expect(r.stdout).not.toContain('available_usd');
      expect(r.stdout).not.toContain('"kind"');
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

/**
 * Phase 11 — the money path.
 *
 * Funding asked someone to carry a token contract, a chain, a treasury address and an exact amount
 * from a terminal into a wallet by hand, and then to wait an unstated length of time for it to land.
 * A mistyped recipient is the one error here that loses real money irreversibly.
 *
 * `REAL_TARGET` uses canonical addresses because the shared `TARGET` fixture does not — and that
 * difference caught a genuine regression: the first version of the URI builder threw on a
 * non-canonical address and took the ENTIRE funding command down with it, on a payment intent the
 * gateway had already opened. A convenience that can stop someone paying is worse than no
 * convenience, so both paths are pinned below.
 */
const REAL_TARGET = () => ({
  ...TARGET(),
  token_address: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
  deposit_address: '0x1111111111111111111111111111111111111111',
});

describe('certen fund: a link a wallet can open', () => {
  it('emits an EIP-681 URI carrying token, chain, recipient and exact amount', async () => {
    const stub = await stubGateway((_req, res) => json(res, 200, REAL_TARGET()));
    try {
      const r = await certen(
        ['--json', 'fund', '25', '--chain', 'base-sepolia', '--no-wait'], stub.url,
      );
      const data = soleJson(r.stdout).data as Record<string, string>;
      expect(r.code).toBe(0);
      // 25.000000 USDC at 6 decimals is 25000000 base units. A float multiplication here is where an
      // off-by-one-unit payment comes from, and attribution matches on the exact amount.
      expect(data.payment_uri).toBe(
        'ethereum:0x036CbD53842c5426634e7929541eC2318f3dCF7e@84532'
        + '/transfer?address=0x1111111111111111111111111111111111111111&uint256=25000000',
      );
    } finally { await stub.close(); }
  });

  it('prints the link only when asked, and hints at it otherwise', async () => {
    const stub = await stubGateway((_req, res) => json(res, 200, REAL_TARGET()));
    try {
      const shown = await certen(['fund', '25', '--chain', 'base-sepolia', '--no-wait', '--uri'], stub.url);
      expect(shown.stdout).toContain('ethereum:0x036CbD53842c5426634e7929541eC2318f3dCF7e@84532');

      const quiet = await certen(['fund', '25', '--chain', 'base-sepolia', '--no-wait'], stub.url);
      // The address is what most people copy; burying it under a long wrapping URI would be a
      // regression for the common case.
      expect(quiet.stdout).not.toContain('ethereum:');
      expect(quiet.stderr).toContain('--uri');
    } finally { await stub.close(); }
  });

  it('still prints the payment when no URI can be built', async () => {
    // The regression this file caught. `TARGET` has non-canonical addresses, so no URI is possible —
    // and the deposit instructions must survive that completely.
    const stub = await stubGateway((_req, res) => json(res, 200, TARGET()));
    try {
      const r = await certen(['fund', '25', '--chain', 'base-sepolia', '--no-wait'], stub.url);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain('0xTreasury');
      expect(r.stdout).toContain('25.000000 USDC');
    } finally { await stub.close(); }
  });

  it('says why the link is missing when it was explicitly requested', async () => {
    const stub = await stubGateway((_req, res) => json(res, 200, TARGET()));
    try {
      const r = await certen(['fund', '25', '--chain', 'base-sepolia', '--no-wait', '--uri'], stub.url);
      // Silence after an explicit flag looks like the flag was ignored.
      expect(r.stdout).toContain('No payment link for this target');
      expect(r.stdout).toContain('0xTreasury');
    } finally { await stub.close(); }
  });
});

describe('certen fund: how long it will take', () => {
  it('turns confirmations into an estimate and names its basis', async () => {
    const stub = await stubGateway((_req, res) => json(res, 200, REAL_TARGET()));
    try {
      const r = await certen(['fund', '25', '--chain', 'base-sepolia', '--no-wait'], stub.url);
      // 3 confirmations at ~2s blocks. A confirmation COUNT alone gives no way to tell a slow chain
      // from a broken command, which is when people interrupt it and send twice.
      expect(r.stdout).toContain('3 confirmation(s)');
      expect(r.stdout).toContain('about 6 seconds');
      expect(r.stdout).toContain('base-sepolia');
      // Presented as an estimate, never as a promise.
      expect(r.stdout).toContain('estimate');
    } finally { await stub.close(); }
  });

  it('publishes the estimate to machines too', async () => {
    const stub = await stubGateway((_req, res) => json(res, 200, REAL_TARGET()));
    try {
      const r = await certen(['--json', 'fund', '25', '--chain', 'base-sepolia', '--no-wait'], stub.url);
      expect((soleJson(r.stdout).data as Record<string, number>).estimated_wait_seconds).toBe(6);
    } finally { await stub.close(); }
  });
});

describe('certen fund: registering the payer at the moment it is known', () => {
  const PAYER = '0x2222222222222222222222222222222222222222';

  it('registers the sending wallet inline', async () => {
    const seen: string[] = [];
    const stub = await stubGateway((req, res) => {
      seen.push(`${req.method} ${(req.url ?? '').split('?')[0]}`);
      if ((req.url ?? '').includes('deposit-addresses')) {
        return json(res, 201, { chain: 'base-sepolia', address: PAYER });
      }
      return json(res, 200, REAL_TARGET());
    });
    try {
      const r = await certen([
        'fund', '25', '--chain', 'base-sepolia', '--no-wait', '--payer', PAYER,
      ], stub.url);

      expect(r.code).toBe(0);
      expect(seen).toContain('POST /v1/billing/deposit-addresses');
      expect(r.stdout).toContain('will credit automatically');
    } finally { await stub.close(); }
  });

  it('treats an already-registered wallet as nothing to do', async () => {
    const stub = await stubGateway((req, res) => {
      if ((req.url ?? '').includes('deposit-addresses')) {
        return json(res, 409, { error: 'Address already registered', code: 'CONFLICT' });
      }
      return json(res, 200, REAL_TARGET());
    });
    try {
      const r = await certen([
        'fund', '25', '--chain', 'base-sepolia', '--no-wait', '--payer', PAYER,
      ], stub.url);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain('already registered');
    } finally { await stub.close(); }
  });

  it('never lets a payer failure break the payment', async () => {
    const stub = await stubGateway((req, res) => {
      if ((req.url ?? '').includes('deposit-addresses')) {
        return json(res, 500, { error: 'boom', code: 'INTERNAL_ERROR' });
      }
      return json(res, 200, REAL_TARGET());
    });
    try {
      const r = await certen([
        'fund', '25', '--chain', 'base-sepolia', '--no-wait', '--payer', PAYER,
      ], stub.url);
      // The deposit target is valid regardless. Reporting a payer problem as a payment problem
      // would send someone hunting for a transfer that was never made.
      expect(r.code).toBe(0);
      expect(r.stdout).toContain('0x1111111111111111111111111111111111111111');
      expect(r.stdout).toContain('Could not register');
    } finally { await stub.close(); }
  });

  it('rejects a malformed payer before opening a payment', async () => {
    const r = await certen(['--json', 'fund', '25', '--chain', 'base-sepolia', '--payer', '0x123']);
    expect(r.code).toBe(2);
    expect((soleJson(r.stdout).error as Record<string, unknown>).code).toBe('INVALID_PAYER_ADDRESS');
  });

  it('suggests registration without spending a request to find out', async () => {
    const stub = await stubGateway((_req, res) => json(res, 200, REAL_TARGET()));
    try {
      const r = await certen(['fund', '25', '--chain', 'base-sepolia', '--no-wait'], stub.url);
      expect(r.stderr).toContain('--payer');
      // Checking whether a payer is already registered would cost a round trip on the money command
      // in exchange for a slightly better-targeted hint. Not a trade worth making.
      expect(stub.hits()).toBe(1);
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


describe('certen ledger and certen receipts', () => {
  const ENTRY = {
    id: 'le_1', account: 'available', amount_usd: '-5.000000', kind: 'capture',
    ref_type: 'identity', ref_id: 'id_1', memo: 'identity.provision',
    created_at: '2026-08-14T09:30:00.000Z',
  };
  const SUMMARY = {
    id: 'rc_1', receipt_number: '1041', type: 'charge', amount_usd: '5.000000',
    currency: 'USD', ref_type: 'identity', ref_id: 'id_1',
    digest: 'd1', signed: true, logged: true, issued_at: '2026-08-14T09:30:00.000Z',
  };
  const FULL = {
    ...SUMMARY, entry_group_id: 'eg_1', body: { a: 1 }, signature: 'sig', key_id: 'k1',
    algorithm: 'ed25519', price_book_hash: 'pbh', computation: {}, leaf_seq: 22065,
  };

  it('prints the ledger with signed amounts', async () => {
    const s = await stubGateway((req, res) => json(res, 200, { entries: [ENTRY] }));
    try {
      const r = await certen(['ledger'], s.url);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain('capture');
      // Negative renders as -$5.00, not $-5.00: the sign belongs outside the currency symbol.
      expect(r.stdout).toContain('-$5.00');
    } finally {
      await s.close();
    }
  });

  it('pages the whole ledger with --all and stops on a short page', async () => {
    // The endpoint reports no total and no has_more, so the stop condition is inferred. Getting it
    // wrong reports a partial ledger as complete, which for a reconciliation is worse than an error.
    const s = await stubGateway((req, res, hit) => {
      if (hit === 1) {
        return json(res, 200, { entries: [{ ...ENTRY, id: 'a' }, { ...ENTRY, id: 'b' }] });
      }
      return json(res, 200, { entries: [{ ...ENTRY, id: 'c' }] });
    });
    try {
      const r = await certen(['ledger', '--all', '--limit', '2', '--json'], s.url);
      expect(r.code).toBe(0);
      expect(s.hits()).toBe(2);
      const { entries } = soleJson(r.stdout).data as { entries: Array<{ id: string }> };
      expect(entries.map((e) => e.id)).toEqual(['a', 'b', 'c']);
    } finally {
      await s.close();
    }
  });

  it('refuses --all together with --offset', async () => {
    // --all starts from the beginning, so the two have no coherent joint meaning. Silently
    // ignoring one would skip records from a report that claims to be complete.
    const r = await certen(['ledger', '--all', '--offset', '10']);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/--offset has no meaning/);
  });

  it('rejects a non-numeric --limit before opening a connection', async () => {
    const r = await certen(['receipts', '--limit', 'lots']);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/not a whole number/);
  });

  it('shows which receipts can actually be proven', async () => {
    // `logged` is what decides whether an inclusion proof exists. A caller who cannot see it asks
    // for a proof, gets a 404, and cannot tell "not yet" from "wrong id".
    const s = await stubGateway((req, res) => json(res, 200, {
      receipts: [SUMMARY, { ...SUMMARY, id: 'rc_2', receipt_number: '1042', logged: false }],
    }));
    try {
      const r = await certen(['receipts'], s.url);
      expect(r.stdout).toMatch(/1041.*signed \+ logged/);
      expect(r.stdout).toMatch(/1042.*signed/);
      expect(r.stdout).not.toMatch(/1042.*logged/);
    } finally {
      await s.close();
    }
  });

  it('fetches one receipt without a proof by default', async () => {
    const s = await stubGateway((req, res) => json(res, 200, FULL));
    try {
      const r = await certen(['receipts', 'get', 'rc_1'], s.url);
      expect(r.code).toBe(0);
      expect(s.hits()).toBe(1);
      expect(r.stdout).toContain('Receipt 1041');
      expect(r.stdout).toContain('Signed ed25519 by key k1');
    } finally {
      await s.close();
    }
  });

  it('reads covering_head, not head, when saying whether a receipt is anchored', async () => {
    // The failure this prevents: `head` is the head at this tree size and may not itself be
    // anchored, while a LATER anchored root still commits to the leaf. Reporting head.anchor_status
    // calls a perfectly good receipt unanchored for every gap between anchors.
    const s = await stubGateway((req, res) => {
      if ((req.url ?? '').endsWith('/proof')) {
        return json(res, 200, {
          receipt_id: 'rc_1', leaf_hash: 'lh', leaf_salt: 'sa', leaf_index: 3,
          tree_size: 22100, root_hash: 'rh', audit_path: [],
          head: { tree_size: 22100, root_hash: 'rh', signature: 's', key_id: 'k',
            anchor_status: 'pending', anchor_tx_hash: null, anchor_account_url: null,
            anchor_block_time: null },
          covering_head: { tree_size: 22400, root_hash: 'rh2', signature: 's', key_id: 'k',
            anchor_status: 'anchored', anchor_tx_hash: '0xabc', anchor_account_url: 'acc://x',
            anchor_block_time: '2026-08-14T10:00:00.000Z', timestamp_attested: true },
        });
      }
      return json(res, 200, FULL);
    });
    try {
      const r = await certen(['receipts', 'get', 'rc_1', '--proof'], s.url);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain('Anchored on Accumulate in 0xabc');
      expect(r.stdout).toContain('(block timestamp)');
      expect(r.stdout).not.toMatch(/Not yet anchored/);
    } finally {
      await s.close();
    }
  });

  it('calls an unattested anchor time a loose bound rather than the block time', async () => {
    // Presenting last_block_time as exact would overstate what the anchor proves, which is the one
    // thing a timestamp claim must never do.
    const s = await stubGateway((req, res) => {
      if ((req.url ?? '').endsWith('/proof')) {
        return json(res, 200, {
          receipt_id: 'rc_1', leaf_index: 3, tree_size: 22100, audit_path: [],
          head: null,
          covering_head: { tree_size: 22400, anchor_status: 'anchored', anchor_tx_hash: '0xabc',
            anchor_block_time: '2026-08-14T10:00:00.000Z', timestamp_attested: false },
        });
      }
      return json(res, 200, FULL);
    });
    try {
      const r = await certen(['receipts', 'get', 'rc_1', '--proof'], s.url);
      expect(r.stdout).toMatch(/loose upper bound/);
      expect(r.stdout).not.toContain('(block timestamp)');
    } finally {
      await s.close();
    }
  });

  it('rejects --tree-size without --proof instead of ignoring it', async () => {
    const r = await certen(['receipts', 'get', 'rc_1', '--tree-size', '22065']);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/only applies to the inclusion proof/);
  });

  it('exits non-zero on an unknown receipt id', async () => {
    const s = await stubGateway((req, res) =>
      json(res, 404, { error: 'Receipt not found', code: 'NOT_FOUND' }));
    try {
      const r = await certen(['receipts', 'get', 'nope', '--json'], s.url);
      expect(r.code).not.toBe(0);
    } finally {
      await s.close();
    }
  });
});

describe('certen verify', () => {
  // A minimal sound receipt is built in the SDK suite against real ed25519 material; what matters
  // HERE is what a process exposes — the exit code a CI gate reads, and whether the report survives
  // a failure.
  const REPORT_PATHS = (over: Record<string, unknown>) =>
    (req: http.IncomingMessage, res: http.ServerResponse) => {
      const url = (req.url ?? '').split('?')[0];
      if (url in over) {
        const v = over[url] as { __status?: number; __body?: unknown };
        if (v && typeof v === 'object' && '__status' in v) {
          return json(res, v.__status as number, v.__body ?? {});
        }
        return json(res, 200, over[url]);
      }
      return json(res, 404, { error: 'not found', code: 'NOT_FOUND' });
    };

  it('exits NON-ZERO when a check could not be run', async () => {
    // The bug this pins, found by running the command: it set `process.exitCode`, and the CLI
    // entrypoint assigns `run()`'s return value over it — so the command printed "this is not a
    // verification" and exited 0. A CI gate would have read that as a pass, which is precisely the
    // failure `certen verify` exists to prevent.
    const s = await stubGateway(REPORT_PATHS({
      // Unsigned and unlogged: signature, inclusion, root and anchor all skip. Nothing FAILS.
      '/v1/billing/receipts/rc_1': {
        id: 'rc_1', receipt_number: '1', type: 'payment', amount_usd: '5.000000',
        body: null, digest: 'd', signature: null, key_id: null, logged: false, leaf_seq: null,
      },
      '/v1/billing/receipts/rc_1/proof': { __status: 404, __body: { error: 'not logged' } },
    }));
    try {
      const r = await certen(['verify', 'rc_1'], s.url);
      expect(r.code).toBe(1);
      expect(r.stdout + r.stderr).toMatch(/not a verification|INCOMPLETE/);
    } finally {
      await s.close();
    }
  });

  it('carries the checks under error.details so failing never costs you the diagnosis', async () => {
    // Same contract as `certen doctor`: the machine interface must not have to choose between
    // knowing something is wrong and knowing what.
    const s = await stubGateway(REPORT_PATHS({
      '/v1/billing/receipts/rc_1': {
        id: 'rc_1', receipt_number: '1', type: 'payment', amount_usd: '5.000000',
        body: { a: 1 }, digest: 'deadbeef', signature: null, key_id: null,
        logged: false, leaf_seq: null,
      },
      '/v1/billing/receipts/rc_1/proof': { __status: 404, __body: { error: 'not logged' } },
    }));
    try {
      const r = await certen(['verify', 'rc_1', '--json'], s.url);
      expect(r.code).toBe(1);
      const env = soleJson(r.stdout) as { ok: boolean; error: { code: string; details?: { checks?: unknown[] } } };
      expect(env.ok).toBe(false);
      // A body that does not hash to the stated digest is a FAILURE, not an omission.
      expect(env.error.code).toBe('RECEIPT_VERIFICATION_FAILED');
      expect(env.error.details?.checks?.length).toBeGreaterThan(0);
    } finally {
      await s.close();
    }
  });
});
