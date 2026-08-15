import { describe, it, expect } from 'vitest';
import http from 'http';
import { AddressInfo } from 'net';
import { CertenClient, fetchSharedProof, parseShareTarget } from '../src/index.js';
import * as nodeCrypto from 'node:crypto';
import { canonicalJson, foldAuditPath } from '../src/verify-receipt.js';

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
  it('reads the intent straight from the body and URL-encodes the reference', async () => {
    // No envelope to unwrap any more: the response IS the intent.
    const srv = await startServer((_req, res) => json(res, 200,
      { reference: 'dep/a b', status: 'open', amount_usd: '25.000000', expires_at: 'x', matched_at: null, payment_id: null },
    ));
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
        reference: 'dep_abc',
        status: polls >= 3 ? 'matched' : 'open',
        amount_usd: '25.000000', expires_at: expires,
        matched_at: polls >= 3 ? new Date().toISOString() : null,
        payment_id: polls >= 3 ? 'pay_1' : null,
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
      reference: 'dep_abc', status: 'expired', amount_usd: '25.000000',
      expires_at: new Date(Date.now() - 1000).toISOString(), matched_at: null, payment_id: null,
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
        reference: 'dep_abc', status: 'open', amount_usd: '25.000000',
        expires_at: new Date(Date.now() - 1000).toISOString(), matched_at: null, payment_id: null,
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
      reference: 'dep_abc', status: 'open', amount_usd: '25.000000',
      expires_at: new Date(Date.now() + 3_600_000).toISOString(), matched_at: null, payment_id: null,
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
    reference: 'dep_x', status: 'open', amount_usd: '1.000000',
    expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    matched_at: null, payment_id: null,
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
          ...OPEN, expires_at: new Date(Date.now() + 50).toISOString(),
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
          ...OPEN, expires_at: new Date(Date.now() + 50).toISOString(),
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
          ...OPEN, status: 'matched', matched_at: new Date().toISOString(), payment_id: 'p9',
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

describe('billing.pricing', () => {
  it('reads the catalogue from GET /v1/pricing and hands it back whole', async () => {
    // Deliberately not reshaped by the SDK. The gateway already renders money as fixed-6dp strings
    // and marks uncapped items with a real null; converting either here would only introduce a
    // second representation of the same numbers for a caller to reconcile.
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
      ],
    };
    const s = await startServer((req, res) => json(res, 200, CATALOG));
    try {
      const out = await new CertenClient({ apiKey: 'ck_live_test', baseUrl: s.url })
        .billing.pricing();
      expect(s.recorded[0]).toMatchObject({ method: 'GET', path: '/v1/pricing' });
      expect(out).toEqual(CATALOG);
      // The one field a mapping layer would most likely flatten to a string or a zero.
      expect(out.items[1].max_charge_usd).toBeNull();
    } finally {
      await s.close();
    }
  });

  it('surfaces NO_PRICE_BOOK rather than reporting an empty catalogue', async () => {
    // "Nothing is priced" and "pricing is not configured" are different facts, and only one of
    // them should ever reach a caller deciding whether CERTEN can do the work.
    const s = await startServer((req, res) =>
      json(res, 503, { error: 'No price book is in effect', code: 'NO_PRICE_BOOK' }));
    try {
      await expect(
        new CertenClient({ apiKey: 'ck_live_test', baseUrl: s.url, maxRetries: 0 })
          .billing.pricing(),
      ).rejects.toMatchObject({ code: 'NO_PRICE_BOOK' });
    } finally {
      await s.close();
    }
  });
});

describe('billing.registerPayerAddress', () => {
  const RECORD = {
    id: 'da_1', chain: 'base-sepolia', address: '0x' + 'a'.repeat(40),
    label: 'treasury', is_active: true, verified_at: null,
    created_at: '2026-08-14T00:00:00.000Z',
  };

  it('registers the wallet the 402 tells you to register', async () => {
    // The gateway's PAYMENT_REQUIRED body names `POST /v1/billing/deposit-addresses` as the
    // recommended fix, and no client could call it. An autonomous caller settling its own refusal
    // is holding an API key with billing:write, which is all this endpoint asks for.
    const s = await startServer((req, res) => json(res, 201, RECORD));
    try {
      const out = await new CertenClient({ apiKey: 'ck_live_test', baseUrl: s.url })
        .billing.registerPayerAddress({
          chain: 'base-sepolia', address: RECORD.address, label: 'treasury',
        });
      expect(s.recorded[0]).toMatchObject({ method: 'POST', path: '/v1/billing/deposit-addresses' });
      expect(JSON.parse(s.recorded[0].body)).toEqual({
        chain: 'base-sepolia', address: RECORD.address, label: 'treasury',
      });
      expect(out).toEqual(RECORD);
    } finally {
      await s.close();
    }
  });

  it('omits the label rather than sending an empty one', async () => {
    // `label: ''` would be stored as the wallet's name, which is worse than having none.
    const s = await startServer((req, res) => json(res, 201, { ...RECORD, label: null }));
    try {
      await new CertenClient({ apiKey: 'ck_live_test', baseUrl: s.url })
        .billing.registerPayerAddress({ chain: 'base-sepolia', address: RECORD.address });
      expect(JSON.parse(s.recorded[0].body)).toEqual({
        chain: 'base-sepolia', address: RECORD.address,
      });
    } finally {
      await s.close();
    }
  });

  it('surfaces the 409 rather than reporting a registration that did not happen', async () => {
    // An address belongs to one organization per chain. Swallowing this would leave the caller
    // believing deposits will attribute automatically when they will not.
    const s = await startServer((req, res) =>
      json(res, 409, { error: 'Already registered', code: 'CONFLICT' }));
    try {
      await expect(
        new CertenClient({ apiKey: 'ck_live_test', baseUrl: s.url, maxRetries: 0 })
          .billing.registerPayerAddress({ chain: 'base-sepolia', address: RECORD.address }),
      ).rejects.toMatchObject({ status: 409 });
    } finally {
      await s.close();
    }
  });

  it('lists what is registered', async () => {
    const s = await startServer((req, res) => json(res, 200, { addresses: [RECORD] }));
    try {
      const out = await new CertenClient({ apiKey: 'ck_live_test', baseUrl: s.url })
        .billing.payerAddresses();
      expect(s.recorded[0]).toMatchObject({ method: 'GET', path: '/v1/billing/deposit-addresses' });
      expect(out.addresses[0].address).toBe(RECORD.address);
    } finally {
      await s.close();
    }
  });
});

describe('the evidence trail', () => {
  const ENTRY = {
    id: 'le_1', account: 'available', amount_usd: '-5.000000', kind: 'capture',
    ref_type: 'identity', ref_id: 'id_1', memo: 'identity.provision',
    created_at: '2026-08-14T00:00:00.000Z',
  };
  const SUMMARY = {
    id: 'rc_1', receipt_number: '1041', type: 'charge', amount_usd: '5.000000',
    currency: 'USD', ref_type: 'identity', ref_id: 'id_1',
    digest: 'd1', signed: true, logged: true, issued_at: '2026-08-14T00:00:00.000Z',
  };

  it('reads the ledger — the record that says where the money went', async () => {
    const s = await startServer((req, res) => json(res, 200, { entries: [ENTRY] }));
    try {
      const out = await new CertenClient({ apiKey: 'ck_live_test', baseUrl: s.url })
        .billing.ledger();
      expect(s.recorded[0].path).toBe('/v1/billing/ledger?limit=50&offset=0');
      expect(out.entries[0].amount_usd).toBe('-5.000000');
    } finally {
      await s.close();
    }
  });

  it('walks every ledger entry, stopping on a short page', async () => {
    // The endpoint returns no total and no has_more, so termination is inferred from page length.
    // Getting that wrong reports a partial ledger as complete — which for a reconciliation is worse
    // than failing outright.
    const s = await startServer((req, res, n) => {
      if (n === 1) return json(res, 200, { entries: Array.from({ length: 2 }, (_, i) => ({ ...ENTRY, id: `a${i}` })) });
      return json(res, 200, { entries: [{ ...ENTRY, id: 'b0' }] });
    });
    try {
      const seen: string[] = [];
      for await (const e of new CertenClient({ apiKey: 'ck_live_test', baseUrl: s.url })
        .billing.ledgerAll(2)) seen.push(e.id);
      expect(seen).toEqual(['a0', 'a1', 'b0']);
      expect(s.recorded).toHaveLength(2);
    } finally {
      await s.close();
    }
  });

  it('lists receipts and says which are signed and logged', async () => {
    // `logged` is what decides whether a proof can be fetched at all; without it a caller asking
    // for one gets a 404 and cannot tell "not yet" from "wrong id".
    const s = await startServer((req, res) => json(res, 200, { receipts: [SUMMARY] }));
    try {
      const out = await new CertenClient({ apiKey: 'ck_live_test', baseUrl: s.url })
        .billing.receipts({ limit: 2 });
      expect(s.recorded[0].path).toBe('/v1/billing/receipts?limit=2&offset=0');
      expect(out.receipts[0]).toMatchObject({ signed: true, logged: true });
    } finally {
      await s.close();
    }
  });

  it('fetches one receipt with its signature and computation intact', async () => {
    const FULL = {
      ...SUMMARY, entry_group_id: 'eg_1', body: { amount_microusd: '5000000' },
      signature: 'sig', key_id: 'k1', algorithm: 'ed25519',
      price_book_hash: 'pbh', computation: { gas_microusd: '0' }, leaf_seq: 22065,
      verification: { signature: 'ok' },
    };
    const s = await startServer((req, res) => json(res, 200, FULL));
    try {
      const out = await new CertenClient({ apiKey: 'ck_live_test', baseUrl: s.url })
        .billing.receipt('rc_1');
      expect(s.recorded[0].path).toBe('/v1/billing/receipts/rc_1');
      // Handed back whole. Reshaping any of it would break the one thing that makes it evidence:
      // the digest must be reproducible from `body` exactly as sent.
      expect(out).toEqual(FULL);
    } finally {
      await s.close();
    }
  });

  it('fetches the inclusion proof, and asks for the newest anchored head by default', async () => {
    const PROOF = {
      receipt_id: 'rc_1', leaf_hash: 'lh', leaf_salt: 'salt', leaf_index: 3,
      tree_size: 22100, root_hash: 'rh', audit_path: ['p1', 'p2'],
      head: { tree_size: 22100, root_hash: 'rh', signature: 's', key_id: 'k',
        anchor_status: 'pending', anchor_tx_hash: null, anchor_account_url: null,
        anchor_block_time: null },
      covering_head: { tree_size: 22400, root_hash: 'rh2', signature: 's', key_id: 'k',
        anchor_status: 'anchored', anchor_tx_hash: '0xabc', anchor_account_url: 'acc://x',
        anchor_block_time: '2026-08-14T01:00:00.000Z', timestamp_attested: true,
        is_same_head: false },
    };
    const s = await startServer((req, res) => json(res, 200, PROOF));
    try {
      const out = await new CertenClient({ apiKey: 'ck_live_test', baseUrl: s.url })
        .billing.receiptProof('rc_1');
      // No tree_size query: the default is the newest ANCHORED head, and a proof against an
      // unanchored head is only as good as CERTEN's word.
      expect(s.recorded[0].path).toBe('/v1/billing/receipts/rc_1/proof');
      // The distinction a verifier must not miss: this receipt's own head is NOT anchored, and
      // reading only `head.anchor_status` would report it as unproven when it is covered.
      expect(out.head?.anchor_status).toBe('pending');
      expect(out.covering_head?.anchor_status).toBe('anchored');
      expect(out.covering_head?.timestamp_attested).toBe(true);
    } finally {
      await s.close();
    }
  });

  it('pins a proof to a tree size when one is given', async () => {
    const s = await startServer((req, res) => json(res, 200, { receipt_id: 'rc_1' }));
    try {
      await new CertenClient({ apiKey: 'ck_live_test', baseUrl: s.url })
        .billing.receiptProof('rc_1', { treeSize: 22065 });
      expect(s.recorded[0].path).toBe('/v1/billing/receipts/rc_1/proof?tree_size=22065');
    } finally {
      await s.close();
    }
  });

  it('reads the verification keys', async () => {
    const s = await startServer((req, res) =>
      json(res, 200, { keys: [{ key_id: 'k1', algorithm: 'ed25519', public_key: 'pk' }] }));
    try {
      const out = await new CertenClient({ apiKey: 'ck_live_test', baseUrl: s.url })
        .billing.verificationKeys();
      expect(s.recorded[0].path).toBe('/v1/billing/receipts/verification-key');
      expect(out.keys[0].key_id).toBe('k1');
    } finally {
      await s.close();
    }
  });

  it('reports a receipt that is not yet logged as 404 rather than inventing a proof', async () => {
    const s = await startServer((req, res) =>
      json(res, 404, { error: 'Receipt is not in the transparency log', code: 'NOT_FOUND' }));
    try {
      await expect(
        new CertenClient({ apiKey: 'ck_live_test', baseUrl: s.url, maxRetries: 0 })
          .billing.receiptProof('rc_1'),
      ).rejects.toMatchObject({ status: 404 });
    } finally {
      await s.close();
    }
  });
});


describe('billing.verifyReceipt', () => {
  // Real ed25519 material and a real Merkle leaf, generated in-test, so these cases exercise the
  // actual cryptography rather than agreeing with a hardcoded expectation.
  const { generateKeyPairSync, createHash, sign: edSign, createPrivateKey } = nodeCrypto;

  function fixture() {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const rawPub = publicKey.export({ format: 'der', type: 'spki' }).subarray(12).toString('hex');
    const body = { amount_microusd: '5000000', type: 'payment', org: 'o1' };
    const canonical = canonicalJson(body);
    const digest = createHash('sha256').update(canonical).digest('hex');
    const signature = edSign(null, Buffer.from(digest, 'hex'), privateKey).toString('hex');

    const salt = '11'.repeat(32);
    const leaf = createHash('sha256')
      .update(Buffer.concat([
        Buffer.from([0x00]), Buffer.from(salt, 'hex'), Buffer.from(canonical, 'utf8'),
      ]))
      .digest('hex');

    // A single-leaf tree: the leaf IS the root, so the audit path is empty.
    return { rawPub, body, digest, signature, salt, leaf, root: leaf };
  }

  function gateway(f: ReturnType<typeof fixture>, over: Record<string, unknown> = {}) {
    return (req: http.IncomingMessage, res: http.ServerResponse) => {
      const url = (req.url ?? '').split('?')[0];
      if (url in over) {
        const v = over[url] as { __status?: number; __body?: unknown };
        if (v && typeof v === 'object' && '__status' in v) {
          return json(res, v.__status as number, v.__body ?? {});
        }
        return json(res, 200, over[url]);
      }
      if (url === '/v1/billing/receipts/rc_1') {
        return json(res, 200, {
          id: 'rc_1', receipt_number: '1', type: 'payment', amount_usd: '5.000000',
          currency: 'USD', ref_type: null, ref_id: null, body: f.body, digest: f.digest,
          signature: f.signature, key_id: 'k1', algorithm: 'ed25519', signed: true, logged: true,
          leaf_seq: 1, issued_at: '2026-08-14T00:00:00.000Z',
        });
      }
      if (url === '/v1/billing/receipts/verification-key') {
        return json(res, 200, { keys: [{ key_id: 'k1', algorithm: 'ed25519', public_key: f.rawPub }] });
      }
      if (url === '/v1/billing/receipts/rc_1/proof') {
        return json(res, 200, {
          receipt_id: 'rc_1', leaf_hash: f.leaf, leaf_salt: f.salt, leaf_index: 0,
          tree_size: 1, root_hash: f.root, audit_path: [],
          head: { tree_size: 1, root_hash: f.root, anchor_status: 'pending' },
          covering_head: {
            tree_size: 1, root_hash: f.root, anchor_status: 'anchored',
            anchor_tx_hash: '0xabc', anchor_block_time: '2026-08-14T01:00:00.000Z',
            timestamp_attested: true,
          },
        });
      }
      if (url === '/v1/transparency/heads/1') {
        return json(res, 200, { tree_size: 1, root_hash: f.root, anchor_status: 'anchored' });
      }
      return json(res, 404, {});
    };
  }

  const client = (url: string) =>
    new CertenClient({ apiKey: 'ck_live_test', baseUrl: url, maxRetries: 0 });

  it('verifies a sound receipt on every layer', async () => {
    const f = fixture();
    const s = await startServer(gateway(f));
    try {
      const r = await client(s.url).billing.verifyReceipt('rc_1');
      expect(r.checks.filter((c) => c.status !== 'ok')).toEqual([]);
      expect(r.verified).toBe(true);
      expect(r.complete).toBe(true);
    } finally {
      await s.close();
    }
  });

  it('catches a body that does not hash to the stated digest', async () => {
    // The tamper this exists to catch: the amount is edited and the digest left alone.
    const f = fixture();
    const s = await startServer(gateway(f, {
      '/v1/billing/receipts/rc_1': {
        id: 'rc_1', digest: f.digest, signature: f.signature, key_id: 'k1',
        body: { ...f.body, amount_microusd: '1' }, algorithm: 'ed25519', logged: false,
      },
    }));
    try {
      const r = await client(s.url).billing.verifyReceipt('rc_1');
      expect(r.verified).toBe(false);
      expect(r.checks.find((c) => c.name === 'digest')?.status).toBe('failed');
    } finally {
      await s.close();
    }
  });

  it('rejects a signature from a key the key set does not publish', async () => {
    // A signature by an unpublished key is not weaker evidence; it is none.
    const f = fixture();
    const s = await startServer(gateway(f, {
      '/v1/billing/receipts/verification-key': {
        keys: [{ key_id: 'other', algorithm: 'ed25519', public_key: f.rawPub }],
      },
    }));
    try {
      const r = await client(s.url).billing.verifyReceipt('rc_1');
      expect(r.checks.find((c) => c.name === 'signature')?.status).toBe('failed');
      expect(r.checks.find((c) => c.name === 'signature')?.detail).toMatch(/not in the published key set/);
    } finally {
      await s.close();
    }
  });

  it('rejects a signature made by a different key', async () => {
    const f = fixture();
    const other = fixture();
    const s = await startServer(gateway(f, {
      '/v1/billing/receipts/verification-key': {
        keys: [{ key_id: 'k1', algorithm: 'ed25519', public_key: other.rawPub }],
      },
    }));
    try {
      const r = await client(s.url).billing.verifyReceipt('rc_1');
      expect(r.checks.find((c) => c.name === 'signature')?.status).toBe('failed');
    } finally {
      await s.close();
    }
  });

  it('compares the folded root against the SEPARATELY fetched head, not the proof', async () => {
    // The whole point of the root check. Here the proof asserts a root that agrees with its own
    // audit path, and the independently served signed head says something else. Checking the proof
    // against itself would pass; checking it against the log catches it.
    const f = fixture();
    const s = await startServer(gateway(f, {
      '/v1/transparency/heads/1': { tree_size: 1, root_hash: 'ff'.repeat(32) },
    }));
    try {
      const r = await client(s.url).billing.verifyReceipt('rc_1');
      expect(r.verified).toBe(false);
      expect(r.checks.find((c) => c.name === 'root')?.status).toBe('failed');
    } finally {
      await s.close();
    }
  });

  it('SKIPS rather than passes when the log cannot be reached', async () => {
    // "I could not check" and "it checks out" are the two answers a dispute must never confuse.
    const f = fixture();
    const s = await startServer(gateway(f, {
      '/v1/transparency/heads/1': { __status: 503, __body: { error: 'down' } },
    }));
    try {
      const r = await client(s.url).billing.verifyReceipt('rc_1');
      expect(r.checks.find((c) => c.name === 'root')?.status).toBe('skipped');
      expect(r.verified).toBe(false);
      expect(r.complete).toBe(false);
    } finally {
      await s.close();
    }
  });

  it('keeps the signature verdict when a receipt is not yet in the log', async () => {
    // Not-yet-logged is an ordinary state. It must not lose the caller the checks that DID run.
    const f = fixture();
    const s = await startServer(gateway(f, {
      '/v1/billing/receipts/rc_1/proof': { __status: 404, __body: { error: 'not logged' } },
    }));
    try {
      const r = await client(s.url).billing.verifyReceipt('rc_1');
      expect(r.checks.find((c) => c.name === 'signature')?.status).toBe('ok');
      expect(r.checks.find((c) => c.name === 'inclusion')?.status).toBe('skipped');
      expect(r.verified).toBe(false);
    } finally {
      await s.close();
    }
  });

  it('does not present an unattested anchor time as the block timestamp', async () => {
    // Overstating what an anchor proves is the one thing a timestamp claim must never do.
    const f = fixture();
    const s = await startServer(gateway(f, {
      '/v1/billing/receipts/rc_1/proof': {
        receipt_id: 'rc_1', leaf_hash: f.leaf, leaf_salt: f.salt, leaf_index: 0,
        tree_size: 1, root_hash: f.root, audit_path: [],
        head: null,
        covering_head: {
          tree_size: 1, anchor_status: 'anchored', anchor_tx_hash: '0xabc',
          anchor_block_time: '2026-08-14T01:00:00.000Z', timestamp_attested: false,
        },
      },
    }));
    try {
      const r = await client(s.url).billing.verifyReceipt('rc_1');
      const anchor = r.checks.find((c) => c.name === 'anchor');
      expect(anchor?.status).toBe('ok');
      expect(anchor?.detail).toMatch(/loose upper bound/);
    } finally {
      await s.close();
    }
  });

  it('folds a multi-level audit path the way RFC 6962 specifies', async () => {
    // The unbalanced-tree case: a node that is the LAST at its level takes the right-hand branch
    // even at an even index. Dropping that condition passes on power-of-two trees and fails on
    // every other size, which is most of them.
    const a = Buffer.from('aa'.repeat(32), 'hex');
    const b = Buffer.from('bb'.repeat(32), 'hex');
    const parent = createHash('sha256')
      .update(Buffer.concat([Buffer.from([0x01]), a, b])).digest();
    expect(foldAuditPath(a.toString('hex'), 0, 2, [b.toString('hex')]))
      .toBe(parent.toString('hex'));
    // Same two leaves, other side: index 1 must fold sibling-first.
    expect(foldAuditPath(b.toString('hex'), 1, 2, [a.toString('hex')]))
      .toBe(parent.toString('hex'));
  });
});

describe('fetchSharedProof — the counterparty side of a share', () => {
  const BUNDLE = { proof_id: 'p1', anchors: [{ chain: 'base-sepolia' }] };
  const SHARED = {
    proof_id: 'p1', shared: true, expires_at: '2026-09-01T00:00:00.000Z',
    view_count: 1, bundle: BUNDLE,
  };

  it('takes the share link as handed over and needs no client and no key', async () => {
    // The asymmetry this closes: the SDK could create, list and revoke a share — every operation
    // for the SENDER — and had nothing for the person the feature is for, who by design has no
    // CERTEN account and so cannot construct a CertenClient at all.
    const s = await startServer((req, res) => json(res, 200, SHARED));
    try {
      const out = await fetchSharedProof(`${s.url}/v1/proof/shared/tok_abc`);
      expect(s.recorded[0]).toMatchObject({ method: 'GET', path: '/v1/proof/shared/tok_abc' });
      // No credential is sent — this endpoint takes none, and appearing to require one would be
      // the misleading part.
      expect(out).toEqual(SHARED);
    } finally {
      await s.close();
    }
  });

  it('accepts a bare token against an explicit base url', async () => {
    const s = await startServer((req, res) => json(res, 200, SHARED));
    try {
      const out = await fetchSharedProof('tok_abc', { baseUrl: s.url });
      expect(s.recorded[0].path).toBe('/v1/proof/shared/tok_abc');
      expect(out.proof_id).toBe('p1');
    } finally {
      await s.close();
    }
  });

  it('fetches from the origin in the LINK, not from a configured default', async () => {
    // A proof shared from one deployment must not be fetched from another, where the token is
    // meaningless — and the 404 that produced would read as "this proof never existed".
    const right = await startServer((req, res) => json(res, 200, SHARED));
    const wrong = await startServer((req, res) => json(res, 404, { error: 'no' }));
    try {
      const out = await fetchSharedProof(`${right.url}/v1/proof/shared/tok_abc`);
      expect(out.proof_id).toBe('p1');
      expect(wrong.recorded).toHaveLength(0);
    } finally {
      await right.close();
      await wrong.close();
    }
  });

  it('distinguishes a dead link from a link that never existed', async () => {
    // 410 means the link WAS real. Collapsing it into "not found" would leave a counterparty
    // believing the proof does not exist, when what they need is to ask for a fresh link.
    const s = await startServer((req, res) =>
      json(res, 410, { error: 'This share link has expired.', code: 'SHARE_NO_LONGER_VALID' }));
    try {
      await expect(fetchSharedProof(`${s.url}/v1/proof/shared/tok_abc`))
        .rejects.toMatchObject({ status: 410, code: 'SHARE_NO_LONGER_VALID' });
      await expect(fetchSharedProof(`${s.url}/v1/proof/shared/tok_abc`))
        .rejects.toThrow(/ask for a new link/);
    } finally {
      await s.close();
    }
  });

  it('rejects something that is not a share link before making a request', async () => {
    await expect(fetchSharedProof('https://example.com/somewhere/else'))
      .rejects.toMatchObject({ code: 'INVALID_SHARE_LINK' });
  });

  it('parses a link with a trailing slash and a percent-encoded token', async () => {
    expect(parseShareTarget('https://g.example/v1/proof/shared/tok%2Fabc/'))
      .toEqual({ token: 'tok/abc', baseUrl: 'https://g.example' });
  });
});
