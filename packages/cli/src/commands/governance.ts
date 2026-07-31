import { Command } from 'commander';
import { CertenClient } from '@certen.io/sdk';
import { getApiKey, getApiUrl } from '../config.js';
import { printOutput } from '../output.js';

async function getClient(): Promise<CertenClient> {
  return new CertenClient({ apiKey: await getApiKey(), baseUrl: getApiUrl() });
}

export function registerGovernanceCommands(program: Command): void {
  const governance = program.command('governance').description('Governance operations');

  governance
    .command('add-delegate')
    // `--identity` is the ADI (acc://org.acme), not a uuid — the governance endpoint keys on the ADI.
    .description('Add a delegate to an identity key book')
    .requiredOption('--identity <adi>', 'Identity ADI, e.g. acc://org.acme')
    .requiredOption('--delegate-url <url>', 'Delegate URL to add')
    .action(async (opts) => {
      const client = await getClient();
      const result = await client.governance.create({
        identity: opts.identity,
        operations: [{ type: 'add_delegate', delegate_url: opts.delegateUrl }],
      });
      printOutput(result as unknown as Record<string, unknown>);
    });

  governance
    .command('set-threshold')
    .description('Set the M-of-N acceptThreshold on an identity key page')
    .requiredOption('--identity <adi>', 'Identity ADI, e.g. acc://org.acme')
    .requiredOption('--threshold <n>', 'New threshold', parseInt)
    .action(async (opts) => {
      const client = await getClient();
      const result = await client.governance.create({
        identity: opts.identity,
        operations: [{ type: 'set_threshold', threshold: opts.threshold }],
      });
      printOutput(result as unknown as Record<string, unknown>);
    });
}
