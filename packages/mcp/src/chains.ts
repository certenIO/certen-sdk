import {
  CertenError, ChainConfigurationError, chainAvailability, chainInfo, defaultEnabledChains, enablableChains, parseEnabledChains,
  resolveEnabledChains,
} from '@certen.io/sdk';
import type { CertenClient, ChainCatalogueEntry } from '@certen.io/sdk';

/**
 * Chain names, checked against the SDK's catalogue before anything is sent.
 *
 * A chain name an agent got wrong used to travel to the gateway and come back as a rejection with no visible connection to the
 * argument that caused it; and Telcoin Adiri, which is OFF by default, was reachable through MCP regardless of configuration. This
 * is the same rule the CLI applies, from the same catalogue:
 *
 *   - the enabled set is `CERTEN_ENABLED_CHAINS` (a comma-separated list), or the catalogue's live chains when it is unset;
 *   - an unknown or retired chain is refused, naming the alternatives;
 *   - a chain that is off by default (opt-in) is accepted only when it is enabled AND the gateway lists it as served: absent is
 *     `unknown_chain`, listed with \`enabled: false\` is \`chain_not_enabled\`, and they are told apart;
 *   - `CERTEN_ALLOW_ANY_CHAIN=1` is the deliberate escape for a chain the gateway serves but this catalogue does not list.
 */
export const ENABLED_CHAINS_ENV_VAR = 'CERTEN_ENABLED_CHAINS';
export const ALLOW_ANY_CHAIN_ENV_VAR = 'CERTEN_ALLOW_ANY_CHAIN';
const CODE = 'UNSUPPORTED_CHAIN';

type Env = Record<string, string | undefined>;

/** The configured set. A setting naming an unknown or retired chain is refused by name, never skipped. */
export function configuredChains(env: Env = process.env): string[] {
  try {
    return parseEnabledChains(env[ENABLED_CHAINS_ENV_VAR]);
  } catch (err) {
    if (err instanceof ChainConfigurationError) throw new CertenError(`${ENABLED_CHAINS_ENV_VAR}: ${err.message}`, 0, CODE);
    throw err;
  }
}

/** Validate one chain name and return the catalogue slug. Throws `UNSUPPORTED_CHAIN` (status 0, nothing sent) otherwise. */
export async function assertChainUsable(client: CertenClient, value: string, env: Env = process.env): Promise<string> {
  const chain = value.trim();
  if (env[ALLOW_ANY_CHAIN_ENV_VAR] === '1') return chain;
  const configured = configuredChains(env);
  const offline = chainAvailability(chain, configured);
  switch (offline.state) {
    case 'unknown':
      throw new CertenError(
        `"${chain}" is not a chain this server knows. Enabled: ${configured.join(', ')}. Known: ${enablableChains().join(', ')}. `
        + `(Set ${ALLOW_ANY_CHAIN_ENV_VAR}=1 to use a chain the gateway serves that is not in this list.)`,
        0, CODE,
      );
    case 'retired':
      throw new CertenError(`"${offline.chain.slug}" is retired and cannot be used. Enabled: ${configured.join(', ')}.`, 0, CODE);
    case 'not-configured':
      throw new CertenError(
        `${offline.chain.slug} (${offline.chain.displayName}, chain ${offline.chain.chainId}) is not enabled. Enabled: ${configured.join(', ')}. `
        + `Enable it with ${ENABLED_CHAINS_ENV_VAR}=${[...configured, offline.chain.slug].join(',')}.`,
        0, CODE,
      );
    default:
      break;
  }
  const info = offline.chain as ChainCatalogueEntry;
  if (info.enabledByDefault) return info.slug;

  // An opt-in chain (Telcoin Adiri): enabled by configuration, but only usable if the gateway says it serves it.
  const { chains } = await client.chains.list();
  const live = chainAvailability(info.slug, configured, chains);
  if (live.state === 'enabled') return info.slug;
  const label = `${info.slug} (${info.displayName}, chain ${info.chainId})`;
  if (live.state === 'disabled') {
    throw new CertenError(`${label} is enabled here, but the gateway has it switched off (chain_not_enabled).`, 0, CODE);
  }
  throw new CertenError(`${label} is enabled here, but the gateway does not list it at all (unknown_chain).`, 0, CODE);
}

/** Validate every chain named in an intent: `legs[].chain`, `toChain`, and `fromChain` (other than the Accumulate source). */
export async function assertIntentChains(client: CertenClient, intent: unknown, env: Env = process.env): Promise<void> {
  if (!intent || typeof intent !== 'object') return;
  const i = intent as Record<string, unknown>;
  const names: string[] = [];
  if (typeof i.toChain === 'string') names.push(i.toChain);
  if (typeof i.fromChain === 'string' && i.fromChain.trim().toLowerCase() !== 'accumulate') names.push(i.fromChain);
  if (Array.isArray(i.legs)) {
    for (const leg of i.legs) {
      const c = (leg as { chain?: unknown } | null)?.chain;
      if (typeof c === 'string') names.push(c);
    }
  }
  for (const n of names) await assertChainUsable(client, n, env);
}

/** What `certen_chains_enabled` returns: the chains this server will accept, and why the others are not offered. */
export async function enabledChainReport(client: CertenClient, env: Env = process.env): Promise<Record<string, unknown>> {
  const configured = configuredChains(env);
  const { chains } = await client.chains.list();
  const usable = resolveEnabledChains(configured, chains);
  return {
    enabled: usable.map((c) => ({
      slug: c.slug, chainId: c.chainId, displayName: c.displayName, environment: c.environment, support: c.support,
      nativeSymbol: c.nativeSymbol, faucet: c.faucet ?? null, blocksOnlyWithTraffic: c.blocksOnlyWithTraffic,
    })),
    configured,
    defaultSet: defaultEnabledChains(),
    optIn: enablableChains().filter((s) => !defaultEnabledChains().includes(s)).map((slug) => ({
      slug,
      enabled: configured.includes(slug),
      servedByGateway: chains.some((g) => chainAvailability(slug, [slug], [g]).state === 'enabled') || undefined,
      howToEnable: configured.includes(slug) ? null : `${ENABLED_CHAINS_ENV_VAR}=${[...configured, slug].join(',')}`,
    })),
    note: `A chain is usable when it is in \`enabled\`. Opt-in chains (e.g. Telcoin Adiri) need ${ENABLED_CHAINS_ENV_VAR} AND the gateway listing them as served.`,
  };
}
