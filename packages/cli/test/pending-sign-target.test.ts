import { describe, it, expect, beforeAll } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { AddressInfo } from 'node:net';

/**
 * `certen pending sign <target>` — the type sent to POST /v1/sign is inferred from the argument.
 *
 * Run as SUBPROCESSES against a stub gateway, matching billing.test.ts and the conformance suite:
 * the properties under test are properties of a process. "No HTTP call was made" is only
 * observable from outside — an in-process test that stubs the client cannot tell a request that
 * was never sent from one that was sent and ignored — and that distinction is the whole point of
 * failing on a missing --public-key before the request goes out.
 *
 * Nothing here reaches the real network. Cases that must not call the gateway point at
 * 127.0.0.1:9 (discard), which refuses immediately and locally.
 */

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'index.js');
const HOME = mkdtempSync(join(tmpdir(), 'certen-pending-sign-'));

const HASH = '2e3d512dba256dc9a399be689e65733db70ec88155b7142a39c6a2d9f2279fc6';
const UUID = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
const IDENTITY = 'acc://signer.acme';
const PAGE = 'acc://signer.acme/book/1';
const PUBKEY = 'ab'.repeat(32);

interface Captured { url: string; body: Record<string, unknown> }

interface Stub {
  url: string;
  hits: () => number;
  requests: Captured[];
  close: () => Promise<void>;
}

const SIGN_RESPONSE = {
  status: 'signing_required',
  sign_request_id: '046db52f-3828-4116-93ce-ce0aea04a244',
  signing_data: {
    data_for_signature: 'cd'.repeat(32),
    transaction_hash: HASH,
    signer_url: PAGE,
    signer_version: 2,
    timestamp: 1787213114297000,
  },
  submit_url: '/v1/sign/046db52f-3828-4116-93ce-ce0aea04a244/signature',
};

async function stubGateway(): Promise<Stub> {
  let hits = 0;
  const requests: Captured[] = [];
  const server = http.createServer((req, res) => {
    hits += 1;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      requests.push({
        url: req.url ?? '',
        body: raw ? (JSON.parse(raw) as Record<string, unknown>) : {},
      });
      res.statusCode = 201;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(SIGN_RESPONSE));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    hits: () => hits,
    requests,
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections?.();
      server.close(() => resolve());
    }),
  };
}

interface Run { stdout: string; stderr: string; code: number }
const run = promisify(execFile);

async function certen(args: string[], apiUrl?: string): Promise<Run> {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    HOME, USERPROFILE: HOME,
    CERTEN_API_KEY: 'ck_live_test',
    CERTEN_API_URL: apiUrl ?? 'http://127.0.0.1:9',
  };
  try {
    const { stdout, stderr } = await run(process.execPath, [CLI, ...args], { env, encoding: 'utf8' });
    return { stdout, stderr, code: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: number };
    return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', code: e.code ?? -1 };
  }
}

beforeAll(() => {
  if (!existsSync(CLI)) {
    throw new Error(`built CLI not found at ${CLI} — run \`npm run build\` before the CLI suite`);
  }
});

describe('certen pending sign — target inference', () => {
  it('sends pending_action for an inbox id, with no key fields required', async () => {
    const stub = await stubGateway();
    try {
      const r = await certen(['--json', 'pending', 'sign', UUID], stub.url);
      expect(r.code).toBe(0);
      expect(stub.requests).toHaveLength(1);
      expect(stub.requests[0].url).toBe('/v1/sign');
      expect(stub.requests[0].body.type).toBe('pending_action');
      expect(stub.requests[0].body.target_id).toBe(UUID);
      // Nothing was invented for the fields the inbox row derives.
      expect(stub.requests[0].body).not.toHaveProperty('public_key');
      expect(stub.requests[0].body).not.toHaveProperty('identity');
    } finally {
      await stub.close();
    }
  });

  it('sends pending_tx for a bare hash, with identity, signer_url and public_key', async () => {
    const stub = await stubGateway();
    try {
      const r = await certen([
        '--json', 'pending', 'sign', HASH,
        '--identity', IDENTITY, '--signer-url', PAGE, '--public-key', PUBKEY,
      ], stub.url);
      expect(r.code).toBe(0);
      expect(stub.requests[0].body).toMatchObject({
        type: 'pending_tx',
        target_id: HASH,
        identity: IDENTITY,
        signer_url: PAGE,
        public_key: PUBKEY,
      });
    } finally {
      await stub.close();
    }
  });

  it('accepts a TxID and sends only the hash', async () => {
    const stub = await stubGateway();
    try {
      const r = await certen([
        '--json', 'pending', 'sign', `acc://${HASH}@signer.acme/data`,
        '--identity', IDENTITY, '--signer-url', PAGE, '--public-key', PUBKEY,
      ], stub.url);
      expect(r.code).toBe(0);
      expect(stub.requests[0].body).toMatchObject({ type: 'pending_tx', target_id: HASH });
    } finally {
      await stub.close();
    }
  });

  it('exits 2 without calling the gateway when a hash is given with no --public-key', async () => {
    const stub = await stubGateway();
    try {
      const r = await certen([
        'pending', 'sign', HASH, '--identity', IDENTITY, '--signer-url', PAGE,
      ], stub.url);
      expect(r.code).toBe(2);
      expect(r.stderr).toContain('--public-key');
      expect(stub.hits()).toBe(0);
    } finally {
      await stub.close();
    }
  });

  it('names every missing flag at once', async () => {
    const stub = await stubGateway();
    try {
      const r = await certen(['pending', 'sign', HASH], stub.url);
      expect(r.code).toBe(2);
      expect(r.stderr).toContain('--identity');
      expect(r.stderr).toContain('--signer-url');
      expect(r.stderr).toContain('--public-key');
      expect(stub.hits()).toBe(0);
    } finally {
      await stub.close();
    }
  });

  it('exits 2 without calling the gateway on a target that is neither form', async () => {
    const stub = await stubGateway();
    try {
      const r = await certen(['pending', 'sign', 'acc://alice.acme/book'], stub.url);
      expect(r.code).toBe(2);
      expect(stub.hits()).toBe(0);
    } finally {
      await stub.close();
    }
  });

  it('emits exactly one JSON object on stdout for a hash target', async () => {
    const stub = await stubGateway();
    try {
      const r = await certen([
        '--json', 'pending', 'sign', HASH,
        '--identity', IDENTITY, '--signer-url', PAGE, '--public-key', PUBKEY,
      ], stub.url);
      expect(r.code).toBe(0);
      // Exactly one object: parses whole, and re-serialising it accounts for all of stdout.
      const parsed = JSON.parse(r.stdout.trim()) as Record<string, unknown>;
      expect(parsed).toBeTypeOf('object');
      expect(r.stdout.trim().split('\n').filter((l) => l.trim().startsWith('{')).length)
        .toBeLessThanOrEqual(1);
      // The two-step hint must not leak into the machine stream.
      expect(r.stdout).not.toContain('certen pending submit');
    } finally {
      await stub.close();
    }
  });

  it('exits 2 with a usage error for a JSON-mode bad target, still one object on stdout', async () => {
    const stub = await stubGateway();
    try {
      const r = await certen(['--json', 'pending', 'sign', 'nonsense'], stub.url);
      expect(r.code).toBe(2);
      const parsed = JSON.parse(r.stdout.trim()) as { ok?: boolean; error?: { code?: string } };
      expect(parsed.ok).toBe(false);
      expect(parsed.error?.code).toBe('INVALID_SIGN_TARGET');
      expect(stub.hits()).toBe(0);
    } finally {
      await stub.close();
    }
  });

  it('lists --public-key in its help', async () => {
    const r = await certen(['pending', 'sign', '--help']);
    expect(r.stdout).toContain('--public-key');
    expect(r.stdout).toContain('hash or TxID');
  });
});
