/**
 * Signature verification of the epoch records (V2_SPEC_S7 5.8 O3; the twin of pkg/finality/adiri sigs.go). Adiri's BLS is min-sig:
 * signatures in G1 (48 B compressed), keys in G2 (96 B compressed), DST BLS_SIG_BLS12381G1_XMD:SHA-256_SSWU_RO_NUL_, run on
 * @noble/curves' bls12_381 (`shortSignatures`). It is NOT the beacon BLS of the Sepolia kind (min-pk, ethl1/bls.ts).
 *
 * Decoding is exactly gnark-crypto's SetBytes (the validator's library), which is stricter than noble's parser: a signature is a point only
 * as a FINITE COMPRESSED encoding (flag bits 100 or 101) with canonical (below the modulus) field coordinates on the curve; the compressed
 * identity is the all-zero encoding with flag bits 110 (reason "identity"; any other bit set is "encoding"); every other flag pattern is
 * "encoding"; a point on the curve but outside the prime-order subgroup is "subgroup". A key is valid only as a finite compressed,
 * canonical, on-curve, subgroup point; the identity is not a key.
 *
 * Two modes return identical verdicts on every input (the vectors prove it):
 *   - 'oneByOne' verifies each record with its own pairing equation;
 *   - 'batched' (production) checks one random linear combination e(sum r_i sigma_i, g2) = prod_A e(sum_{i: A_i = A} r_i H(m_i), A) with
 *     128-bit scalars, and only on failure localises the LOWEST failing record by bisection over prefixes of the same combination
 *     (never to accept). The verdict is the lowest failing epoch either way, with its reason.
 */
import { bls12_381 } from '@noble/curves/bls12-381';
import { randomBytes } from '@noble/hashes/utils';
import {
  ReasonEncoding,
  ReasonIdentity,
  ReasonPairing,
  ReasonSubgroup,
  type SignatureReason,
} from './states.js';
import { SigBytes } from './cfa1.js';
import { firstFailureBatched } from './batched.js';
import type { Parallelism } from './pool.js';

/** The RFC 9380 domain separation tag of these signatures (the "NUL_" scheme of draft-irtf-cfrg-bls-signature, min-sig). */
export const SignatureDST = 'BLS_SIG_BLS12381G1_XMD:SHA-256_SSWU_RO_NUL_';

export type G1Point = InstanceType<typeof bls12_381.G1.Point>;
export type G2Point = InstanceType<typeof bls12_381.G2.Point>;

export type Mode = 'oneByOne' | 'batched';

const Fp = bls12_381.fields.Fp;
const FIELD_P: bigint = Fp.ORDER;
const HALF_P: bigint = (FIELD_P - 1n) / 2n;

function beInt(b: Uint8Array): bigint {
  let n = 0n;
  for (const x of b) n = (n << 8n) | BigInt(x);
  return n;
}

/** Whether every 48-byte coordinate of b (flag bits cleared from the first) is below the field modulus. */
function canonical(b: Uint8Array, coordinates: number): boolean {
  for (let c = 0; c < coordinates; c++) {
    const coord = Uint8Array.from(b.subarray(c * 48, c * 48 + 48));
    if (c === 0) coord[0]! &= 0x1f;
    if (beInt(coord) >= FIELD_P) return false;
  }
  return true;
}

/**
 * Decodes a compressed G1 signature with the encoding, non-identity and subgroup checks, each reported by its own reason (gnark-crypto
 * Decoder with NoSubgroupChecks, then IsInfinity, IsOnCurve, IsInSubGroup).
 */
export function decodeSignature(b: Uint8Array): { point: G1Point; reason: undefined } | { point: undefined; reason: SignatureReason } {
  const enc = (): { point: undefined; reason: SignatureReason } => ({ point: undefined, reason: ReasonEncoding });
  if (b.length !== SigBytes) return enc();
  const flags = b[0]! & 0xe0;
  if (flags === 0xc0) {
    // compressed infinity: the low five bits of the first byte and every other byte are zero (else invalid infinity encoding)
    for (let i = 1; i < SigBytes; i++) if (b[i] !== 0) return enc();
    if ((b[0]! & 0x1f) !== 0) return enc();
    return { point: undefined, reason: ReasonIdentity };
  }
  // 000 and 010 (uncompressed forms) need 96 bytes; 001, 011 and 111 are invalid masks
  if (flags !== 0x80 && flags !== 0xa0) return enc();
  const xb = Uint8Array.from(b);
  xb[0]! &= 0x1f;
  const x = beInt(xb);
  if (x >= FIELD_P) return enc();
  let y: bigint;
  try {
    y = Fp.sqrt(Fp.add(Fp.mul(Fp.mul(x, x), x), 4n));
  } catch {
    return enc();
  }
  // the lexicographically largest root is the one with y > (p-1)/2; flag 101 asks for it, flag 100 for the other
  const largest = y > HALF_P;
  if (largest !== (flags === 0xa0)) y = Fp.neg(y);
  const point = bls12_381.G1.Point.fromAffine({ x, y });
  if (!point.isTorsionFree()) return { point: undefined, reason: ReasonSubgroup };
  return { point, reason: undefined };
}

/** Decodes a 96-byte compressed G2 public key: finite compressed, canonical, on the curve, in the prime-order subgroup. Undefined when it is not. */
export function decodeKey(b: Uint8Array): G2Point | undefined {
  if (b.length !== 96) return undefined;
  const flags = b[0]! & 0xe0;
  if (flags !== 0x80 && flags !== 0xa0) return undefined;
  if (!canonical(b, 2)) return undefined;
  try {
    // noble's parser clears the flag bits of a Node Buffer IN PLACE: hand it a private copy
    const p = bls12_381.G2.Point.fromBytes(Uint8Array.from(b));
    return p.is0() ? undefined : p;
  } catch {
    return undefined;
  }
}

/** A validated committee key. */
export interface KeyEntry {
  g2: G2Point;
  /** unique within a KeyCache: identifies the key in an aggregate's group key */
  id: number;
}

const keyString = (b: Uint8Array): string => {
  let s = '';
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]!);
  return s;
};

/** Decodes and subgroup-checks each distinct key once; an invalid key is cached as such. */
export class KeyCache {
  private readonly m = new Map<string, KeyEntry | undefined>();
  /** how many distinct keys were decoded (valid or not) */
  get decoded(): number {
    return this.m.size;
  }
  /** The validated key, or undefined when it is not a valid, non-identity G2 subgroup point. */
  get(k: Uint8Array): KeyEntry | undefined {
    const s = keyString(k);
    if (this.m.has(s)) return this.m.get(s);
    const g2 = decodeKey(k);
    const e = g2 === undefined ? undefined : { g2, id: this.m.size };
    this.m.set(s, e);
    return e;
  }
}

/** One record's signature statement. */
export interface SigItem {
  epoch: number;
  sig: Uint8Array;
  signer: KeyEntry[];
  msg: Uint8Array;
}

const aggregateKey = (signer: readonly KeyEntry[]): G2Point => {
  let a = signer[0]!.g2;
  for (let i = 1; i < signer.length; i++) a = a.add(signer[i]!.g2);
  return a;
};

/** The group of a signer list: the same list of keys, in order, aggregates to the same key. */
const signerGroup = (signer: readonly KeyEntry[]): string => signer.map((k) => k.id).join(',');

const hashMsg = (msg: Uint8Array): G1Point => bls12_381.shortSignatures.hash(msg, SignatureDST);

/** e(sig, g2) == e(H(m), aggregate key); an aggregate that is the identity, or any failure of the pairing machinery, is a failed pairing. */
function pairingHolds(sig: G1Point, h: G1Point, agg: G2Point): boolean {
  try {
    return bls12_381.shortSignatures.verify(sig, h, agg);
  } catch {
    return false;
  }
}

/** Judges one item: undefined = valid, else the reason. */
export function verifyOne(it: SigItem): SignatureReason | undefined {
  const d = decodeSignature(it.sig);
  if (d.reason !== undefined) return d.reason;
  if (it.signer.length === 0) return ReasonPairing;
  return pairingHolds(d.point, hashMsg(it.msg), aggregateKey(it.signer)) ? undefined : ReasonPairing;
}

export interface Failure {
  /** index into the items */
  index: number;
  reason: SignatureReason;
}

/** Verifies every item in ascending order and returns the first failing one. */
export function firstOneByOne(items: readonly SigItem[]): Failure | undefined {
  for (let i = 0; i < items.length; i++) {
    const reason = verifyOne(items[i]!);
    if (reason !== undefined) return { index: i, reason };
  }
  return undefined;
}

/** A source of random bytes (128-bit batch scalars). The default is the platform CSPRNG. */
export type Rand = (n: number) => Uint8Array;

/** A 128-bit scalar >= 1. */
function batchScalar(rnd: Rand): bigint {
  for (;;) {
    const s = beInt(rnd(16));
    if (s > 0n) return s;
  }
}

/**
 * The lowest failing item and its reason under the mode, or undefined. In batched mode the combination decides acceptance; a failure is
 * only localised (by bisection over prefixes of the SAME combination, then one individual check of the item found), never accepted by
 * the localisation.
 */
export function firstFailure(items: readonly SigItem[], mode: Mode, rnd: Rand = randomBytes, parallel: Parallelism = 'auto'): Failure | undefined {
  if (items.length === 0) return undefined;
  if (mode === 'oneByOne') return firstOneByOne(items);
  return firstFailureBatched(items, rnd, { dst: SignatureDST, batchScalar, aggregateKey, signerGroup, verifyOne }, parallel);
}
