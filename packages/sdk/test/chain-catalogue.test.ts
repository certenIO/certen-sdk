import { describe, it, expect } from 'vitest';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import {
  CertenClient, CHAIN_CATALOGUE, chainInfo, chainSlug, nativeSymbolFor, faucetForChain, defaultEnabledChains,
  enablableChains, parseEnabledChains, ChainConfigurationError, chainAvailability, resolveEnabledChains,
  readNativeBalance, describeUnverifiable, normalizeChainId,
} from '../src/index.js';

/**
 * The chain catalogue is the single source every chain table in the SDK, the CLI and the MCP
 * server derives from. What is pinned here:
 *
 * - the three live chains are exactly what they were (slug, id, ETH, cadence, faucet, aliases);
 * - Telcoin Adiri (2017) is a testnet whose gas is TEL, off by default;
 * - "enabled" is configuration ∩ what the gateway serves — the SDK never offers a chain the
 *   gateway does not serve;
 * - the native balance is found by the chain's own symbol, and an unidentifiable one is named.
 */

describe('the catalogue', () => {
  it('keeps the three live chains exactly as they were', () => {
    expect(defaultEnabledChains()).toEqual(['ethereum-sepolia', 'base-sepolia', 'arbitrum-sepolia']);
    const live = CHAIN_CATALOGUE.filter((c) => c.support === 'live').map((c) => ({
      slug: c.slug, chainId: c.chainId, nativeSymbol: c.nativeSymbol, nativeDecimals: c.nativeDecimals,
      blockSeconds: c.blockSeconds, blocksOnlyWithTraffic: c.blocksOnlyWithTraffic, faucet: c.faucet,
      enabledByDefault: c.enabledByDefault,
    }));
    expect(live).toEqual([
      { slug: 'ethereum-sepolia', chainId: 11155111, nativeSymbol: 'ETH', nativeDecimals: 18, blockSeconds: 12,
        blocksOnlyWithTraffic: false, faucet: 'https://sepoliafaucet.com', enabledByDefault: true },
      { slug: 'base-sepolia', chainId: 84532, nativeSymbol: 'ETH', nativeDecimals: 18, blockSeconds: 2,
        blocksOnlyWithTraffic: false, faucet: 'https://www.alchemy.com/faucets/base-sepolia', enabledByDefault: true },
      { slug: 'arbitrum-sepolia', chainId: 421614, nativeSymbol: 'ETH', nativeDecimals: 18, blockSeconds: 0.25,
        blocksOnlyWithTraffic: false, faucet: 'https://www.alchemy.com/faucets/arbitrum-sepolia', enabledByDefault: true },
    ]);
  });

  it('holds Telcoin Adiri: chain 2017, a testnet, gas TEL with 18 decimals, off by default', () => {
    const adiri = chainInfo(2017)!;
    expect(adiri).toMatchObject({
      slug: 'telcoin-adiri', chainId: 2017, environment: 'testnet', nativeSymbol: 'TEL', nativeDecimals: 18,
      blockSeconds: 7, blocksOnlyWithTraffic: true, support: 'opt-in', enabledByDefault: false,
    });
    expect(adiri.displayName).toMatch(/testnet/);
    expect(chainInfo('telcoin-adiri')).toBe(adiri);
    expect(faucetForChain('2017')).toBe('https://www.telcoin.network/faucet');
  });

  it('resolves every numeric id the SDK resolved before, plus 2017', () => {
    // These five were the SDK's NUMERIC_CHAIN_IDS before the catalogue; an older gateway may still
    // return any of them as a numeric chain_id.
    expect(chainSlug('11155111')).toBe('ethereum-sepolia');
    expect(chainSlug(84532)).toBe('base-sepolia');
    expect(chainSlug('421614')).toBe('arbitrum-sepolia');
    expect(chainSlug('11155420')).toBe('optimism-sepolia');
    expect(chainSlug('80002')).toBe('polygon-amoy');
    expect(normalizeChainId('2017')).toBe('telcoin-adiri');
    expect(normalizeChainId(' base-sepolia ')).toBe('base-sepolia');
    expect(normalizeChainId('solana-devnet')).toBe('solana-devnet');
    expect(normalizeChainId(null)).toBe('');
  });

  it('names each chain\'s own gas token, and nothing for a chain it does not know', () => {
    expect(nativeSymbolFor('base-sepolia')).toBe('ETH');
    expect(nativeSymbolFor('2017')).toBe('TEL');
    expect(nativeSymbolFor('polygon-amoy')).toBe('POL');
    expect(nativeSymbolFor('solana-devnet')).toBeUndefined();
  });

  it('is frozen, so no caller can widen it at runtime', () => {
    expect(Object.isFrozen(CHAIN_CATALOGUE)).toBe(true);
    expect(Object.isFrozen(CHAIN_CATALOGUE[0])).toBe(true);
  });
});

describe('the enabled set: configuration', () => {
  it('defaults to the live chains when unset or blank', () => {
    expect(parseEnabledChains(undefined)).toEqual(defaultEnabledChains());
    expect(parseEnabledChains('  ')).toEqual(defaultEnabledChains());
  });

  it('enables 2017 when configuration names it (by slug or id)', () => {
    expect(parseEnabledChains('base-sepolia, telcoin-adiri')).toEqual(['base-sepolia', 'telcoin-adiri']);
    expect(parseEnabledChains('2017')).toEqual(['telcoin-adiri']);
  });

  it('refuses an unknown or retired chain by name', () => {
    expect(() => parseEnabledChains('base-sepolia,solana-devnet')).toThrow(ChainConfigurationError);
    expect(() => parseEnabledChains('solana-devnet')).toThrow(/"solana-devnet" is not a chain this client knows/);
    expect(() => parseEnabledChains('optimism-sepolia')).toThrow(/retired/);
    expect(enablableChains()).not.toContain('optimism-sepolia');
  });
});

describe('the enabled set: configuration ∩ what the gateway serves', () => {
  const SERVED_3 = [
    { id: 'ethereum-sepolia', chainId: 11155111 },
    { id: 'base-sepolia', chainId: 84532 },
    { id: 'arbitrum-sepolia', chainId: 421614 },
  ];
  const withAdiri = [...defaultEnabledChains(), 'telcoin-adiri'];

  it('refuses 2017 by default, even when the gateway serves it', () => {
    const served = [...SERVED_3, { id: 'telcoin-adiri', chainId: 2017 }];
    expect(chainAvailability('telcoin-adiri', defaultEnabledChains(), served).state).toBe('not-configured');
    expect(resolveEnabledChains(defaultEnabledChains(), served).map((c) => c.slug))
      .toEqual(['ethereum-sepolia', 'base-sepolia', 'arbitrum-sepolia']);
  });

  it('accepts 2017 when enabled AND served', () => {
    const served = [...SERVED_3, { id: 'telcoin-adiri', chainId: 2017 }];
    expect(chainAvailability('telcoin-adiri', withAdiri, served).state).toBe('enabled');
    expect(resolveEnabledChains(withAdiri, served).map((c) => c.slug)).toContain('telcoin-adiri');
  });

  it('never offers 2017 when the gateway does not list it, or lists it disabled', () => {
    expect(chainAvailability('telcoin-adiri', withAdiri, SERVED_3).state).toBe('not-served');
    const disabled = [...SERVED_3, { id: 'telcoin-adiri', chainId: 2017, enabled: false }];
    expect(chainAvailability('telcoin-adiri', withAdiri, disabled).state).toBe('not-served');
    expect(resolveEnabledChains(withAdiri, disabled).map((c) => c.slug)).not.toContain('telcoin-adiri');
  });

  it('matches a served entry by numeric id as well as by slug', () => {
    expect(chainAvailability('telcoin-adiri', withAdiri, [{ id: '2017', chainId: 2017 }]).state).toBe('enabled');
  });

  it('names unknown and retired chains as such', () => {
    expect(chainAvailability('solana-devnet', withAdiri).state).toBe('unknown');
    expect(chainAvailability('polygon-amoy', withAdiri).state).toBe('retired');
  });

  it('offline (gateway not consulted) is the configured set', () => {
    expect(resolveEnabledChains(withAdiri).map((c) => c.slug)).toEqual(withAdiri);
  });

  it('client.chains.enabled() narrows to what the live gateway serves', async () => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
        version: '2', last_updated: '2026-10-05', accumulate: {}, count: 4,
        chains: [
          ...SERVED_3.map((c) => ({ ...c, family: 'evm', displayName: c.id, environment: 'testnet', explorer: '', status: 'active', contracts: {} })),
          { id: 'telcoin-adiri', chainId: 2017, family: 'evm', displayName: 'Adiri', environment: 'testnet', explorer: '', status: 'active', contracts: {}, enabled: false },
        ],
      }));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    try {
      const client = new CertenClient({ apiKey: 'ck_live_test', baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, maxRetries: 0 });
      expect((await client.chains.enabled()).map((c) => c.slug)).toEqual(['ethereum-sepolia', 'base-sepolia', 'arbitrum-sepolia']);
      expect((await client.chains.enabled(withAdiri)).map((c) => c.slug)).not.toContain('telcoin-adiri');
    } finally {
      server.close();
    }
  });
});

describe('reading the native balance by the chain\'s own symbol', () => {
  it('reads ETH on the live chains exactly as before', () => {
    expect(readNativeBalance('base-sepolia', [{ token: 'ETH', balance: '0' }]).state).toBe('empty');
    expect(readNativeBalance('84532', [{ token: 'ETH', balance: '0.5' }]).state).toBe('funded');
    expect(readNativeBalance('base-sepolia', [{ token: 'native', balance: '1' }]).state).toBe('funded');
    expect(readNativeBalance('base-sepolia', [{ balance: '0' }]).state).toBe('empty');
    expect(readNativeBalance('base-sepolia', []).state).toBe('no-balances');
    expect(readNativeBalance('base-sepolia', undefined).state).toBe('no-balances');
  });

  it('reads TEL on 2017, and an empty TEL balance is empty (was: no ETH row, so ignored)', () => {
    expect(readNativeBalance('2017', [{ token: 'TEL', balance: '0' }])).toEqual({ state: 'empty', symbol: 'TEL', balance: '0' });
    expect(readNativeBalance('telcoin-adiri', [{ token: 'TEL', balance: '3' }]).state).toBe('funded');
  });

  it('does not read an ETH row as gas on a chain whose gas is TEL', () => {
    const r = readNativeBalance('telcoin-adiri', [{ token: 'ETH', balance: '5' }]);
    expect(r).toEqual({ state: 'native-not-reported', chain: 'telcoin-adiri', symbol: 'TEL', reported: ['ETH'] });
    expect(describeUnverifiable('telcoin-adiri', r)).toMatch(/reported ETH on telcoin-adiri, but its gas token is TEL/);
  });

  it('names a chain whose gas token it does not know, rather than guessing', () => {
    const r = readNativeBalance('solana-devnet', [{ token: 'SOL', balance: '0' }]);
    expect(r).toEqual({ state: 'unknown-native', chain: 'solana-devnet' });
    expect(describeUnverifiable('solana-devnet', r)).toMatch(/does not know the native gas token of "solana-devnet"/);
  });

  it('calls an unreadable balance unreadable, not zero and not funded', () => {
    // The gateway reports `{ token: '', balance: 'unavailable' }` when its balance lookup failed.
    const r = readNativeBalance('ethereum-sepolia', [{ token: '', balance: 'unavailable' }]);
    expect(r).toEqual({ state: 'unreadable', symbol: 'ETH', balance: 'unavailable' });
  });
});
