import { describe, it, expect } from 'vitest';
import http from 'node:http';
import { CertenClient } from '../src/client.js';
import { CertenError, CertenForeignOriginError } from '../src/errors.js';
import { checkOwnOrigin, assertOwnOrigin, redirectStaysOnOrigin } from '../src/origin.js';

/**
 * The API key goes only to the client's own gateway.
 *
 * Fail-before, recorded in RUNLOG_RB7b (F16): a gateway response whose `submit_url` was `http://<other host>/steal` made the SDK
 * sign and POST there with its default `X-API-Key` header, and the other host received the key. axios 1.19.0 and 1.20.0 both do
 * this, so the guard is in the client, not in a dependency version.
 */
const BASE = 'https://gateway.example.test';

describe('checkOwnOrigin', () => {
  it('accepts paths and absolute urls on the base origin', () => {
    for (const u of ['/v1/transaction/abc/signature', 'v1/x', `${BASE}/v1/x`, `${BASE.toUpperCase()}/v1/x`, '/v1/x?a=1#f', `${BASE}:443/v1/x`]) {
      expect(checkOwnOrigin(u, BASE).ok, u).toBe(true);
    }
  });

  it('refuses every way of naming another host', () => {
    const refused = [
      'https://evil.example/steal',                 // another host
      'http://gateway.example.test/v1/x',           // scheme downgrade is another origin
      'https://gateway.example.test:8443/v1/x',     // another port
      'https://gateway.example.test.evil.example/x', // suffix trick
      '//evil.example/steal',                       // protocol-relative
      'https://user:pw@gateway.example.test/v1/x',  // credentials smuggled in the url
      'https://gateway.example.test@evil.example/x', // userinfo that looks like the host
      'ftp://gateway.example.test/x',
    ];
    for (const u of refused) expect(checkOwnOrigin(u, BASE).ok, u).toBe(false);
  });

  it('judges the url axios will actually build: backslashes in a relative path stay on the gateway', () => {
    // axios appends a non-absolute url to the base, so this is a (strange) path on the gateway's own host, not another host.
    expect(checkOwnOrigin('\\\\evil.example\\steal', BASE).ok).toBe(true);
    expect(checkOwnOrigin('\\\\evil.example\\steal', BASE).resolved).toMatch(/^https:\/\/gateway\.example\.test\//);
  });

  it('respects a base url that has a path prefix', () => {
    expect(checkOwnOrigin('/v1/x', 'https://host.example/api').ok).toBe(true);
    expect(checkOwnOrigin('https://host.example/other/v1/x', 'https://host.example/api').ok).toBe(true); // same origin is the rule
    expect(checkOwnOrigin('https://evil.example/api/v1/x', 'https://host.example/api').ok).toBe(false);
  });

  it('assertOwnOrigin names the url, the base and where the url came from, in a typed error', () => {
    let err: unknown;
    try { assertOwnOrigin('https://evil.example/steal', BASE, 'submit_url'); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(CertenForeignOriginError);
    expect(err).toBeInstanceOf(CertenError);
    expect(err).toMatchObject({ code: 'FOREIGN_ORIGIN_URL', status: 0, url: 'https://evil.example/steal', baseUrl: BASE, source: 'submit_url' });
    expect((err as CertenError).details).toEqual({ url: 'https://evil.example/steal', baseUrl: BASE, source: 'submit_url' });
    expect((err as CertenError).isRetryable).toBe(false);
    expect((err as Error).message).toContain('no credential left this process');
  });
});

describe('redirectStaysOnOrigin', () => {
  it('allows the same origin and an http -> https upgrade of the same host, nothing else', () => {
    expect(redirectStaysOnOrigin('https://g.example', 'https://g.example/v1/x')).toBe(true);
    expect(redirectStaysOnOrigin('http://g.example', 'https://g.example/v1/x')).toBe(true);
    expect(redirectStaysOnOrigin('http://g.example:80', 'https://g.example:443/v1/x')).toBe(true);
    expect(redirectStaysOnOrigin('https://g.example', 'http://g.example/v1/x')).toBe(false);   // downgrade
    expect(redirectStaysOnOrigin('https://g.example', 'https://evil.example/x')).toBe(false);
    expect(redirectStaysOnOrigin('http://g.example', 'https://evil.example/x')).toBe(false);
    expect(redirectStaysOnOrigin('http://g.example:8080', 'https://g.example/x')).toBe(false); // not the default ports
    expect(redirectStaysOnOrigin('https://g.example', 'https://u:p@g.example/x')).toBe(false);
  });
});

interface Listener { url: string; seen: Array<{ method: string; url: string; key: string | undefined }>; close: () => Promise<void> }

async function listen(handler: (req: http.IncomingMessage, res: http.ServerResponse, seen: Listener['seen']) => void): Promise<Listener> {
  const seen: Listener['seen'] = [];
  const srv = http.createServer((req, res) => {
    seen.push({ method: req.method ?? '', url: req.url ?? '', key: req.headers['x-api-key'] as string | undefined });
    req.resume();
    req.on('end', () => handler(req, res, seen));
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${(srv.address() as { port: number }).port}`,
    seen,
    close: () => new Promise<void>((r) => { srv.closeAllConnections?.(); srv.close(() => r()); }),
  };
}
const json = (res: http.ServerResponse, status: number, body: unknown): void => {
  res.statusCode = status; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(body));
};
const SECRET = 'ck_live_must_never_leave_the_gateway';

describe('a response cannot send the key, or a signature, to another host', () => {
  const callParams = (sign: (h: string) => string) => ({
    identityId: 'id-1', adiUrl: 'acc://x.acme', chain: 'ethereum-sepolia', chainId: 11155111, fromAddress: `0x${'11'.repeat(20)}`,
    contractCall: { target: `0x${'22'.repeat(20)}`, functionName: 'f()', args: [] } as never,
    sign, publicKey: 'ab'.repeat(32), skipFundingCheck: true,
  });

  it('refuses a foreign submit_url on an intent BEFORE signing, and the other host sees nothing', async () => {
    const evil = await listen((_q, res) => json(res, 200, {}));
    const home = await listen((_q, res) => json(res, 201, {
      intent_id: 'i1', signing_mode: 'external', signing_data: { hash_to_sign: 'cd'.repeat(32), transaction_hash: 'ee'.repeat(32) },
      submit_url: `${evil.url}/steal`,
    }));
    try {
      let signed = 0;
      const client = new CertenClient({ apiKey: SECRET, baseUrl: home.url, maxRetries: 3 });
      const err = await client.execute.contractCall(callParams(() => { signed++; return 'ff'.repeat(64); })).catch((e) => e);
      expect(err).toBeInstanceOf(CertenForeignOriginError);
      expect(err).toMatchObject({ code: 'FOREIGN_ORIGIN_URL', source: 'submit_url', url: `${evil.url}/steal` });
      expect(signed, 'nothing may be signed for a url that will be refused').toBe(0);
      expect(evil.seen, 'the other host received a request').toEqual([]);
      expect(home.seen.filter((s) => s.method === 'POST')).toHaveLength(1); // the open only; no retry of the refused submit
    } finally { await evil.close(); await home.close(); }
  });

  it('still posts the signature to a relative submit_url and to an absolute one on its own origin', async () => {
    for (const make of [() => '/v1/transaction/i1/signature', (own: string) => `${own}/v1/transaction/i1/signature`]) {
      let own = '';
      const home = await listen((q, res) => {
        if (q.url === '/v1/transaction') return json(res, 201, {
          intent_id: 'i1', signing_mode: 'external', signing_data: { hash_to_sign: 'cd'.repeat(32), transaction_hash: 'ee'.repeat(32) }, submit_url: make(own),
        });
        return json(res, 200, { ok: true });
      });
      own = home.url;
      try {
        const client = new CertenClient({ apiKey: SECRET, baseUrl: home.url });
        const out = await client.execute.contractCall(callParams(() => 'ff'.repeat(64)));
        expect(out.intentId).toBe('i1');
        expect(home.seen.map((s) => `${s.method} ${s.url}`)).toEqual(['POST /v1/transaction', 'POST /v1/transaction/i1/signature']);
        expect(home.seen.every((s) => s.key === SECRET)).toBe(true);
      } finally { await home.close(); }
    }
  });

  it('refuses a foreign submit_url on a co-signature before signing as well', async () => {
    const evil = await listen((_q, res) => json(res, 200, {}));
    const home = await listen((_q, res) => json(res, 201, {
      sign_request_id: 'sr1', signing_data: { data_for_signature: 'cd'.repeat(32), transaction_hash: 'ee'.repeat(32) }, submit_url: `${evil.url}/steal`,
    }));
    try {
      let signed = 0;
      const client = new CertenClient({ apiKey: SECRET, baseUrl: home.url });
      const err = await client.execute.cosign({
        accumTxHash: 'ee'.repeat(32), identity: 'id-1', signerUrl: 'acc://x.acme/book/1', publicKey: 'ab'.repeat(32), sign: () => { signed++; return 'ff'.repeat(64); },
      }).catch((e) => e);
      expect(err).toBeInstanceOf(CertenForeignOriginError);
      expect(signed).toBe(0);
      expect(evil.seen).toEqual([]);
    } finally { await evil.close(); await home.close(); }
  });

  it('refuses ANY request to an absolute url on another host, whichever call site builds it', async () => {
    const evil = await listen((_q, res) => json(res, 200, {}));
    const home = await listen((_q, res) => json(res, 200, {}));
    try {
      const client = new CertenClient({ apiKey: SECRET, baseUrl: home.url, maxRetries: 3 });
      const http2 = (client.identity as unknown as { http: { get: (u: string) => Promise<unknown>; post: (u: string, b: unknown) => Promise<unknown> } }).http;
      await expect(http2.get(`${evil.url}/x`)).rejects.toMatchObject({ code: 'FOREIGN_ORIGIN_URL' });
      await expect(http2.post('//127.0.0.1:1/x', {})).rejects.toMatchObject({ code: 'FOREIGN_ORIGIN_URL' });
      expect(evil.seen).toEqual([]);
      expect(home.seen).toEqual([]);
    } finally { await evil.close(); await home.close(); }
  });

  it('does not follow a redirect off the gateway, so the key never reaches the target', async () => {
    const evil = await listen((_q, res) => json(res, 200, {}));
    const home = await listen((q, res) => {
      if (q.url === '/v1/portfolio') { res.statusCode = 307; res.setHeader('location', `${evil.url}/steal`); return void res.end(); }
      return json(res, 200, {});
    });
    try {
      const client = new CertenClient({ apiKey: SECRET, baseUrl: home.url, maxRetries: 3 });
      const err = await client.portfolio.get().catch((e) => e);
      expect(err).toBeInstanceOf(CertenForeignOriginError);
      expect(err).toMatchObject({ code: 'FOREIGN_ORIGIN_URL', source: 'redirect' });
      expect(err.isRetryable).toBe(false);
      expect(evil.seen).toEqual([]);
      expect(home.seen).toHaveLength(1); // the redirect is not retried
    } finally { await evil.close(); await home.close(); }
  });

  it('follows a redirect that stays on the gateway', async () => {
    const home = await listen((q, res) => {
      if (q.url === '/v1/portfolio') { res.statusCode = 307; res.setHeader('location', '/v1/portfolio/real'); return void res.end(); }
      return json(res, 200, { total_usd: '1' });
    });
    try {
      const client = new CertenClient({ apiKey: SECRET, baseUrl: home.url });
      await client.portfolio.get();
      expect(home.seen.map((s) => s.url)).toEqual(['/v1/portfolio', '/v1/portfolio/real']);
    } finally { await home.close(); }
  });
});
