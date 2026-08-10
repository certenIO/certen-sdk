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
    const srv = await startServer((_req, res, n) => json(res, 200, {
      intent: {
        reference: 'dep_abc',
        status: n >= 3 ? 'matched' : 'open',
        amount_usd: '25.000000', expires_at: expires,
        matched_at: n >= 3 ? new Date().toISOString() : null,
        payment_id: n >= 3 ? 'pay_1' : null,
      },
    }));
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
    const srv = await startServer((_req, res) => json(res, 200, {
      intent: {
        reference: 'dep_abc', status: 'open', amount_usd: '25.000000',
        expires_at: new Date(Date.now() - 1000).toISOString(), matched_at: null, payment_id: null,
      },
    }));
    try {
      const final = await client(srv.url).billing.waitForPayment('dep_abc', { intervalMs: 5 });
      expect(final.status).toBe('open');
      expect(srv.recorded).toHaveLength(1);
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
