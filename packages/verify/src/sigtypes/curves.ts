/**
 * The signature algorithms behind the nine key-signature types, each accepting exactly what the Go call Accumulate's Verify
 * makes accepts. The mathematics is @noble/curves and @noble/hashes; what is written here is only the choice of which
 * encodings and which edge cases reach it, and each function says which Go function it stands for.
 *
 *   ed25519Verify             crypto/ed25519.Verify (ed25519, rcd1, legacyED25519)
 *   secp256k1Verify           crypto/ecdsa.Verify on Accumulate's own secp256k1 curve, no low-S rule (btc, btclegacy, eth, typedData)
 *   ecdsaAsn1Verify           crypto/ecdsa.VerifyASN1 over a PKIX key (ecdsaSha256)
 *   rsaPkcs1v15Sha256Verify   crypto/rsa.VerifyPKCS1v15 with the digest as the already-hashed value (rsaSha256)
 *
 * None enforces a rule Accumulate does not: no low-S, no strict-DER for the secp256k1 types, no minimum curve beyond what Go's
 * x509 knows. Each refuses everything Go refuses.
 */
import { ed25519 } from '@noble/curves/ed25519';
import { p256, p384, p521 } from '@noble/curves/nist';
import { secp256k1 } from '@noble/curves/secp256k1';
import { ecdsa, weierstrassN } from '@noble/curves/abstract/weierstrass';
import { sha256 as nobleSha256, sha512 } from '@noble/hashes/sha2';
import { laxSecp256k1Signature, parsePkcs1Rsa, parseSpkiEcdsa, strictEcdsaSignature, type EcCurve } from './der.js';

const toBig = (b: Uint8Array): bigint => {
  let n = 0n;
  for (const x of b) n = (n << 8n) | BigInt(x);
  return n;
};
const toBigLE = (b: Uint8Array): bigint => {
  let n = 0n;
  for (let i = b.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(b[i]!);
  return n;
};
function fixed(n: bigint, len: number): Uint8Array {
  const out = new Uint8Array(len);
  let x = n;
  for (let i = len - 1; i >= 0; i--) {
    out[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  return out;
}

// ------------------------------------------------------------------ ed25519

const ED_L = ed25519.Point.Fn.ORDER;

/**
 * crypto/ed25519.Verify (Go 1.25, crypto/internal/fips140/ed25519): a 64-byte signature whose scalar has the top three bits
 * clear and is below the group order; the public key decodes as Go decodes it (a non-canonical encoding of a valid point is
 * accepted); R must be the canonical encoding of a point; and [S]B = R + [k]A holds exactly (cofactorless), k being
 * SHA-512(R || A || message) reduced mod L, with A the public key bytes as given. The point arithmetic is @noble/curves.
 */
export function ed25519Verify(publicKey: Uint8Array, message: Uint8Array, signature: Uint8Array): boolean {
  if (publicKey.length !== 32 || signature.length !== 64) return false;
  if ((signature[63]! & 224) !== 0) return false;
  const rBytes = signature.subarray(0, 32);
  const s = toBigLE(signature.subarray(32));
  if (s >= ED_L) return false;
  let a, r;
  try {
    a = ed25519.Point.fromBytes(publicKey, true);
    r = ed25519.Point.fromBytes(rBytes, true);
  } catch {
    return false;
  }
  const canonical = r.toBytes();
  for (let i = 0; i < 32; i++) if (canonical[i] !== rBytes[i]) return false;
  const input = new Uint8Array(64 + message.length);
  input.set(rBytes, 0);
  input.set(publicKey, 32);
  input.set(message, 64);
  const k = toBigLE(sha512(input)) % ED_L;
  return ed25519.Point.BASE.multiplyUnsafe(s).equals(r.add(a.multiplyUnsafe(k)));
}

// ------------------------------------------------------------------ secp256k1 (btc, btclegacy, eth, typedData)

const SECP_P = secp256k1.Point.Fp.ORDER;
const SECP_N = secp256k1.Point.Fn.ORDER;

/**
 * pkg/crypto ParsePubKey / UnmarshalPubkey / DecompressPubkey: 65 bytes starting 0x04 (on the curve), or 33 bytes whose first
 * byte only supplies the parity of y through its low bit (any first byte is accepted - Accumulate does not check for 02/03).
 * Returns the uncompressed 65-byte point, or undefined. A 33-byte x that is not below the field prime is refused (Go would
 * carry it unreduced into the curve code; that has no defined meaning).
 */
export function secp256k1Point(key: Uint8Array): Uint8Array | undefined {
  try {
    if (key.length === 33) {
      const x = toBig(key.subarray(1));
      if (x >= SECP_P) return undefined;
      const normalised = new Uint8Array(key);
      normalised[0] = 0x02 | (key[0]! & 1);
      return secp256k1.Point.fromBytes(normalised).toBytes(false);
    }
    if (key.length === 65 && key[0] === 0x04) return secp256k1.Point.fromBytes(key).toBytes(false);
  } catch {
    return undefined;
  }
  return undefined;
}

/**
 * ecdsa.Verify(pub, hash, r, s) on secp256k1: 0 < r, s < n and the standard equation. A high S is valid, as it is for
 * Accumulate. The caller passes the point from secp256k1Point.
 */
export function secp256k1Verify(point65: Uint8Array, hash: Uint8Array, r: bigint, s: bigint): boolean {
  if (r <= 0n || s <= 0n || r >= SECP_N || s >= SECP_N) return false;
  try {
    return secp256k1.verify(new Uint8Array([...fixed(r, 32), ...fixed(s, 32)]), hash, point65, { prehash: false, lowS: false, format: 'compact' });
  } catch {
    return false;
  }
}

/** altcrypto.VerifySignature: a 64-byte r||s, a 32-byte hash, a 33- or 65-byte key. */
export function ethVerify(publicKey: Uint8Array, hash: Uint8Array, signature: Uint8Array): boolean {
  if (signature.length !== 64 || hash.length !== 32) return false;
  const pt = secp256k1Point(publicKey);
  if (!pt) return false;
  return secp256k1Verify(pt, hash, toBig(signature.subarray(0, 32)), toBig(signature.subarray(32)));
}

/** BTCSignature.Verify / ethSignatureV1.Verify: pkg/crypto ParseSignature (lax DER), ParsePubKey, ecdsa.Verify. */
export function btcVerify(publicKey: Uint8Array, hash: Uint8Array, signature: Uint8Array): boolean {
  const rs = laxSecp256k1Signature(signature);
  if (!rs) return false;
  const pt = secp256k1Point(publicKey);
  if (!pt) return false;
  return secp256k1Verify(pt, hash, rs.r, rs.s);
}

// ------------------------------------------------------------------ ecdsaSha256 (PKIX key, ASN.1 DER signature)

// NIST P-224 (FIPS 186-4 D.1.2.2; the values crypto/elliptic.P224().Params() holds). @noble/curves ships P-256, P-384 and
// P-521 but not P-224, which Go's x509 reads: the curve is built with noble's own generic Weierstrass engine.
const P224 = (() => {
  const p = 0xffffffffffffffffffffffffffffffff000000000000000000000001n;
  const Point = weierstrassN({
    p,
    n: 0xffffffffffffffffffffffffffff16a2e0b8f03e13dd29455c5c2a3dn,
    h: 1n,
    a: p - 3n,
    b: 0xb4050a850c04b3abf54132565044b0b7d7bfd8ba270b39432355ffb4n,
    Gx: 0xb70e0cbd6bb4bf7f321390b94a03c1d356c21122343280d6115c1d21n,
    Gy: 0xbd376388b5f723fb4c22dfe6cd4375a05a07476444d5819985007e34n,
  });
  return ecdsa(Point, nobleSha256, { lowS: false });
})();

type Ecdsa = {
  verify: (sig: Uint8Array, msg: Uint8Array, pub: Uint8Array, opts?: { prehash?: boolean; lowS?: boolean; format?: 'compact' | 'recovered' | 'der' }) => boolean;
  Point: { Fn: { ORDER: bigint; BYTES: number } };
};
const CURVES: Readonly<Record<EcCurve, { c: Ecdsa; bytes: number }>> = {
  'P-224': { c: P224 as unknown as Ecdsa, bytes: 28 },
  'P-256': { c: p256 as unknown as Ecdsa, bytes: 32 },
  'P-384': { c: p384 as unknown as Ecdsa, bytes: 48 },
  'P-521': { c: p521 as unknown as Ecdsa, bytes: 66 },
};

/**
 * EcdsaSha256Signature.Verify's primitive: x509.ParsePKIXPublicKey (an EC key on P-224, P-256, P-384 or P-521, in uncompressed
 * form) and ecdsa.VerifyASN1(pub, digest, sig) with the 32-byte digest used directly as the hash: no further hashing, and no
 * low-S rule. The signature is strict DER with nothing after it.
 */
export function ecdsaAsn1Verify(spki: Uint8Array, digest: Uint8Array, signature: Uint8Array): boolean {
  const key = parseSpkiEcdsa(spki);
  if (!key) return false;
  const { c, bytes } = CURVES[key.curve];
  if (key.point.length !== 1 + 2 * bytes || key.point[0] !== 0x04) return false;
  const rs = strictEcdsaSignature(signature);
  if (!rs) return false;
  const n = c.Point.Fn.ORDER;
  if (rs.r <= 0n || rs.s <= 0n || rs.r >= n || rs.s >= n) return false;
  try {
    return c.verify(new Uint8Array([...fixed(rs.r, bytes), ...fixed(rs.s, bytes)]), digest, key.point, { prehash: false, lowS: false, format: 'compact' });
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------ rsaSha256 (PKCS#1 key, PKCS#1 v1.5 over the digest)

/** DigestInfo prefix for SHA-256 (crypto/rsa hashPrefixes["SHA-256"]). */
const SHA256_PREFIX = Uint8Array.from([0x30, 0x31, 0x30, 0x0d, 0x06, 0x09, 0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02, 0x01, 0x05, 0x00, 0x04, 0x20]);

function modPow(base: bigint, exp: bigint, mod: bigint): bigint {
  let result = 1n;
  let b = base % mod;
  let e = exp;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % mod;
    e >>= 1n;
    if (e > 0n) b = (b * b) % mod;
  }
  return result;
}

/**
 * RsaSha256Signature.Verify's primitive: x509.ParsePKCS1PublicKey, the signature as long as the modulus, and
 * rsa.VerifyPKCS1v15(pub, SHA-256, digest, sig) - where `digest` is the 32 bytes Accumulate computed, passed as the
 * ALREADY-HASHED value, which no message-based API (WebCrypto verify, node:crypto verify) can express. The public operation
 * is c^e mod n; the result must equal 0x00 0x01 0xFF.. 0x00 || DigestInfo(SHA-256) || digest, compared without an early exit.
 * Go's own preconditions apply: a modulus of at least 1024 bits, odd, and an exponent that is odd, at least 3 and below 2^31.
 */
export function rsaPkcs1v15Sha256Verify(pkcs1: Uint8Array, digest: Uint8Array, signature: Uint8Array): boolean {
  const key = parsePkcs1Rsa(pkcs1);
  if (!key || digest.length !== 32) return false;
  const { n, e } = key;
  const bits = n.toString(2).length;
  const size = Math.ceil(bits / 8);
  if (signature.length !== size) return false;
  if (bits < 1024 || (n & 1n) === 0n) return false;
  if (e < 2 || (e & 1) === 0) return false;
  const c = toBig(signature);
  if (c >= n) return false;
  const k = size;
  if (k < SHA256_PREFIX.length + digest.length + 2 + 8 + 1) return false;
  const em = fixed(modPow(c, BigInt(e), n), k);
  const expected = new Uint8Array(k);
  expected[1] = 1;
  const tLen = SHA256_PREFIX.length + digest.length;
  for (let i = 2; i < k - tLen - 1; i++) expected[i] = 0xff;
  expected.set(SHA256_PREFIX, k - tLen);
  expected.set(digest, k - digest.length);
  let diff = 0;
  for (let i = 0; i < k; i++) diff |= em[i]! ^ expected[i]!;
  return diff === 0;
}
