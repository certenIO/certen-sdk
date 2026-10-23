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
import { hash_to_field } from '@noble/curves/abstract/hash-to-curve';
import { SWUFpSqrtRatio } from '@noble/curves/abstract/weierstrass';
import { sha256 } from '@noble/hashes/sha2';

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

/** Decodes the signatures in order and stops at the first refusal (the later ones are SigNotExamined). tick is called after each record. */
export function decodeBatch(job: DecodeJob, tick?: () => void): DecodeResult {
  const n = job.sigs.length;
  const codes = new Uint8Array(n).fill(SigNotExamined);
  const points: (G1Point | undefined)[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const d = decodeG1Signature(job.sigs[i]!);
    codes[i] = d.code;
    if (d.code !== SigOk) break;
    points[i] = d.point;
    tick?.();
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
  /** per group, the sum of r_i * Q_i over the group's records, ascending group, where Q_i is H(m_i) BEFORE the cofactor clearing */
  sumHash: Map<number, G1Point>;
  /** Q_i = H(m_i) before the cofactor clearing, of every record (retained for the localisation of a failure) */
  hashPts: G1Point[];
}

// ---- hash to G1 without the cofactor clearing (RFC 9380: BLS12381G1_XMD:SHA-256_SSWU_RO_) -------------------------------------------
// hash_to_curve(m) = clear_cofactor(map(u0) + map(u1)) with (u0, u1) = hash_to_field(m, 2). The clearing is multiplication by the fixed
// effective cofactor h_eff = 1 - x (RFC 9380 8.8.1), a group homomorphism, so sum_i r_i * clear(Q_i) = clear(sum_i r_i * Q_i): the batched
// check sums the UNCLEARED points Q_i and clears once per group. noble's public hashToCurve always clears (and then checks the subgroup of
// each result), so the map is evaluated here: the RFC 9380 section 6.6.2 simplified SWU for the curve E': y^2 = x^3 + A'x + B' with Z = 11
// (the square-root-ratio is noble's own SWUFpSqrtRatio) followed by the 11-isogeny of section 6.6.3 and appendix E.2, evaluated in
// homogeneous coordinates so that no field inversion is needed. Every constant below is that appendix's; units_h2c.test.ts compares the
// result with noble's hashToCurve and mapToCurve on thousands of inputs.
const ISO_XNUM: readonly bigint[] = [
  0x11a05f2b1e833340b809101dd99815856b303e88a2d7005ff2627b56cdb4e2c85610c2d5f2e62d6eaeac1662734649b7n,
  0x17294ed3e943ab2f0588bab22147a81c7c17e75b2f6a8417f565e33c70d1e86b4838f2a6f318c356e834eef1b3cb83bbn,
  0xd54005db97678ec1d1048c5d10a9a1bce032473295983e56878e501ec68e25c958c3e3d2a09729fe0179f9dac9edcb0n,
  0x1778e7166fcc6db74e0609d307e55412d7f5e4656a8dbf25f1b33289f1b330835336e25ce3107193c5b388641d9b6861n,
  0xe99726a3199f4436642b4b3e4118e5499db995a1257fb3f086eeb65982fac18985a286f301e77c451154ce9ac8895d9n,
  0x1630c3250d7313ff01d1201bf7a74ab5db3cb17dd952799b9ed3ab9097e68f90a0870d2dcae73d19cd13c1c66f652983n,
  0xd6ed6553fe44d296a3726c38ae652bfb11586264f0f8ce19008e218f9c86b2a8da25128c1052ecaddd7f225a139ed84n,
  0x17b81e7701abdbe2e8743884d1117e53356de5ab275b4db1a682c62ef0f2753339b7c8f8c8f475af9ccb5618e3f0c88en,
  0x80d3cf1f9a78fc47b90b33563be990dc43b756ce79f5574a2c596c928c5d1de4fa295f296b74e956d71986a8497e317n,
  0x169b1f8e1bcfa7c42e0c37515d138f22dd2ecb803a0c5c99676314baf4bb1b7fa3190b2edc0327797f241067be390c9en,
  0x10321da079ce07e272d8ec09d2565b0dfa7dccdde6787f96d50af36003b14866f69b771f8c285decca67df3f1605fb7bn,
  0x6e08c248e260e70bd1e962381edee3d31d79d7e22c837bc23c0bf1bc24c6b68c24b1b80b64d391fa9c8ba2e8ba2d229n,
];
const ISO_XDEN: readonly bigint[] = [
  0x8ca8d548cff19ae18b2e62f4bd3fa6f01d5ef4ba35b48ba9c9588617fc8ac62b558d681be343df8993cf9fa40d21b1cn,
  0x12561a5deb559c4348b4711298e536367041e8ca0cf0800c0126c2588c48bf5713daa8846cb026e9e5c8276ec82b3bffn,
  0xb2962fe57a3225e8137e629bff2991f6f89416f5a718cd1fca64e00b11aceacd6a3d0967c94fedcfcc239ba5cb83e19n,
  0x3425581a58ae2fec83aafef7c40eb545b08243f16b1655154cca8abc28d6fd04976d5243eecf5c4130de8938dc62cd8n,
  0x13a8e162022914a80a6f1d5f43e7a07dffdfc759a12062bb8d6b44e833b306da9bd29ba81f35781d539d395b3532a21en,
  0xe7355f8e4e667b955390f7f0506c6e9395735e9ce9cad4d0a43bcef24b8982f7400d24bc4228f11c02df9a29f6304a5n,
  0x772caacf16936190f3e0c63e0596721570f5799af53a1894e2e073062aede9cea73b3538f0de06cec2574496ee84a3an,
  0x14a7ac2a9d64a8b230b3f5b074cf01996e7f63c21bca68a81996e1cdf9822c580fa5b9489d11e2d311f7d99bbdcc5a5en,
  0xa10ecf6ada54f825e920b3dafc7a3cce07f8d1d7161366b74100da67f39883503826692abba43704776ec3a79a1d641n,
  0x95fc13ab9e92ad4476d6e3eb3a56680f682b4ee96f7d03776df533978f31c1593174e4b4b7865002d6384d168ecdd0an,
  0x1n,
];
const ISO_YNUM: readonly bigint[] = [
  0x90d97c81ba24ee0259d1f094980dcfa11ad138e48a869522b52af6c956543d3cd0c7aee9b3ba3c2be9845719707bb33n,
  0x134996a104ee5811d51036d776fb46831223e96c254f383d0f906343eb67ad34d6c56711962fa8bfe097e75a2e41c696n,
  0xcc786baa966e66f4a384c86a3b49942552e2d658a31ce2c344be4b91400da7d26d521628b00523b8dfe240c72de1f6n,
  0x1f86376e8981c217898751ad8746757d42aa7b90eeb791c09e4a3ec03251cf9de405aba9ec61deca6355c77b0e5f4cbn,
  0x8cc03fdefe0ff135caf4fe2a21529c4195536fbe3ce50b879833fd221351adc2ee7f8dc099040a841b6daecf2e8fedbn,
  0x16603fca40634b6a2211e11db8f0a6a074a7d0d4afadb7bd76505c3d3ad5544e203f6326c95a807299b23ab13633a5f0n,
  0x4ab0b9bcfac1bbcb2c977d027796b3ce75bb8ca2be184cb5231413c4d634f3747a87ac2460f415ec961f8855fe9d6f2n,
  0x987c8d5333ab86fde9926bd2ca6c674170a05bfe3bdd81ffd038da6c26c842642f64550fedfe935a15e4ca31870fb29n,
  0x9fc4018bd96684be88c9e221e4da1bb8f3abd16679dc26c1e8b6e6a1f20cabe69d65201c78607a360370e577bdba587n,
  0xe1bba7a1186bdb5223abde7ada14a23c42a0ca7915af6fe06985e7ed1e4d43b9b3f7055dd4eba6f2bafaaebca731c30n,
  0x19713e47937cd1be0dfd0b8f1d43fb93cd2fcbcb6caf493fd1183e416389e61031bf3a5cce3fbafce813711ad011c132n,
  0x18b46a908f36f6deb918c143fed2edcc523559b8aaf0c2462e6bfe7f911f643249d9cdf41b44d606ce07c8a4d0074d8en,
  0xb182cac101b9399d155096004f53f447aa7b12a3426b08ec02710e807b4633f06c851c1919211f20d4c04f00b971ef8n,
  0x245a394ad1eca9b72fc00ae7be315dc757b3b080d4c158013e6632d3c40659cc6cf90ad1c232a6442d9d3f5db980133n,
  0x5c129645e44cf1102a159f748c4a3fc5e673d81d7e86568d9ab0f5d396a7ce46ba1049b6579afb7866b1e715475224bn,
  0x15e6be4e990f03ce4ea50b3b42df2eb5cb181d8f84965a3957add4fa95af01b2b665027efec01c7704b456be69c8b604n,
];
const ISO_YDEN: readonly bigint[] = [
  0x16112c4c3a9c98b252181140fad0eae9601a6de578980be6eec3232b5be72e7a07f3688ef60c206d01479253b03663c1n,
  0x1962d75c2381201e1a0cbd6c43c348b885c84ff731c4d59ca4a10356f453e01f78a4260763529e3532f6102c2e49a03dn,
  0x58df3306640da276faaae7d6e8eb15778c4855551ae7f310c35a5dd279cd2eca6757cd636f96f891e2538b53dbf67f2n,
  0x16b7d288798e5395f20d23bf89edb4d1d115c5dbddbcd30e123da489e726af41727364f2c28297ada8d26d98445f5416n,
  0xbe0e079545f43e4b00cc912f8228ddcc6d19c9f0f69bbb0542eda0fc9dec916a20b15dc0fd2ededda39142311a5001dn,
  0x8d9e5297186db2d9fb266eaac783182b70152c65550d881c5ecd87b6f0f5a6449f38db9dfa9cce202c6477faaf9b7acn,
  0x166007c08a99db2fc3ba8734ace9824b5eecfdfa8d0cf8ef5dd365bc400a0051d5fa9c01a58b1fb93d1a1399126a775cn,
  0x16a3ef08be3ea7ea03bcddfabba6ff6ee5a4375efa1f4fd7feb34fd206357132b920f5b00801dee460ee415a15812ed9n,
  0x1866c8ed336c61231a1be54fd1d74cc4f9fb0ce4c6af5920abc5750c4bf39b4852cfe2f7bb9248836b233d9d55535d4an,
  0x167a55cda70a6e1cea820597d94a84903216f763e13d87bb5308592e7ea7d4fbc7385ea3d529b35e346ef48bb8913f55n,
  0x4d2f259eea405bd48f010a01ad2911d9c6dd039bb61a6290e591b36e636a5c871a5c29f4f83060400f8b49cba8f6aa8n,
  0xaccbb67481d033ff5852c1e48c50c477f94ff8aefce42d28c0f9a88cea7913516f968986f7ebbea9684b529e2561092n,
  0xad6b9514c767fe3c3613144b45f1496543346d98adf02267d5ceef9a00d9b8693000763e3b90ac11e99b138573345ccn,
  0x2660400eb2e4f3b628bdd0d53cd76f2bf565b94e72927c1cb748df27942480e420517bd8714cc80d1fadc1326ed06f7n,
  0xe0fa1d816ddc03e6b24255e0d7819c171c40f65e273b853324efcd6356caa205ca2f570f13497804415473a1d634b8fn,
  0x1n,
];
const SWU_A = 0x144698a3b8e9433d693a02c96d4982b0ea985383ee66a8d8e8981aefd881ac98936f8da0e0f97f5cf428082d584c1dn;
const SWU_B = 0x12e2908d11688030018b12e8753eee3b2016c1f0f24f4070a0b9c14fcef35ef55a23215a316ceaa5d1cc48e98e172be0n;

const SWU_Z = 11n;
const sqrtRatio = SWUFpSqrtRatio(Fp, Fp.create(SWU_Z));

/** sum_j c[j] a^j b^(d-j) (d = c.length - 1): the numerator of c(a/b) times b^d. bpow[k] = b^k. */
function homogeneous(c: readonly bigint[], a: bigint, bpow: readonly bigint[]): bigint {
  const d = c.length - 1;
  let acc = c[d]!;
  for (let j = d - 1; j >= 0; j--) acc = Fp.add(Fp.mul(acc, a), Fp.mul(c[j]!, bpow[d - j]!));
  return acc;
}

/**
 * map_to_curve(u) of RFC 9380 for BLS12-381 G1 (simplified SWU to E', then the 11-isogeny to E), WITHOUT the cofactor clearing: a point
 * of E(Fp), projective. The exceptional case of the isogeny (a zero denominator) is the identity (6.6.3).
 */
export function mapToG1Unclamped(uIn: bigint): G1Point {
  const u = Fp.create(uIn);
  const tv1 = Fp.mul(Fp.sqr(u), SWU_Z);
  let tv2 = Fp.add(Fp.sqr(tv1), tv1);
  const tv3 = Fp.mul(Fp.add(tv2, Fp.ONE), SWU_B);
  const tv4 = Fp.mul(tv2 !== 0n ? Fp.neg(tv2) : SWU_Z, SWU_A);
  const tv4sq = Fp.sqr(tv4);
  tv2 = Fp.add(Fp.sqr(tv3), Fp.mul(tv4sq, SWU_A));
  tv2 = Fp.mul(tv2, tv3);
  const tv6 = Fp.mul(tv4sq, tv4);
  tv2 = Fp.add(tv2, Fp.mul(tv6, SWU_B));
  let x = Fp.mul(tv1, tv3);
  const { isValid, value } = sqrtRatio(tv2, tv6);
  let y = Fp.mul(Fp.mul(tv1, u), value);
  if (isValid) {
    x = tv3;
    y = value;
  }
  // sgn0(u) == sgn0(y)
  if ((u & 1n) !== (y & 1n)) y = Fp.neg(y);
  // the point of E' is (x / tv4, y); evaluate the isogeny at a / b with a = x, b = tv4
  const b = tv4;
  const bpow: bigint[] = [1n];
  for (let k = 1; k <= 15; k++) bpow.push(Fp.mul(bpow[k - 1]!, b));
  const xn = homogeneous(ISO_XNUM, x, bpow);
  const xd = homogeneous(ISO_XDEN, x, bpow);
  const yn = homogeneous(ISO_YNUM, x, bpow);
  const yd = homogeneous(ISO_YDEN, x, bpow);
  // x_E = xn / (b * xd), y_E = y * yn / yd
  const bxd = Fp.mul(b, xd);
  const z = Fp.mul(bxd, yd);
  if (z === 0n) return G1P.ZERO;
  return new G1P(Fp.mul(xn, yd), Fp.mul(Fp.mul(y, yn), bxd), z);
}

/** hash_to_curve(m) of the scheme up to, and excluding, the cofactor clearing: map(u0) + map(u1). */
export function hashToG1Unclamped(msg: Uint8Array, dst: string): G1Point {
  const u = hash_to_field(msg, 2, { DST: dst, p: FIELD_P, m: 1, k: 128, expand: 'xmd', hash: sha256 });
  return mapToG1Unclamped(u[0]![0]!).add(mapToG1Unclamped(u[1]![0]!));
}

/** The cofactor clearing of G1 (multiplication by h_eff = 1 - x), noble's own. */
export const clearG1Cofactor = (p: G1Point): G1Point => p.clearCofactor();

/** The two sums of the random linear combination over the records of the job. */
export function combineBatch(job: CombineJob, tick?: () => void): CombineResult {
  const n = job.points.length;
  if (job.msgs.length !== n || job.scalars.length !== n || job.groups.length !== n) throw new RangeError('combineBatch: arrays differ in length');
  const hashPts: G1Point[] = new Array(n);
  for (let i = 0; i < n; i++) {
    hashPts[i] = hashToG1Unclamped(job.msgs[i]!, job.dst);
    tick?.();
  }
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

// ---- the plain-data form of the two jobs, for a worker thread (pool.ts) ----------------------------------------------------------------

/** Byte strings in ONE fresh buffer: structured clone copies a typed array's whole backing buffer, so views of a large evidence buffer are not sent. */
export interface Packed {
  data: Uint8Array;
  /** ends[i] is the end offset of string i in data */
  ends: Uint32Array;
}
export function pack(list: readonly Uint8Array[]): Packed {
  let total = 0;
  for (const b of list) total += b.length;
  const data = new Uint8Array(total);
  const ends = new Uint32Array(list.length);
  let o = 0;
  list.forEach((b, i) => {
    data.set(b, o);
    o += b.length;
    ends[i] = o;
  });
  return { data, ends };
}
export function unpack(p: Packed): Uint8Array[] {
  const out: Uint8Array[] = [];
  let o = 0;
  for (let i = 0; i < p.ends.length; i++) {
    out.push(p.data.subarray(o, p.ends[i]!));
    o = p.ends[i]!;
  }
  return out;
}

export type JobKind = 'decode' | 'combine';
export interface DecodeWire {
  sigs: Packed;
}
export interface DecodeResultWire {
  codes: Uint8Array;
  points: (Raw | undefined)[];
}
export interface CombineWire {
  points: Raw[];
  msgs: Packed;
  scalars: bigint[];
  groups: number[];
  dst: string;
}
export interface CombineResultWire {
  sumSig: Raw;
  sumHash: [number, Raw][];
  hashPts: Raw[];
}

/** Runs one wire job (what a worker does for each message). tick is called after each record. */
export function runWire(kind: string, job: unknown, tick: () => void): DecodeResultWire | CombineResultWire {
  if (kind === 'decode') {
    const r = decodeBatch({ sigs: unpack((job as DecodeWire).sigs) }, tick);
    return { codes: r.codes, points: r.points.map((p) => (p === undefined ? undefined : toRaw(p))) };
  }
  if (kind === 'combine') {
    const w = job as CombineWire;
    const r = combineBatch({ points: w.points.map(fromRaw), msgs: unpack(w.msgs), scalars: w.scalars, groups: w.groups, dst: w.dst }, tick);
    return { sumSig: toRaw(r.sumSig), sumHash: [...r.sumHash].map(([g, pt]): [number, Raw] => [g, toRaw(pt)]), hashPts: r.hashPts.map(toRaw) };
  }
  throw new RangeError(`unknown job kind ${kind}`);
}
