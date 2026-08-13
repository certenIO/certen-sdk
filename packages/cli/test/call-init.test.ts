import { describe, it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { AddressInfo } from 'node:net';

/**
 * `certen call` and `certen init`.
 *
 * What is pinned here is what running against the LIVE gateway showed to matter:
 *
 * - `adiUrl` and `fromAddress` are REQUIRED and are dereferenced upstream with no null check, so
 *   omitting either yields a bodyless 502 that reads as "the gateway is down". `call` derives
 *   both from the identity so a user cannot omit them.
 * - The gateway spells `chain_id` as a slug on some chain accounts and as a numeric EVM id on
 *   others, so the abstract-account lookup must normalize before comparing.
 * - `init` must be idempotent against real quota. It reuses the identity THIS MACHINE recorded,
 *   because the gateway has no identity list route and `/v1/portfolio` returns no UUIDs — an
 *   identity id that is not written down at creation is unrecoverable.
 *
 * Both `HOME` and `USERPROFILE` are set on every spawn: `os.homedir()` reads `USERPROFILE` on
 * Windows, so setting only `HOME` targets the developer's real `~/.certen`.
 */

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'index.js');
const run = promisify(execFile);

type Handler = (req: http.IncomingMessage, res: http.ServerResponse, body: string) => void;
interface Stub { url: string; posts: () => number; close: () => Promise<void> }

async function stubGateway(handler: Handler): Promise<Stub> {
  let posts = 0;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (req.method === 'POST') posts += 1;
      try { handler(req, res, body); } catch { res.statusCode = 500; res.end('{}'); }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    posts: () => posts,
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections?.();
      server.close(() => resolve());
    }),
  };
}

interface Run { stdout: string; stderr: string; code: number; home: string }

function envFor(home: string, apiUrl: string): Record<string, string> {
  return {
    ...(process.env as Record<string, string>),
    HOME: home,
    USERPROFILE: home,
    CERTEN_API_URL: apiUrl,
    CERTEN_API_KEY: 'ck_live_test',
  };
}

async function spawn(args: string[], env: Record<string, string>, home: string): Promise<Run> {
  try {
    const { stdout, stderr } = await run(process.execPath, [CLI, ...args], { env, encoding: 'utf8', cwd: home });
    return { stdout, stderr, code: 0, home };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: number };
    return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', code: e.code ?? -1, home };
  }
}

async function certen(
  args: string[],
  apiUrl: string,
  opts: { home?: string; withKey?: string } = {},
): Promise<Run> {
  const home = opts.home ?? mkdtempSync(join(tmpdir(), 'certen-call-'));
  const env = envFor(home, apiUrl);
  if (opts.withKey) {
    await spawn(['keys', 'generate', '--name', opts.withKey, '--no-passphrase'], env, home);
  }
  return spawn(args, env, home);
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

const ID = '396f863c-879c-4046-8591-3f0405c5f6bd';
const ADDR = `0x${'11'.repeat(20)}`;
const B32 = `0x${'ab'.repeat(32)}`;
const ABSTRACT = '0xe293e95Ec1471155d977448B99B0922C2828cAcB';

/** Numeric chain_id on the account, as the live gateway really returns for ethereum-sepolia. */
function identityBody(over: Record<string, unknown> = {}): Record<string, unknown> {
  // Flat: the gateway returns the identity's own fields at the top level, with any joined
  // sub-resources beside them. It was nested under `identity` until the 2026-08 break.
  return {
    id: ID,
    adi_url: 'acc://v9-195727.acme',
    book_url: 'acc://v9-195727.acme/book',
    key_page_url: 'acc://v9-195727.acme/book/1',
    status: 'active',
    can_sign: true,
    credit_balance: 500,
    chain_accounts: [{ chain_id: '11155111', address: ABSTRACT, status: 'deployed' }],
    created_at: '2026-01-01T00:00:00Z',
    ...over,
  };
}

const FUNDED_PORTFOLIO = {
  identities: [{
    adi_url: 'acc://v9-195727.acme',
    status: 'active',
    credit_balance: 500,
    chains: [{
      chain_id: 'ethereum-sepolia', address: ABSTRACT, deployed: true,
      balances: [{ token: 'ETH', balance: '1000000000000000' }],
    }],
    pending_actions: 0,
  }],
  total_chains: 1,
};

function gateway(over: Record<string, unknown> = {}): Handler {
  return (req, res) => {
    const url = (req.url ?? '').split('?')[0];
    if (url in over) return json(res, 200, over[url]);
    if (url === `/v1/identity/${ID}`) return json(res, 200, identityBody());
    if (url === '/v1/portfolio') return json(res, 200, FUNDED_PORTFOLIO);
    if (url === '/v1/billing/balance') {
      return json(res, 200, {
        currency: 'USD', available_usd: '5.000000', held_usd: '0.000000',
        credit_limit_usd: '0.000000', spendable_usd: '5.000000', status: 'active',
      });
    }
    if (url === '/v1/billing/obligations') {
      return json(res, 200, { pending_intents: 0, remaining_usd: '5.000000', uncovered_usd: '0.000000' });
    }
    if (url === '/v1/transaction' && req.method === 'POST') {
      return json(res, 201, {
        intent_id: 'intent-1',
        signing_data: { hash_to_sign: 'ab'.repeat(32) },
      });
    }
    if (url === '/v1/transaction/intent-1/signature') return json(res, 200, { ok: true });
    if (url === '/v1/transaction/intent-1') return json(res, 200, { intent_id: 'intent-1', status: 'completed' });
    return json(res, 404, {});
  };
}

describe('certen call derives what the gateway silently requires', () => {
  it('--dry-run resolves adiUrl, fromAddress and chainId, and sends nothing', async () => {
    const stub = await stubGateway(gateway());
    try {
      const r = await certen(
        ['--json', 'call', '--identity', ID, '--chain', 'ethereum-sepolia',
          '--to', ADDR, '--fn', 'confirm(bytes32)', '--arg', B32, '--dry-run'],
        stub.url,
      );
      expect(r.code).toBe(0);
      const data = soleJson(r.stdout).data as {
        adi_url: string; from_address: string; chain_id: number;
        contract_call: { functionSignature: string; args: string[]; value: string };
      };
      // Omitting either of these upstream produces a BODYLESS 502 that reads as "the gateway is
      // down". They are derived so a user cannot omit them.
      expect(data.adi_url).toBe('acc://v9-195727.acme');
      // Found despite the account carrying a NUMERIC chain_id while --chain named a slug.
      expect(data.from_address).toBe(ABSTRACT);
      expect(data.chain_id).toBe(11155111);
      expect(data.contract_call.functionSignature).toBe('confirm(bytes32)');
      expect(data.contract_call.args).toEqual([B32]);
      expect(stub.posts()).toBe(0);
    } finally {
      await stub.close();
    }
  });

  it('refuses when the identity has no abstract account on that chain, and names the fix', async () => {
    const stub = await stubGateway(gateway());
    try {
      const r = await certen(
        ['--json', 'call', '--identity', ID, '--chain', 'arbitrum-sepolia',
          '--to', ADDR, '--fn', 'confirm(bytes32)', '--arg', B32, '--dry-run'],
        stub.url,
      );
      expect(r.code).toBe(1);
      const err = soleJson(r.stdout).error as { code: string; message: string };
      expect(err.code).toBe('NO_ABSTRACT_ACCOUNT');
      expect(err.message).toContain('certen identity link-chain');
    } finally {
      await stub.close();
    }
  });

  it('refuses an identity that cannot sign, before asking for a passphrase', async () => {
    const stub = await stubGateway(gateway({ [`/v1/identity/${ID}`]: identityBody({ can_sign: false }) }));
    try {
      const r = await certen(
        ['--json', 'call', '--identity', ID, '--chain', 'ethereum-sepolia',
          '--to', ADDR, '--fn', 'confirm(bytes32)', '--arg', B32, '--sign-with', 'dev'],
        stub.url,
        { withKey: 'dev' },
      );
      expect(r.code).toBe(1);
      expect((soleJson(r.stdout).error as { code: string }).code).toBe('IDENTITY_CANNOT_SIGN');
    } finally {
      await stub.close();
    }
  });

  it('validates arguments before any network call at all', async () => {
    const stub = await stubGateway(gateway());
    try {
      const r = await certen(
        ['--json', 'call', '--identity', ID, '--chain', 'ethereum-sepolia',
          '--to', ADDR, '--fn', 'confirm(bytes32)', '--arg', '0xdeadbeef', '--dry-run'],
        stub.url,
      );
      expect(r.code).toBe(2);
      expect((soleJson(r.stdout).error as { code: string }).code).toBe('INVALID_ARGUMENT');
    } finally {
      await stub.close();
    }
  });

  it('rejects a --to that is not an address', async () => {
    const stub = await stubGateway(gateway());
    try {
      const r = await certen(
        ['--json', 'call', '--identity', ID, '--chain', 'ethereum-sepolia',
          '--to', '0xdEaD', '--fn', 'confirm(bytes32)', '--arg', B32, '--dry-run'],
        stub.url,
      );
      expect(r.code).toBe(2);
      expect((soleJson(r.stdout).error as { code: string }).code).toBe('INVALID_ADDRESS');
    } finally {
      await stub.close();
    }
  });

  it('refuses to pretend it signed when nothing can sign', async () => {
    const stub = await stubGateway(gateway());
    try {
      const r = await certen(
        ['--json', 'call', '--identity', ID, '--chain', 'ethereum-sepolia',
          '--to', ADDR, '--fn', 'confirm(bytes32)', '--arg', B32],
        stub.url,
      );
      expect(r.code).toBe(2);
      expect((soleJson(r.stdout).error as { code: string }).code).toBe('MISSING_SIGNING_KEY');
      expect(stub.posts()).toBe(0);
    } finally {
      await stub.close();
    }
  });

  it('opens and signs the intent when everything is in place', async () => {
    const stub = await stubGateway(gateway());
    try {
      const r = await certen(
        ['--json', 'call', '--identity', ID, '--chain', 'ethereum-sepolia',
          '--to', ADDR, '--fn', 'confirm(bytes32)', '--arg', B32, '--sign-with', 'dev'],
        stub.url,
        { withKey: 'dev' },
      );
      expect(r.code).toBe(0);
      expect((soleJson(r.stdout).data as { intentId: string }).intentId).toBe('intent-1');
      // The intent POST plus the signature POST.
      expect(stub.posts()).toBe(2);
    } finally {
      await stub.close();
    }
  });

  it('applies the unfunded-account guard to a payable call', async () => {
    const empty = {
      ...FUNDED_PORTFOLIO,
      identities: [{
        ...FUNDED_PORTFOLIO.identities[0],
        chains: [{ chain_id: 'ethereum-sepolia', address: ABSTRACT, deployed: true, balances: [{ token: 'ETH', balance: '0' }] }],
      }],
    };
    const stub = await stubGateway(gateway({ '/v1/portfolio': empty }));
    try {
      const r = await certen(
        ['--json', 'call', '--identity', ID, '--chain', 'ethereum-sepolia',
          '--to', ADDR, '--fn', 'deposit()', '--value', '1000', '--sign-with', 'dev'],
        stub.url,
        { withKey: 'dev' },
      );
      expect(r.code).toBe(1);
      expect((soleJson(r.stdout).error as { code: string }).code).toBe('ABSTRACT_ACCOUNT_UNFUNDED');
      expect(stub.posts()).toBe(0);
    } finally {
      await stub.close();
    }
  });

  it('does NOT apply the guard to a zero-value call', async () => {
    // A contract call that forwards nothing still needs gas to execute, but the account paying is
    // not necessarily empty of it in the way a transfer requires — and blocking every read-shaped
    // call on a zero native balance would refuse work that succeeds.
    const empty = {
      ...FUNDED_PORTFOLIO,
      identities: [{
        ...FUNDED_PORTFOLIO.identities[0],
        chains: [{ chain_id: 'ethereum-sepolia', address: ABSTRACT, deployed: true, balances: [{ token: 'ETH', balance: '0' }] }],
      }],
    };
    const stub = await stubGateway(gateway({ '/v1/portfolio': empty }));
    try {
      const r = await certen(
        ['--json', 'call', '--identity', ID, '--chain', 'ethereum-sepolia',
          '--to', ADDR, '--fn', 'confirm(bytes32)', '--arg', B32, '--sign-with', 'dev'],
        stub.url,
        { withKey: 'dev' },
      );
      expect(r.code).toBe(0);
    } finally {
      await stub.close();
    }
  });
});

describe('certen identity retire', () => {
  it('refuses without --yes, and sends nothing', async () => {
    const stub = await stubGateway(gateway());
    try {
      const r = await certen(['--json', 'identity', 'retire', ID], stub.url);
      // The required flag IS the confirmation. No y/N prompt: an identity a live integration
      // depends on must not be retirable by an accidental Enter.
      expect(r.code).toBe(2);
      expect((soleJson(r.stdout).error as { code: string }).code).toBe('USAGE_ERROR');
    } finally {
      await stub.close();
    }
  });

  it('retires with --yes and forgets the id locally', async () => {
    const home = mkdtempSync(join(tmpdir(), 'certen-retire-'));
    const retiring = (req: http.IncomingMessage, res: http.ServerResponse, body: string): void => {
      const url = (req.url ?? '').split('?')[0];
      if (url === '/v1/identity' && req.method === 'POST') return json(res, 202, identityBody());
      if (url === `/v1/identity/${ID}` && req.method === 'DELETE') {
        return json(res, 200, { deleted: true, id: ID, adi_url: 'acc://v9-195727.acme' });
      }
      return gateway()(req, res, body);
    };
    const stub = await stubGateway(retiring);
    try {
      // Seed the local record the way `identity create` would.
      const env = envFor(home, stub.url);
      await spawn(['identity', 'create', '--name', 'x', '--public-key-hash', 'a'.repeat(64), '--no-wait'], env, home);
      const before = JSON.parse(readFileSync(join(home, '.certen', 'config.json'), 'utf8'));
      expect((before.identities ?? []).length).toBeGreaterThan(0);

      const r = await spawn(['identity', 'retire', ID, '--yes'], env, home);
      expect(r.code).toBe(0);
      // The distinction that matters if someone retired for security reasons rather than tidiness.
      expect(r.stdout + r.stderr).toMatch(/not a way to revoke a key/);

      const after = JSON.parse(readFileSync(join(home, '.certen', 'config.json'), 'utf8'));
      // Left in place, `certen init` would keep offering to reuse an identity the gateway no
      // longer tracks.
      expect((after.identities ?? []).some((i: { id: string }) => i.id === ID)).toBe(false);
    } finally {
      await stub.close();
    }
  });
});

describe('certen init is idempotent against real quota', () => {
  function initGateway(): Handler {
    return (req, res, body) => {
      const url = (req.url ?? '').split('?')[0];
      if (url === '/v1/identity' && req.method === 'POST') {
        const parsed = JSON.parse(body || '{}') as { name?: string };
        return json(res, 202, identityBody({ id: 'new-id-1', adi_url: `acc://${parsed.name}.acme`, status: 'creating', can_sign: null }));
      }
      if (url === '/v1/identity/new-id-1') {
        return json(res, 200, identityBody({
          id: 'new-id-1', adi_url: 'acc://fresh.acme', status: 'active', can_sign: true,
          chain_accounts: [{ chain_id: 'base-sepolia', address: '0xNew', status: 'deployed' }],
        }));
      }
      return gateway()(req, res, body);
    };
  }

  it('creates on first run and records the id so it can be reused', async () => {
    const home = mkdtempSync(join(tmpdir(), 'certen-init-'));
    const stub = await stubGateway(initGateway());
    try {
      const first = await certen(
        ['--json', 'init', '--yes', '--name', 'fresh', '--chains', 'base-sepolia', '--poll-interval', '0.05'],
        stub.url,
        { home, withKey: 'dev' },
      );
      expect(first.code).toBe(0);
      const data = soleJson(first.stdout).data as { identity_id: string; steps: Array<{ step: string; status: string }> };
      expect(data.identity_id).toBe('new-id-1');
      expect(data.steps.find((s) => s.step === 'identity')!.status).toBe('created');

      // The id must be on disk: the gateway has no identity list route and the portfolio returns
      // no UUIDs, so an unrecorded id is gone the moment the terminal scrolls.
      const config = JSON.parse(readFileSync(join(home, '.certen', 'config.json'), 'utf8'));
      expect(config.identities).toHaveLength(1);
      expect(config.identities[0].id).toBe('new-id-1');

      const postsAfterFirst = stub.posts();

      const second = await certen(['--json', 'init', '--yes'], stub.url, { home });
      expect(second.code).toBe(0);
      const again = soleJson(second.stdout).data as { identity_id: string; steps: Array<{ step: string; status: string }> };
      expect(again.identity_id).toBe('new-id-1');
      expect(again.steps.find((s) => s.step === 'identity')!.status).toBe('skipped');
      // Nothing was created the second time. Re-running to check a setup must never cost quota.
      expect(stub.posts()).toBe(postsAfterFirst);
    } finally {
      await stub.close();
    }
  });

  it('reuses the existing signing key rather than minting another', async () => {
    const home = mkdtempSync(join(tmpdir(), 'certen-init-'));
    const stub = await stubGateway(initGateway());
    try {
      await certen(['--json', 'init', '--yes', '--name', 'fresh', '--poll-interval', '0.05'], stub.url,
        { home, withKey: 'dev' });
      const keys = await certen(['--json', 'keys', 'list'], stub.url, { home });
      const list = soleJson(keys.stdout).data as Array<{ name: string }>;
      expect(list.map((k) => k.name)).toEqual(['dev']);
    } finally {
      await stub.close();
    }
  });

  it('fails with a usage error when there is no key and no way to ask for one', async () => {
    const stub = await stubGateway(initGateway());
    try {
      const home = mkdtempSync(join(tmpdir(), 'certen-init-'));
      const env = envFor(home, stub.url);
      delete env.CERTEN_API_KEY;
      const r = await spawn(['--json', 'init', '--yes'], env, home);
      expect(r.code).toBe(2);
      expect((soleJson(r.stdout).error as { code: string }).code).toBe('NO_API_KEY');
      expect(existsSync(join(home, '.certen', 'config.json'))).toBe(false);
    } finally {
      await stub.close();
    }
  });

  it('validates chains before creating anything', async () => {
    const stub = await stubGateway(initGateway());
    try {
      const r = await certen(['--json', 'init', '--yes', '--chains', 'base'], stub.url);
      expect(r.code).toBe(2);
      expect((soleJson(r.stdout).error as { code: string }).code).toBe('UNSUPPORTED_CHAIN');
      expect(stub.posts()).toBe(0);
    } finally {
      await stub.close();
    }
  });
});
