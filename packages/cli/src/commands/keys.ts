import { Command } from 'commander';
import { readFileSync } from 'node:fs';
import { inspectSigningData } from '@certen.io/sdk';
import { printOutput, human, hint } from '../output.js';
import { UsageError } from '../errors.js';
import { resolvePassphrase, resolveNewPassphrase, PASSPHRASE_ENV_VAR } from '../passphrase.js';
import {
  generateKey, listKeys, getKeyInfo, deleteKey, signHash, selfTest, keyPath, KEYS_DIR,
} from '../keystore.js';

/**
 * Local signing keys.
 *
 * Certen never holds these. The gateway is given a public key and a signature; the private key
 * stays in ~/.certen/keys at 0600. That is the same posture the SDK documents for `sign`, made
 * available to someone who is driving the CLI instead of writing code.
 */
export function registerKeysCommands(program: Command): void {
  const keys = program.command('keys').description('Local Ed25519 signing keys (never leave this machine)');

  keys
    .command('generate')
    .description('Generate an Ed25519 signing key and store it encrypted')
    .requiredOption('--name <name>', 'Local name for this key')
    .option('--no-passphrase', 'Store the key unencrypted (0600 file permissions only)')
    .action(async (opts: { name: string; passphrase: boolean }) => {
      const passphrase = await resolveNewPassphrase(opts.passphrase === false);
      const info = generateKey(opts.name, passphrase);

      if (passphrase === null) {
        console.error(
          `Warning: key "${info.name}" is stored UNENCRYPTED at ${keyPath(info.name)}. `
          + 'Anyone who can read that file can sign as you.',
        );
      }

      printOutput({
        name: info.name,
        public_key: info.publicKey,
        public_key_hash: info.publicKeyHash,
        encrypted: info.encrypted,
        path: keyPath(info.name),
        created_at: info.createdAt,
      });

      // The hash is what `identity create` needs, and it is not obvious that it is sha256 of the
      // raw public key rather than the key itself. Show the next command instead of explaining.
      console.error('');
      console.error(`Next: certen identity create --name <adi-name> --sign-with ${info.name}`);
    });

  keys
    .command('list')
    .description('List local signing keys (metadata only — never decrypts)')
    .action(() => {
      const all = listKeys();
      if (all.length === 0) {
        human(`(no keys in ${KEYS_DIR})`);
        console.error('');
        console.error('Next: certen keys generate --name dev');
        return;
      }
      printOutput(all.map((k) => ({
        name: k.name,
        public_key_hash: k.publicKeyHash,
        encrypted: k.encrypted,
        created_at: k.createdAt,
      })));
    });

  keys
    .command('show <name>')
    .description('Show one key\'s public material')
    .action((name: string) => {
      const k = getKeyInfo(name);
      printOutput({
        name: k.name,
        public_key: k.publicKey,
        public_key_hash: k.publicKeyHash,
        encrypted: k.encrypted,
        path: keyPath(k.name),
        created_at: k.createdAt,
      });
    });

  keys
    .command('sign')
    .description('Sign the signing data a gateway returned, after rebuilding it and showing what it authorises — prints the signature, sends nothing')
    .requiredOption('--name <name>', 'Key to sign with')
    .option('--signing-data <@file|->', "The gateway's signing_data JSON (as 'tx inspect --json' or the open response shows it); '-' reads stdin")
    .option('--existing', 'The transaction already exists on the network (a co-signature)')
    .option('--hash <hex>', 'REFUSED: a bare hash says nothing about what a signature on it authorises')
    .action(async (opts: { name: string; signingData?: string; existing?: boolean; hash?: string }) => {
      if (opts.hash) {
        throw new UsageError(
          'Refusing to sign a bare hash: it says nothing about what the signature would authorise. Pass --signing-data (the signing_data the gateway returned): '
          + 'the transaction is rebuilt, every hash is recomputed, and what it authorises is shown before the signature is made. There is no option to sign a hash blind.',
          'BLIND_SIGNING_REFUSED',
        );
      }
      if (!opts.signingData) {
        throw new UsageError('Provide --signing-data <@file|->: the signing_data the gateway returned, which is rebuilt and shown before anything is signed.', 'MISSING_SIGNING_DATA');
      }
      const raw = opts.signingData === '-' ? readFileSync(0, 'utf8') : readFileSync(opts.signingData.startsWith('@') ? opts.signingData.slice(1) : opts.signingData, 'utf8');
      let parsed: unknown;
      try { parsed = JSON.parse(raw); } catch (err) {
        throw new UsageError(`--signing-data is not valid JSON: ${err instanceof Error ? err.message : String(err)}`, 'INVALID_SIGNING_DATA_JSON');
      }
      // Accept the signing_data itself, or an intent / inspect output that carries it.
      const sd = (parsed as { signing_data?: unknown })?.signing_data ?? parsed;
      const info = getKeyInfo(opts.name);
      // Offline and with nothing to compare it with: every hash is recomputed and must agree, the signature metadata must name THIS key, and the
      // summary says what the signature would authorise. Whether that is what you meant is for the person reading it.
      const summary = await inspectSigningData(sd, { signerPublicKey: info.publicKey, ...(opts.existing ? { existing: true } : {}) });
      hint(summary.text.join(String.fromCharCode(10)));
      const passphrase = await resolvePassphrase(info.encrypted, opts.name);
      const signature = signHash(opts.name, passphrase, summary.hashes.toSign);
      printOutput({ signature, public_key: info.publicKey, hash_signed: summary.hashes.toSign, signing: summary } as unknown as Record<string, unknown>);
    });

  keys
    .command('verify <name>')
    .description('Check the key decrypts and produces a signature its own public key accepts')
    .action(async (name: string) => {
      const info = getKeyInfo(name);
      const passphrase = await resolvePassphrase(info.encrypted, name);
      const ok = selfTest(name, passphrase);
      printOutput({ name, ok, public_key_hash: info.publicKeyHash });
      if (!ok) process.exitCode = 1;
    });

  keys
    .command('delete <name>')
    .description('Delete a local key file (irreversible)')
    .requiredOption('--yes', 'Confirm deletion')
    .action((name: string) => {
      // No prompt: the required --yes is the confirmation. A key that controls a live key page
      // should not be deletable by an accidental Enter on a y/N prompt.
      const path = keyPath(name);
      deleteKey(name);
      human(`Deleted ${path}`);
      console.error('If this key was on a key page, it is still on that page — remove it there too.');
    });

  keys
    .command('path')
    .description('Print where keys are stored')
    .action(() => {
      printOutput({ keys_dir: KEYS_DIR, passphrase_env: PASSPHRASE_ENV_VAR });
    });
}
