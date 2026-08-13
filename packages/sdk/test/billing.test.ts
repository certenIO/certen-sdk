import { describe, it, expect } from 'vitest';
import http from 'http';
import { AddressInfo } from 'net';
import { CertenClient } from '../src/index.js';

/**
 * Billing: balance, commitments, and adding funds.
 *
 * Real localhost server rather than a mocked axios, matching client.test.ts — the
 * point is to observe exactly what the SDK sends and how it interprets what comes
 * back, including the polling loop, which a mock would let us fake into passing.
 */

interface Recorded { method: string; path: string; body: string }

async function startServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse, n: number) => void,
): Promise<{ url: string; recorded: Recorded[]; close: () => Promise<void> }> {
  const recorded: Recorded[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      recorded.push({
        method: req.method ?? '',
        path: req.url ?? '',
        body: Buffer.concat(chunks).toString('utf8'),
      });
      handler(req, res, recorded.length);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    recorded,
    close: () => new Promise<void>((resolve) => { server.close(() => resolve()); }),
  };
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body));
}

const target = (overrides: Record<string, unknown> = {}) => ({
  chain: 'base', chain_id: 8453, token_symbol: 'USDC', token_address: '0xT',
  token_decimals: 6, deposit_address: '0xTreasury', min_confirmations: 3,
  deposit_intent: { reference: 'dep_abc', amount_usd: '25.000000', expires_at: new Date(Date.now() + 3_600_000).toISOString() },
  note: 'send only USDC',
  ...overrides,
});

function client(url: string): CertenClient {
  return new CertenClient({ apiKey: 'ck_live_x', baseUrl: url, maxRetries: 0 });
}

describe('billing.openPayment', () => {
  it('sends the amount as a string under amount_usd', async () => {
    const srv = await startServer((_req, res) => json(res, 200, target()));
    try {
      const t = await client(srv.url).billing.openPayment({ chain: 'base', amountUsd: '25' });
      expect(srv.recorded[0].method).toBe('POST');
      expect(srv.recorded[0].path).toBe('/v1/billing/deposits');
      // Money crosses the wire as a decimal string. A JSON number would lose
      // cents at scale and the gateway rejects it anyway.
      expect(JSON.parse(srv.recorded[0].body)).toEqual({ chain: 'base', amount_usd: '25' });
      expect(t.deposit_intent?.reference).toBe('dep_abc');
    } finally { await srv.close(); }
  });

  it('omits amount_usd entirely when no amount is given', async () => {
    const srv = await startServer((_req, res) => json(res, 200, target({ deposit_intent: null })));
    try {
      const t = await client(srv.url).billing.openPayment({ chain: 'base' });
      // Not `amount_usd: undefined` — sending the key with no value would open an
      // intent that can never be matched.
      expect(JSON.parse(srv.recorded[0].body)).toEqual({ chain: 'base' });
      expect(t.deposit_intent).toBeNull();
    } finally { await srv.close(); }
  });
});

describe('billing.payment', () => {
  it('unwraps the intent envelope and URL-encodes the reference', async () => {
    const srv = await startServer((_req, res) => json(res, 200, {
      intent: { reference: 'dep/a b', status: 'open', amount_usd: '25.000000', expires_at: 'x', matched_at: null, payment_id: null },
    }));
    try {
      const s = await client(srv.url).billing.payment('dep/a b');
      expect(srv.recorded[0].path).toBe('/v1/billing/deposits/dep%2Fa%20b');
      expect(s.status).toBe('open');
    } finally { await srv.close(); }
  });
});

describe('billing.waitForPayment', () => {
  it('polls until the payment is matched', async () => {
    const expires = new Date(Date.now() + 3_600_000).toISOString();
    // Counts INTENT polls only: `waitForPayment` also reads the payments feed each tick, and a
    // shared counter made the response sequence depend on how many endpoints it happened to call.
    let polls = 0;
    const srv = await startServer((req, res) => {
      if (!(req.url ?? '').includes('/deposits/')) return json(res, 200, { payments: [] });
      polls += 1;
      return json(res, 200, {
        intent: {
          reference: 'dep_abc',
          status: polls >= 3 ? 'matched' : 'open',
          amount_usd: '25.000000', expires_at: expires,
          matched_at: polls >= 3 ? new Date().toISOString() : null,
          payment_id: polls >= 3 ? 'pay_1' : null,
        },
      });
    });
    try {
      const seen: string[] = [];
      const final = await client(srv.url).billing.waitForPayment('dep_abc', {
        intervalMs: 5,
        onPoll: (s) => seen.push(s.status),
      });
      expect(final.status).toBe('matched');
      expect(seen).toEqual(['open', 'open', 'matched']);
    } finally { await srv.close(); }
  });

  it('returns the expired status instead of throwing', async () => {
    // An expired payment is an ordinary outcome the caller must report, not an
    // exception. Throwing would make callers treat it as a transport failure.
    const srv = await startServer((_req, res) => json(res, 200, {
      intent: {
        reference: 'dep_abc', status: 'expired', amount_usd: '25.000000',
        expires_at: new Date(Date.now() - 1000).toISOString(), matched_at: null, payment_id: null,
      },
    }));
    try {
      const final = await client(srv.url).billing.waitForPayment('dep_abc', { intervalMs: 5 });
      expect(final.status).toBe('expired');
    } finally { await srv.close(); }
  });

  it('stops once the expiry has passed even while the status still reads open', async () => {
    // The gateway marks intents expired on a sweep, so `open` past its expiry is a
    // normal transient state. Without this the loop would spin to the timeout.
    const srv = await startServer((req, res) => {
      if (!(req.url ?? '').includes('/deposits/')) return json(res, 200, { payments: [] });
      return json(res, 200, {
        intent: {
          reference: 'dep_abc', status: 'open', amount_usd: '25.000000',
          expires_at: new Date(Date.now() - 1000).toISOString(), matched_at: null, payment_id: null,
        },
      });
    });
    try {
      const final = await client(srv.url).billing.waitForPayment('dep_abc', { intervalMs: 5 });
      expect(final.status).toBe('open');
      // Exactly one INTENT poll — the point is that it does not spin to the timeout. The payments
      // feed is read alongside it and is not what this case measures.
      expect(srv.recorded.filter((r) => r.path.includes('/deposits/'))).toHaveLength(1);
    } finally { await srv.close(); }
  });

  it('gives up at the timeout and returns the last status', async () => {
    const srv = await startServer((_req, res) => json(res, 200, {
      intent: {
        reference: 'dep_abc', status: 'open', amount_usd: '25.000000',
        expires_at: new Date(Date.now() + 3_600_000).toISOString(), matched_at: null, payment_id: null,
      },
    }));
    try {
      const final = await client(srv.url).billing.waitForPayment('dep_abc', {
        intervalMs: 5, timeoutMs: 20,
      });
      expect(final.status).toBe('open');
    } finally { await srv.close(); }
  });
});

describe('billing reads', () => {
  it('fetches balance and obligations from their own endpoints', async () => {
    const srv = await startServer((req, res) => {
      if ((req.url ?? '').includes('obligations')) {
        return json(res, 200, {
          pending_intents: 2, estimated_total_usd: '0.700000', uncovered_usd: '0.700000',
          spendable_usd: '0.900000', remaining_usd: '0.200000', shortfall_usd: '0.000000',
          enforcing: true, obligations: [],
        });
      }
      return json(res, 200, {
        currency: 'USD', available_usd: '0.900000', held_usd: '0.350000',
        credit_limit_usd: '0.000000', spendable_usd: '0.900000', status: 'active',
      });
    });
    try {
      const c = client(srv.url);
      const [balance, obligations] = await Promise.all([c.billing.balance(), c.billing.obligations()]);
      expect(balance.available_usd).toBe('0.900000');
      // remaining < spendable: pending work has already claimed part of it.
      expect(obligations.remaining_usd).toBe('0.200000');
      expect(srv.recorded.map((r) => r.path).sort()).toEqual(
        ['/v1/billing/balance', '/v1/billing/obligations'],
      );
    } finally { await srv.close(); }
  });
});

describe('billing.quote', () => {
  it('surfaces the id under the name the gateway actually sends', async () => {
    // The wire field is `quote_id`. The type declared `id`, so every read was undefined: the CLI
    // printed an empty id and then advised passing it as `quote_id=` — disabling the one thing a
    // quote exists for, locking the price. Asserted on the real field name so a rename upstream
    // fails here rather than silently blanking the value again.
    const s = await startServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
        quote_id: 'q-abc-123',
        sku: 'proof', chain: 'base-sepolia', proof_class: 'on_cadence', leg_count: 1,
        platform_fee_usd: '0.350000', gas_usd: '0.000000',
        total_usd: '0.350000', max_total_usd: '0.525000',
        expires_at: '2026-08-13T09:18:18.486Z',
      }));
    });
    try {
      const q = await new CertenClient({ apiKey: 'ck_live_test', baseUrl: s.url, maxRetries: 0 })
        .billing.quote({ chain: 'base-sepolia' });
      expect(q.quote_id).toBe('q-abc-123');
      expect(q.total_usd).toBe('0.350000');
    } finally {
      await s.close();
    }
  });
});

describe('waitForPayment and the registered-address path', () => {
  /**
   * Reproduces what happened live. The gateway has two ways to attribute money: matching a deposit
   * intent by exact amount, and recognising a REGISTERED payer address. On the second path the
   * payment is credited within seconds and the intent is never touched — it stays `open` until it
   * expires an hour later.
   *
   * Watching only the intent therefore reported "not credited" on money that had already arrived,
   * after making the caller wait the full hour. Observed: 1 USDC credited with
   * `attribution: registered_address` while the intent sat `open` with `matched_at: null`.
   */
  const OPEN = {
    intent: {
      reference: 'dep_x', status: 'open', amount_usd: '1.000000',
      expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      matched_at: null, payment_id: null,
    },
  };

  it('resolves as matched when the payment credits by registered address', async () => {
    let polls = 0;
    const s = await startServer((req, res) => {
      const url = (req.url ?? '').split('?')[0];
      if (url.startsWith('/v1/billing/deposits/')) {
        polls += 1;
        return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(OPEN));
      }
      // The payment shows up credited, attributed by address, never touching the intent.
      return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
        payments: [{
          id: 'pay-1', status: 'credited', amount_usd: '1.000000',
          attribution: 'registered_address', created_at: new Date().toISOString(),
        }],
      }));
    });
    try {
      const out = await new CertenClient({ apiKey: 'ck_live_test', baseUrl: s.url, maxRetries: 0 })
        .billing.waitForPayment('dep_x', { intervalMs: 10, timeoutMs: 5_000 });
      // From the caller's point of view the money arrived, which is the question they asked.
      expect(out.status).toBe('matched');
      expect(out.payment_id).toBe('pay-1');
      expect(polls).toBeLessThan(5);
    } finally {
      await s.close();
    }
  });

  it('ignores a credited payment of a DIFFERENT amount', async () => {
    const s = await startServer((req, res) => {
      const url = (req.url ?? '').split('?')[0];
      if (url.startsWith('/v1/billing/deposits/')) {
        return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
          intent: { ...OPEN.intent, expires_at: new Date(Date.now() + 50).toISOString() },
        }));
      }
      return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
        payments: [{ id: 'pay-2', status: 'credited', amount_usd: '25.000000', created_at: new Date().toISOString() }],
      }));
    });
    try {
      const out = await new CertenClient({ apiKey: 'ck_live_test', baseUrl: s.url, maxRetries: 0 })
        .billing.waitForPayment('dep_x', { intervalMs: 10, timeoutMs: 3_000 });
      // Someone else's deposit must never satisfy this one.
      expect(out.status).toBe('open');
    } finally {
      await s.close();
    }
  });

  it('does not treat a payment that predates the wait as evidence', async () => {
    const s = await startServer((req, res) => {
      const url = (req.url ?? '').split('?')[0];
      if (url.startsWith('/v1/billing/deposits/')) {
        return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
          intent: { ...OPEN.intent, expires_at: new Date(Date.now() + 50).toISOString() },
        }));
      }
      return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
        payments: [{
          id: 'pay-old', status: 'credited', amount_usd: '1.000000',
          created_at: new Date(Date.now() - 86_400_000).toISOString(),
        }],
      }));
    });
    try {
      const out = await new CertenClient({ apiKey: 'ck_live_test', baseUrl: s.url, maxRetries: 0 })
        .billing.waitForPayment('dep_x', { intervalMs: 10, timeoutMs: 3_000 });
      expect(out.status).toBe('open');
    } finally {
      await s.close();
    }
  });

  it('an unavailable payments feed never breaks a wait that would otherwise work', async () => {
    const s = await startServer((req, res) => {
      const url = (req.url ?? '').split('?')[0];
      if (url.startsWith('/v1/billing/deposits/')) {
        return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
          intent: { ...OPEN.intent, status: 'matched', matched_at: new Date().toISOString(), payment_id: 'p9' },
        }));
      }
      return res.writeHead(500, { 'content-type': 'application/json' }).end('{}');
    });
    try {
      const out = await new CertenClient({ apiKey: 'ck_live_test', baseUrl: s.url, maxRetries: 0 })
        .billing.waitForPayment('dep_x', { intervalMs: 10, timeoutMs: 3_000 });
      expect(out.status).toBe('matched');
    } finally {
      await s.close();
    }
  });
});
