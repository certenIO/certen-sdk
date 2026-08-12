import { Command } from 'commander';
import { CertenClient } from '@certen.io/sdk';
import { getApiKey, getApiUrl } from '../config.js';
import { printOutput, hint } from '../output.js';
import { resolveSigner } from '../signer.js';
import { assertChain, assertChains } from '../chains.js';
import { UsageError } from '../errors.js';

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

      // Chains are validated BEFORE the signer is unlocked and before the request goes out. A
      // typo'd chain used to reach the gateway and come back as a rejection with no visible link
      // to the flag that caused it — after the passphrase prompt, which made the round trip worse.
      const chains = opts.chains ? assertChains(opts.chains) : undefined;

      if (opts.signWith) {
        if (publicKeyHash || publicKey) {
          throw new UsageError(
            'Pass either --sign-with or --public-key-hash/--public-key, not both.',
            'CONFLICTING_KEY_FLAGS',
          );
        }
        const signer = await resolveSigner(opts.signWith);
        publicKeyHash = signer.publicKeyHash;
        publicKey = signer.publicKey;
      }

      if (!publicKeyHash) {
        throw new UsageError(
          'Provide --sign-with <key>, or --public-key-hash <hash>. '
          + 'To make a key: certen keys generate --name dev',
          'MISSING_SIGNING_KEY',
        );
      }

      const client = await getClient();
      const result = await client.identity.create({
        name: opts.name,
        publicKeyHash,
        publicKey,
        chains,
        credits: opts.credits,
      });
      printOutput(result as unknown as Record<string, unknown>);

      // `create` returns 202 and provisioning continues in the background. Until Phase 1 adds
      // --wait, the least this can do is say so — an identity used before `can_sign` is true fails
      // at the last step of every flow, with an error that never mentions provisioning.
      const id = (result as unknown as { identity?: { id?: string }; id?: string }).identity?.id
        ?? (result as unknown as { id?: string }).id;
      hint('');
      hint('Provisioning continues in the background. Wait for status to be terminal AND can_sign true:');
      hint(`  certen identity get ${id ?? '<id>'}`);
    });

  identity
    .command('list')
    .description('List the identities in your organization (via the portfolio view)')
    .action(async () => {
      // This called GET /v1/identities, which 404s: the gateway serves /v1/identity (POST) and
      // /v1/identity/{id} (GET/PATCH/DELETE) and has no collection route. It then spent a release
      // as a command whose only behaviour was to explain that it did not work — honest, but the
      // user's actual question ("what identities do I have") was answerable the whole time from
      // /v1/portfolio. So answer it, and note the one thing that view genuinely cannot give.
      const client = await getClient();
      const portfolio = await client.portfolio.get();
      const identities = portfolio.identities ?? [];

      if (identities.length === 0) {
        printOutput([]);
        hint('No identities yet. Create one: certen identity create --name <name> --sign-with <key>');
        return;
      }

      printOutput(identities.map((i) => ({
        adi_url: i.adi_url,
        status: i.status,
        credit_balance: i.credit_balance,
        chains: i.chains?.length ?? 0,
        pending_actions: i.pending_actions,
      })));

      // The gap is real and worth naming: /v1/portfolio keys identities by ADI URL and does not
      // return the UUID that `identity get` takes. Someone who did not record the ID at create
      // time cannot recover it here, and pretending otherwise would send them looking for a
      // column that does not exist.
      hint('');
      hint('Note: the gateway has no identity collection route, so this comes from `certen portfolio`.');
      hint('It shows ADI URLs, not the UUIDs `certen identity get` takes — those are printed at create time.');
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
    .requiredOption('--chain <chain>', 'Chain to link, e.g. base-sepolia')
    .action(async (id: string, opts) => {
      const chain = assertChain(opts.chain);
      const client = await getClient();
      const result = await client.identity.update(id, {
        linkChains: [chain],
      });
      printOutput(result as unknown as Record<string, unknown>);
    });
}
