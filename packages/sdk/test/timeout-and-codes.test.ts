import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import { CertenClient } from '../src/index.js';
import { CertenError } from '../src/errors.js';

/**
 * Both of these were found by running the SDK against the live gateway, not by reading it.
 *
 *   1. `execute.proof()` failed with `NETWORK_ERROR` because the 30s request timeout was hardcoded
 *      and unreachable from the outside — the merkle-receipt fallback legitimately takes longer.
 *   2. An edge-level 502 has a `text/plain` body, so `data.code` was undefined and the error
 *      surfaced as `UNKNOWN_ERROR`. Anyone branching on `BAD_GATEWAY`, as docs/errors.md instructs,
 *      never matched.
 *
 * Neither is visible against a mock that always answers JSON promptly, which is why neither was
 * caught before.
 */

const servers: http.Server[] = [];

afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

/** A server that replies exactly as told — including non-JSON bodies and deliberate delays. */
async function serve(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<string> {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe('configurable request timeout', () => {
  it('defaults to 30s', async () => {
    const baseUrl = await serve((_req, res) => res.end('{}'));
    const c = new CertenClient({ apiKey: 'k', baseUrl });
    // Reach into the axios instance the client built — the default is otherwise unobservable.
    expect((c as unknown as { http: { defaults: { timeout: number } } }).http.defaults.timeout).toBe(30_000);
  });

  it('honours timeoutMs', async () => {
    const baseUrl = await serve((_req, res) => res.end('{}'));
    const c = new CertenClient({ apiKey: 'k', baseUrl, timeoutMs: 90_000 });
    expect((c as unknown as { http: { defaults: { timeout: number } } }).http.defaults.timeout).toBe(90_000);
  });

  it('a slow response fails under a short timeout', async () => {
    const baseUrl = await serve((_req, res) => {
      setTimeout(() => res.end('{"identity":{}}'), 400);
    });
    const c = new CertenClient({ apiKey: 'k', baseUrl, timeoutMs: 60, maxRetries: 0 });
    await expect(c.identity.get('x')).rejects.toMatchObject({ code: 'NETWORK_ERROR', status: 0 });
  });

  it('the same response succeeds when the caller allows more time', async () => {
    const baseUrl = await serve((_req, res) => {
      setTimeout(() => res.end('{"identity":{"id":"x"}}'), 400);
    });
    const c = new CertenClient({ apiKey: 'k', baseUrl, timeoutMs: 5_000 });
    await expect(c.identity.get('x')).resolves.toBeTruthy();
  });

  it('execute.proof outlives the client default, and accepts an override', async () => {
    let receiptDelay = 0;
    const baseUrl = await serve((req, res) => {
      res.setHeader('content-type', 'application/json');
      if (req.url?.includes('/v1/transaction/')) {
        // No proof_id -> forces the merkle-receipt fallback, the slow path.
        res.end(JSON.stringify({ accum_tx_hash: 'a'.repeat(64) }));
        return;
      }
      setTimeout(() => res.end(JSON.stringify({ receipt: true })), receiptDelay);
    });

    // Client timeout is tiny, but proof() applies its own longer budget to the receipt fetch.
    const c = new CertenClient({ apiKey: 'k', baseUrl, timeoutMs: 50, maxRetries: 0 });
    receiptDelay = 250;
    const p = await c.execute.proof('intent-1');
    expect(p.kind).toBe('accumulate-receipt');

    // And an explicit override still bounds it.
    receiptDelay = 400;
    await expect(c.execute.proof('intent-1', { timeoutMs: 60 })).rejects.toMatchObject({
      code: 'NETWORK_ERROR',
    });
  });
});

describe('error codes stay inside the documented catalog', () => {
  const cases: Array<[number, string]> = [
    [400, 'BAD_REQUEST'],
    [401, 'UNAUTHORIZED'],
    [403, 'FORBIDDEN'],
    [404, 'NOT_FOUND'],
    [409, 'CONFLICT'],
    [429, 'RATE_LIMIT_EXCEEDED'],
    [500, 'INTERNAL_ERROR'],
    [502, 'BAD_GATEWAY'],
    [503, 'BAD_GATEWAY'],
    [504, 'BAD_GATEWAY'],
  ];

  for (const [status, code] of cases) {
    it(`a plain-text ${status} maps to ${code}, not UNKNOWN_ERROR`, async () => {
      const baseUrl = await serve((_req, res) => {
        // Exactly what an edge 502 looks like: text/plain, no JSON, no code field.
        res.writeHead(status, { 'content-type': 'text/plain' });
        res.end(`error code: ${status}`);
      });
      const c = new CertenClient({ apiKey: 'k', baseUrl, maxRetries: 0 });
      await expect(c.identity.get('x')).rejects.toMatchObject({ status, code });
    });
  }

  it('a code the gateway actually sent always wins over the status map', async () => {
    const baseUrl = await serve((_req, res) => {
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'downstream exploded', code: 'PROOF_SERVICE_DOWN' }));
    });
    const c = new CertenClient({ apiKey: 'k', baseUrl, maxRetries: 0 });
    await expect(c.identity.get('x')).rejects.toMatchObject({ code: 'PROOF_SERVICE_DOWN' });
  });

  it('an unmapped status still reports UNKNOWN_ERROR', async () => {
    const baseUrl = await serve((_req, res) => {
      res.writeHead(418, { 'content-type': 'text/plain' });
      res.end('teapot');
    });
    const c = new CertenClient({ apiKey: 'k', baseUrl, maxRetries: 0 });
    await expect(c.identity.get('x')).rejects.toMatchObject({ status: 418, code: 'UNKNOWN_ERROR' });
  });

  it('the mapped codes keep their documented retry semantics', () => {
    expect(new CertenError('x', 502, 'BAD_GATEWAY').isRetryable).toBe(true);
    expect(new CertenError('x', 404, 'NOT_FOUND').isRetryable).toBe(false);
  });
});

describe('backing off when the server says when', () => {
  const jsonR = (
    res: http.ServerResponse, status: number, body: unknown,
    headers: Record<string, string> = {},
  ): void => {
    res.statusCode = status;
    res.setHeader('content-type', 'application/json');
    for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
    res.end(JSON.stringify(body));
  };

  it('waits the server-stated Retry-After rather than its own curve', async () => {
    // Exponential backoff is a guess made without information. `Retry-After` is the gateway saying
    // when the window reopens — retrying before it cannot succeed, and each early attempt still
    // counts against the limit.
    let hits = 0;
    const baseUrl = await serve((_req, res) => {
      hits += 1;
      if (hits === 1) {
        return jsonR(res, 429, { error: 'Rate limit exceeded', code: 'RATE_LIMIT_EXCEEDED' },
          { 'retry-after': '1' });
      }
      return jsonR(res, 200, { ok: true });
    });
    const t0 = Date.now();
    await new CertenClient({
      apiKey: 'ck_live_test', baseUrl, maxRetries: 2,
      // A tiny local curve: without honouring the header this retries almost immediately.
      baseBackoffMs: 5, maxBackoffMs: 10_000,
    }).billing.balance();
    expect(hits).toBe(2);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(1_000);
  });

  it('never waits longer than maxBackoffMs, whatever the server asks for', async () => {
    // A caller who set a ceiling agreed to wait that long and no longer; an hour-long
    // `Retry-After` must not park them there.
    let hits = 0;
    const baseUrl = await serve((_req, res) => {
      hits += 1;
      if (hits === 1) {
        return jsonR(res, 429, { error: 'slow down', code: 'RATE_LIMIT_EXCEEDED' },
          { 'retry-after': '3600' });
      }
      return jsonR(res, 200, { ok: true });
    });
    const t0 = Date.now();
    await new CertenClient({
      apiKey: 'ck_live_test', baseUrl, maxRetries: 1, baseBackoffMs: 5, maxBackoffMs: 200,
    }).billing.balance();
    expect(hits).toBe(2);
    expect(Date.now() - t0).toBeLessThan(3_000);
  });

  it('falls back to exponential backoff when no header is sent', async () => {
    let hits = 0;
    const baseUrl = await serve((_req, res) => {
      hits += 1;
      if (hits === 1) return jsonR(res, 503, { error: 'down', code: 'UNAVAILABLE' });
      return jsonR(res, 200, { ok: true });
    });
    await new CertenClient({
      apiKey: 'ck_live_test', baseUrl, maxRetries: 1, baseBackoffMs: 5, maxBackoffMs: 50,
    }).billing.balance();
    expect(hits).toBe(2);
  });

  it('does not self-throttle while quota remains', async () => {
    // `x-ratelimit-reset` rides on EVERY response. Treating it as a window to wait for — rather
    // than only once `x-ratelimit-remaining` hits zero — would sleep the full remaining window
    // before every request, turning a 60/min limit into roughly one request a minute.
    let hits = 0;
    const baseUrl = await serve((_req, res) => {
      hits += 1;
      res.setHeader('x-ratelimit-limit', '60');
      res.setHeader('x-ratelimit-remaining', '59');
      res.setHeader('x-ratelimit-reset', '56');
      jsonR(res, 200, { ok: true });
    });
    const client = new CertenClient({ apiKey: 'ck_live_test', baseUrl, maxBackoffMs: 10_000 });
    const t0 = Date.now();
    await client.billing.balance();
    await client.billing.balance();
    expect(hits).toBe(2);
    expect(Date.now() - t0).toBeLessThan(1_000);
  });

  it('waits — but not unboundedly — once quota is exhausted', async () => {
    // `reset` is seconds REMAINING, not an epoch. Read as an epoch it lands in 1970 and the
    // throttle silently never fires; read correctly but uncapped it can park a caller for the
    // whole window. Bounded by maxBackoffMs.
    let hits = 0;
    const baseUrl = await serve((_req, res) => {
      hits += 1;
      res.setHeader('x-ratelimit-limit', '60');
      res.setHeader('x-ratelimit-remaining', hits === 1 ? '0' : '59');
      res.setHeader('x-ratelimit-reset', '3600');
      jsonR(res, 200, { ok: true });
    });
    const client = new CertenClient({ apiKey: 'ck_live_test', baseUrl, maxBackoffMs: 150 });
    await client.billing.balance();
    const t0 = Date.now();
    await client.billing.balance();
    const waited = Date.now() - t0;
    expect(waited).toBeGreaterThanOrEqual(100);
    expect(waited).toBeLessThan(3_000);
  });

  it('carries the gateway validation detail on error.details', async () => {
    // It used to live only on `body`, so anything rendering `error.details` showed nothing for the
    // one error class where per-field structure is most useful.
    const baseUrl = await serve((_req, res) => jsonR(res, 400, {
      error: 'id must be a UUID',
      code: 'VALIDATION_ERROR',
      details: [{ instancePath: '/id', keyword: 'pattern' }],
    }));
    await expect(
      new CertenClient({ apiKey: 'ck_live_test', baseUrl, maxRetries: 0 }).billing.balance(),
    ).rejects.toMatchObject({
      message: 'id must be a UUID',
      details: { validation: [{ instancePath: '/id', keyword: 'pattern' }] },
    });
  });
});

/**
 * A gateway older than the client, told apart from a resource that is simply absent.
 *
 * Both are 404s, and collapsing them produced the least useful message on the whole surface:
 * `certen pricing` — a command the CLI advertises in its own `--help` — answered
 * `Error [NOT_FOUND]: Not Found` against production, because `GET /v1/pricing` had not been
 * deployed yet. Nothing in that message says whether the key lacks access, the resource is missing,
 * or the deployment is behind.
 *
 * Clients and the gateway deploy separately, so the window where one is ahead of the other is not
 * an edge case — it is every release, and it is precisely when someone hits this.
 *
 * The bodies are the real ones, captured from the live gateway.
 */
describe('telling a missing endpoint from a missing resource', () => {
  it('names version skew when the route is not registered', async () => {
    const url = await serve((_req, res) => {
      res.writeHead(404, { 'content-type': 'application/json' });
      // Fastify's unmatched-route 404: `statusCode` and a `Route …` message, and NO `code`.
      res.end(JSON.stringify({ message: 'Route GET:/v1/pricing not found', error: 'Not Found', statusCode: 404 }));
    });
    const client = new CertenClient({ apiKey: 'ck_live_test', baseUrl: url, maxRetries: 0 });

    const err = await client.billing.pricing().catch((e: unknown) => e as CertenError);

    expect(err).toBeInstanceOf(CertenError);
    expect((err as CertenError).code).toBe('ENDPOINT_NOT_ON_GATEWAY');
    // The method and path are named, because "which endpoint" is the first thing anyone asks.
    expect((err as CertenError).message).toContain('GET /v1/pricing');
    expect((err as CertenError).message).toContain('older than this client');
  });

  it('leaves a genuine missing resource alone', async () => {
    const url = await serve((_req, res) => {
      res.writeHead(404, { 'content-type': 'application/json' });
      // A handler-raised 404 always carries `code`. Misreading this as version skew would be worse
      // than the original bug: it would tell someone to upgrade their gateway over a bad id.
      res.end(JSON.stringify({ error: 'Transaction intent not found', code: 'NOT_FOUND' }));
    });
    const client = new CertenClient({ apiKey: 'ck_live_test', baseUrl: url, maxRetries: 0 });

    const err = await client.transaction.get('missing-id').catch((e: unknown) => e as CertenError);

    expect((err as CertenError).code).toBe('NOT_FOUND');
    expect((err as CertenError).message).toBe('Transaction intent not found');
  });

  it('does not mistake a 404 with no body for skew', async () => {
    const url = await serve((_req, res) => {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('Not Found');
    });
    const client = new CertenClient({ apiKey: 'ck_live_test', baseUrl: url, maxRetries: 0 });

    const err = await client.billing.pricing().catch((e: unknown) => e as CertenError);

    // A proxy or CDN can return this for reasons that have nothing to do with versions. Claiming
    // skew from an unparseable body would be a guess presented as a diagnosis.
    expect((err as CertenError).code).toBe('NOT_FOUND');
  });
});
