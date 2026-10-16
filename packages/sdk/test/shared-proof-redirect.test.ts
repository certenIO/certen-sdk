import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { CertenError, CertenForeignOriginError, fetchSharedProof } from '../src/index.js';

/**
 * `fetchSharedProof` stays on the origin it was pointed at.
 *
 * It sends no credential (the endpoint takes none: the person a link is for has no CERTEN relationship), so a redirect could never leak a key. What it could do is
 * carry the request somewhere nobody chose: a host that was allowed (by a server's operator, or by a person typing a link) answering 302 to an address on the
 * network behind it. The authenticated client has refused a redirect off its own origin since RB7b; the standalone redeemer follows the same rule now, so "this
 * origin" means this origin all the way through. A same-origin redirect (a trailing slash, a moved path) still works.
 *
 * Real localhost listeners; nothing is mocked.
 */

async function listen(handler: (req: http.IncomingMessage, res: http.ServerResponse) => void) {
  const hits: string[] = [];
  const server = http.createServer((req, res) => { hits.push(`${req.method} ${req.url}`); handler(req, res); });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  return {
    hits,
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => new Promise<void>((r) => { server.closeAllConnections?.(); server.close(() => r()); }),
  };
}

const SHARED = { proof_id: 'p1', shared: true, expires_at: '2030-01-01T00:00:00Z', view_count: 1, bundle: { bundle_id: 'b1', proof_components: {} } };
const json = (res: http.ServerResponse, body: unknown): void => void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));

describe('fetchSharedProof and redirects', () => {
  it('follows a redirect that stays on the same origin', async () => {
    const a = await listen((req, res) => {
      if (req.url === '/v1/proof/shared/old') return void res.writeHead(302, { location: '/v1/proof/shared/new' }).end();
      json(res, SHARED);
    });
    try {
      const got = await fetchSharedProof(`${a.url}/v1/proof/shared/old`);
      expect(got.proof_id).toBe('p1');
      expect(a.hits).toEqual(['GET /v1/proof/shared/old', 'GET /v1/proof/shared/new']);
    } finally { await a.close(); }
  });

  it('refuses a redirect to another origin, names it, and never contacts it', async () => {
    const elsewhere = await listen((_req, res) => json(res, SHARED));
    const a = await listen((_req, res) => void res.writeHead(302, { location: `${elsewhere.url}/v1/proof/shared/landed` }).end());
    try {
      const err = await fetchSharedProof(`${a.url}/v1/proof/shared/tok`).then(() => null, (e: unknown) => e as CertenForeignOriginError);
      expect(err).toBeInstanceOf(CertenForeignOriginError);
      expect(err!.code).toBe('FOREIGN_ORIGIN_URL');
      expect(err!.status).toBe(0);
      expect(err!.message).toContain(new URL(elsewhere.url).origin);
      expect(err!.source).toBe('redirect');
      expect(elsewhere.hits).toEqual([]);
    } finally { await a.close(); await elsewhere.close(); }
  });

  it('is not a retryable network failure: a host that redirects away will do it again', async () => {
    const elsewhere = await listen((_req, res) => json(res, SHARED));
    const a = await listen((_req, res) => void res.writeHead(307, { location: `${elsewhere.url}/x` }).end());
    try {
      const err = await fetchSharedProof(`${a.url}/v1/proof/shared/tok`).then(() => null, (e: unknown) => e as CertenError);
      expect(err!.isRetryable).toBe(false);
      expect(err!.code).not.toBe('NETWORK_ERROR');
    } finally { await a.close(); await elsewhere.close(); }
  });

  it('applies to a bare token with an explicit gateway too', async () => {
    const elsewhere = await listen((_req, res) => json(res, SHARED));
    const a = await listen((_req, res) => void res.writeHead(302, { location: `${elsewhere.url}/x` }).end());
    try {
      await expect(fetchSharedProof('cps_tok', { baseUrl: a.url })).rejects.toMatchObject({ code: 'FOREIGN_ORIGIN_URL' });
      expect(elsewhere.hits).toEqual([]);
    } finally { await a.close(); await elsewhere.close(); }
  });

  it('an ordinary answer still works, and an ordinary 410 is still the named "ask for a new link"', async () => {
    const ok = await listen((_req, res) => json(res, SHARED));
    const gone = await listen((_req, res) => void res.writeHead(410, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'expired', code: 'SHARE_EXPIRED' })));
    try {
      expect((await fetchSharedProof(`${ok.url}/v1/proof/shared/t`)).proof_id).toBe('p1');
      await expect(fetchSharedProof(`${gone.url}/v1/proof/shared/t`)).rejects.toMatchObject({ status: 410, code: 'SHARE_EXPIRED' });
    } finally { await ok.close(); await gone.close(); }
  });
});
