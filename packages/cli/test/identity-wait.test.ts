import { describe, it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { AddressInfo } from 'node:net';

/**
 * `certen identity create --wait` and the zero-balance guard.
 *
 * Run as a subprocess against a stub gateway. What is being pinned is not the polling mechanics —
 * those are simple — but the JUDGEMENTS the wait makes, each of which has a wrong answer that
 * looks reasonable:
 *
 * - a terminal status with `can_sign: false` is a FAILURE, not a success with a caveat;
 * - `can_sign: null` is UNKNOWN and must never round up to ready;
 * - a timeout is neither success nor failure, and must not exit 0;
 * - an unfunded abstract account must be refused BEFORE an intent is opened, not after.
 *
 * Intervals are driven down to 0.05s via --poll-interval so the suite costs milliseconds. The
 * real defaults are asserted in wait.test.ts; nothing here depends on wall-clock duration.
 */

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'index.js');
const run = promisify(execFile);

type Handler = (req: http.IncomingMessage, res: http.ServerResponse, hit: number) => void;
interface Stub { url: string; hits: () => number; close: () => Promise<void> }

async function stubGateway(handler: Handler): Promise<Stub> {
  let hits = 0;
  const server = http.createServer((req, res) => {
    hits += 1;
    try { handler(req, res, hits); } catch { res.statusCode = 500; res.end('{}'); }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    hits: () => hits,
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections?.();
      server.close(() => resolve());
    }),
  };
}

interface Run { stdout: string; stderr: string; code: number }

async function certen(args: string[], apiUrl: string): Promise<Run> {
  const home = mkdtempSync(join(tmpdir(), 'certen-wait-'));
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    HOME: home,
    USERPROFILE: home,
    CERTEN_API_KEY: 'ck_live_test',
    CERTEN_API_URL: apiUrl,
  };
  try {
    const { stdout, stderr } = await run(process.execPath, [CLI, ...args], { env, encoding: 'utf8' });
    return { stdout, stderr, code: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: number };
    return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', code: e.code ?? -1 };
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

const ID = '11111111-2222-3333-4444-555555555555';

function identity(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    identity: {
      id: ID,
      adi_url: 'acc://mybot.acme',
      book_url: 'acc://mybot.acme/book',
      key_page_url: 'acc://mybot.acme/book/1',
      status: 'provisioning',
      can_sign: null,
      credit_balance: 500,
      chain_accounts: [{ chain_id: 'base-sepolia', address: '0xAbstract', status: 'deployed' }],
      created_at: '2026-01-01T00:00:00Z',
      ...over,
    },
  };
}

const FAST = ['--poll-interval', '0.05', '--timeout', '0.05'];

describe('identity create --wait', () => {
  it('polls until the identity is active AND can sign, then reports the usable identity', async () => {
    const stub = await stubGateway((req, res, hit) => {
      if (req.method === 'POST') return json(res, 202, identity());
      // provisioning → active-but-unreadable → ready. The middle state is the one a naive check
      // would accept.
      if (hit === 2) return json(res, 200, identity({ status: 'provisioning' }));
      if (hit === 3) return json(res, 200, identity({ status: 'active', can_sign: null }));
      return json(res, 200, identity({ status: 'active', can_sign: true }));
    });
    try {
      const r = await certen(
        ['--json', 'identity', 'create', '--name', 'mybot', '--public-key-hash', 'a'.repeat(64),
          '--wait', '--poll-interval', '0.05'],
        stub.url,
      );
      expect(r.code).toBe(0);
      // Same envelope shape as the no-wait response, with a refreshed identity — a consumer
      // must not have to branch on which flags were passed to find the status.
      const data = soleJson(r.stdout).data as { identity: { status: string; can_sign: boolean } };
      expect(data.identity).toMatchObject({ status: 'active', can_sign: true });
      // The 202 is not also emitted: one payload, one envelope.
      expect(r.stdout.trim().split('\n')).toHaveLength(1);
    } finally {
      await stub.close();
    }
  });

  it('fails when provisioning finishes but the identity cannot sign', async () => {
    const stub = await stubGateway((req, res) => {
      if (req.method === 'POST') return json(res, 202, identity());
      return json(res, 200, identity({ status: 'active', can_sign: false }));
    });
    try {
      const r = await certen(
        ['--json', 'identity', 'create', '--name', 'mybot', '--public-key-hash', 'a'.repeat(64),
          '--wait', '--poll-interval', '0.05'],
        stub.url,
      );
      // An identity that exists, consumes quota, and can never sign is a failed outcome. Exiting
      // 0 here would hand back something that fails at the last step of every later flow.
      expect(r.code).toBe(1);
      expect((soleJson(r.stdout).error as { code: string }).code).toBe('IDENTITY_CANNOT_SIGN');
    } finally {
      await stub.close();
    }
  });

  it('reports a provisioning error with the gateway\'s reason', async () => {
    const stub = await stubGateway((req, res) => {
      if (req.method === 'POST') return json(res, 202, identity());
      return json(res, 200, identity({ status: 'error', can_sign: false, error_message: 'sponsor key unavailable' }));
    });
    try {
      const r = await certen(
        ['--json', 'identity', 'create', '--name', 'mybot', '--public-key-hash', 'a'.repeat(64),
          '--wait', '--poll-interval', '0.05'],
        stub.url,
      );
      expect(r.code).toBe(1);
      const err = soleJson(r.stdout).error as { code: string; message: string };
      expect(err.message).toContain('sponsor key unavailable');
    } finally {
      await stub.close();
    }
  });

  it('never rounds can_sign: null up to ready, even at the deadline', async () => {
    const stub = await stubGateway((req, res) => {
      if (req.method === 'POST') return json(res, 202, identity());
      // Active forever, key page never readable — an Accumulate outage looks exactly like this.
      return json(res, 200, identity({ status: 'active', can_sign: null }));
    });
    try {
      const r = await certen(
        ['--json', 'identity', 'create', '--name', 'mybot', '--public-key-hash', 'a'.repeat(64),
          '--wait', ...FAST],
        stub.url,
      );
      expect(r.code).toBe(1);
      const err = soleJson(r.stdout).error as { code: string; message: string };
      expect(err.code).toBe('IDENTITY_CAN_SIGN_UNKNOWN');
      // The distinction it must preserve: unknown is not "no", and the identity may be fine.
      expect(err.message).toMatch(/could not be determined/);
    } finally {
      await stub.close();
    }
  });

  it('treats a timeout as neither success nor failure, and does not exit 0', async () => {
    const stub = await stubGateway((req, res) => {
      if (req.method === 'POST') return json(res, 202, identity());
      return json(res, 200, identity({ status: 'provisioning' }));
    });
    try {
      const r = await certen(
        ['--json', 'identity', 'create', '--name', 'mybot', '--public-key-hash', 'a'.repeat(64),
          '--wait', ...FAST],
        stub.url,
      );
      expect(r.code).toBe(1);
      const err = soleJson(r.stdout).error as { code: string; message: string };
      expect(err.code).toBe('IDENTITY_WAIT_TIMEOUT');
      expect(err.message).toContain('may yet');
    } finally {
      await stub.close();
    }
  });

  it('does not wait in --json mode unless asked — one POST, no polling', async () => {
    const stub = await stubGateway((req, res) => {
      if (req.method === 'POST') return json(res, 202, identity());
      return json(res, 200, identity({ status: 'active', can_sign: true }));
    });
    try {
      const r = await certen(
        ['--json', 'identity', 'create', '--name', 'mybot', '--public-key-hash', 'a'.repeat(64)],
        stub.url,
      );
      expect(r.code).toBe(0);
      // Exactly one request: the create. A script written against the old behaviour keeps it.
      expect(stub.hits()).toBe(1);
      const data = soleJson(r.stdout).data as { identity: { status: string } };
      expect(data.identity.status).toBe('provisioning');
    } finally {
      await stub.close();
    }
  });

  it('waits by default in human mode, and names the abstract account that needs gas', async () => {
    const stub = await stubGateway((req, res) => {
      if (req.method === 'POST') return json(res, 202, identity());
      return json(res, 200, identity({ status: 'active', can_sign: true }));
    });
    try {
      const r = await certen(
        ['identity', 'create', '--name', 'mybot', '--public-key-hash', 'a'.repeat(64),
          '--poll-interval', '0.05'],
        stub.url,
      );
      expect(r.code).toBe(0);
      expect(stub.hits()).toBeGreaterThan(1);
      const all = r.stdout + r.stderr;
      expect(all).toContain('0xAbstract');
      // The address alone is not the point — that it is msg.sender and starts empty is.
      expect(all).toContain('msg.sender');
      expect(all).toContain('certen tx create');
    } finally {
      await stub.close();
    }
  });

  it('validates --timeout before creating anything', async () => {
    const stub = await stubGateway((_req, res) => json(res, 202, identity()));
    try {
      const r = await certen(
        ['--json', 'identity', 'create', '--name', 'mybot', '--public-key-hash', 'a'.repeat(64),
          '--wait', '--timeout', 'soon'],
        stub.url,
      );
      expect(r.code).toBe(2);
      expect((soleJson(r.stdout).error as { code: string }).code).toBe('INVALID_TIMEOUT');
      // Nothing was created. A typo in a wait flag must not burn an identity slot.
      expect(stub.hits()).toBe(0);
    } finally {
      await stub.close();
    }
  });
});

describe('the zero-balance abstract account guard', () => {
  const portfolio = (balance: string): Record<string, unknown> => ({
    identities: [{
      adi_url: 'acc://mybot.acme',
      status: 'active',
      credit_balance: 500,
      chains: [{
        chain_id: 'base-sepolia',
        address: '0xAbstract',
        deployed: true,
        balances: [{ token: 'ETH', balance }],
      }],
      pending_actions: 0,
    }],
    total_chains: 1,
  });

  it('refuses a value transfer from an empty account BEFORE opening the intent', async () => {
    let posts = 0;
    const stub = await stubGateway((req, res) => {
      if (req.url?.startsWith('/v1/portfolio')) return json(res, 200, portfolio('0'));
      if (req.method === 'POST') { posts += 1; return json(res, 201, { intent_id: 'x' }); }
      return json(res, 404, {});
    });
    try {
      const r = await certen(
        ['--json', 'tx', 'create', '--identity', ID, '--to-chain', 'base-sepolia',
          '--to', '0xRecipient', '--amount', '1'],
        stub.url,
      );
      expect(r.code).toBe(1);
      const err = soleJson(r.stdout).error as { code: string; message: string };
      expect(err.code).toBe('ABSTRACT_ACCOUNT_UNFUNDED');
      // The failure it prevents is silent, so the message has to carry both the cause and the fix.
      expect(err.message).toContain('anchoring');
      expect(err.message).toContain('0xAbstract');
      // Nothing was submitted.
      expect(posts).toBe(0);
    } finally {
      await stub.close();
    }
  });

  it('allows the same transfer with --force', async () => {
    const stub = await stubGateway((req, res) => {
      if (req.url?.startsWith('/v1/portfolio')) return json(res, 200, portfolio('0'));
      if (req.method === 'POST') return json(res, 201, { intent_id: 'x', status: 'pending' });
      return json(res, 404, {});
    });
    try {
      const r = await certen(
        ['--json', 'tx', 'create', '--identity', ID, '--to-chain', 'base-sepolia',
          '--to', '0xRecipient', '--amount', '1', '--force'],
        stub.url,
      );
      expect(r.code).toBe(0);
    } finally {
      await stub.close();
    }
  });

  it('does not block when the account has a balance', async () => {
    const stub = await stubGateway((req, res) => {
      if (req.url?.startsWith('/v1/portfolio')) return json(res, 200, portfolio('1000000000000000000'));
      if (req.method === 'POST') return json(res, 201, { intent_id: 'x', status: 'pending' });
      return json(res, 404, {});
    });
    try {
      const r = await certen(
        ['--json', 'tx', 'create', '--identity', ID, '--to-chain', 'base-sepolia',
          '--to', '0xRecipient', '--amount', '1'],
        stub.url,
      );
      expect(r.code).toBe(0);
    } finally {
      await stub.close();
    }
  });

  it('does not block when the balance cannot be read — a guard must not become a gate', async () => {
    const stub = await stubGateway((req, res) => {
      // Portfolio unavailable. The intent must still go through: blocking on missing data would
      // break legitimate work every time this view lagged.
      if (req.url?.startsWith('/v1/portfolio')) return json(res, 500, { error: { message: 'down' } });
      if (req.method === 'POST') return json(res, 201, { intent_id: 'x', status: 'pending' });
      return json(res, 404, {});
    });
    try {
      const r = await certen(
        ['--json', 'tx', 'create', '--identity', ID, '--to-chain', 'base-sepolia',
          '--to', '0xRecipient', '--amount', '1'],
        stub.url,
      );
      expect(r.code).toBe(0);
    } finally {
      await stub.close();
    }
  });
});
