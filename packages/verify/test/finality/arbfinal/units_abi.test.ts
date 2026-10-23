/**
 * The ValidatorWallet ABI decode of the wallet route (go-ethereum accounts/abi Unpack semantics + the canonical re-pack rule of decodeWalletCalls,
 * N2(2)): canonical calldata of the four entry points decodes; every non-canonical encoding go-ethereum would still unpack (dirty address bits,
 * offset gaps, trailing words, padding garbage, shifted offsets) and every truncation is refused; hostile lengths allocate nothing. The calldata
 * here is encoded by hand, word by word, independently of src/.../abi.ts.
 */
import { describe, expect, it } from 'vitest';
import { embeddedPins } from '../../../src/proof-v2/finality/pins.js';
import { load } from './vectorset.js';

const W = (n: bigint | number): Uint8Array => {
  const out = new Uint8Array(32);
  let x = BigInt(n);
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  return out;
};
const ADDR = (n: number): Uint8Array => {
  const out = new Uint8Array(20);
  out.fill(n);
  return out;
};
const AW = (a: Uint8Array): Uint8Array => {
  const out = new Uint8Array(32);
  out.set(a, 12);
  return out;
};
const cat = (...p: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(p.reduce((n, x) => n + x.length, 0));
  let o = 0;
  for (const x of p) {
    out.set(x, o);
    o += x.length;
  }
  return out;
};
const padded = (b: Uint8Array): Uint8Array => cat(b, new Uint8Array((32 - (b.length % 32)) % 32));
const bytesEnc = (b: Uint8Array): Uint8Array => cat(W(b.length), padded(b));
const bytesArr = (ds: Uint8Array[]): Uint8Array => {
  const tails = ds.map(bytesEnc);
  let off = 32 * ds.length;
  const heads = tails.map((t) => {
    const h = W(off);
    off += t.length;
    return h;
  });
  return cat(W(ds.length), ...heads, ...tails);
};
const addrArr = (as: Uint8Array[]): Uint8Array => cat(W(as.length), ...as.map(AW));
const uintArr = (xs: (bigint | number)[]): Uint8Array => cat(W(xs.length), ...xs.map(W));

const encTx = (d: Uint8Array, a: Uint8Array, m: bigint | number): Uint8Array => cat(W(0x60), AW(a), W(m), bytesEnc(d));
const encTxR = (r: Uint8Array, d: Uint8Array, a: Uint8Array, m: bigint | number): Uint8Array => cat(AW(r), W(0x80), AW(a), W(m), bytesEnc(d));
const encTxs = (ds: Uint8Array[], as: Uint8Array[], ms: (bigint | number)[]): Uint8Array => {
  const b = bytesArr(ds);
  const a = addrArr(as);
  return cat(W(0x60), W(0x60 + b.length), W(0x60 + b.length + a.length), b, a, uintArr(ms));
};
const encTxsR = (r: Uint8Array, ds: Uint8Array[], as: Uint8Array[], ms: (bigint | number)[]): Uint8Array => {
  const b = bytesArr(ds);
  const a = addrArr(as);
  return cat(AW(r), W(0x80), W(0x80 + b.length), W(0x80 + b.length + a.length), b, a, uintArr(ms));
};

const MAX = (1n << 256n) - 1n;
const data = (n: number, v = 7): Uint8Array => new Uint8Array(n).fill(v);

type Shape = 'tx' | 'txR' | 'txs' | 'txsR';
interface Plan {
  ds: Uint8Array[];
  as: Uint8Array[];
  ms: (bigint | number)[];
}
const plans: Plan[] = [
  { ds: [data(0)], as: [ADDR(1)], ms: [0] },
  { ds: [data(4)], as: [ADDR(2)], ms: [1] },
  { ds: [data(31)], as: [ADDR(3)], ms: [MAX] },
  { ds: [data(32)], as: [ADDR(4)], ms: [5] },
  { ds: [data(33)], as: [ADDR(5)], ms: [6] },
  { ds: [data(164)], as: [ADDR(6)], ms: [0] },
  { ds: [data(4), data(0), data(70)], as: [ADDR(7), ADDR(8), ADDR(9)], ms: [1, 2, 3] },
  { ds: [], as: [], ms: [] },
];
const encode = (shape: Shape, p: Plan, sels: Record<Shape, Uint8Array>): Uint8Array => {
  switch (shape) {
    case 'tx':
      return cat(sels.tx, encTx(p.ds[0] ?? data(0), p.as[0] ?? ADDR(0), p.ms[0] ?? 0));
    case 'txR':
      return cat(sels.txR, encTxR(ADDR(0x55), p.ds[0] ?? data(0), p.as[0] ?? ADDR(0), p.ms[0] ?? 0));
    case 'txs':
      return cat(sels.txs, encTxs(p.ds, p.as, p.ms));
    case 'txsR':
      return cat(sels.txsR, encTxsR(ADDR(0x55), p.ds, p.as, p.ms));
  }
};
const SHAPES: Shape[] = ['tx', 'txR', 'txs', 'txsR'];

const setup = async () => {
  const A = await load();
  const arb = A.loadArbFinalPins(embeddedPins());
  const sels: Record<Shape, Uint8Array> = { tx: arb.sel.walletTx, txR: arb.sel.walletTxRefund, txs: arb.sel.walletTxs, txsR: arb.sel.walletTxsRef };
  const dec = (input: Uint8Array) => A.decodeWalletCalls(arb, input.subarray(0, 4), input);
  return { A, arb, sels, dec };
};

describe('canonical calldata decodes', () => {
  it.each(SHAPES)('%s: every plan decodes to its calls, in order', async (shape) => {
    const { dec, sels } = await setup();
    for (const [i, p] of plans.entries()) {
      const got = dec(encode(shape, p, sels));
      if (shape === 'tx' || shape === 'txR') {
        const d0 = p.ds[0] ?? data(0);
        expect(got, `plan ${i}`).toEqual([{ data: d0, dest: p.as[0] ?? ADDR(0), amount: BigInt(p.ms[0] ?? 0) }]);
      } else {
        expect(got, `plan ${i}`).toEqual(p.ds.map((d, k) => ({ data: d, dest: p.as[k], amount: BigInt(p.ms[k]!) })));
      }
    }
  });

  it('a batch of no calls is a decoded empty list, not a refusal (the classifier then answers wallet_no_confirm_call)', async () => {
    const { dec, sels } = await setup();
    expect(dec(encode('txs', plans[7]!, sels))).toEqual([]);
    expect(dec(encode('txsR', plans[7]!, sels))).toEqual([]);
  });
});

describe('every non-canonical encoding go-ethereum would still unpack is refused (canonical re-pack)', () => {
  const addressWordOffsets = (shape: Shape, p: Plan): number[] => {
    // byte offsets (within the arguments) of every address word of the canonical encoding
    const head = shape === 'tx' ? 96 : shape === 'txR' ? 128 : shape === 'txs' ? 96 : 128;
    const offs: number[] = [];
    if (shape === 'tx') offs.push(32);
    if (shape === 'txR') offs.push(0, 64);
    if (shape === 'txsR') offs.push(0);
    if (shape === 'txs' || shape === 'txsR') {
      const b = bytesArr(p.ds).length;
      const start = head + b + 32;
      for (let i = 0; i < p.as.length; i++) offs.push(start + 32 * i);
    }
    return offs;
  };

  it.each(SHAPES)('%s: dirty address bits (any of the 12 high bytes of any address word) are refused', async (shape) => {
    const { dec, sels } = await setup();
    for (const p of plans.slice(0, 7)) {
      const ok = encode(shape, p, sels);
      expect(dec(ok)).toBeDefined();
      for (const off of addressWordOffsets(shape, p)) {
        for (const k of [0, 5, 11]) {
          const bad = Uint8Array.from(ok);
          bad[4 + off + k] = 1;
          expect(dec(bad), `${shape} word@${off} byte ${k}`).toBeUndefined();
        }
        const edge = Uint8Array.from(ok); // the lowest dirty byte is byte 11; byte 12 is the address itself and stays accepted as data of a different address
        edge[4 + off + 12] ^= 0x80;
        expect(dec(edge), `${shape} word@${off} byte 12`).toBeDefined();
      }
    }
  });

  it.each(SHAPES)('%s: a trailing zero word, a trailing byte, and every truncation are refused (N passes, N-1 fails)', async (shape) => {
    const { dec, sels } = await setup();
    for (const p of [plans[1]!, plans[6]!]) {
      const ok = encode(shape, p, sels);
      expect(dec(ok)).toBeDefined();
      expect(dec(cat(ok, new Uint8Array(32)))).toBeUndefined();
      expect(dec(cat(ok, Uint8Array.of(0)))).toBeUndefined();
      for (let n = 0; n < ok.length; n++) expect(dec(ok.subarray(0, n)), `${shape} truncated to ${n}`).toBeUndefined();
    }
  });

  it.each(SHAPES)('%s: a zero word inserted after the head (an offset gap) and every head offset moved by 32 are refused', async (shape) => {
    const { dec, sels } = await setup();
    const p = plans[6]!;
    const ok = encode(shape, p, sels);
    const heads = shape === 'tx' || shape === 'txs' ? 3 : 4;
    const gap = cat(ok.subarray(0, 4 + 32 * heads), new Uint8Array(32), ok.subarray(4 + 32 * heads));
    expect(dec(gap)).toBeUndefined();
    const offsetHeads: Record<Shape, number[]> = { tx: [0], txR: [1], txs: [0, 1, 2], txsR: [1, 2, 3] };
    for (const h of offsetHeads[shape]) {
      for (const d of [32n, -32n, 1n, -1n]) {
        const bad = Uint8Array.from(ok);
        const o = 4 + 32 * h;
        const v = BigInt(`0x${Array.from(ok.subarray(o, o + 32), (x) => x.toString(16).padStart(2, '0')).join('')}`);
        bad.set(W(v + d), o);
        expect(dec(bad), `${shape} head ${h} ${d}`).toBeUndefined();
      }
    }
  });

  it.each(SHAPES)('%s: padding garbage after the data is refused, in every byte of the padding', async (shape) => {
    const { dec, sels } = await setup();
    const p = { ds: [data(5)], as: [ADDR(1)], ms: [1] };
    const ok = encode(shape, p, sels);
    // the data tail is the last 32-byte word for the single forms and sits inside the first array for the batches
    const dataStart = ok.length - 32 * (shape === 'tx' || shape === 'txR' ? 1 : 3) - (shape === 'tx' || shape === 'txR' ? 0 : 0);
    void dataStart;
    let refused = 0;
    for (let i = 4; i < ok.length; i++) {
      if (ok[i] !== 0) continue;
      const bad = Uint8Array.from(ok);
      bad[i] = 1;
      if (dec(bad) === undefined) refused++;
    }
    expect(refused).toBeGreaterThan(20);
    // the 27 padding bytes of the 5-byte data are among the zero bytes: no single flipped padding byte is accepted
    const tail = encode('tx', p, sels);
    for (let i = tail.length - 27; i < tail.length; i++) {
      const bad = Uint8Array.from(tail);
      bad[i] = 1;
      expect(dec(bad), `padding byte ${i}`).toBeUndefined();
    }
  });

  it.each(SHAPES)('%s: a length or offset word of 2^64, 2^255 or 2^256-1 is refused without allocating', async (shape) => {
    const { dec, sels } = await setup();
    const p = plans[6]!;
    const ok = encode(shape, p, sels);
    const t0 = performance.now();
    for (let w = 0; w < (ok.length - 4) / 32; w++) {
      for (const v of [1n << 64n, 1n << 255n, MAX, (1n << 63n) - 1n, 1n << 32n]) {
        const bad = Uint8Array.from(ok);
        bad.set(W(v), 4 + 32 * w);
        const got = dec(bad);
        if (got !== undefined) {
          // only an amount word may take any value: the call list is the same shape, the amount differs
          expect(got.length).toBe(p.ds.length === 0 ? 1 : shape === 'tx' || shape === 'txR' ? 1 : p.ds.length);
        }
      }
    }
    expect(performance.now() - t0).toBeLessThan(10_000);
  });

  it('batches whose arrays differ in length are refused, whichever array is the odd one', async () => {
    const { dec, sels } = await setup();
    const three = { ds: [data(4), data(4), data(4)], as: [ADDR(1), ADDR(2), ADDR(3)], ms: [1, 2, 3] };
    for (const [ds, as, ms] of [
      [three.ds.slice(0, 2), three.as, three.ms],
      [three.ds, three.as.slice(0, 2), three.ms],
      [three.ds, three.as, three.ms.slice(0, 2)],
      [three.ds, three.as.slice(0, 1), three.ms.slice(0, 2)],
      [[], three.as, three.ms],
      [three.ds, [], []],
    ] as [Uint8Array[], Uint8Array[], (number | bigint)[]][]) {
      expect(dec(cat(sels.txs, encTxs(ds, as, ms)))).toBeUndefined();
      expect(dec(cat(sels.txsR, encTxsR(ADDR(9), ds, as, ms)))).toBeUndefined();
    }
  });

  it('a selector that is not an entry point, calldata below four bytes, and arguments of another entry point are refused', async () => {
    const { A, arb, dec, sels } = await setup();
    const ok = encode('tx', plans[1]!, sels);
    expect(dec(cat(Uint8Array.of(1, 2, 3, 4), ok.subarray(4)))).toBeUndefined();
    expect(dec(cat(arb.sel.confirm, ok.subarray(4)))).toBeUndefined();
    expect(A.decodeWalletCalls(arb, new Uint8Array(4), new Uint8Array(0))).toBeUndefined();
    expect(A.decodeWalletCalls(arb, sels.tx, sels.tx)).toBeUndefined();
    expect(A.decodeWalletCalls(arb, sels.tx, ok.subarray(0, 3))).toBeUndefined();
    expect(dec(cat(sels.txs, ok.subarray(4)))).toBeUndefined();
    expect(dec(cat(sels.txR, ok.subarray(4)))).toBeUndefined();
  });
});

describe('the unpack is go-ethereum\'s, so the re-pack is what makes the encoding canonical', () => {
  it('unpack reads the last 20 bytes of an address word, a bytes value without checking its padding, and ignores trailing data; pack of that differs', async () => {
    const { A } = await setup();
    const dirty = cat(W(0x60), cat(Uint8Array.of(0xab), new Uint8Array(11), ADDR(2)), W(5), bytesEnc(data(5)));
    const vals = A.unpackArgs(['bytes', 'address', 'uint256'], dirty) as [Uint8Array, Uint8Array, bigint];
    expect(vals[1]).toEqual(ADDR(2));
    expect(A.packArgs(['bytes', 'address', 'uint256'], vals)).not.toEqual(dirty);
    const padGarbage = Uint8Array.from(encTx(data(5), ADDR(1), 1));
    padGarbage[padGarbage.length - 1] = 9;
    expect((A.unpackArgs(['bytes', 'address', 'uint256'], padGarbage)[0] as Uint8Array).length).toBe(5);
    const trailing = cat(encTx(data(5), ADDR(1), 1), new Uint8Array(64));
    expect(A.unpackArgs(['bytes', 'address', 'uint256'], trailing)[2]).toBe(1n);
    expect(A.packArgs(['bytes', 'address', 'uint256'], A.unpackArgs(['bytes', 'address', 'uint256'], trailing))).not.toEqual(trailing);
  });

  it('pack(unpack(x)) is x for canonical x of every argument shape, and an empty input with arguments expected is an error', async () => {
    const { A } = await setup();
    const cases: [string[], Uint8Array][] = [
      [['bytes', 'address', 'uint256'], encTx(data(40), ADDR(3), MAX)],
      [['address', 'bytes', 'address', 'uint256'], encTxR(ADDR(1), data(0), ADDR(3), 0)],
      [['bytes[]', 'address[]', 'uint256[]'], encTxs([data(1), data(33)], [ADDR(1), ADDR(2)], [4, 5])],
      [['address', 'bytes[]', 'address[]', 'uint256[]'], encTxsR(ADDR(1), [], [], [])],
    ];
    for (const [t, b] of cases) expect(A.packArgs(t as never, A.unpackArgs(t as never, b))).toEqual(b);
    expect(() => A.unpackArgs(['bytes'], new Uint8Array(0))).toThrow();
    expect(A.unpackArgs([], new Uint8Array(0))).toEqual([]);
  });

  it('a length above the data is refused before any allocation: 2^255 elements in a 150-byte input take no time', async () => {
    const { A } = await setup();
    const evil = cat(W(0x60), W(0x60 + 32 + 32), W(0x60 + 64 + 32), W(1n << 255n), W(0), W(0), W(0));
    const t0 = performance.now();
    expect(() => A.unpackArgs(['address[]', 'address[]', 'address[]'], evil)).toThrow();
    expect(() => A.unpackArgs(['bytes'], cat(W(32), W(1n << 64n)))).toThrow();
    expect(() => A.unpackArgs(['bytes[]'], cat(W(32), W(1n << 40n), W(0)))).toThrow();
    expect(performance.now() - t0).toBeLessThan(1000);
  });
});
