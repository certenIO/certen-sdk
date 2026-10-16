import { describe, it, expect } from 'vitest';
import http from 'node:http';
import { CertenClient, CertenError, CertenWaitTimeoutError } from '../src/index.js';

/**
 * `execute.wait()` with an AbortSignal: the Ctrl-C of a wait.
 *
 * A wait is minutes of polling for work the gateway is doing on its own. Stopping it must (a) take effect at once, not after the poll
 * interval, (b) never cancel the intent (it keeps running; the caller says how to pick it back up), and (c) be told apart from a
 * timeout, which means "ran out of time" and not "the person stopped". Without a signal nothing here may change.
 */

interface Gateway {
  url: string;
  requests: string[];
  /** Number of responses sent. */
  polls: () => number;
  close: () => Promise<void>;
}

/** Walks an intent through a scripted sequence of statuses (the last repeats). `hold` makes the gateway take its time over one answer. */
async function gateway(script: string[], hold?: { onRequest: (n: number, res: http.ServerResponse) => boolean }): Promise<Gateway> {
  const requests: string[] = [];
  let answered = 0;
  const server = http.createServer((req, res) => {
    requests.push(`${req.method} ${(req.url ?? '').split('?')[0]}`);
    if (hold?.onRequest(requests.length, res)) return; // the hook took the response and will answer (or not) itself
    const status = script[Math.min(answered++, script.length - 1)];
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ intent_id: 'i1', status }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}`, requests, polls: () => answered,
    close: () => new Promise<void>((r) => { server.closeAllConnections?.(); server.close(() => r()); }),
  };
}

const clientFor = (url: string): CertenClient => new CertenClient({ apiKey: 'k', baseUrl: url, maxRetries: 0 });

async function failure(p: Promise<unknown>): Promise<CertenError> {
  try { await p; } catch (e) { return e as CertenError; }
  throw new Error('expected the wait to throw');
}

describe('execute.wait() with a signal', () => {
  it('stops at once when aborted during the sleep between polls, not after the interval', async () => {
    const g = await gateway(['submitted']);
    try {
      const controller = new AbortController();
      const started = Date.now();
      const waiting = clientFor(g.url).execute.wait('i1', {
        // An interval no test would sit through: if the abort did not wake the sleep, this would hang past the test timeout.
        timeoutMs: 600_000, intervalMs: 300_000, signal: controller.signal,
        onPoll: () => { setTimeout(() => controller.abort(), 50); },
      });
      const err = await failure(waiting);
      expect(Date.now() - started).toBeLessThan(5_000);
      expect(err).toBeInstanceOf(CertenError);
      expect(err.code).toBe('WAIT_ABORTED');
      expect(err.status).toBe(0);
      expect(err.details).toEqual({ intent_id: 'i1', last_status: 'submitted' });
      expect(err.message).toMatch(/stopped waiting for intent i1 \(last status submitted\)\. The intent keeps running\./);
    } finally { await g.close(); }
  });

  it('does not cancel the intent: the only request ever made is the read of it', async () => {
    const g = await gateway(['submitted']);
    try {
      const controller = new AbortController();
      await failure(clientFor(g.url).execute.wait('i1', {
        timeoutMs: 600_000, intervalMs: 300_000, signal: controller.signal, onPoll: () => { controller.abort(); },
      }));
      expect(g.requests).toEqual(['GET /v1/transaction/i1']);
    } finally { await g.close(); }
  });

  it('throws before any request when the signal is already aborted', async () => {
    const g = await gateway(['completed']);
    try {
      const controller = new AbortController();
      controller.abort();
      const err = await failure(clientFor(g.url).execute.wait('i1', { timeoutMs: 5_000, intervalMs: 10, signal: controller.signal }));
      expect(err.code).toBe('WAIT_ABORTED');
      expect(err.details).toEqual({ intent_id: 'i1', last_status: null });
      expect(err.message).not.toMatch(/last status/);
      expect(g.requests).toEqual([]);
    } finally { await g.close(); }
  });

  it('stops a poll that is in flight, and says there was no status yet', async () => {
    let held: http.ServerResponse | undefined;
    const g = await gateway(['completed'], { onRequest: (_n, res) => { held = res; return true; } });
    try {
      const controller = new AbortController();
      const waiting = clientFor(g.url).execute.wait('i1', { timeoutMs: 600_000, intervalMs: 10, signal: controller.signal });
      // Wait until the gateway has the request and is sitting on it, then stop.
      for (let i = 0; i < 100 && g.requests.length === 0; i += 1) await new Promise((r) => setTimeout(r, 20));
      expect(g.requests).toHaveLength(1);
      const started = Date.now();
      controller.abort();
      const err = await failure(waiting);
      expect(Date.now() - started).toBeLessThan(5_000);
      expect(err.code).toBe('WAIT_ABORTED');
      expect(err.details).toEqual({ intent_id: 'i1', last_status: null });
      // The aborted request was not retried: still the one request.
      expect(g.requests).toHaveLength(1);
    } finally { held?.destroy(); await g.close(); }
  });

  it('is WAIT_ABORTED, not a timeout, when the stop arrives as the budget runs out', async () => {
    const g = await gateway(['processing']);
    try {
      const controller = new AbortController();
      const err = await failure(clientFor(g.url).execute.wait('i1', {
        timeoutMs: 300, intervalMs: 100, signal: controller.signal,
        onPoll: (() => { let n = 0; return () => { n += 1; if (n === 2) controller.abort(); }; })(),
      }));
      expect(err.code).toBe('WAIT_ABORTED');
      expect(err).not.toBeInstanceOf(CertenWaitTimeoutError);
    } finally { await g.close(); }
  });

  it('a signal that is never aborted changes nothing: the wait resolves with the terminal intent', async () => {
    const g = await gateway(['submitted', 'executed', 'completed']);
    try {
      const controller = new AbortController();
      const tx = await clientFor(g.url).execute.wait('i1', { timeoutMs: 5_000, intervalMs: 10, signal: controller.signal });
      expect(tx.status).toBe('completed');
      expect(g.polls()).toBe(3);
    } finally { await g.close(); }
  });

  it('without a signal behaves exactly as before: resolves at a terminal state, and times out with the timeout error', async () => {
    const done = await gateway(['submitted', 'executed', 'completed']);
    try {
      const tx = await clientFor(done.url).execute.wait('i1', { timeoutMs: 5_000, intervalMs: 10 });
      expect(tx.status).toBe('completed');
      expect(done.polls()).toBe(3);
    } finally { await done.close(); }

    const stuck = await gateway(['anchoring']);
    try {
      const err = await failure(clientFor(stuck.url).execute.wait('i1', { timeoutMs: 150, intervalMs: 20 }));
      expect(err).toBeInstanceOf(CertenWaitTimeoutError);
      expect(err.code).not.toBe('WAIT_ABORTED');
    } finally { await stuck.close(); }
  });

  it('reports the status it last saw, not an earlier one', async () => {
    const g = await gateway(['submitted', 'anchoring']);
    try {
      const controller = new AbortController();
      let n = 0;
      const err = await failure(clientFor(g.url).execute.wait('i1', {
        timeoutMs: 600_000, intervalMs: 20, signal: controller.signal,
        onPoll: () => { n += 1; if (n === 3) controller.abort(); },
      }));
      expect(err.details).toMatchObject({ last_status: 'anchoring' });
    } finally { await g.close(); }
  });
});
