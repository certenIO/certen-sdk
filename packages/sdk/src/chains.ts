/**
 * The chain catalogue: the one place this SDK, the CLI and the MCP server learn what a chain IS.
 *
 * Before this file the same facts lived in five tables — the CLI's supported list, its alias map,
 * its numeric-id map, its block-time table and its faucet table, plus two copies of a numeric-id
 * map in the SDK — and they had already drifted (the SDK knew five chains, the CLI three). Every
 * native-balance check also assumed the gas token was called `ETH`, which on a chain whose gas is
 * not ETH made the funding guards pass without looking. Each of those is now derived from here.
 *
 * **What this table is, and what it is not.**
 *
 * - It is static on purpose. Normalizing a numeric `chain_id`, naming the gas token, estimating a
 *   wait and validating a flag must all work offline and on a first run.
 * - It does NOT decide what is enabled on its own. A chain is offered only when it is enabled in
 *   configuration AND the gateway serves it (`GET /v1/chains`): see {@link resolveEnabledChains}.
 *   The catalogue's `enabledByDefault` is only the configuration default.
 * - A `retired` entry is kept for reading: an older gateway may still return its numeric id in a
 *   portfolio, and dropping it would make that row unrecognisable. A retired chain is never
 *   offered and cannot be enabled.
 */

export type ChainSupport = 'live' | 'opt-in' | 'retired';

export interface ChainCatalogueEntry {
  /** Registry slug, as `GET /v1/chains` names it. */
  readonly slug: string;
  /** Numeric EVM chain id (EIP-155). */
  readonly chainId: number;
  readonly displayName: string;
  readonly environment: 'testnet';
  /** The native gas token's symbol as the gateway's portfolio reports it, e.g. `ETH`, `TEL`. */
  readonly nativeSymbol: string;
  readonly nativeDecimals: number;
  /**
   * Typical seconds per block, for turning a confirmation count into an estimate a person can plan
   * around. Never a promise; see `blocksOnlyWithTraffic`.
   */
  readonly blockSeconds: number;
  /**
   * The chain produces a block only when there is a transaction to put in it. A confirmation count
   * on such a chain is not a measure of time at all when it is idle, so every estimate built on
   * `blockSeconds` is a lower bound and must be presented as one.
   */
  readonly blocksOnlyWithTraffic: boolean;
  /** Where to get testnet gas. Absent rather than guessed. */
  readonly faucet?: string;
  /**
   * Names people type for this chain that are NOT its slug. They SUGGEST and never substitute: a
   * mainnet name mapped silently to a testnet would be the client deciding where money goes.
   */
  readonly aliases: readonly string[];
  readonly support: ChainSupport;
  /** Enabled when configuration says nothing. True only for `live` chains. */
  readonly enabledByDefault: boolean;
}

/**
 * Every chain this SDK knows. Order is the order chains are listed to a person.
 *
 * Facts verified 2026-10-05 against chainid.network and, for Telcoin Adiri, against the chain's
 * own RPC (`eth_chainId` = 0x7e1). Adiri's block cadence was measured over its last 6000 blocks:
 * blocks appear only when there is a transaction, and active blocks cluster 7–16 s apart.
 */
export const CHAIN_CATALOGUE: readonly ChainCatalogueEntry[] = Object.freeze([
  {
    slug: 'ethereum-sepolia',
    chainId: 11155111,
    displayName: 'Ethereum Sepolia',
    environment: 'testnet',
    nativeSymbol: 'ETH',
    nativeDecimals: 18,
    blockSeconds: 12,
    blocksOnlyWithTraffic: false,
    faucet: 'https://sepoliafaucet.com',
    aliases: ['eth', 'ethereum', 'sepolia', 'eth-sepolia', 'mainnet'],
    support: 'live',
    enabledByDefault: true,
  },
  {
    slug: 'base-sepolia',
    chainId: 84532,
    displayName: 'Base Sepolia',
    environment: 'testnet',
    nativeSymbol: 'ETH',
    nativeDecimals: 18,
    blockSeconds: 2,
    blocksOnlyWithTraffic: false,
    faucet: 'https://www.alchemy.com/faucets/base-sepolia',
    aliases: ['base', 'basesepolia'],
    support: 'live',
    enabledByDefault: true,
  },
  {
    slug: 'arbitrum-sepolia',
    chainId: 421614,
    displayName: 'Arbitrum Sepolia',
    environment: 'testnet',
    nativeSymbol: 'ETH',
    nativeDecimals: 18,
    blockSeconds: 0.25,
    blocksOnlyWithTraffic: false,
    faucet: 'https://www.alchemy.com/faucets/arbitrum-sepolia',
    aliases: ['arb', 'arbitrum', 'arb-sepolia', 'arbsepolia'],
    support: 'live',
    enabledByDefault: true,
  },
  {
    // Telcoin Network's testnet. Gas is TEL, not ETH. Off until configuration enables it AND the
    // gateway serves it.
    slug: 'telcoin-adiri',
    chainId: 2017,
    displayName: 'Telcoin Adiri (testnet)',
    environment: 'testnet',
    nativeSymbol: 'TEL',
    nativeDecimals: 18,
    blockSeconds: 7,
    blocksOnlyWithTraffic: true,
    faucet: 'https://www.telcoin.network/faucet',
    aliases: ['adiri', 'telcoin', 'tel', 'telcoin-testnet', 'telcoin-network'],
    support: 'opt-in',
    enabledByDefault: false,
  },
  {
    slug: 'optimism-sepolia',
    chainId: 11155420,
    displayName: 'OP Sepolia',
    environment: 'testnet',
    nativeSymbol: 'ETH',
    nativeDecimals: 18,
    blockSeconds: 2,
    blocksOnlyWithTraffic: false,
    aliases: [],
    support: 'retired',
    enabledByDefault: false,
  },
  {
    slug: 'polygon-amoy',
    chainId: 80002,
    displayName: 'Polygon Amoy',
    environment: 'testnet',
    nativeSymbol: 'POL',
    nativeDecimals: 18,
    blockSeconds: 2,
    blocksOnlyWithTraffic: false,
    aliases: [],
    support: 'retired',
    enabledByDefault: false,
  },
].map((entry) => Object.freeze({ ...entry, aliases: Object.freeze([...entry.aliases]) })) as ChainCatalogueEntry[]);

const BY_SLUG = new Map(CHAIN_CATALOGUE.map((c) => [c.slug, c]));
const BY_NUMERIC = new Map(CHAIN_CATALOGUE.map((c) => [String(c.chainId), c]));

/** The catalogue entry for a slug or a numeric chain id (either spelling), or undefined. */
export function chainInfo(value: string | number | null | undefined): ChainCatalogueEntry | undefined {
  if (value === null || value === undefined) return undefined;
  const raw = String(value).trim();
  return BY_SLUG.get(raw) ?? BY_NUMERIC.get(raw);
}

/**
 * Resolve whatever the gateway called a chain into its slug.
 *
 * A numeric id the catalogue knows becomes its slug. Anything else is returned unchanged (trimmed):
 * a value we cannot map is still the best label we have for it, and inventing one would be worse.
 */
export function chainSlug(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '';
  const raw = String(value).trim();
  return chainInfo(raw)?.slug ?? raw;
}

/** The native gas token's symbol, or undefined when the catalogue does not know the chain. */
export function nativeSymbolFor(chain: string | number | null | undefined): string | undefined {
  return chainInfo(chain)?.nativeSymbol;
}

export function faucetForChain(chain: string | number | null | undefined): string | undefined {
  return chainInfo(chain)?.faucet;
}

/** Slugs the catalogue enables when configuration says nothing: the live chains, in order. */
export function defaultEnabledChains(): string[] {
  return CHAIN_CATALOGUE.filter((c) => c.enabledByDefault).map((c) => c.slug);
}

/** Slugs that configuration may enable: everything not retired. */
export function enablableChains(): string[] {
  return CHAIN_CATALOGUE.filter((c) => c.support !== 'retired').map((c) => c.slug);
}

/** Thrown when configuration names a chain that cannot be enabled. */
export class ChainConfigurationError extends Error {
  readonly chain: string;
  constructor(chain: string, message: string) {
    super(message);
    this.name = 'ChainConfigurationError';
    this.chain = chain;
  }
}

/**
 * Parse an enabled-chains setting (e.g. `CERTEN_ENABLED_CHAINS`): a comma-separated list of slugs
 * or numeric ids that REPLACES the default set.
 *
 * Unset or blank means the default set. Every name must be a catalogue chain that is not retired;
 * anything else is refused by name — an enable switch that quietly ignored a typo would leave a
 * person believing a chain was on.
 */
export function parseEnabledChains(setting: string | undefined | null): string[] {
  if (setting === undefined || setting === null || setting.trim() === '') return defaultEnabledChains();
  const out: string[] = [];
  for (const part of setting.split(',').map((p) => p.trim()).filter((p) => p.length > 0)) {
    const info = chainInfo(part);
    if (!info) {
      throw new ChainConfigurationError(
        part,
        `"${part}" is not a chain this client knows, so it cannot be enabled. Known: ${enablableChains().join(', ')}.`,
      );
    }
    if (info.support === 'retired') {
      throw new ChainConfigurationError(
        info.slug,
        `"${info.slug}" is retired and cannot be enabled. Enablable: ${enablableChains().join(', ')}.`,
      );
    }
    if (!out.includes(info.slug)) out.push(info.slug);
  }
  return out;
}

/** The part of a `GET /v1/chains` entry this module reads. */
export interface ServedChain {
  id: string;
  chainId?: number | null;
  /** Present once the gateway publishes its enable switch; `false` means listed but not served. */
  enabled?: boolean;
}

/** Does the gateway serve this entry? Listed, and not explicitly disabled. */
export function gatewayServes(entry: ServedChain): boolean {
  return entry.enabled !== false;
}

export type ChainAvailability =
  | { state: 'enabled'; chain: ChainCatalogueEntry }
  | { state: 'unknown'; chain: string }
  | { state: 'retired'; chain: ChainCatalogueEntry }
  | { state: 'not-configured'; chain: ChainCatalogueEntry }
  | { state: 'not-served'; chain: ChainCatalogueEntry };

/**
 * Is `chain` available to use, given the configured set and (when known) what the gateway serves?
 *
 * `served` undefined means "the gateway has not been asked": the configured set alone decides,
 * which is what an offline client can know. Passing the gateway's list narrows it — the client
 * never offers a chain the gateway does not serve.
 */
export function chainAvailability(
  chain: string | number,
  configured: readonly string[],
  served?: readonly ServedChain[],
): ChainAvailability {
  const info = chainInfo(chain);
  if (!info) return { state: 'unknown', chain: String(chain).trim() };
  if (info.support === 'retired') return { state: 'retired', chain: info };
  if (!configured.includes(info.slug)) return { state: 'not-configured', chain: info };
  if (served !== undefined) {
    const entry = served.find((s) => chainSlug(s.id) === info.slug || (s.chainId !== null && s.chainId === info.chainId));
    if (!entry || !gatewayServes(entry)) return { state: 'not-served', chain: info };
  }
  return { state: 'enabled', chain: info };
}

/**
 * The chains to offer: configured ∩ served, in catalogue order.
 *
 * `served` undefined means the gateway was not consulted, and the configured set is returned.
 */
export function resolveEnabledChains(
  configured: readonly string[] = defaultEnabledChains(),
  served?: readonly ServedChain[],
): ChainCatalogueEntry[] {
  return CHAIN_CATALOGUE.filter((c) => chainAvailability(c.slug, configured, served).state === 'enabled');
}

// ── native balances ─────────────────────────────────────────────────────────────────────────────

/** One balance row as the portfolio and identity endpoints report it. */
export interface BalanceRow {
  token?: string;
  balance: string;
}

/**
 * What the reported balances say about the gas on one chain account.
 *
 * - `funded` / `empty`: the native row was found and read.
 * - `no-balances`: nothing was reported for the account (not yet deployed, or not yet indexed).
 * - `unknown-native`: the catalogue does not know this chain's gas token, so no row can be
 *   identified as the gas — refused by name rather than guessed.
 * - `native-not-reported`: rows were reported, but none is the chain's gas token (e.g. an `ETH`
 *   row on a chain whose gas is `TEL`). Treating any of them as gas would be reading the wrong
 *   number.
 * - `unreadable`: the native row's balance is not a number (the gateway reports `unavailable` when
 *   its balance lookup failed).
 */
export type NativeBalanceReading =
  | { state: 'funded'; symbol: string; balance: string }
  | { state: 'empty'; symbol: string; balance: string }
  | { state: 'no-balances' }
  | { state: 'unknown-native'; chain: string }
  | { state: 'native-not-reported'; chain: string; symbol: string; reported: string[] }
  | { state: 'unreadable'; symbol: string; balance: string };

/**
 * Find and read the native (gas) balance among an account's reported balance rows.
 *
 * A row is the native one when its token is the catalogue's symbol for the chain, or is reported
 * without a token / as `native` (how the gateway marks a native row it did not name).
 */
export function readNativeBalance(
  chain: string | number,
  balances: readonly BalanceRow[] | undefined | null,
): NativeBalanceReading {
  const symbol = nativeSymbolFor(chain);
  if (symbol === undefined) return { state: 'unknown-native', chain: chainSlug(chain) };
  const rows = balances ?? [];
  if (rows.length === 0) return { state: 'no-balances' };

  const native = rows.find((b) => !b.token || b.token === 'native' || b.token.toUpperCase() === symbol.toUpperCase());
  if (!native) {
    return {
      state: 'native-not-reported',
      chain: chainSlug(chain),
      symbol,
      reported: rows.map((b) => b.token ?? ''),
    };
  }
  const n = Number(native.balance);
  if (native.balance === '' || !Number.isFinite(n)) return { state: 'unreadable', symbol, balance: native.balance };
  return n > 0 ? { state: 'funded', symbol, balance: native.balance } : { state: 'empty', symbol, balance: native.balance };
}

/** A sentence naming why the gas on `chain` could not be read, for an unverifiable reading. */
export function describeUnverifiable(chain: string, reading: NativeBalanceReading): string | undefined {
  switch (reading.state) {
    case 'unknown-native':
      return `this client does not know the native gas token of "${reading.chain}", so it cannot tell which balance pays for execution`;
    case 'native-not-reported':
      return `the gateway reported ${reading.reported.map((t) => t || '(unnamed)').join(', ')} on ${chain}, `
        + `but its gas token is ${reading.symbol}`;
    case 'unreadable':
      return `the gateway could not read the ${reading.symbol} balance on ${chain} (it reported "${reading.balance}")`;
    default:
      return undefined;
  }
}
