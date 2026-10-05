import { Command } from 'commander';
import { CertenClient, readNativeBalance, describeUnverifiable } from '@certen.io/sdk';
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
      //
      // The gas row is found by each chain's OWN native symbol from the catalogue: matching `ETH`
      // everywhere never warned on a chain whose gas is something else. A row that cannot be
      // identified or read is named as such, never passed over in silence.
      const empty: string[] = [];
      const unverifiable: string[] = [];
      for (const identity of result.identities) {
        for (const chain of identity.chains ?? []) {
          // Normalized: the same chain arrives as a slug on one account and a numeric EVM id on
          // another, so the raw values would list one chain twice.
          const slug = normalizeChain(chain.chain_id);
          const reading = readNativeBalance(slug, chain.balances);
          if (reading.state === 'empty') empty.push(slug);
          else if (reading.state !== 'funded' && reading.state !== 'no-balances') {
            unverifiable.push(describeUnverifiable(slug, reading)!);
          }
        }
      }
      if (unverifiable.length > 0) {
        hint('');
        hint('Gas that cannot be verified, so an intent moving value from these accounts may never execute:');
        for (const why of [...new Set(unverifiable)]) hint(`  ${why}`);
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
