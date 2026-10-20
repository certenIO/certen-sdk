/**
 * Unit tests of the BLS layer (the twin of bls_test.go plus the decoding rules of gnark-crypto's SetBytes that noble's own parser
 * lacks): off-subgroup and identity keys and signatures never verify, non-canonical coordinates and non-compressed forms are refused,
 * only PARTICIPATING keys are decoded, a duplicate key is summed once per set bit, every distinct key is decoded once, and the
 * decoders never modify the caller's buffer.
 */
import { bls12_381 } from '@noble/curves/bls12-381';
import { sha256 } from '@noble/hashes/sha2';
import { describe, expect, it } from 'vitest';
import {
  Committee,
  KeyCache,
  blsDST,
  computeDomain,
  decodeG1,
  decodeG2,
  fastAggregateVerify,
  signingRoot,
  SyncCommitteeBytes,
  type SyncAggregate,
} from '../../../src/proof-v2/finality/ethl1/index.js';
import { hexLower } from '../../../src/proof-v2/finality/state.js';

const Fp = bls12_381.fields.Fp;
const Fp2 = bls12_381.fields.Fp2;
const P = Fp.ORDER;
const HALF = (P - 1n) / 2n;

const be48 = (n: bigint): Uint8Array => {
  const b = new Uint8Array(48);
  for (let i = 47; i >= 0; i--) {
    b[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return b;
};

/** A compressed encoding by hand: flag bits, then the coordinate(s). */
function compressG1(x: bigint, largest: boolean, flags = 0x80): Uint8Array {
  const b = be48(x);
  b[0]! |= flags | (largest ? 0x20 : 0);
  return b;
}

/** A point of E(Fp) outside the prime-order subgroup, compressed. */
function offSubgroupG1(): Uint8Array {
  for (let x = 2n; x < 200n; x++) {
    const rhs = Fp.add(Fp.mul(Fp.mul(x, x), x), 4n);
    let y: bigint;
    try {
      y = Fp.sqrt(rhs);
    } catch {
      continue;
    }
    if (Fp.mul(y, y) !== rhs) continue;
    const pt = bls12_381.G1.Point.fromAffine({ x, y });
    if (!pt.isTorsionFree()) return compressG1(x, y > HALF);
  }
  throw new Error('no off-subgroup G1 point');
}

/** A point of the twist outside the prime-order subgroup, compressed. */
function offSubgroupG2(): Uint8Array {
  for (let x0 = 1n; x0 < 200n; x0++) {
    const x = Fp2.create({ c0: x0, c1: 0n });
    const rhs = Fp2.add(Fp2.mul(Fp2.mul(x, x), x), Fp2.create({ c0: 4n, c1: 4n }));
    let y;
    try {
      y = Fp2.sqrt(rhs);
    } catch {
      continue;
    }
    if (!Fp2.eql(Fp2.mul(y, y), rhs)) continue;
    const pt = bls12_381.G2.Point.fromAffine({ x, y });
    if (pt.isTorsionFree()) continue;
    const out = new Uint8Array(96);
    out.set(be48(x.c1), 0);
    out.set(be48(x.c0), 48);
    const largest = y.c1 === 0n ? y.c0 > HALF : y.c1 > HALF;
    out[0]! |= 0x80 | (largest ? 0x20 : 0);
    return out;
  }
  throw new Error('no off-subgroup G2 point');
}

const pkOf = (sk: bigint): Uint8Array => bls12_381.G1.Point.BASE.multiply(sk).toBytes(true);
const msg = (b: number): Uint8Array => new Uint8Array(32).fill(b);

/** The signature of `seats` seats all holding the key sk*G1 over m: sk*seats*H(m). */
const signAll = (sk: bigint, m: Uint8Array, seats: number): Uint8Array =>
  bls12_381.longSignatures.sign(bls12_381.longSignatures.hash(m, blsDST), sk * BigInt(seats)).toBytes(true);

function committeeOf(pk: Uint8Array, cache: KeyCache, bad: Map<number, Uint8Array> = new Map()): Committee {
  const raw = new Uint8Array(SyncCommitteeBytes);
  for (let i = 0; i < 512; i++) raw.set(bad.get(i) ?? pk, i * 48);
  raw.set(pk, 512 * 48);
  return new Committee(raw, cache);
}

const bitsOf = (seats: number[]): Uint8Array => {
  const b = new Uint8Array(64);
  for (const s of seats) b[s >> 3]! |= 1 << (s & 7);
  return b;
};
const aggOf = (seats: number[], signature: Uint8Array): SyncAggregate => ({ bits: bitsOf(seats), signature });
const range = (n: number): number[] => Array.from({ length: n }, (_, i) => i);

describe('point decoding is as strict as gnark-crypto SetBytes', () => {
  it('accepts the generator in both orientations and refuses every other flag pattern', () => {
    const g = pkOf(1n);
    expect(decodeG1(g).equals(bls12_381.G1.Point.BASE)).toBe(true);
    const s = signAll(1n, msg(1), 1);
    expect(decodeG2(s).is0()).toBe(false);
    // flag bits: only 100 (smallest) and 101 (largest) are finite compressed encodings
    const flagsOf = (b: Uint8Array, f: number): Uint8Array => {
      const c = Uint8Array.from(b);
      c[0] = (c[0]! & 0x1f) | f;
      return c;
    };
    for (const f of [0x00, 0x20, 0x40, 0x60, 0xc0, 0xe0]) {
      expect(() => decodeG1(flagsOf(g, f)), `G1 flags ${f.toString(16)}`).toThrow(/finite compressed/);
      expect(() => decodeG2(flagsOf(s, f)), `G2 flags ${f.toString(16)}`).toThrow(/finite compressed/);
    }
    // the identity in its canonical compressed form
    const id1 = new Uint8Array(48);
    id1[0] = 0xc0;
    const id2 = new Uint8Array(96);
    id2[0] = 0xc0;
    expect(() => decodeG1(id1)).toThrow();
    expect(() => decodeG2(id2)).toThrow();
    // wrong lengths
    expect(() => decodeG1(new Uint8Array(47))).toThrow(/48 bytes/);
    expect(() => decodeG1(new Uint8Array(96))).toThrow(/48 bytes/);
    expect(() => decodeG2(new Uint8Array(95))).toThrow(/96 bytes/);
    expect(() => decodeG2(new Uint8Array(48))).toThrow(/96 bytes/);
  });

  it('refuses a coordinate that is not below the field modulus (noble itself would reduce it)', () => {
    const g = pkOf(1n);
    const x = BigInt(`0x${hexLower(Uint8Array.from(g, (v, i) => (i === 0 ? v & 0x1f : v)))}`);
    // x + p does not fit in 381 bits for the generator, so use a small x and the maximal in-range value 2^381 - 1 >= p
    expect(x < P).toBe(true);
    expect(() => decodeG1(compressG1(P, false))).toThrow(/non-canonical/);
    expect(() => decodeG1(compressG1(P + 1n, true))).toThrow(/non-canonical/);
    expect(() => decodeG1(compressG1((1n << 381n) - 1n, true))).toThrow(/non-canonical/);
    expect(() => decodeG1(compressG1(P - 1n, false))).not.toThrow(/non-canonical/);
    const s = signAll(1n, msg(1), 1);
    const hi = Uint8Array.from(s);
    hi.set(be48(P), 0);
    hi[0]! |= 0x80;
    expect(() => decodeG2(hi)).toThrow(/non-canonical/);
    const lo = Uint8Array.from(s);
    lo.set(be48(P + 5n), 48);
    expect(() => decodeG2(lo)).toThrow(/non-canonical/);
    const ok = Uint8Array.from(s);
    expect(() => decodeG2(ok)).not.toThrow();
  });

  it('refuses points on the curve but outside the prime-order subgroup, keys and signatures alike', () => {
    expect(() => decodeG1(offSubgroupG1())).toThrow();
    expect(() => decodeG2(offSubgroupG2())).toThrow();
    // the same bytes ARE valid curve points: the refusal comes from the subgroup check and nothing else
    const raw = offSubgroupG1();
    const x = BigInt(`0x${hexLower(Uint8Array.from(raw, (v, i) => (i === 0 ? v & 0x1f : v)))}`);
    expect(x > 1n && x < 200n).toBe(true);
  });

  it('never modifies the caller\'s buffer (noble clears flag bits of a Node Buffer in place)', () => {
    const k = Buffer.from(pkOf(5n));
    const before = Buffer.from(k);
    decodeG1(k);
    decodeG1(k);
    expect(k.equals(before)).toBe(true);
    const sg = Buffer.from(signAll(5n, msg(2), 3));
    const sb = Buffer.from(sg);
    decodeG2(sg);
    decodeG2(sg);
    expect(sg.equals(sb)).toBe(true);
    // a committee decoded from a Buffer view can be used twice
    const cache = new KeyCache();
    const raw = Buffer.alloc(SyncCommitteeBytes);
    for (let i = 0; i < 513; i++) k.copy(raw, i * 48);
    const c = new Committee(raw, cache);
    const m = msg(3);
    const agg = aggOf(range(342), signAll(5n, m, 342));
    fastAggregateVerify(c, agg, m);
    fastAggregateVerify(new Committee(raw, new KeyCache()), agg, m);
  });
});

describe('fastAggregateVerify', () => {
  it('verifies the aggregate of the participating seats and rejects a wrong message, signature or seat set', () => {
    const cache = new KeyCache();
    const c = committeeOf(pkOf(1n), cache);
    const m = msg(7);
    fastAggregateVerify(c, aggOf([0, 1, 2, 3], signAll(1n, m, 4)), m);
    expect(() => fastAggregateVerify(c, aggOf([0, 1, 2, 3], signAll(1n, m, 4)), msg(8))).toThrow(/does not verify/);
    expect(() => fastAggregateVerify(c, aggOf([0, 1, 2], signAll(1n, m, 4)), m)).toThrow(/does not verify/);
    expect(() => fastAggregateVerify(c, aggOf([0, 1, 2, 3, 4], signAll(1n, m, 4)), m)).toThrow(/does not verify/);
    expect(() => fastAggregateVerify(c, aggOf([], signAll(1n, m, 1)), m)).toThrow(/no participants/);
  });

  it('decodes only the keys of participating seats (spec FastAggregateVerify)', () => {
    const garbage = new Uint8Array(48).fill(0xff);
    const c = committeeOf(pkOf(1n), new KeyCache(), new Map([[5, garbage]]));
    const m = msg(7);
    fastAggregateVerify(c, aggOf([0, 1, 2, 3], signAll(1n, m, 4)), m);
    expect(() => fastAggregateVerify(c, aggOf([0, 1, 2, 3, 5], signAll(1n, m, 5)), m)).toThrow(/finite compressed/);
  });

  it('sums a key the committee holds twice once per set bit, and decodes each distinct key once', () => {
    const cache = new KeyCache();
    const c = committeeOf(pkOf(2n), cache);
    const m = msg(9);
    fastAggregateVerify(c, aggOf(range(342), signAll(2n, m, 342)), m);
    expect(cache.decoded).toBe(1);
    expect(() => fastAggregateVerify(c, aggOf(range(342), signAll(2n, m, 341)), m)).toThrow(/does not verify/);
    // two distinct keys in alternating seats
    const raw = new Uint8Array(SyncCommitteeBytes);
    for (let i = 0; i < 512; i++) raw.set(pkOf(i % 2 === 0 ? 3n : 4n), i * 48);
    raw.set(pkOf(3n), 512 * 48);
    const c2cache = new KeyCache();
    const c2 = new Committee(raw, c2cache);
    const seats = range(342);
    const secret = seats.reduce((a, s) => a + (s % 2 === 0 ? 3n : 4n), 0n);
    const sig = bls12_381.longSignatures.sign(bls12_381.longSignatures.hash(m, blsDST), secret).toBytes(true);
    fastAggregateVerify(c2, aggOf(seats, sig), m);
    expect(c2cache.decoded).toBe(2);
    // a cache shared by two committees decodes a shared key once
    const shared = new KeyCache();
    fastAggregateVerify(committeeOf(pkOf(2n), shared), aggOf(range(342), signAll(2n, m, 342)), m);
    fastAggregateVerify(committeeOf(pkOf(2n), shared), aggOf(range(342), signAll(2n, m, 342)), m);
    expect(shared.decoded).toBe(1);
  });

  it('caches a refusal too: an invalid participating key fails every time', () => {
    const cache = new KeyCache();
    const bad = offSubgroupG1();
    const c = committeeOf(pkOf(1n), cache, new Map([[1, bad]]));
    const m = msg(1);
    for (let i = 0; i < 2; i++) expect(() => fastAggregateVerify(c, aggOf([0, 1], signAll(1n, m, 2)), m)).toThrow();
    expect(cache.decoded).toBe(2);
  });

  it('refuses the identity or off-subgroup signature and an identity aggregate key', () => {
    const c = committeeOf(pkOf(1n), new KeyCache());
    const m = msg(4);
    const id2 = new Uint8Array(96);
    id2[0] = 0xc0;
    expect(() => fastAggregateVerify(c, aggOf([0], id2), m)).toThrow();
    expect(() => fastAggregateVerify(c, aggOf([0], offSubgroupG2()), m)).toThrow();
    // keys k and -k cancel: the aggregate key is the identity
    const neg = bls12_381.G1.Point.BASE.negate().toBytes(true);
    const raw = new Uint8Array(SyncCommitteeBytes);
    raw.set(pkOf(1n), 0);
    raw.set(neg, 48);
    for (let i = 2; i < 513; i++) raw.set(pkOf(1n), i * 48);
    const cc = new Committee(raw, new KeyCache());
    expect(() => fastAggregateVerify(cc, aggOf([0, 1], signAll(1n, m, 1)), m)).toThrow(/identity aggregate/);
  });
});

describe('signing domain and root', () => {
  it('compute_domain and compute_signing_root as the consensus specification defines them', () => {
    const gvr = Uint8Array.from({ length: 32 }, (_, i) => i);
    const d = computeDomain(Uint8Array.of(0x90, 0, 0, 0x76), gvr);
    expect(d.length).toBe(32);
    expect(Array.from(d.subarray(0, 4))).toEqual([7, 0, 0, 0]);
    // fork_data_root = sha256(version padded to 32 || gvr); the domain carries its first 28 bytes
    const fv = new Uint8Array(32);
    fv.set([0x90, 0, 0, 0x76]);
    const forkDataRoot = sha256(Uint8Array.of(...fv, ...gvr));
    expect(hexLower(d.subarray(4))).toBe(hexLower(forkDataRoot.subarray(0, 28)));
    expect(hexLower(signingRoot(new Uint8Array(32).fill(1), d))).toBe(hexLower(sha256(Uint8Array.of(...new Uint8Array(32).fill(1), ...d))));
    expect(computeDomain(Uint8Array.of(0x90, 0, 0, 0x77), gvr)).not.toEqual(d);
    expect(computeDomain(Uint8Array.of(0x90, 0, 0, 0x76), new Uint8Array(32))).not.toEqual(d);
    const r = signingRoot(new Uint8Array(32).fill(1), d);
    expect(r.length).toBe(32);
    expect(signingRoot(new Uint8Array(32).fill(2), d)).not.toEqual(r);
    expect(signingRoot(new Uint8Array(32).fill(1), computeDomain(Uint8Array.of(0x90, 0, 0, 0x77), gvr))).not.toEqual(r);
  });
});
