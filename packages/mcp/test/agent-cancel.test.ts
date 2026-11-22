import { describe, it, expect } from 'vitest';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { CertenClient, cancelByRejectVote, ed25519Signer, SEAT_RECORD_STATEMENT } from '@certen.io/sdk';
import { dispatch } from '../src/protocol.js';
import { createHandlers } from '../src/server.js';
import { ALL_TOOLS } from '../src/tools.js';
import { honestCosign } from '../../sdk/test/helpers/honest-gateway.js';

/**
 * AGT-F135: certen_agent_cancel_by_reject_vote is the SDK's cancel by reject vote without the key (the server signs nothing). It names the agent
 * it cancels for (`subject`, required) and returns the SAME seat record as the SDK's cancelByRejectVote: the form the named person submits at the
 * seat (POST /agents/interventions), `recordedAtSeat: false` and the statement that the act is in the seat's decision log only once it is submitted.
 * FICTIONAL parties and throwaway keys.
 */
const ENV = { CERTEN_API_KEY: 'k', CERTEN_MCP_ALLOW_WRITES: '1' } as NodeJS.ProcessEnv;
const PRINCIPAL = 'acc://harbor-mfg.acme';
const OFFICER = `${PRINCIPAL}/officers/1`;
const AGENT = 'acc://agent-7.harbor-mfg.acme';
const WHO = { seat: 'seat:harbor-supervisor', reason: 'Agent compromised in the lab drill; cancelling its payment.' };
const real = JSON.parse(readFileSync(new URL('../../verify/test/fixtures/signing-vectors.json', import.meta.url), 'utf8')).vectors.find((v: any) => v.label === 'four-leg');
const TX = String(real.txid).match(/[0-9a-f]{64}/)![0];

async function gatewayFor(publicKey: string) {
  const seen: string[] = [];
  const srv = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      seen.push(`${req.method} ${req.url}`);
      const out = req.url === '/v1/sign' ? honestCosign(real, { publicKey, signer: OFFICER, vote: 'reject' }) : { status: 200, body: { status: 'submitted' } };
      res.writeHead(out.status ?? 200, { 'content-type': 'application/json' }).end(JSON.stringify(out.body));
    });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
  return { seen, client: new CertenClient({ apiKey: 'k', baseUrl: url, maxRetries: 0 }), close: () => { srv.closeAllConnections?.(); srv.close(); } };
}

async function call(client: CertenClient, args: Record<string, unknown>) {
  const res = await dispatch({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'certen_agent_cancel_by_reject_vote', arguments: { confirm: true, ...args } } }, createHandlers({ env: ENV, client }));
  const r = res?.result as { isError?: boolean; content: { text: string }[] };
  return { isError: r.isError === true, body: JSON.parse(r.content[0].text) };
}

describe('AGT-F135: certen_agent_cancel_by_reject_vote returns the seat record', () => {
  it('requires subject (the agent ADI) in its input schema', () => {
    const tool = ALL_TOOLS.find((t) => t.name === 'certen_agent_cancel_by_reject_vote')!;
    expect(tool.inputSchema.required).toContain('subject');
    expect(Object.keys(tool.inputSchema.properties)).toContain('subject');
  });

  it('returns seatRecord (act reject, the agent, the seat, the reason, the pending transaction), recordedAtSeat false and the statement; signs nothing', async () => {
    const key = ed25519Signer();
    const gw = await gatewayFor(key.publicKey);
    try {
      const { isError, body } = await call(gw.client, { txHash: real.txid, identity: PRINCIPAL, subject: AGENT, signerUrl: OFFICER, publicKey: key.publicKey, ...WHO });
      expect(isError, JSON.stringify(body)).toBe(false);
      expect(body.seatRecord).toEqual({ act: 'reject', subject: AGENT, seat: WHO.seat, reason: WHO.reason, txHash: TX });
      expect([body.recordedAtSeat, body.seatRecordStatement]).toEqual([false, SEAT_RECORD_STATEMENT]);
      expect(body.signing).toBeDefined();
      expect(gw.seen.filter((r) => r.endsWith('/signature'))).toEqual([]);
    } finally { gw.close(); }
  });

  it('is the same seat record the SDK\'s cancelByRejectVote returns for the same act (one implementation)', async () => {
    const key = ed25519Signer();
    const gw = await gatewayFor(key.publicKey);
    try {
      const { body } = await call(gw.client, { txHash: real.txid, identity: PRINCIPAL, subject: AGENT, signerUrl: OFFICER, publicKey: key.publicKey, ...WHO });
      const sdk = await cancelByRejectVote(gw.client, { identity: PRINCIPAL, subject: AGENT, txHash: real.txid, signerUrl: OFFICER, signer: key, ...WHO });
      expect(body.seatRecord).toEqual(sdk.seatRecord);
      expect(body.seatRecordStatement).toBe(sdk.seatRecordStatement);
    } finally { gw.close(); }
  });

  it('without subject, or with a subject that is not an agent ADI: refused, no request', async () => {
    const key = ed25519Signer();
    const gw = await gatewayFor(key.publicKey);
    try {
      for (const subject of [undefined, `${AGENT}/book/1`]) {
        const { isError } = await call(gw.client, { txHash: real.txid, identity: PRINCIPAL, ...(subject ? { subject } : {}), signerUrl: OFFICER, publicKey: key.publicKey, ...WHO });
        expect(isError, String(subject)).toBe(true);
      }
      expect(gw.seen).toEqual([]);
    } finally { gw.close(); }
  });
});
