/**
 * Transaction-header fields — `additionalAuthorities` and `expiresAt` — and the outcome vocabulary
 * that goes with them (`reason_code: expired | expectation_unmet`, `completion_basis`).
 *
 * What is pinned:
 *
 * - every intent-opening method maps the fields to `additional_authorities` / `expires_at`;
 * - a malformed value is refused BEFORE any request, so no Idempotency-Key or portfolio read is spent;
 * - the gateway's default refusal (422 HEADER_AUTHORITY_NOT_EXECUTABLE) surfaces as a typed error
 *   that says what to do instead;
 * - `wait()` carries the failure reason, so `expired` and `expectation_unmet` are distinguishable
 *   without a second fetch.
 */
import { describe, it, expect } from 'vitest';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import {
  CertenAgent,
  CertenClient,
  CertenError,
  CertenBadRequestError,
  CertenHeaderAuthorityNotExecutableError,
  CertenIntentFailedError,
  describeReasonCode,
  expiresIn,
  isTransactionReasonCode,
  normalizeAdditionalAuthorities,
  normalizeExpiresAt,
  parseDuration,
  REASON_CODE_DESCRIPTIONS,
} from '../src/index.js';

const HASH = 'ab'.repeat(32);
const PUBKEY = '11'.repeat(32);
// Inside the gateway's window (60 s – 7 d) at any time the suite runs, and whole seconds.
const FUTURE = new Date(Math.floor(Date.now() / 1000) * 1000 + 3 * 3600_000).toISOString().replace('.000Z', 'Z');

interface Req { method: string; path: string; body?: any }

async function gateway(handler: (e: Req) => { status?: number; body?: unknown }) {
  const seen: Req[] = [];
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    const entry: Req = { method: req.method ?? 'GET', path: (req.url ?? '').split('?')[0], body: raw ? JSON.parse(raw) : undefined };
    seen.push(entry);
    const out = handler(entry);
    res.writeHead(out.status ?? 200, { 'content-type': 'application/json' }).end(JSON.stringify(out.body ?? {}));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  return { seen, url: `http://127.0.0.1:${port}`, close: () => server.close() };
}

const opened = {
  status: 201,
  body: {
    intent_id: 'intent-1',
    signing_mode: 'external',
    signing_data: { hash_to_sign: HASH, transaction_hash: 'cd'.repeat(32) },
    submit_url: '/v1/transaction/intent-1/signature',
  },
};
const okFlow = (e: Req) => (e.path === '/v1/transaction' && e.method === 'POST' ? opened : { body: { ok: true } });
const clientFor = (url: string) => new CertenClient({ apiKey: 'ck_live_test', baseUrl: url, maxRetries: 0 });
const openBody = (g: { seen: Req[] }) => g.seen.find((e) => e.path === '/v1/transaction' && e.method === 'POST')?.body;

const CALL = {
  identityId: 'id-1',
  adiUrl: 'acc://fictional-seller.acme',
  fromAddress: '0xAbstract',
  chain: 'ethereum-sepolia',
  contractCall: { target: `0x${'22'.repeat(20)}`, functionSignature: 'poke()' },
  publicKey: PUBKEY,
  sign: (h: string) => `signed:${h}`,
  skipFundingCheck: true,
};

const TRANSFER = {
  identityId: 'id-1',
  adiUrl: 'acc://fictional-seller.acme',
  fromChain: 'ethereum-sepolia',
  toChain: 'ethereum-sepolia',
  fromAddress: '0xAbstract',
  toAddress: `0x${'33'.repeat(20)}`,
  amount: '0.001',
  publicKey: PUBKEY,
  sign: (h: string) => `signed:${h}`,
  skipFundingCheck: true,
};

describe('request body mapping', () => {
  it('execute.contractCall sends additional_authorities (normalised) and expires_at', async () => {
    const g = await gateway(okFlow);
    try {
      await clientFor(g.url).execute.contractCall({
        ...CALL,
        additionalAuthorities: ['ACC://Fictional-Firm.acme/book', 'acc://fictional-firm.acme/book'],
        expiresAt: FUTURE,
      });
      const body = openBody(g);
      expect(body.additional_authorities).toEqual(['acc://fictional-firm.acme/book']);
      expect(body.expires_at).toBe(FUTURE);
    } finally { g.close(); }
  });

  it('execute.transfer renders a Date as RFC 3339', async () => {
    const g = await gateway(okFlow);
    try {
      const at = new Date(Date.now() + 2 * 86_400_000);
      await clientFor(g.url).execute.transfer({ ...TRANSFER, expiresAt: at });
      expect(openBody(g).expires_at).toBe(at.toISOString());
      expect(openBody(g)).not.toHaveProperty('additional_authorities');
    } finally { g.close(); }
  });

  it('omits both fields when not set, so existing callers send the same body as before', async () => {
    const g = await gateway(okFlow);
    try {
      await clientFor(g.url).execute.contractCall({ ...CALL, additionalAuthorities: [] });
      expect(openBody(g)).not.toHaveProperty('additional_authorities');
      expect(openBody(g)).not.toHaveProperty('expires_at');
    } finally { g.close(); }
  });

  it('transaction.create maps both fields', async () => {
    const g = await gateway(okFlow);
    try {
      await clientFor(g.url).transaction.create({
        identityId: 'id-1', intent: { adiUrl: 'acc://x.acme' },
        additionalAuthorities: ['acc://fictional-firm.acme/book'], expiresAt: FUTURE,
      });
      expect(openBody(g)).toMatchObject({ additional_authorities: ['acc://fictional-firm.acme/book'], expires_at: FUTURE });
    } finally { g.close(); }
  });

  it('agent.call and agent.transfer pass both fields through', async () => {
    const g = await gateway(okFlow);
    try {
      const signer = { publicKey: PUBKEY, publicKeyHash: 'ee'.repeat(32), sign: (h: string) => `signed:${h}` };
      const agent = new CertenAgent(clientFor(g.url), signer, {
        identityId: 'id-1', adiUrl: 'acc://fictional-agent.acme', keyPageUrl: null, accounts: { 'ethereum-sepolia': '0xAbstract' },
      });
      await agent.call({
        chain: 'ethereum-sepolia', call: CALL.contractCall, skipFundingCheck: true,
        additionalAuthorities: ['acc://fictional-firm.acme/book'], expiresAt: FUTURE,
      });
      await agent.transfer({ chain: 'ethereum-sepolia', to: TRANSFER.toAddress, amount: '0.001', skipFundingCheck: true, expiresAt: FUTURE });
      const opens = g.seen.filter((e) => e.path === '/v1/transaction' && e.method === 'POST');
      expect(opens[0].body).toMatchObject({ additional_authorities: ['acc://fictional-firm.acme/book'], expires_at: FUTURE });
      expect(opens[1].body).toMatchObject({ expires_at: FUTURE });
    } finally { g.close(); }
  });
});

describe('client-side validation, before any request', () => {
  const cases: Array<[string, Record<string, unknown>, string]> = [
    ['nine authorities', { additionalAuthorities: Array.from({ length: 9 }, (_, i) => `acc://f${i}.acme/book`) }, 'INVALID_ADDITIONAL_AUTHORITIES'],
    ['a non-acc URL', { additionalAuthorities: ['https://fictional-firm.example'] }, 'INVALID_ADDITIONAL_AUTHORITIES'],
    ['a non-array', { additionalAuthorities: 'acc://fictional-firm.acme/book' }, 'INVALID_ADDITIONAL_AUTHORITIES'],
    ['a past deadline', { expiresAt: '2001-01-01T00:00:00Z' }, 'INVALID_EXPIRES_AT'],
    ['a deadline without an offset', { expiresAt: FUTURE.replace('Z', '') }, 'INVALID_EXPIRES_AT'],
    ['a deadline 60s away (under the local 90s margin)', { expiresAt: new Date(Date.now() + 60_000) }, 'INVALID_EXPIRES_AT'],
    ['a deadline beyond 7 days', { expiresAt: new Date(Date.now() + 7 * 86_400_000 + 120_000) }, 'INVALID_EXPIRES_AT'],
    ['an authority with an empty host', { additionalAuthorities: ['acc:///book'] }, 'INVALID_ADDITIONAL_AUTHORITIES'],
    ['an authority that is only a scheme and slashes', { additionalAuthorities: ['acc:////'] }, 'INVALID_ADDITIONAL_AUTHORITIES'],
    ['an authority over 512 characters', { additionalAuthorities: [`acc://${'a'.repeat(507)}`] }, 'INVALID_ADDITIONAL_AUTHORITIES'],
    ['an unparseable deadline', { expiresAt: 'tomorrow' }, 'INVALID_EXPIRES_AT'],
    ['an invalid Date', { expiresAt: new Date('nope') }, 'INVALID_EXPIRES_AT'],
  ];

  for (const [name, extra, code] of cases) {
    it(`refuses ${name} with ${code} and sends nothing`, async () => {
      const g = await gateway(okFlow);
      try {
        const err = await clientFor(g.url).execute.contractCall({ ...CALL, skipFundingCheck: false, ...extra } as never)
          .catch((e) => e);
        expect(err).toBeInstanceOf(CertenError);
        expect(err.code).toBe(code);
        expect(g.seen).toHaveLength(0);
      } finally { g.close(); }
    });
  }

  it('counts the limit of eight after normalising and de-duplicating, like the gateway', () => {
    const spellings = Array.from({ length: 8 }, (_, i) => [`acc://f${i}.acme/book`, ` ACC://F${i}.acme/book/ `]).flat();
    expect(spellings).toHaveLength(16);
    expect(normalizeAdditionalAuthorities(spellings)).toEqual(Array.from({ length: 8 }, (_, i) => `acc://f${i}.acme/book`));
    const nine = [...spellings, 'acc://f8.acme/book'];
    expect(() => normalizeAdditionalAuthorities(nine)).toThrow(/9 distinct books/);
  });

  it('strips trailing slashes before comparing', () => {
    expect(normalizeAdditionalAuthorities(['acc://fictional-firm.acme/book//', 'acc://fictional-firm.acme/book']))
      .toEqual(['acc://fictional-firm.acme/book']);
  });

  it('applies the window in whole seconds: 90 s and 7 days are both accepted', () => {
    const now = Date.UTC(2026, 8, 14, 12, 0, 0);
    expect(normalizeExpiresAt(new Date(now + 90_000), now)).toBe('2026-09-14T12:01:30.000Z');
    expect(normalizeExpiresAt(new Date(now + 604_800_000), now)).toBe('2026-09-21T12:00:00.000Z');
    expect(() => normalizeExpiresAt(new Date(now + 89_000), now)).toThrow(/gateway requires at least 60s/);
    expect(() => normalizeExpiresAt(new Date(now + 604_801_000), now)).toThrow(/at most 604800s/);
    expect(() => normalizeExpiresAt(new Date(now - 1_000), now)).toThrow(/in the past/);
  });

  it('accepts exactly eight authorities', () => {
    const eight = Array.from({ length: 8 }, (_, i) => `acc://f${i}.acme/book`);
    expect(normalizeAdditionalAuthorities(eight)).toEqual(eight);
  });

  it('accepts an RFC 3339 string with a numeric offset, verbatim', () => {
    const now = Date.UTC(2026, 8, 14, 12, 0, 0);
    expect(normalizeExpiresAt(' 2026-09-14T15:00:00+02:00 ', now)).toBe('2026-09-14T15:00:00+02:00');
  });
});

describe('durations', () => {
  it('parses s, m, h and d', () => {
    expect(parseDuration('90s')).toBe(90_000);
    expect(parseDuration('30m')).toBe(1_800_000);
    expect(parseDuration('2h')).toBe(7_200_000);
    expect(parseDuration('7d')).toBe(604_800_000);
  });

  it('refuses anything else', () => {
    for (const bad of ['', '30', 'm', '0m', '-5m', '1.5h', '30 minutes', '1w']) {
      expect(() => parseDuration(bad), bad).toThrow(/not valid/);
    }
  });

  it('expiresIn is now + duration', () => {
    expect(expiresIn('30m', 1_000).getTime()).toBe(1_000 + 1_800_000);
  });
});

describe('the default refusal of header authorities', () => {
  it('maps 422 HEADER_AUTHORITY_NOT_EXECUTABLE to a typed error with guidance, and does not sign', async () => {
    const g = await gateway((e) => (e.path === '/v1/transaction'
      ? { status: 422, body: { error: 'additional_authorities are not executable', code: 'HEADER_AUTHORITY_NOT_EXECUTABLE' } }
      : { body: {} }));
    try {
      const err = await clientFor(g.url).execute.contractCall({
        ...CALL, additionalAuthorities: ['acc://fictional-firm.acme/book'],
      }).catch((e) => e);
      expect(err).toBeInstanceOf(CertenHeaderAuthorityNotExecutableError);
      expect(err).toBeInstanceOf(CertenBadRequestError);
      expect(err.status).toBe(422);
      expect(err.isRetryable).toBe(false);
      expect(err.guidance).toMatch(/account/);
      expect(g.seen.some((e) => e.path.endsWith('/signature'))).toBe(false);
    } finally { g.close(); }
  });
});

describe('reason codes', () => {
  it('describes every known reason, including expired and expectation_unmet', () => {
    for (const code of ['target_reverted', 'policy_denied', 'network_failed', 'post_submission_timeout',
      'pre_submission_error', 'expired', 'expectation_unmet']) {
      expect(isTransactionReasonCode(code), code).toBe(true);
      expect(REASON_CODE_DESCRIPTIONS[code as keyof typeof REASON_CODE_DESCRIPTIONS]).toBeTruthy();
    }
    expect(describeReasonCode('expired')).toMatch(/no fee or gas/);
    expect(describeReasonCode('expectation_unmet')).toMatch(/not a success/);
    expect(describeReasonCode('something_new')).toMatch(/does not recognise/);
    expect(describeReasonCode(null)).toBeUndefined();
  });

  for (const reason of ['expired', 'expectation_unmet']) {
    it(`wait() throws CertenIntentFailedError carrying reason_code ${reason}`, async () => {
      const g = await gateway(() => ({ body: { intent_id: 'intent-1', status: 'failed', reason_code: reason, error_message: 'x' } }));
      try {
        const err = await clientFor(g.url).execute.wait('intent-1', { intervalMs: 1, timeoutMs: 5_000 }).catch((e) => e);
        expect(err).toBeInstanceOf(CertenIntentFailedError);
        expect(err.reasonCode).toBe(reason);
        expect(err.intentId).toBe('intent-1');
        expect(err.message).toContain(`failed (${reason})`);
        expect(err.isRetryable).toBe(false);
      } finally { g.close(); }
    });
  }
});
