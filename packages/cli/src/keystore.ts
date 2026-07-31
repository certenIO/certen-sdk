import {
  createCipheriv, createDecipheriv, createHash, createPrivateKey, createPublicKey,
  generateKeyPairSync, randomBytes, scryptSync, sign as edSign, timingSafeEqual,
  verify as edVerify,
} from 'crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync, statSync, readdirSync, unlinkSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const KEYS_DIR = join(homedir(), '.certen', 'keys');

/**
 * A local Ed25519 signing key.
 *
 * The CLI shipped without one, which made it read-only in practice: `tx sign` takes
 * `--signature <hex>`, so anyone without their own Ed25519 tooling could authenticate and
 * query and then stop. The SDK's `sign` callback covers people writing code; it does nothing
 * for someone driving the CLI.
 *
 * The non-custodial posture is unchanged. The key is generated here, encrypted here, and
 * never leaves this machine — the CLI sends a signature, never a private key. This file is
 * the local half of the same contract the SDK states: you hold the key, we hand you bytes.
 */

/** scrypt, not argon2id. */
// argon2id is the better KDF and was the original intent. Every Node implementation of it is a
// native module, and a native dependency in a globally-installed CLI turns `npm i -g @certen.io/cli`
// into a compiler invocation that fails on any machine without build tools — the exact audience
// this command exists to serve. scrypt is memory-hard, in the standard library, and at these
// parameters (~134 MB, ~1s) is a sound choice for a passphrase-derived file key. Revisit if a
// pure-WASM argon2id becomes viable.
const KDF = { N: 65536, r: 8, p: 1, keylen: 32 } as const;
// Node's scrypt refuses to allocate past `maxmem` (32 MB default). 128*N*r is ~67 MB here, so it
// must be raised explicitly or every generate fails with an opaque ERR_CRYPTO_INVALID_SCRYPT_PARAM.
const SCRYPT_MAXMEM = 256 * 1024 * 1024;

const CIPHER = 'aes-256-gcm';
const VERSION = 1;

export interface StoredKey {
  version: number;
  name: string;
  algorithm: 'ed25519';
  /** Raw 32-byte Ed25519 public key, hex. */
  publicKey: string;
  /** sha256(raw public key), hex — what `identity create` wants as `public_key_hash`. */
  publicKeyHash: string;
  createdAt: string;
  encryption: {
    kdf: 'scrypt';
    params: typeof KDF;
    salt: string;
    cipher: typeof CIPHER;
    iv: string;
    authTag: string;
  } | null;
  /** PKCS8 DER, hex. Ciphertext when `encryption` is set, plaintext when it is null. */
  privateKey: string;
}

export interface KeyInfo {
  name: string;
  publicKey: string;
  publicKeyHash: string;
  createdAt: string;
  encrypted: boolean;
}

/**
 * Key names become filenames, so anything that could escape the directory or collide with a
 * different name after normalization is rejected rather than sanitized. Silently rewriting a
 * name means `certen keys sign --name ../../x` signs with something the user did not choose.
 */
const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

export function assertValidName(name: string): void {
  if (!NAME_RE.test(name)) {
    throw new Error(
      `Invalid key name "${name}". Use 1-64 characters: letters, digits, hyphen, underscore; must start with a letter or digit.`,
    );
  }
}

function keyPath(name: string): string {
  assertValidName(name);
  return join(KEYS_DIR, `${name}.json`);
}

function ensureKeysDir(): void {
  if (!existsSync(KEYS_DIR)) {
    mkdirSync(KEYS_DIR, { recursive: true, mode: 0o700 });
  }
  try {
    chmodSync(KEYS_DIR, 0o700);
  } catch {
    // Windows or a non-permission-aware filesystem: best effort, same as config.ts.
  }
}

function writeKeyFile(name: string, key: StoredKey): void {
  ensureKeysDir();
  const path = keyPath(name);
  writeFileSync(path, JSON.stringify(key, null, 2), { encoding: 'utf-8', mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    // Best effort, as above.
  }
}

/**
 * Refuse to read a key file that group or world can read. Same rule config.ts applies to the
 * API key, and it matters more here: an API key can be revoked from the portal in one click,
 * a signing key that controls an on-chain key page cannot.
 *
 * POSIX only. Windows does not implement POSIX mode bits — `chmod` is a no-op there and
 * `statSync().mode` reports a synthesized 0666/0444 derived from the read-only attribute, never
 * 0600. Enforcing the check on that synthetic value rejects every key file on Windows, including
 * ones the user just created, while telling them to run a `chmod` that cannot fix it. Access
 * control on Windows is the file's ACL, which it inherits from the user profile directory.
 */
function assertFileSecure(path: string): void {
  if (process.platform === 'win32') return;
  try {
    const mode = statSync(path).mode & 0o077;
    if (mode !== 0) {
      throw new Error(
        `Refusing to read ${path} — permissions are not 0600. Run: chmod 600 "${path}"`,
      );
    }
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('Refusing')) throw err;
    // stat failed for a reason other than our own check (missing file): let the caller's
    // existence check produce the clearer message.
  }
}

/** Raw 32-byte public key from a KeyObject. The last 32 bytes of the SPKI DER are the key. */
function rawPublicKey(publicKey: ReturnType<typeof createPublicKey>): Buffer {
  const spki = publicKey.export({ format: 'der', type: 'spki' }) as Buffer;
  return spki.subarray(spki.length - 32);
}

export function publicKeyHashOf(rawPub: Buffer): string {
  return createHash('sha256').update(rawPub).digest('hex');
}

function deriveFileKey(passphrase: string, salt: Buffer): Buffer {
  return scryptSync(passphrase, salt, KDF.keylen, {
    N: KDF.N, r: KDF.r, p: KDF.p, maxmem: SCRYPT_MAXMEM,
  });
}

export function keyExists(name: string): boolean {
  return existsSync(keyPath(name));
}

export function generateKey(name: string, passphrase: string | null): KeyInfo {
  assertValidName(name);
  if (keyExists(name)) {
    throw new Error(`Key "${name}" already exists at ${keyPath(name)}. Choose another name or delete it first.`);
  }

  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const rawPub = rawPublicKey(publicKey);
  const pkcs8 = privateKey.export({ format: 'der', type: 'pkcs8' }) as Buffer;

  let encryption: StoredKey['encryption'] = null;
  let stored: string;

  if (passphrase === null) {
    stored = pkcs8.toString('hex');
  } else {
    const salt = randomBytes(16);
    const iv = randomBytes(12);
    const fileKey = deriveFileKey(passphrase, salt);
    const cipher = createCipheriv(CIPHER, fileKey, iv);
    const ct = Buffer.concat([cipher.update(pkcs8), cipher.final()]);
    encryption = {
      kdf: 'scrypt', params: KDF, salt: salt.toString('hex'),
      cipher: CIPHER, iv: iv.toString('hex'), authTag: cipher.getAuthTag().toString('hex'),
    };
    stored = ct.toString('hex');
  }

  const key: StoredKey = {
    version: VERSION,
    name,
    algorithm: 'ed25519',
    publicKey: rawPub.toString('hex'),
    publicKeyHash: publicKeyHashOf(rawPub),
    createdAt: new Date().toISOString(),
    encryption,
    privateKey: stored,
  };

  writeKeyFile(name, key);
  return toInfo(key);
}

function toInfo(k: StoredKey): KeyInfo {
  return {
    name: k.name,
    publicKey: k.publicKey,
    publicKeyHash: k.publicKeyHash,
    createdAt: k.createdAt,
    encrypted: k.encryption !== null,
  };
}

export function readKeyFile(name: string): StoredKey {
  const path = keyPath(name);
  if (!existsSync(path)) {
    throw new Error(`No key named "${name}". Run \`certen keys list\` to see what you have, or \`certen keys generate --name ${name}\`.`);
  }
  assertFileSecure(path);
  const parsed = JSON.parse(readFileSync(path, 'utf-8')) as StoredKey;
  if (parsed.version !== VERSION) {
    throw new Error(`Key "${name}" has unsupported version ${parsed.version} (this CLI understands ${VERSION}).`);
  }
  if (parsed.algorithm !== 'ed25519') {
    throw new Error(`Key "${name}" uses unsupported algorithm "${parsed.algorithm}".`);
  }
  return parsed;
}

/** Metadata only — never decrypts, so it never needs a passphrase. */
export function getKeyInfo(name: string): KeyInfo {
  return toInfo(readKeyFile(name));
}

export function listKeys(): KeyInfo[] {
  if (!existsSync(KEYS_DIR)) return [];
  return readdirSync(KEYS_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.slice(0, -5))
    .filter((n) => NAME_RE.test(n))
    .map((n) => {
      try {
        return toInfo(readKeyFile(n));
      } catch {
        // A corrupt or unreadable file should not make `keys list` fail for every other key.
        return null;
      }
    })
    .filter((k): k is KeyInfo => k !== null)
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function deleteKey(name: string): void {
  const path = keyPath(name);
  if (!existsSync(path)) throw new Error(`No key named "${name}".`);
  unlinkSync(path);
}

export function isEncrypted(name: string): boolean {
  return readKeyFile(name).encryption !== null;
}

function decryptPrivateKey(k: StoredKey, passphrase: string | null): Buffer {
  if (k.encryption === null) return Buffer.from(k.privateKey, 'hex');
  if (passphrase === null) {
    throw new Error(`Key "${k.name}" is encrypted — a passphrase is required.`);
  }
  const enc = k.encryption;
  const fileKey = deriveFileKey(passphrase, Buffer.from(enc.salt, 'hex'));
  const decipher = createDecipheriv(enc.cipher, fileKey, Buffer.from(enc.iv, 'hex'));
  decipher.setAuthTag(Buffer.from(enc.authTag, 'hex'));
  try {
    return Buffer.concat([decipher.update(Buffer.from(k.privateKey, 'hex')), decipher.final()]);
  } catch {
    // GCM auth failure is indistinguishable from a wrong passphrase, and saying "wrong
    // passphrase" for a corrupted file sends people down the wrong path. Say both.
    throw new Error(`Could not decrypt key "${k.name}" — wrong passphrase, or the file has been modified.`);
  }
}

/**
 * Sign the RAW BYTES of `hashHex` — matching the SDK's `SignFn` contract exactly.
 *
 * The two ways to get this wrong are signing the ASCII of the hex string, and hashing the hash
 * again before signing. Both produce a well-formed 128-hex signature that the gateway rejects
 * with a signature-verification error that names neither cause, so the decoding happens here
 * once rather than in every caller.
 */
export function signHash(name: string, passphrase: string | null, hashHex: string): string {
  const clean = hashHex.trim().toLowerCase().replace(/^0x/, '');
  if (!/^[0-9a-f]+$/.test(clean) || clean.length % 2 !== 0) {
    throw new Error(`--hash must be an even-length hex string, got "${hashHex}".`);
  }
  const k = readKeyFile(name);
  const pkcs8 = decryptPrivateKey(k, passphrase);
  const privateKey = createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' });
  const sig = edSign(null, Buffer.from(clean, 'hex'), privateKey);
  return sig.toString('hex');
}

/**
 * Verify a stored key can actually produce a signature its own public key accepts.
 *
 * Cheap, and it catches a passphrase that decrypts to garbage which happens to survive GCM
 * (it cannot, in practice) as well as any future format drift, before a signature goes to the
 * gateway and comes back as an opaque rejection.
 */
export function selfTest(name: string, passphrase: string | null): boolean {
  const k = readKeyFile(name);
  const probe = randomBytes(32).toString('hex');
  const sig = Buffer.from(signHash(name, passphrase, probe), 'hex');
  const pub = createPublicKey({
    // SPKI DER prefix for Ed25519, then the raw 32-byte key.
    key: Buffer.concat([
      Buffer.from('302a300506032b6570032100', 'hex'),
      Buffer.from(k.publicKey, 'hex'),
    ]),
    format: 'der',
    type: 'spki',
  });
  return edVerify(null, Buffer.from(probe, 'hex'), pub, sig);
}

/** Constant-time compare for the confirm-passphrase path. */
export function samePassphrase(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf-8');
  const bb = Buffer.from(b, 'utf-8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export { KEYS_DIR, keyPath };
