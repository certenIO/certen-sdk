import { describe, it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { AddressInfo } from 'node:net';

/**
 * `certen portfolio` and `certen init` read each chain's OWN gas token, run as the real binary.
 *
 * Both used to find the gas row by matching `ETH` on every chain. On Telcoin Adiri (2017), whose
 * gas is TEL, that meant `portfolio` never warned about an empty account and `init` reported every
 * account as unfunded however much it held.
 */

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'index.js');
const run = promisify(execFile);

interface Stub { url: string; posts: () => number; close: () => Promise<void> }

async function stubGateway(handler: (req: http.IncomingMessage, res: http.ServerResponse, body: string) => void): Promise<Stub> {
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

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body));
}

/** A home whose chain cache says the gateway serves the three live chains and 2017. */
function homeServingAdiri(): string {
  const home = mkdtempSync(join(tmpdir(), 'certen-gas-'));
  mkdirSync(join(home, '.certen'), { recursive: true });
  writeFileSync(join(home, '.certen', 'chains.json'), JSON.stringify({
    fetched_at: new Date().toISOString(),
    ids: ['ethereum-sepolia', 'base-sepolia', 'arbitrum-sepolia', 'telcoin-adiri'],
    numeric: { 11155111: 'ethereum-sepolia', 84532: 'base-sepolia', 421614: 'arbitrum-sepolia', 2017: 'telcoin-adiri' },
    disabled: [],
  }));
  return home;
}

async function certen(args: string[], apiUrl: string, home: string, extra: Record<string, string> = {}) {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    HOME: home,
    USERPROFILE: home,
    CERTEN_API_URL: apiUrl,
    CERTEN_API_KEY: 'ck_live_test',
    ...extra,
  };
  delete env.CERTEN_ALLOW_ANY_CHAIN;
  try {
    const { stdout, stderr } = await run(process.execPath, [CLI, ...args], { env, encoding: 'utf8', cwd: home });
    return { stdout, stderr, code: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: number };
    return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', code: e.code ?? -1 };
  }
}

const portfolioOf = (chains: unknown[]) => ({
  identities: [{ adi_url: 'acc://bot.acme', status: 'active', credit_balance: 500, pending_actions: 0, chains }],
  total_chains: chains.length,
});

describe('certen portfolio warns by each chain\'s own gas token', () => {
  it('warns about an empty TEL account on 2017, and names gas it cannot verify', async () => {
    const stub = await stubGateway((req, res) => {
      if ((req.url ?? '').startsWith('/v1/portfolio')) {
        return json(res, 200, portfolioOf([
          { chain_id: '2017', address: '0xT', deployed: true, balances: [{ token: 'TEL', balance: '0' }] },
          { chain_id: 'base-sepolia', address: '0xB', deployed: true, balances: [{ token: 'ETH', balance: '0' }] },
          { chain_id: 'arbitrum-sepolia', address: '0xA', deployed: true, balances: [{ token: 'ETH', balance: '3' }] },
          { chain_id: 'solana-devnet', address: 'So1', deployed: true, balances: [{ token: 'SOL', balance: '3' }] },
        ]));
      }
      return json(res, 404, {});
    });
    try {
      const r = await certen(['portfolio'], stub.url, mkdtempSync(join(tmpdir(), 'certen-gas-')));
      expect(r.code).toBe(0);
      const out = r.stdout + r.stderr;
      // Before: only base-sepolia was listed; the TEL row was never recognised as gas.
      expect(out).toMatch(/Abstract accounts with no gas on: telcoin-adiri, base-sepolia\./);
      expect(out).toContain('https://www.telcoin.network/faucet');
      expect(out).toMatch(/does not know the native gas token of "solana-devnet"/);
      expect(out).not.toMatch(/arbitrum-sepolia: https/);
    } finally {
      await stub.close();
    }
  });
});

describe('certen init reads 2017 gas as TEL', () => {
  const ID = 'new-id-1';
  function initGateway(balances: Array<{ token: string; balance: string }>) {
    return (req: http.IncomingMessage, res: http.ServerResponse) => {
      const url = (req.url ?? '').split('?')[0];
      if (url === '/v1/identity' && req.method === 'POST') {
        return json(res, 202, { id: ID, adi_url: 'acc://fresh.acme', status: 'creating', can_sign: null });
      }
      if (url === `/v1/identity/${ID}`) {
        return json(res, 200, {
          id: ID, adi_url: 'acc://fresh.acme', status: 'active', can_sign: true, credit_balance: 500,
          chain_accounts: [{ chain_id: '2017', address: '0xNew', status: 'deployed' }],
        });
      }
      if (url === '/v1/portfolio') {
        return json(res, 200, portfolioOf([{ chain_id: '2017', address: '0xNew', deployed: true, balances }]));
      }
      if (url === '/v1/billing/balance') {
        return json(res, 200, {
          currency: 'USD', available_usd: '5.000000', held_usd: '0.000000', credit_limit_usd: '0.000000',
          spendable_usd: '5.000000', status: 'active', remaining_usd: '5.000000',
        });
      }
      return json(res, 404, {});
    };
  }

  async function init(balances: Array<{ token: string; balance: string }>) {
    const home = homeServingAdiri();
    const stub = await stubGateway(initGateway(balances));
    try {
      const env = { CERTEN_ENABLED_CHAINS: 'base-sepolia,telcoin-adiri' };
      await certen(['keys', 'generate', '--name', 'dev', '--no-passphrase'], stub.url, home, env);
      const r = await certen(
        ['--json', 'init', '--yes', '--name', 'fresh', '--chains', 'telcoin-adiri', '--poll-interval', '0.05'],
        stub.url, home, env,
      );
      expect(r.code).toBe(0);
      return JSON.parse(r.stdout.trim()).data as { unfunded_chains: string[]; steps: Array<{ step: string; detail: string }> };
    } finally {
      await stub.close();
    }
  }

  it('reports a funded TEL account as funded (before: always "needs gas")', async () => {
    const data = await init([{ token: 'TEL', balance: '5' }]);
    expect(data.unfunded_chains).toEqual([]);
    expect(data.steps.find((s) => s.step === 'funding')!.detail).toBe('abstract accounts have gas');
  });

  it('reports an empty TEL account as needing gas', async () => {
    const data = await init([{ token: 'TEL', balance: '0' }]);
    expect(data.unfunded_chains).toEqual(['telcoin-adiri']);
  });

  it('names an ETH-labelled row on 2017 as unverifiable, and still asks for gas', async () => {
    const data = await init([{ token: 'ETH', balance: '5' }]);
    expect(data.unfunded_chains).toEqual(['telcoin-adiri']);
    expect(data.steps.find((s) => s.step === 'funding')!.detail).toMatch(/cannot verify gas: .*gas token is TEL/);
  });

  it('refuses 2017 in --chains when it is not enabled, before creating anything', async () => {
    const home = homeServingAdiri();
    const stub = await stubGateway(initGateway([]));
    try {
      const r = await certen(['--json', 'init', '--yes', '--chains', 'telcoin-adiri'], stub.url, home);
      expect(r.code).toBe(2);
      expect(JSON.parse(r.stdout.trim()).error.code).toBe('UNSUPPORTED_CHAIN');
      expect(stub.posts()).toBe(0);
    } finally {
      await stub.close();
    }
  });
});
