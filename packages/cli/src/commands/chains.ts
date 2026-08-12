import { Command } from 'commander';
import { CertenClient, type ChainEntry } from '@certen.io/sdk';
import { getApiUrl } from '../config.js';
import { printOutput, hint, human, isJsonMode } from '../output.js';
import { CliError, EXIT } from '../errors.js';
import {
  SUPPORTED_CHAINS, isSupportedChain, writeChainCache, readChainCache, chainCacheIsFresh,
  CHAIN_CACHE_FILE,
} from '../chains.js';
import { faucetFor } from '../funding-guard.js';

/**
 * `certen chains` — what CERTEN is deployed on, and where.
 *
 * Two commands required a chain name (`fund`, `quote`) while nothing in the CLI could tell you
 * what a valid one looked like. The answer lived in prose documentation, which is the one place a
 * developer already in a terminal is not looking.
 *
 * **No API key.** `GET /v1/chains` is public by design on the gateway side, and keeping that
 * property here is what makes this the first useful command a new user can run — before signup,
 * before login, before anything. It doubles as the cheapest possible reachability check.
 */

/** Public endpoint, so the key is irrelevant — but the client requires the field. */
function publicClient(): CertenClient {
  return new CertenClient({ apiKey: process.env.CERTEN_API_KEY ?? 'public', baseUrl: getApiUrl() });
}

function contractSummary(chain: ChainEntry): string {
  const roles = Object.keys(chain.contracts ?? {});
  if (roles.length === 0) return '-';
  const verified = roles.filter((r) => chain.contracts[r]?.verified).length;
  return `${roles.length} (${verified} verified)`;
}

export function registerChainsCommands(program: Command): void {
  const chains = program
    .command('chains')
    .description('Chains CERTEN is deployed on, with contract addresses (no API key needed)')
    .argument('[id]', 'One chain by registry id (base-sepolia) or numeric chain id (84532)')
    .option('--all', 'Show every chain the gateway serves, not just the ones this CLI targets')
    .option('--refresh', 'Bypass the local cache and refetch from the gateway')
    .action(async (id: string | undefined, opts: { all?: boolean; refresh?: boolean }) => {
      const client = publicClient();

      if (id) {
        const { chain } = await client.chains.get(id).catch((err) => {
          // A 404 here is a wrong argument, not a broken gateway, and the fix is one command away.
          if ((err as { status?: number }).status === 404) {
            throw new CliError(
              `The gateway has no chain "${id}". Run \`certen chains --all\` to see every one it serves.`,
              'UNKNOWN_CHAIN',
              EXIT.FAILED,
            );
          }
          throw err;
        });

        printOutput({
          id: chain.id,
          chain_id: chain.chainId ?? '-',
          family: chain.family,
          display_name: chain.displayName,
          environment: chain.environment,
          status: chain.status,
          explorer: chain.explorer,
          supported_by_cli: isSupportedChain(chain.id),
        });

        if (isJsonMode()) return;

        const roles = Object.entries(chain.contracts ?? {});
        if (roles.length > 0) {
          human('');
          human('  CERTEN contracts on this chain:');
          for (const [role, contract] of roles) {
            const mark = contract.verified ? 'verified' : 'unverified';
            human(`    ${role.padEnd(18)} ${contract.address}  (${mark})`);
          }
          // Worth stating once rather than leaving as a footnote: unverified on a non-EVM chain
          // means "not checkable by eth_getCode", not "suspect".
          if (chain.family !== 'evm' && roles.some(([, c]) => !c.verified)) {
            human('');
            human('  Non-EVM addresses come from validator configuration and cannot be');
            human('  independently verified the way EVM bytecode can.');
          }
        }

        const faucet = faucetFor(chain.id);
        if (faucet) {
          human('');
          human(`  Testnet gas: ${faucet}`);
        }

        if (!isSupportedChain(chain.id)) {
          hint('');
          hint(`This CLI targets ${SUPPORTED_CHAINS.join(', ')}. Set CERTEN_ALLOW_ANY_CHAIN=1 to use others.`);
        }
        return;
      }

      const cache = readChainCache();
      if (!opts.refresh && chainCacheIsFresh(cache)) {
        // Cheap path: the list is static for hours and this is the command most likely to be run
        // repeatedly while someone is finding their footing.
        const ids = opts.all ? cache!.ids : cache!.ids.filter(isSupportedChain);
        printOutput(ids.map((chainId) => ({ id: chainId, supported_by_cli: isSupportedChain(chainId) })));
        if (isJsonMode()) return;
        hint('');
        hint(`From cache (${CHAIN_CACHE_FILE}). Refresh with: certen chains --refresh`);
        return;
      }

      const result = await client.chains.list();
      // Numeric ids are cached alongside the slugs so `normalizeChain` can resolve a numeric
      // `chain_id` from the portfolio without another round trip.
      writeChainCache(result.chains.map((c) => ({ id: c.id, chainId: c.chainId })));

      const shown = opts.all ? result.chains : result.chains.filter((c) => isSupportedChain(c.id));

      printOutput(shown.map((chain) => ({
        id: chain.id,
        chain_id: chain.chainId ?? '-',
        family: chain.family,
        status: chain.status,
        contracts: contractSummary(chain),
      })));

      if (isJsonMode()) return;

      if (!opts.all && result.chains.length > shown.length) {
        hint('');
        hint(`${result.chains.length - shown.length} more chain(s) are served by the gateway but are `
          + 'outside what this CLI targets. See them with: certen chains --all');
      }
      hint('');
      hint('Detail for one: certen chains base-sepolia');
    });

  chains.addHelpText('after', `
Registry version and Accumulate network are included in --json output.
This command needs no API key, so it also answers "is the gateway up".`);
}
