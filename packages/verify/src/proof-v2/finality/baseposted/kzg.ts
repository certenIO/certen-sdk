/**
 * EIP-4844 blob proof verification (consensus-specs deneb polynomial-commitments, verify_blob_kzg_proof and
 * verify_blob_kzg_proof_batch) on @noble/curves' bls12_381, under a trusted setup whose raw-file SHA-256 equals a pin (V2_SPEC_S7 section
 * 4.2 kzg_setup_sha256). The twin of pkg/finality/baseposted/kzgsetup.
 *
 * Only what verification reads of the ceremony file is decoded: [tau]G2 (g2_monomial[1]); the 4096 G1 points are never needed to
 * verify a proof (the file is hash-checked whole). A blob is valid iff its length is 131072, every 32-byte big-endian field element is
 * below the BLS scalar modulus, its commitment and proof are compressed G1 points (the identity allowed, as in the specification; any
 * other point finite, on the curve and in the prime-order subgroup), and the pairing equation holds at the Fiat-Shamir challenge.
 *
 * verifyBlobs judges a set in ONE batched pairing check (the specification's random linear combination, 2 Miller loops for any number
 * of blobs). The batch is only an accelerator of the accepting case: when it fails, or a blob does not even prepare, the blobs are
 * judged one by one in order and the index of the first invalid one is returned, so a set with a single bad blob yields exactly the
 * index the one-by-one check yields.
 */
import { bls12_381 } from '@noble/curves/bls12-381';
import { sha256 } from '@noble/hashes/sha2';
import { bytesToHex } from '@noble/hashes/utils';
import { EMBEDDED_KZG_SETUP_TEXT } from './kzg-setup-embedded.js';

/** The raw-file SHA-256 of the embedded ceremony file: the value of the pin base_sepolia.kzg_setup_sha256. */
export const EMBEDDED_KZG_SETUP_SHA256 = 'f8e44a31ebf0a6d0734dcb301b0716e2c77f3ae18ed0cab0870fbcc2ca55616f';

/** FIELD_ELEMENTS_PER_BLOB. */
export const FIELD_ELEMENTS_PER_BLOB = 4096;
/** BYTES_PER_FIELD_ELEMENT. */
export const BYTES_PER_FIELD_ELEMENT = 32;
/** BYTES_PER_BLOB. */
export const BYTES_PER_BLOB = FIELD_ELEMENTS_PER_BLOB * BYTES_PER_FIELD_ELEMENT;

/** One blob with its commitment and proof (48-byte compressed G1 each), as the evidence container carries them. */
export interface KzgBlob {
  raw: Uint8Array;
  commitment: Uint8Array;
  proof: Uint8Array;
}

type G1Point = InstanceType<typeof bls12_381.G1.Point>;
type G2Point = InstanceType<typeof bls12_381.G2.Point>;

const G1 = bls12_381.G1.Point;
const G2 = bls12_381.G2.Point;
const Fp12 = bls12_381.fields.Fp12;

/** BLS_MODULUS: the order of the scalar field (and of G1, G2 and GT). */
const R: bigint = bls12_381.fields.Fr.ORDER;
/** The base field modulus. */
const P: bigint = bls12_381.fields.Fp.ORDER;
/** PRIMITIVE_ROOT_OF_UNITY of the specification. */
const PRIMITIVE_ROOT = 7n;

const enc = new TextEncoder();
const FIAT_SHAMIR_PROTOCOL_DOMAIN = enc.encode('FSBLOBVERIFY_V1_');
const RANDOM_CHALLENGE_KZG_BATCH_DOMAIN = enc.encode('RCKZGBATCH___V1_');

// ---- small arithmetic ----

function beInt(b: Uint8Array): bigint {
  return BigInt(`0x${bytesToHex(b) || '0'}`);
}

function beBytes32(v: bigint): Uint8Array {
  const out = new Uint8Array(32);
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

function u64be(v: number): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, BigInt(v), false);
  return out;
}

function u128be(v: number): Uint8Array {
  const out = new Uint8Array(16);
  new DataView(out.buffer).setBigUint64(8, BigInt(v), false);
  return out;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function modpow(base: bigint, exp: bigint, mod: bigint): bigint {
  let result = 1n;
  let b = base % mod;
  let e = exp;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % mod;
    b = (b * b) % mod;
    e >>= 1n;
  }
  return result;
}

/** hash_to_bls_field: the big-endian value of SHA-256(data) reduced modulo the scalar modulus. */
function hashToField(data: Uint8Array): bigint {
  return beInt(sha256(data)) % R;
}

/** point * k for any k (0 gives the identity; noble's multiply refuses it). */
function mul<T extends { multiplyUnsafe(k: bigint): T }>(p: T, zero: T, k: bigint): T {
  const s = ((k % R) + R) % R;
  return s === 0n ? zero : p.multiplyUnsafe(s);
}

const mulG1 = (p: G1Point, k: bigint): G1Point => mul(p, G1.ZERO, k);
const mulG2 = (p: G2Point, k: bigint): G2Point => mul(p, G2.ZERO, k);

// ---- point decoding (the checks of gnark-crypto's SetBytes and the specification's KeyValidate/validate_kzg_g1) ----

/** Whether every byte of b from index `from` is zero. */
function zeroFrom(b: Uint8Array, from: number): boolean {
  for (let i = from; i < b.length; i++) if (b[i] !== 0) return false;
  return true;
}

/** A finite compressed encoding (flag bits 100 or 101) with canonical coordinates, or an Error. */
function checkFiniteCompressed(b: Uint8Array, coordinates: number, what: string): void {
  const flags = b[0]! & 0xe0;
  if (flags !== 0x80 && flags !== 0xa0) throw new Error(`${what}: not a finite compressed point (flag bits ${flags >> 5})`);
  for (let c = 0; c < coordinates; c++) {
    const coord = Uint8Array.from(b.subarray(c * 48, c * 48 + 48));
    if (c === 0) coord[0]! &= 0x1f;
    if (beInt(coord) >= P) throw new Error(`${what}: non-canonical field element`);
  }
}

/**
 * A KZGCommitment or KZGProof (validate_kzg_g1): 48 bytes; the identity encoding 0xc0 00..00 is a valid point; anything else is a finite
 * compressed point with canonical coordinates, on the curve and in the prime-order subgroup. Throws an Error otherwise.
 */
export function decodeKzgG1(b: Uint8Array): G1Point {
  if (b.length !== 48) throw new Error('kzg g1: not 48 bytes');
  if ((b[0]! & 0xe0) === 0xc0) {
    if ((b[0]! & 0x1f) !== 0 || !zeroFrom(b, 1)) throw new Error('kzg g1: malformed infinity');
    return G1.ZERO;
  }
  const copy = Uint8Array.from(b); // noble's parser clears the flag bits of a Node Buffer in place
  checkFiniteCompressed(copy, 1, 'kzg g1');
  const p = G1.fromBytes(copy);
  if (p.is0()) throw new Error('kzg g1: decoded to the identity');
  p.assertValidity();
  return p;
}

function decodeSetupG2(b: Uint8Array): G2Point {
  if (b.length !== 96) throw new Error('kzg setup g2: not 96 bytes');
  const copy = Uint8Array.from(b);
  checkFiniteCompressed(copy, 2, 'kzg setup g2');
  const p = G2.fromBytes(copy);
  if (p.is0()) throw new Error('kzg setup g2: decoded to the identity');
  p.assertValidity();
  return p;
}

// ---- the evaluation domain ----

interface Domain {
  /** the 4096 roots of unity in bit-reversal order */
  roots: bigint[];
  /** root -> its index in `roots` */
  index: Map<bigint, number>;
  /** 4096^-1 mod r */
  invWidth: bigint;
}

let domainCache: Domain | undefined;

function domain(): Domain {
  if (domainCache !== undefined) return domainCache;
  const w = modpow(PRIMITIVE_ROOT, (R - 1n) / BigInt(FIELD_ELEMENTS_PER_BLOB), R);
  const natural: bigint[] = new Array(FIELD_ELEMENTS_PER_BLOB);
  natural[0] = 1n;
  for (let i = 1; i < FIELD_ELEMENTS_PER_BLOB; i++) natural[i] = (natural[i - 1]! * w) % R;
  const bits = Math.log2(FIELD_ELEMENTS_PER_BLOB);
  const roots: bigint[] = new Array(FIELD_ELEMENTS_PER_BLOB);
  const index = new Map<bigint, number>();
  for (let i = 0; i < FIELD_ELEMENTS_PER_BLOB; i++) {
    let rev = 0;
    for (let b = 0; b < bits; b++) if (i & (1 << b)) rev |= 1 << (bits - 1 - b);
    roots[i] = natural[rev]!;
    index.set(roots[i]!, i);
  }
  domainCache = { roots, index, invWidth: modpow(BigInt(FIELD_ELEMENTS_PER_BLOB), R - 2n, R) };
  return domainCache;
}

/** evaluate_polynomial_in_evaluation_form: the polynomial given by its values on the bit-reversed domain, at z. */
function evaluateInEvaluationForm(poly: bigint[], z: bigint): bigint {
  const d = domain();
  const at = d.index.get(z);
  if (at !== undefined) return poly[at]!;
  // sum_i poly[i] * root[i] / (z - root[i]), the inverses by one Montgomery batch inversion (every z - root[i] is nonzero here)
  const n = FIELD_ELEMENTS_PER_BLOB;
  const diff: bigint[] = new Array(n);
  const prefix: bigint[] = new Array(n);
  let acc = 1n;
  for (let i = 0; i < n; i++) {
    const v = (z - d.roots[i]! + R) % R;
    diff[i] = v;
    acc = (acc * v) % R;
    prefix[i] = acc;
  }
  let inv = modpow(acc, R - 2n, R);
  let sum = 0n;
  for (let i = n - 1; i >= 0; i--) {
    const invI = i === 0 ? inv : (inv * prefix[i - 1]!) % R;
    inv = (inv * diff[i]!) % R;
    sum += (((poly[i]! * d.roots[i]!) % R) * invI) % R;
  }
  const factor = (modpow(z, BigInt(n), R) - 1n + R) % R;
  return (((sum % R) * factor) % R * d.invWidth) % R;
}

// ---- verification ----

/** A blob that decoded: its points, the challenge z and the evaluation y. */
interface Prepared {
  commitment: G1Point;
  commitmentBytes: Uint8Array;
  proof: G1Point;
  proofBytes: Uint8Array;
  z: bigint;
  y: bigint;
}

/** Whether the product of the pairings is one; a pair with the identity on either side contributes one. */
function pairingProductIsOne(pairs: { g1: G1Point; g2: G2Point }[]): boolean {
  const live = pairs.filter((p) => !p.g1.is0() && !p.g2.is0());
  if (live.length === 0) return true;
  return Fp12.eql(bls12_381.pairingBatch(live), Fp12.ONE);
}

/** The result of loadKzgSetup: judges blobs under the pinned setup. */
export class KzgContext {
  /** [tau]G2 */
  private readonly tauG2: G2Point;
  private readonly negG2: G2Point = G2.BASE.negate();
  /** -[tau]G2 */
  private readonly negTauG2: G2Point;

  /** @internal use loadKzgSetup */
  constructor(tauG2: G2Point) {
    this.tauG2 = tauG2;
    this.negTauG2 = tauG2.negate();
  }

  /** The blob's decoded form, or undefined when it is not a valid input of verify_blob_kzg_proof. */
  private prepare(b: KzgBlob): Prepared | undefined {
    if (b.raw.length !== BYTES_PER_BLOB) return undefined;
    const hex = bytesToHex(b.raw);
    const poly: bigint[] = new Array(FIELD_ELEMENTS_PER_BLOB);
    for (let i = 0; i < FIELD_ELEMENTS_PER_BLOB; i++) {
      const v = BigInt(`0x${hex.slice(i * 64, i * 64 + 64)}`);
      if (v >= R) return undefined;
      poly[i] = v;
    }
    let commitment: G1Point;
    let proof: G1Point;
    try {
      commitment = decodeKzgG1(b.commitment);
      proof = decodeKzgG1(b.proof);
    } catch {
      return undefined;
    }
    const z = hashToField(concat(FIAT_SHAMIR_PROTOCOL_DOMAIN, u128be(FIELD_ELEMENTS_PER_BLOB), b.raw, b.commitment));
    const y = evaluateInEvaluationForm(poly, z);
    return { commitment, commitmentBytes: b.commitment, proof, proofBytes: b.proof, z, y };
  }

  /** verify_kzg_proof_impl: e(C - [y]G1, -G2) * e(proof, [tau]G2 - [z]G2) = 1. */
  private single(p: Prepared): boolean {
    const pMinusY = p.commitment.add(mulG1(G1.BASE, R - p.y));
    const xMinusZ = this.tauG2.add(mulG2(G2.BASE, R - p.z));
    return pairingProductIsOne([
      { g1: pMinusY, g2: this.negG2 },
      { g1: p.proof, g2: xMinusZ },
    ]);
  }

  /** verify_kzg_proof_batch over the prepared blobs: one random linear combination (Fiat-Shamir powers), two Miller loops. */
  private batch(items: Prepared[]): boolean {
    const parts: Uint8Array[] = [RANDOM_CHALLENGE_KZG_BATCH_DOMAIN, u64be(FIELD_ELEMENTS_PER_BLOB), u64be(items.length)];
    for (const it of items) parts.push(it.commitmentBytes, beBytes32(it.z), beBytes32(it.y), it.proofBytes);
    const r = hashToField(concat(...parts));
    let proofLin = G1.ZERO;
    let proofZLin = G1.ZERO;
    let commitLin = G1.ZERO;
    let yLin = 0n;
    let power = 1n;
    for (const it of items) {
      proofLin = proofLin.add(mulG1(it.proof, power));
      proofZLin = proofZLin.add(mulG1(it.proof, (it.z * power) % R));
      commitLin = commitLin.add(mulG1(it.commitment, power));
      yLin = (yLin + it.y * power) % R;
      power = (power * r) % R;
    }
    const cMinusYLin = commitLin.add(mulG1(G1.BASE, R - yLin));
    return pairingProductIsOne([
      { g1: proofLin, g2: this.negTauG2 },
      { g1: cMinusYLin.add(proofZLin), g2: G2.BASE },
    ]);
  }

  /** verify_blob_kzg_proof for one blob. */
  verifyBlob(b: KzgBlob): boolean {
    const p = this.prepare(b);
    return p !== undefined && this.single(p);
  }

  /** Prepares blobs in order up to the first one that does not prepare (its index, or -1). */
  private prepareAll(bs: readonly KzgBlob[]): { prepared: Prepared[]; unprepared: number } {
    const prepared: Prepared[] = [];
    for (let i = 0; i < bs.length; i++) {
      const p = this.prepare(bs[i]!);
      if (p === undefined) return { prepared, unprepared: i };
      prepared.push(p);
    }
    return { prepared, unprepared: -1 };
  }

  /**
   * The batched equation alone, with no fallback: true iff every blob prepares and the one random-linear-combination pairing check
   * holds. It is the accelerator verifyBlobs relies on; a false answer does not say which blob is bad.
   */
  verifyBatchOnly(bs: readonly KzgBlob[]): boolean {
    const { prepared, unprepared } = this.prepareAll(bs);
    return unprepared === -1 && (prepared.length === 0 || this.batch(prepared));
  }

  /**
   * The index of the first invalid blob of bs in order, or -1 when every blob is valid. One batched pairing check settles the
   * accepting case; any failure of the batch or of a blob's preparation falls back to the one-by-one judgement, which names the blob.
   */
  verifyBlobs(bs: readonly KzgBlob[]): number {
    const { prepared, unprepared } = this.prepareAll(bs);
    if (prepared.length > 0 && !this.batch(prepared)) {
      for (let i = 0; i < prepared.length; i++) if (!this.single(prepared[i]!)) return i;
    }
    return unprepared;
  }

  /** The reference judgement: every blob alone, in order (what a one-by-one verifier returns). Same result contract as verifyBlobs. */
  verifyBlobsOneByOne(bs: readonly KzgBlob[]): number {
    for (let i = 0; i < bs.length; i++) if (!this.verifyBlob(bs[i]!)) return i;
    return -1;
  }
}

// ---- loading the setup ----

const loaded = new Map<string, KzgContext>();

/**
 * The verification context under the ceremony file whose raw-file SHA-256 is `wantSha256` (the pin). The text's UTF-8 bytes must hash
 * to exactly that lower-case hex string, else this throws an Error naming both hashes: a different pin is an error, never a different
 * setup. `setupText` is the embedded file; a caller may hand another text only together with that text's own pin. The context is built
 * once per pin and cached.
 */
export function loadKzgSetup(wantSha256: string, setupText: string = EMBEDDED_KZG_SETUP_TEXT): KzgContext {
  const raw = enc.encode(setupText);
  const got = bytesToHex(sha256(raw));
  if (got !== wantSha256) throw new Error(`kzg setup: the setup file hashes to ${got}, the pin is ${wantSha256}`);
  const cached = loaded.get(got);
  if (cached !== undefined) return cached;
  const doc = JSON.parse(setupText) as { g1_monomial?: unknown; g1_lagrange?: unknown; g2_monomial?: unknown };
  const sizes: [string, unknown, number][] = [
    ['g1_monomial', doc.g1_monomial, FIELD_ELEMENTS_PER_BLOB],
    ['g1_lagrange', doc.g1_lagrange, FIELD_ELEMENTS_PER_BLOB],
    ['g2_monomial', doc.g2_monomial, 65],
  ];
  for (const [name, v, want] of sizes) {
    if (!Array.isArray(v) || v.length !== want) throw new Error(`kzg setup: ${name} must hold ${want} points`);
  }
  const g2 = doc.g2_monomial as unknown[];
  const hexPoint = (v: unknown): Uint8Array => {
    if (typeof v !== 'string' || !/^0x[0-9a-f]{192}$/.test(v)) throw new Error('kzg setup: g2_monomial point is not 96 bytes of lower-case hex');
    return Uint8Array.from(v.slice(2).match(/../g)!, (h) => parseInt(h, 16));
  };
  // [tau^0]G2 is the generator: the cheapest check that the file is a G2 monomial basis at all
  if (!decodeSetupG2(hexPoint(g2[0])).equals(G2.BASE)) throw new Error('kzg setup: g2_monomial[0] is not the G2 generator');
  const ctx = new KzgContext(decodeSetupG2(hexPoint(g2[1])));
  loaded.set(got, ctx);
  return ctx;
}
