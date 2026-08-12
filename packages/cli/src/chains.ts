/**
 * Chain vocabulary.
 *
 * Every command that takes a chain validates it HERE, before the network call. A typo used to
 * travel all the way to the gateway and come back as a rejection with no visible connection to
 * the flag that caused it — and in `fund`'s case it came back only after a real payment intent
 * had already been opened against the wrong chain.
 *
 * The suggestion matters as much as the rejection. `--chain base` is not a typo of nothing: `base`
 * is a real mainnet, and silently mapping it to `base-sepolia` would be the CLI guessing about
 * where money goes. So aliases SUGGEST and never substitute.
 *
 * This list is a constant today. Phase 2 replaces it with a cached read of `GET /v1/chains` and
 * keeps this as the offline fallback — which is why the export is a function, not the array.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { UsageError } from './errors.js';

/** The chains this product targets. Deliberately testnet-only. */
export const SUPPORTED_CHAINS = [
  'ethereum-sepolia',
  'base-sepolia',
  'arbitrum-sepolia',
] as const;

export type SupportedChain = (typeof SUPPORTED_CHAINS)[number];

/**
 * Escape hatch for a chain the gateway serves but this build does not list.
 *
 * The gateway is deployed on more chains than these three. Someone deliberately working outside
 * the supported set should not have to patch the CLI to do it — but they should have to say so,
 * so it can never happen by typo.
 */
const OVERRIDE_ENV_VAR = 'CERTEN_ALLOW_ANY_CHAIN';

/** Near-misses worth naming explicitly. A mainnet name is the dangerous case, not the harmless one. */
const ALIASES: Record<string, SupportedChain> = {
  eth: 'ethereum-sepolia',
  ethereum: 'ethereum-sepolia',
  sepolia: 'ethereum-sepolia',
  'eth-sepolia': 'ethereum-sepolia',
  mainnet: 'ethereum-sepolia',
  base: 'base-sepolia',
  basesepolia: 'base-sepolia',
  arb: 'arbitrum-sepolia',
  arbitrum: 'arbitrum-sepolia',
  'arb-sepolia': 'arbitrum-sepolia',
  arbsepolia: 'arbitrum-sepolia',
};

export function supportedChains(): readonly string[] {
  return SUPPORTED_CHAINS;
}

/**
 * Numeric EVM chain id → registry slug, for the chains this CLI targets.
 *
 * **This is not a convenience.** `GET /v1/portfolio` returns `chain_id` as a slug for some chain
 * accounts and as a numeric EVM id for others — both spellings appear in the same response, on
 * the same organization. Anything comparing `chain_id` to a slug therefore silently misses every
 * numeric entry, which is exactly how the unfunded-account guard came to skip the chain it was
 * written to protect.
 *
 * The cache below extends this at runtime; the constant is what makes it work offline and on a
 * first run.
 */
const NUMERIC_TO_SLUG: Record<string, SupportedChain> = {
  11155111: 'ethereum-sepolia',
  84532: 'base-sepolia',
  421614: 'arbitrum-sepolia',
};

/**
 * Registry slug → numeric EVM chain id.
 *
 * `execute.contractCall` passes `chainId` straight through to the intent leg. Leaving it undefined
 * makes the caller supply a number they already told us by naming the chain, so it is derived —
 * from the cached registry when there is one, and from this table otherwise.
 */
export function chainIdFor(chain: string): number | undefined {
  const slug = normalizeChain(chain);
  for (const [numeric, mapped] of Object.entries(NUMERIC_TO_SLUG)) {
    if (mapped === slug) return Number(numeric);
  }
  const cached = readChainCache()?.numeric;
  if (cached) {
    for (const [numeric, mapped] of Object.entries(cached)) {
      if (mapped === slug) return Number(numeric);
    }
  }
  return undefined;
}

/**
 * Resolve whatever the gateway called a chain into one canonical name.
 *
 * Anything unrecognised is returned unchanged: a value we cannot map is still the best label we
 * have for it, and inventing one would be worse than showing what arrived.
 */
export function normalizeChain(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '';
  const raw = String(value).trim();
  if (isSupportedChain(raw)) return raw;
  if (NUMERIC_TO_SLUG[raw]) return NUMERIC_TO_SLUG[raw];
  const fromCache = readChainCache()?.numeric?.[raw];
  return fromCache ?? raw;
}

// ── the registry cache ──────────────────────────────────────────────────────────────────────────

/**
 * `GET /v1/chains` is public and its answer is static for hours at a time, so it is cached rather
 * than fetched on every validation. The cache does NOT widen the supported set — that is a product
 * decision, not a gateway fact — it exists so a refusal can tell the truth about WHY a real chain
 * is being refused: "the gateway serves optimism-sepolia, but this CLI targets these three" reads
 * very differently from "optimism-sepolia is not a chain", and only one of them is accurate.
 */
const CACHE_FILE = join(homedir(), '.certen', 'chains.json');
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

interface ChainCache {
  fetched_at: string;
  /** Registry ids the gateway reported, e.g. ['ethereum-sepolia', 'solana-devnet', ...]. */
  ids: string[];
  /** Numeric EVM chain id → registry slug, so a numeric `chain_id` can be resolved live. */
  numeric?: Record<string, string>;
}

export function readChainCache(): ChainCache | null {
  try {
    if (!existsSync(CACHE_FILE)) return null;
    const parsed = JSON.parse(readFileSync(CACHE_FILE, 'utf-8')) as ChainCache;
    if (!Array.isArray(parsed.ids)) return null;
    return parsed;
  } catch {
    // A corrupt cache is not an error worth surfacing — it just means we fall back to the
    // constant, which is what would have happened had the file never existed.
    return null;
  }
}

export function chainCacheIsFresh(cache: ChainCache | null): boolean {
  if (!cache) return false;
  const age = Date.now() - new Date(cache.fetched_at).getTime();
  return Number.isFinite(age) && age >= 0 && age < CACHE_TTL_MS;
}

export function writeChainCache(entries: Array<{ id: string; chainId: number | null }>): void {
  try {
    const numeric: Record<string, string> = {};
    for (const entry of entries) {
      if (entry.chainId !== null && entry.chainId !== undefined) numeric[String(entry.chainId)] = entry.id;
    }
    mkdirSync(join(homedir(), '.certen'), { recursive: true });
    writeFileSync(CACHE_FILE, JSON.stringify({
      fetched_at: new Date().toISOString(),
      ids: entries.map((e) => e.id),
      numeric,
    }, null, 2));
  } catch {
    // Best effort. Failing to cache must never fail the command that triggered it.
  }
}

export const CHAIN_CACHE_FILE = CACHE_FILE;

/** Does the gateway serve this chain, as far as the cache knows? Absent cache means "no idea". */
function gatewayKnows(chain: string): boolean {
  const cache = readChainCache();
  return cache ? cache.ids.includes(chain) : false;
}

export function isSupportedChain(value: string): boolean {
  return (SUPPORTED_CHAINS as readonly string[]).includes(value);
}

function levenshtein(a: string, b: string): number {
  // Single-row DP: the strings here are chain names, so allocation matters less than clarity,
  // but there is no reason to hold a full matrix for it either.
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const row = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row[j] = Math.min(row[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    prev = row;
  }
  return prev[b.length];
}

/** The closest supported chain to `value`, or undefined if nothing is close enough to suggest. */
export function nearestChain(value: string): string | undefined {
  const needle = value.trim().toLowerCase();
  if (ALIASES[needle]) return ALIASES[needle];

  let best: string | undefined;
  let bestDistance = Infinity;
  for (const chain of SUPPORTED_CHAINS) {
    const d = levenshtein(needle, chain);
    if (d < bestDistance) {
      bestDistance = d;
      best = chain;
    }
  }
  // 3 is wide enough to catch "base-sepolai" and narrow enough not to propose a chain for "solana".
  return bestDistance <= 3 ? best : undefined;
}

/**
 * Validate one chain name, throwing a UsageError that names the alternatives.
 *
 * `flag` is the option the value arrived on, so the message points at what the caller typed rather
 * than at an abstract notion of "chain".
 */
export function assertChain(value: string, flag = '--chain'): string {
  const chain = value.trim();
  if (isSupportedChain(chain)) return chain;

  if (process.env[OVERRIDE_ENV_VAR] === '1') return chain;

  // A chain the gateway really serves gets a different sentence from one that does not exist.
  // Telling someone `optimism-sepolia` "is not a chain" would be false, and would send them
  // looking for a typo they did not make.
  if (gatewayKnows(chain)) {
    throw new UsageError(
      `The gateway serves "${chain}", but this CLI targets ${SUPPORTED_CHAINS.join(', ')}. `
      + `Set ${OVERRIDE_ENV_VAR}=1 to use it anyway.`,
      'UNSUPPORTED_CHAIN',
    );
  }

  const suggestion = nearestChain(chain);
  const lines = [
    `"${chain}" is not a supported chain.`,
    suggestion ? ` Did you mean ${suggestion}?` : '',
    ` Supported: ${SUPPORTED_CHAINS.join(', ')}.`,
    ` (Set ${OVERRIDE_ENV_VAR}=1 to use a chain outside this set.)`,
  ];
  throw new UsageError(lines.join(''), 'UNSUPPORTED_CHAIN');
}

/**
 * Validate a comma-separated list, as `--chains` takes.
 *
 * Empty entries are dropped rather than rejected — a trailing comma is a slip, not an instruction,
 * and failing on it would be pedantry. An empty list after that is an error, because the caller
 * clearly meant to name at least one.
 */
export function assertChains(value: string, flag = '--chains'): string[] {
  const parts = value.split(',').map((c) => c.trim()).filter((c) => c.length > 0);
  if (parts.length === 0) {
    throw new UsageError(
      `${flag} was given no chains. Supported: ${SUPPORTED_CHAINS.join(', ')}.`,
      'UNSUPPORTED_CHAIN',
    );
  }
  return parts.map((c) => assertChain(c, flag));
}
