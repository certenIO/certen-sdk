import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bls12_381 } from '@noble/curves/bls12-381';
import { sha256 } from '@noble/hashes/sha2';
import { bytesToHex } from '@noble/hashes/utils';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  BYTES_PER_BLOB,
  EMBEDDED_KZG_SETUP_SHA256,
  FIELD_ELEMENTS_PER_BLOB,
  KzgContext,
  computeChallenge,
  decodeKzgG1,
  evaluateInEvaluationForm,
  loadKzgSetup,
  type KzgBlob,
} from '../../../src/proof-v2/finality/baseposted/kzg.js';
import { EMBEDDED_KZG_SETUP_TEXT } from '../../../src/proof-v2/finality/baseposted/kzg-setup-embedded.js';

const here = dirname(fileURLToPath(import.meta.url));
const SRC = join(here, '..', '..', '..', 'src', 'proof-v2', 'finality', 'baseposted');
const EVIDENCE = join(here, '..', '..', 'fixtures', 'finality', 'base_posted1', 'evidence');

const R = bls12_381.fields.Fr.ORDER;
const P = bls12_381.fields.Fp.ORDER;
const G1 = bls12_381.G1.Point;
const G2 = bls12_381.G2.Point;

// ---- a local reader of the blobs of a base-sepolia/l1_posted/v1 container (wire.go; independent of the port's wire codec) ----

function blobsOf(evidence: Uint8Array): KzgBlob[] {
  const dv = new DataView(evidence.buffer, evidence.byteOffset, evidence.byteLength);
  let o = 0;
  const u8 = (): number => evidence[o++]!;
  const u32 = (): number => {
    const v = dv.getUint32(o, false);
    o += 4;
    return v;
  };
  const skip = (n: number): void => {
    o += n;
  };
  const lp = (): Uint8Array => {
    const n = u32();
    const out = evidence.subarray(o, o + n);
    o += n;
    return out;
  };
  skip(4); // CFE1
  lp(); // kind
  skip(8 + 1 + 8 + 32); // chain, level, number, hash
  lp(); // LC profile
  skip(1 + 8 + 32); // anchor kind, period, root
  u8();
  lp(); // anchor body
  for (let n = u32(); n > 0; n--) {
    u8();
    lp();
  }
  u8();
  lp(); // final update
  for (let n = u32(); n > 0; n--) lp(); // spine
  skip(16); // channel id
  const out: KzgBlob[] = [];
  for (let f = u32(); f > 0; f--) {
    skip(8 + 4); // l1 block, tx index
    lp(); // tx
    for (let n = u32(); n > 0; n--) {
      const raw = lp();
      const commitment = evidence.subarray(o, o + 48);
      o += 48;
      const proof = evidence.subarray(o, o + 48);
      o += 48;
      out.push({ raw: Uint8Array.from(raw), commitment: Uint8Array.from(commitment), proof: Uint8Array.from(proof) });
    }
  }
  return out;
}

const evidenceA = readFileSync(join(EVIDENCE, 'valid_a.bin'));
const evidenceB = readFileSync(join(EVIDENCE, 'valid_b.bin'));
const clone = (b: KzgBlob): KzgBlob => ({ raw: Uint8Array.from(b.raw), commitment: Uint8Array.from(b.commitment), proof: Uint8Array.from(b.proof) });
const cloneAll = (bs: KzgBlob[]): KzgBlob[] => bs.map(clone);
const be32 = (v: bigint): Uint8Array => Uint8Array.from(v.toString(16).padStart(64, '0').match(/../g)!, (h) => parseInt(h, 16));

let ctx: KzgContext;
let blobsA: KzgBlob[];
let blobsB: KzgBlob[];
let setupMs = 0;

beforeAll(() => {
  const t0 = performance.now();
  ctx = loadKzgSetup(EMBEDDED_KZG_SETUP_SHA256);
  setupMs = performance.now() - t0;
  blobsA = blobsOf(evidenceA);
  blobsB = blobsOf(evidenceB);
});

describe('the embedded ceremony file', () => {
  it('is the pinned file: the JSON file, the embedded text and the pin are one', () => {
    const file = readFileSync(join(SRC, 'kzg-trusted-setup.json'));
    expect(bytesToHex(sha256(file))).toBe('f8e44a31ebf0a6d0734dcb301b0716e2c77f3ae18ed0cab0870fbcc2ca55616f');
    expect(EMBEDDED_KZG_SETUP_SHA256).toBe('f8e44a31ebf0a6d0734dcb301b0716e2c77f3ae18ed0cab0870fbcc2ca55616f');
    expect(Buffer.from(EMBEDDED_KZG_SETUP_TEXT, 'utf8').equals(file)).toBe(true);
    expect(file.includes(0x0d)).toBe(false);
  });

  it('a different pin is an error naming both hashes, never a different setup', () => {
    const other = '00'.repeat(32);
    expect(() => loadKzgSetup(other)).toThrow(new RegExp(`${EMBEDDED_KZG_SETUP_SHA256}.*${other}`));
    expect(() => loadKzgSetup(EMBEDDED_KZG_SETUP_SHA256.toUpperCase())).toThrow(/hashes to/);
    expect(() => loadKzgSetup('')).toThrow(/hashes to/);
  });

  it('is built once per pin', () => {
    expect(loadKzgSetup(EMBEDDED_KZG_SETUP_SHA256)).toBe(ctx);
  });

  it('refuses a file of another shape even under its own hash', () => {
    const doc = JSON.parse(EMBEDDED_KZG_SETUP_TEXT) as { g1_monomial: string[]; g1_lagrange: string[]; g2_monomial: string[] };
    const under = (d: unknown): KzgContext => {
      const text = JSON.stringify(d);
      return loadKzgSetup(bytesToHex(sha256(new TextEncoder().encode(text))), text);
    };
    expect(() => under({ ...doc, g1_monomial: doc.g1_monomial.slice(1) })).toThrow(/g1_monomial must hold 4096/);
    expect(() => under({ ...doc, g1_lagrange: doc.g1_lagrange.slice(1) })).toThrow(/g1_lagrange must hold 4096/);
    expect(() => under({ ...doc, g2_monomial: doc.g2_monomial.slice(1) })).toThrow(/g2_monomial must hold 65/);
    expect(() => under({ ...doc, g1_monomial: { length: 4096 } })).toThrow(/g1_monomial must hold 4096/);
    expect(() => under({ ...doc, g2_monomial: { length: 65 } })).toThrow(/g2_monomial must hold 65/);
    expect(() => under({ g1_monomial: doc.g1_monomial, g1_lagrange: doc.g1_lagrange })).toThrow(/g2_monomial must hold 65/);
    expect(() => under({ ...doc, g2_monomial: [doc.g2_monomial[1], ...doc.g2_monomial.slice(1)] })).toThrow(/not the G2 generator/);
    expect(() => under({ ...doc, g2_monomial: [doc.g2_monomial[0], doc.g2_monomial[1]!.toUpperCase().replace('0X', '0x'), ...doc.g2_monomial.slice(2)] })).toThrow(
      /lower-case hex/,
    );
    expect(() => under({ ...doc, g2_monomial: [doc.g2_monomial[0], 7, ...doc.g2_monomial.slice(2)] })).toThrow(/lower-case hex/);
    expect(() => under({ ...doc, g2_monomial: [doc.g2_monomial[0], [doc.g2_monomial[1]], ...doc.g2_monomial.slice(2)] })).toThrow(/lower-case hex/);
    expect(() => under({ ...doc, g2_monomial: [doc.g2_monomial[0], doc.g2_monomial[1]!.slice(0, -2), ...doc.g2_monomial.slice(2)] })).toThrow(/lower-case hex/);
    // the same file with an extra unknown key is the same setup: verification reads only the three arrays
    expect(under({ ...doc, comment: 'x' })).toBeInstanceOf(KzgContext);
  });
});

describe('real blobs (Base Sepolia channels posted as EIP-4844 blobs; the Go verifier accepts these evidences)', () => {
  it('extracts 6 and 7 blobs', () => {
    expect(blobsA.length).toBeGreaterThanOrEqual(6);
    expect(blobsB.length).toBeGreaterThanOrEqual(6);
    for (const b of [...blobsA, ...blobsB]) {
      expect(b.raw.length).toBe(BYTES_PER_BLOB);
      expect(b.commitment.length).toBe(48);
      expect(b.proof.length).toBe(48);
    }
  });

  it('every genuine blob verifies alone, and both evidences verify as batches and one by one', () => {
    for (const b of [...blobsA, ...blobsB]) expect(ctx.verifyBlob(b)).toBe(true);
    expect(ctx.verifyBlobs(blobsA)).toBe(-1);
    expect(ctx.verifyBlobs(blobsB)).toBe(-1);
    expect(ctx.verifyBlobsOneByOne(blobsA)).toBe(-1);
    // the batched equation ALONE accepts them (verifyBlobs falls back to single checks when it does not, which would hide a broken batch)
    expect(ctx.verifyBatchOnly(blobsA)).toBe(true);
    expect(ctx.verifyBatchOnly(blobsB)).toBe(true);
    expect(ctx.verifyBatchOnly([])).toBe(true);
    expect(ctx.verifyBlobsOneByOne(blobsB)).toBe(-1);
    expect(ctx.verifyBlobs([])).toBe(-1);
    expect(ctx.verifyBlobs([blobsA[0]!])).toBe(-1);
  });

  it('a blob under another blob\'s commitment or proof is invalid', () => {
    const a = blobsA[0]!;
    const b = blobsA[1]!;
    expect(ctx.verifyBlob({ raw: a.raw, commitment: b.commitment, proof: a.proof })).toBe(false);
    expect(ctx.verifyBlob({ raw: a.raw, commitment: a.commitment, proof: b.proof })).toBe(false);
    expect(ctx.verifyBlob({ raw: b.raw, commitment: a.commitment, proof: a.proof })).toBe(false);
  });

  /** A bad blob among 6 or 7: the batch names exactly the index the one-by-one check names. */
  const cases: { name: string; at: number; mutate: (set: KzgBlob[], i: number) => void }[] = [];
  for (const at of [0, 3, 5]) {
    cases.push(
      { name: 'one bit of an interior field element', at, mutate: (s, i) => (s[i]!.raw[1000 * 32 + 31]! ^= 0x01) },
      { name: 'the first byte of the blob (bit 0, still below the modulus)', at, mutate: (s, i) => (s[i]!.raw[1]! ^= 0x01) },
      { name: 'the last byte of the blob', at, mutate: (s, i) => (s[i]!.raw[BYTES_PER_BLOB - 1]! ^= 0x80 >> 7) },
      { name: 'the commitment replaced by another blob\'s', at, mutate: (s, i) => (s[i]!.commitment = Uint8Array.from(s[(i + 1) % s.length]!.commitment)) },
      { name: 'the proof replaced by another blob\'s', at, mutate: (s, i) => (s[i]!.proof = Uint8Array.from(s[(i + 1) % s.length]!.proof)) },
      { name: 'the commitment one bit flipped', at, mutate: (s, i) => (s[i]!.commitment[40]! ^= 0x01) },
      { name: 'the proof one bit flipped', at, mutate: (s, i) => (s[i]!.proof[47]! ^= 0x01) },
      { name: 'the commitment the identity', at, mutate: (s, i) => (s[i]!.commitment = Uint8Array.from([0xc0, ...new Array(47).fill(0)])) },
      { name: 'the proof the identity', at, mutate: (s, i) => (s[i]!.proof = Uint8Array.from([0xc0, ...new Array(47).fill(0)])) },
    );
  }
  for (const c of cases) {
    it(`${c.name} in blob ${c.at}: the batch names blob ${c.at}`, () => {
      const set = cloneAll(blobsA);
      c.mutate(set, c.at);
      expect(ctx.verifyBlobsOneByOne(set)).toBe(c.at);
      expect(ctx.verifyBlobs(set)).toBe(c.at);
      expect(ctx.verifyBlob(set[c.at]!)).toBe(false);
      expect(ctx.verifyBatchOnly(set)).toBe(false);
    });
  }

  it('errors that cancel in an unweighted sum are caught by the weighted batch: proofs moved by +D and -D', () => {
    const set = cloneAll(blobsA);
    const D = G1.BASE.multiply(12345n);
    set[0]!.proof = decodeKzgG1(blobsA[0]!.proof).add(D).toBytes(true);
    set[1]!.proof = decodeKzgG1(blobsA[1]!.proof).subtract(D).toBytes(true);
    expect(ctx.verifyBatchOnly(set)).toBe(false);
    expect(ctx.verifyBlobs(set)).toBe(0);
    expect(ctx.verifyBlobsOneByOne(set)).toBe(0);
    // commitments moved by +D and -D with the identity of the sum kept
    const set2 = cloneAll(blobsA);
    set2[2]!.commitment = decodeKzgG1(blobsA[2]!.commitment).add(D).toBytes(true);
    set2[3]!.commitment = decodeKzgG1(blobsA[3]!.commitment).subtract(D).toBytes(true);
    expect(ctx.verifyBatchOnly(set2)).toBe(false);
    expect(ctx.verifyBlobs(set2)).toBe(2);
  });

  it('two bad blobs: the first in order is named, whichever fails in which way', () => {
    const set = cloneAll(blobsB);
    set[4]!.raw[2000 * 32 + 5]! ^= 0x01; // pairing failure
    set[2]!.commitment[47]! ^= 0x01; // pairing failure or undecodable point
    expect(ctx.verifyBlobs(set)).toBe(2);
    const set2 = cloneAll(blobsB);
    set2[4]!.raw[2000 * 32 + 5]! ^= 0x01;
    set2[1]!.raw.set(be32(R), 12 * 32); // not a field element: does not even prepare
    expect(ctx.verifyBlobs(set2)).toBe(1);
    const set3 = cloneAll(blobsB);
    set3[1]!.raw[2000 * 32 + 5]! ^= 0x01; // pairing failure BEFORE an unpreparable blob
    set3[3]!.raw.set(be32(R), 12 * 32);
    expect(ctx.verifyBlobs(set3)).toBe(1);
    expect(ctx.verifyBlobsOneByOne(set3)).toBe(1);
    const set4 = cloneAll(blobsB);
    set4[3]!.raw.set(be32(R), 12 * 32); // only an unpreparable blob, all earlier ones valid
    expect(ctx.verifyBlobs(set4)).toBe(3);
  });

  it('a field element at or above the modulus is refused, the largest valid one is only a different blob', () => {
    const b = clone(blobsA[0]!);
    const at = 77 * 32;
    const keep = Uint8Array.from(b.raw.subarray(at, at + 32));
    for (const bad of [R, R + 1n, (1n << 256n) - 1n]) {
      b.raw.set(be32(bad), at);
      expect(ctx.verifyBlob(b)).toBe(false);
    }
    b.raw.set(be32(R - 1n), at); // a valid element: prepares, and fails the pairing
    expect(ctx.verifyBlob(b)).toBe(false);
    b.raw.set(keep, at);
    expect(ctx.verifyBlob(b)).toBe(true);
  });

  it('Node Buffers (views into a larger buffer) are judged without being modified', () => {
    const a = blobsA[0]!;
    const backing = Buffer.concat([Buffer.alloc(3), Buffer.from(a.commitment), Buffer.alloc(5), Buffer.from(a.proof)]);
    const commitment = backing.subarray(3, 51);
    const proof = backing.subarray(56, 104);
    const before = Buffer.from(backing);
    expect(ctx.verifyBlob({ raw: Buffer.from(a.raw), commitment, proof })).toBe(true);
    expect(ctx.verifyBlobs([{ raw: Buffer.from(a.raw), commitment, proof }])).toBe(-1);
    expect(backing.equals(before)).toBe(true);
  });

  it('a blob of any length but 131072 is refused', () => {
    const a = blobsA[0]!;
    expect(ctx.verifyBlob({ ...a, raw: a.raw.subarray(0, BYTES_PER_BLOB - 1) })).toBe(false);
    expect(ctx.verifyBlob({ ...a, raw: new Uint8Array(BYTES_PER_BLOB + 1) })).toBe(false);
    expect(ctx.verifyBlob({ ...a, raw: new Uint8Array(0) })).toBe(false);
    expect(ctx.verifyBlobs([a, { ...a, raw: a.raw.subarray(0, BYTES_PER_BLOB - 32) }])).toBe(1);
  });
});

describe('known answers that need no ceremony point', () => {
  const infinity = Uint8Array.from([0xc0, ...new Array(47).fill(0)]);
  const constantBlob = (c: bigint): Uint8Array => {
    const raw = new Uint8Array(BYTES_PER_BLOB);
    for (let i = 0; i < FIELD_ELEMENTS_PER_BLOB; i++) raw.set(be32(c), i * 32);
    return raw;
  };

  it('the zero blob with the identity commitment and the identity proof is valid (an official EIP-4844 case)', () => {
    expect(ctx.verifyBlob({ raw: new Uint8Array(BYTES_PER_BLOB), commitment: infinity, proof: infinity })).toBe(true);
    expect(ctx.verifyBlobs([{ raw: new Uint8Array(BYTES_PER_BLOB), commitment: infinity, proof: infinity }])).toBe(-1);
  });

  it('a constant polynomial c is committed to by [c]G1 with the identity proof (checks the barycentric evaluation and the domain)', () => {
    for (const c of [1n, 5n, 123456789123456789n, R - 1n]) {
      const commitment = G1.BASE.multiply(c).toBytes(true);
      expect(ctx.verifyBlob({ raw: constantBlob(c), commitment, proof: infinity })).toBe(true);
      // the same blob under the wrong commitment, or with a proof that is not the identity, fails
      expect(ctx.verifyBlob({ raw: constantBlob(c), commitment: G1.BASE.multiply(c === 1n ? 2n : c - 1n).toBytes(true), proof: infinity })).toBe(false);
      expect(ctx.verifyBlob({ raw: constantBlob(c), commitment, proof: G1.BASE.toBytes(true) })).toBe(false);
    }
    expect(ctx.verifyBlob({ raw: constantBlob(5n), commitment: infinity, proof: infinity })).toBe(false);
    expect(ctx.verifyBlob({ raw: new Uint8Array(BYTES_PER_BLOB), commitment: G1.BASE.toBytes(true), proof: infinity })).toBe(false);
    expect(ctx.verifyBlob({ raw: new Uint8Array(BYTES_PER_BLOB), commitment: infinity, proof: G1.BASE.toBytes(true) })).toBe(false);
    // several constant blobs in one batch, one wrong
    const good = (c: bigint): KzgBlob => ({ raw: constantBlob(c), commitment: G1.BASE.multiply(c).toBytes(true), proof: infinity });
    expect(ctx.verifyBlobs([good(2n), good(3n), good(4n)])).toBe(-1);
    expect(ctx.verifyBlobs([good(2n), { ...good(3n), commitment: G1.BASE.multiply(4n).toBytes(true) }, good(4n)])).toBe(1);
  });
});

describe('point decoding of commitments and proofs', () => {
  /** the compressed encoding of the affine point (x, y) of E: y^2 = x^3 + 4 */
  const compress = (x: bigint, y: bigint): Uint8Array => {
    const b = be48(x);
    b[0]! |= y > (P - 1n) / 2n ? 0xa0 : 0x80;
    return b;
  };
  const be48 = (v: bigint): Uint8Array => Uint8Array.from(v.toString(16).padStart(96, '0').match(/../g)!, (h) => parseInt(h, 16));
  const infinity = Uint8Array.from([0xc0, ...new Array(47).fill(0)]);

  it('accepts the identity and the generator, refuses every malformation', () => {
    expect(decodeKzgG1(infinity).is0()).toBe(true);
    expect(decodeKzgG1(G1.BASE.toBytes(true)).equals(G1.BASE)).toBe(true);
    const badInf = Uint8Array.from(infinity);
    badInf[47] = 1;
    expect(() => decodeKzgG1(badInf)).toThrow(/malformed infinity/);
    const badInf2 = Uint8Array.from(infinity);
    badInf2[0] = 0xc1; // a coordinate bit under the infinity flags
    expect(() => decodeKzgG1(badInf2)).toThrow(/malformed infinity/);
    const badInf3 = Uint8Array.from(infinity);
    badInf3[20] = 0x80;
    const badInf4 = Uint8Array.from(infinity);
    badInf4[1] = 1; // the byte right after the flags
    expect(() => decodeKzgG1(badInf4)).toThrow(/malformed infinity/);
    expect(() => decodeKzgG1(badInf3)).toThrow(/malformed infinity/);
    expect(() => decodeKzgG1(infinity.subarray(0, 47))).toThrow(/48 bytes/);
    expect(() => decodeKzgG1(new Uint8Array(49))).toThrow(/48 bytes/);
    expect(() => decodeKzgG1(new Uint8Array(48))).toThrow(/finite compressed/); // uncompressed flag pattern 000
    const gen = G1.BASE.toBytes(true);
    for (const flags of [0x00, 0x20, 0x40, 0x60, 0xe0]) {
      const x = Uint8Array.from(gen);
      x[0] = (x[0]! & 0x1f) | flags;
      expect(() => decodeKzgG1(x)).toThrow(/finite compressed/);
    }
    // x at or above the field modulus is not canonical (the boundary included), whatever x mod p is
    for (const x of [P, P + 1n, (1n << 381n) - 1n]) {
      const over = be48(x);
      over[0]! |= 0x80;
      expect(() => decodeKzgG1(over)).toThrow(/non-canonical/);
    }
    const under = be48(P - 1n);
    under[0]! |= 0x80;
    expect(() => decodeKzgG1(under)).not.toThrow(/non-canonical/);
  });

  it('refuses a point off the curve and a point on the curve outside the prime-order subgroup', () => {
    const Fp = bls12_381.fields.Fp;
    let offCurve: Uint8Array | undefined;
    let outside: Uint8Array | undefined;
    for (let x = 1n; x < 400n && (offCurve === undefined || outside === undefined); x++) {
      const rhs = Fp.add(Fp.mul(Fp.mul(x, x), x), 4n);
      let y: bigint | undefined;
      try {
        y = Fp.sqrt(rhs);
      } catch {
        y = undefined;
      }
      if (y === undefined || Fp.sqr(y) !== rhs) {
        offCurve ??= compress(x, 1n);
        continue;
      }
      const pt = G1.fromAffine({ x, y });
      if (!pt.isTorsionFree()) outside ??= compress(x, y);
    }
    expect(offCurve).toBeDefined();
    expect(outside).toBeDefined();
    expect(() => decodeKzgG1(offCurve!)).toThrow();
    expect(() => decodeKzgG1(outside!)).toThrow();
    const blob = blobsA[0]!;
    expect(ctx.verifyBlob({ ...blob, commitment: outside! })).toBe(false);
    expect(ctx.verifyBlob({ ...blob, proof: outside! })).toBe(false);
    expect(ctx.verifyBlob({ ...blob, commitment: offCurve! })).toBe(false);
    expect(ctx.verifyBlobs([blobsA[0]!, { ...blob, proof: outside! }])).toBe(1);
  });
});

const modpow = (b: bigint, e: bigint, m: bigint): bigint => {
  let r = 1n;
  for (b %= m; e > 0n; e >>= 1n, b = (b * b) % m) if (e & 1n) r = (r * b) % m;
  return r;
};
const inv = (v: bigint): bigint => modpow(v, R - 2n, R);

/** the 4096 roots of unity in bit-reversal order, as the specification defines them */
function bitReversedRoots(): bigint[] {
  const w = modpow(7n, (R - 1n) / 4096n, R);
  const natural: bigint[] = [1n];
  for (let i = 1; i < 4096; i++) natural.push((natural[i - 1]! * w) % R);
  return natural.map((_, i) => {
    let rev = 0;
    for (let b = 0; b < 12; b++) if (i & (1 << b)) rev |= 1 << (11 - b);
    return natural[rev]!;
  });
}

describe('evaluation of a polynomial given on the bit-reversed domain', () => {
  const roots = bitReversedRoots();
  const at = (f: (x: bigint) => bigint): bigint[] => roots.map(f);
  const z = 0x1234567890abcdef1234567890abcdefn;

  it('reproduces polynomials of low degree away from the domain (barycentric formula, the z^4096-1 factor and the 1/4096 width)', () => {
    expect(evaluateInEvaluationForm(at(() => 9n), z)).toBe(9n);
    expect(evaluateInEvaluationForm(at((x) => x), z)).toBe(z);
    expect(evaluateInEvaluationForm(at((x) => (x * x) % R), z)).toBe((z * z) % R);
    expect(evaluateInEvaluationForm(at((x) => (modpow(x, 5n, R) + 3n * x + 1n) % R), z)).toBe((modpow(z, 5n, R) + 3n * z + 1n) % R);
    expect(evaluateInEvaluationForm(at((x) => (x * x) % R), R - 1n)).toBe(1n);
    expect(evaluateInEvaluationForm(at(() => 0n), z)).toBe(0n);
  });

  it('inside the domain it returns the stored value at that index', () => {
    const poly = roots.map((_, i) => BigInt(i * i + 7));
    for (const k of [0, 1, 17, 2048, 4095]) expect(evaluateInEvaluationForm(poly, roots[k]!)).toBe(poly[k]);
    // the order is bit-reversed: root 1 (index 0) and root -1 (index 1)
    expect(roots[0]).toBe(1n);
    expect(roots[1]).toBe(R - 1n);
  });
});

describe('a setup with a KNOWN tau: blobs and proofs built here, to judge the batch and the verdict structure', () => {
  const tau = 424242424242424242n;
  const infinity = Uint8Array.from([0xc0, ...new Array(47).fill(0)]);
  const hex = (p: { toBytes(c: boolean): Uint8Array }): string => `0x${bytesToHex(p.toBytes(true))}`;
  const dummy = (n: number): string[] => new Array<string>(n).fill('0x00');
  const settext = JSON.stringify({ g1_monomial: dummy(4096), g1_lagrange: dummy(4096), g2_monomial: [hex(G2.BASE), hex(G2.BASE.multiply(tau)), ...dummy(63)] });
  const kctx = loadKzgSetup(bytesToHex(sha256(new TextEncoder().encode(settext))), settext);

  function makeBlob(poly: bigint[], patch?: (raw: Uint8Array) => void): { blob: KzgBlob; z: bigint } {
    const raw = new Uint8Array(BYTES_PER_BLOB);
    poly.forEach((v, i) => raw.set(be32(v), i * 32));
    patch?.(raw); // the commitment is of POLY; the challenge is of the patched bytes
    const pTau = evaluateInEvaluationForm(poly, tau);
    const commitment = G1.BASE.multiply(pTau).toBytes(true);
    const z = computeChallenge(raw, commitment);
    const y = evaluateInEvaluationForm(poly, z);
    const q = (((pTau - y + R) % R) * inv((tau - z + R) % R)) % R;
    return { blob: { raw, commitment, proof: q === 0n ? infinity : G1.BASE.multiply(q).toBytes(true) }, z };
  }
  const polyOf = (k: number): bigint[] => Array.from({ length: 4096 }, (_, i) => (BigInt(k + 1) * BigInt(i + 3) ** 3n + 11n * BigInt(k)) % R);
  const made = [0, 1, 2, 3].map((k) => makeBlob(polyOf(k)));
  const good = made.map((m) => m.blob);

  it('genuine blobs of this setup verify alone, as a batch and one by one; the real setup rejects them', () => {
    for (const b of good) {
      expect(kctx.verifyBlob(b)).toBe(true);
      expect(ctx.verifyBlob(b)).toBe(false);
    }
    expect(kctx.verifyBatchOnly(good)).toBe(true);
    expect(kctx.verifyBlobs(good)).toBe(-1);
    expect(ctx.verifyBlobs(good)).toBe(0);
  });

  it('the weights of the batch matter: proof errors that CANCEL in an unweighted sum are rejected', () => {
    const [z0, z1] = [made[0]!.z, made[1]!.z];
    const a = 777n;
    // e(D_i, [z_i - tau]G2) multiply to one when a (z0 - tau) + b (z1 - tau) = 0
    const b = (((R - a) * ((z0 - tau + R) % R)) % R) * inv((z1 - tau + R) % R) % R;
    const set = cloneAll(good);
    set[0]!.proof = decodeKzgG1(good[0]!.proof).add(G1.BASE.multiply(a)).toBytes(true);
    set[1]!.proof = decodeKzgG1(good[1]!.proof).add(G1.BASE.multiply(b)).toBytes(true);
    expect(kctx.verifyBlob(set[0]!)).toBe(false);
    expect(kctx.verifyBlob(set[1]!)).toBe(false);
    expect(kctx.verifyBatchOnly(set)).toBe(false);
    expect(kctx.verifyBlobs(set)).toBe(0);
    expect(kctx.verifyBlobsOneByOne(set)).toBe(0);
  });

  it('a polynomial whose evaluation at z is zero and one whose proof is the identity are judged like any other', () => {
    const constant = makeBlob(Array.from({ length: 4096 }, () => 5n)).blob;
    expect(constant.proof).toEqual(infinity);
    expect(kctx.verifyBlob(constant)).toBe(true);
    expect(kctx.verifyBatchOnly([constant, good[0]!, constant])).toBe(true);
  });

  it('a field element equal to the modulus is refused although its residue (zero) would verify: the boundary belongs to the decoder, not to the pairing', () => {
    const poly = polyOf(1);
    poly[7] = 0n;
    const control = makeBlob(poly).blob;
    expect(kctx.verifyBlob(control)).toBe(true);
    const aliased = makeBlob(poly, (raw) => raw.set(be32(R), 7 * 32)).blob;
    expect(kctx.verifyBlob(aliased)).toBe(false);
    expect(kctx.verifyBlobs([control, aliased])).toBe(1);
    expect(kctx.verifyBatchOnly([control, aliased])).toBe(false);
  });

  it('refuses a setup point whose second coordinate is a non-canonical alias of a valid point', () => {
    let alias: string | undefined;
    for (let t = 2n; t < 40n && alias === undefined; t++) {
      const bytes = G2.BASE.multiply(t).toBytes(true);
      const c0 = BigInt(`0x${bytesToHex(bytes.subarray(48))}`);
      if (c0 + P < 1n << 384n) alias = `0x${bytesToHex(bytes.subarray(0, 48))}${(c0 + P).toString(16).padStart(96, '0')}`;
    }
    expect(alias).toBeDefined();
    const text = JSON.stringify({ g1_monomial: dummy(4096), g1_lagrange: dummy(4096), g2_monomial: [hex(G2.BASE), alias, ...dummy(63)] });
    expect(() => loadKzgSetup(bytesToHex(sha256(new TextEncoder().encode(text))), text)).toThrow(/non-canonical/);
  });
});

describe('timings (informational)', () => {
  it('measures the setup, one blob and a whole evidence', () => {
    const t0 = performance.now();
    for (const b of blobsA) expect(ctx.verifyBlob(b)).toBe(true);
    const oneByOne = performance.now() - t0;
    const t1 = performance.now();
    expect(ctx.verifyBlobs(blobsA)).toBe(-1);
    const batched = performance.now() - t1;
    const per: number[] = [];
    for (const b of blobsA) {
      const s = performance.now();
      ctx.verifyBlob(b);
      per.push(performance.now() - s);
    }
    per.sort((x, y) => x - y);
    console.log(
      `KZG timings: setup load ${setupMs.toFixed(0)} ms; ${blobsA.length} blobs one by one ${oneByOne.toFixed(0)} ms; batched ${batched.toFixed(0)} ms; ` +
        `per blob median ${per[Math.floor(per.length / 2)]!.toFixed(0)} ms (min ${per[0]!.toFixed(0)}, max ${per[per.length - 1]!.toFixed(0)})`,
    );
    expect(batched).toBeGreaterThan(0);
  });
});
