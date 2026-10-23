/**
 * The group arithmetic of the batched Adiri signature check (V2_SPEC_S7 5.8 O3): G1 signature decoding, a bucket (Pippenger)
 * multi-scalar multiplication for the 128-bit batch scalars, and the two jobs the check is made of (`decodeBatch`, `combineBatch`),
 * each a pure function of plain data so that the same code runs in this thread or in a worker thread (pool.ts, pool-worker.ts).
 *
 * LEAF MODULE: it imports only @noble packages and no sibling file. The worker thread loads it by file name (`.js` from a build,
 * `.ts` under Node's type stripping), which cannot resolve a relative `./x.js` import of a `.ts` source; the syntax is erasable
 * TypeScript only (no enums, parameter properties or namespaces).
 */
import { bls12_381 } from '@noble/curves/bls12-381';

export type G1Point = InstanceType<typeof bls12_381.G1.Point>;

const G1P = bls12_381.G1.Point;
const Fp = bls12_381.fields.Fp;
const FIELD_P: bigint = Fp.ORDER;
const HALF_P: bigint = (FIELD_P - 1n) / 2n;

/** The result codes of a signature decode: 0 is a point; 1..3 are the encoding, identity and subgroup refusals; 255 = not examined. */
export const SigOk = 0;
export const SigEncoding = 1;
export const SigIdentity = 2;
export const SigSubgroup = 3;
export const SigNotExamined = 255;

function beInt(b: Uint8Array): bigint {
  let n = 0n;
  for (const x of b) n = (n << 8n) | BigInt(x);
  return n;
}

/**
 * Decodes a compressed G1 signature with the encoding, non-identity and subgroup checks, each reported by its own code (gnark-crypto
 * Decoder with NoSubgroupChecks, then IsInfinity, IsOnCurve, IsInSubGroup). A signature is a point only as a FINITE COMPRESSED encoding
 * (flag bits 100 or 101) with a canonical (below the modulus) x on the curve; the compressed identity is the all-zero encoding with flag
 * bits 110; every other flag pattern is an encoding error.
 */
export function decodeG1Signature(b: Uint8Array): { code: 0; point: G1Point } | { code: 1 | 2 | 3; point: undefined } {
  if (b.length !== 48) return { code: SigEncoding, point: undefined };
  const flags = b[0]! & 0xe0;
  if (flags === 0xc0) {
    // compressed infinity: the low five bits of the first byte and every other byte are zero (else invalid infinity encoding)
    for (let i = 1; i < 48; i++) if (b[i] !== 0) return { code: SigEncoding, point: undefined };
    if ((b[0]! & 0x1f) !== 0) return { code: SigEncoding, point: undefined };
    return { code: SigIdentity, point: undefined };
  }
  // 000 and 010 (uncompressed forms) need 96 bytes; 001, 011 and 111 are invalid masks
  if (flags !== 0x80 && flags !== 0xa0) return { code: SigEncoding, point: undefined };
  const xb = Uint8Array.from(b);
  xb[0]! &= 0x1f;
  const x = beInt(xb);
  if (x >= FIELD_P) return { code: SigEncoding, point: undefined };
  let y: bigint;
  try {
    y = Fp.sqrt(Fp.add(Fp.mul(Fp.mul(x, x), x), 4n));
  } catch {
    return { code: SigEncoding, point: undefined };
  }
  // the lexicographically largest root is the one with y > (p-1)/2; flag 101 asks for it, flag 100 for the other
  const largest = y > HALF_P;
  if (largest !== (flags === 0xa0)) y = Fp.neg(y);
  const point = G1P.fromAffine({ x, y });
  if (!point.isTorsionFree()) return { code: SigSubgroup, point: undefined };
  return { code: SigOk, point };
}

/**
 * The window width, in bits, that minimises the number of group additions of a bucket multi-scalar multiplication of n scalars of `bits`
 * bits: ceil(bits / c) windows, each n additions into buckets and about 2 * (2^c - 1) to combine them.
 */
export function windowBits(n: number, bits: number): number {
  let best = 1;
  let bestCost = Infinity;
  for (let c = 1; c <= 16; c++) {
    const cost = Math.ceil(bits / c) * (n + 2 * ((1 << c) - 1));
    if (cost < bestCost) {
      best = c;
      bestCost = cost;
    }
  }
  return best;
}

/**
 * sum_i scalars[i] * points[i] by the bucket method (Pippenger). Every scalar is in [0, 2^bits). Unlike noble's own `msm` it
 * walks only the `bits` bits of the scalars it is given (the batch scalars are 128-bit, the curve order 255-bit).
 */
export function msm(points: readonly G1Point[], scalars: readonly bigint[], bits = 128): G1Point {
  const n = points.length;
  if (scalars.length !== n) throw new RangeError('msm: points and scalars differ in length');
  const limit = 1n << BigInt(bits);
  for (const s of scalars) if (s < 0n || s >= limit) throw new RangeError(`msm: scalar outside [0, 2^${bits})`);
  if (n === 0) return G1P.ZERO;
  const c = windowBits(n, bits);
  const windows = Math.ceil(bits / c);
  const mask = (1n << BigInt(c)) - 1n;
  const size = 1 << c;
  const digits = new Int32Array(windows * n);
  for (let i = 0; i < n; i++) {
    const s = scalars[i]!;
    for (let w = 0; w < windows; w++) digits[w * n + i] = Number((s >> BigInt(w * c)) & mask);
  }
  let acc: G1Point | undefined;
  for (let w = windows - 1; w >= 0; w--) {
    if (acc !== undefined) for (let k = 0; k < c; k++) acc = acc.double();
    const buckets: (G1Point | undefined)[] = new Array(size);
    for (let i = 0; i < n; i++) {
      const d = digits[w * n + i]!;
      if (d === 0) continue;
      const b = buckets[d];
      buckets[d] = b === undefined ? points[i]! : b.add(points[i]!);
    }
    // sum_j j * bucket[j] as a running sum from the top bucket down
    let running: G1Point | undefined;
    let total: G1Point | undefined;
    for (let j = size - 1; j >= 1; j--) {
      const b = buckets[j];
      if (b !== undefined) running = running === undefined ? b : running.add(b);
      if (running !== undefined) total = total === undefined ? running : total.add(running);
    }
    if (total !== undefined) acc = acc === undefined ? total : acc.add(total);
  }
  return acc ?? G1P.ZERO;
}

/** A projective point as plain data (structured-clone safe). */
export type Raw = readonly [bigint, bigint, bigint];
export const toRaw = (p: G1Point): Raw => [p.X, p.Y, p.Z];
export const fromRaw = (r: Raw): G1Point => new G1P(r[0], r[1], r[2]);

/** The signatures of a batch to decode. */
export interface DecodeJob {
  sigs: Uint8Array[];
}
export interface DecodeResult {
  /** per signature, the code of its decode (SigOk, or the refusal); everything after the first refusal is SigNotExamined */
  codes: Uint8Array;
  /** the decoded points, undefined where the code is not SigOk */
  points: (G1Point | undefined)[];
}

/** Decodes the signatures in order and stops at the first refusal (the later ones are SigNotExamined). */
export function decodeBatch(job: DecodeJob): DecodeResult {
  const n = job.sigs.length;
  const codes = new Uint8Array(n).fill(SigNotExamined);
  const points: (G1Point | undefined)[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const d = decodeG1Signature(job.sigs[i]!);
    codes[i] = d.code;
    if (d.code !== SigOk) break;
    points[i] = d.point;
  }
  return { codes, points };
}

/**
 * The inputs of one combination over a run of records: the decoded signature points, the signed messages, the 128-bit scalars r_i and
 * the group (distinct signer list) of each record.
 */
export interface CombineJob {
  points: G1Point[];
  msgs: Uint8Array[];
  scalars: bigint[];
  groups: number[];
  dst: string;
}
export interface CombineResult {
  /** sum_i r_i * sigma_i */
  sumSig: G1Point;
  /** per group, sum of r_i * H(m_i) over the group's records, ascending group */
  sumHash: Map<number, G1Point>;
  /** H(m_i) of every record (retained for the localisation of a failure) */
  hashPts: G1Point[];
}

/** H(m): the hash to G1 of the signature scheme (RFC 9380, suite BLS12381G1_XMD:SHA-256_SSWU_RO_ with the given DST). */
export function hashToG1(msg: Uint8Array, dst: string): G1Point {
  return bls12_381.shortSignatures.hash(msg, dst);
}

/** The two sums of the random linear combination over the records of the job. */
export function combineBatch(job: CombineJob): CombineResult {
  const n = job.points.length;
  if (job.msgs.length !== n || job.scalars.length !== n || job.groups.length !== n) throw new RangeError('combineBatch: arrays differ in length');
  const hashPts: G1Point[] = new Array(n);
  for (let i = 0; i < n; i++) hashPts[i] = hashToG1(job.msgs[i]!, job.dst);
  return { sumSig: msm(job.points, job.scalars), sumHash: groupSums(hashPts, job.scalars, job.groups, 0, n), hashPts };
}

/** Per group, sum_{i in [from, to)} scalars[i] * points[i], ascending group. */
export function groupSums(points: readonly G1Point[], scalars: readonly bigint[], groups: readonly number[], from: number, to: number): Map<number, G1Point> {
  const byGroup = new Map<number, { p: G1Point[]; s: bigint[] }>();
  for (let i = from; i < to; i++) {
    const g = groups[i]!;
    let e = byGroup.get(g);
    if (e === undefined) byGroup.set(g, (e = { p: [], s: [] }));
    e.p.push(points[i]!);
    e.s.push(scalars[i]!);
  }
  const out = new Map<number, G1Point>();
  for (const g of [...byGroup.keys()].sort((a, b) => a - b)) out.set(g, msm(byGroup.get(g)!.p, byGroup.get(g)!.s));
  return out;
}
