/** Signature verification (V2_SPEC_S7 5.8 O3): the gnark-exact decoders, the pairing, and the batched/one-by-one equivalence. */
import { bls12_381 } from '@noble/curves/bls12-381';
import { describe, expect, it } from 'vitest';
import {
  KeyCache,
  SignatureDST,
  decodeKey,
  decodeSignature,
  firstFailure,
  firstOneByOne,
  verifyOne,
  type Mode,
  type SigItem,
} from '../../../src/proof-v2/finality/adiri/index.js';
import { aggregateSign, concat, filled, hex, keyPair, pubKey } from './synth.js';

const P = bls12_381.fields.Fp.ORDER;
const be48 = (n: bigint): Uint8Array => Uint8Array.from({ length: 48 }, (_, i) => Number((n >> BigInt(8 * (47 - i))) & 0xffn));
const msgOf = (i: number): Uint8Array => concat(Uint8Array.of(1, 0, 1, 0x20), filled(32, i));
const cache = new KeyCache();
const entries = (nums: number[]) => nums.map((n) => cache.get(pubKey(n))!);

/** An item signed by `by` (key numbers) over message i and claimed for `claimed`. */
function item(epoch: number, claimed: number[], by: number[] = claimed, msgSeed = epoch): SigItem {
  return { epoch, sig: aggregateSign(by, msgOf(msgSeed)), signer: entries(claimed), msg: msgOf(msgSeed) };
}
const both = (items: SigItem[]): [ReturnType<typeof firstFailure>, ReturnType<typeof firstFailure>] => [firstFailure(items, 'oneByOne'), firstFailure(items, 'batched')];
const same = (items: SigItem[]): ReturnType<typeof firstFailure> => {
  const [a, b] = both(items);
  expect(b).toEqual(a);
  return a;
};

describe('the signature decoder is gnark-crypto SetBytes', () => {
  const good = aggregateSign([0], msgOf(0));

  it('accepts a valid compressed signature and reads the sign flag as the lexicographically largest y', () => {
    const d = decodeSignature(good);
    expect(d.reason).toBeUndefined();
    const flipped = Uint8Array.from(good);
    flipped[0]! ^= 0x20;
    const e = decodeSignature(flipped);
    expect(e.reason).toBeUndefined();
    expect(e.point!.equals(d.point!.negate())).toBe(true);
    expect(e.point!.equals(d.point!)).toBe(false);
    // the flag selects the root, the encoding of the point it produces is the input
    expect(hex(d.point!.toBytes(true))).toBe(hex(good));
    expect(hex(e.point!.toBytes(true))).toBe(hex(flipped));
  });

  it('a signature that is not 48 bytes is an encoding error', () => {
    expect(decodeSignature(good.subarray(0, 47)).reason).toBe('encoding');
    expect(decodeSignature(concat(good, Uint8Array.of(0))).reason).toBe('encoding');
    expect(decodeSignature(new Uint8Array(0)).reason).toBe('encoding');
  });

  it('every flag pattern other than 100, 101 and the clean 110 is an encoding error', () => {
    for (const flags of [0x00, 0x20, 0x40, 0x60, 0xe0]) {
      const b = Uint8Array.from(good);
      b[0] = (b[0]! & 0x1f) | flags;
      expect(decodeSignature(b).reason, `flags ${flags.toString(16)}`).toBe('encoding');
    }
  });

  it('the compressed identity is "identity" only when every other bit is zero', () => {
    expect(decodeSignature(Uint8Array.of(0xc0, ...new Uint8Array(47))).reason).toBe('identity');
    const low = new Uint8Array(48);
    low[0] = 0xc1;
    expect(decodeSignature(low).reason).toBe('encoding');
    for (const at of [1, 20, 47]) {
      const b = new Uint8Array(48);
      b[0] = 0xc0;
      b[at] = 1;
      expect(decodeSignature(b).reason, `byte ${at}`).toBe('encoding');
    }
  });

  it('a coordinate at or above the field modulus is an encoding error', () => {
    for (const x of [P, P + 1n, (1n << 381n) - 1n]) {
      const b = be48(x);
      b[0]! |= 0x80;
      expect(decodeSignature(b).reason, x.toString(16)).toBe('encoding');
    }
    const ok = be48(P - 1n);
    ok[0]! |= 0x80;
    // P-1 may or may not be on the curve, but it is never refused as non-canonical
    expect(['encoding', 'subgroup', undefined]).toContain(decodeSignature(ok).reason);
  });

  it('an x with no square root is an encoding error; a curve point outside the subgroup is "subgroup"', () => {
    let noRoot = -1n;
    let offGroup: Uint8Array | undefined;
    for (let x = 1n; x < 200n && (noRoot < 0n || offGroup === undefined); x++) {
      const y2 = bls12_381.fields.Fp.add(bls12_381.fields.Fp.mul(bls12_381.fields.Fp.mul(x, x), x), 4n);
      let root = true;
      try {
        bls12_381.fields.Fp.sqrt(y2);
      } catch {
        root = false;
      }
      const b = be48(x);
      b[0]! |= 0x80;
      if (!root && noRoot < 0n) {
        noRoot = x;
        expect(decodeSignature(b).reason).toBe('encoding');
      }
      if (root && offGroup === undefined) {
        const d = decodeSignature(b);
        if (d.reason === 'subgroup') offGroup = b;
      }
    }
    expect(noRoot).toBeGreaterThan(0n);
    expect(offGroup).toBeDefined();
    const b = Uint8Array.from(offGroup!);
    b[0]! |= 0xa0;
    expect(decodeSignature(b).reason).toBe('subgroup');
  });
});

describe('the key decoder', () => {
  const k = pubKey(0);
  it('accepts a compressed subgroup key and refuses everything else', () => {
    const p = decodeKey(k)!;
    expect(hex(p.toBytes(true))).toBe(hex(k));
    expect(decodeKey(k.subarray(0, 95))).toBeUndefined();
    expect(decodeKey(concat(k, Uint8Array.of(0)))).toBeUndefined();
    for (const flags of [0x00, 0x20, 0x40, 0x60, 0xc0, 0xe0]) {
      const b = Uint8Array.from(k);
      b[0] = (b[0]! & 0x1f) | flags;
      expect(decodeKey(b), `flags ${flags.toString(16)}`).toBeUndefined();
    }
    expect(decodeKey(Uint8Array.of(0xc0, ...new Uint8Array(95)))).toBeUndefined();
    for (const half of [0, 48]) {
      const b = Uint8Array.from(k);
      b.set(be48(P), half);
      b[0]! |= 0x80;
      expect(decodeKey(b), `half ${half}`).toBeUndefined();
    }
    const noRoot = Uint8Array.from(k);
    noRoot[95]! ^= 0x01;
    expect(decodeKey(noRoot)).toBeUndefined();
  });

  it('caches each distinct key once, refusals included, and numbers them', () => {
    const c = new KeyCache();
    const a = c.get(pubKey(1))!;
    const a2 = c.get(Uint8Array.from(pubKey(1)))!;
    expect(a2).toBe(a);
    const bad = Uint8Array.from(pubKey(2));
    bad[95]! ^= 0x01;
    expect(c.get(bad)).toBeUndefined();
    expect(c.get(Uint8Array.from(bad))).toBeUndefined();
    const b = c.get(pubKey(2))!;
    expect(c.decoded).toBe(3);
    expect(new Set([a.id, b.id]).size).toBe(2);
  });
});

describe('one record: the pairing equation', () => {
  it('accepts a signature of the whole signer set', () => {
    expect(verifyOne(item(0, [0, 1, 2]))).toBeUndefined();
    expect(verifyOne(item(0, [1]))).toBeUndefined();
    expect(verifyOne(item(3, [0, 2, 3, 4]))).toBeUndefined();
  });
  it('refuses a wrong message, a wrong or partial signer set, and an empty one', () => {
    const it0 = item(0, [0, 1, 2]);
    expect(verifyOne({ ...it0, msg: msgOf(9) })).toBe('pairing');
    expect(verifyOne(item(0, [0, 1, 2], [0, 1]))).toBe('pairing');
    expect(verifyOne(item(0, [0, 1], [0, 1, 2]))).toBe('pairing');
    expect(verifyOne(item(0, [0, 1, 2], [3]))).toBe('pairing');
    expect(verifyOne({ ...it0, signer: [] })).toBe('pairing');
  });
  it('reports decode reasons before the pairing', () => {
    const it0 = item(0, [0, 1]);
    expect(verifyOne({ ...it0, sig: Uint8Array.of(0xc0, ...new Uint8Array(47)) })).toBe('identity');
    expect(verifyOne({ ...it0, sig: filled(48, 0xff) })).toBe('encoding');
  });
  it('an aggregate key that is the identity is a failed pairing, not an exception', () => {
    const a = cache.get(pubKey(0))!;
    const minusA = { g2: a.g2.negate(), id: 1000 };
    const it0 = { epoch: 0, sig: aggregateSign([0], msgOf(0)), signer: [a, minusA], msg: msgOf(0) };
    expect(verifyOne(it0)).toBe('pairing');
    expect(firstFailure([it0], 'batched')).toEqual({ index: 0, reason: 'pairing' });
    expect(firstFailure([it0], 'oneByOne')).toEqual({ index: 0, reason: 'pairing' });
  });
});

describe('firstFailure: both modes name the lowest failing record', () => {
  const good = (n: number): SigItem[] => Array.from({ length: n }, (_, i) => item(i, [0, 1, 2, 3][i % 2 === 0 ? 0 : 1] === 0 ? [0, 1, 2] : [0, 1, 2, 3]));

  it('nothing fails when everything verifies, including no items at all', () => {
    expect(same([])).toBeUndefined();
    expect(same(good(1))).toBeUndefined();
    expect(same(good(4))).toBeUndefined();
  });

  it('a single bad record at every position is found at that position', () => {
    for (const n of [1, 2, 3, 5]) {
      for (let k = 0; k < n; k++) {
        const items = good(n);
        items[k] = { ...items[k]!, msg: msgOf(99) };
        expect(same(items), `n=${n} k=${k}`).toEqual({ index: k, reason: 'pairing' });
      }
    }
  });

  it('with several bad records the lowest is named', () => {
    const items = good(6);
    items[2] = { ...items[2]!, msg: msgOf(99) };
    items[4] = { ...items[4]!, msg: msgOf(98) };
    items[5] = { ...items[5]!, msg: msgOf(97) };
    expect(same(items)).toEqual({ index: 2, reason: 'pairing' });
    const upper = good(6);
    upper[3] = { ...upper[3]!, msg: msgOf(99) };
    upper[5] = { ...upper[5]!, msg: msgOf(98) };
    expect(same(upper)).toEqual({ index: 3, reason: 'pairing' });
  });

  it('a decode failure is a failure of its record, ordered with the pairing failures', () => {
    const idSig = Uint8Array.of(0xc0, ...new Uint8Array(47));
    const items = good(5);
    items[3] = { ...items[3]!, sig: idSig };
    expect(same(items)).toEqual({ index: 3, reason: 'identity' });
    const pairingFirst = good(5);
    pairingFirst[1] = { ...pairingFirst[1]!, msg: msgOf(99) };
    pairingFirst[3] = { ...pairingFirst[3]!, sig: idSig };
    expect(same(pairingFirst)).toEqual({ index: 1, reason: 'pairing' });
    const decodeFirst = good(5);
    decodeFirst[0] = { ...decodeFirst[0]!, sig: filled(48, 0xff) };
    decodeFirst[1] = { ...decodeFirst[1]!, msg: msgOf(99) };
    expect(same(decodeFirst)).toEqual({ index: 0, reason: 'encoding' });
    const emptySigners = good(3);
    emptySigners[2] = { ...emptySigners[2]!, signer: [] };
    expect(same(emptySigners)).toEqual({ index: 2, reason: 'pairing' });
  });

  it('a record whose signature is off the subgroup is "subgroup" in both modes', () => {
    let offGroup: Uint8Array | undefined;
    for (let x = 1n; x < 200n && offGroup === undefined; x++) {
      const b = be48(x);
      b[0]! |= 0x80;
      if (decodeSignature(b).reason === 'subgroup') offGroup = b;
    }
    const items = good(3);
    items[1] = { ...items[1]!, sig: offGroup! };
    expect(same(items)).toEqual({ index: 1, reason: 'subgroup' });
  });

  it('firstOneByOne is the reference: the first failing record in order', () => {
    const items = good(3);
    expect(firstOneByOne(items)).toBeUndefined();
    items[2] = { ...items[2]!, msg: msgOf(99) };
    expect(firstOneByOne(items)).toEqual({ index: 2, reason: 'pairing' });
  });

  it('two wrong signatures whose errors cancel are still refused: the scalars are random per record', () => {
    // sigma_0' = sigma_0 + d and sigma_1' = sigma_1 - d sum to the right total; an unweighted sum would accept the pair
    const delta = bls12_381.shortSignatures.hash(Uint8Array.of(7), SignatureDST).multiply(5n);
    const a = item(0, [0, 1, 2]);
    const b = item(1, [0, 1, 2]);
    const pt = (it0: SigItem) => decodeSignature(it0.sig).point!;
    const a2 = { ...a, sig: pt(a).add(delta).toBytes(true) };
    const b2 = { ...b, sig: pt(b).subtract(delta).toBytes(true) };
    expect(firstOneByOne([a2, b2])).toEqual({ index: 0, reason: 'pairing' });
    expect(firstFailure([a2, b2], 'batched')).toEqual({ index: 0, reason: 'pairing' });
    // the unmodified pair verifies
    expect(firstFailure([a, b], 'batched')).toBeUndefined();
  });

  it('the scalar source is injectable and a deterministic one gives the same verdicts', () => {
    let c = 1;
    const counter = (n: number): Uint8Array => {
      const out = new Uint8Array(n);
      out[n - 1] = (c++ % 250) + 1;
      return out;
    };
    const items = good(4);
    expect(firstFailure(items, 'batched', counter)).toBeUndefined();
    items[2] = { ...items[2]!, msg: msgOf(99) };
    expect(firstFailure(items, 'batched', counter)).toEqual({ index: 2, reason: 'pairing' });
  });

  it('keys numbered by the generator differ, so distinct signer lists are distinct groups', () => {
    expect(hex(keyPair(0).pk)).not.toBe(hex(keyPair(1).pk));
    const m: Mode = 'batched';
    // two records with different signer sets in one combination
    const items = [item(0, [0, 1, 2]), item(1, [1, 2, 3]), item(2, [0, 1, 2]), item(3, [1, 2, 3])];
    expect(firstFailure(items, m)).toBeUndefined();
    items[3] = { ...items[3]!, signer: entries([0, 2, 3]) };
    expect(firstFailure(items, m)).toEqual({ index: 3, reason: 'pairing' });
  });
});
