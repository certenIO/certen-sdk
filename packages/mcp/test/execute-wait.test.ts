import { describe, it, expect } from 'vitest';
import http from 'node:http';
import { CertenClient } from '@certen.io/sdk';
import { dispatch } from '../src/protocol.js';
import { createHandlers } from '../src/server.js';

/**
 * `certen_execute_wait` through the real JSON-RPC handlers, the real SDK and a stub gateway that walks an intent through a scripted
 * sequence of statuses. The tool returns the named outcome; it never reports an executed action as failed, and a failure or a
 * timeout comes back as a typed error with what the model needs to decide.
 */
const READ_ONLY = { CERTEN_API_KEY: 'ck_test' } as NodeJS.ProcessEnv;

async function gateway(script: Array<string | { status: string; [k: string]: unknown }>): Promise<{ url: string; close: () => Promise<void> }> {
  let i = 0;
  const srv = http.createServer((_req, res) => {
    const step = script[Math.min(i++, script.length - 1)];
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ intent_id: 'i1', ...(typeof step === 'string' ? { status: step } : step) }));
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${(srv.address() as { port: number }).port}`,
    close: () => new Promise<void>((r) => { srv.closeAllConnections?.(); srv.close(() => r()); }),
  };
}

async function callWait(url: string, args: Record<string, unknown>): Promise<{ isError: boolean; body: any }> {
  const client = new CertenClient({ apiKey: 'k', baseUrl: url, maxRetries: 0 });
  const res = await dispatch(
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'certen_execute_wait', arguments: args } },
    createHandlers({ env: READ_ONLY, client }),
  );
  const result = res?.result as { isError?: boolean; content: Array<{ text: string }> };
  return { isError: result.isError === true, body: JSON.parse(result.content[0].text) };
}

describe('certen_execute_wait returns the named state', () => {
  it('returns completed_unproven as its own outcome, not as an error and not as completed', async () => {
    const g = await gateway([{ status: 'completed_unproven', reason_code: 'execution_proof_unavailable' }]);
    try {
      const { isError, body } = await callWait(g.url, { intentId: 'i1' });
      expect(isError).toBe(false);
      expect(body.status).toBe('completed_unproven');
      expect(body.outcome).toEqual({
        status: 'completed_unproven', class: 'terminal_gas_only', terminal: true, outcome: 'completed_unproven', reason: 'execution_proof_unavailable',
      });
    } finally { await g.close(); }
  });

  it('returns completed with outcome completed', async () => {
    const g = await gateway(['completed']);
    try {
      const { body } = await callWait(g.url, { intentId: 'i1' });
      expect(body.outcome).toMatchObject({ outcome: 'completed', terminal: true, reason: null });
    } finally { await g.close(); }
  });

  it('accepts until: "executed" and returns the executed outcome while the proof is still pending', async () => {
    const g = await gateway(['submitted', 'executed', 'completed']);
    try {
      const { isError, body } = await callWait(g.url, { intentId: 'i1', until: 'executed' });
      expect(isError).toBe(false);
      expect(body.status).toBe('executed');
      expect(body.outcome).toMatchObject({ outcome: 'executed', terminal: false });
    } finally { await g.close(); }
  });

  it('rejects an until it does not know', async () => {
    const g = await gateway(['completed']);
    try {
      const { isError, body } = await callWait(g.url, { intentId: 'i1', until: 'proven' });
      expect(isError).toBe(true);
      expect(body.error.message).toMatch(/until must be "terminal" or "executed"/);
    } finally { await g.close(); }
  });

  it('reports an expired intent as INTENT_FAILED with its reason, as an error', async () => {
    const g = await gateway([{ status: 'expired', reason_code: 'expired' }]);
    try {
      const { isError, body } = await callWait(g.url, { intentId: 'i1' });
      expect(isError).toBe(true);
      expect(body.error).toMatchObject({ code: 'INTENT_FAILED', retryable: false, reason_code: 'expired' });
      expect(body.error.details).toBeUndefined(); // INTENT_FAILED carries its reason_code, not a details bag
    } finally { await g.close(); }
  });

  it('reports a timeout as WAIT_TIMEOUT with the last status seen, not retryable', async () => {
    // One poll fits in the budget (the tool uses the default interval), so the last status seen is the first one served.
    const g = await gateway(['executed']);
    try {
      const { isError, body } = await callWait(g.url, { intentId: 'i1', timeoutMs: 150 });
      expect(isError).toBe(true);
      expect(body.error).toMatchObject({ code: 'WAIT_TIMEOUT', status: 0, retryable: false });
      expect(body.error.details).toEqual({ intentId: 'i1', timeoutMs: 150, lastStatus: 'executed', lastClass: 'executed' });
      expect(body.error.message).toMatch(/the action executed; its proof is still being produced/);
    } finally { await g.close(); }
  });
});
