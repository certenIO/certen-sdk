import { describe, it, expect } from 'vitest';
import http from 'node:http';
import { CertenClient } from '@certen.io/sdk';
import { dispatch } from '../src/protocol.js';
import { createHandlers } from '../src/server.js';
import { honestIntent } from '../../sdk/test/helpers/honest-gateway.js';

/**
 * certen_transaction_open returns what the signature would authorise, rebuilt from the transaction the gateway returned, or says that it could not be
 * checked and that the hash must not be signed. The server signs nothing either way.
 */
const ADI = 'acc://org.acme';
const TO = `0x${'be'.repeat(20)}`;
const ENV = { CERTEN_API_KEY: 'k', CERTEN_MCP_ALLOW_WRITES: '1' } as NodeJS.ProcessEnv;
const INTENT = { adiUrl: ADI, fromChain: 'accumulate', toChain: 'ethereum-sepolia', fromAddress: ADI, toAddress: TO, amount: '0.001' };

async function open(reply: (body: any) => Promise<{ status?: number; body: unknown }>) {
  const srv = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', async () => {
      if (req.url === '/v1/chains') { res.setHeader('content-type', 'application/json'); return void res.end(JSON.stringify({ chains: [{ id: 'ethereum-sepolia', chainId: 11155111 }] })); }
      const out = await reply(raw ? JSON.parse(raw) : {});
      res.writeHead(out.status ?? 201, { 'content-type': 'application/json' }).end(JSON.stringify(out.body));
    });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const url = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
    const client = new CertenClient({ apiKey: 'k', baseUrl: url, maxRetries: 0 });
    const res = await dispatch({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'certen_transaction_open', arguments: { identityId: 'id-1', intent: INTENT, confirm: true } } }, createHandlers({ env: ENV, client }));
    const r = res?.result as { isError?: boolean; content: { text: string }[] };
    return { isError: r.isError === true, body: JSON.parse(r.content[0].text) };
  } finally { srv.closeAllConnections?.(); srv.close(); }
}

describe('certen_transaction_open', () => {
  it('returns the intent with `signing`: what the signature would authorise', async () => {
    const { isError, body } = await open((b) => honestIntent(b));
    expect(isError).toBe(false);
    expect(body.signing_check).toBeUndefined();
    expect(body.signing.legs[0]).toMatchObject({ chainId: 11155111, valueWei: '1000000000000000', callDataBytes: 0 });
    expect(body.signing.text.join('\n')).toMatch(/You are about to sign/);
    expect(body.signing.hashes.toSign).toBe(body.signing_data.hash_to_sign);
  });

  it('says DO NOT SIGN, with the code, when the transaction does not match the request: the intent is still returned', async () => {
    const { isError, body } = await open(async (b) => {
      const h = await honestIntent(b);
      (h.body as any).signing_data.hash_to_sign = 'ab'.repeat(32);
      return h;
    });
    expect(isError).toBe(false);
    expect(body.intent_id).toBe('intent-1');
    expect(body.signing).toBeUndefined();
    expect(body.signing_check).toMatchObject({ ok: false, code: 'SIGNING_DATA_MISMATCH', details: { field: 'hash_to_sign' } });
  });

  it('says so when the gateway returned only a hash', async () => {
    const { body } = await open(async () => ({ body: { intent_id: 'i1', signing_mode: 'external', signing_data: { hash_to_sign: 'ab'.repeat(32) } } }));
    expect(body.signing_check).toMatchObject({ ok: false, code: 'SIGNING_DATA_ABSENT' });
  });

  it('describes the tool as a check the agent must read, and still holds no key', async () => {
    const { ALL_TOOLS } = await import('../src/tools.js');
    const t = ALL_TOOLS.find((x) => x.name === 'certen_transaction_open')!;
    expect(t.description).toMatch(/DO NOT SIGN/);
    expect(t.description).toMatch(/HOLDS NO KEY/);
  });
});
