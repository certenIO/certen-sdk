import { Command } from 'commander';
import { readFileSync } from 'node:fs';
import { inspectSigningData } from '@certen.io/sdk';
import { printOutput, human, hint } from '../output.js';
import { UsageError } from '../errors.js';
import { resolvePassphrase, resolveNewPassphrase, PASSPHRASE_ENV_VAR } from '../passphrase.js';
import {
  assertUnlockEnabled, keyUnlockEnabled, lockSessions, sessionSigner, unlockedUntil, unlockSession, unlockSpanMs,
} from '../session-unlock.js';
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
      console.error(`Next: certen setup --key ${info.name}   (makes the account and identity this key owns, checks gas, and saves your defaults)`);
    });

  keys
    .command('list')
    .description('List local signing keys (metadata only — never decrypts)')
    .action(async () => {
      const all = listKeys();
      if (all.length === 0) {
        human(`(no keys in ${KEYS_DIR})`);
        console.error('');
        console.error('Next: certen setup   (makes a key, an identity, and everything after)');
        return;
      }
      // `unlocked_until` exists only while the experimental unlock switch is on: with it off this listing is exactly what it always was.
      const withSessions = keyUnlockEnabled();
      const rows = [];
      for (const k of all) {
        const until = withSessions ? await unlockedUntil(k.name, k) : null;
        rows.push({
          name: k.name,
          public_key_hash: k.publicKeyHash,
          encrypted: k.encrypted,
          created_at: k.createdAt,
          ...(withSessions ? { unlocked_until: until === null ? null : new Date(until).toISOString() } : {}),
        });
      }
      printOutput(rows);
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
      // A key unlocked for a while signs without a prompt (only with the experimental switch on); the summary above was shown either way.
      const session = await sessionSigner(opts.name, info);
      const signature = session
        ? session.sign(summary.hashes.toSign)
        : signHash(opts.name, await resolvePassphrase(info.encrypted, opts.name), summary.hashes.toSign);
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
    .command('unlock <name>')
    .description('Keep a key unlocked for a while so signing does not ask for its passphrase (experimental: ships behind a security review)')
    .option('--for <duration>', 'How long: 90s, 15m, 1h (a bare number is minutes). Default 15m, at most 8h')
    .action(async (name: string, opts: { for?: string }) => {
      // Every refusal comes before the passphrase is read (session-unlock.ts): the switch, then the length, then the key, then the keyring.
      assertUnlockEnabled();
      const ttl = unlockSpanMs(opts.for);
      const done = await unlockSession(name, ttl, (info) => resolvePassphrase(info.encrypted, name));
      printOutput({
        name: done.name,
        public_key_hash: done.public_key_hash,
        unlocked_until: new Date(done.expires_at).toISOString(),
        for_seconds: Math.round((done.expires_at - done.unlocked_at) / 1000),
      });
      console.error('');
      console.error(`The decrypted key is held in your OS keyring until then. Wipe it sooner with: certen keys lock ${done.name}`);
    });

  keys
    .command('lock [name]')
    .description('Wipe the unlocked session of a key (or of every key with --all). Always safe to run')
    .option('--all', 'Wipe the sessions of every local key')
    .action(async (name: string | undefined, opts: { all?: boolean }) => {
      if (name !== undefined && opts.all) {
        throw new UsageError('Give a key name or --all, not both.', 'CONFLICTING_OPTIONS');
      }
      if (name === undefined && !opts.all) {
        throw new UsageError('Which key? Give its name, or --all to lock every key: certen keys lock <name> | certen keys lock --all', 'LOCK_TARGET_REQUIRED');
      }
      const names = opts.all ? listKeys().map((k) => k.name) : [name!];
      const done = await lockSessions(names);
      printOutput({ locked: done.wiped, not_unlocked: done.not_unlocked, keyring: done.keyring });
      if (done.keyring === 'unavailable') {
        console.error('No OS keyring can be loaded here, so no key can have been unlocked: there was nothing to wipe.');
      } else if (done.wiped.length === 0) {
        console.error(names.length === 0 ? 'There are no local keys.' : `Nothing was unlocked: ${names.join(', ')}.`);
      } else {
        console.error(`Locked: ${done.wiped.join(', ')}. Signing asks for the passphrase again.`);
      }
    });

  keys
    .command('delete <name>')
    .description('Delete a local key file (irreversible)')
    .requiredOption('--yes', 'Confirm deletion')
    .action(async (name: string) => {
      // No prompt: the required --yes is the confirmation. A key that controls a live key page
      // should not be deletable by an accidental Enter on a y/N prompt.
      const path = keyPath(name);
      // A deleted key must not stay usable from the OS keyring for the rest of its session. Only when the experimental unlock switch is on, so with it
      // off this command is exactly what it was (a headless machine's keyring would otherwise be asked about a feature nobody turned on).
      if (keyUnlockEnabled()) {
        try {
          const locked = await lockSessions([name]);
          if (locked.wiped.length > 0) console.error(`Also locked the unlocked session for "${name}".`);
        } catch (err) {
          console.error(`Warning: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
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
