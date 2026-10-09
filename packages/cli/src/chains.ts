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
 * **Every fact here comes from the SDK's chain catalogue** (`CHAIN_CATALOGUE` in `@certen.io/sdk`):
 * the slugs, the aliases, the numeric ids, the gas token, the faucet and the block time. This file
 * holds no chain table of its own, so it cannot drift from the SDK's.
 *
 * **What is enabled** is decided in two steps:
 *
 * 1. configuration: `CERTEN_ENABLED_CHAINS` (a comma-separated list that replaces the default), or
 *    the catalogue's live chains when it is unset;
 * 2. the gateway: a chain is never offered when the cached `GET /v1/chains` (see
 *    `certen chains`) says the gateway does not serve it. A chain that is off by default (Telcoin
 *    Adiri) needs that cache to say the gateway DOES serve it before it is accepted.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import {
  CHAIN_CATALOGUE, chainInfo, chainSlug, defaultEnabledChains, parseEnabledChains, chainAvailability,
  ChainConfigurationError, type ServedChain,
} from '@certen.io/sdk';
import { UsageError } from './errors.js';

/** The chains this product targets by default: the catalogue's live chains. Deliberately testnet-only. */
export const SUPPORTED_CHAINS: readonly string[] = Object.freeze(defaultEnabledChains());

/**
 * Escape hatch for a chain the gateway serves but this build does not list.
 *
 * The gateway is deployed on more chains than these three. Someone deliberately working outside
 * the supported set should not have to patch the CLI to do it — but they should have to say so,
 * so it can never happen by typo.
 */
const OVERRIDE_ENV_VAR = 'CERTEN_ALLOW_ANY_CHAIN';

/** Configuration of the enabled set. Replaces the default when set. */
export const ENABLED_CHAINS_ENV_VAR = 'CERTEN_ENABLED_CHAINS';

/** Near-misses worth naming explicitly, from the catalogue. A mainnet name is the dangerous case. */
function aliasTarget(needle: string): string | undefined {
  for (const entry of CHAIN_CATALOGUE) {
    if (entry.support === 'retired') continue;
    if (entry.aliases.includes(needle)) return entry.slug;
  }
  return undefined;
}

/**
 * The configured set: `CERTEN_ENABLED_CHAINS`, or the live chains when it is unset.
 *
 * A setting naming a chain the catalogue does not know, or a retired one, is a usage error by name
 * — an enable switch that skipped a typo would leave someone believing a chain was on.
 */
export function enabledChains(): string[] {
  try {
    return parseEnabledChains(process.env[ENABLED_CHAINS_ENV_VAR]);
  } catch (err) {
    if (err instanceof ChainConfigurationError) {
      throw new UsageError(`${ENABLED_CHAINS_ENV_VAR}: ${err.message}`, 'UNSUPPORTED_CHAIN');
    }
    throw err;
  }
}

export function supportedChains(): readonly string[] {
  return enabledChains();
}

/**
 * Registry slug → numeric EVM chain id.
 *
 * `execute.contractCall` passes `chainId` straight through to the intent leg. Leaving it undefined
 * makes the caller supply a number they already told us by naming the chain, so it is derived —
 * from the catalogue, and from the cached registry for a chain the catalogue does not know.
 */
export function chainIdFor(chain: string): number | undefined {
  const slug = normalizeChain(chain);
  const known = chainInfo(slug);
  if (known) return known.chainId;
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
 * **This is not a convenience.** `GET /v1/portfolio` used to return `chain_id` as a slug for some
 * chain accounts and as a numeric EVM id for others — both spellings in the same response, on the
 * same organization. Anything comparing `chain_id` to a slug therefore silently missed every
 * numeric entry, which is exactly how the unfunded-account guard came to skip the chain it was
 * written to protect. The gateway now canonicalizes on write, but the CLI ships on its own cadence
 * and is frequently newer than the gateway it talks to, and the failure this prevents is silent.
 *
 * Anything unrecognised is returned unchanged: a value we cannot map is still the best label we
 * have for it, and inventing one would be worse than showing what arrived.
 */
export function normalizeChain(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '';
  const raw = String(value).trim();
  if (chainInfo(raw)) return chainSlug(raw);
  const fromCache = readChainCache()?.numeric?.[raw];
  return fromCache ?? raw;
}

// ── the registry cache ──────────────────────────────────────────────────────────────────────────

/**
 * `GET /v1/chains` is public and its answer is static for hours at a time, so it is cached rather
 * than fetched on every validation. The cache never widens the set beyond configuration — that is
 * a product decision, not a gateway fact. It narrows it: a chain the gateway does not serve is not
 * offered. And it lets a refusal tell the truth about WHY a real chain is being refused: "the
 * gateway serves optimism-sepolia, but this CLI targets these three" reads very differently from
 * "optimism-sepolia is not a chain", and only one of them is accurate.
 */
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/** Resolved on each use, so a changed home directory (a test, a sandbox) is honoured. */
export function chainCacheFile(): string {
  return join(homedir(), '.certen', 'chains.json');
}

interface ChainCache {
  fetched_at: string;
  /** Registry ids the gateway reported, e.g. ['ethereum-sepolia', 'solana-devnet', ...]. */
  ids: string[];
  /** Numeric EVM chain id → registry slug, so a numeric `chain_id` can be resolved live. */
  numeric?: Record<string, string>;
  /** Ids the gateway lists with `enabled: false`: listed, not served. */
  disabled?: string[];
}

export function readChainCache(): ChainCache | null {
  try {
    const file = chainCacheFile();
    if (!existsSync(file)) return null;
    const parsed = JSON.parse(readFileSync(file, 'utf-8')) as ChainCache;
    if (!Array.isArray(parsed.ids)) return null;
    return parsed;
  } catch {
    // A corrupt cache is not an error worth surfacing — it just means the gateway's answer is not
    // known, which is what would have happened had the file never existed.
    return null;
  }
}

export function chainCacheIsFresh(cache: ChainCache | null): boolean {
  if (!cache) return false;
  const age = Date.now() - new Date(cache.fetched_at).getTime();
  return Number.isFinite(age) && age >= 0 && age < CACHE_TTL_MS;
}

export function writeChainCache(entries: Array<{ id: string; chainId: number | null; enabled?: boolean }>): void {
  try {
    const numeric: Record<string, string> = {};
    for (const entry of entries) {
      if (entry.chainId !== null && entry.chainId !== undefined) numeric[String(entry.chainId)] = entry.id;
    }
    mkdirSync(join(homedir(), '.certen'), { recursive: true });
    writeFileSync(chainCacheFile(), JSON.stringify({
      fetched_at: new Date().toISOString(),
      ids: entries.map((e) => e.id),
      numeric,
      disabled: entries.filter((e) => e.enabled === false).map((e) => e.id),
    }, null, 2));
  } catch {
    // Best effort. Failing to cache must never fail the command that triggered it.
  }
}

/** What the fresh cache says the gateway serves, or undefined when there is no fresh answer. */
export function servedFromCache(): ServedChain[] | undefined {
  const cache = readChainCache();
  if (!cache || !chainCacheIsFresh(cache)) return undefined;
  const numericOf = new Map(Object.entries(cache.numeric ?? {}).map(([n, id]) => [id, Number(n)]));
  const disabled = new Set(cache.disabled ?? []);
  return cache.ids.map((id) => ({ id, chainId: numericOf.get(id) ?? null, enabled: !disabled.has(id) }));
}

/** Does the gateway serve this chain, as far as the cache knows? Absent cache means "no idea". */
function gatewayKnows(chain: string): boolean {
  const cache = readChainCache();
  return cache ? cache.ids.includes(chain) && !(cache.disabled ?? []).includes(chain) : false;
}

/**
 * Is this chain enabled: configured, and not known to be unserved by the gateway?
 *
 * Pass `served` when the gateway's list is in hand (as `certen chains` has it); otherwise the
 * fresh cache is consulted. A chain that is off by default is enabled only when the gateway's
 * answer is in hand and says it serves it.
 */
export function isSupportedChain(value: string, served: readonly ServedChain[] | undefined = servedFromCache()): boolean {
  const info = chainInfo(value);
  if (!info || info.slug !== value) return false;
  const availability = chainAvailability(value, enabledChains(), served);
  if (availability.state !== 'enabled') return false;
  return availability.chain.enabledByDefault || served !== undefined;
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

/** The closest catalogue chain to `value`, or undefined if nothing is close enough to suggest. */
export function nearestChain(value: string): string | undefined {
  const needle = value.trim().toLowerCase();
  const aliased = aliasTarget(needle);
  if (aliased) return aliased;

  let best: string | undefined;
  let bestDistance = Infinity;
  for (const entry of CHAIN_CATALOGUE) {
    if (entry.support === 'retired') continue;
    const d = levenshtein(needle, entry.slug);
    if (d < bestDistance) {
      bestDistance = d;
      best = entry.slug;
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
  const configured = enabledChains();
  const served = servedFromCache();
  if (isSupportedChain(chain, served)) return chain;

  if (process.env[OVERRIDE_ENV_VAR] === '1') return chain;

  const info = chainInfo(chain);
  if (info && info.slug === chain && info.support !== 'retired') {
    const availability = chainAvailability(chain, configured, served);
    const label = `${chain} (${info.displayName}, chain ${info.chainId})`;
    if (availability.state === 'not-configured') {
      throw new UsageError(
        `${flag}: ${label} is not enabled. Enabled: ${configured.join(', ')}. `
        + `Enable it with ${ENABLED_CHAINS_ENV_VAR}=${[...configured, chain].join(',')}.`,
        'UNSUPPORTED_CHAIN',
      );
    }
    if (availability.state === 'disabled') {
      throw new UsageError(
        `${flag}: ${label} is enabled here, but the gateway has it switched off (chain_not_enabled, per ${chainCacheFile()}). `
        + 'Refresh with: certen chains --refresh',
        'UNSUPPORTED_CHAIN',
      );
    }
    if (availability.state === 'unlisted') {
      throw new UsageError(
        `${flag}: ${label} is enabled here, but the gateway does not list it at all (unknown_chain, per ${chainCacheFile()}). `
        + 'Refresh with: certen chains --refresh',
        'UNSUPPORTED_CHAIN',
      );
    }
    // Enabled in configuration, off by default, and no fresh answer from the gateway.
    throw new UsageError(
      `${flag}: ${label} is enabled here, but whether the gateway serves it is not known. `
      + 'Check with: certen chains --refresh',
      'UNSUPPORTED_CHAIN',
    );
  }

  // A chain the gateway really serves gets a different sentence from one that does not exist.
  // Telling someone `optimism-sepolia` "is not a chain" would be false, and would send them
  // looking for a typo they did not make.
  if (gatewayKnows(chain)) {
    throw new UsageError(
      `The gateway serves "${chain}", but this CLI targets ${configured.join(', ')}. `
      + `Set ${OVERRIDE_ENV_VAR}=1 to use it anyway.`,
      'UNSUPPORTED_CHAIN',
    );
  }

  const suggestion = nearestChain(chain);
  const lines = [
    `"${chain}" is not a supported chain.`,
    suggestion ? ` Did you mean ${suggestion}?` : '',
    ` Supported: ${configured.join(', ')}.`,
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
      `${flag} was given no chains. Supported: ${enabledChains().join(', ')}.`,
      'UNSUPPORTED_CHAIN',
    );
  }
  return parts.map((c) => assertChain(c, flag));
}
