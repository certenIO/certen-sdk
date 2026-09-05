import { Command } from 'commander';
import { CertenClient } from '@certen.io/sdk';
import { getApiKey, getApiUrl } from '../config.js';
import { printOutput, hint } from '../output.js';
import { resolveSigner } from '../signer.js';

/** `--account` for an authority operation: nothing for the identity, `<adi>/book` for "book", a URL as given. */
function accountTarget(opts: { identity: string; account?: string }): { account_url?: string } {
  if (!opts.account || opts.account === 'identity') return {};
  if (opts.account === 'book') return { account_url: `${opts.identity.replace(/\/+$/, '')}/book` };
  return { account_url: opts.account };
}

async function getClient(): Promise<CertenClient> {
  return new CertenClient({ apiKey: await getApiKey(), baseUrl: getApiUrl() });
}

/**
 * Every governance operation is the same two steps: the gateway builds the Accumulate transaction
 * and returns `signing_data.hash_to_sign`; a key that is ON THE PAGE signs it and the signature is
 * submitted. Without `--sign-with` the first step happens and the hash is printed for an external
 * signer, which is how an HSM or the policy signer participates. With it, both steps happen here.
 */
async function submitGovernance(
  operation: Record<string, unknown>,
  opts: { identity: string; signWith?: string; signerKeyPage?: string },
): Promise<void> {
  const client = await getClient();
  const signer = opts.signWith ? await resolveSigner(opts.signWith) : null;
  const created = await client.governance.create({
    identity: opts.identity,
    operations: [operation],
    signerKeyPage: opts.signerKeyPage,
    signerPublicKey: signer?.publicKey,
  });
  const hash = created.signing_data?.hash_to_sign;
  if (!signer || !hash) {
    printOutput(created as unknown as Record<string, unknown>);
    if (hash) {
      hint('');
      hint(`Sign signing_data.hash_to_sign with a key on the page, then: certen governance sign ${created.governance_op_id} --signature <hex> --public-key <hex>`);
    }
    return;
  }
  const submitted = await client.governance.submitSignature(created.governance_op_id, {
    signature: signer.sign(hash),
    publicKey: signer.publicKey,
  });
  printOutput({ ...created, ...submitted } as unknown as Record<string, unknown>);
}

export function registerGovernanceCommands(program: Command): void {
  const governance = program.command('governance').description('Who may sign for an identity, and under what rules');

  const signing = (cmd: Command) => cmd
    .option('--sign-with <key>', 'Local key on the page: sign the returned hash and submit it in one step')
    .option('--signer-key-page <url>', 'Sign with a specific page of the book, e.g. acc://org.acme/book/2');

  signing(governance
    .command('add-key')
    .description('Seat another key on the identity\'s key page — a co-signer, a human, a second agent')
    .requiredOption('--identity <adi>', 'Identity ADI, e.g. acc://org.acme')
    .requiredOption('--public-key-hash <hex>', 'sha256 of the new key\'s raw public key, 64 hex (certen keys list shows it)'))
    .action(async (opts) => {
      await submitGovernance({ type: 'add_key', public_key_hash: opts.publicKeyHash }, opts);
    });

  signing(governance
    .command('remove-key')
    .description('Remove a seat from the identity\'s key page')
    .requiredOption('--identity <adi>', 'Identity ADI, e.g. acc://org.acme')
    .requiredOption('--public-key-hash <hex>', 'sha256 of the key to remove, 64 hex'))
    .action(async (opts) => {
      await submitGovernance({ type: 'remove_key', public_key_hash: opts.publicKeyHash }, opts);
    });

  signing(governance
    .command('set-threshold')
    .description('Set the M-of-N acceptThreshold on an identity key page')
    .requiredOption('--identity <adi>', 'Identity ADI, e.g. acc://org.acme')
    .requiredOption('--threshold <n>', 'New threshold', parseInt))
    .action(async (opts) => {
      await submitGovernance({ type: 'set_threshold', threshold: opts.threshold }, opts);
    });

  signing(governance
    .command('add-authority')
    .description('Name a key book as a REQUIRED authority: every transaction then waits for it to sign too — how a policy signer regulates an agent')
    .requiredOption('--identity <adi>', 'Identity ADI, e.g. acc://org.acme')
    .requiredOption('--authority <book-url>', 'The key book that must co-sign, e.g. acc://owner-policy.acme/book')
    .option('--account <url>', 'The account to put it on: the identity (default), "book" for its key book — so seats and thresholds face the authority too — or a full account URL under the identity'))
    .action(async (opts) => {
      await submitGovernance({ type: 'add_authority', authority_url: opts.authority, ...accountTarget(opts) }, opts);
    });

  signing(governance
    .command('remove-authority')
    .description('Release a required authority')
    .requiredOption('--identity <adi>', 'Identity ADI, e.g. acc://org.acme')
    .requiredOption('--authority <book-url>', 'The key book to release')
    .option('--account <url>', 'The account to release it from: the identity (default), "book", or a full account URL under the identity'))
    .action(async (opts) => {
      await submitGovernance({ type: 'remove_authority', authority_url: opts.authority, ...accountTarget(opts) }, opts);
    });

  signing(governance
    .command('add-delegate')
    // `--identity` is the ADI (acc://org.acme), not a uuid — the governance endpoint keys on the ADI.
    .description('Add a delegate to an identity key book')
    .requiredOption('--identity <adi>', 'Identity ADI, e.g. acc://org.acme')
    .requiredOption('--delegate-url <url>', 'Delegate URL to add'))
    .action(async (opts) => {
      await submitGovernance({ type: 'add_delegate', delegate_url: opts.delegateUrl }, opts);
    });

  governance
    .command('sign <governance-op-id>')
    .description('Submit a signature for a governance operation created without --sign-with')
    .option('--sign-with <key>', 'Local key to sign with (needs --hash)')
    .option('--hash <hex>', 'The operation\'s signing_data.hash_to_sign')
    .option('--signature <hex>', 'A signature produced elsewhere (with --public-key)')
    .option('--public-key <hex>', 'The signing key\'s public key, 64 hex')
    .action(async (id, opts) => {
      const { resolveSignature } = await import('../signer.js');
      const { signature, publicKey } = await resolveSignature(opts);
      const client = await getClient();
      const result = await client.governance.submitSignature(id, { signature, publicKey });
      printOutput(result as unknown as Record<string, unknown>);
    });
}
