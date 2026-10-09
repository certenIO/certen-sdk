import { describe, it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import {
  CertenError, CertenIntentFailedError, CertenProofNotAvailableError, CertenWaitTimeoutError,
} from '@certen.io/sdk';
import { EXIT } from '../src/errors.js';
import { emitFailure, resetOutput, setJsonMode } from '../src/output.js';

/**
 * `certen tx status --wait` against a gateway that walks an intent through a scripted sequence of statuses.
 *
 * `executed` is progress, not an end; `completed_unproven` ends the wait successfully and says what it is; `expired` is a failure;
 * and a wait that runs out names the last status it saw. Before, `completed_unproven` and `expired` were in neither list the SDK
 * consulted, so the CLI polled to its timeout and reported `still completed_unproven after ...`.
 *
 * Everything runs against a local stub gateway with a throwaway HOME. Fictional data only.
 */

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'index.js');
const run = promisify(execFile);

interface Stub { url: string; polls: () => number; close: () => Promise<void> }

async function gateway(script: Array<string | { status: string; [k: string]: unknown }>): Promise<Stub> {
  let i = 0;
  const server = http.createServer((req, res) => {
    const path = (req.url ?? '').split('?')[0];
    res.setHeader('content-type', 'application/json');
    if (req.method === 'GET' && path === '/v1/transaction/intent-1') {
      const step = script[Math.min(i++, script.length - 1)];
      const body = typeof step === 'string' ? { status: step } : step;
      res.end(JSON.stringify({ intent_id: 'intent-1', created_at: '2026-01-01T00:00:00Z', ...body }));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ code: 'NOT_FOUND', error: 'not stubbed' }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    polls: () => i,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); }),
  };
}

interface Run { stdout: string; stderr: string; code: number }

async function certen(args: string[], apiUrl: string): Promise<Run> {
  const home = mkdtempSync(join(tmpdir(), 'certen-wait-'));
  const env = { ...(process.env as Record<string, string>), HOME: home, USERPROFILE: home, CERTEN_API_URL: apiUrl, CERTEN_API_KEY: 'ck_live_test' };
  try {
    const { stdout, stderr } = await run(process.execPath, [CLI, ...args], { env, encoding: 'utf8', cwd: home });
    return { stdout, stderr, code: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: number };
    return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', code: e.code ?? -1 };
  }
}

const envelope = (stdout: string) => JSON.parse(stdout.trim()) as { ok: boolean; data?: any; error?: any };
const WAIT = ['tx', 'status', 'intent-1', '--wait', '--poll-interval', '0.05'];

describe('certen tx status --wait and the execution outcome states', () => {
  it('ends successfully at completed_unproven and keeps that status in the JSON', async () => {
    const g = await gateway(['submitted', 'executed', { status: 'completed_unproven', reason_code: 'execution_proof_unavailable' }]);
    try {
      const r = await certen(['--json', ...WAIT], g.url);
      expect(r.code).toBe(0);
      const env = envelope(r.stdout);
      expect(env.ok).toBe(true);
      expect(env.data).toMatchObject({ intent_id: 'intent-1', status: 'completed_unproven', reason_code: 'execution_proof_unavailable' });
      expect(g.polls()).toBe(3);
    } finally { await g.close(); }
  });

  it('says in plain words that the action executed and there is no proof, and does not suggest fetching one', async () => {
    const g = await gateway(['executed', 'completed_unproven']);
    try {
      const r = await certen([...WAIT], g.url);
      expect(r.code).toBe(0);
      const out = r.stdout + r.stderr; // progress is printed on stdout, hints on stderr
      expect(out).toContain('Status: executed. The action ran on its chain; its proof is still being produced.');
      expect(out).toContain('its proof can never be produced');
      expect(out).toContain('There is no proof to fetch or verify for this intent.');
      expect(out).not.toContain('certen proof get');
      expect(out).not.toMatch(/Still completed_unproven/);
    } finally { await g.close(); }
  });

  it('treats executed as progress and goes on to completed', async () => {
    const g = await gateway(['submitted', 'executed', 'executed', 'completed']);
    try {
      const r = await certen([...WAIT], g.url);
      expect(r.code).toBe(0);
      const out = r.stdout + r.stderr;
      expect(out).toContain('Status: submitted.');
      expect(out).toContain('Status: executed. The action ran on its chain');
      expect(out).toContain('Status: completed.');
      expect(out).toContain('Next: certen proof get');
      expect(g.polls()).toBe(4);
    } finally { await g.close(); }
  });

  it('fails an expired intent as TX_FAILED with its reason instead of waiting out the timeout', async () => {
    const g = await gateway(['submitted', { status: 'expired', reason_code: 'expired' }]);
    try {
      const r = await certen(['--json', ...WAIT], g.url);
      expect(r.code).toBe(1);
      const err = envelope(r.stdout).error;
      expect(err.code).toBe('TX_FAILED');
      expect(err.retryable).toBe(false);
      expect(err.details).toMatchObject({ intent_id: 'intent-1', reason_code: 'expired' });
      expect(g.polls()).toBe(2);
    } finally { await g.close(); }
  });

  it('on a timeout names the last status and class, exits 1, and is not retryable', async () => {
    const g = await gateway(['submitted', 'executed']);
    try {
      const r = await certen(['--json', 'tx', 'status', 'intent-1', '--wait', '--poll-interval', '0.05', '--timeout', '0.01'], g.url);
      expect(r.code).toBe(1);
      const err = envelope(r.stdout).error;
      expect(err.code).toBe('TX_WAIT_TIMEOUT');
      expect(err.retryable).toBe(false);
      expect(err.details).toMatchObject({ intent_id: 'intent-1', last_status: 'executed', last_class: 'executed', timeout_ms: 600 });
      expect(err.message).toMatch(/still executed after 600ms.*It may yet complete\. Check with: certen tx status intent-1/);
    } finally { await g.close(); }
  });

  it('names a status it does not recognise rather than calling it done or failed', async () => {
    const g = await gateway(['brand_new_state']);
    try {
      const r = await certen(['--json', 'tx', 'status', 'intent-1', '--wait', '--poll-interval', '0.05', '--timeout', '0.01'], g.url);
      expect(r.code).toBe(1);
      const err = envelope(r.stdout).error;
      expect(err.code).toBe('TX_WAIT_TIMEOUT');
      expect(err.details).toMatchObject({ last_status: 'brand_new_state', last_class: 'unknown' });
      expect(err.message).toContain('a status this client does not recognise');
    } finally { await g.close(); }
  });
});

describe('exit 3 means the gateway was not reached, and nothing else', () => {
  // `NETWORK_ERROR` and the typed wait/proof errors all carry status 0. Exit 3 promises "nothing was submitted, safe to retry",
  // which is false for an intent the gateway already holds; the old rule (any status 0) sent all of them to exit 3.
  const exitFor = (e: unknown): number => {
    resetOutput();
    setJsonMode(true);
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = (() => true) as typeof process.stdout.write;
    try { return emitFailure(e); } finally { process.stdout.write = write; resetOutput(); }
  };

  it('keeps NETWORK_ERROR at exit 3', () => {
    expect(exitFor(new CertenError('down', 0, 'NETWORK_ERROR'))).toBe(EXIT.UNREACHABLE);
  });

  it('sends the typed errors about an existing intent to exit 1, not 3', () => {
    expect(exitFor(new CertenWaitTimeoutError('t', 'i', 1000, 'executed', 'executed', {}))).toBe(EXIT.FAILED);
    expect(exitFor(new CertenIntentFailedError('f', 'i', 'expired', {}))).toBe(EXIT.FAILED);
    expect(exitFor(new CertenProofNotAvailableError('p', 'i', 'proof_pending', {}))).toBe(EXIT.FAILED);
  });

  it('does the same for any other coded status-0 error, which is a refusal and not an outage', () => {
    for (const code of ['NO_PROOF_ARTIFACT', 'NO_IDENTITY_ID', 'WAIT_TIMEOUT', 'FOREIGN_ORIGIN_URL']) {
      expect(exitFor(new CertenError('x', 0, code)), code).toBe(EXIT.FAILED);
    }
  });

  it('still treats a status-0 error with no code at all as unreachable', () => {
    expect(exitFor({ message: 'socket hang up', status: 0 })).toBe(EXIT.UNREACHABLE);
  });
});
