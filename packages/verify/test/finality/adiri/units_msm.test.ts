/**
 * The multi-scalar multiplication and the batched combination (RB12-TS-SPEED): the bucket sum equals the naive sum of scalar
 * multiplications at every size and scalar boundary, the decoder of msm.ts equals the base commit's decoder on every refusal class, and
 * the batched check built on it returns the verdict of the one-record-at-a-time form AND of the base commit's batched form (the frozen
 * reference in reference_sigs.ts) on valid, failing and hostile batches.
 */
import { bls12_381 } from '@noble/curves/bls12-381';
import { describe, expect, it } from 'vitest';
import { KeyCache, SignatureDST, firstFailure, firstOneByOne, type SigItem } from '../../../src/proof-v2/finality/adiri/index.js';
import {
  SigEncoding,
  SigIdentity,
  SigNotExamined,
  SigOk,
  SigSubgroup,
  clearG1Cofactor,
  combineBatch,
  decodeBatch,
  decodeG1Signature,
  fromRaw,
  groupSums,
  msm,
  toRaw,
  windowBits,
  type G1Point,
} from '../../../src/proof-v2/finality/adiri/msm.js';
import { referenceDecodeSignature, referenceFirstFailureBatched } from './reference_sigs.js';
import { aggregateSign, concat, filled, pubKey } from './synth.js';

const G1 = bls12_381.G1.Point;
const P = bls12_381.fields.Fp.ORDER;
const be48 = (n: bigint): Uint8Array => Uint8Array.from({ length: 48 }, (_, i) => Number((n >> BigInt(8 * (47 - i))) & 0xffn));

/** A deterministic generator (xorshift64*), so a failure reproduces from its seed. */
function prng(seed: number): () => bigint {
  let s = BigInt(seed) * 0x9e3779b97f4a7c15n + 1n;
  const M = (1n << 64n) - 1n;
  return () => {
    s ^= s >> 12n;
    s ^= (s << 25n) & M;
    s ^= s >> 27n;
    return (s * 0x2545f4914f6cdd1dn) & M;
  };
}
const rand128 = (r: () => bigint): bigint => (r() << 64n) | r();
const randBits = (r: () => bigint, bits: number): bigint => (((r() << 192n) | (r() << 128n) | (r() << 64n) | r()) & ((1n << BigInt(bits)) - 1n));
const point = (k: bigint): G1Point => G1.BASE.multiply((k % (bls12_381.fields.Fr.ORDER - 1n)) + 1n);
// the points are in the prime-order subgroup, so a scalar is reduced modulo its order (noble refuses a scalar at or above it)
const R = bls12_381.fields.Fr.ORDER;
const naive = (pts: readonly G1Point[], ss: readonly bigint[]): G1Point => pts.reduce((a, p, i) => a.add(p.multiplyUnsafe(ss[i]! % R)), G1.ZERO);

describe('msm equals the sum of scalar multiplications', () => {
  for (const seed of [1, 2]) {
    it(`random points and 128-bit scalars at sizes 0..40 (seed ${seed})`, () => {
      const r = prng(seed);
      for (let n = 0; n <= 40; n++) {
        const pts = Array.from({ length: n }, () => point(randBits(r, 255)));
        const ss = Array.from({ length: n }, () => rand128(r));
        expect(msm(pts, ss).equals(naive(pts, ss)), `n=${n}`).toBe(true);
      }
    });
  }

  it('the boundaries of the scalar range: 0, 1, 2^c - 1, 2^c and 2^128 - 1 at every window width', () => {
    const r = prng(3);
    const pts = Array.from({ length: 12 }, () => point(randBits(r, 255)));
    const edge = [0n, 1n, 2n, 3n, 15n, 16n, 255n, 256n, 65535n, 65536n, (1n << 64n) - 1n, 1n << 64n, (1n << 127n), (1n << 128n) - 1n];
    for (const e of edge) {
      const ss = pts.map((_, i) => (i % 3 === 0 ? e : i % 3 === 1 ? 1n : rand128(r)));
      expect(msm(pts, ss).equals(naive(pts, ss)), `scalar ${e}`).toBe(true);
    }
    // every window width 1..16 gives the same point: force each by the size of the instance
    for (const n of [1, 2, 3, 5, 9, 17, 33, 70, 140, 300]) {
      const many = Array.from({ length: n }, (_, i) => pts[i % pts.length]!.multiplyUnsafe(BigInt(i + 1)));
      const ss = many.map(() => rand128(r));
      expect(msm(many, ss).equals(naive(many, ss)), `n=${n} c=${windowBits(n, 128)}`).toBe(true);
    }
  });

  it('identity points, repeated points and cancelling pairs are summed exactly', () => {
    const p = point(11n);
    const q = point(12n);
    const s = (1n << 100n) + 12345n;
    expect(msm([G1.ZERO, p], [s, 5n]).equals(p.multiplyUnsafe(5n))).toBe(true);
    expect(msm([G1.ZERO], [s]).is0()).toBe(true);
    expect(msm([p, p, p], [1n, 2n, 3n]).equals(p.multiplyUnsafe(6n))).toBe(true);
    expect(msm([p, p.negate()], [s, s]).is0()).toBe(true);
    expect(msm([p, q], [0n, 0n]).is0()).toBe(true);
    expect(msm([], []).is0()).toBe(true);
  });

  it('other scalar widths: the bits argument bounds the scalars exactly (N passes, N-1 fails)', () => {
    const r = prng(4);
    for (const bits of [1, 2, 5, 64, 128, 129, 255]) {
      const pts = Array.from({ length: 9 }, () => point(randBits(r, 255)));
      const top = (1n << BigInt(bits)) - 1n;
      const ss = pts.map((_, i) => (i === 0 ? top : randBits(r, bits)));
      expect(msm(pts, ss, bits).equals(naive(pts, ss)), `bits=${bits}`).toBe(true);
      expect(() => msm(pts, [top + 1n, ...ss.slice(1)], bits), `bits=${bits}`).toThrow(RangeError);
    }
  });

  it('refuses a negative scalar and mismatched lengths', () => {
    const p = point(1n);
    expect(() => msm([p], [-1n])).toThrow(RangeError);
    expect(() => msm([p, p], [1n])).toThrow(RangeError);
    expect(() => msm([p], [1n, 2n])).toThrow(RangeError);
    expect(() => msm([p], [1n << 128n])).toThrow(RangeError);
    expect(msm([p], [(1n << 128n) - 1n]).equals(p.multiplyUnsafe((1n << 128n) - 1n))).toBe(true);
  });

  it('windowBits is the width of least cost for every size, between 1 and 16', () => {
    const cost = (n: number, bits: number, c: number): number => Math.ceil(bits / c) * (n + 2 * ((1 << c) - 1));
    for (const bits of [8, 64, 128, 255]) {
      for (const n of [1, 2, 3, 4, 8, 16, 32, 64, 100, 200, 652, 1000, 4096, 100000, 1000000]) {
        const c = windowBits(n, bits);
        expect(c).toBeGreaterThanOrEqual(1);
        expect(c).toBeLessThanOrEqual(16);
        for (let o = 1; o <= 16; o++) expect(cost(n, bits, c), `n=${n} bits=${bits} c=${c} vs ${o}`).toBeLessThanOrEqual(cost(n, bits, o));
      }
    }
    expect(windowBits(652, 128)).toBe(6);
    expect(windowBits(1, 128)).toBe(1);
  });
});

describe('decodeG1Signature is the base commit decoder', () => {
  const good = aggregateSign([0], concat(Uint8Array.of(1, 0, 1, 0x20), filled(32, 0)));
  const reasonCode = { encoding: SigEncoding, identity: SigIdentity, subgroup: SigSubgroup } as const;
  const agree = (b: Uint8Array, label: string): void => {
    const ref = referenceDecodeSignature(b);
    const got = decodeG1Signature(b);
    if (ref.reason === undefined) {
      expect(got.code, label).toBe(SigOk);
      expect(got.point!.equals(ref.point), label).toBe(true);
    } else {
      expect(got.code, label).toBe(reasonCode[ref.reason]);
      expect(got.point, label).toBeUndefined();
    }
  };

  it('agrees on every flag byte over valid, identity-shaped and random bodies', () => {
    const r = prng(5);
    for (let f = 0; f < 256; f++) {
      for (const body of [good, new Uint8Array(48), filled(48, 0xff), be48(randBits(r, 381)), be48(P - 1n), be48(P), be48(P + 1n), be48((1n << 381n) - 1n)]) {
        const b = Uint8Array.from(body);
        b[0] = (b[0]! & 0x1f) | (f & 0xe0);
        agree(b, `flag ${f.toString(16)} body ${Array.from(body.subarray(0, 4)).join(',')}`);
        const c = Uint8Array.from(body);
        c[0] = f;
        agree(c, `byte0 ${f.toString(16)}`);
      }
    }
  });

  it('agrees on lengths 0..100 and on a lengthened valid signature', () => {
    for (let n = 0; n <= 100; n++) agree(filled(n, 0x80), `len ${n}`);
    for (let n = 0; n <= 100; n++) agree(n <= 48 ? good.subarray(0, n) : concat(good, new Uint8Array(n - 48)), `valid len ${n}`);
  });

  it('agrees on 400 random x with each sign flag: roots, non-roots and points outside the subgroup', () => {
    const r = prng(6);
    const seen = { ok: 0, enc: 0, sub: 0 };
    for (let i = 0; i < 400; i++) {
      const b = be48(randBits(r, 381));
      b[0] = (b[0]! & 0x1f) | (i % 2 === 0 ? 0x80 : 0xa0);
      agree(b, `random ${i}`);
      const c = decodeG1Signature(b).code;
      if (c === SigOk) seen.ok++;
      else if (c === SigSubgroup) seen.sub++;
      else seen.enc++;
    }
    // a random curve point is in the prime-order subgroup with probability about 2^-126: the valid case is covered by the signed vectors
    expect(seen.ok).toBe(0);
    expect(seen.enc).toBeGreaterThan(0);
    expect(seen.sub).toBeGreaterThan(0);
  });

  it('agrees on the boundary of the modulus: x = p-1 passes the range check, x = p does not', () => {
    for (const x of [0n, 1n, 2n, P - 2n, P - 1n, P, P + 1n]) {
      for (const flag of [0x80, 0xa0]) {
        const b = be48(x);
        b[0]! |= flag;
        agree(b, `x=${x} flag=${flag}`);
      }
    }
    const atP = be48(P);
    atP[0]! |= 0x80;
    expect(decodeG1Signature(atP).code).toBe(SigEncoding);
  });

  it('the identity is "identity" only for flags 110 with every other bit zero', () => {
    const id = Uint8Array.of(0xc0, ...new Uint8Array(47));
    expect(decodeG1Signature(id).code).toBe(SigIdentity);
    for (let i = 0; i < 48; i++) {
      const b = Uint8Array.from(id);
      b[i]! |= i === 0 ? 0x01 : 0x80;
      expect(decodeG1Signature(b).code, `bit in byte ${i}`).toBe(SigEncoding);
      agree(b, `bit in byte ${i}`);
    }
  });
});

describe('decodeBatch', () => {
  it('stops at the first refusal and marks the rest not examined', () => {
    const msg = concat(Uint8Array.of(1, 0, 1, 0x20), filled(32, 0));
    const ok = aggregateSign([0, 1], msg);
    const id = Uint8Array.of(0xc0, ...new Uint8Array(47));
    const r = decodeBatch({ sigs: [ok, ok, id, filled(48, 0xff), ok] });
    expect(Array.from(r.codes)).toEqual([SigOk, SigOk, SigIdentity, SigNotExamined, SigNotExamined]);
    expect(r.points[0]!.equals(r.points[1]!)).toBe(true);
    expect(r.points[2]).toBeUndefined();
    expect(r.points[3]).toBeUndefined();
    expect(r.points[4]).toBeUndefined();
    expect(Array.from(decodeBatch({ sigs: [] }).codes)).toEqual([]);
    expect(Array.from(decodeBatch({ sigs: [filled(48, 0xff)] }).codes)).toEqual([SigEncoding]);
  });
});

describe('combineBatch sums the hash points and the signature points as the base commit did', () => {
  const msgOf = (i: number): Uint8Array => concat(Uint8Array.of(1, 0, 1, 0x20), filled(32, i));
  const setup = (n: number, seed: number) => {
    const r = prng(seed);
    const points = Array.from({ length: n }, (_, i) => decodeG1Signature(aggregateSign([i % 4], msgOf(i))).point!);
    const msgs = Array.from({ length: n }, (_, i) => msgOf(i));
    const scalars = Array.from({ length: n }, () => rand128(r) | 1n);
    const groups = Array.from({ length: n }, () => Number(r() % 3n));
    return { points, msgs, scalars, groups, dst: SignatureDST };
  };

  it('sumSig and every group sum equal the sums of the single scalar multiplications', () => {
    for (const seed of [1, 2]) {
      const job = setup(13, seed);
      const res = combineBatch(job);
      expect(res.sumSig.equals(naive(job.points, job.scalars))).toBe(true);
      const want = new Map<number, G1Point>();
      job.groups.forEach((g, i) => {
        const h = bls12_381.shortSignatures.hash(job.msgs[i]!, SignatureDST).multiplyUnsafe(job.scalars[i]!);
        want.set(g, want.has(g) ? want.get(g)!.add(h) : h);
      });
      expect([...res.sumHash.keys()]).toEqual([...want.keys()].sort((a, b) => a - b));
      // the sums are of the uncleared points Q_i: one clearing per group gives the sum of the H(m_i)
      for (const [g, w] of want) expect(clearG1Cofactor(res.sumHash.get(g)!).equals(w), `group ${g}`).toBe(true);
      expect(res.hashPts).toHaveLength(13);
    }
  });

  it('the sums do not depend on how the records are split: any partition adds up to the same points', () => {
    const job = setup(17, 3);
    const whole = combineBatch(job);
    for (const cuts of [[8], [1, 2, 3], [5, 6, 16], [4, 8, 12], [1, 16]]) {
      const bounds = [0, ...cuts, 17];
      let sig: G1Point | undefined;
      const sums = new Map<number, G1Point>();
      for (let k = 0; k + 1 < bounds.length; k++) {
        const [a, b] = [bounds[k]!, bounds[k + 1]!];
        const part = combineBatch({ ...job, points: job.points.slice(a, b), msgs: job.msgs.slice(a, b), scalars: job.scalars.slice(a, b), groups: job.groups.slice(a, b) });
        sig = sig === undefined ? part.sumSig : sig.add(part.sumSig);
        for (const [g, s] of part.sumHash) sums.set(g, sums.has(g) ? sums.get(g)!.add(s) : s);
      }
      expect(sig!.equals(whole.sumSig), `cuts ${cuts}`).toBe(true);
      for (const [g, s] of whole.sumHash) expect(sums.get(g)!.equals(s), `cuts ${cuts} group ${g}`).toBe(true);
    }
  });

  it('groupSums over a window of the records equals the sum of exactly those records', () => {
    const job = setup(10, 4);
    const res = combineBatch(job);
    const win = groupSums(res.hashPts, job.scalars, job.groups, 3, 8);
    const want = new Map<number, G1Point>();
    for (let i = 3; i < 8; i++) {
      const h = res.hashPts[i]!.multiplyUnsafe(job.scalars[i]!);
      want.set(job.groups[i]!, want.has(job.groups[i]!) ? want.get(job.groups[i]!)!.add(h) : h);
    }
    expect([...win.keys()]).toEqual([...want.keys()].sort((a, b) => a - b));
    for (const [g, w] of want) expect(win.get(g)!.equals(w)).toBe(true);
    expect(groupSums(res.hashPts, job.scalars, job.groups, 4, 4).size).toBe(0);
  });

  it('refuses arrays of different lengths', () => {
    const job = setup(3, 5);
    expect(() => combineBatch({ ...job, msgs: job.msgs.slice(1) })).toThrow(RangeError);
    expect(() => combineBatch({ ...job, scalars: job.scalars.slice(1) })).toThrow(RangeError);
    expect(() => combineBatch({ ...job, groups: job.groups.slice(1) })).toThrow(RangeError);
  });

  it('a point survives the plain-data form used between threads, the identity included', () => {
    const r = prng(7);
    for (let i = 0; i < 20; i++) {
      const p = point(randBits(r, 255)).multiplyUnsafe(rand128(r));
      const [x, y, z] = toRaw(p);
      expect(typeof x).toBe('bigint');
      expect(fromRaw(toRaw(p)).equals(p)).toBe(true);
      expect(fromRaw([x, y, z]).equals(p)).toBe(true);
    }
    expect(fromRaw(toRaw(G1.ZERO)).is0()).toBe(true);
  });
});

describe('the batched check returns the verdict of the one-by-one form and of the base commit', () => {
  const cache = new KeyCache();
  const entries = (nums: number[]) => nums.map((n) => cache.get(pubKey(n))!);
  const msgOf = (i: number): Uint8Array => concat(Uint8Array.of(1, 0, 1, 0x20), filled(32, i));
  const signerSets = [[0, 1, 2], [0, 1, 2, 3], [1, 2, 3], [0, 2, 3]];
  const item = (i: number): SigItem => {
    const set = signerSets[i % signerSets.length]!;
    return { epoch: i, sig: aggregateSign(set, msgOf(i)), signer: entries(set), msg: msgOf(i) };
  };
  const batch = (n: number): SigItem[] => Array.from({ length: n }, (_, i) => item(i));
  const counter = (): ((n: number) => Uint8Array) => {
    let c = 1;
    return (n) => {
      const out = new Uint8Array(n);
      out[n - 1] = (c++ % 250) + 1;
      out[n - 2] = (c * 7) % 251;
      return out;
    };
  };
  const all = (items: SigItem[], label: string) => {
    const a = firstOneByOne(items);
    const b = firstFailure(items, 'batched', counter());
    const c = referenceFirstFailureBatched(items, counter());
    expect(b, `${label}: batched vs one by one`).toEqual(a);
    expect(c, `${label}: reference vs one by one`).toEqual(a);
    return b;
  };

  it('a valid batch of every size 1..9 is accepted by all three', () => {
    for (let n = 1; n <= 9; n++) expect(all(batch(n), `n=${n}`)).toBeUndefined();
  });

  it('a single bad record at every position of batches of 1..9 is found at that position', () => {
    for (const n of [1, 2, 3, 4, 5, 8, 9]) {
      for (let k = 0; k < n; k++) {
        const items = batch(n);
        items[k] = { ...items[k]!, msg: msgOf(100 + k) };
        expect(all(items, `n=${n} k=${k}`), `n=${n} k=${k}`).toEqual({ index: k, reason: 'pairing' });
      }
    }
  });

  it('a wrong signer list, a signature by another set, and every group of the batch failing', () => {
    const items = batch(8);
    items[5] = { ...items[5]!, signer: entries([0, 1]) };
    expect(all(items, 'wrong signer list')).toEqual({ index: 5, reason: 'pairing' });
    const swapped = batch(8);
    swapped[2] = { ...swapped[2]!, sig: aggregateSign([0, 1, 2, 3], msgOf(2)) };
    expect(all(swapped, 'signature by another set')).toEqual({ index: 2, reason: 'pairing' });
    const every = batch(8).map((it, i) => ({ ...it, msg: msgOf(200 + i) }));
    expect(all(every, 'all failing')).toEqual({ index: 0, reason: 'pairing' });
  });

  it('with several bad records the lowest is named; swapped and duplicated records fail at the first changed position', () => {
    const items = batch(9);
    items[3] = { ...items[3]!, msg: msgOf(300) };
    items[6] = { ...items[6]!, msg: msgOf(301) };
    expect(all(items, 'two bad')).toEqual({ index: 3, reason: 'pairing' });
    const swap = batch(7);
    [swap[1], swap[4]] = [{ ...swap[1]!, sig: swap[4]!.sig }, { ...swap[4]!, sig: swap[1]!.sig }];
    expect(all(swap, 'signatures swapped')).toEqual({ index: 1, reason: 'pairing' });
    const dup = batch(7);
    dup[5] = { ...dup[5]!, sig: dup[2]!.sig };
    expect(all(dup, 'signature duplicated')).toEqual({ index: 5, reason: 'pairing' });
    const reordered = batch(7);
    [reordered[1], reordered[4]] = [reordered[4]!, reordered[1]!];
    expect(all(reordered, 'whole records reordered (each still valid)')).toBeUndefined();
  });

  it('decode refusals and an empty signer list are ordered with the pairing failures at their own index', () => {
    const id = Uint8Array.of(0xc0, ...new Uint8Array(47));
    const bad = batch(6);
    bad[3] = { ...bad[3]!, sig: id };
    expect(all(bad, 'identity')).toEqual({ index: 3, reason: 'identity' });
    const early = batch(6);
    early[1] = { ...early[1]!, msg: msgOf(400) };
    early[3] = { ...early[3]!, sig: id };
    expect(all(early, 'pairing before identity')).toEqual({ index: 1, reason: 'pairing' });
    const first = batch(6);
    first[0] = { ...first[0]!, sig: filled(48, 0xff) };
    first[1] = { ...first[1]!, msg: msgOf(401) };
    expect(all(first, 'encoding at 0')).toEqual({ index: 0, reason: 'encoding' });
    const empty = batch(5);
    empty[2] = { ...empty[2]!, signer: [] };
    expect(all(empty, 'empty signer list')).toEqual({ index: 2, reason: 'pairing' });
    const emptyBadSig = batch(5);
    emptyBadSig[2] = { ...emptyBadSig[2]!, signer: [], sig: id };
    expect(all(emptyBadSig, 'empty signer list with an identity signature')).toEqual({ index: 2, reason: 'identity' });
    const emptyFirst = batch(4);
    emptyFirst[0] = { ...emptyFirst[0]!, signer: [] };
    expect(all(emptyFirst, 'empty at 0')).toEqual({ index: 0, reason: 'pairing' });
    const lateBad = batch(6);
    lateBad[4] = { ...lateBad[4]!, signer: [] };
    lateBad[5] = { ...lateBad[5]!, sig: id };
    expect(all(lateBad, 'empty before a later refusal')).toEqual({ index: 4, reason: 'pairing' });
  });

  it('a signature off the subgroup is "subgroup" and an off-curve x is "encoding", in all three', () => {
    let offGroup: Uint8Array | undefined;
    for (let x = 1n; x < 400n && offGroup === undefined; x++) {
      const b = be48(x);
      b[0]! |= 0x80;
      if (referenceDecodeSignature(b).reason === 'subgroup') offGroup = b;
    }
    const items = batch(5);
    items[2] = { ...items[2]!, sig: offGroup! };
    expect(all(items, 'subgroup')).toEqual({ index: 2, reason: 'subgroup' });
    let noRoot: Uint8Array | undefined;
    for (let x = 1n; x < 400n && noRoot === undefined; x++) {
      const b = be48(x);
      b[0]! |= 0x80;
      if (referenceDecodeSignature(b).reason === 'encoding') noRoot = b;
    }
    const items2 = batch(5);
    items2[4] = { ...items2[4]!, sig: noRoot! };
    expect(all(items2, 'encoding')).toEqual({ index: 4, reason: 'encoding' });
  });

  it('draws exactly one scalar per record before the first refusal, in order, and none for a batch refused at 0', () => {
    const draws = (items: SigItem[]): number => {
      let n = 0;
      const spy = (m: number): Uint8Array => {
        n++;
        const out = new Uint8Array(m);
        out[m - 1] = n;
        return out;
      };
      firstFailure(items, 'batched', spy);
      return n;
    };
    expect(draws(batch(5))).toBe(5);
    const id = Uint8Array.of(0xc0, ...new Uint8Array(47));
    const refused = batch(5);
    refused[3] = { ...refused[3]!, sig: id };
    expect(draws(refused)).toBe(3);
    refused[0] = { ...refused[0]!, sig: id };
    expect(draws(refused)).toBe(0);
  });
});
