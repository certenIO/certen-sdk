import { Command } from 'commander';
import { CertenClient } from '@certen.io/sdk';
import { getApiKey, getApiUrl } from '../config.js';
import { printOutput, hint, isJsonMode } from '../output.js';
import { faucetFor } from '../funding-guard.js';
import { normalizeChain } from '../chains.js';

async function getClient(): Promise<CertenClient> {
  return new CertenClient({ apiKey: await getApiKey(), baseUrl: getApiUrl() });
}

export function registerPortfolioCommands(program: Command): void {
  program
    .command('portfolio')
    .description('Get multi-chain portfolio balances')
    .option('--identity <id>', 'Filter by identity')
    .action(async (opts) => {
      const client = await getClient();
      const result = await client.portfolio.get(opts.identity);
      printOutput(result as unknown as Record<string, unknown>);

      if (isJsonMode()) return;

      if ((result.identities ?? []).length === 0) {
        hint('');
        hint('No identities yet. Next: certen identity create --name <name> --sign-with <key>');
        return;
      }

      // An abstract account with no gas is the difference between an intent that executes and one
      // that parks at `anchoring` forever. This is the view where that is visible, so say it here
      // rather than leaving it to be discovered at submit time.
      const empty: string[] = [];
      for (const identity of result.identities) {
        for (const chain of identity.chains ?? []) {
          const native = (chain.balances ?? []).find((b) => !b.token || b.token === 'ETH' || b.token === 'native');
          // Normalized: the same chain arrives as a slug on one account and a numeric EVM id on
          // another, so the raw values would list one chain twice.
          if (native && Number(native.balance) === 0) empty.push(normalizeChain(chain.chain_id));
        }
      }
      if (empty.length > 0) {
        const chains = [...new Set(empty)];
        hint('');
        hint(`Abstract accounts with no gas on: ${chains.join(', ')}.`);
        hint('An intent that moves value from these is accepted and then never executes.');
        for (const chain of chains) {
          const faucet = faucetFor(chain);
          if (faucet) hint(`  ${chain}: ${faucet}`);
        }
      }
    });
}
