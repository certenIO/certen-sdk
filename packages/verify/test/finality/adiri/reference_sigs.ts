/**
 * The REFERENCE of the batched signature check: the form it had at pv2/rb12-ts-base (d7ca45b) before the multi-scalar multiplication,
 * the deferred cofactor clearing and the worker pool, kept verbatim as a test oracle. It forms the two sums with one noble scalar
 * multiplication per record and per sum and hashes every message with noble's full hash-to-curve; its decoder is the original
 * noble-based one. The production code (batched.ts, msm.ts, pool.ts) must return the same verdict on every input.
 */
import { bls12_381 } from '@noble/curves/bls12-381';
import { randomBytes } from '@noble/hashes/utils';
import { ReasonEncoding, ReasonIdentity, ReasonPairing, ReasonSubgroup, type SignatureReason } from '../../../src/proof-v2/finality/adiri/states.js';
import { SigBytes } from '../../../src/proof-v2/finality/adiri/cfa1.js';
import { SignatureDST, verifyOne, type Failure, type G1Point, type G2Point, type KeyEntry, type Rand, type SigItem } from '../../../src/proof-v2/finality/adiri/sigs.js';

const Fp = bls12_381.fields.Fp;
const FIELD_P: bigint = Fp.ORDER;
const HALF_P: bigint = (FIELD_P - 1n) / 2n;

function beInt(b: Uint8Array): bigint {
  let n = 0n;
  for (const x of b) n = (n << 8n) | BigInt(x);
  return n;
}

/** The decoder of the base commit (gnark-crypto SetBytes), verbatim. */
export function referenceDecodeSignature(b: Uint8Array): { point: G1Point; reason: undefined } | { point: undefined; reason: SignatureReason } {
  const enc = (): { point: undefined; reason: SignatureReason } => ({ point: undefined, reason: ReasonEncoding });
  if (b.length !== SigBytes) return enc();
  const flags = b[0]! & 0xe0;
  if (flags === 0xc0) {
    for (let i = 1; i < SigBytes; i++) if (b[i] !== 0) return enc();
    if ((b[0]! & 0x1f) !== 0) return enc();
    return { point: undefined, reason: ReasonIdentity };
  }
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
  const largest = y > HALF_P;
  if (largest !== (flags === 0xa0)) y = Fp.neg(y);
  const point = bls12_381.G1.Point.fromAffine({ x, y });
  if (!point.isTorsionFree()) return { point: undefined, reason: ReasonSubgroup };
  return { point, reason: undefined };
}

const aggregateKey = (signer: readonly KeyEntry[]): G2Point => {
  let a = signer[0]!.g2;
  for (let i = 1; i < signer.length; i++) a = a.add(signer[i]!.g2);
  return a;
};
const signerGroup = (signer: readonly KeyEntry[]): string => signer.map((k) => k.id).join(',');
const hashMsg = (msg: Uint8Array): G1Point => bls12_381.shortSignatures.hash(msg, SignatureDST);

function batchScalar(rnd: Rand): bigint {
  for (;;) {
    const s = beInt(rnd(16));
    if (s > 0n) return s;
  }
}

interface Term {
  rs: G1Point;
  rh: G1Point;
  agg: G2Point;
  aggKey: string;
}

function combinationHolds(terms: readonly Term[], n: number): boolean {
  if (n === 0) return true;
  let lhs = terms[0]!.rs;
  const groups = new Map<string, { agg: G2Point; sum: G1Point }>();
  for (let i = 0; i < n; i++) {
    const t = terms[i]!;
    if (i > 0) lhs = lhs.add(t.rs);
    const g = groups.get(t.aggKey);
    if (g === undefined) groups.set(t.aggKey, { agg: t.agg, sum: t.rh });
    else g.sum = g.sum.add(t.rh);
  }
  try {
    const pairs = [{ g1: lhs, g2: bls12_381.G2.Point.BASE.negate() }];
    for (const g of groups.values()) pairs.push({ g1: g.sum, g2: g.agg });
    return bls12_381.fields.Fp12.eql(bls12_381.pairingBatch(pairs), bls12_381.fields.Fp12.ONE);
  } catch {
    return false;
  }
}

/** The batched check of the base commit, verbatim: the lowest failing item and its reason, or undefined. */
export function referenceFirstFailureBatched(items: readonly SigItem[], rnd: Rand = randomBytes): Failure | undefined {
  if (items.length === 0) return undefined;
  const decoded: G1Point[] = [];
  let decodeFail: Failure | undefined;
  for (let i = 0; i < items.length; i++) {
    const d = referenceDecodeSignature(items[i]!.sig);
    if (d.reason !== undefined) {
      decodeFail = { index: i, reason: d.reason };
      break;
    }
    if (items[i]!.signer.length === 0) {
      decodeFail = { index: i, reason: ReasonPairing };
      break;
    }
    decoded.push(d.point);
  }
  const n = decodeFail === undefined ? items.length : decodeFail.index;
  const terms: Term[] = [];
  const aggs = new Map<string, G2Point>();
  const termAt = (i: number): Term => {
    let t = terms[i];
    if (t === undefined) {
      const it = items[i]!;
      const r = batchScalar(rnd);
      const aggKey = signerGroup(it.signer);
      let agg = aggs.get(aggKey);
      if (agg === undefined) {
        agg = aggregateKey(it.signer);
        aggs.set(aggKey, agg);
      }
      t = { rs: decoded[i]!.multiplyUnsafe(r), rh: hashMsg(it.msg).multiplyUnsafe(r), agg, aggKey };
      terms[i] = t;
    }
    return t;
  };
  for (let i = 0; i < n; i++) termAt(i);
  if (n > 0 && !combinationHolds(terms, n)) {
    let lo = 0;
    let hi = n;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (combinationHolds(terms, mid)) lo = mid;
      else hi = mid;
    }
    const k = hi - 1;
    const reason = verifyOne(items[k]!);
    return { index: reason === undefined ? 0 : k, reason: reason ?? ReasonPairing };
  }
  return decodeFail;
}
