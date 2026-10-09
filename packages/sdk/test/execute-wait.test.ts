import { describe, it, expect } from 'vitest';
import http from 'node:http';
import { CertenClient } from '../src/client.js';
import { CertenError, CertenIntentFailedError, CertenProofNotAvailableError, CertenWaitTimeoutError } from '../src/errors.js';
import { intentOutcome } from '../src/intent-states.js';

/**
 * `execute.wait()` against a gateway that walks an intent through a scripted sequence of statuses (the last one repeats).
 *
 * Fail-before, recorded in RUNLOG_RB7b: on the previous code `submitted -> executed -> completed_unproven` and
 * `submitted -> expired` both polled to the timeout and threw a plain Error with no code, because neither status was in either
 * of the two lists `wait()` consulted.
 */
async function gateway(script: Array<string | { status: string; [k: string]: unknown }>): Promise<{ url: string; polls: () => number; close: () => Promise<void> }> {
  let i = 0;
  const srv = http.createServer((_req, res) => {
    const step = script[Math.min(i++, script.length - 1)];
    const body = typeof step === 'string' ? { status: step } : step;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ intent_id: 'i1', ...body }));
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const port = (srv.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}`, polls: () => i, close: () => new Promise<void>((r) => srv.close(() => r())) };
}
const clientFor = (url: string): CertenClient => new CertenClient({ apiKey: 'k', baseUrl: url, maxRetries: 0 });
const FAST = { timeoutMs: 5_000, intervalMs: 10 };

describe('execute.wait() and the execution outcome states', () => {
  it('resolves at completed_unproven, naming it, instead of polling to the timeout', async () => {
    const g = await gateway(['submitted', 'executed', { status: 'completed_unproven', reason_code: 'execution_proof_unavailable' }]);
    try {
      const tx = await clientFor(g.url).execute.wait('i1', FAST);
      expect(tx.status).toBe('completed_unproven');
      expect(intentOutcome(tx)).toMatchObject({ outcome: 'completed_unproven', terminal: true, reason: 'execution_proof_unavailable' });
      expect(g.polls()).toBe(3);
    } finally { await g.close(); }
  });

  it('resolves at completed_unproven with the standard reason even when the gateway sent none', async () => {
    const g = await gateway(['completed_unproven']);
    try {
      const tx = await clientFor(g.url).execute.wait('i1', FAST);
      expect(intentOutcome(tx).reason).toBe('execution_proof_unavailable');
    } finally { await g.close(); }
  });

  it('treats executed as non-terminal: it keeps polling to completed and reports executed through onState', async () => {
    const g = await gateway(['submitted', 'submitted', 'executed', 'executed', 'completed']);
    try {
      const seen: Array<[string, string]> = [];
      const tx = await clientFor(g.url).execute.wait('i1', { ...FAST, onState: (e) => seen.push([e.status, e.class]) });
      expect(tx.status).toBe('completed');
      // once per CHANGE of status, with its class
      expect(seen).toEqual([['submitted', 'in_flight'], ['executed', 'executed'], ['completed', 'terminal_success']]);
      expect(g.polls()).toBe(5);
    } finally { await g.close(); }
  });

  it('accepts until: "executed" and returns as soon as the action has executed', async () => {
    const g = await gateway(['submitted', 'executed', 'completed']);
    try {
      const tx = await clientFor(g.url).execute.wait('i1', { ...FAST, until: 'executed' });
      expect(tx.status).toBe('executed');
      expect(g.polls()).toBe(2);
    } finally { await g.close(); }
  });

  it('with until: "executed" also returns a final state reached first, and still throws a failure', async () => {
    const done = await gateway(['completed']);
    const gone = await gateway(['submitted', 'expired']);
    try {
      expect((await clientFor(done.url).execute.wait('i1', { ...FAST, until: 'executed' })).status).toBe('completed');
      await expect(clientFor(gone.url).execute.wait('i1', { ...FAST, until: 'executed' })).rejects.toBeInstanceOf(CertenIntentFailedError);
    } finally { await done.close(); await gone.close(); }
  });

  it('rejects an until it does not know, before any request', async () => {
    const g = await gateway(['completed']);
    try {
      await expect(clientFor(g.url).execute.wait('i1', { until: 'proven' as never })).rejects.toThrow(/until.*'terminal' or 'executed'/);
      expect(g.polls()).toBe(0);
    } finally { await g.close(); }
  });

  it('throws CertenIntentFailedError for expired, with its reason, instead of polling to the timeout', async () => {
    const g = await gateway(['submitted', { status: 'expired', reason_code: 'expired', error_message: 'passed expires_at' }]);
    try {
      const err = await clientFor(g.url).execute.wait('i1', FAST).catch((e) => e);
      expect(err).toBeInstanceOf(CertenIntentFailedError);
      expect(err).toMatchObject({ code: 'INTENT_FAILED', intentId: 'i1', reasonCode: 'expired' });
      expect(err.message).toBe('certen: intent i1 expired (expired): passed expires_at');
      expect(g.polls()).toBe(2);
    } finally { await g.close(); }
  });

  it('still resolves completed, proven and the older delivered', async () => {
    for (const s of ['completed', 'proven', 'delivered']) {
      const g = await gateway([s]);
      try { expect((await clientFor(g.url).execute.wait('i1', FAST)).status).toBe(s); } finally { await g.close(); }
    }
  });

  it('still throws for failed and the older error', async () => {
    for (const s of ['failed', 'error']) {
      const g = await gateway([{ status: s, reason_code: 'target_reverted' }]);
      try { await expect(clientFor(g.url).execute.wait('i1', FAST)).rejects.toMatchObject({ code: 'INTENT_FAILED', reasonCode: 'target_reverted' }); } finally { await g.close(); }
    }
  });

  it('times out with a typed error carrying the last status, not a plain Error', async () => {
    const g = await gateway(['submitted', 'executed']);
    try {
      const err = await clientFor(g.url).execute.wait('i1', { timeoutMs: 250, intervalMs: 20 }).catch((e) => e);
      expect(err).toBeInstanceOf(CertenWaitTimeoutError);
      expect(err).toBeInstanceOf(CertenError);
      expect(err).toMatchObject({ code: 'WAIT_TIMEOUT', status: 0, intentId: 'i1', timeoutMs: 250, lastStatus: 'executed', lastClass: 'executed' });
      expect(err.details).toEqual({ intentId: 'i1', timeoutMs: 250, lastStatus: 'executed', lastClass: 'executed' });
      expect(err.transaction).toMatchObject({ status: 'executed' });
      expect(err.message).toBe('certen: intent i1 still executed after 250ms (the action executed; its proof is still being produced)');
      expect(err.isRetryable).toBe(false);
    } finally { await g.close(); }
  });

  it('keeps polling a status it does not recognise, and names it unknown if time runs out', async () => {
    const g = await gateway(['submitted', 'settling_soon']);
    try {
      const err = await clientFor(g.url).execute.wait('i1', { timeoutMs: 250, intervalMs: 20 }).catch((e) => e);
      expect(err).toBeInstanceOf(CertenWaitTimeoutError);
      expect(err).toMatchObject({ lastStatus: 'settling_soon', lastClass: 'unknown' });
      expect(err.message).toMatch(/still settling_soon after 250ms \(a status this client does not recognise\)/);
    } finally { await g.close(); }
  });

  it('times out with a null last status when no poll ever completed', async () => {
    const g = await gateway(['completed']);
    try {
      const err = await clientFor(g.url).execute.wait('i1', { timeoutMs: 0, intervalMs: 10 }).catch((e) => e);
      expect(err).toBeInstanceOf(CertenWaitTimeoutError);
      expect(err).toMatchObject({ lastStatus: null, lastClass: null });
      expect(err.message).toBe('certen: intent i1 still unknown after 0ms');
    } finally { await g.close(); }
  });
});

describe('execute.proof() when there is nothing to fetch', () => {
  const none = (status: string) => gateway([{ status }]);

  it('says the proof is still being produced for an executed intent', async () => {
    const g = await none('executed');
    try {
      const err = await clientFor(g.url).execute.proof('i1').catch((e) => e);
      expect(err).toBeInstanceOf(CertenProofNotAvailableError);
      expect(err).toMatchObject({ code: 'PROOF_NOT_ASSIGNED', status: 0, intentId: 'i1', reason: 'proof_pending' });
      expect(err.details).toEqual({ intentId: 'i1', reason: 'proof_pending' });
      expect(err.message).toMatch(/neither a proof_id nor an Accumulate transaction hash \(the action executed; its proof is still being produced\)/);
    } finally { await g.close(); }
  });

  it('says there is nothing to wait for on completed_unproven', async () => {
    const g = await none('completed_unproven');
    try {
      await expect(clientFor(g.url).execute.proof('i1')).rejects.toMatchObject({ code: 'PROOF_NOT_ASSIGNED', reason: 'execution_proof_unavailable' });
    } finally { await g.close(); }
  });

  it('says not_assigned for an intent that has not reached a state with a proof', async () => {
    const g = await none('submitted');
    try {
      const err = await clientFor(g.url).execute.proof('i1').catch((e) => e);
      expect(err).toMatchObject({ code: 'PROOF_NOT_ASSIGNED', reason: 'not_assigned' });
      expect(err.message).toBe('certen: intent i1 has neither a proof_id nor an Accumulate transaction hash');
      expect(err.transaction).toMatchObject({ status: 'submitted' });
    } finally { await g.close(); }
  });
});
