/**
 * Contract tests — does what the SDK SENDS match what the API ACCEPTS?
 *
 * This file exists because the SDK shipped three methods that could not work, and nothing caught it:
 *
 *   - `transaction.create` sent a flat `{type,to,amount,…}` body and never sent `intent`, which is REQUIRED
 *   - `governance.create` omitted BOTH required fields and sent three the endpoint does not accept
 *   - `identity.list` called `GET /v1/identities`, a route that does not exist
 *
 * The existing suite passed throughout, because it exercised retry, idempotency, and error mapping against
 * a local mock that accepted any body. Those tests are good; they just cannot see this class of bug. A mock
 * that answers 200 to anything will never tell you the request was wrong.
 *
 * So: capture what each method puts on the wire, and check it against a snapshot of the gateway's own
 * OpenAPI spec — path exists, method exists, every required field present, no field the endpoint would
 * strip.
 *
 * Refresh the snapshot when the API changes:
 *   curl -s https://gateway.kompendium.co/docs/json > /tmp/gw.json   # then regenerate the fixture
 * It is vendored rather than fetched at test time on purpose: a unit suite that needs the network is a
 * suite that fails for reasons unrelated to the code.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CertenClient } from '../src/index.js';

interface Contract {
  paths: Record<string, Record<string, { required: string[]; properties: string[]; propertyTypes?: Record<string, string>; query: string[] }>>;
}
const CONTRACT: Contract = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures/openapi-contract.json'), 'utf8'),
);

/** Records the request each SDK call produces, and answers 200 so the call resolves. */
async function recorder() {
  const seen: Array<{ method: string; path: string; query: URLSearchParams; body: Record<string, unknown> }> = [];
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    const u = new URL(req.url ?? '/', 'http://x');
    seen.push({
      method: (req.method ?? 'GET').toLowerCase(),
      path: u.pathname,
      query: u.searchParams,
      body: raw ? JSON.parse(raw) : {},
    });
    res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  return { seen, url: `http://127.0.0.1:${port}`, close: () => server.close() };
}

/** Turn a concrete path into its spec template: /v1/identity/abc -> /v1/identity/{id} */
function templatize(path: string): string {
  const candidates = Object.keys(CONTRACT.paths);
  if (candidates.includes(path)) return path;
  const parts = path.split('/');
  for (const c of candidates) {
    const cp = c.split('/');
    if (cp.length !== parts.length) continue;
    if (cp.every((seg, i) => seg === parts[i] || (seg.startsWith('{') && seg.endsWith('}')))) return c;
  }
  return path;   // unmatched — the assertion below will report it as missing
}

/** The whole check, in one place. */
function assertMatchesSpec(req: { method: string; path: string; query: URLSearchParams; body: Record<string, unknown> }) {
  const tmpl = templatize(req.path);
  const pathSpec = CONTRACT.paths[tmpl];
  expect(pathSpec, `route ${req.method.toUpperCase()} ${req.path} is not in the API spec`).toBeDefined();

  const op = pathSpec[req.method];
  expect(op, `${req.method.toUpperCase()} is not defined on ${tmpl}`).toBeDefined();

  const sent = Object.keys(req.body);
  const unknown = sent.filter((k) => !op.properties.includes(k));
  expect(unknown, `${tmpl} would strip these — they are not in its schema`).toEqual([]);

  const missing = op.required.filter((r) => !sent.includes(r));
  expect(missing, `${tmpl} requires these and the SDK did not send them`).toEqual([]);

  const badQuery = [...req.query.keys()].filter((q) => !op.query.includes(q));
  expect(badQuery, `${tmpl} does not accept these query parameters`).toEqual([]);

  // Types, not just names.
  //
  // A name-only check answers "may I send this key" but never "in what shape", and that gap let a
  // real bug ship: `contract_addresses` is an object, the SDK declared `string[]` and sent
  // `[target]`, so every execute.contractCall was rejected with `/contract_addresses must be
  // object` while this test stayed green.
  const typeErrors: string[] = [];
  for (const [key, value] of Object.entries(req.body)) {
    const declared = op.propertyTypes?.[key];
    if (!declared || value === null || value === undefined) continue;
    if (!satisfiesJsonType(value, declared)) {
      typeErrors.push(`${key}: sent ${jsonTypeOf(value)}, schema says ${declared}`);
    }
  }
  expect(typeErrors, `${tmpl} received values of the wrong JSON type`).toEqual([]);
}

/** JSON Schema's type names, which differ from `typeof` for arrays and null. */
function jsonTypeOf(v: unknown): string {
  if (Array.isArray(v)) return 'array';
  if (v === null) return 'null';
  return typeof v;
}

/**
 * Is this value acceptable for the schema's declared type?
 *
 * Not string equality: JSON Schema's `number` accepts integers, so `credits: 50000` satisfies
 * `number` even though it is a whole number. Only the reverse is narrowing — a float does not
 * satisfy `integer`.
 */
function satisfiesJsonType(value: unknown, declared: string): boolean {
  const actual = jsonTypeOf(value);
  if (actual === declared) return true;
  if (declared === 'number' && actual === 'number') return true;
  if (declared === 'integer') return typeof value === 'number' && Number.isInteger(value);
  if (declared === 'number') return typeof value === 'number';
  return false;
}

describe('SDK requests match the API contract', () => {
  let rec: Awaited<ReturnType<typeof recorder>>;
  let certen: CertenClient;

  beforeEach(async () => {
    rec = await recorder();
    certen = new CertenClient({ apiKey: 'ck_live_test', baseUrl: rec.url, maxRetries: 0 });
    return () => rec.close();
  });

  const check = () => {
    expect(rec.seen.length, 'no request was recorded').toBeGreaterThan(0);
    for (const r of rec.seen) assertMatchesSpec(r);
  };

  // ── the three that were broken ────────────────────────────────────────────────────────────────────

  it('transaction.create sends identity_id + intent', async () => {
    await certen.transaction.create({
      identityId: 'id-1',
      intent: {
        fromChain: 'accumulate', toChain: 'ethereum-sepolia',
        fromAddress: 'acc://org.acme', toAddress: '0xBe00', amount: '4000', tokenSymbol: 'ETH',
      },
    });
    check();
    expect(rec.seen[0].body).toHaveProperty('intent');
    expect(rec.seen[0].body).not.toHaveProperty('type');   // the old flat shape, gone
  });

  it('transaction.create carries a contract-call intent and the seat/page selectors', async () => {
    await certen.transaction.create({
      identityId: 'id-1',
      // An OBJECT keyed by role — the endpoint rejects an array outright.
      contractAddresses: { anchor: '0xANCHOR', abstractAccount: '0xACCT' },
      signerKeyPage: 'acc://panel.acme/book/2',
      signerPublicKey: 'ab'.repeat(32),
      intent: {
        adiUrl: 'acc://panel.acme',
        legs: [{
          legId: 'leg-1', chain: 'ethereum-sepolia', chainId: 11155111,
          fromAddress: '0xAcct', toAddress: '0xESCROBOT', amount: '0',
          contractCall: { target: '0xESCROBOT', functionSignature: 'confirm(bytes32)', args: ['0xabc'], value: '0' },
        }],
      },
    });
    check();
    expect(rec.seen[0].body.signer_key_page).toBe('acc://panel.acme/book/2');
  });

  it('governance.create sends identity + operations', async () => {
    await certen.governance.create({
      identity: 'acc://panel.acme',
      operations: [{ type: 'remove_key', public_key_hash: 'aa'.repeat(32) }],
    });
    check();
    expect(rec.seen[0].body.identity).toBe('acc://panel.acme');
    expect(Array.isArray(rec.seen[0].body.operations)).toBe(true);
    expect(rec.seen[0].body).not.toHaveProperty('identity_id');
  });

  it('has no identity.list — GET /v1/identities does not exist', () => {
    expect((certen.identity as unknown as Record<string, unknown>).list).toBeUndefined();
    expect(CONTRACT.paths['/v1/identities']).toBeUndefined();
  });

  // ── the rest of the surface ───────────────────────────────────────────────────────────────────────

  it('identity.create omits webhook_url, which POST /v1/identity would strip', async () => {
    await certen.identity.create({
      name: 'buyer-bot', publicKey: 'ab'.repeat(32), publicKeyHash: 'cd'.repeat(32),
      chains: ['ethereum-sepolia'], credits: 50_000, idempotencyKey: 'idem-1',
    });
    check();
    expect(rec.seen[0].body).not.toHaveProperty('webhook_url');
  });

  it('identity.get sends no query parameters', async () => {
    await certen.identity.get('id-1');
    check();
    expect([...rec.seen[0].query.keys()]).toEqual([]);
  });

  it('identity.update sends only fields PATCH accepts', async () => {
    await certen.identity.update('id-1', { linkChains: ['base'], webhookUrl: 'https://h', publicKey: 'ab'.repeat(32) });
    check();
  });

  it('identity.retire targets the DELETE route', async () => {
    await certen.identity.retire('id-1');
    check();
    expect(rec.seen[0].method).toBe('delete');
  });

  it('transaction.submitSignature matches', async () => {
    await certen.transaction.submitSignature('i-1', { signature: 'ab'.repeat(64), publicKey: 'cd'.repeat(32) });
    check();
  });

  it('transaction.get and list match', async () => {
    await certen.transaction.get('i-1');
    await certen.transaction.list({ limit: 10 });
    check();
  });

  it('sign.create and sign.submitSignature match', async () => {
    await certen.sign.create({ type: 'pending_action', targetId: 'pa-1' } as never);
    await certen.sign.submitSignature('sr-1', { signature: 'ab'.repeat(64), publicKey: 'cd'.repeat(32) } as never);
    check();
  });

  it('governance.submitSignature and get match', async () => {
    await certen.governance.submitSignature('g-1', { signature: 'ab'.repeat(64), publicKey: 'cd'.repeat(32) });
    await certen.governance.get('g-1');
    check();
  });

  it('pending.list and portfolio.get match', async () => {
    await certen.pending.list({} as never);
    await certen.portfolio.get({} as never);
    check();
  });

  it('admin routes match', async () => {
    await certen.admin.createOrg({ name: 'acme' });
    await certen.admin.createApiKey({ name: 'k', orgId: 'o-1' });
    await certen.admin.listApiKeys();
    await certen.admin.getUsage();
    check();
  });
});

describe('the contract fixture itself', () => {
  it('is a real capture, not a stub', () => {
    expect(Object.keys(CONTRACT.paths).length).toBeGreaterThan(50);
    expect(CONTRACT.paths['/v1/transaction'].post.required).toContain('intent');
    expect(CONTRACT.paths['/v1/governance'].post.required).toEqual(
      expect.arrayContaining(['identity', 'operations']),
    );
  });
});

/**
 * These routes read query parameters, so the spec must declare them.
 *
 * It did not, for a while: the handlers were typed `Querystring: {...}` but the route schemas omitted
 * `querystring`, so @fastify/swagger emitted no `parameters`. The routes worked; the spec lied by omission,
 * and a client generated from it had no paging at all — while `/v1/pending` silently lost the identity and
 * category filters a signer needs to find its own work.
 *
 * Now fixed in the gateway. This is the regression guard on the SDK side; the gateway has its own in
 * `test/integration/openapi-snapshot.test.ts`.
 */
describe('paged and filtered routes declare their query parameters', () => {
  const expected: Record<string, string[]> = {
    '/v1/transactions': ['limit', 'offset'],
    '/v1/pending': ['identity', 'status', 'category', 'limit', 'offset'],
    '/v1/portfolio': ['identity'],
    '/v1/admin/usage': ['from', 'to'],
    '/v1/admin/audit-log': ['resource_type', 'action', 'from', 'to', 'limit', 'offset'],
    '/v1/admin/webhooks/deliveries': ['status', 'limit', 'offset'],
  };

  it.each(Object.entries(expected))('%s declares %s', (path, params) => {
    expect([...(CONTRACT.paths[path]?.get?.query ?? [])].sort()).toEqual([...params].sort());
  });
});
