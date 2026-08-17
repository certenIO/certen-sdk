import { describe, it, expect, afterAll } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { AddressInfo } from 'node:net';

/**
 * The four operations that had no client surface at all.
 *
 * Each one was reachable only by hand-rolling HTTP, and the coverage tool that was supposed to
 * notice missed them — one by matching a path inside a code comment, one by not following a helper
 * indirection, and `GET /v1/errors` by nobody checking after it was published. So these cases
 * assert reachability first: the command must issue the request, to the right path, with the right
 * method. A method that compiles and never calls anything is exactly the failure being fixed.
 *
 * The mnemonic cases carry the weight. That token is consumed atomically on first read, so a
 * command that requests it twice, or prints it somewhere it will be logged, destroys key material
 * with no recovery path. Both properties are asserted directly.
 *
 * Subprocess, per the rest of this suite: what matters here includes the exit code and what lands
 * on stdout, and both are properties of a process rather than of a function.
 */

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'index.js');
const HOME = mkdtempSync(join(tmpdir(), 'certen-p6-'));
const WORK = mkdtempSync(join(tmpdir(), 'certen-p6-work-'));

interface Hit { method: string; url: string; body: string }

interface Stub {
  url: string;
  hits: Hit[];
  close: () => Promise<void>;
}

type Handler = (req: http.IncomingMessage, res: http.ServerResponse, hits: Hit[]) => void;

async function stubGateway(handler: Handler): Promise<Stub> {
  const hits: Hit[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      hits.push({ method: req.method ?? '', url: req.url ?? '', body });
      try {
        handler(req, res, hits);
      } catch {
        res.statusCode = 500;
        res.end('{}');
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    hits,
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections?.();
      server.close(() => resolve());
    }),
  };
}

const run = promisify(execFile);

interface Run { stdout: string; stderr: string; code: number }

async function certen(args: string[], apiUrl?: string): Promise<Run> {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    HOME, USERPROFILE: HOME,
    CERTEN_API_KEY: 'ck_live_test',
    CERTEN_API_URL: apiUrl ?? 'http://127.0.0.1:9',
  };
  try {
    const { stdout, stderr } = await run(process.execPath, [CLI, ...args], {
      env, encoding: 'utf8', cwd: WORK,
    });
    return { stdout, stderr, code: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: number };
    return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', code: e.code ?? -1 };
  }
}

/**
 * The single `--json` envelope, unwrapped to its payload.
 *
 * `--json` emits exactly one `{ok, data}` object on stdout — asserting on the whole envelope would
 * mean every case repeats `.data`, and a case that forgets it passes against `undefined`.
 */
function soleJson(stdout: string): Record<string, unknown> {
  const trimmed = stdout.trim();
  expect(trimmed.length).toBeGreaterThan(0);
  const envelope = JSON.parse(trimmed) as { ok?: boolean; data?: Record<string, unknown> };
  expect(envelope.ok).toBe(true);
  return envelope.data ?? {};
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body));
}

const ID = '11111111-2222-3333-4444-555555555555';
const TOKEN = 'abcdefghijklmnopqrstuvwxyz012345';
const PHRASE = 'legal winner thank year wave sausage worth useful legal winner thank yellow';

const openStubs: Stub[] = [];
async function stub(handler: Handler): Promise<Stub> {
  const s = await stubGateway(handler);
  openStubs.push(s);
  return s;
}
afterAll(async () => { await Promise.all(openStubs.map((s) => s.close())); });

// ── The mnemonic: one read, ever ──────────────────────────────────────────────────────────────

describe('certen identity mnemonic', () => {
  it('reads the one-shot URL exactly once, and writes rather than prints', async () => {
    const s = await stub((_req, res) => {
      json(res, 200, { mnemonic: PHRASE, warning: 'Save this now.' });
    });

    const out = `${ID}-collect.txt`;
    const res = await certen(['identity', 'mnemonic', ID, TOKEN, '--out', out], s.url);

    expect(res.code).toBe(0);
    // Exactly one request. A retry on this endpoint cannot succeed and the first attempt already
    // consumed the token, so a client that retries turns a transient blip into lost key material.
    const reads = s.hits.filter((h) => h.url.includes('/mnemonic/'));
    expect(reads).toHaveLength(1);
    expect(reads[0].method).toBe('GET');
    expect(reads[0].url).toBe(`/v1/identity/${ID}/mnemonic/${TOKEN}`);

    // The phrase is on disk and NOT on stdout. Stdout is scrollback, CI logs, and whatever is
    // recording the session — all places a seed outlives its usefulness by years.
    const path = join(WORK, out);
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, 'utf8').trim()).toBe(PHRASE);
    expect(res.stdout).not.toContain(PHRASE);
    expect(res.stdout).toContain(out);
  });

  it('accepts the retrieval URL the create response actually returns', async () => {
    const s = await stub((_req, res) => { json(res, 200, { mnemonic: PHRASE }); });

    // What a caller holds is `mnemonic_retrieval.url` — a path, not an id and a token. Requiring
    // them to split it themselves is asking them to get a one-shot credential right by hand.
    const res = await certen(
      ['identity', 'mnemonic', `/v1/identity/${ID}/mnemonic/${TOKEN}`, '--out', 'from-url.txt'],
      s.url,
    );

    expect(res.code).toBe(0);
    expect(s.hits[0].url).toBe(`/v1/identity/${ID}/mnemonic/${TOKEN}`);
    expect(readFileSync(join(WORK, 'from-url.txt'), 'utf8').trim()).toBe(PHRASE);
  });

  it('gives the value to a machine consumer that asked for JSON', async () => {
    const s = await stub((_req, res) => { json(res, 200, { mnemonic: PHRASE }); });

    const res = await certen(['identity', 'mnemonic', ID, TOKEN, '--json'], s.url);

    expect(res.code).toBe(0);
    expect(soleJson(res.stdout).mnemonic).toBe(PHRASE);
  });

  it('fails without spending a request when the target is not a retrieval URL', async () => {
    const s = await stub((_req, res) => { json(res, 200, { mnemonic: PHRASE }); });

    const res = await certen(['identity', 'mnemonic', 'https://example.com/nope'], s.url);

    expect(res.code).not.toBe(0);
    expect(s.hits).toHaveLength(0);
  });

  it('surfaces a consumed token as a failure, not as an empty success', async () => {
    const s = await stub((_req, res) => {
      json(res, 404, { error: 'Not Found', code: 'NOT_FOUND', message: 'Retrieval token not found, already used, or expired' });
    });

    const res = await certen(['identity', 'mnemonic', ID, TOKEN], s.url);

    // Exiting 0 here would let a provisioning script believe it had collected a seed it never got.
    expect(res.code).not.toBe(0);
  });
});

// ── The error catalogue ───────────────────────────────────────────────────────────────────────

const CATALOGUE = {
  errors: [
    { code: 'PLAN_QUOTA_EXCEEDED', status: 429, retryable: false, audience: 'caller', meaning: 'Plan quota exhausted.', action: 'Upgrade the plan.' },
    { code: 'BAD_GATEWAY', status: 502, retryable: true, audience: 'platform', meaning: 'A downstream service failed.' },
  ],
};

describe('certen errors', () => {
  it('reads the catalogue from the live gateway', async () => {
    const s = await stub((_req, res) => { json(res, 200, CATALOGUE); });

    const res = await certen(['errors', '--json'], s.url);

    expect(res.code).toBe(0);
    // The point is the LIVE gateway, not the vendored copy: a deployment ahead of this SDK raises
    // codes the local file has never heard of, and those are exactly the ones worth asking about.
    expect(s.hits.some((h) => h.method === 'GET' && h.url === '/v1/errors')).toBe(true);
    expect((soleJson(res.stdout).errors as unknown[]).length).toBe(2);
  });

  it('explains a single code, including whether retrying can work', async () => {
    const s = await stub((_req, res) => { json(res, 200, CATALOGUE); });

    const res = await certen(['errors', 'plan_quota_exceeded'], s.url);

    expect(res.code).toBe(0);
    expect(res.stdout).toContain('PLAN_QUOTA_EXCEEDED');
    expect(res.stdout).toContain('will not help');
    expect(res.stdout).toContain('Upgrade the plan.');
  });

  it('says a platform-side code is not the caller\'s to fix', async () => {
    const s = await stub((_req, res) => { json(res, 200, CATALOGUE); });

    const res = await certen(['errors', 'BAD_GATEWAY'], s.url);

    expect(res.stdout).toContain('can succeed');
    expect(res.stdout).toContain('Nothing in your request changes this');
  });

  it('rejects a code this gateway does not raise', async () => {
    const s = await stub((_req, res) => { json(res, 200, CATALOGUE); });

    const res = await certen(['errors', 'NOT_A_REAL_CODE'], s.url);

    expect(res.code).not.toBe(0);
  });
});

// ── Reading a quote back ──────────────────────────────────────────────────────────────────────

const QUOTE = (status: string, expiresAt: string) => ({
  quote_id: 'q_123', sku: 'identity.provision', chain: 'base-sepolia',
  proof_class: 'on_cadence', leg_count: 1,
  platform_fee_usd: '0.250000', gas_usd: '0.010000',
  total_usd: '0.260000', max_total_usd: '0.300000',
  expires_at: expiresAt, status,
});

describe('certen quote --id', () => {
  it('reads an existing quote instead of issuing a new one', async () => {
    const s = await stub((_req, res) => {
      json(res, 200, QUOTE('active', new Date(Date.now() + 600_000).toISOString()));
    });

    const res = await certen(['quote', '--id', 'q_123', '--json'], s.url);

    expect(res.code).toBe(0);
    // A GET, not a POST. Reading a quote back must not consume a fresh one — that is the whole
    // reason someone reaches for this instead of asking again.
    expect(s.hits[0].method).toBe('GET');
    expect(s.hits[0].url).toBe('/v1/quote/q_123');
    expect(soleJson(res.stdout).quote_id).toBe('q_123');
  });

  it('says plainly when the price can still be used', async () => {
    const s = await stub((_req, res) => {
      json(res, 200, QUOTE('active', new Date(Date.now() + 600_000).toISOString()));
    });

    const res = await certen(['quote', '--id', 'q_123'], s.url);

    expect(res.stderr).toContain('Lock this price');
  });

  it('says plainly when it has been spent', async () => {
    const s = await stub((_req, res) => {
      json(res, 200, QUOTE('consumed', new Date(Date.now() + 600_000).toISOString()));
    });

    const res = await certen(['quote', '--id', 'q_123'], s.url);

    // "Still valid?" is the question this command exists to answer, so it is answered rather than
    // left as a status string for the reader to interpret.
    expect(res.stdout).toContain('can no longer be used');
    expect(res.stderr).not.toContain('Lock this price');
  });

  it('says plainly when it has expired, even while its status still reads active', async () => {
    const s = await stub((_req, res) => {
      json(res, 200, QUOTE('active', new Date(Date.now() - 60_000).toISOString()));
    });

    const res = await certen(['quote', '--id', 'q_123'], s.url);

    expect(res.stdout).toContain('Expired at');
    expect(res.stderr).not.toContain('Lock this price');
  });

  it('refuses --id together with --chain rather than silently ignoring one', async () => {
    const s = await stub((_req, res) => { json(res, 200, QUOTE('active', new Date().toISOString())); });

    const res = await certen(['quote', '--id', 'q_123', '--chain', 'base-sepolia'], s.url);

    expect(res.code).not.toBe(0);
    expect(s.hits).toHaveLength(0);
  });
});

// ── OAuth clients ─────────────────────────────────────────────────────────────────────────────

describe('certen oauth-clients', () => {
  it('lists from the moved path, not the old admin one', async () => {
    const s = await stub((_req, res) => {
      json(res, 200, {
        clients: [{
          id: 'c1', client_id: 'cid_1', org_id: 'o1', scopes: ['proof:read'],
          is_active: true, created_at: '2026-01-01T00:00:00Z',
        }],
      });
    });

    const res = await certen(['oauth-clients', 'list', '--json'], s.url);

    expect(res.code).toBe(0);
    // The rows are org-scoped and always were, so this is a customer capability that merely lived
    // on the admin surface — the same misfiling webhooks had.
    expect(s.hits[0].url).toBe('/v1/oauth-clients');
    expect((soleJson(res.stdout).clients as unknown[]).length).toBe(1);
  });

  it('shows a new client secret once, with the warning, and never in the JSON table', async () => {
    const s = await stub((_req, res) => {
      json(res, 201, {
        client_id: 'cid_new', client_secret: 'cs_supersecret',
        org_id: 'o1', scopes: ['proof:read'],
      });
    });

    const res = await certen(['oauth-clients', 'create', '--scopes', 'proof:read'], s.url);

    expect(res.code).toBe(0);
    expect(s.hits[0].method).toBe('POST');
    expect(JSON.parse(s.hits[0].body).scopes).toEqual(['proof:read']);
    expect(res.stdout).toContain('cs_supersecret');
    expect(res.stdout).toContain('SAVE THIS NOW');
    // Shown once, deliberately, and NOT as a table row. The table is the part that gets piped into
    // a file or a log by whoever is scripting around this; the announcement is a one-time notice
    // aimed at a person. A secret rendered as a field is a secret nobody notices they kept.
    expect(res.stdout).not.toMatch(/^client_secret\s/m);
    expect(res.stdout).toMatch(/^client_id\s/m);
  });

  it('gives a JSON consumer the secret it explicitly asked for', async () => {
    const s = await stub((_req, res) => {
      json(res, 201, { client_id: 'cid_new', client_secret: 'cs_supersecret', org_id: 'o1', scopes: [] });
    });

    const res = await certen(['oauth-clients', 'create', '--scopes', 'proof:read', '--json'], s.url);

    expect(soleJson(res.stdout).client_secret).toBe('cs_supersecret');
  });

  it('explains what the grace window means on a rotation', async () => {
    const s = await stub((_req, res) => {
      json(res, 200, {
        client_id: 'cid_1', client_secret: 'cs_rotated',
        grace_seconds: 300, previous_secret_expires_at: '2026-01-01T00:05:00Z',
      });
    });

    const res = await certen(['oauth-clients', 'rotate-secret', 'c1', '--grace', '300'], s.url);

    expect(res.code).toBe(0);
    expect(s.hits[0].url).toBe('/v1/oauth-clients/c1/rotate-secret');
    expect(JSON.parse(s.hits[0].body).grace_seconds).toBe(300);
    expect(res.stdout).toContain('previous secret keeps working for 300s');
    // Rotating twice before the deploy lands strands the fleet on a secret that is already dead.
    expect(res.stdout).toContain('Do not run this again');
  });

  it('warns that an immediate cutover is already failing', async () => {
    const s = await stub((_req, res) => {
      json(res, 200, { client_id: 'cid_1', client_secret: 'cs_rotated', grace_seconds: 0 });
    });

    const res = await certen(['oauth-clients', 'rotate-secret', 'c1', '--grace', '0'], s.url);

    expect(res.stdout).toContain('previous secret is dead already');
  });

  it('says that removal revokes live tokens, and points at the gentler option', async () => {
    const s = await stub((_req, res) => { res.statusCode = 204; res.end(); });

    const res = await certen(['oauth-clients', 'remove', 'c1'], s.url);

    expect(res.code).toBe(0);
    expect(s.hits[0].method).toBe('DELETE');
    expect(res.stdout).toContain('revoked');
    expect(res.stdout).toContain('rotate-secret');
  });
});
