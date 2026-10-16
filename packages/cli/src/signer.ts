import { getKeyInfo, unlockKey } from './keystore.js';
import { resolvePassphrase } from './passphrase.js';
import { CliError, EXIT, UsageError } from './errors.js';
import { keyArg } from './next-step.js';
import { sessionSigner, type SessionOptions } from './session-unlock.js';

/**
 * Bridge a local key into the shape the rest of the CLI needs.
 *
 * `--sign-with` resolves a stored key once, unlocks it once, and hands back both the public
 * material and a `sign` function. Unlocking once matters: a flow that signs twice must not
 * prompt twice, and holding the passphrase in a closure keeps it off argv where every process
 * lister on the machine can read it.
 */
export interface ResolvedSigner {
  publicKey: string;
  publicKeyHash: string;
  sign: (hashHex: string) => string;
}

export interface ResolveSignerOptions {
  /**
   * May an unlocked session (`keys unlock`) stand in for the passphrase? Default true.
   *
   * Pass `false` where the bytes being signed are chosen by the GATEWAY and no card can describe them: `signup --with-key` signs a 32-byte nonce, and the
   * passphrase prompt is the one moment a person is made to notice a key is being used. With `false` the session is not used and not even read.
   */
  session?: boolean;
  /** A keyring and clock to use instead of the OS ones. For tests; production leaves it out. */
  sessionOptions?: SessionOptions;
}

export async function resolveSigner(name: string, opts: ResolveSignerOptions = {}): Promise<ResolvedSigner> {
  const info = getKeyInfo(name);
  // A key the person has unlocked for a while signs without a prompt, and without reading CERTEN_KEY_PASSPHRASE: the session replaces ONLY the
  // passphrase. The card, `checkIntentSigning` and the confirmation all still run in the callers. Inert unless the experimental switch is on
  // (session-unlock.ts), and a session that does not check out is removed and falls through to the prompt.
  const session = opts.session === false ? undefined : await sessionSigner(name, info, opts.sessionOptions);
  if (session) return { publicKey: info.publicKey, publicKeyHash: info.publicKeyHash, sign: session.sign };
  const passphrase = await resolvePassphrase(info.encrypted, name);
  // Unlocked NOW, not at the moment of signing. A wrong passphrase used to surface only when the signature was made: after the intent was
  // opened and after a person had read the card and said yes, as an untyped error. Here it ends the command before anything exists.
  let key: ReturnType<typeof unlockKey>;
  try {
    key = unlockKey(name, passphrase);
  } catch (err) {
    // The key store types what it knows: WRONG_PASSPHRASE (the key did not open), PASSPHRASE_REQUIRED, KEY_FILE_*. Those pass through as they are, so "this
    // key needs a passphrase" is not reported as "wrong passphrase". Anything else that comes out of the unlock is, as it always was, a key that would not open;
    // `keys verify` is the command that asks for the passphrase and says whether it does, so a person can sort it out without an intent in play.
    if (err instanceof CliError) throw err;
    throw new CliError(err instanceof Error ? err.message : String(err), 'WRONG_PASSPHRASE', EXIT.FAILED, false, undefined, `certen keys verify ${keyArg(name)}`);
  }
  return {
    publicKey: info.publicKey,
    publicKeyHash: info.publicKeyHash,
    sign: (hashHex: string) => key.sign(hashHex),
  };
}

/**
 * Resolve the signature/public-key pair for a command that accepts either `--sign-with` or the
 * explicit `--signature`/`--public-key` pair.
 *
 * The explicit pair stays first-class — it is how an HSM, an air-gapped machine, or someone
 * else's policy signer participates, and removing it would trade one locked-out audience for
 * another. `--sign-with` is the convenience path, not the replacement.
 */
export async function resolveSignature(opts: {
  signWith?: string;
  signature?: string;
  publicKey?: string;
  hash?: string;
}): Promise<{ signature: string; publicKey: string }> {
  // These are wrong invocations and must exit 2, not 1. As bare Errors they were indistinguishable
  // from a rejected request, which is the exact confusion the exit-code taxonomy exists to prevent.
  if (opts.signWith) {
    if (opts.signature) {
      throw new UsageError('Pass either --sign-with or --signature, not both.', 'CONFLICTING_SIGNING_FLAGS');
    }
    // A hash on its own says nothing about what a signature on it would authorise, so this command will not sign one. The commands that
    // open the thing being signed (`tx create --sign-with`, `call`, `governance ... --sign-with`, `pending sign --sign-with`) rebuild the
    // transaction, check it against the request and show it before signing. To sign elsewhere, `inspect` it first and pass --signature.
    throw new UsageError(
      'Refusing to sign a bare hash: it says nothing about what the signature would authorise. Sign where the transaction is opened '
      + '(tx create --sign-with, call, governance <op> --sign-with, pending sign --sign-with), which rebuild it, check it against your '
      + 'request and show it first. To sign somewhere else, run the matching "inspect" command, then pass --signature and --public-key. '
      + 'There is no option to sign a hash blind.',
      'BLIND_SIGNING_REFUSED',
    );
  }

  if (!opts.signature || !opts.publicKey) {
    throw new UsageError(
      'Provide --sign-with <key>, or both --signature <hex> and --public-key <hex>.',
      'MISSING_SIGNATURE',
    );
  }
  return { signature: opts.signature, publicKey: opts.publicKey };
}
