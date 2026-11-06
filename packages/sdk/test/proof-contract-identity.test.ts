import { describe, it, expect } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { CertenClient, CertenError } from '../src/index.js';

/** `proof.contractIdentity`: it asks the route the gateway documents, with the proof id encoded as one path segment, and returns the members as sent. */
async function serve(handler: (req: http.IncomingMessage, res: http.ServerResponse) => void) {
  const asked: string[] = [];
  const server = http.createServer((req, res) => {
    asked.push(`${req.method} ${req.url}`);
    handler(req, res);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    asked,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

describe('proof.contractIdentity', () => {
  it('reads GET /v1/proof/{id}/contract-identity and returns what the gateway sent', async () => {
    const state = { state: 'recorded', leg: 0, digest: 'ab'.repeat(32), member: { kind: 'x' } };
    const s = await serve((_req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(state));
    });
    try {
      const out = await new CertenClient({ apiKey: 'ck_live_x', baseUrl: s.url, maxRetries: 0 }).proof.contractIdentity('proof_1');
      expect(s.asked).toEqual(['GET /v1/proof/proof_1/contract-identity']);
      expect(out).toEqual(state);
    } finally {
      await s.close();
    }
  });

  it('keeps a proof id with a slash in it to one path segment', async () => {
    const s = await serve((_req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end('{"state":"absent"}');
    });
    try {
      await new CertenClient({ apiKey: 'ck_live_x', baseUrl: s.url, maxRetries: 0 }).proof.contractIdentity('a/b');
      expect(s.asked).toEqual(['GET /v1/proof/a%2Fb/contract-identity']);
    } finally {
      await s.close();
    }
  });

  it('reports the gateway error code when the proof service cannot be read', async () => {
    const s = await serve((_req, res) => {
      res.statusCode = 502;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ code: 'CONTRACT_IDENTITY_UNAVAILABLE', error: 'the proof service could not be read' }));
    });
    try {
      const err = await new CertenClient({ apiKey: 'ck_live_x', baseUrl: s.url, maxRetries: 0 }).proof.contractIdentity('proof_1').catch((e: unknown) => e);
      expect(err).toBeInstanceOf(CertenError);
      expect((err as CertenError).status).toBe(502);
      expect((err as CertenError).code).toBe('CONTRACT_IDENTITY_UNAVAILABLE');
    } finally {
      await s.close();
    }
  });
});
