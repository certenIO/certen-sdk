import { describe, it, expect } from 'vitest';
import http from 'http';
import { AddressInfo } from 'net';
import { CertenClient } from '../src/index.js';

/**
 * `client.doctor()`.
 *
 * A real localhost server rather than a mocked axios, matching the rest of this suite: the point
 * is what the SDK actually does with what the gateway actually returns, and a mock would let a
 * wrong interpretation pass.
 *
 * What is pinned here is the JUDGEMENT each check makes, because each has a plausible wrong answer:
 *
 * - a diagnosis must never THROW for a failed check — one that cannot report a broken setup is
 *   useless, and a caller wrapping it in try/catch would lose the report it needed;
 * - the check list is the same length however far the run got, so a skipped check is visibly
 *   skipped rather than absent;
 * - a 403 on billing means the key is REAL but unscoped, not that it is invalid;
 * - a healthy-looking balance that is entirely committed to pending intents is a FAILURE, because
 *   `remaining_usd` is what decides whether new work is accepted;
 * - an unfunded abstract account is a WARNING, not a failure — a contract call that forwards no
 *   value is unaffected, and blocking it would refuse work that succeeds.
 */

interface Stub { url: string; close: () => Promise<void> }

async function startServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<Stub> {
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => handler(req, res));
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

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body));
}

const CHAINS = { version: '2.0.0', last_updated: '2026-07-31', accumulate: {}, count: 3, chains: [] };
const BALANCE = {
  currency: 'USD', available_usd: '5.000000', held_usd: '0.000000',
  credit_limit_usd: '0.000000', spendable_usd: '5.000000', status: 'active',
};
const OBLIGATIONS = { pending_intents: 0, remaining_usd: '5.000000', uncovered_usd: '0.000000' };

/** One funded identity on a slug-named chain. Individual cases override one route at a time. */
const PORTFOLIO = {
  identities: [{
    adi_url: 'acc://mybot.acme',
    status: 'active',
    credit_balance: 500,
    chains: [{
      chain_id: 'base-sepolia', address: '0xAbs', deployed: true,
      balances: [{ token: 'ETH', balance: '1000000000000000' }],
    }],
    pending_actions: 0,
  }],
  total_chains: 1,
};

function gateway(over: Record<string, unknown> = {}): (req: http.IncomingMessage, res: http.ServerResponse) => void {
  return (req, res) => {
    const url = (req.url ?? '').split('?')[0];
    if (url in over) {
      const value = over[url] as { __status?: number; __body?: unknown };
      if (value && typeof value === 'object' && '__status' in value) {
        return json(res, value.__status as number, value.__body ?? {});
      }
      return json(res, 200, over[url]);
    }
    if (url === '/v1/chains') return json(res, 200, CHAINS);
    if (url === '/v1/billing/balance') return json(res, 200, BALANCE);
    if (url === '/v1/billing/obligations') return json(res, 200, OBLIGATIONS);
    if (url === '/v1/portfolio') return json(res, 200, PORTFOLIO);
    return json(res, 404, {});
  };
}

function client(url: string): CertenClient {
  // No retries: a case that deliberately returns 500 should be diagnosed, not retried three times.
  return new CertenClient({ apiKey: 'ck_live_test', baseUrl: url, maxRetries: 0 });
}

function byName(checks: Array<{ name: string; status: string; fix?: string; detail: string }>, name: string) {
  return checks.find((c) => c.name === name)!;
}

describe('a healthy setup', () => {
  it('reports every check ok and ok:true', async () => {
    const stub = await startServer(gateway());
    try {
      const report = await client(stub.url).doctor();
      expect(report.ok).toBe(true);
      expect(report.unreachable).toBe(false);
      expect(report.checks).toHaveLength(6);
      expect(report.checks.every((c) => c.status === 'ok')).toBe(true);
    } finally {
      await stub.close();
    }
  });
});

describe('it never throws, whatever is broken', () => {
  it('returns a report when the gateway is unreachable', async () => {
    // Discard port: refuses immediately, locally.
    const report = await client('http://127.0.0.1:9').doctor();
    expect(report.unreachable).toBe(true);
    expect(report.ok).toBe(false);
    // Same length as a healthy run. A caller must not have to branch on how far it got.
    expect(report.checks).toHaveLength(6);
    expect(byName(report.checks, 'gateway reachable').status).toBe('fail');
    expect(report.checks.filter((c) => c.status === 'skipped')).toHaveLength(5);
  });

  it('returns a report when the credential is rejected', async () => {
    const stub = await startServer(gateway({
      '/v1/billing/balance': { __status: 401, __body: { error: { message: 'nope' } } },
    }));
    try {
      const report = await client(stub.url).doctor();
      expect(report.ok).toBe(false);
      expect(byName(report.checks, 'api key').status).toBe('fail');
      expect(report.checks).toHaveLength(6);
    } finally {
      await stub.close();
    }
  });
});

describe('403 on billing means unscoped, not invalid', () => {
  it('treats the key as real and keeps going', async () => {
    const stub = await startServer(gateway({
      '/v1/billing/balance': { __status: 403, __body: { error: { message: 'no scope' } } },
    }));
    try {
      const report = await client(stub.url).doctor();
      const key = byName(report.checks, 'api key');
      expect(key.status).toBe('warn');
      expect(key.detail).toMatch(/billing:read/);
      // Rejecting a perfectly good scoped key would be the wrong answer, so the identity checks
      // below it still run.
      expect(byName(report.checks, 'identity can sign').status).toBe('ok');
      // And ok stays true: a missing optional scope is not a broken setup.
      expect(report.ok).toBe(true);
    } finally {
      await stub.close();
    }
  });
});

describe('the checks that catch silent failures', () => {
  it('fails when the balance is entirely committed to pending intents', async () => {
    // The balance reads healthy. `remaining_usd` is the number that decides whether new work is
    // accepted, and multi-signature intents can hold it for weeks.
    const stub = await startServer(gateway({
      '/v1/billing/obligations': { pending_intents: 3, remaining_usd: '0.000000', uncovered_usd: '1.5' },
    }));
    try {
      const report = await client(stub.url).doctor();
      expect(report.ok).toBe(false);
      const billing = byName(report.checks, 'billing balance');
      expect(billing.status).toBe('fail');
      expect(billing.detail).toMatch(/3 pending intent/);
    } finally {
      await stub.close();
    }
  });

  it('warns — does not fail — on an unfunded abstract account', async () => {
    const stub = await startServer(gateway({
      '/v1/portfolio': {
        identities: [{
          ...PORTFOLIO.identities[0],
          chains: [{ chain_id: 'base-sepolia', address: '0xAbs', deployed: true, balances: [{ token: 'ETH', balance: '0' }] }],
        }],
        total_chains: 1,
      },
    }));
    try {
      const report = await client(stub.url).doctor();
      // A contract call that forwards no value is unaffected, so failing here would refuse work
      // that would have succeeded.
      expect(report.ok).toBe(true);
      const funding = byName(report.checks, 'abstract accounts funded');
      expect(funding.status).toBe('warn');
      expect(funding.detail).toMatch(/anchoring/);
    } finally {
      await stub.close();
    }
  });

  it('counts empty accounts rather than implying the CHAIN has no gas', async () => {
    const stub = await startServer(gateway({
      '/v1/portfolio': {
        identities: [
          {
            ...PORTFOLIO.identities[0],
            chains: [{ chain_id: 'base-sepolia', address: '0xA', deployed: true, balances: [{ token: 'ETH', balance: '0' }] }],
          },
          {
            ...PORTFOLIO.identities[0],
            adi_url: 'acc://other.acme',
            chains: [{ chain_id: 'base-sepolia', address: '0xB', deployed: true, balances: [{ token: 'ETH', balance: '99' }] }],
          },
        ],
        total_chains: 1,
      },
    }));
    try {
      const report = await client(stub.url).doctor();
      // "1 of 2 chain account(s)" says something true; "no gas on base-sepolia" would not.
      expect(byName(report.checks, 'abstract accounts funded').detail).toMatch(/1 of 2 chain account/);
    } finally {
      await stub.close();
    }
  });

  it('normalizes the two spellings the gateway uses for a chain id', async () => {
    // `GET /v1/portfolio` returns a slug on some accounts and a numeric EVM id on others, in the
    // same response. Without normalizing, one chain is reported twice.
    const stub = await startServer(gateway({
      '/v1/portfolio': {
        identities: [{
          ...PORTFOLIO.identities[0],
          chains: [
            { chain_id: 'ethereum-sepolia', address: '0xA', deployed: true, balances: [{ token: 'ETH', balance: '0' }] },
            { chain_id: '11155111', address: '0xB', deployed: true, balances: [{ token: 'ETH', balance: '0' }] },
          ],
        }],
        total_chains: 1,
      },
    }));
    try {
      const report = await client(stub.url).doctor();
      const detail = byName(report.checks, 'abstract accounts funded').detail;
      expect(detail).toMatch(/2 of 2 chain account/);
      // One chain named once, not "ethereum-sepolia, 11155111".
      expect(detail).toContain('ethereum-sepolia');
      expect(detail).not.toContain('11155111');
    } finally {
      await stub.close();
    }
  });

  it('fails when there are no identities at all', async () => {
    const stub = await startServer(gateway({ '/v1/portfolio': { identities: [], total_chains: 0 } }));
    try {
      const report = await client(stub.url).doctor();
      expect(report.ok).toBe(false);
      expect(byName(report.checks, 'identity can sign').status).toBe('fail');
      expect(byName(report.checks, 'abstract accounts funded').status).toBe('skipped');
    } finally {
      await stub.close();
    }
  });

  it('fails on a suspended account and says why', async () => {
    const stub = await startServer(gateway({
      '/v1/billing/balance': { ...BALANCE, status: 'suspended', suspended_reason: 'arrears' },
    }));
    try {
      const report = await client(stub.url).doctor();
      expect(report.ok).toBe(false);
      expect(byName(report.checks, 'billing balance').detail).toMatch(/arrears/);
    } finally {
      await stub.close();
    }
  });
});

describe('credit and trials', () => {
  it('warns when a trial ends within three days', async () => {
    const soon = new Date(Date.now() + 2 * 86_400_000).toISOString();
    const stub = await startServer(gateway({
      '/v1/billing/balance': {
        ...BALANCE,
        credit: { kind: 'trial', label: 'Free trial', granted_limit_usd: '10.000000', expires_at: soon, expired: false },
      },
    }));
    try {
      const report = await client(stub.url).doctor();
      const credit = byName(report.checks, 'credit / trial');
      expect(credit.status).toBe('warn');
      expect(credit.detail).toMatch(/2 day/);
      // A trial that has not lapsed yet is not a broken setup.
      expect(report.ok).toBe(true);
    } finally {
      await stub.close();
    }
  });

  it('fails on an expired credit line', async () => {
    const stub = await startServer(gateway({
      '/v1/billing/balance': {
        ...BALANCE,
        credit: { kind: 'trial', granted_limit_usd: '10.000000', expired: true },
      },
    }));
    try {
      const report = await client(stub.url).doctor();
      expect(report.ok).toBe(false);
      expect(byName(report.checks, 'credit / trial').status).toBe('fail');
    } finally {
      await stub.close();
    }
  });

  it('is quiet when there is no credit line', async () => {
    const stub = await startServer(gateway());
    try {
      const report = await client(stub.url).doctor();
      expect(byName(report.checks, 'credit / trial').status).toBe('ok');
    } finally {
      await stub.close();
    }
  });
});
