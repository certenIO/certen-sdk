import { describe, it, expect, vi, beforeEach } from 'vitest';
import http from 'http';
import { AddressInfo } from 'net';
import { CertenClient, paginate } from '../src/index.js';
import { DEFAULT_BASE_URL } from '../src/client.js';
import {
  CertenError,
  CertenAuthError,
  CertenRateLimitError,
  CertenBadRequestError,
  CertenServerError,
} from '../src/index.js';

interface Recorded {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: string;
}

/**
 * Spin up a real localhost HTTP server so we can observe everything the
 * SDK sends — headers, bodies, retry-attempt count — without mocking
 * axios. The handler is pluggable per test.
 */
async function startServer(handler: (req: http.IncomingMessage, res: http.ServerResponse, recorded: Recorded) => void): Promise<{
  url: string;
  recorded: Recorded[];
  close: () => Promise<void>;
}> {
  const recorded: Recorded[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const r: Recorded = {
        method: req.method ?? '',
        path: req.url ?? '',
        headers: Object.fromEntries(
          Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(',') : (v ?? '')]),
        ),
        body: Buffer.concat(chunks).toString('utf8'),
      };
      recorded.push(r);
      handler(req, res, r);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    recorded,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

describe('CertenClient.auto-Idempotency-Key', () => {
  it('stamps an Idempotency-Key on POST when none is set', async () => {
    const srv = await startServer((_req, res) => {
      res.statusCode = 201;
      res.setHeader('content-type', 'application/json');
      res.end('{}');
    });
    try {
      const client = new CertenClient({ apiKey: 'ck_live_x', baseUrl: srv.url, maxRetries: 0 });
      const http = (client.transaction as unknown as { http: { post: (path: string, body: unknown) => Promise<unknown> } }).http;
      await http.post('/v1/transaction', { identity_id: 'x', intent: {} });
      const r = srv.recorded[0];
      expect(r.headers['idempotency-key']).toMatch(/^sdk_[a-z0-9]+_[0-9a-f]{16}$/);
    } finally {
      await srv.close();
    }
  });

  it('preserves the same Idempotency-Key across retries within a single call', async () => {
    let count = 0;
    const srv = await startServer((_req, res) => {
      count++;
      if (count < 3) {
        res.statusCode = 502;
        res.end('{"error":"upstream","code":"BAD_GATEWAY"}');
      } else {
        res.statusCode = 201;
        res.setHeader('content-type', 'application/json');
        res.end('{}');
      }
    });
    try {
      const client = new CertenClient({
        apiKey: 'ck_live_x', baseUrl: srv.url,
        maxRetries: 3, baseBackoffMs: 1, maxBackoffMs: 5,
      });
      const http = (client.transaction as unknown as { http: { post: (path: string, body: unknown) => Promise<unknown> } }).http;
      await http.post('/v1/transaction', { identity_id: 'x', intent: {} });
      // 3 server calls (2 failures + 1 success), but the SDK should send
      // the SAME Idempotency-Key each time so the gateway can de-dupe.
      const keys = srv.recorded.map((r) => r.headers['idempotency-key']);
      expect(keys).toHaveLength(3);
      expect(new Set(keys).size).toBe(1);
    } finally {
      await srv.close();
    }
  });

  it('does NOT stamp Idempotency-Key on GET', async () => {
    const srv = await startServer((_req, res) => {
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end('{}');
    });
    try {
      const client = new CertenClient({ apiKey: 'ck_live_x', baseUrl: srv.url, maxRetries: 0 });
      const http = (client.identity as unknown as { http: { get: (path: string) => Promise<unknown> } }).http;
      await http.get('/v1/identity/abc');
      expect(srv.recorded[0].headers['idempotency-key']).toBeUndefined();
    } finally {
      await srv.close();
    }
  });

  it('respects a caller-supplied Idempotency-Key when autoIdempotencyKey: false', async () => {
    const srv = await startServer((_req, res) => {
      res.statusCode = 201;
      res.end('{}');
    });
    try {
      const client = new CertenClient({
        apiKey: 'ck_live_x', baseUrl: srv.url, autoIdempotencyKey: false, maxRetries: 0,
      });
      const http = (client.transaction as unknown as { http: { post: (path: string, body: unknown, opts?: { headers: Record<string, string> }) => Promise<unknown> } }).http;
      await http.post('/v1/transaction', {}, { headers: { 'Idempotency-Key': 'caller-key-1' } });
      expect(srv.recorded[0].headers['idempotency-key']).toBe('caller-key-1');
    } finally {
      await srv.close();
    }
  });
});

describe('CertenClient.retry', () => {
  it('retries 5xx with exponential backoff', async () => {
    let count = 0;
    const timestamps: number[] = [];
    const srv = await startServer((_req, res) => {
      timestamps.push(Date.now());
      count++;
      if (count < 4) {
        res.statusCode = 503;
        res.end('{"error":"down","code":"SERVICE_DOWN"}');
      } else {
        res.statusCode = 200;
        res.end('{"ok":true}');
      }
    });
    try {
      const client = new CertenClient({
        apiKey: 'ck_live_x', baseUrl: srv.url,
        maxRetries: 5, baseBackoffMs: 20, maxBackoffMs: 200,
      });
      const http = (client.identity as unknown as { http: { get: (path: string) => Promise<unknown> } }).http;
      await http.get('/v1/identity/abc');
      expect(count).toBe(4);
      // gaps between attempts should grow (modulo jitter)
      const gaps = timestamps.slice(1).map((t, i) => t - timestamps[i]);
      expect(gaps.length).toBe(3);
      // last gap should be >= first gap (allowing jitter slack)
      expect(gaps[gaps.length - 1]).toBeGreaterThanOrEqual(gaps[0] - 5);
    } finally {
      await srv.close();
    }
  });

  it('does NOT retry 4xx (other than 408/429)', async () => {
    let count = 0;
    const srv = await startServer((_req, res) => {
      count++;
      res.statusCode = 400;
      res.end('{"error":"bad input","code":"BAD_REQUEST"}');
    });
    try {
      const client = new CertenClient({
        apiKey: 'ck_live_x', baseUrl: srv.url,
        maxRetries: 5, baseBackoffMs: 1, maxBackoffMs: 5,
      });
      const http = (client.identity as unknown as { http: { get: (path: string) => Promise<unknown> } }).http;
      await expect(http.get('/v1/identity/abc')).rejects.toBeInstanceOf(CertenBadRequestError);
      expect(count).toBe(1);
    } finally {
      await srv.close();
    }
  });

  it('retries 429 (rate-limited)', async () => {
    let count = 0;
    const srv = await startServer((_req, res) => {
      count++;
      if (count < 2) {
        res.statusCode = 429;
        res.setHeader('retry-after', '0');
        res.end('{"error":"rate","code":"RATE_LIMIT"}');
      } else {
        res.statusCode = 200;
        res.end('{"ok":true}');
      }
    });
    try {
      const client = new CertenClient({
        apiKey: 'ck_live_x', baseUrl: srv.url,
        maxRetries: 5, baseBackoffMs: 1, maxBackoffMs: 5,
      });
      const http = (client.identity as unknown as { http: { get: (path: string) => Promise<unknown> } }).http;
      await http.get('/v1/identity/abc');
      expect(count).toBe(2);
    } finally {
      await srv.close();
    }
  });
});

describe('CertenClient typed errors', () => {
  async function fireWith(status: number, body: string): Promise<unknown> {
    const srv = await startServer((_req, res) => {
      res.statusCode = status;
      res.end(body);
    });
    try {
      const client = new CertenClient({
        apiKey: 'ck_live_x', baseUrl: srv.url,
        maxRetries: 0,
      });
      const http = (client.identity as unknown as { http: { get: (path: string) => Promise<unknown> } }).http;
      try {
        await http.get('/v1/identity/abc');
        return null;
      } catch (err) {
        return err;
      }
    } finally {
      await srv.close();
    }
  }

  it('401 → CertenAuthError', async () => {
    const err = await fireWith(401, '{"error":"x","code":"UNAUTHORIZED"}');
    expect(err).toBeInstanceOf(CertenAuthError);
    expect((err as CertenError).code).toBe('UNAUTHORIZED');
  });

  it('403 → CertenAuthError', async () => {
    const err = await fireWith(403, '{"error":"x","code":"FORBIDDEN"}');
    expect(err).toBeInstanceOf(CertenAuthError);
  });

  it('429 → CertenRateLimitError', async () => {
    const err = await fireWith(429, '{"error":"x","code":"RATE_LIMIT"}');
    expect(err).toBeInstanceOf(CertenRateLimitError);
  });

  it('400 → CertenBadRequestError', async () => {
    const err = await fireWith(400, '{"error":"x","code":"BAD_REQUEST"}');
    expect(err).toBeInstanceOf(CertenBadRequestError);
  });

  it('502 → CertenServerError (retryable)', async () => {
    // Single attempt by passing maxRetries=0 in fireWith.
    const err = await fireWith(502, '{"error":"x","code":"BAD_GATEWAY"}');
    expect(err).toBeInstanceOf(CertenServerError);
    expect((err as CertenError).isRetryable).toBe(true);
  });

  it('exposes the gateway request id', async () => {
    const srv = await startServer((_req, res) => {
      res.setHeader('x-request-id', 'req-abc');
      res.statusCode = 400;
      res.end('{"error":"x","code":"BAD_REQUEST"}');
    });
    try {
      const client = new CertenClient({ apiKey: 'ck_live_x', baseUrl: srv.url, maxRetries: 0 });
      const http = (client.identity as unknown as { http: { get: (path: string) => Promise<unknown> } }).http;
      try {
        await http.get('/v1/identity/abc');
      } catch (err) {
        expect((err as CertenError).requestId).toBe('req-abc');
      }
    } finally {
      await srv.close();
    }
  });
});

describe('paginate helper', () => {
  it('walks pages until a short page is returned', async () => {
    const pages = [
      { items: [1, 2, 3], total: 7 },
      { items: [4, 5, 6], total: 7 },
      { items: [7], total: 7 },
    ];
    let pageIndex = 0;
    const out: number[] = [];
    for await (const v of paginate(async (limit, offset) => {
      const p = pages[pageIndex++];
      expect(limit).toBe(3);
      expect(offset).toBe(pageIndex === 1 ? 0 : pageIndex === 2 ? 3 : 6);
      return p;
    }, 3)) {
      out.push(v as number);
    }
    expect(out).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it('stops at the first empty page', async () => {
    const out: number[] = [];
    for await (const v of paginate<number>(async () => ({ items: [] }), 50)) {
      out.push(v);
    }
    expect(out).toEqual([]);
  });
});

/**
 * The default base URL.
 *
 * It was `https://api.certen.io`, which resolves — to the Certen marketing site. A client built without
 * `baseUrl` therefore returned HTML for every call, and the failure read as a broken SDK rather than a
 * wrong address. Nothing caught it because the old value was a perfectly well-formed URL, so these tests
 * assert both the right answer AND the specific wrong one.
 */
describe('CertenClient default base URL', () => {
  const ENV = 'CERTEN_API_URL';
  beforeEach(() => { delete process.env[ENV]; });

  it('points at the gateway when the caller says nothing', () => {
    expect(DEFAULT_BASE_URL).toBe('https://gateway.kompendium.co');
    const client = new CertenClient({ apiKey: 'ck_live_x' });
    expect(baseUrlOf(client)).toBe('https://gateway.kompendium.co');
  });

  it('is not the marketing site', () => {
    expect(DEFAULT_BASE_URL).not.toContain('api.certen.io');
  });

  it('honors CERTEN_API_URL, so a deployment can be retargeted without an SDK release', () => {
    process.env[ENV] = 'https://staging.example.com';
    expect(baseUrlOf(new CertenClient({ apiKey: 'ck_live_x' }))).toBe('https://staging.example.com');
  });

  /** Explicit beats env beats default — an caller who passed a URL must always get that URL. */
  it('lets an explicit baseUrl win over the env var', () => {
    process.env[ENV] = 'https://staging.example.com';
    const client = new CertenClient({ apiKey: 'ck_live_x', baseUrl: 'https://explicit.example.com' });
    expect(baseUrlOf(client)).toBe('https://explicit.example.com');
  });
});

/** The axios instance is private; read the resolved baseURL the way a caller cannot, for assertions only. */
function baseUrlOf(client: CertenClient): string | undefined {
  return (client as unknown as { http: { defaults: { baseURL?: string } } }).http.defaults.baseURL;
}
