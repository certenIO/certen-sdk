import { getKeyInfo, signHash } from './keystore.js';
import { resolvePassphrase } from './passphrase.js';

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
  if (opts.signWith) {
    if (opts.signature) {
      throw new Error('Pass either --sign-with or --signature, not both.');
    }
    if (!opts.hash) {
      throw new Error('--sign-with needs the hash to sign; this command did not supply one.');
    }
    const signer = await resolveSigner(opts.signWith);
    return { signature: signer.sign(opts.hash), publicKey: signer.publicKey };
  }

  if (!opts.signature || !opts.publicKey) {
    throw new Error('Provide --sign-with <key>, or both --signature <hex> and --public-key <hex>.');
  }
  return { signature: opts.signature, publicKey: opts.publicKey };
}
