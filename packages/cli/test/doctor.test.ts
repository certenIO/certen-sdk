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
 * `certen doctor`, `certen whoami`, `certen chains`.
 *
 * The behaviours pinned here are the ones with a plausible wrong answer:
 *
 * - the check list is the SAME LENGTH whatever happens, so a skipped check is visibly skipped
 *   rather than absent;
 * - a failing run still carries every check, under `error.details` — signalling the failure must
 *   not cost the caller the diagnosis;
 * - an unreachable gateway exits 3, not 1;
 * - `chains` works with no API key at all, which is what makes it the first useful command.
 *
 * Isolation note: every spawn sets BOTH `HOME` and `USERPROFILE`. `os.homedir()` reads
 * `USERPROFILE` on Windows, so setting only `HOME` there silently leaves the developer's real
 * `~/.certen` as the target — which is not a hypothetical, it is how this suite's own smoke
 * testing once overwrote a live config file.
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

interface Run { stdout: string; stderr: string; code: number }

function envFor(home: string, apiUrl: string, apiKey?: string): Record<string, string> {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    HOME: home,
    USERPROFILE: home,
    CERTEN_API_URL: apiUrl,
  };
  delete env.CERTEN_API_KEY;
  if (apiKey) env.CERTEN_API_KEY = apiKey;
  return env;
}

async function spawn(args: string[], env: Record<string, string>): Promise<Run> {
  try {
    const { stdout, stderr } = await run(process.execPath, [CLI, ...args], { env, encoding: 'utf8' });
    return { stdout, stderr, code: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: number };
    return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', code: e.code ?? -1 };
  }
}

/**
 * `withLocalKey` generates a real signing key in the scratch home before the command runs.
 *
 * Without it, `doctor`'s "local signing key" check fails in every case — correctly, since a fresh
 * home has none — and a case meaning to exercise a healthy setup would be asserting against a
 * broken one. The key is real (the keystore is not stubbed); `--no-passphrase` only avoids a
 * prompt on a pipe with no TTY.
 */
async function certen(
  args: string[],
  apiUrl: string,
  apiKey?: string,
  opts: { withLocalKey?: boolean } = {},
): Promise<Run> {
  const home = mkdtempSync(join(tmpdir(), 'certen-doctor-'));
  const env = envFor(home, apiUrl, apiKey);
  if (opts.withLocalKey) {
    await spawn(['keys', 'generate', '--name', 'probe', '--no-passphrase'], env);
  }
  return spawn(args, env);
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

/** Shaped like the live registry: three EVM testnets plus one the CLI does not target. */
const CHAINS = {
  version: '2.0.0',
  last_updated: '2026-07-31',
  accumulate: { network: 'kermit', environment: 'testnet', api: 'https://a', explorer: 'https://b' },
  count: 4,
  chains: [
    {
      id: 'ethereum-sepolia', chainId: 11155111, family: 'evm', displayName: 'Ethereum Sepolia',
      environment: 'testnet', explorer: 'https://sepolia.etherscan.io', status: 'active',
      contracts: { anchor: { address: '0xA', verified: true } },
    },
    {
      id: 'base-sepolia', chainId: 84532, family: 'evm', displayName: 'Base Sepolia',
      environment: 'testnet', explorer: 'https://sepolia.basescan.org', status: 'active',
      contracts: { anchor: { address: '0xB', verified: true } },
    },
    {
      id: 'arbitrum-sepolia', chainId: 421614, family: 'evm', displayName: 'Arbitrum Sepolia',
      environment: 'testnet', explorer: 'https://sepolia.arbiscan.io', status: 'active',
      contracts: { anchor: { address: '0xC', verified: true } },
    },
    {
      id: 'solana-devnet', chainId: null, family: 'solana', displayName: 'Solana Devnet',
      environment: 'testnet', explorer: 'https://explorer.solana.com', status: 'active',
      contracts: { anchor: { address: 'SoL', verified: false } },
    },
  ],
};

const BALANCE = {
  currency: 'USD', available_usd: '5.000000', held_usd: '0.000000',
  credit_limit_usd: '0.000000', spendable_usd: '5.000000', status: 'active',
};
const OBLIGATIONS = {
  pending_intents: 0, remaining_usd: '5.000000', uncovered_usd: '0.000000', spendable_usd: '5.000000',
};
const PORTFOLIO = {
  identities: [{
    adi_url: 'acc://mybot.acme',
    status: 'active',
    credit_balance: 500,
    chains: [{
      chain_id: 'base-sepolia', address: '0xAbs', deployed: true,
      balances: [{ token: 'ETH', balance: '1000000000000000' }],
    }],
    pending_actions: 0,
  }],
  total_chains: 1,
};

/** A gateway where everything is healthy. Individual cases override one route at a time. */
function healthy(over: Record<string, unknown> = {}): Handler {
  return (req, res) => {
    const url = (req.url ?? '').split('?')[0];
    if (url in over) return json(res, 200, over[url]);
    if (url === '/v1/chains') return json(res, 200, CHAINS);
    if (url.startsWith('/v1/chains/')) {
      const id = url.split('/').pop();
      const chain = CHAINS.chains.find((c) => c.id === id || String(c.chainId) === id);
      return chain ? json(res, 200, { chain }) : json(res, 404, { error: { message: 'no such chain' } });
    }
    if (url === '/v1/billing/balance') return json(res, 200, BALANCE);
    if (url === '/v1/billing/obligations') return json(res, 200, OBLIGATIONS);
    if (url === '/v1/portfolio') return json(res, 200, PORTFOLIO);
    if (url === '/v1/transactions') return json(res, 200, { transactions: [] });
    if (url === '/v1/admin/usage') return json(res, 403, { error: { message: 'no scope' } });
    return json(res, 404, {});
  };
}

describe('certen chains', () => {
  it('works with no API key — the first useful command a new user can run', async () => {
    const stub = await stubGateway(healthy());
    try {
      const r = await certen(['--json', 'chains'], stub.url);
      expect(r.code).toBe(0);
      const rows = soleJson(r.stdout).data as Array<{ id: string }>;
      // Filtered to what this CLI targets, not everything the gateway serves.
      expect(rows.map((x) => x.id)).toEqual(['ethereum-sepolia', 'base-sepolia', 'arbitrum-sepolia']);
    } finally {
      await stub.close();
    }
  });

  it('--all shows the chains outside the target set too', async () => {
    const stub = await stubGateway(healthy());
    try {
      const r = await certen(['--json', 'chains', '--all'], stub.url);
      const rows = soleJson(r.stdout).data as Array<{ id: string }>;
      expect(rows.map((x) => x.id)).toContain('solana-devnet');
    } finally {
      await stub.close();
    }
  });

  // Two subprocess spawns where every other case here makes one, against vitest's 5s default. It
  // passed alone and failed inside the full suite under load — a flake that says nothing about the
  // behaviour under test, which is the resolution, never a duration.
  it('resolves one chain by registry id and by numeric chain id alike', async () => {
    const stub = await stubGateway(healthy());
    try {
      const bySlug = await certen(['--json', 'chains', 'base-sepolia'], stub.url);
      const byNumber = await certen(['--json', 'chains', '84532'], stub.url);
      expect((soleJson(bySlug.stdout).data as { id: string }).id).toBe('base-sepolia');
      expect((soleJson(byNumber.stdout).data as { id: string }).id).toBe('base-sepolia');
    } finally {
      await stub.close();
    }
  }, 20_000);

  it('reports an unknown chain as a failed lookup, not a broken gateway', async () => {
    const stub = await stubGateway(healthy());
    try {
      const r = await certen(['--json', 'chains', 'nosuchchain'], stub.url);
      expect(r.code).toBe(1);
      expect((soleJson(r.stdout).error as { code: string }).code).toBe('UNKNOWN_CHAIN');
    } finally {
      await stub.close();
    }
  });
});

describe('certen doctor', () => {
  it('reports every check, in the same order, when everything is healthy', async () => {
    const stub = await stubGateway(healthy());
    try {
      const r = await certen(['--json', 'doctor'], stub.url, 'ck_live_test', { withLocalKey: true });
      expect(r.code).toBe(0);
      const data = soleJson(r.stdout).data as { ok: boolean; checks: Array<{ name: string; status: string }> };
      expect(data.ok).toBe(true);
      expect(data.checks).toHaveLength(8);
      expect(data.checks.every((c) => c.status === 'ok' || c.status === 'warn')).toBe(true);
    } finally {
      await stub.close();
    }
  });

  it('keeps the check list the same length when checks are skipped', async () => {
    // No API key: four checks cannot run. They must still appear, marked skipped — a list whose
    // length depends on how far the run got is one a caller cannot index into, and reads to a
    // human as "that check does not exist".
    const stub = await stubGateway(healthy());
    try {
      const r = await certen(['--json', 'doctor'], stub.url);
      expect(r.code).toBe(1);
      const checks = (soleJson(r.stdout).error as { details: { checks: Array<{ name: string; status: string }> } })
        .details.checks;
      expect(checks).toHaveLength(8);
      expect(checks.filter((c) => c.status === 'skipped')).toHaveLength(5);
    } finally {
      await stub.close();
    }
  });

  it('carries every check on a FAILING run, so the diagnosis survives the failure signal', async () => {
    const stub = await stubGateway(healthy());
    try {
      const r = await certen(['--json', 'doctor'], stub.url);
      const err = soleJson(r.stdout).error as { code: string; details?: { checks: unknown[] } };
      expect(err.code).toBe('DOCTOR_CHECKS_FAILED');
      // The whole point of the `details` key: a caller must not have to choose between knowing
      // that something is broken and knowing what.
      expect(err.details?.checks).toBeDefined();
      expect((err.details!.checks as unknown[]).length).toBe(8);
    } finally {
      await stub.close();
    }
  });

  it('exits 3 when the gateway is unreachable — not 1', async () => {
    // Discard port: refuses immediately, no network needed. Nothing was submitted, and a retry is
    // worth attempting; that is what 3 promises and 1 does not.
    const r = await certen(['--json', 'doctor'], 'http://127.0.0.1:9', 'ck_live_test');
    expect(r.code).toBe(3);
    const err = soleJson(r.stdout).error as { code: string; retryable: boolean };
    expect(err.code).toBe('NETWORK_ERROR');
    expect(err.retryable).toBe(true);
  });

  it('flags an unfunded abstract account as a warning with the faucet', async () => {
    const empty = {
      ...PORTFOLIO,
      identities: [{
        ...PORTFOLIO.identities[0],
        chains: [{ chain_id: 'base-sepolia', address: '0xAbs', deployed: true, balances: [{ token: 'ETH', balance: '0' }] }],
      }],
    };
    const stub = await stubGateway(healthy({ '/v1/portfolio': empty }));
    try {
      const r = await certen(['--json', 'doctor'], stub.url, 'ck_live_test', { withLocalKey: true });
      // A warning, not a failure: the setup works, and a contract call that forwards no value is
      // unaffected. Exiting non-zero here would block work that would have succeeded.
      expect(r.code).toBe(0);
      const checks = (soleJson(r.stdout).data as { checks: Array<{ name: string; status: string; fix?: string }> }).checks;
      const funding = checks.find((c) => c.name === 'abstract accounts funded')!;
      expect(funding.status).toBe('warn');
      expect(funding.fix).toContain('faucet');
    } finally {
      await stub.close();
    }
  });

  it('fails when the balance is entirely committed to pending intents', async () => {
    // The balance reads healthy while every cent is claimed by intents awaiting quorum.
    // `remaining_usd` is the number that decides whether new work is accepted.
    const committed = { ...OBLIGATIONS, pending_intents: 3, remaining_usd: '0.000000' };
    const stub = await stubGateway(healthy({ '/v1/billing/obligations': committed }));
    try {
      const r = await certen(['--json', 'doctor'], stub.url, 'ck_live_test');
      expect(r.code).toBe(1);
      const checks = (soleJson(r.stdout).error as { details: { checks: Array<{ name: string; status: string }> } })
        .details.checks;
      expect(checks.find((c) => c.name === 'billing balance')!.status).toBe('fail');
    } finally {
      await stub.close();
    }
  });

  it('prints only the first blocking problem by default, and all of them with --all', async () => {
    const stub = await stubGateway(healthy());
    try {
      const brief = await certen(['doctor'], stub.url);
      const full = await certen(['doctor', '--all'], stub.url);
      const briefOut = brief.stdout + brief.stderr;
      const fullOut = full.stdout + full.stderr;
      // Triage is the part that needs expertise; doing it for the reader is the whole design.
      expect(briefOut).toContain('api key');
      expect(briefOut).not.toContain('credit / trial');
      expect(fullOut).toContain('credit / trial');
    } finally {
      await stub.close();
    }
  });
});

describe('certen whoami', () => {
  it('reports the key, the gateway, and the standing that key actually has', async () => {
    const stub = await stubGateway(healthy());
    try {
      const r = await certen(['--json', 'whoami'], stub.url, 'ck_live_test');
      expect(r.code).toBe(0);
      const data = soleJson(r.stdout).data as {
        api_url: string; key_prefix: string; account_status: string;
        organization: string; scopes_observed: Record<string, boolean>;
      };
      expect(data.api_url).toBe(stub.url);
      expect(data.key_prefix).toBe('ck_live_test...');
      expect(data.account_status).toBe('active');
      // Honesty about the API surface: no endpoint returns the org name to a machine key, so the
      // field says where it lives rather than being silently absent or plausibly invented.
      expect(data.organization).toMatch(/portal/);
      // The stub answers 403 for admin usage, so the observed scope must reflect that.
      expect(data.scopes_observed['billing:read']).toBe(true);
      expect(data.scopes_observed['admin:read']).toBe(false);
    } finally {
      await stub.close();
    }
  });

  it('is a usage error when no key is configured at all', async () => {
    const stub = await stubGateway(healthy());
    try {
      const r = await certen(['--json', 'whoami'], stub.url);
      expect(r.code).toBe(2);
      expect((soleJson(r.stdout).error as { code: string }).code).toBe('NO_API_KEY');
    } finally {
      await stub.close();
    }
  });
});
