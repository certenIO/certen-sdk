import { getKeyInfo, signHash } from './keystore.js';
import { resolvePassphrase } from './passphrase.js';
import { UsageError } from './errors.js';

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

export async function resolveSigner(name: string): Promise<ResolvedSigner> {
  const info = getKeyInfo(name);
  const passphrase = await resolvePassphrase(info.encrypted, name);
  return {
    publicKey: info.publicKey,
    publicKeyHash: info.publicKeyHash,
    sign: (hashHex: string) => signHash(name, passphrase, hashHex),
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
