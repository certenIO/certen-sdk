/**
 * The deferred cofactor clearing (RB12-TS-SPEED): hash_to_curve(m) = clear(map(u0) + map(u1)) and the clearing is the homomorphism
 * multiplication by h_eff, so the batched check sums the uncleared points and clears once per group. Proved here against noble's own
 * hashToCurve / mapToCurve (the per-record clearing) on thousands of inputs, and the identity itself on random combinations that include
 * the point at infinity, points of every small order of the cofactor group, and points outside the prime-order subgroup.
 */
import { bls12_381 } from '@noble/curves/bls12-381';
import { describe, expect, it } from 'vitest';
import { SignatureDST } from '../../../src/proof-v2/finality/adiri/index.js';
import { clearG1Cofactor, hashToG1Unclamped, mapToG1Unclamped, msm, type G1Point } from '../../../src/proof-v2/finality/adiri/msm.js';

const G1 = bls12_381.G1.Point;
const Fp = bls12_381.fields.Fp;
const R = bls12_381.fields.Fr.ORDER;
const P = Fp.ORDER;

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
const rand = (r: () => bigint, bits: number): bigint => ((r() << 192n) | (r() << 128n) | (r() << 64n) | r()) & ((1n << BigInt(bits)) - 1n);
const bytesOf = (r: () => bigint, n: number): Uint8Array => Uint8Array.from({ length: n }, () => Number(r() & 0xffn));

/** y^2 z = x^3 + 4 z^3 (projective), the equation of E */
const onCurve = (p: G1Point): boolean => {
  const { X, Y, Z } = p;
  return Fp.eql(Fp.mul(Fp.sqr(Y), Z), Fp.add(Fp.mul(Fp.sqr(X), X), Fp.mul(4n, Fp.mul(Fp.sqr(Z), Z))));
};

describe('map_to_curve without the clearing, then the clearing, is noble mapToCurve', () => {
  it('equals noble on 1500 random field elements', () => {
    const r = prng(1);
    for (let i = 0; i < 1500; i++) {
      const u = rand(r, 381) % P;
      const raw = mapToG1Unclamped(u);
      expect(onCurve(raw), `u=${u}`).toBe(true);
      expect(clearG1Cofactor(raw).equals(bls12_381.G1.mapToCurve([u])), `u=${u}`).toBe(true);
    }
  });

  it('equals noble on the special inputs: 0, small values, +-1, +-(p-1)/2, the p boundary, and the roots of the exceptional case of the SWU', () => {
    const sqrtMinusInvZ = Fp.sqrt(Fp.neg(Fp.inv(11n)));
    const specials = [0n, 1n, 2n, 3n, 4n, 5n, 10n, 11n, 12n, P - 1n, P - 2n, (P - 1n) / 2n, (P + 1n) / 2n, (P - 3n) / 4n, P, P + 1n, 2n * P + 5n, sqrtMinusInvZ, Fp.neg(sqrtMinusInvZ)];
    for (const u of specials) {
      const raw = mapToG1Unclamped(u);
      expect(onCurve(raw), `u=${u}`).toBe(true);
      expect(clearG1Cofactor(raw).equals(bls12_381.G1.mapToCurve([u])), `u=${u}`).toBe(true);
    }
    // 11 * u^2 = -1: the case tv2 = 0 of the SWU, where tv4 is Z * A
    expect(Fp.mul(11n, Fp.sqr(sqrtMinusInvZ))).toBe(P - 1n);
  });

  it('the raw point is in general NOT in the prime-order subgroup (so the clearing is needed), and the cleared one always is', () => {
    const r = prng(2);
    let outside = 0;
    for (let i = 0; i < 40; i++) {
      const raw = mapToG1Unclamped(rand(r, 381) % P);
      if (!raw.isTorsionFree()) outside++;
      expect(clearG1Cofactor(raw).isTorsionFree()).toBe(true);
    }
    expect(outside).toBeGreaterThan(30);
  });
});

describe('hash to curve without the clearing, then the clearing, is noble hashToCurve', () => {
  it('equals shortSignatures.hash on 400 random messages of lengths 0..300 with the signature DST', () => {
    const r = prng(3);
    for (let i = 0; i < 400; i++) {
      const msg = bytesOf(r, i === 0 ? 0 : Number(r() % 301n));
      const got = clearG1Cofactor(hashToG1Unclamped(msg, SignatureDST));
      expect(got.equals(bls12_381.shortSignatures.hash(msg, SignatureDST)), `message ${i} (length ${msg.length})`).toBe(true);
    }
  });

  it('follows the DST it is given, including one longer than 255 bytes (the hashed form)', () => {
    const msg = Uint8Array.of(1, 2, 3);
    for (const dst of ['A', 'BLS_SIG_BLS12381G1_XMD:SHA-256_SSWU_RO_POP_', 'x'.repeat(255), 'y'.repeat(256), 'z'.repeat(300)]) {
      expect(clearG1Cofactor(hashToG1Unclamped(msg, dst)).equals(bls12_381.shortSignatures.hash(msg, dst)), `dst length ${dst.length}`).toBe(true);
    }
    expect(clearG1Cofactor(hashToG1Unclamped(msg, 'A')).equals(clearG1Cofactor(hashToG1Unclamped(msg, 'B')))).toBe(false);
  });

  it('is the signed-message shape of the chain: 36-byte messages for 300 digests', () => {
    const r = prng(4);
    for (let i = 0; i < 300; i++) {
      const msg = Uint8Array.from([1, 0, 1, 0x20, ...bytesOf(r, 32)]);
      expect(clearG1Cofactor(hashToG1Unclamped(msg, SignatureDST)).equals(bls12_381.shortSignatures.hash(msg, SignatureDST))).toBe(true);
    }
  });
});

describe('the deferral identity: sum r_i * clear(Q_i) = clear(sum r_i * Q_i)', () => {
  // the cofactor of G1 is h = (x - 1)^2 / 3 with |x| = 0xd201000000010000; its prime factorisation
  const H = (0xd201000000010001n * 0xd201000000010001n) / 3n;
  const FACTORS = [3n, 11n, 10177n, 859267n, 52437899n];
  it('h factors as 3 * 11^2 * 10177^2 * 859267^2 * 52437899^2', () => {
    expect(3n * 11n ** 2n * 10177n ** 2n * 859267n ** 2n * 52437899n ** 2n).toBe(H);
  });

  /** A random point of E(Fp) outside the prime-order subgroup. */
  const randomCurvePoint = (r: () => bigint): G1Point => {
    for (;;) {
      const x = rand(r, 381) % P;
      try {
        const y = Fp.sqrt(Fp.add(Fp.mul(Fp.sqr(x), x), 4n));
        return G1.fromAffine({ x, y });
      } catch {
        // x^3 + 4 is not a square: try the next
      }
    }
  };
  /** [r] R: the cofactor-group component of R (the multiple by r kills the prime-order part). */
  const cofactorPart = (pt: G1Point): G1Point => pt.multiplyUnsafe(R - 1n).add(pt);
  /** A point of order exactly q (a prime factor of h): the q-primary part of a cofactor-group point, walked down by q until q * T = 0. */
  const orderQ = (r: () => bigint, q: bigint): G1Point => {
    let e = 0n;
    for (let m = H; m % q === 0n; m /= q) e++;
    for (;;) {
      let t = cofactorPart(randomCurvePoint(r)).multiplyUnsafe(H / q ** e);
      if (t.is0()) continue;
      while (!t.multiplyUnsafe(q).is0()) t = t.multiplyUnsafe(q);
      return t;
    }
  };

  it('builds points of order exactly q for every prime q dividing the cofactor, and the point at infinity', () => {
    const r = prng(5);
    for (const q of FACTORS) {
      const t = orderQ(r, q);
      expect(t.is0(), `q=${q}`).toBe(false);
      expect(t.multiplyUnsafe(q).is0(), `q=${q}`).toBe(true);
      expect(clearG1Cofactor(t).isTorsionFree()).toBe(true);
    }
  });

  for (const seed of [11, 12]) {
    it(`250 random combinations of identity, small-order, cofactor-group, off-subgroup and subgroup points (seed ${seed})`, () => {
      const r = prng(seed);
      const small: G1Point[] = FACTORS.map((q) => orderQ(r, q));
      const kinds = ['identity', 'small', 'cofactor', 'offsubgroup', 'subgroup', 'mixed'] as const;
      const seen = new Set<string>();
      for (let round = 0; round < 250; round++) {
        const n = 1 + Number(r() % 9n);
        const pts: G1Point[] = [];
        for (let i = 0; i < n; i++) {
          const kind = kinds[Number(r() % BigInt(kinds.length))]!;
          seen.add(kind);
          switch (kind) {
            case 'identity':
              pts.push(G1.ZERO);
              break;
            case 'small':
              pts.push(small[Number(r() % BigInt(small.length))]!);
              break;
            case 'cofactor':
              pts.push(cofactorPart(randomCurvePoint(r)));
              break;
            case 'offsubgroup':
              pts.push(randomCurvePoint(r));
              break;
            case 'subgroup':
              pts.push(G1.BASE.multiply((rand(r, 255) % (R - 1n)) + 1n));
              break;
            default:
              pts.push(small[Number(r() % BigInt(small.length))]!.add(G1.BASE.multiply((rand(r, 255) % (R - 1n)) + 1n)));
          }
        }
        const ss = pts.map(() => (r() % 7n === 0n ? 0n : rand(r, 128)));
        const perRecord = pts.reduce((a, p, i) => a.add(clearG1Cofactor(p).multiplyUnsafe(ss[i]! % R)), G1.ZERO);
        const deferred = clearG1Cofactor(msm(pts, ss));
        expect(deferred.equals(perRecord), `round ${round}`).toBe(true);
      }
      expect(seen.size).toBe(kinds.length);
    });
  }

  it('the clearing of the identity is the identity, and of a subgroup point p is [1 - x] p', () => {
    expect(clearG1Cofactor(G1.ZERO).is0()).toBe(true);
    const p = G1.BASE.multiply(12345n);
    expect(clearG1Cofactor(p).equals(p.multiplyUnsafe(0xd201000000010001n))).toBe(true);
  });
});
