import { describe, it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { AddressInfo } from 'node:net';

/**
 * `certen login` / `certen signup` — the device authorization flow.
 *
 * The behaviours pinned here were all confirmed against a REAL gateway running against a real
 * PostgreSQL, which is where the flow was developed. What these cases add is the CLI half: that
 * every non-approval outcome fails loudly and writes nothing, because the failure mode that
 * matters is a command which reports success while leaving the machine without a working
 * credential — or worse, writes `undefined` as one.
 *
 * The gateway's own guarantees (device code stored only as an HMAC, key minted at claim time, one
 * claim per approval under concurrent polling) are covered in the gateway repo's
 * `test/unit/device-auth.test.ts` and were verified live with eight simultaneous claims producing
 * exactly one key.
 *
 * Both `HOME` and `USERPROFILE` are set on every spawn: `os.homedir()` reads `USERPROFILE` on
 * Windows, so setting only `HOME` targets the developer's real `~/.certen`.
 */

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'index.js');
const run = promisify(execFile);

type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => void;
interface Stub { url: string; close: () => Promise<void> }

async function stubGateway(handler: Handler): Promise<Stub> {
  const server = http.createServer((req, res) => {
    try { handler(req, res); } catch { res.statusCode = 500; res.end('{}'); }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections?.();
      server.close(() => resolve());
    }),
  };
}

interface Run { stdout: string; stderr: string; code: number; home: string }

async function certen(args: string[], apiUrl: string): Promise<Run> {
  const home = mkdtempSync(join(tmpdir(), 'certen-signup-'));
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    HOME: home,
    USERPROFILE: home,
    CERTEN_API_URL: apiUrl,
  };
  delete env.CERTEN_API_KEY;
  try {
    const { stdout, stderr } = await run(process.execPath, [CLI, ...args], { env, encoding: 'utf8' });
    return { stdout, stderr, code: 0, home };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: number };
    return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', code: e.code ?? -1, home };
  }
}

function soleJson(stdout: string): Record<string, unknown> {
  const trimmed = stdout.trim();
  expect(trimmed.length).toBeGreaterThan(0);
  return JSON.parse(trimmed) as Record<string, unknown>;
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body));
}

function configOf(home: string): Record<string, unknown> | null {
  const file = join(home, '.certen', 'config.json');
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf-8')) : null;
}

/**
 * The advertised interval is 1 second, and the CLI floors it at 1 second regardless — a deliberate
 * production guard against a gateway advertising a hot loop. So each case here costs a second or
 * two of real waiting, and every one carries an explicit timeout rather than relying on vitest's
 * 5s default. Shortening the floor to make tests faster would change production behaviour to suit
 * the tests, which is the wrong direction.
 */
const POLL_CASE = 20_000;

function deviceGateway(polls: Array<Record<string, unknown>>): Handler {
  let index = 0;
  return (req, res) => {
    const url = (req.url ?? '').split('?')[0];
    if (url === '/v1/portal/device' && req.method === 'POST') {
      return json(res, 201, {
        device_code: 'cd_test-device-code',
        user_code: 'WDJB-MJHT',
        verification_uri: 'http://portal.example/portal',
        verification_uri_complete: 'http://portal.example/portal#device=WDJB-MJHT',
        expires_in: 600,
        interval: 1,
      });
    }
    if (url.startsWith('/v1/portal/device/')) {
      const next = polls[Math.min(index, polls.length - 1)];
      index += 1;
      return json(res, 200, next);
    }
    return json(res, 404, {});
  };
}

describe('the happy path never displays the key', () => {
  it('stores the key and reports only its prefix', async () => {
    const stub = await stubGateway(deviceGateway([
      { status: 'pending' },
      { status: 'approved', api_key: 'ck_live_granted_secret', key_prefix: 'ck_live_gran', org_id: 'org-1' },
    ]));
    try {
      const r = await certen(['--json', 'login', '--no-browser', '--no-keyring'], stub.url);
      expect(r.code).toBe(0);
      const data = soleJson(r.stdout).data as { key_prefix: string; org_id: string };
      expect(data.key_prefix).toBe('ck_live_gran...');
      expect(data.org_id).toBe('org-1');

      // The point of the whole feature: the secret reaches the machine without passing through a
      // human's clipboard, so it must not appear in output either.
      expect(r.stdout).not.toContain('ck_live_granted_secret');
      expect(r.stderr).not.toContain('ck_live_granted_secret');

      expect(configOf(r.home)).toMatchObject({ api_key: 'ck_live_granted_secret' });
    } finally {
      await stub.close();
    }
  }, POLL_CASE);

  it('prints the user code and the URL, because the browser may not open', async () => {
    const stub = await stubGateway(deviceGateway([
      { status: 'approved', api_key: 'ck_live_x', key_prefix: 'ck_live_x' },
    ]));
    try {
      const r = await certen(['login', '--no-browser', '--no-keyring'], stub.url);
      const out = r.stdout + r.stderr;
      expect(out).toContain('WDJB-MJHT');
      expect(out).toContain('http://portal.example/portal');
      // Said before the wait, so someone who did not start this has the information while it is
      // still actionable.
      expect(out).toContain('Nothing is granted until you approve it');
    } finally {
      await stub.close();
    }
  }, POLL_CASE);

  it('signup is the same flow under a second name', async () => {
    const stub = await stubGateway(deviceGateway([
      { status: 'approved', api_key: 'ck_live_y', key_prefix: 'ck_live_y' },
    ]));
    try {
      const r = await certen(['--json', 'signup', '--no-browser', '--no-keyring'], stub.url);
      expect(r.code).toBe(0);
      expect(configOf(r.home)).toMatchObject({ api_key: 'ck_live_y' });
    } finally {
      await stub.close();
    }
  }, POLL_CASE);
});

describe('every non-approval outcome writes nothing', () => {
  it('denied — exits 1 and stores no key', async () => {
    const stub = await stubGateway(deviceGateway([{ status: 'denied' }]));
    try {
      const r = await certen(['--json', 'login', '--no-browser', '--no-keyring'], stub.url);
      expect(r.code).toBe(1);
      expect((soleJson(r.stdout).error as { code: string }).code).toBe('DEVICE_CODE_DENIED');
      expect(configOf(r.home)?.api_key).toBeUndefined();
    } finally {
      await stub.close();
    }
  }, POLL_CASE);

  it('expired — exits 1 and says nothing was created', async () => {
    const stub = await stubGateway(deviceGateway([{ status: 'expired' }]));
    try {
      const r = await certen(['--json', 'login', '--no-browser', '--no-keyring'], stub.url);
      expect(r.code).toBe(1);
      const err = soleJson(r.stdout).error as { code: string; message: string };
      expect(err.code).toBe('DEVICE_CODE_EXPIRED');
      expect(err.message).toMatch(/Nothing was created/);
    } finally {
      await stub.close();
    }
  }, POLL_CASE);

  it('already claimed — treats it as alarming, not as success', async () => {
    const stub = await stubGateway(deviceGateway([{ status: 'claimed' }]));
    try {
      const r = await certen(['--json', 'login', '--no-browser', '--no-keyring'], stub.url);
      expect(r.code).toBe(1);
      const err = soleJson(r.stdout).error as { code: string; message: string };
      expect(err.code).toBe('DEVICE_CODE_ALREADY_CLAIMED');
      // Someone else collected a key with this code. Saying "revoke it" is the only useful
      // response; reporting success would hand the user a machine with no key and no idea why.
      expect(err.message).toMatch(/revoke/i);
    } finally {
      await stub.close();
    }
  }, POLL_CASE);

  it('approved but keyless — refuses rather than storing undefined', async () => {
    const stub = await stubGateway(deviceGateway([{ status: 'approved' }]));
    try {
      const r = await certen(['--json', 'login', '--no-browser', '--no-keyring'], stub.url);
      expect(r.code).toBe(1);
      expect((soleJson(r.stdout).error as { code: string }).code).toBe('DEVICE_FLOW_FAILED');
      expect(configOf(r.home)?.api_key).toBeUndefined();
    } finally {
      await stub.close();
    }
  }, POLL_CASE);
});

describe('a gateway that cannot do this says so precisely', () => {
  it('404 is reported as an old build, not as a bad code', async () => {
    // The wrong diagnosis here — "my code must be wrong" — sends someone in entirely the wrong
    // direction, so the message names the real cause and offers the portal.
    const stub = await stubGateway((_req, res) => json(res, 404, { error: 'Not Found' }));
    try {
      const r = await certen(['--json', 'login', '--no-browser'], stub.url);
      expect(r.code).toBe(1);
      const err = soleJson(r.stdout).error as { code: string; message: string };
      expect(err.code).toBe('DEVICE_FLOW_UNSUPPORTED');
      expect(err.message).toMatch(/does not support device authorization/);
      expect(err.message).toMatch(/portal/);
    } finally {
      await stub.close();
    }
  }, POLL_CASE);

  it('403 is reported as self-service being switched off', async () => {
    const stub = await stubGateway((_req, res) => json(res, 403, { error: 'disabled' }));
    try {
      const r = await certen(['--json', 'login', '--no-browser'], stub.url);
      expect(r.code).toBe(1);
      expect((soleJson(r.stdout).error as { code: string }).code).toBe('SELF_SERVICE_DISABLED');
    } finally {
      await stub.close();
    }
  }, POLL_CASE);

  it('unreachable exits 3, so a retry is known to be safe', async () => {
    const r = await certen(['--json', 'login', '--no-browser'], 'http://127.0.0.1:9');
    expect(r.code).toBe(3);
    expect((soleJson(r.stdout).error as { code: string }).code).toBe('NETWORK_ERROR');
  });
});

describe('guards', () => {
  it('refuses when CERTEN_API_KEY is set, because it would take precedence anyway', async () => {
    const home = mkdtempSync(join(tmpdir(), 'certen-signup-'));
    const stub = await stubGateway(deviceGateway([{ status: 'pending' }]));
    try {
      const env = {
        ...(process.env as Record<string, string>),
        HOME: home, USERPROFILE: home,
        CERTEN_API_URL: stub.url,
        CERTEN_API_KEY: 'ck_live_from_env',
      };
      const r = await run(process.execPath, [CLI, '--json', 'login'], { env, encoding: 'utf8' })
        .then(() => ({ stdout: '', code: 0 }))
        .catch((e: { stdout?: string; code?: number }) => ({ stdout: e.stdout ?? '', code: e.code ?? -1 }));
      expect(r.code).toBe(2);
      // Storing a key that the env var then shadows is a confusing no-op, not a success.
      expect((soleJson(r.stdout).error as { code: string }).code).toBe('API_KEY_ENV_SET');
    } finally {
      await stub.close();
    }
  }, POLL_CASE);

  it('validates --timeout before starting anything', async () => {
    const stub = await stubGateway(deviceGateway([{ status: 'pending' }]));
    try {
      const r = await certen(['--json', 'login', '--timeout', 'soon'], stub.url);
      expect(r.code).toBe(2);
      expect((soleJson(r.stdout).error as { code: string }).code).toBe('INVALID_TIMEOUT');
    } finally {
      await stub.close();
    }
  }, POLL_CASE);
});
