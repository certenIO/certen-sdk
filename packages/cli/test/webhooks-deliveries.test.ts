import { describe, it, expect, afterAll } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { AddressInfo } from 'node:net';

/**
 * `certen webhooks deliveries` and `certen webhooks list`, against a stub gateway that answers the way the real one does.
 *
 * Three things were wrong, each invisible until someone used the command to find out why an event had not arrived:
 *   - `--status` did not exist (the gateway has always filtered on it), so the only filter was applied to a page after it was fetched;
 *   - the reason a delivery failed was printed from `d.error`, a field the gateway has never sent (it sends `last_error`), so no
 *     failure reason was ever shown;
 *   - `webhooks list` read `verified`, which `register` and `verify` send but `list` does not (it sends `verified_at`), so every
 *     verified endpoint was printed UNVERIFIED.
 *
 * Asynchronous execFile throughout: a child started with spawnSync would block the event loop the in-process stub needs to answer.
 */

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'index.js');
const HOME = mkdtempSync(join(tmpdir(), 'certen-whd-'));
const WORK = mkdtempSync(join(tmpdir(), 'certen-whd-work-'));
const execFileAsync = promisify(execFile);

interface Run { stdout: string; stderr: string; code: number }
interface Hit { method: string; url: string }

async function certen(args: string[], url: string): Promise<Run> {
  const env = { ...process.env, HOME, USERPROFILE: HOME, CERTEN_API_KEY: 'ck_live_test', CERTEN_API_URL: url } as NodeJS.ProcessEnv;
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [CLI, ...args], { env, encoding: 'utf8', cwd: WORK });
    return { stdout, stderr, code: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: number };
    return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', code: e.code ?? -1 };
  }
}

const open: Array<() => Promise<void>> = [];
afterAll(async () => { await Promise.all(open.map((c) => c())); });

/** A gateway that answers every request with `body`, and remembers what it was asked. */
async function gateway(body: unknown): Promise<{ url: string; hits: Hit[] }> {
  const hits: Hit[] = [];
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      hits.push({ method: req.method ?? '', url: req.url ?? '' });
      res.statusCode = 200; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  open.push(() => new Promise<void>((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); }));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, hits };
}

type Envelope = { ok: boolean; data?: Record<string, any>; error?: { code: string; message: string; next?: string } };
function envelope(r: Run): Envelope {
  expect(r.stdout.trim().split('\n').length, `exactly one envelope on stdout:\n${r.stdout}`).toBe(1);
  return JSON.parse(r.stdout) as Envelope;
}

// What the gateway's list route returns: `SELECT *` rows, so last_error and dlq_at are present on every one.
const DLQ_ROW = {
  id: 'd-dlq', event_type: 'transaction.completed', status: 'dlq', attempts: 5, response_status: 503,
  last_error: 'Request failed with status code 503', dlq_at: '2026-11-01T10:00:00.000Z', created_at: '2026-11-01T09:00:00.000Z',
};
const PENDING_ROW = {
  id: 'd-pending', event_type: 'transaction.failed', status: 'pending', attempts: 2, response_status: null,
  last_error: 'connect ECONNREFUSED 10.0.0.9:443', dlq_at: null, created_at: '2026-11-01T09:30:00.000Z',
};
const DELIVERED_ROW = {
  id: 'd-ok', event_type: 'transaction.completed', status: 'delivered', attempts: 1, response_status: 200,
  last_error: null, dlq_at: null, created_at: '2026-11-01T09:45:00.000Z',
};
const page = (...deliveries: unknown[]) => ({ deliveries, pagination: { limit: 50, offset: 0, total: deliveries.length, has_more: false } });

describe('certen webhooks deliveries', () => {
  it('asks the gateway for the status, prints why the delivery failed, and says how to retry it', async () => {
    const g = await gateway(page(DLQ_ROW));
    const r = await certen(['webhooks', 'deliveries', '--status', 'dlq'], g.url);
    expect(r.code).toBe(0);
    expect(g.hits).toHaveLength(1);
    expect(g.hits[0].url).toBe('/v1/webhooks/deliveries?limit=50&offset=0&status=dlq');
    // the reason is `last_error` (this printed `d.error`, which the gateway has never sent, so it printed nothing)
    expect(r.stdout).toContain('Request failed with status code 503');
    expect(r.stdout).toContain('gave up after 5 attempts');
    expect(r.stdout).toContain('retry it: certen webhooks redeliver d-dlq');
  });

  it('carries last_error through --json as well, in one envelope', async () => {
    const g = await gateway(page(DLQ_ROW));
    const r = await certen(['--json', 'webhooks', 'deliveries', '--status', 'dlq'], g.url);
    expect(r.code).toBe(0);
    expect(envelope(r).data?.deliveries[0]).toMatchObject({ id: 'd-dlq', status: 'dlq', last_error: 'Request failed with status code 503' });
  });

  it('refuses a status the gateway would answer with an empty list, before any request', async () => {
    const g = await gateway(page());
    const r = await certen(['--json', 'webhooks', 'deliveries', '--status', 'DLQ'], g.url);
    expect(r.code).toBe(2);
    expect(g.hits).toHaveLength(0);
    const { ok, error } = envelope(r);
    expect(ok).toBe(false);
    expect(error).toMatchObject({ code: 'INVALID_VALUE', next: 'certen webhooks deliveries --help' });
    expect(error?.message).toContain('pending, delivered, failed, dlq');
  });

  it('refuses --status together with --failed, and --failed without a status still filters the page it fetched', async () => {
    const g = await gateway(page(PENDING_ROW, DELIVERED_ROW));
    const both = await certen(['--json', 'webhooks', 'deliveries', '--status', 'dlq', '--failed'], g.url);
    expect(both.code).toBe(2);
    expect(g.hits).toHaveLength(0);
    expect(envelope(both).error?.code).toBe('CONFLICTING_FLAGS');

    const failed = await certen(['webhooks', 'deliveries', '--failed'], g.url);
    expect(failed.code).toBe(0);
    expect(g.hits).toHaveLength(1);
    expect(g.hits[0].url).toBe('/v1/webhooks/deliveries?limit=50&offset=0');
    // the pending delivery stays (it did not succeed, yet) with its reason and no retry command (it retries by itself); the delivered one goes
    expect(failed.stdout).toContain('connect ECONNREFUSED');
    expect(failed.stdout).toContain('retrying on its own');
    expect(failed.stdout).not.toContain('redeliver d-pending');
    expect(failed.stdout).not.toContain('transaction.completed');
  });
});

describe('certen webhooks list', () => {
  it('reads verification from verified_at, which is what the list route sends, and says why an endpoint is off', async () => {
    const base = { event_types: ['transaction.completed'], description: null, is_active: true, created_at: '2026-10-01T00:00:00.000Z' };
    const g = await gateway({
      endpoints: [
        { ...base, id: 'e-verified', url: 'https://ok.example/hook', verified_at: '2026-10-01T00:01:00.000Z', last_success_at: '2026-11-01T08:00:00.000Z', consecutive_failures: 0 },
        { ...base, id: 'e-never', url: 'https://never.example/hook', verified_at: null, last_success_at: null, consecutive_failures: 0 },
        { ...base, id: 'e-off', url: 'https://off.example/hook', is_active: false, verified_at: '2026-10-01T00:01:00.000Z', last_success_at: '2026-10-30T08:00:00.000Z', consecutive_failures: 12 },
      ],
    });
    const r = await certen(['webhooks', 'list'], g.url);
    expect(r.code).toBe(0);
    const lines = r.stdout.split('\n');
    const stateOf = (id: string) => lines.find((l) => l.includes(id)) ?? '';
    // (this printed UNVERIFIED for all three)
    expect(stateOf('e-verified')).toContain('active, verified');
    expect(stateOf('e-never')).toContain('UNVERIFIED');
    expect(stateOf('e-off')).toContain('INACTIVE, verified');
    expect(r.stdout).toContain('12 failed attempts in a row; last success 2026-10-30 08:00:00');
  });
});
