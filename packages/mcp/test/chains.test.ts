import { describe, it, expect, vi } from 'vitest';
import { dispatch } from '../src/protocol.js';
import { createHandlers } from '../src/server.js';
import { assertChainUsable, assertIntentChains, configuredChains, enabledChainReport } from '../src/chains.js';
import { ALL_TOOLS } from '../src/tools.js';

/**
 * Chain names reach MCP through the SDK's catalogue.
 *
 * Before: MCP checked no chain name at all, so a typo went to the gateway and came back as a rejection nobody could connect to the
 * argument, and Telcoin Adiri (off by default everywhere else) was usable here whatever the configuration said. Now the same rule the
 * CLI applies runs before anything is sent.
 */
const THREE = [
  { id: 'ethereum-sepolia', chainId: 11155111 },
  { id: 'base-sepolia', chainId: 84532 },
  { id: 'arbitrum-sepolia', chainId: 421614 },
];
const ADIRI = { id: 'telcoin-adiri', chainId: 2017 };
const ENABLE_ADIRI = { CERTEN_ENABLED_CHAINS: 'ethereum-sepolia,base-sepolia,arbitrum-sepolia,telcoin-adiri' };

const clientServing = (chains: Array<{ id: string; chainId: number; enabled?: boolean }>, extra: Record<string, unknown> = {}) =>
  ({ chains: { list: vi.fn().mockResolvedValue({ chains }) }, ...extra }) as never;

describe('assertChainUsable', () => {
  it('accepts the three live chains offline (no gateway call), by slug or numeric id', async () => {
    const client = clientServing(THREE);
    expect(await assertChainUsable(client, 'base-sepolia', {})).toBe('base-sepolia');
    expect(await assertChainUsable(client, '84532', {})).toBe('base-sepolia');
    expect(await assertChainUsable(client, '  ethereum-sepolia ', {})).toBe('ethereum-sepolia');
    expect((client as unknown as { chains: { list: ReturnType<typeof vi.fn> } }).chains.list).not.toHaveBeenCalled();
  });

  it('refuses an unknown chain by name, listing the alternatives, and says how to go outside the list', async () => {
    await expect(assertChainUsable(clientServing(THREE), 'mars-testnet', {})).rejects.toMatchObject({ code: 'UNSUPPORTED_CHAIN', status: 0 });
    await expect(assertChainUsable(clientServing(THREE), 'mars-testnet', {})).rejects.toThrow(/Enabled: ethereum-sepolia, base-sepolia, arbitrum-sepolia.*CERTEN_ALLOW_ANY_CHAIN=1/);
  });

  it('refuses a retired catalogue chain as retired, not as unknown', async () => {
    await expect(assertChainUsable(clientServing(THREE), 'optimism-sepolia', {})).rejects.toThrow(/"optimism-sepolia" is retired and cannot be used/);
  });

  it('refuses Telcoin Adiri by default and tells the caller exactly how to enable it', async () => {
    const err = await assertChainUsable(clientServing([...THREE, ADIRI]), 'telcoin-adiri', {}).catch((e) => e);
    expect(err).toMatchObject({ code: 'UNSUPPORTED_CHAIN' });
    expect(err.message).toContain('is not enabled');
    expect(err.message).toContain('CERTEN_ENABLED_CHAINS=ethereum-sepolia,base-sepolia,arbitrum-sepolia,telcoin-adiri');
  });

  it('accepts Adiri when it is enabled AND the gateway serves it', async () => {
    const client = clientServing([...THREE, ADIRI]);
    expect(await assertChainUsable(client, 'telcoin-adiri', ENABLE_ADIRI)).toBe('telcoin-adiri');
    expect(await assertChainUsable(client, '2017', ENABLE_ADIRI)).toBe('telcoin-adiri');
  });

  it('tells the gateway\'s two refusals apart: not listed is unknown_chain, switched off is chain_not_enabled', async () => {
    const absent = await assertChainUsable(clientServing(THREE), 'telcoin-adiri', ENABLE_ADIRI).catch((e) => e);
    expect(absent.message).toMatch(/does not list it at all \(unknown_chain\)/);
    const off = await assertChainUsable(clientServing([...THREE, { ...ADIRI, enabled: false }]), 'telcoin-adiri', ENABLE_ADIRI).catch((e) => e);
    expect(off.message).toMatch(/switched off \(chain_not_enabled\)/);
  });

  it('does not guess when the gateway cannot be asked about an opt-in chain', async () => {
    const client = { chains: { list: vi.fn().mockRejectedValue(Object.assign(new Error('down'), { code: 'NETWORK_ERROR' })) } } as never;
    await expect(assertChainUsable(client, 'telcoin-adiri', ENABLE_ADIRI)).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
  });

  it('honours the CERTEN_ALLOW_ANY_CHAIN=1 escape, and only exactly "1"', async () => {
    expect(await assertChainUsable(clientServing(THREE), 'optimism-sepolia', { CERTEN_ALLOW_ANY_CHAIN: '1' })).toBe('optimism-sepolia');
    await expect(assertChainUsable(clientServing(THREE), 'optimism-sepolia', { CERTEN_ALLOW_ANY_CHAIN: 'true' })).rejects.toMatchObject({ code: 'UNSUPPORTED_CHAIN' });
  });

  it('refuses a configuration that names an unknown or retired chain instead of skipping it', () => {
    expect(() => configuredChains({ CERTEN_ENABLED_CHAINS: 'base-sepolia,mars-testnet' })).toThrow(/CERTEN_ENABLED_CHAINS: "mars-testnet" is not a chain/);
    expect(configuredChains({})).toEqual(['ethereum-sepolia', 'base-sepolia', 'arbitrum-sepolia']);
  });
});

describe('assertIntentChains', () => {
  const client = clientServing(THREE);
  it('checks every leg and the destination, but not the Accumulate source', async () => {
    await expect(assertIntentChains(client, { fromChain: 'accumulate', toChain: 'base-sepolia' }, {})).resolves.toBeUndefined();
    await expect(assertIntentChains(client, { legs: [{ chain: 'base-sepolia' }, { chain: 'solana-devnet' }] }, {})).rejects.toMatchObject({ code: 'UNSUPPORTED_CHAIN' });
    await expect(assertIntentChains(client, { fromChain: 'ethereum', toChain: 'base-sepolia' }, {})).rejects.toMatchObject({ code: 'UNSUPPORTED_CHAIN' });
    await expect(assertIntentChains(client, undefined, {})).resolves.toBeUndefined();
    await expect(assertIntentChains(client, { legs: 'nope' }, {})).resolves.toBeUndefined();
  });
});

describe('through the tools', () => {
  const READ = { CERTEN_API_KEY: 'k' } as NodeJS.ProcessEnv;
  const WRITE = { CERTEN_API_KEY: 'k', CERTEN_MCP_ALLOW_WRITES: '1' } as NodeJS.ProcessEnv;
  const call = async (env: NodeJS.ProcessEnv, client: unknown, name: string, args: Record<string, unknown>) => {
    const res = await dispatch({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, createHandlers({ env, client: client as never }));
    const r = res?.result as { isError?: boolean; content: Array<{ text: string }> };
    return { isError: r.isError === true, body: JSON.parse(r.content[0].text) };
  };

  it('certen_quote refuses an unlisted chain before any request, and passes a listed one', async () => {
    const quote = vi.fn().mockResolvedValue({ quote_id: 'q' });
    const client = { ...(clientServing(THREE) as object), billing: { quote } };
    const bad = await call(READ, client, 'certen_quote', { chain: 'optimism-sepolia' });
    expect(bad.isError).toBe(true);
    expect(bad.body.error).toMatchObject({ code: 'UNSUPPORTED_CHAIN', retryable: false });
    expect(quote).not.toHaveBeenCalled();
    const ok = await call(READ, client, 'certen_quote', { chain: '84532', sku: 'x' });
    expect(ok.isError).toBe(false);
    expect(quote).toHaveBeenCalledWith(expect.objectContaining({ chain: 'base-sepolia' })); // normalised to the slug
  });

  it('certen_transaction_open refuses an intent naming an unlisted chain before it is opened', async () => {
    const create = vi.fn().mockResolvedValue({ intent_id: 'i' });
    const client = { ...(clientServing(THREE) as object), transaction: { create } };
    const bad = await call(WRITE, client, 'certen_transaction_open', { identityId: 'id', intent: { legs: [{ chain: 'telcoin-adiri' }] }, confirm: true });
    expect(bad.isError).toBe(true);
    expect(bad.body.error.code).toBe('UNSUPPORTED_CHAIN');
    expect(create).not.toHaveBeenCalled();
    const ok = await call(WRITE, client, 'certen_transaction_open', { identityId: 'id', intent: { legs: [{ chain: 'base-sepolia' }] }, confirm: true });
    expect(ok.isError).toBe(false);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('certen_identity_create and certen_billing_register_payer check their chain arguments', async () => {
    const create = vi.fn().mockResolvedValue({ id: 'x' });
    const register = vi.fn().mockResolvedValue({});
    const client = { ...(clientServing(THREE) as object), identity: { create, createAndWait: create }, billing: { registerPayerAddress: register } };
    const a = await call(WRITE, client, 'certen_identity_create', { name: 'n', publicKeyHash: 'a'.repeat(64), publicKey: 'b'.repeat(64), chains: ['base-sepolia', 'nope'], confirm: true });
    expect(a.body.error.code).toBe('UNSUPPORTED_CHAIN');
    expect(create).not.toHaveBeenCalled();
    const b = await call(WRITE, client, 'certen_billing_register_payer', { chain: 'nope', address: `0x${'1'.repeat(40)}`, confirm: true });
    expect(b.body.error.code).toBe('UNSUPPORTED_CHAIN');
    expect(register).not.toHaveBeenCalled();
  });

  it('certen_chains_enabled lists only what is usable, and how to enable the opt-in chain', async () => {
    const tool = ALL_TOOLS.find((t) => t.name === 'certen_chains_enabled')!;
    expect(tool).toMatchObject({ tier: 'read', mutates: false });
    const r = await enabledChainReport(clientServing([...THREE, ADIRI]), {});
    expect((r.enabled as Array<{ slug: string }>).map((c) => c.slug)).toEqual(['ethereum-sepolia', 'base-sepolia', 'arbitrum-sepolia']);
    expect(r.optIn).toEqual([{ slug: 'telcoin-adiri', enabled: false, servedByGateway: true, howToEnable: 'CERTEN_ENABLED_CHAINS=ethereum-sepolia,base-sepolia,arbitrum-sepolia,telcoin-adiri' }]);
    const on = await enabledChainReport(clientServing([...THREE, ADIRI]), ENABLE_ADIRI);
    expect((on.enabled as Array<{ slug: string }>).map((c) => c.slug)).toContain('telcoin-adiri');
    const notServed = await enabledChainReport(clientServing(THREE), ENABLE_ADIRI);
    expect((notServed.enabled as Array<{ slug: string }>).map((c) => c.slug)).not.toContain('telcoin-adiri');
  });
});
