/**
 * Ethereum's BLS suite for the sync committee (the twin of pkg/finality/ethl1/bls.go): public keys in G1 (48-byte compressed),
 * signatures in G2 (96-byte compressed), the proof-of-possession ciphersuite BLS_SIG_BLS12381G2_XMD:SHA-256_SSWU_RO_POP_, run on
 * @noble/curves' bls12_381 (`longSignatures`: G1 keys, G2 signatures).
 *
 * Both orientations decode exactly as gnark-crypto's SetBytes does, which is stricter than noble's own parser: only a FINITE
 * COMPRESSED encoding is a point (flag bits 100 or 101; the identity, an uncompressed form, or any other flag pattern is refused), the
 * field coordinates must be canonical (below the field modulus, never reduced), the point must lie on the curve and in the prime-order
 * subgroup. The identity is not a valid key or signature. Committee keys are authenticated by hash_tree_root against the pin; ONLY the
 * keys of PARTICIPATING seats are ever decoded and validated, exactly as FastAggregateVerify(participant_pubkeys, ...) does in the
 * consensus specification, each distinct key ONCE per verification (KeyCache).
 */
import { bls12_381 } from '@noble/curves/bls12-381';
import { sha256 } from '@noble/hashes/sha2';
import { aggregateBit, hashTreeRootSyncCommittee, sha2, type SyncAggregate } from './ssz.js';
import { SyncCommitteeSize } from './types.js';

/** The DST of the Ethereum sync-committee suite. */
export const blsDST = 'BLS_SIG_BLS12381G2_XMD:SHA-256_SSWU_RO_POP_';

/** DOMAIN_SYNC_COMMITTEE = 0x07000000. */
export const domainSyncCommittee: Uint8Array = Uint8Array.of(0x07, 0, 0, 0);

type G1Point = InstanceType<typeof bls12_381.G1.Point>;
type G2Point = InstanceType<typeof bls12_381.G2.Point>;

const FIELD_P: bigint = bls12_381.fields.Fp.ORDER;

function beInt(b: Uint8Array): bigint {
  let n = 0n;
  for (const x of b) n = (n << 8n) | BigInt(x);
  return n;
}

/** The checks of gnark's SetBytes that precede the curve arithmetic: a finite compressed flag pattern and canonical coordinates. */
function strictCompressed(b: Uint8Array, coordinates: number, what: string): void {
  const flags = b[0]! & 0xe0;
  if (flags !== 0x80 && flags !== 0xa0) throw new Error(`${what}: not a finite compressed point (flag bits ${flags >> 5})`);
  for (let c = 0; c < coordinates; c++) {
    const coord = Uint8Array.from(b.subarray(c * 48, c * 48 + 48));
    if (c === 0) coord[0]! &= 0x1f;
    if (beInt(coord) >= FIELD_P) throw new Error(`${what}: non-canonical field element`);
  }
}

/** Decodes a 48-byte compressed G1 public key: canonical, on the curve, in the prime-order subgroup, never the identity. */
export function decodeG1(b: Uint8Array): G1Point {
  if (b.length !== 48) throw new Error('public key: not 48 bytes');
  // noble's parser clears the flag bits of a Node Buffer IN PLACE (Buffer#slice is a view): hand it a private copy
  b = Uint8Array.from(b);
  strictCompressed(b, 1, 'public key');
  const p = bls12_381.G1.Point.fromBytes(b);
  if (p.is0()) throw new Error('identity public key');
  return p;
}

/** Decodes a 96-byte compressed G2 signature: canonical, on the curve, in the prime-order subgroup, never the identity. */
export function decodeG2(b: Uint8Array): G2Point {
  if (b.length !== 96) throw new Error('signature: not 96 bytes');
  b = Uint8Array.from(b); // see decodeG1
  strictCompressed(b, 2, 'signature');
  const p = bls12_381.G2.Point.fromBytes(b);
  if (p.is0()) throw new Error('identity signature');
  return p;
}

const keyString = (b: Uint8Array): string => {
  let s = '';
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]!);
  return s;
};

/**
 * The decoded public keys of one verification, by their 48 compressed bytes. Whether a key is valid is a function of its bytes alone,
 * so a key met again (in the committee that is `next` and later `current`, or in a neighbouring period) is decoded and subgroup-checked
 * once; a refusal is cached too. A cache may be shared by several verifications.
 */
export class KeyCache {
  private readonly m = new Map<string, G1Point | Error>();
  /** how many distinct keys were decoded (valid or not) */
  get decoded(): number {
    return this.m.size;
  }
  key(raw: Uint8Array): G1Point {
    const k = keyString(raw);
    let v = this.m.get(k);
    if (v === undefined) {
      try {
        v = decodeG1(raw);
      } catch (e) {
        v = e instanceof Error ? e : new Error(String(e));
      }
      this.m.set(k, v);
    }
    if (v instanceof Error) throw v;
    return v;
  }
}

/** A sync committee with its root; its keys are decoded lazily through the cache. */
export class Committee {
  readonly root: Uint8Array;
  constructor(
    readonly raw: Uint8Array,
    private readonly cache: KeyCache,
  ) {
    this.root = hashTreeRootSyncCommittee(raw);
  }
  /** Seat i's key (decoded and validated on first use). A key the committee holds twice is summed once per set bit. */
  key(i: number): G1Point {
    return this.cache.key(this.raw.subarray(i * 48, i * 48 + 48));
  }
}

/** compute_domain(DOMAIN_SYNC_COMMITTEE, fork_version, genesis_validators_root). */
export function computeDomain(version: Uint8Array, gvr: Uint8Array): Uint8Array {
  const fv = new Uint8Array(32);
  fv.set(version.subarray(0, 4), 0);
  const forkDataRoot = sha2(fv, gvr); // hash_tree_root(ForkData{current_version, genesis_validators_root})
  const d = new Uint8Array(32);
  d.set(domainSyncCommittee, 0);
  d.set(forkDataRoot.subarray(0, 28), 4);
  return d;
}

/** compute_signing_root(object_root, domain) = hash_tree_root(SigningData{object_root, domain}). */
export function signingRoot(objectRoot: Uint8Array, domain: Uint8Array): Uint8Array {
  const buf = new Uint8Array(64);
  buf.set(objectRoot, 0);
  buf.set(domain, 32);
  return sha256(buf);
}

/**
 * bls.FastAggregateVerify over the committee keys whose bit is set: the keys are summed once per set bit, the aggregate must not be
 * the identity, the signature must be a subgroup-checked non-identity G2 point. Throws an Error on every failure (the caller turns it
 * into finality_signature_invalid).
 */
export function fastAggregateVerify(c: Committee, agg: SyncAggregate, msg: Uint8Array): void {
  const sig = decodeG2(agg.signature);
  let sum = bls12_381.G1.Point.ZERO;
  let n = 0;
  for (let i = 0; i < SyncCommitteeSize; i++) {
    if (!aggregateBit(agg, i)) continue;
    sum = sum.add(c.key(i));
    n++;
  }
  if (n === 0) throw new Error('no participants');
  if (sum.is0()) throw new Error('identity aggregate public key');
  const h = bls12_381.longSignatures.hash(msg, blsDST);
  if (!bls12_381.longSignatures.verify(sig, h, sum)) throw new Error('aggregate signature does not verify');
}
