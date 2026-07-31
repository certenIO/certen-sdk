import { Command } from 'commander';
import { CertenClient } from '@certen.io/sdk';
import { getApiKey, getApiUrl } from '../config.js';
import { printOutput } from '../output.js';

async function getClient(): Promise<CertenClient> {
  return new CertenClient({ apiKey: await getApiKey(), baseUrl: getApiUrl() });
}

export function registerIdentityCommands(program: Command): void {
  const identity = program.command('identity').description('Identity management');

  identity
    .command('create')
    .description('Create a new identity')
    .requiredOption('--name <name>', 'Identity name')
    .requiredOption('--public-key-hash <hash>', 'Public key hash')
    .option('--public-key <key>', 'Public key (hex)')
    .option('--chains <chains>', 'Comma-separated chain IDs')
    .option('--credits <credits>', 'Initial credits', parseInt)
    .action(async (opts) => {
      const client = await getClient();
      const result = await client.identity.create({
        name: opts.name,
        publicKeyHash: opts.publicKeyHash,
        publicKey: opts.publicKey,
        chains: opts.chains ? opts.chains.split(',') : undefined,
        credits: opts.credits,
      });
      printOutput(result as unknown as Record<string, unknown>);
    });

  identity
    .command('list')
    .description('(unavailable — the gateway has no identity list endpoint)')
    .action(() => {
      // This called GET /v1/identities, which 404s: the gateway serves /v1/identity (POST) and
      // /v1/identity/{id} (GET/PATCH/DELETE) and has no collection route. Failing with an explanation
      // beats failing with a 404 the user has to go decode. Kept as a command so it explains itself
      // rather than printing "unknown command".
      throw new Error(
        'The gateway has no identity list endpoint — GET /v1/identities does not exist. '
        + 'Use `certen identity get <id>` for an identity you know, or `certen portfolio` for a '
        + 'cross-identity view of the org.',
      );
    });

  identity
    .command('get <id>')
    .description('Get identity details')
    .action(async (id: string) => {
      const client = await getClient();
      // No `--include`: the route takes no query parameters. It used to be sent and silently ignored.
      const result = await client.identity.get(id);
      printOutput(result as unknown as Record<string, unknown>);
    });

  identity
    .command('link-chain <id>')
    .description('Link a chain to an identity')
    .requiredOption('--chain <chain>', 'Chain ID to link')
    .action(async (id: string, opts) => {
      const client = await getClient();
      const result = await client.identity.update(id, {
        linkChains: [opts.chain],
      });
      printOutput(result as unknown as Record<string, unknown>);
    });
}
