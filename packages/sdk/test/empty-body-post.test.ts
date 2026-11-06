/**
 * A request with no body carries no content type.
 *
 * The client set `Content-Type: application/json` on every request, so a POST with nothing to send (the gas drip) arrived as JSON with an empty body, which the gateway
 * answers with 400 "Request body is not valid JSON" before the route runs. `certen gas --drip` therefore failed with that message whatever the gateway was configured
 * to do, and when the drip was switched off (503 DRIP_DISABLED) the real reason never reached the caller. A request that does have a body is unchanged.
 */
import { describe, it, expect } from 'vitest';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import { CertenClient } from '../src/index.js';

interface Seen { method: string; path: string; contentType: string | null; contentLength: string | null; idempotencyKey: string | null; body: string }

async function gateway(reply: (n: number) => { status: number; body: unknown }) {
  const seen: Seen[] = [];
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    seen.push({
      method: req.method ?? 'GET',
      path: (req.url ?? '').split('?')[0]!,
      contentType: (req.headers['content-type'] as string | undefined) ?? null,
      contentLength: (req.headers['content-length'] as string | undefined) ?? null,
      idempotencyKey: (req.headers['idempotency-key'] as string | undefined) ?? null,
      body: raw,
    });
    const out = reply(seen.length);
    res.writeHead(out.status, { 'content-type': 'application/json' }).end(JSON.stringify(out.body));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { seen, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => server.close() };
}
const clientFor = (url: string) => new CertenClient({ apiKey: 'ck_live_test', baseUrl: url, maxRetries: 0 });
const ID = '11111111-2222-3333-4444-555555555555';

describe('a POST with no body', () => {
  it('sends no content type, so the gateway does not read an empty body as malformed JSON, and still carries its idempotency key', async () => {
    const gw = await gateway(() => ({ status: 200, body: { drip_id: 'd1', status: 'sent', chain: 'base-sepolia' } }));
    try {
      await clientFor(gw.url).identity.drip(ID, 'base-sepolia');
      expect(gw.seen).toHaveLength(1);
      expect(gw.seen[0]!.method).toBe('POST');
      expect(gw.seen[0]!.path).toBe(`/v1/identity/${ID}/chain-accounts/base-sepolia/drip`);
      expect(gw.seen[0]!.contentType).toBeNull();
      expect(gw.seen[0]!.body).toBe('');
      expect(gw.seen[0]!.idempotencyKey).toBeTruthy();
    } finally {
      gw.close();
    }
  });

  it('hands the caller the gateway\'s own reason when the drip is switched off (DRIP_DISABLED), not a malformed-body error', async () => {
    const gw = await gateway(() => ({ status: 503, body: { error: 'The gas drip is not enabled on this deployment.', code: 'DRIP_DISABLED' } }));
    try {
      await expect(clientFor(gw.url).identity.drip(ID, 'base-sepolia')).rejects.toMatchObject({ code: 'DRIP_DISABLED', status: 503 });
    } finally {
      gw.close();
    }
  });
});

describe('a POST with a body', () => {
  it('still sends it as JSON', async () => {
    const gw = await gateway(() => ({ status: 201, body: { governance_op_id: 'g1', status: 'pending' } }));
    try {
      await clientFor(gw.url).governance.create({ identity: 'acc://bot.acme', operations: [{ type: 'add_key', public_key_hash: 'ab'.repeat(32) }] });
      expect(gw.seen).toHaveLength(1);
      expect(gw.seen[0]!.contentType).toBe('application/json');
      expect(JSON.parse(gw.seen[0]!.body)).toMatchObject({ identity: 'acc://bot.acme' });
    } finally {
      gw.close();
    }
  });
});
