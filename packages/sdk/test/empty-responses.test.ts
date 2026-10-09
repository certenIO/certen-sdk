import { describe, it, expect } from 'vitest';
import http from 'node:http';
import { CertenClient } from '../src/client.js';

/**
 * The gateway answers three DELETEs with 204 and no body: revoking an API key, removing a webhook endpoint, deactivating an OAuth client.
 *
 * `admin.revokeApiKey` was typed `{ success: boolean; message: string }` and `webhooks.remove` `{ deleted?: boolean; ... }`, and both
 * returned the empty body, which axios hands back as the empty string `""`. A caller reading `.success` got undefined and a tool that
 * needed an object (the MCP server's structured output) got a string. Fail-before is recorded in RUNLOG_RB7b (RB7b-F41): both returned `""`
 * on the previous build.
 */
async function noContentGateway(): Promise<{ client: CertenClient; seen: string[]; close: () => Promise<void> }> {
  const seen: string[] = [];
  const srv = http.createServer((req, res) => { seen.push(`${req.method} ${req.url}`); res.statusCode = 204; res.end(); });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  return {
    client: new CertenClient({ apiKey: 'k', baseUrl: `http://127.0.0.1:${(srv.address() as { port: number }).port}`, maxRetries: 0 }),
    seen,
    close: () => new Promise<void>((r) => { srv.closeAllConnections?.(); srv.close(() => r()); }),
  };
}

describe('methods whose gateway answer is 204 resolve an object that says what happened', () => {
  it('admin.revokeApiKey resolves { success: true }', async () => {
    const g = await noContentGateway();
    try {
      const out = await g.client.admin.revokeApiKey('key-1');
      expect(out).toEqual({ success: true });
      expect(g.seen).toEqual(['DELETE /v1/admin/api-keys/key-1']);
    } finally { await g.close(); }
  });

  it('webhooks.remove resolves { deleted: true }', async () => {
    const g = await noContentGateway();
    try {
      expect(await g.client.webhooks.remove('wh-1')).toEqual({ deleted: true });
      expect(g.seen).toEqual(['DELETE /v1/webhooks/endpoints/wh-1']);
    } finally { await g.close(); }
  });

  it('oauthClients.remove still resolves nothing (it was already typed void)', async () => {
    const g = await noContentGateway();
    try {
      expect(await g.client.oauthClients.remove('oc-1')).toBeUndefined();
    } finally { await g.close(); }
  });

  it('does not claim success when the gateway refuses: a failure still throws', async () => {
    const srv = http.createServer((_q, res) => { res.statusCode = 404; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ code: 'NOT_FOUND', error: 'no such key' })); });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    try {
      const client = new CertenClient({ apiKey: 'k', baseUrl: `http://127.0.0.1:${(srv.address() as { port: number }).port}`, maxRetries: 0 });
      await expect(client.admin.revokeApiKey('gone')).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 });
      await expect(client.webhooks.remove('gone')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    } finally {
      srv.closeAllConnections?.();
      await new Promise<void>((r) => srv.close(() => r()));
    }
  });
});
