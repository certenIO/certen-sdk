/**
 * span.ts against the OP Delta span-batch specification (an independent encoder is written here), against transactions signed here and
 * rebuilt from their span form (the rebuilt bytes must equal the signed bytes), against the real channels of the Go vector evidence
 * (deframed, inflated and decoded here with a throwaway pipeline), and on every refusal branch of the Go decoder.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { brotliDecompressSync, inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { keccak_256 } from '@noble/hashes/sha3';
import { secp256k1 } from '@noble/curves/secp256k1';
import { concatBytes, decodeTx, rlpBytes, rlpList, rlpUint } from '../../../src/proof-v2/finality/baseposted/ethtx.js';
import { BatchFormatError, BatchStreamError, decodeBatches, decodeSpanBatch, type Batch, type SpanParams } from '../../../src/proof-v2/finality/baseposted/span.js';

const here = dirname(fileURLToPath(import.meta.url));
const SET = join(here, '..', '..', 'fixtures', 'finality', 'base_posted1');

const hex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const unhex = (s: string): Uint8Array => Uint8Array.from(s.replace(/^0x/, '').match(/../g) ?? [], (h) => parseInt(h, 16));

const SP: SpanParams = { genesisTime: 1695768288n, blockTime: 2n, chainId: 84532n };

// ---- an independent span-batch encoder (Delta specification) ----

function uv(v: bigint): Uint8Array {
  const out: number[] = [];
  for (;;) {
    const b = Number(v & 0x7fn);
    v >>= 7n;
    if (v === 0n) {
      out.push(b);
      return Uint8Array.from(out);
    }
    out.push(b | 0x80);
  }
}

/** A bit list of n bits as ceil(n/8) big-endian bytes, bit i (least significant first) = item i. */
function bitlist(bits: number[]): Uint8Array {
  const n = bits.length;
  let v = 0n;
  bits.forEach((b, i) => {
    if (b) v |= 1n << BigInt(i);
  });
  const len = Math.ceil(n / 8);
  const out = new Uint8Array(len);
  for (let i = len - 1; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

interface STx {
  /** 0 legacy, 1, 2, 4; anything else is written as given (data is then opaque) */
  typ: number;
  /** the RLP item that follows the optional type byte */
  data: Uint8Array;
  sig: Uint8Array;
  y: number;
  to: Uint8Array | null;
  nonce: bigint;
  gas: bigint;
  /** legacy only: the protected bit */
  prot: number;
  /** write the leading type byte even for typ 0 (the Go decoder then treats the tx as legacy again) */
  explicitType?: boolean;
}

interface SBlock {
  advance: number;
  txs: STx[];
}

function encodeSpan(rel: bigint, originNum: bigint, parentCheck: Uint8Array, originCheck: Uint8Array, blocks: SBlock[]): Uint8Array {
  const all = blocks.flatMap((b) => b.txs);
  const legacy = all.filter((t) => t.typ === 0);
  return concatBytes([
    uv(rel), uv(originNum), parentCheck, originCheck,
    uv(BigInt(blocks.length)), bitlist(blocks.map((b) => b.advance)), ...blocks.map((b) => uv(BigInt(b.txs.length))),
    bitlist(all.map((t) => (t.to === null ? 1 : 0))), bitlist(all.map((t) => t.y)),
    ...all.map((t) => t.sig), ...all.map((t) => t.to ?? new Uint8Array(0)),
    ...all.map((t) => concatBytes([t.typ === 0 && !t.explicitType ? new Uint8Array(0) : Uint8Array.of(t.typ), t.data])),
    ...all.map((t) => uv(t.nonce)), ...all.map((t) => uv(t.gas)),
    bitlist(legacy.map((t) => t.prot)),
  ]);
}

// ---- signed transactions and their span form ----

const PRIV = unhex('b71c71a67e1177ad4e901695e1b4b9ee17ae16c6668d313eac2f96dbcda3f291');
const TO = unhex('b94f5374fce5edbc8e2a8697c15331677e6ebf0b');
const KEY = unhex('0101010101010101010101010101010101010101010101010101010101010101');
const ACCESS = rlpList([rlpList([rlpBytes(TO), rlpList([rlpBytes(KEY)])])]);
const AUTH = rlpList([rlpList([rlpUint(1n), rlpBytes(TO), rlpUint(5n), rlpUint(1n), rlpUint(9n), rlpUint(10n)])]);

type Kind = 'legacy-protected' | 'legacy-unprotected' | '2930' | '1559' | '7702';

/** Signs a transaction with the L2 chain id and returns its consensus bytes together with the span-batch form of the same fields. */
function make(kind: Kind, nonce: bigint, to: Uint8Array | null, data = Uint8Array.of(1, 2, 3)): { raw: Uint8Array; span: STx } {
  const cid = SP.chainId;
  const value = 1000n + nonce;
  const gas = 21000n + nonce;
  const optTo = rlpBytes(to ?? new Uint8Array(0));
  let items: Uint8Array[];
  let spanData: Uint8Array;
  let typ: number;
  switch (kind) {
    case 'legacy-protected':
    case 'legacy-unprotected':
      typ = 0;
      items = [rlpUint(nonce), rlpUint(77n), rlpUint(gas), optTo, rlpUint(value), rlpBytes(data)];
      spanData = rlpList([rlpUint(value), rlpUint(77n), rlpBytes(data)]);
      break;
    case '2930':
      typ = 1;
      items = [rlpUint(cid), rlpUint(nonce), rlpUint(77n), rlpUint(gas), optTo, rlpUint(value), rlpBytes(data), ACCESS];
      spanData = rlpList([rlpUint(value), rlpUint(77n), rlpBytes(data), ACCESS]);
      break;
    case '1559':
      typ = 2;
      items = [rlpUint(cid), rlpUint(nonce), rlpUint(5n), rlpUint(77n), rlpUint(gas), optTo, rlpUint(value), rlpBytes(data), ACCESS];
      spanData = rlpList([rlpUint(value), rlpUint(5n), rlpUint(77n), rlpBytes(data), ACCESS]);
      break;
    case '7702':
      typ = 4;
      items = [rlpUint(cid), rlpUint(nonce), rlpUint(5n), rlpUint(77n), rlpUint(gas), optTo, rlpUint(value), rlpBytes(data), ACCESS, AUTH];
      spanData = rlpList([rlpUint(value), rlpUint(5n), rlpUint(77n), rlpBytes(data), ACCESS, AUTH]);
      break;
  }
  let pre: Uint8Array;
  if (typ === 0) pre = rlpList(kind === 'legacy-protected' ? [...items, rlpUint(cid), rlpUint(0n), rlpUint(0n)] : items);
  else pre = concatBytes([Uint8Array.of(typ), rlpList(items)]);
  const sig = secp256k1.sign(keccak_256(pre), PRIV, { lowS: true });
  const y = sig.recovery!;
  let v: bigint;
  if (typ !== 0) v = BigInt(y);
  else v = kind === 'legacy-protected' ? 35n + 2n * cid + BigInt(y) : 27n + BigInt(y);
  const body = rlpList([...items, rlpUint(v), rlpUint(sig.r), rlpUint(sig.s)]);
  const raw = typ === 0 ? body : concatBytes([Uint8Array.of(typ), body]);
  const sigBytes = concatBytes([be32(sig.r), be32(sig.s)]);
  return { raw, span: { typ, data: spanData, sig: sigBytes, y, to, nonce, gas, prot: kind === 'legacy-protected' ? 1 : 0 } };
}

const be32 = (x: bigint): Uint8Array => {
  const out = new Uint8Array(32);
  for (let i = 31; i >= 0; i--, x >>= 8n) out[i] = Number(x & 0xffn);
  return out;
};

const PC = new Uint8Array(20).fill(0xaa);
const OC = new Uint8Array(20).fill(0xbb);

describe('span batches built by an independent encoder', () => {
  it('every transaction kind round-trips: signed bytes -> span form -> rebuilt bytes equal the signed bytes', () => {
    const kinds: Kind[] = ['legacy-protected', 'legacy-unprotected', '2930', '1559', '7702', 'legacy-protected', '1559', 'legacy-unprotected'];
    const made = kinds.map((k, i) => make(k, BigInt(i), TO));
    const blocks: SBlock[] = [
      { advance: 0, txs: [made[0]!.span, made[1]!.span, made[2]!.span] },
      { advance: 1, txs: [] },
      { advance: 0, txs: [made[3]!.span, made[4]!.span] },
      { advance: 1, txs: [made[5]!.span, made[6]!.span, made[7]!.span] },
    ];
    const out = decodeSpanBatch(encodeSpan(100n, 5000n, PC, OC, blocks), SP);
    expect(out).toHaveLength(4);
    const want = [made.slice(0, 3), [], made.slice(3, 5), made.slice(5, 8)];
    out.forEach((b, i) => expect(b.txs.map(hex)).toEqual(want[i]!.map((m) => hex(m.raw))));
    // every rebuilt transaction is a transaction go decodes
    for (const m of made) expect(decodeTx(m.raw).type).toBe(m.span.typ);
  });

  it('creation transactions (to bit set) rebuild with an empty `to` for legacy, 2930 and 1559', () => {
    const made = (['legacy-protected', '2930', '1559'] as Kind[]).map((k, i) => make(k, BigInt(i), null));
    const out = decodeSpanBatch(encodeSpan(0n, 9n, PC, OC, [{ advance: 0, txs: made.map((m) => m.span) }]), SP);
    expect(out[0]!.txs.map(hex)).toEqual(made.map((m) => hex(m.raw)));
    for (const m of made) expect(decodeTx(m.raw).to).toBeNull();
  });

  it('blocks: timestamps, origins counted back from the last block, parent only on the first, epoch only on the last', () => {
    const blocks: SBlock[] = [0, 1, 0, 0, 1, 1, 0].map((advance) => ({ advance, txs: [] }));
    const out = decodeSpanBatch(encodeSpan(86n, 1000n, PC, OC, blocks), SP);
    expect(out).toHaveLength(7);
    // bits: 0:0 1:1 2:0 3:0 4:1 5:1 6:0 ; counting back from block 6 (origin 1000): 6:1000, 5:1000, 4:999, 3:998, 2:998, 1:998, 0:997
    expect(out.map((b) => b.epochNum)).toEqual([997n, 998n, 998n, 998n, 999n, 1000n, 1000n]);
    out.forEach((b, i) => {
      expect(b.type).toBe(1);
      expect(b.timestamp).toBe(SP.genesisTime + 86n + 2n * BigInt(i));
      expect(b.spanIndex).toBe(i);
      expect(b.spanBlocks).toBe(7);
      expect(b.parentLen).toBe(i === 0 ? 20 : 0);
      expect(b.epochLen).toBe(i === 6 ? 20 : 0);
      expect(hex(b.parentHash)).toBe(i === 0 ? hex(PC) + '00'.repeat(12) : '00'.repeat(32));
      expect(hex(b.epochHash)).toBe(i === 6 ? hex(OC) + '00'.repeat(12) : '00'.repeat(32));
    });
  });

  it('a single-block span carries both the parent check and the origin check', () => {
    const out = decodeSpanBatch(encodeSpan(0n, 7n, PC, OC, [{ advance: 0, txs: [] }]), SP);
    expect(out[0]!.parentLen).toBe(20);
    expect(out[0]!.epochLen).toBe(20);
    expect(out[0]!.epochNum).toBe(7n);
  });

  it('bit 0 of the origin bits is ignored (a set bit 0 does not move the origin)', () => {
    const a = decodeSpanBatch(encodeSpan(0n, 7n, PC, OC, [{ advance: 1, txs: [] }, { advance: 0, txs: [] }]), SP);
    const b = decodeSpanBatch(encodeSpan(0n, 7n, PC, OC, [{ advance: 0, txs: [] }, { advance: 0, txs: [] }]), SP);
    expect(a.map((x) => x.epochNum)).toEqual(b.map((x) => x.epochNum));
  });

  it('the timestamp wraps at 64 bits like go\'s uint64', () => {
    const out = decodeSpanBatch(encodeSpan((1n << 64n) - 1n, 1n, PC, OC, [{ advance: 0, txs: [] }, { advance: 0, txs: [] }]), SP);
    expect(out[0]!.timestamp).toBe((SP.genesisTime + (1n << 64n) - 1n) & ((1n << 64n) - 1n));
    expect(out[1]!.timestamp).toBe((SP.genesisTime + (1n << 64n) - 1n + 2n) & ((1n << 64n) - 1n));
  });

  it('a type byte of 0 before a legacy transaction is read as a legacy transaction (go does too)', () => {
    const m = make('legacy-protected', 1n, TO);
    const out = decodeSpanBatch(encodeSpan(0n, 7n, PC, OC, [{ advance: 0, txs: [{ ...m.span, explicitType: true }] }]), SP);
    expect(hex(out[0]!.txs[0]!)).toBe(hex(m.raw));
  });

  it('the protected bits are consumed in legacy order only (typed transactions between legacy ones do not shift them)', () => {
    const l1 = make('legacy-protected', 1n, TO);
    const t = make('1559', 2n, TO);
    const l2 = make('legacy-unprotected', 3n, TO);
    const l3 = make('legacy-protected', 4n, TO);
    const out = decodeSpanBatch(encodeSpan(0n, 7n, PC, OC, [{ advance: 0, txs: [l1.span, t.span, l2.span, l3.span] }]), SP);
    expect(out[0]!.txs.map(hex)).toEqual([l1.raw, t.raw, l2.raw, l3.raw].map(hex));
  });

  it('the maximum block count (65536) is accepted and one more is refused', () => {
    const ok = decodeSpanBatch(encodeSpan(0n, 70000n, PC, OC, Array.from({ length: 65536 }, () => ({ advance: 0, txs: [] }))), SP);
    expect(ok).toHaveLength(65536);
    expect(() => decodeSpanBatch(encodeSpan(0n, 70000n, PC, OC, Array.from({ length: 65537 }, () => ({ advance: 0, txs: [] }))), SP)).toThrow(BatchStreamError);
  });
});

// ---- refusals ----

describe('span batch refusals (each one is a malformed stream, channel_malformed)', () => {
  const m1 = make('1559', 1n, TO);
  const good = (): Uint8Array => encodeSpan(5n, 50n, PC, OC, [{ advance: 0, txs: [m1.span] }, { advance: 1, txs: [] }]);
  const stream = (b: Uint8Array): void => expect(() => decodeSpanBatch(b, SP)).toThrow(BatchStreamError);

  it('the good batch decodes', () => {
    expect(decodeSpanBatch(good(), SP)).toHaveLength(2);
  });
  it('every strict prefix of a good batch is refused (a short field anywhere)', () => {
    const g = good();
    for (let n = 0; n < g.length; n++) stream(g.subarray(0, n));
  });
  it('trailing bytes are refused', () => stream(concatBytes([good(), Uint8Array.of(0)])));
  it('uvarint: empty, unterminated, 11 bytes, 10th byte above 1', () => {
    stream(new Uint8Array(0));
    stream(Uint8Array.of(0x80));
    stream(concatBytes([new Uint8Array(10).fill(0x80), Uint8Array.of(0)]));
    stream(concatBytes([new Uint8Array(9).fill(0xff), Uint8Array.of(2), PC, OC]));
    // 10th byte of exactly 1 is the largest uint64: accepted as the relative timestamp, which then fails later for another reason
    expect(() => decodeSpanBatch(concatBytes([new Uint8Array(9).fill(0xff), Uint8Array.of(1)]), SP)).toThrow(BatchStreamError);
  });
  it('uvarint: the 11-byte form and a 10th byte of 2 are refused with a valid batch behind them; 10th byte 1 and 0x80 0x01 are read as values', () => {
    const rest = good().subarray(1);
    stream(concatBytes([new Uint8Array(10).fill(0x80), Uint8Array.of(0), rest]));
    stream(concatBytes([new Uint8Array(9).fill(0x80), Uint8Array.of(2), rest]));
    const big = decodeSpanBatch(concatBytes([new Uint8Array(9).fill(0x80), Uint8Array.of(1), rest]), SP);
    expect(big[0]!.timestamp).toBe((SP.genesisTime + (1n << 63n)) & ((1n << 64n) - 1n));
    expect(decodeSpanBatch(concatBytes([Uint8Array.of(0x80, 0x01), rest]), SP)[0]!.timestamp).toBe(SP.genesisTime + 128n);
  });
  it('uvarint accepts a non-minimal encoding, like go (0x80 0x00 is 0)', () => {
    const g = good();
    // replace the rel timestamp byte 5 by 0x85 0x00 (still 5)
    const alt = concatBytes([Uint8Array.of(0x85, 0x00), g.subarray(1)]);
    expect(decodeSpanBatch(alt, SP).map((b) => b.timestamp)).toEqual(decodeSpanBatch(g, SP).map((b) => b.timestamp));
  });
  it('block count 0 is refused', () => stream(concatBytes([uv(0n), uv(5n), PC, OC, uv(0n)])));
  it('a set bit beyond the length of a bit list is refused (origin bits, creation bits, y parity bits, protected bits)', () => {
    // 3 blocks: the origin bits are one byte; bit 3 set is beyond 3 bits
    const head = concatBytes([uv(0n), uv(9n), PC, OC, uv(3n)]);
    stream(concatBytes([head, Uint8Array.of(0b1000), uv(0n), uv(0n), uv(0n), new Uint8Array(0), new Uint8Array(0)]));
    expect(decodeSpanBatch(concatBytes([head, Uint8Array.of(0b0111), uv(0n), uv(0n), uv(0n)]), SP)).toHaveLength(3);
    // one block, one legacy tx: the creation, y-parity and protected lists are one bit; bit 1 is beyond
    const m = make('legacy-protected', 1n, TO).span;
    const body = (creation: number, y: number, prot: number): Uint8Array =>
      concatBytes([uv(0n), uv(9n), PC, OC, uv(1n), Uint8Array.of(0), uv(1n), Uint8Array.of(creation), Uint8Array.of(y), m.sig, TO, m.data, uv(m.nonce), uv(m.gas), Uint8Array.of(prot)]);
    expect(decodeSpanBatch(body(0, 1, 1), SP)).toHaveLength(1);
    stream(body(2, 0, 0));
    stream(body(0, 2, 0));
    stream(body(0, 0, 2));
  });
  it('the transaction counts: the bound is 2^20 in total, a hostile count never allocates', () => {
    const head = (counts: bigint[]): Uint8Array => concatBytes([uv(0n), uv(9n), PC, OC, uv(BigInt(counts.length)), bitlist(counts.map(() => 0)), ...counts.map(uv)]);
    stream(head([(1n << 20n) + 1n]));
    stream(head([1n << 20n, 1n]));
    stream(head([1n << 63n]));
  });
  it('FINDING go: counts [1, 2^64-1] wrap go\'s uint64 total to 0 and slip under the bound; here the sum is exact and the batch is refused', () => {
    const counts = [1n, (1n << 64n) - 1n];
    const b = concatBytes([uv(0n), uv(9n), PC, OC, uv(2n), bitlist([0, 0]), ...counts.map(uv)]);
    stream(b);
  });
  it('signature, to, data, nonce and gas lists that run short are refused', () => {
    const g = good();
    const m = m1.span;
    const sections = [m.sig, m.to!, concatBytes([Uint8Array.of(m.typ), m.data]), uv(m.nonce), uv(m.gas)];
    // the encoding is head | creation | y | sig | to | data | nonce | gas | protected: truncating the tail by one byte at a time covers it
    for (let cut = 1; cut <= sections.reduce((n, s) => n + s.length, 0); cut++) stream(g.subarray(0, g.length - cut - 0));
  });
  it('a transaction data item whose RLP header is wrong is refused', () => {
    const m = { ...m1.span, data: Uint8Array.of(0xf8, 0x02, 0x01) }; // long form below 56
    stream(encodeSpan(0n, 9n, PC, OC, [{ advance: 0, txs: [m] }]));
    stream(encodeSpan(0n, 9n, PC, OC, [{ advance: 0, txs: [{ ...m1.span, data: Uint8Array.of(0xc5, 1) }] }])); // list longer than the input
  });
  it('a transaction data item that begins with 0x80 is data (an empty string), not a type byte', () => {
    const m = make('1559', 1n, TO).span;
    stream(encodeSpan(0n, 9n, PC, OC, [{ advance: 0, txs: [{ ...m, typ: 0x80, data: m.data }] }]));
  });
  it('bit 0 of the origin bits never underflows, even at origin 0', () => {
    expect(decodeSpanBatch(encodeSpan(0n, 0n, PC, OC, [{ advance: 1, txs: [] }]), SP)[0]!.epochNum).toBe(0n);
  });
  it('origin underflow: a set bit below origin 0 is refused', () => {
    stream(encodeSpan(0n, 0n, PC, OC, [{ advance: 0, txs: [] }, { advance: 1, txs: [] }]));
    expect(decodeSpanBatch(encodeSpan(0n, 1n, PC, OC, [{ advance: 0, txs: [] }, { advance: 1, txs: [] }]), SP)[0]!.epochNum).toBe(0n);
  });
  it('rebuild: wrong item counts, non-canonical integers, non-lists, oversized uint256 fields are refused for every type', () => {
    const cases: { name: string; m: STx }[] = [
      { name: 'legacy too few', m: { ...make('legacy-protected', 1n, TO).span, data: rlpList([rlpUint(1n), rlpUint(2n)]) } },
      { name: 'legacy too many', m: { ...make('legacy-protected', 1n, TO).span, data: rlpList([rlpUint(1n), rlpUint(2n), rlpBytes(new Uint8Array(0)), rlpUint(0n)]) } },
      { name: 'legacy leading zero', m: { ...make('legacy-protected', 1n, TO).span, data: rlpList([Uint8Array.of(0x82, 0, 1), rlpUint(2n), rlpBytes(new Uint8Array(0))]) } },
      { name: 'legacy 33-byte value', m: { ...make('legacy-protected', 1n, TO).span, data: rlpList([rlpBytes(new Uint8Array(33).fill(1)), rlpUint(2n), rlpBytes(new Uint8Array(0))]) } },
      { name: 'legacy not a list', m: { ...make('legacy-protected', 1n, TO).span, data: rlpBytes(Uint8Array.of(1, 2, 3)) } },
      { name: '2930 too few', m: { ...make('2930', 1n, TO).span, data: rlpList([rlpUint(1n), rlpUint(2n), rlpBytes(new Uint8Array(0))]) } },
      { name: '2930 bad access list', m: { ...make('2930', 1n, TO).span, data: rlpList([rlpUint(1n), rlpUint(2n), rlpBytes(new Uint8Array(0)), rlpList([rlpBytes(TO)])]) } },
      { name: '1559 too few', m: { ...make('1559', 1n, TO).span, data: rlpList([rlpUint(1n), rlpUint(2n), rlpUint(3n), rlpBytes(new Uint8Array(0))]) } },
      { name: '1559 33-byte tip', m: { ...make('1559', 1n, TO).span, data: rlpList([rlpUint(1n), rlpBytes(new Uint8Array(33).fill(1)), rlpUint(3n), rlpBytes(new Uint8Array(0)), rlpList([])]) } },
      { name: '1559 data is a list', m: { ...make('1559', 1n, TO).span, data: rlpList([rlpUint(1n), rlpUint(2n), rlpUint(3n), rlpList([]), rlpList([])]) } },
      { name: '7702 too few', m: { ...make('7702', 1n, TO).span, data: rlpList([rlpUint(1n), rlpUint(2n), rlpUint(3n), rlpBytes(new Uint8Array(0)), rlpList([])]) } },
      { name: '7702 bad authorization', m: { ...make('7702', 1n, TO).span, data: rlpList([rlpUint(1n), rlpUint(2n), rlpUint(3n), rlpBytes(new Uint8Array(0)), rlpList([]), rlpList([rlpList([rlpUint(1n)])])]) } },
      { name: '7702 without a to', m: { ...make('7702', 1n, null).span } },
    ];
    for (const c of cases) {
      expect(() => decodeSpanBatch(encodeSpan(0n, 9n, PC, OC, [{ advance: 0, txs: [c.m] }]), SP), c.name).toThrow(BatchStreamError);
    }
  });
  it('an unsupported transaction type is BatchFormatError{typ}, but only once the whole batch parses and in transaction order', () => {
    const blob = { ...make('1559', 1n, TO).span, typ: 3 };
    const sentinel = (): void => {};
    void sentinel;
    try {
      decodeSpanBatch(encodeSpan(0n, 9n, PC, OC, [{ advance: 0, txs: [blob] }]), SP);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(BatchFormatError);
      expect((e as BatchFormatError).typ).toBe(3);
    }
    // type 5 and 0x7f, with data that need not even be a list: the type decides, no decode happens
    for (const typ of [5, 0x7f]) {
      expect(() => decodeSpanBatch(encodeSpan(0n, 9n, PC, OC, [{ advance: 0, txs: [{ ...blob, typ, data: Uint8Array.of(0x05) }] }]), SP)).toThrow(BatchFormatError);
    }
    // a plain error in an EARLIER transaction wins over the unsupported type of a later one
    const badFirst = { ...make('1559', 2n, TO).span, data: rlpList([rlpUint(1n)]) };
    expect(() => decodeSpanBatch(encodeSpan(0n, 9n, PC, OC, [{ advance: 0, txs: [badFirst, blob] }]), SP)).toThrow(BatchStreamError);
    // ... and a later plain error does not hide an earlier unsupported type
    expect(() => decodeSpanBatch(encodeSpan(0n, 9n, PC, OC, [{ advance: 0, txs: [blob, badFirst] }]), SP)).toThrow(BatchFormatError);
    // a malformed batch is a stream error even when it also carries an unsupported type
    expect(() => decodeSpanBatch(concatBytes([encodeSpan(0n, 9n, PC, OC, [{ advance: 0, txs: [blob] }]), Uint8Array.of(1)]), SP)).toThrow(BatchStreamError);
  });
});

// ---- the whole channel stream ----

describe('decodeBatches: the channel stream of RLP strings', () => {
  const singular = (parent: number, num: bigint, epoch: number, ts: bigint, txs: Uint8Array[]): Uint8Array =>
    rlpBytes(concatBytes([Uint8Array.of(0), rlpList([rlpBytes(new Uint8Array(32).fill(parent)), rlpUint(num), rlpBytes(new Uint8Array(32).fill(epoch)), rlpUint(ts), rlpList(txs.map(rlpBytes))])]));
  const spanItem = (payload: Uint8Array): Uint8Array => rlpBytes(concatBytes([Uint8Array.of(1), payload]));
  const stream = (b: Uint8Array): void => expect(() => decodeBatches(b, SP)).toThrow(BatchStreamError);

  it('singular batches carry all four fields and their transactions, in order', () => {
    const out = decodeBatches(concatBytes([singular(1, 10n, 2, 1700000000n, [Uint8Array.of(7), Uint8Array.of(8, 9)]), singular(3, 11n, 4, 1700000002n, [])]), SP);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ type: 0, parentLen: 32, epochLen: 32, epochNum: 10n, timestamp: 1700000000n, spanIndex: 0, spanBlocks: 1 });
    expect(hex(out[0]!.parentHash)).toBe('01'.repeat(32));
    expect(hex(out[0]!.epochHash)).toBe('02'.repeat(32));
    expect(out[0]!.txs.map(hex)).toEqual(['07', '0809']);
    expect(out[1]).toMatchObject({ epochNum: 11n, timestamp: 1700000002n });
    expect(out[1]!.txs).toEqual([]);
  });
  it('singular and span batches mix; the span expands to its blocks', () => {
    const sp = encodeSpan(100n, 5n, PC, OC, [{ advance: 0, txs: [] }, { advance: 1, txs: [] }]);
    const out = decodeBatches(concatBytes([singular(1, 10n, 2, 1700000000n, []), spanItem(sp), singular(5, 12n, 6, 5n, [])]), SP);
    expect(out.map((b) => b.type)).toEqual([0, 1, 1, 0]);
    expect(out[1]!.timestamp).toBe(SP.genesisTime + 100n);
  });
  it('an empty stream has no batches', () => expect(decodeBatches(new Uint8Array(0), SP)).toEqual([]));
  it('batch types other than 0 and 1 are BatchFormatError{typ}', () => {
    for (const typ of [2, 3, 0x7f, 0xff]) {
      try {
        decodeBatches(rlpBytes(Uint8Array.of(typ, 0xc0)), SP);
        expect.unreachable();
      } catch (e) {
        expect(e).toBeInstanceOf(BatchFormatError);
        expect((e as BatchFormatError).typ).toBe(typ);
      }
    }
  });
  it('an unsupported type after a good batch still refuses; a stream error before it wins', () => {
    expect(() => decodeBatches(concatBytes([singular(1, 1n, 1, 1n, []), rlpBytes(Uint8Array.of(9, 0xc0))]), SP)).toThrow(BatchFormatError);
    stream(concatBytes([Uint8Array.of(0x05), rlpBytes(Uint8Array.of(9, 0xc0))]));
  });
  it('stream errors: a lone byte (not a string), the empty string, a list, a truncated string', () => {
    stream(Uint8Array.of(0x05));
    stream(Uint8Array.of(0x80));
    stream(rlpList([]));
    stream(Uint8Array.of(0xb8, 0x40, 0x00)); // long string longer than the input
    stream(concatBytes([singular(1, 1n, 1, 1n, []), Uint8Array.of(0x83, 0x00)]));
  });
  it('singular decode is strict: field count, hash sizes, integer widths, canonical integers, tx list shape', () => {
    const wrap = (items: Uint8Array[]): Uint8Array => rlpBytes(concatBytes([Uint8Array.of(0), rlpList(items)]));
    const h = rlpBytes(new Uint8Array(32).fill(1));
    const ok = [h, rlpUint(1n), h, rlpUint(2n), rlpList([])];
    expect(decodeBatches(wrap(ok), SP)).toHaveLength(1);
    stream(wrap(ok.slice(0, 4)));
    stream(wrap([...ok, rlpUint(0n)]));
    stream(wrap([rlpBytes(new Uint8Array(31).fill(1)), ...ok.slice(1)]));
    stream(wrap([h, rlpBytes(new Uint8Array(9).fill(1)), ...ok.slice(2)]));
    stream(wrap([h, ok[1]!, rlpBytes(new Uint8Array(33).fill(1)), ...ok.slice(3)]));
    stream(wrap([h, Uint8Array.of(0x82, 0, 1), ...ok.slice(2)]));
    stream(wrap([h, ok[1]!, h, rlpBytes(new Uint8Array(9).fill(1)), ok[4]!]));
    stream(wrap([h, ok[1]!, h, Uint8Array.of(0x00), ok[4]!]));
    stream(wrap([...ok.slice(0, 4), rlpBytes(Uint8Array.of(1))]));
    stream(wrap([...ok.slice(0, 4), rlpList([rlpList([])])]));
    stream(wrap([rlpList([]), ...ok.slice(1)]));
    stream(concatBytes([rlpBytes(concatBytes([Uint8Array.of(0), rlpList(ok)])).subarray(0, -1)]));
    // trailing bytes inside the payload
    stream(rlpBytes(concatBytes([Uint8Array.of(0), rlpList(ok), Uint8Array.of(0)])));
    // the payload of a type-0 batch cannot be empty
    stream(rlpBytes(Uint8Array.of(0)));
  });
});

// ---- the real channels of the Go vector evidence ----

function readEvidence(file: string): { channelId: Uint8Array; frames: { l1Block: bigint; raw: Uint8Array; blobs: Uint8Array[] }[] } {
  const ev = readFileSync(join(SET, 'evidence', file));
  const dv = new DataView(ev.buffer, ev.byteOffset, ev.byteLength);
  let p = 0;
  const u32 = (): number => ((p += 4), dv.getUint32(p - 4));
  const u64 = (): bigint => ((p += 8), dv.getBigUint64(p - 8));
  const skip = (n: number): void => void (p += n);
  const lp = (): Uint8Array => {
    const n = u32();
    p += n;
    return Uint8Array.from(ev.subarray(p - n, p));
  };
  skip(4);
  lp();
  skip(8 + 1 + 8 + 32);
  lp();
  skip(1 + 8 + 32 + 1);
  lp();
  const links = u32();
  for (let i = 0; i < links; i++) {
    skip(1);
    lp();
  }
  skip(1);
  lp();
  const spine = u32();
  for (let i = 0; i < spine; i++) lp();
  const channelId = Uint8Array.from(ev.subarray(p, p + 16));
  skip(16);
  const n = u32();
  const frames = [];
  for (let i = 0; i < n; i++) {
    const l1Block = u64();
    skip(4);
    const raw = lp();
    const bc = u32();
    const blobs: Uint8Array[] = [];
    for (let j = 0; j < bc; j++) {
      blobs.push(lp());
      skip(96);
    }
    frames.push({ l1Block, raw, blobs });
  }
  return { channelId, frames };
}

/** OP Blob.ToData, for the throwaway deframing of the real evidence. */
function blobToData(b: Uint8Array): Uint8Array {
  const maxData = (4 * 31 + 3) * 1024 - 4;
  const outLen = (b[2]! << 16) | (b[3]! << 8) | b[4]!;
  const out = new Uint8Array(maxData);
  out.set(b.subarray(5, 32), 0);
  let opos = 28;
  let ipos = 32;
  const enc = [b[0]!, 0, 0, 0];
  const field = (): number => {
    out.set(b.subarray(ipos + 1, ipos + 32), opos);
    const c = b[ipos]!;
    opos += 32;
    ipos += 32;
    return c;
  };
  const reassemble = (): void => {
    opos--;
    const x = (enc[0]! & 0x3f) | ((enc[1]! & 0x30) << 2);
    const y = (enc[1]! & 0x0f) | ((enc[3]! & 0x0f) << 4);
    const z = (enc[2]! & 0x3f) | ((enc[3]! & 0x30) << 2);
    out[opos - 32] = z;
    out[opos - 64] = y;
    out[opos - 96] = x;
  };
  for (let i = 1; i < 4; i++) enc[i] = field();
  reassemble();
  for (let i = 1; i < 1024 && opos < outLen; i++) {
    for (let j = 0; j < 4; j++) enc[j] = field();
    reassemble();
  }
  return out.subarray(0, outLen);
}

function channelOf(file: string): Uint8Array {
  const { channelId, frames } = readEvidence(file);
  const parts: { n: number; data: Uint8Array; last: boolean }[] = [];
  for (const f of frames) {
    for (const blob of f.blobs) {
      const d = blobToData(blob);
      expect(d[0]).toBe(0); // derivation version
      let p = 1;
      while (p < d.length) {
        const id = d.subarray(p, p + 16);
        const num = (d[p + 16]! << 8) | d[p + 17]!;
        const len = new DataView(d.buffer, d.byteOffset + p + 18, 4).getUint32(0);
        const data = d.subarray(p + 22, p + 22 + len);
        const last = d[p + 22 + len] === 1;
        p += 22 + len + 1;
        if (hex(id) === hex(channelId)) parts.push({ n: num, data, last });
      }
    }
  }
  parts.sort((a, b) => a.n - b.n);
  parts.forEach((x, i) => expect(x.n).toBe(i));
  expect(parts[parts.length - 1]!.last).toBe(true);
  const ch = concatBytes(parts.map((x) => x.data));
  return ch[0] === 1 ? brotliDecompressSync(ch.subarray(1)) : inflateSync(ch);
}

describe('the real Base Sepolia channels of the Go vector evidence', () => {
  for (const [file, leg] of [['valid_a.bin', 'a.json'], ['valid_b.bin', 'b.json']] as const) {
    it(`${file}: deframed, inflated and decoded; singular batches (batch_type 0), the leg's block among them`, () => {
      const batches = decodeBatches(channelOf(file), SP);
      expect(batches.length).toBeGreaterThan(1);
      expect(new Set(batches.map((b) => b.type))).toEqual(new Set([0]));
      expect(batches.every((b) => b.parentLen === 32 && b.epochLen === 32 && b.spanBlocks === 1)).toBe(true);
      // consecutive L2 blocks of one chain: the timestamps ascend by the block time
      for (let i = 1; i < batches.length; i++) expect(batches[i]!.timestamp).toBe(batches[i - 1]!.timestamp + 2n);
      // the leg's header: its timestamp is one of the batches', and the batch's parent hash is the header's
      const legJson = JSON.parse(readFileSync(join(SET, 'legs', leg), 'utf8'));
      const header = unhex(legJson.header);
      const hash = keccak_256(header);
      expect('0x' + hex(hash)).toBe(legJson.hash);
      const ts = BigInt(`0x${hex(headerItem(header, 11))}`);
      const b = batches.find((x) => x.timestamp === ts);
      expect(b).toBeDefined();
      expect(hex(b!.parentHash)).toBe(hex(headerItem(header, 0)));
      // every batch transaction is a transaction go decodes (deposits excluded: they are not in batches)
      for (const x of batches) for (const t of x.txs) expect(() => decodeTx(t)).not.toThrow();
    });
  }
});

/** Item i of a raw header RLP list (strings only). */
function headerItem(header: Uint8Array, idx: number): Uint8Array {
  let p = 1 + (header[0]! - 0xf7);
  for (let i = 0; ; i++) {
    const b = header[p]!;
    let hdr = 1;
    let n = 0;
    if (b < 0x80) (hdr = 0), (n = 1);
    else if (b < 0xb8) n = b - 0x80;
    else if (b < 0xc0) {
      const l = b - 0xb7;
      hdr = 1 + l;
      for (let k = 0; k < l; k++) n = n * 256 + header[p + 1 + k]!;
    } else if (b < 0xf8) n = b - 0xc0;
    else {
      const l = b - 0xf7;
      hdr = 1 + l;
      for (let k = 0; k < l; k++) n = n * 256 + header[p + 1 + k]!;
    }
    if (i === idx) return header.subarray(p + hdr, p + hdr + n);
    p += hdr + n;
  }
}
