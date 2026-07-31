import { Command } from 'commander';
import { CertenClient } from '@certen.io/sdk';
import { getApiKey, getApiUrl } from '../config.js';
import { printOutput } from '../output.js';

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
    });
}
