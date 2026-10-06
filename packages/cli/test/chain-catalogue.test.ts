import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// The chain cache lives under the home directory. Vitest runs this file in a worker thread, where
// assigning process.env.HOME/USERPROFILE does not reach os.homedir(), so the home directory is
// redirected here instead: these cases must never read or write the real ~/.certen.
const fakeHome = vi.hoisted(() => ({ dir: '' }));
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  const homedir = (): string => {
    if (!fakeHome.dir) throw new Error('test home not set');
    return fakeHome.dir;
  };
  return { ...actual, default: { ...actual, homedir }, homedir };
});
const { tmpdir } = await vi.importActual<typeof import('node:os')>('node:os');
import type { CertenClient } from '@certen.io/sdk';
import {
  SUPPORTED_CHAINS, assertChain, assertChains, isSupportedChain, chainIdFor, normalizeChain, nearestChain,
  enabledChains, writeChainCache, readChainCache,
} from '../src/chains.js';
import { estimateWait } from '../src/payment-uri.js';
import { faucetFor, assertFundedForValue } from '../src/funding-guard.js';

/**
 * The CLI's chain vocabulary now derives from the SDK's chain catalogue, and Telcoin Adiri (2017)
 * is in it — off by default, enabled only by configuration AND the gateway serving it.
 *
 * Each case below states what the code did before this change, so the test is a regression pin for
 * the three live chains and a fail-before/pass-after for 2017.
 */

const saved: Record<string, string | undefined> = {};
const VARS = ['CERTEN_ENABLED_CHAINS', 'CERTEN_ALLOW_ANY_CHAIN'];

beforeEach(() => {
  for (const v of VARS) saved[v] = process.env[v];
  fakeHome.dir = mkdtempSync(join(tmpdir(), 'certen-catalogue-'));
  delete process.env.CERTEN_ENABLED_CHAINS;
  delete process.env.CERTEN_ALLOW_ANY_CHAIN;
});

afterEach(() => {
  for (const v of VARS) {
    if (saved[v] === undefined) delete process.env[v];
    else process.env[v] = saved[v];
  }
});

const SERVED_3 = [
  { id: 'ethereum-sepolia', chainId: 11155111 },
  { id: 'base-sepolia', chainId: 84532 },
  { id: 'arbitrum-sepolia', chainId: 421614 },
];
const ADIRI = { id: 'telcoin-adiri', chainId: 2017 };
const ENABLE_ADIRI = 'ethereum-sepolia,base-sepolia,arbitrum-sepolia,telcoin-adiri';

describe('the three live chains are unchanged', () => {
  it('are the default set, accepted with or without a gateway cache', () => {
    expect([...SUPPORTED_CHAINS]).toEqual(['ethereum-sepolia', 'base-sepolia', 'arbitrum-sepolia']);
    expect(enabledChains()).toEqual([...SUPPORTED_CHAINS]);
    for (const chain of SUPPORTED_CHAINS) expect(assertChain(chain)).toBe(chain);
    writeChainCache(SERVED_3);
    for (const chain of SUPPORTED_CHAINS) expect(assertChain(chain)).toBe(chain);
  });

  it('keep their ids, numeric spellings, aliases, faucets and wait estimates', () => {
    expect(chainIdFor('ethereum-sepolia')).toBe(11155111);
    expect(chainIdFor('base-sepolia')).toBe(84532);
    expect(chainIdFor('arbitrum-sepolia')).toBe(421614);
    expect(normalizeChain('11155111')).toBe('ethereum-sepolia');
    expect(normalizeChain(84532)).toBe('base-sepolia');
    expect(nearestChain('arb')).toBe('arbitrum-sepolia');
    expect(nearestChain('mainnet')).toBe('ethereum-sepolia');
    expect(faucetFor('base-sepolia')).toBe('https://www.alchemy.com/faucets/base-sepolia');
    expect(estimateWait('ethereum-sepolia', 3)).toEqual({ seconds: 36, text: 'about 36 seconds', basis: 'ethereum-sepolia', lowerBound: false });
    expect(estimateWait('base-sepolia', 3)?.seconds).toBe(6);
  });

  it('are still refused when the gateway, per a fresh cache, positively does not serve them', () => {
    writeChainCache([SERVED_3[0], SERVED_3[2]]);
    expect(() => assertChain('base-sepolia')).toThrowError(/the gateway does not serve it/);
  });
});

describe('Telcoin Adiri (2017): off by default, on with configuration AND the gateway', () => {
  it('is refused by default, by name, with how to enable it', () => {
    // Before: "telcoin-adiri" is not a supported chain (it was not in any table).
    expect(isSupportedChain('telcoin-adiri')).toBe(false);
    expect(() => assertChain('telcoin-adiri')).toThrowError(
      /telcoin-adiri \(Telcoin Adiri \(testnet\), chain 2017\) is not enabled.*CERTEN_ENABLED_CHAINS=ethereum-sepolia,base-sepolia,arbitrum-sepolia,telcoin-adiri/,
    );
    expect(() => assertChains('base-sepolia,telcoin-adiri')).toThrowError(/is not enabled/);
  });

  it('is accepted when enabled and the gateway serves it', () => {
    process.env.CERTEN_ENABLED_CHAINS = ENABLE_ADIRI;
    writeChainCache([...SERVED_3, ADIRI]);
    expect(assertChain('telcoin-adiri')).toBe('telcoin-adiri');
    expect(assertChains('base-sepolia,telcoin-adiri')).toEqual(['base-sepolia', 'telcoin-adiri']);
  });

  it('is refused when enabled but the gateway does not serve it, or lists it disabled', () => {
    process.env.CERTEN_ENABLED_CHAINS = ENABLE_ADIRI;
    writeChainCache(SERVED_3);
    expect(() => assertChain('telcoin-adiri')).toThrowError(/the gateway does not serve it/);
    writeChainCache([...SERVED_3, { ...ADIRI, enabled: false }]);
    expect(readChainCache()?.disabled).toEqual(['telcoin-adiri']);
    expect(() => assertChain('telcoin-adiri')).toThrowError(/the gateway does not serve it/);
  });

  it('is refused when enabled but there is no fresh answer from the gateway', () => {
    process.env.CERTEN_ENABLED_CHAINS = ENABLE_ADIRI;
    expect(() => assertChain('telcoin-adiri')).toThrowError(/whether the gateway serves it is not known/);
    // A stale cache is not an answer.
    const dir = join(fakeHome.dir, '.certen');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'chains.json'), JSON.stringify({
      fetched_at: '2020-01-01T00:00:00Z', ids: ['telcoin-adiri'], numeric: { 2017: 'telcoin-adiri' },
    }));
    expect(() => assertChain('telcoin-adiri')).toThrowError(/not known/);
  });

  it('refuses a misconfigured enable list by name', () => {
    process.env.CERTEN_ENABLED_CHAINS = 'base-sepolia,telcoin-adri';
    expect(() => assertChain('base-sepolia')).toThrowError(/CERTEN_ENABLED_CHAINS: "telcoin-adri" is not a chain/);
    process.env.CERTEN_ENABLED_CHAINS = 'optimism-sepolia';
    expect(() => assertChain('base-sepolia')).toThrowError(/retired/);
  });

  it('has its id, numeric spelling, faucet and a 7 s-per-block wait that is labelled a lower bound', () => {
    expect(chainIdFor('telcoin-adiri')).toBe(2017);
    expect(normalizeChain('2017')).toBe('telcoin-adiri');
    expect(nearestChain('adiri')).toBe('telcoin-adiri');
    expect(faucetFor('telcoin-adiri')).toBe('https://www.telcoin.network/faucet');
    // Before: null (no cadence known). Adiri makes blocks only when there is traffic, so a block
    // count is a floor on the wait, never a promise.
    expect(estimateWait('telcoin-adiri', 3)).toEqual({
      seconds: 21, text: 'at least about 21 seconds', basis: 'telcoin-adiri', lowerBound: true,
    });
  });
});

// ── the funding guard (both of its balance sources) ────────────────────────────────────────────

const ABS = '0xAbs';
function fakeClient(chainId: string, balances: Array<{ token?: string; balance: string }>): CertenClient {
  return {
    portfolio: {
      get: async () => ({
        identities: [{ chains: [{ chain_id: chainId, address: ABS, deployed: true, balances }] }],
      }),
    },
  } as unknown as CertenClient;
}
const VALUE = { amount: '1' };

async function refusal(p: Promise<void>): Promise<{ code: string; message: string } | null> {
  try { await p; return null; } catch (e) { return e as { code: string; message: string }; }
}

describe('the CLI funding guard reads each chain\'s own gas token', () => {
  it('refuses an empty TEL account on 2017, from the portfolio and from known balances', async () => {
    // Before: the guard looked for an ETH row, found none, and let the intent through.
    const fromPortfolio = await refusal(assertFundedForValue(fakeClient('2017', [{ token: 'TEL', balance: '0' }]), 'id', 'telcoin-adiri', VALUE, false));
    expect(fromPortfolio?.code).toBe('ABSTRACT_ACCOUNT_UNFUNDED');
    expect(fromPortfolio?.message).toContain('https://www.telcoin.network/faucet');
    expect(fromPortfolio?.message).toContain('testnet gas');

    const fromKnown = await refusal(assertFundedForValue(fakeClient('x', []), 'id', 'telcoin-adiri', VALUE, false,
      [{ chain_id: '2017', address: ABS, token: 'TEL', balance: '0' }]));
    expect(fromKnown?.code).toBe('ABSTRACT_ACCOUNT_UNFUNDED');
  });

  it('allows a funded TEL account on 2017', async () => {
    expect(await refusal(assertFundedForValue(fakeClient('telcoin-adiri', [{ token: 'TEL', balance: '1' }]), 'id', 'telcoin-adiri', VALUE, false))).toBeNull();
  });

  it('refuses by name when 2017 reports only an ETH row', async () => {
    const r = await refusal(assertFundedForValue(fakeClient('2017', [{ token: 'ETH', balance: '9' }]), 'id', 'telcoin-adiri', VALUE, false));
    expect(r?.code).toBe('ABSTRACT_ACCOUNT_FUNDING_UNVERIFIABLE');
    expect(r?.message).toMatch(/gas token is TEL/);
    expect(r?.message).toMatch(/--force/);
  });

  it('refuses by name on a chain whose gas token is unknown, without reading anything', async () => {
    let reads = 0;
    const client = { portfolio: { get: async () => { reads += 1; return { identities: [] }; } } } as unknown as CertenClient;
    const r = await refusal(assertFundedForValue(client, 'id', 'solana-devnet', VALUE, false));
    expect(r?.code).toBe('ABSTRACT_ACCOUNT_FUNDING_UNVERIFIABLE');
    expect(r?.message).toMatch(/"solana-devnet"/);
    expect(reads).toBe(0);
  });

  it('refuses by name when the balance is unreadable (was: "holds no gas", which was not known)', async () => {
    const r = await refusal(assertFundedForValue(fakeClient('ethereum-sepolia', [{ token: '', balance: 'unavailable' }]), 'id', 'ethereum-sepolia', VALUE, false));
    expect(r?.code).toBe('ABSTRACT_ACCOUNT_FUNDING_UNVERIFIABLE');
    expect(r?.message).toMatch(/could not read the ETH balance/);
  });

  it('--force still bypasses it', async () => {
    expect(await refusal(assertFundedForValue(fakeClient('2017', [{ token: 'TEL', balance: '0' }]), 'id', 'telcoin-adiri', VALUE, true))).toBeNull();
  });

  it('leaves the live chains as they were', async () => {
    for (const [chainId, chain] of [['ethereum-sepolia', 'ethereum-sepolia'], ['84532', 'base-sepolia'], ['421614', 'arbitrum-sepolia']]) {
      expect((await refusal(assertFundedForValue(fakeClient(chainId, [{ token: 'ETH', balance: '0' }]), 'id', chain, VALUE, false)))?.code)
        .toBe('ABSTRACT_ACCOUNT_UNFUNDED');
      expect(await refusal(assertFundedForValue(fakeClient(chainId, [{ token: 'ETH', balance: '1' }]), 'id', chain, VALUE, false))).toBeNull();
      // Not in the portfolio, or nothing reported yet: proceeds, as before.
      expect(await refusal(assertFundedForValue(fakeClient('other', []), 'id', chain, VALUE, false))).toBeNull();
      expect(await refusal(assertFundedForValue(fakeClient(chainId, []), 'id', chain, VALUE, false))).toBeNull();
    }
  });
});
