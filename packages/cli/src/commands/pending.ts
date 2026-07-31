import { Command } from 'commander';
import { CertenClient } from '@certen.io/sdk';
import { getApiKey, getApiUrl } from '../config.js';
import { printOutput } from '../output.js';
import { resolveSignature } from '../signer.js';

async function getClient(): Promise<CertenClient> {
  return new CertenClient({ apiKey: await getApiKey(), baseUrl: getApiUrl() });
}

export function registerPendingCommands(program: Command): void {
  const pending = program.command('pending').description('Pending actions inbox');

  pending
    .command('list')
    .description('List pending actions')
    .option('--identity <id>', 'Filter by identity')
    .option('--status <status>', 'Filter by status')
    .option('--category <cat>', 'Filter by category')
    .option('--limit <n>', 'Max results', parseInt)
    .option('--offset <n>', 'Offset', parseInt)
    .action(async (opts) => {
      const client = await getClient();
      const result = await client.pending.list({
        identity: opts.identity,
        status: opts.status,
        category: opts.category,
        limit: opts.limit,
        offset: opts.offset,
      });
      printOutput(result as unknown as Record<string, unknown>);
    });

  pending
    .command('sign <id>')
    .description('Create a sign request for a pending action')
    .option('--identity <id>', 'Identity to sign as')
    .option('--signer-url <url>', 'Signer URL')
    // Was documented as "accept/reject". The API takes a lowercase `approve` | `reject` |
    // `abstain`; `accept` is rejected. The help text was sending people to a value that fails.
    .option('--vote <vote>', 'Vote: approve | reject | abstain')
    .action(async (id: string, opts) => {
      const client = await getClient();
      const result = await client.sign.create({
        type: 'pending_action',
        targetId: id,
        identity: opts.identity,
        signerUrl: opts.signerUrl,
        vote: opts.vote,
      });
      printOutput(result as unknown as Record<string, unknown>);
    });

  pending
    .command('submit <id>')
    .description('Submit a signature for a pending sign request')
    .option('--sign-with <key>', 'Local key to sign with (needs --hash)')
    .option('--hash <hex>', 'Hash to sign, from the sign request\'s signing data')
    .option('--signature <sig>', 'Signature (hex) — for an HSM or air-gapped signer')
    .option('--public-key <key>', 'Public key (hex), required with --signature')
    .action(async (id: string, opts) => {
      const { signature, publicKey } = await resolveSignature({
        signWith: opts.signWith,
        signature: opts.signature,
        publicKey: opts.publicKey,
        hash: opts.hash,
      });
      const client = await getClient();
      const result = await client.sign.submitSignature(id, { signature, publicKey });
      printOutput(result as unknown as Record<string, unknown>);
    });
}
