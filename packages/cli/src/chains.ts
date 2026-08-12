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
