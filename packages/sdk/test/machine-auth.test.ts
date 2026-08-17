import { describe, it, expect } from 'vitest';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import { CertenClient } from '../src/index.js';
import { CertenError } from '../src/errors.js';

/**
 * Authenticating with no human in the loop.
 *
 * Every credential this SDK could hold came from a person: an API key minted in a portal, or one
 * collected by the device flow — which pauses until somebody opens a browser and approves it. So an
 * agent, a CI job or any unattended process could not obtain a credential, and the onboarding story
 * for a machine ended with "ask a human".
 *
 * The gateway never had that limitation. `apiKeyAuth` accepts `Authorization: Bearer` on every
 * protected route, and the OAuth2 client-credentials grant exists precisely so a service can
 * authenticate itself. The SDK sent `X-API-Key` and nothing else — so `fetchOAuthToken()` minted
 * tokens that no part of this SDK could spend.
 *
 * A human still creates the CLIENT once, and that is the right boundary: someone must be
 * accountable for what an organization's credentials can do. What should never have needed a human
 * is the step after — and that is what these cover.
 */

const servers: http.Server[] = [];

interface Hit { method: string; url: string; auth?: string; apiKey?: string; body: string }

async function gateway(handler: (hit: Hit, n: number) => { status?: number; body?: unknown }) {
  const hits: Hit[] = [];
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    const hit: Hit = {
      method: req.method ?? 'GET',
      url: (req.url ?? '').split('?')[0],
      auth: req.headers.authorization as string | undefined,
      apiKey: req.headers['x-api-key'] as string | undefined,
      body: raw,
    };
    hits.push(hit);
    const out = handler(hit, hits.length);
    res.writeHead(out.status ?? 200, { 'content-type': 'application/json' })
      .end(JSON.stringify(out.body ?? {}));
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { hits, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

/** The gateway's real token response, plus whatever the endpoint under test should return. */
function respond(hit: Hit, n: number, tokenTtl = 3600): { status?: number; body?: unknown } {
  if (hit.url === '/v1/oauth/token') {
    return {
      body: {
        access_token: `at_${n}`,
        refresh_token: `rt_${n}`,
        token_type: 'Bearer',
        expires_in: tokenTtl,
      },
    };
  }
  return { body: { ok: true, scopes: ['billing:read'] } };
}

describe('a credential that needs nobody', () => {
  it('mints its own token from client credentials and sends it as a Bearer', async () => {
    const g = await gateway(respond);
    const client = new CertenClient({
      clientId: 'cid_1', clientSecret: 'cs_1', baseUrl: g.url, maxRetries: 0,
    });

    await client.me();

    const [token, me] = g.hits;
    expect(token.url).toBe('/v1/oauth/token');
    expect(JSON.parse(token.body).grant_type).toBe('client_credentials');
    // The secret goes to the token endpoint and NOWHERE else. Only the short-lived token travels
    // with ordinary requests, which is the whole security argument for this over a shared key.
    expect(me.url).toBe('/v1/me');
    expect(me.auth).toBe('Bearer at_1');
    expect(me.apiKey).toBeUndefined();
    expect(me.body).not.toContain('cs_1');
  });

  it('reuses the token instead of minting one per request', async () => {
    const g = await gateway(respond);
    const client = new CertenClient({
      clientId: 'cid_1', clientSecret: 'cs_1', baseUrl: g.url, maxRetries: 0,
    });

    await client.me();
    await client.me();
    await client.me();

    // One token, three calls. Minting per request would triple the request count and leave live
    // credentials scattered behind — each one valid for an hour.
    expect(g.hits.filter((h) => h.url === '/v1/oauth/token')).toHaveLength(1);
    expect(g.hits.filter((h) => h.url === '/v1/me')).toHaveLength(3);
  });

  it('mints ONCE for concurrent calls on a cold client', async () => {
    const g = await gateway(respond);
    const client = new CertenClient({
      clientId: 'cid_1', clientSecret: 'cs_1', baseUrl: g.url, maxRetries: 0,
    });

    // The realistic shape for an agent: fire everything at once on startup. Without a single-flight
    // guard this mints ten tokens and abandons nine, which is an invisible leak of live credentials.
    await Promise.all(Array.from({ length: 10 }, () => client.me()));

    expect(g.hits.filter((h) => h.url === '/v1/oauth/token')).toHaveLength(1);
    expect(g.hits.filter((h) => h.url === '/v1/me')).toHaveLength(10);
  });

  it('re-mints BEFORE expiry rather than after a 401', async () => {
    // A token valid for 30s is already inside the 60s refresh margin, so the second call must not
    // reuse it. Waiting for expiry to announce itself as a 401 means one request fails every hour,
    // forever, for a reason the caller can do nothing about.
    const g = await gateway((hit, n) => respond(hit, n, 30));
    const client = new CertenClient({
      clientId: 'cid_1', clientSecret: 'cs_1', baseUrl: g.url, maxRetries: 0,
    });

    await client.me();
    await client.me();

    expect(g.hits.filter((h) => h.url === '/v1/oauth/token')).toHaveLength(2);
    expect(g.hits.filter((h) => h.url === '/v1/me').map((h) => h.auth))
      .toEqual(['Bearer at_1', 'Bearer at_3']);
  });

  it('treats a missing expires_in as an hour, not as forever', async () => {
    const g = await gateway((hit, n) => {
      if (hit.url === '/v1/oauth/token') {
        return { body: { access_token: `at_${n}`, token_type: 'Bearer' } };
      }
      return { body: { ok: true } };
    });
    const client = new CertenClient({
      clientId: 'cid_1', clientSecret: 'cs_1', baseUrl: g.url, maxRetries: 0,
    });

    await client.me();
    await client.me();

    // Reused, because an hour has not passed — but bounded, so a gateway that omits the field can
    // never strand this client on a token that died silently.
    expect(g.hits.filter((h) => h.url === '/v1/oauth/token')).toHaveLength(1);
  });

  it('sends a pre-minted token as-is, without a token endpoint round trip', async () => {
    const g = await gateway(respond);
    const client = new CertenClient({ accessToken: 'at_supplied', baseUrl: g.url, maxRetries: 0 });

    await client.me();

    expect(g.hits).toHaveLength(1);
    expect(g.hits[0].auth).toBe('Bearer at_supplied');
  });

  it('still sends an API key as an API key', async () => {
    const g = await gateway(respond);
    const client = new CertenClient({ apiKey: 'ck_live_test', baseUrl: g.url, maxRetries: 0 });

    await client.me();

    expect(g.hits[0].apiKey).toBe('ck_live_test');
    expect(g.hits[0].auth).toBeUndefined();
  });
});

describe('refusing an unusable client at construction', () => {
  it('rejects a client with no credential at all', () => {
    // Previously this constructed fine and sent `X-API-Key: undefined`, so the failure surfaced as
    // a 401 on whichever call happened to run first — blaming that call rather than the setup.
    expect(() => new CertenClient({ baseUrl: 'http://127.0.0.1:9' }))
      .toThrow(/no credential/);
  });

  it('rejects a client id with no secret', () => {
    expect(() => new CertenClient({ clientId: 'cid_1', baseUrl: 'http://127.0.0.1:9' }))
      .toThrow(/clientSecret/);
  });

  it('reports the refusal as a CertenError, like everything else', () => {
    try {
      new CertenClient({ baseUrl: 'http://127.0.0.1:9' });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(CertenError);
      expect((err as CertenError).code).toBe('NO_CREDENTIAL');
    }
  });
});
