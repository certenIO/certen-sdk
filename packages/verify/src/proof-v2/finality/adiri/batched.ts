/**
 * The batched signature check of the Adiri chain (V2_SPEC_S7 5.8 O3), the production mode of sigs.ts `firstFailure`: one random linear
 * combination e(sum r_i sigma_i, g2) = prod_A e(sum_{i: A_i = A} r_i H(m_i), A) with 128-bit scalars, and only on failure a bisection over
 * prefixes of the SAME combination that localises the lowest failing record (never to accept).
 *
 * The order of judgement is exactly that of the one-record-at-a-time form it replaces: the signatures are decoded in order up to the first
 * refusal (an empty signer list fails its pairing at its own index), one scalar is drawn per record before that index, and the records
 * before it are judged by the combination. What changed is how the two sums are formed: bucket multi-scalar multiplication (msm.ts)
 * instead of one scalar multiplication per record and per sum, and the cofactor clearing of the hash (a fixed homomorphism) applied once
 * to each group's sum of r_i * Q_i instead of to every H(m_i) = clear(Q_i). Both sums are group elements, so for the same scalars they are
 * the same points and the combination holds exactly when it held before.
 *
 * sigs.ts hands in the functions this module needs (BatchContext) so that the two files do not import each other.
 */
import { bls12_381 } from '@noble/curves/bls12-381';
import { ReasonEncoding, ReasonIdentity, ReasonPairing, ReasonSubgroup, type SignatureReason } from './states.js';
import { SigEncoding, SigIdentity, SigOk, SigSubgroup, clearG1Cofactor, combineBatch, decodeBatch, groupSums, msm, type G1Point } from './msm.js';
import type { Failure, G2Point, KeyEntry, Rand, SigItem } from './sigs.js';

export interface BatchContext {
  /** the hash-to-curve domain separation tag of the signatures */
  dst: string;
  /** a 128-bit scalar >= 1 drawn from rnd */
  batchScalar(rnd: Rand): bigint;
  /** the aggregate key of a signer list */
  aggregateKey(signer: readonly KeyEntry[]): G2Point;
  /** the group of a signer list: the same list of keys, in order, is the same group */
  signerGroup(signer: readonly KeyEntry[]): string;
  /** the individual judgement of one item (undefined = valid) */
  verifyOne(it: SigItem): SignatureReason | undefined;
}

const reasonOf = (code: number): SignatureReason => {
  switch (code) {
    case SigEncoding:
      return ReasonEncoding;
    case SigIdentity:
      return ReasonIdentity;
    case SigSubgroup:
      return ReasonSubgroup;
    default:
      throw new RangeError(`unknown signature decode code ${code}`);
  }
};

/** The lowest failing item and its reason under the batched mode, or undefined. */
export function firstFailureBatched(items: readonly SigItem[], rnd: Rand, ctx: BatchContext): Failure | undefined {
  // every signature is decoded and checked before it enters the combination; an empty signer list has no aggregate key and fails its
  // pairing (its decode, if it fails, is reported first)
  let emptyAt = items.length;
  for (let i = 0; i < items.length; i++) {
    if (items[i]!.signer.length === 0) {
      emptyAt = i;
      break;
    }
  }
  const upto = Math.min(emptyAt + 1, items.length);
  const dec = decodeBatch({ sigs: items.slice(0, upto).map((it) => it.sig) });
  let decodeFail: Failure | undefined;
  for (let i = 0; i < upto; i++) {
    if (dec.codes[i] !== SigOk) {
      decodeFail = { index: i, reason: reasonOf(dec.codes[i]!) };
      break;
    }
  }
  if (decodeFail === undefined && emptyAt < items.length) decodeFail = { index: emptyAt, reason: ReasonPairing };
  // the items before the first undecodable one are judged by the combination; that one fails by its decode reason
  const n = decodeFail === undefined ? items.length : decodeFail.index;
  if (n === 0) return decodeFail;

  const scalars: bigint[] = [];
  for (let i = 0; i < n; i++) scalars.push(ctx.batchScalar(rnd));
  const groupOf = new Map<string, number>();
  const groups: number[] = [];
  const aggs: G2Point[] = [];
  for (let i = 0; i < n; i++) {
    const key = ctx.signerGroup(items[i]!.signer);
    let g = groupOf.get(key);
    if (g === undefined) {
      g = aggs.length;
      groupOf.set(key, g);
      aggs.push(ctx.aggregateKey(items[i]!.signer));
    }
    groups.push(g);
  }
  const points = dec.points.slice(0, n) as G1Point[];
  const negG2 = bls12_381.G2.Point.BASE.negate();

  /** The pairing check of a combination (all signatures already decoded). A zero sum or aggregate cannot be paired: it does not hold. */
  const holds = (sumSig: G1Point, sums: ReadonlyMap<number, G1Point>): boolean => {
    try {
      const pairs = [{ g1: sumSig, g2: negG2 }];
      for (const [g, s] of sums) pairs.push({ g1: clearG1Cofactor(s), g2: aggs[g]! });
      return bls12_381.fields.Fp12.eql(bls12_381.pairingBatch(pairs), bls12_381.fields.Fp12.ONE);
    } catch {
      return false;
    }
  };

  const full = combineBatch({ points, msgs: items.slice(0, n).map((it) => it.msg), scalars, groups, dst: ctx.dst });
  if (holds(full.sumSig, full.sumHash)) return decodeFail;

  // bisect for the lowest k such that the prefix [0..k] fails: prefix(lo) holds, prefix(hi) fails. The prefix sums are carried: the
  // sums of [lo, mid) are added to those of [0, lo), so the multi-scalar multiplications over all steps total about one over n.
  let lo = 0;
  let hi = n;
  let accSig: G1Point | undefined;
  let accSums = new Map<number, G1Point>();
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    const incSig = msm(points.slice(lo, mid), scalars.slice(lo, mid));
    const candSig = accSig === undefined ? incSig : accSig.add(incSig);
    const candSums = new Map(accSums);
    for (const [g, s] of groupSums(full.hashPts, scalars, groups, lo, mid)) {
      const prev = candSums.get(g);
      candSums.set(g, prev === undefined ? s : prev.add(s));
    }
    if (holds(candSig, candSums)) {
      lo = mid;
      accSig = candSig;
      accSums = candSums;
    } else hi = mid;
  }
  const k = hi - 1;
  const reason = ctx.verifyOne(items[k]!);
  // the combination rejected what the item itself accepts: a negligible-probability event, never an acceptance
  return { index: reason === undefined ? 0 : k, reason: reason ?? ReasonPairing };
}
