import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import { createHmac } from 'node:crypto';

/**
 * `certen webhooks sign | check-signature | check-delivery`.
 *
 * The gateway signs every delivery; these are the receiving end's tools. The properties worth pinning are the ones a script depends on:
 * the exit code says whether the signature held (0 / 1) or the invocation was wrong (2), `--json` is always exactly one envelope, the
 * two local commands need no API key and make no request, and the secret appears in no output and in no request — ever.
 *
 * Subprocess, per the rest of this suite: exit codes and stdout are properties of a process.
 */

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'index.js');
const HOME = mkdtempSync(join(tmpdir(), 'certen-wh-'));
const WORK = mkdtempSync(join(tmpdir(), 'certen-wh-work-'));

const SECRET = 'whsec_test_secret_0123456789';
const T0 = 1716624000;
// Pinned to what the gateway produces (see packages/sdk/test/webhook-signature.test.ts).
const DOC_BODY = '{"a":1,"b":"hello"}';
const DOC_SIGNATURE = 't=1716624000,v1=5b085ed362bf7b76234b8afa51a0f244985467e7ddc83947aa0f6b37fea5a5f8';

interface Run { stdout: string; stderr: string; code: number }

/**
 * The invariant behind every case in this file: whatever the command did — succeeded, failed verification, refused a usage error — the
 * secret is in neither stream. Checked on EVERY run rather than in one dedicated case, so a new code path cannot print it unnoticed.
 */
function noSecret(r: Run): Run {
  expect(r.stdout + r.stderr, 'the signing secret must never be printed').not.toContain(SECRET);
  return r;
}

function certen(args: string[], env: Record<string, string | undefined> = {}, input?: string): Run {
  const merged: Record<string, string | undefined> = {
    ...process.env, HOME, USERPROFILE: HOME,
    CERTEN_API_KEY: '', CERTEN_API_URL: 'http://127.0.0.1:9', CERTEN_WEBHOOK_SECRET: SECRET,
    ...env,
  };
  for (const k of Object.keys(merged)) if (merged[k] === undefined) delete merged[k];
  const r = spawnSync(process.execPath, [CLI, ...args], { env: merged as NodeJS.ProcessEnv, encoding: 'utf8', cwd: WORK, input });
  return noSecret({ stdout: r.stdout ?? '', stderr: r.stderr ?? '', code: r.status ?? -1 });
}

const execFileAsync = promisify(execFile);

/**
 * The same as `certen`, but asynchronous. A test that hosts a stub gateway IN this process must use this one: `spawnSync` blocks the event
 * loop the stub needs in order to answer, so the child waits for a reply that can never be served.
 */
async function certenAsync(args: string[], env: Record<string, string | undefined> = {}): Promise<Run> {
  const merged: Record<string, string | undefined> = {
    ...process.env, HOME, USERPROFILE: HOME,
    CERTEN_API_KEY: '', CERTEN_API_URL: 'http://127.0.0.1:9', CERTEN_WEBHOOK_SECRET: SECRET,
    ...env,
  };
  for (const k of Object.keys(merged)) if (merged[k] === undefined) delete merged[k];
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [CLI, ...args], { env: merged as NodeJS.ProcessEnv, encoding: 'utf8', cwd: WORK });
    return noSecret({ stdout, stderr, code: 0 });
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: number };
    return noSecret({ stdout: e.stdout ?? '', stderr: e.stderr ?? '', code: e.code ?? -1 });
  }
}

type Envelope = { ok: boolean; data?: Record<string, any>; error?: { code: string; message: string; retryable: boolean; next?: string; details?: Record<string, any> } };
function envelope(r: Run): Envelope {
  expect(r.stdout.trim().split('\n').length, `exactly one envelope on stdout:\n${r.stdout}`).toBe(1);
  return JSON.parse(r.stdout) as Envelope;
}

describe('certen webhooks sign', () => {
  it('reproduces the gateway\'s signature for the example in its guide, with no API key and no network', () => {
    const r = certen(['--json', 'webhooks', 'sign', '--payload', '{"b":"hello","a":1}', '--timestamp', String(T0)]);
    expect(r.code).toBe(0);
    const { ok, data } = envelope(r);
    expect(ok).toBe(true);
    expect(data).toMatchObject({ body: DOC_BODY, signature: DOC_SIGNATURE, timestamp: T0 });
    expect(data?.headers).toEqual({ 'Content-Type': 'application/json', 'X-Certen-Signature': DOC_SIGNATURE, 'X-Certen-Timestamp': String(T0) });
  });

  it('adds the event and delivery headers only when asked, and signs now by default', () => {
    const r = certen(['--json', 'webhooks', 'sign', '--payload', '{"a":1}', '--event', 'transaction.completed', '--delivery-id', 'd-1']);
    const { data } = envelope(r);
    expect(data?.headers).toMatchObject({ 'X-Certen-Event': 'transaction.completed', 'X-Certen-Delivery': 'd-1' });
    expect(Math.abs(Number(data?.timestamp) - Date.now() / 1000)).toBeLessThan(30);
  });

  it('reads the payload from a file or standard input, and canonicalizes it', () => {
    const f = join(WORK, 'payload.json');
    writeFileSync(f, '{\n  "z": 1,\n  "a": [ 2, { "y": 1, "b": 2 } ]\n}\n');
    expect(envelope(certen(['--json', 'webhooks', 'sign', '--payload-file', f])).data?.body).toBe('{"a":[2,{"b":2,"y":1}],"z":1}');
    expect(envelope(certen(['--json', 'webhooks', 'sign', '--payload-file', '-'], {}, '{"q": true}')).data?.body).toBe('{"q":true}');
  });

  it('prints the body and headers for a person, and never the secret', () => {
    const r = certen(['webhooks', 'sign', '--payload', '{"a":1}', '--timestamp', String(T0)]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('{"a":1}');
    expect(r.stdout).toContain('X-Certen-Signature: t=1716624000,v1=');
    expect(r.stdout + r.stderr).not.toContain(SECRET);
  });

  it('is a usage error (exit 2) without exactly one payload source, with invalid JSON, or with a bad timestamp', () => {
    for (const args of [[], ['--payload', '{}', '--payload-file', 'x'], ['--payload', '{nope'], ['--payload', '{}', '--timestamp', 'yesterday']]) {
      const r = certen(['--json', 'webhooks', 'sign', ...args]);
      expect(r.code, args.join(' ')).toBe(2);
      expect(envelope(r).ok).toBe(false);
    }
  });
});

describe('certen webhooks check-signature', () => {
  const check = (extra: string[], env: Record<string, string | undefined> = {}) =>
    certen(['--json', 'webhooks', 'check-signature', '--signature', DOC_SIGNATURE, '--body', DOC_BODY, '--now', String(T0), ...extra], env);

  it('exits 0 and reports the signature when it holds, with no API key and no network', () => {
    const r = check([]);
    expect(r.code).toBe(0);
    expect(envelope(r)).toEqual({ ok: true, data: { valid: true, timestamp: T0, age_seconds: 0, version: 'v1' } });
  });

  it('exits 1 with the reason in one envelope when the body was altered', () => {
    const r = certen(['--json', 'webhooks', 'check-signature', '--signature', DOC_SIGNATURE, '--body', '{"a":2,"b":"hello"}', '--now', String(T0)]);
    expect(r.code).toBe(1);
    const e = envelope(r);
    expect(e.ok).toBe(false);
    expect(e.error).toMatchObject({ code: 'WEBHOOK_SIGNATURE_INVALID', retryable: false, details: { reason: 'signature-mismatch' } });
  });

  it('says an authentic but old signature is old, and --now / --tolerance move the window', () => {
    const stale = certen(['--json', 'webhooks', 'check-signature', '--signature', DOC_SIGNATURE, '--body', DOC_BODY]);
    expect(stale.code).toBe(1);
    expect(envelope(stale).error?.details).toMatchObject({ reason: 'timestamp-outside-tolerance', timestamp: T0 });
    expect(check(['--tolerance', '10']).code).toBe(0);
    expect(certen(['--json', 'webhooks', 'check-signature', '--signature', DOC_SIGNATURE, '--body', DOC_BODY, '--now', String(T0 + 100), '--tolerance', '10']).code).toBe(1);
  });

  it('hashes a body file as bytes, and says so when the body was re-serialized', () => {
    const good = join(WORK, 'good.bin'); writeFileSync(good, DOC_BODY);
    expect(check(['--body-file', good]).code).toBe(2); // --body AND --body-file: exactly one is allowed
    const r1 = certen(['--json', 'webhooks', 'check-signature', '--signature', DOC_SIGNATURE, '--body-file', good, '--now', String(T0)]);
    expect(r1.code).toBe(0);

    const pretty = join(WORK, 'pretty.json'); writeFileSync(pretty, JSON.stringify(JSON.parse(DOC_BODY), null, 2));
    const r2 = certen(['--json', 'webhooks', 'check-signature', '--signature', DOC_SIGNATURE, '--body-file', pretty, '--now', String(T0)]);
    expect(r2.code).toBe(1);
    expect(envelope(r2).error?.details?.hint).toMatch(/re-serialized/);
  });

  it('reads the body from standard input', () => {
    const r = certen(['--json', 'webhooks', 'check-signature', '--signature', DOC_SIGNATURE, '--body-file', '-', '--now', String(T0)], {}, DOC_BODY);
    expect(r.code).toBe(0);
  });

  it('verifies bytes that are not UTF-8', () => {
    const raw = Buffer.from([0xff, 0xfe, 0x00, 0x80]);
    const f = join(WORK, 'raw.bin'); writeFileSync(f, raw);
    const sig = `t=${T0},v1=${createHmac('sha256', SECRET).update(Buffer.concat([Buffer.from(`${T0}.`), raw])).digest('hex')}`;
    expect(certen(['--json', 'webhooks', 'check-signature', '--signature', sig, '--body-file', f, '--now', String(T0)]).code).toBe(0);
  });

  describe('the secret', () => {
    it('is a usage error (exit 2) when unset or too short — never a verification against an empty key', () => {
      const unset = check([], { CERTEN_WEBHOOK_SECRET: undefined });
      expect(unset.code).toBe(2);
      expect(envelope(unset).error?.code).toBe('WEBHOOK_SECRET_REQUIRED');
      const short = check([], { CERTEN_WEBHOOK_SECRET: 'short' });
      expect(short.code).toBe(2);
      expect(envelope(short).error?.code).toBe('WEBHOOK_SECRET_INVALID');
    });

    it('can come from a file, whose single trailing newline is not part of it', () => {
      const f = join(WORK, 'secret.txt'); writeFileSync(f, `${SECRET}\n`);
      expect(check(['--secret-file', f], { CERTEN_WEBHOOK_SECRET: undefined }).code).toBe(0);
      const crlf = join(WORK, 'secret-crlf.txt'); writeFileSync(crlf, `${SECRET}\r\n`);
      expect(check(['--secret-file', crlf], { CERTEN_WEBHOOK_SECRET: undefined }).code).toBe(0);
      const missing = check(['--secret-file', join(WORK, 'nope.txt')], { CERTEN_WEBHOOK_SECRET: undefined });
      expect(missing.code).toBe(2);
      expect(envelope(missing).error?.code).toBe('SECRET_FILE_UNREADABLE');
    });

    it('is not accepted as a flag, so it never reaches a shell history or a process list', () => {
      const r = check(['--secret', SECRET]);
      expect(r.code).toBe(2);
    });

  });

  it('needs the signature and exactly one body source', () => {
    expect(certen(['--json', 'webhooks', 'check-signature', '--body', DOC_BODY]).code).toBe(2);
    expect(certen(['--json', 'webhooks', 'check-signature', '--signature', DOC_SIGNATURE]).code).toBe(2);
  });

  it('prints a plain verdict for a person', () => {
    const ok = certen(['webhooks', 'check-signature', '--signature', DOC_SIGNATURE, '--body', DOC_BODY, '--now', String(T0)]);
    expect(ok.code).toBe(0);
    expect(ok.stdout).toContain('Signature verified');
    const bad = certen(['webhooks', 'check-signature', '--signature', DOC_SIGNATURE, '--body', 'x', '--now', String(T0)]);
    expect(bad.code).toBe(1);
    expect(bad.stderr).toContain('does not match');
  });
});

describe('certen webhooks check-delivery', () => {
  const ID = 'c0ffee00-0000-4000-8000-000000000002';
  const sig = createHmac('sha256', SECRET).update(`${T0}.${DOC_BODY}`).digest('hex');
  const RECORD = {
    id: ID, event_type: 'transaction.completed', status: 'delivered', attempts: 1, response_status: 200,
    signature_version: 'v1', signature_hex: sig, signed_at_unix: T0, signed_canonical_payload: DOC_BODY,
  };

  interface Hit { method: string; url: string; headers: http.IncomingHttpHeaders; body: string }
  const open: Array<() => Promise<void>> = [];
  afterAll(async () => { await Promise.all(open.map((c) => c())); });

  async function gateway(status: number, body: unknown): Promise<{ url: string; hits: Hit[] }> {
    const hits: Hit[] = [];
    const server = http.createServer((req, res) => {
      let b = '';
      req.on('data', (c) => { b += c; });
      req.on('end', () => {
        hits.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body: b });
        res.statusCode = status; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(body));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    open.push(() => new Promise<void>((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); }));
    return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, hits };
  }

  const withGateway = (url: string, extra: Record<string, string | undefined> = {}) => ({ CERTEN_API_KEY: 'ck_live_test', CERTEN_API_URL: url, ...extra });

  it('confirms the secret signed the delivery, asking the gateway only for the delivery and never sending the secret', async () => {
    const g = await gateway(200, RECORD);
    const r = await certenAsync(['--json', 'webhooks', 'check-delivery', ID], withGateway(g.url));
    expect(r.code).toBe(0);
    expect(envelope(r).data).toEqual({ valid: true, delivery_id: ID, signed_at: T0, version: 'v1' });
    expect(g.hits).toHaveLength(1);
    expect(`${g.hits[0].method} ${g.hits[0].url}`).toBe(`GET /v1/webhooks/deliveries/${ID}`);
    expect(JSON.stringify(g.hits[0])).not.toContain(SECRET);
  });

  it('exits 1 and says the secret is not the one used when it is not', async () => {
    const g = await gateway(200, RECORD);
    const r = await certenAsync(['--json', 'webhooks', 'check-delivery', ID], withGateway(g.url, { CERTEN_WEBHOOK_SECRET: 'a-different-secret' }));
    expect(r.code).toBe(1);
    expect(envelope(r).error).toMatchObject({ code: 'WEBHOOK_SIGNATURE_INVALID', details: { reason: 'signature-mismatch', delivery_id: ID } });
    expect(envelope(r).error?.details?.hint).toMatch(/rotated|another endpoint/);
    expect(r.stdout + r.stderr).not.toContain('a-different-secret');
  });

  it('exits 1 with not-signed for a delivery that has not been attempted', async () => {
    const g = await gateway(200, { ...RECORD, signature_hex: null, signed_at_unix: null, signed_canonical_payload: null });
    const r = await certenAsync(['--json', 'webhooks', 'check-delivery', ID], withGateway(g.url));
    expect(r.code).toBe(1);
    expect(envelope(r).error?.details?.reason).toBe('not-signed');
  });

  it('refuses an unusable secret before contacting the gateway', async () => {
    const g = await gateway(200, RECORD);
    const r = await certenAsync(['--json', 'webhooks', 'check-delivery', ID], withGateway(g.url, { CERTEN_WEBHOOK_SECRET: undefined }));
    expect(r.code).toBe(2);
    expect(g.hits).toHaveLength(0);
  });

  it('exits 1 when the delivery is not found, like any other gateway refusal', async () => {
    const g = await gateway(404, { error: 'Webhook delivery not found', code: 'NOT_FOUND' });
    const r = await certenAsync(['--json', 'webhooks', 'check-delivery', ID], withGateway(g.url));
    expect(r.code).toBe(1);
    expect(envelope(r).error?.code).toBe('NOT_FOUND');
  });
});
