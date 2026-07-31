import { Command } from 'commander';
import { printOutput } from '../output.js';
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
        console.log(`(no keys in ${KEYS_DIR})`);
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
    .description('Sign a hash with a local key — prints the signature, sends nothing')
    .requiredOption('--name <name>', 'Key to sign with')
    .requiredOption('--hash <hex>', 'Hash to sign (hex, as returned by the gateway)')
    .action(async (opts: { name: string; hash: string }) => {
      const info = getKeyInfo(opts.name);
      const passphrase = await resolvePassphrase(info.encrypted, opts.name);
      const signature = signHash(opts.name, passphrase, opts.hash);
      printOutput({ signature, public_key: info.publicKey });
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
      console.log(`Deleted ${path}`);
      console.error('If this key was on a key page, it is still on that page — remove it there too.');
    });

  keys
    .command('path')
    .description('Print where keys are stored')
    .action(() => {
      printOutput({ keys_dir: KEYS_DIR, passphrase_env: PASSPHRASE_ENV_VAR });
    });
}
