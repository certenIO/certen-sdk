import { Command } from 'commander';
import { CertenClient } from '@certen.io/sdk';
import { getApiKey, getApiUrl } from '../config.js';
import { printOutput } from '../output.js';
import { resolveSigner } from '../signer.js';

async function getClient(): Promise<CertenClient> {
  return new CertenClient({ apiKey: await getApiKey(), baseUrl: getApiUrl() });
}

export function registerIdentityCommands(program: Command): void {
  const identity = program.command('identity').description('Identity management');

  identity
    .command('create')
    .description('Create a new identity')
    .requiredOption('--name <name>', 'Identity name')
    .option('--sign-with <key>', 'Local key to own this identity (see `certen keys generate`)')
    .option('--public-key-hash <hash>', 'Public key hash (omit when using --sign-with)')
    .option('--public-key <key>', 'Public key (hex)')
    .option('--chains <chains>', 'Comma-separated chain IDs')
    .option('--credits <credits>', 'Initial credits', parseInt)
    .action(async (opts) => {
      // --public-key-hash was required, which is why the CLI could not create an identity on its
      // own: the hash is sha256 of the RAW 32-byte public key, and working that out was left to
      // the user. --sign-with derives both fields from a stored key so the common case needs
      // neither. The explicit flags still work for a key this machine does not hold.
      let publicKeyHash: string | undefined = opts.publicKeyHash;
      let publicKey: string | undefined = opts.publicKey;

      if (opts.signWith) {
        if (publicKeyHash || publicKey) {
          throw new Error('Pass either --sign-with or --public-key-hash/--public-key, not both.');
        }
        const signer = await resolveSigner(opts.signWith);
        publicKeyHash = signer.publicKeyHash;
        publicKey = signer.publicKey;
      }

      if (!publicKeyHash) {
        throw new Error(
          'Provide --sign-with <key>, or --public-key-hash <hash>. '
          + 'To make a key: certen keys generate --name dev',
        );
      }

      const client = await getClient();
      const result = await client.identity.create({
        name: opts.name,
        publicKeyHash,
        publicKey,
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
