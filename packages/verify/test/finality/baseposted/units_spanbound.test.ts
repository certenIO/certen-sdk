/**
 * RB12-TS-FIX-POSTED D4 (audit mutant B15): the span batch decoder bounds the transactions of a span batch by 2^20 IN TOTAL, applied to the exact sum
 * (span.ts: `c > MAX_SPAN_TXS - total` before `total += c`; Go span.go `c > maxSpanTxs-total`), not per block. The audit listed "exact sum -> per-count bound"
 * as verdict-equivalent because the later length checks refuse a short body; that holds only for a body shorter than 64 bytes per transaction. A WELL-FORMED
 * payload of 2^20 + 1 transactions in two blocks (counts [2^20, 1]) passes a per-count bound, is decoded to all 1,048,577 transactions (probe: 35 s, a 102 MB payload; the contract-creation form below is 87 MB) and so
 * differs from Go, which refuses it with "span: tx count". The mutant is therefore killed here, not listed as an equivalent:
 *   - the refusal is judged by its reason (the first failing check), so a count that merely fails later on a short body is not mistaken for the bound;
 *   - the bound is exact at the boundary: a total of 2^20 passes the count check, a total of 2^20 + 1 does not, however the counts are split over blocks;
 *   - a well-formed payload of 2^20 + 1 transactions is refused by the count and never decoded.
 */
import { describe, expect, it } from 'vitest';
import { keccak_256 } from '@noble/hashes/sha3';
import { secp256k1 } from '@noble/curves/secp256k1';
import { concatBytes, rlpBytes, rlpList, rlpUint } from '../../../src/proof-v2/finality/baseposted/ethtx.js';
import { embeddedPins } from '../../../src/proof-v2/finality/pins.js';
import { parseBasePins } from '../../../src/proof-v2/finality/baseposted/pins.js';
import { BatchStreamError, MAX_SPAN_TXS, decodeSpanBatch, type SpanParams } from '../../../src/proof-v2/finality/baseposted/span.js';

const SP: SpanParams = { genesisTime: 1695768288n, blockTime: 2n, chainId: 84532n };
const PC = new Uint8Array(20).fill(0xaa);
const OC = new Uint8Array(20).fill(0xbb);
const unhex = (s: string): Uint8Array => Uint8Array.from(s.match(/../g) ?? [], (h) => parseInt(h, 16));

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
/** a bit list of n zero bits: ceil(n/8) zero bytes */
const zeroBits = (n: number): Uint8Array => new Uint8Array(Math.ceil(n / 8));
/** prefix, block count, origin bits (all zero), the per-block transaction counts: what the decoder has read when it judges the counts */
const head = (counts: bigint[]): Uint8Array => concatBytes([uv(0n), uv(9n), PC, OC, uv(BigInt(counts.length)), zeroBits(counts.length), ...counts.map(uv)]);

/** the message of the BatchStreamError the decoder refuses the payload with */
function reason(payload: Uint8Array): string {
  try {
    decodeSpanBatch(payload, SP);
  } catch (e) {
    if (e instanceof BatchStreamError) return e.message;
    throw e;
  }
  return 'decoded';
}
const TX_COUNT = 'span: tx count';
const MAX = BigInt(MAX_SPAN_TXS);

describe('span batch transaction bound: 2^20 in total, on the exact sum', () => {
  it('the bound is 2^20', () => {
    expect(MAX_SPAN_TXS).toBe(1 << 20);
  });

  it('a total of exactly 2^20 passes the count check however it is split over blocks (the body is then refused later, never for its count)', () => {
    for (const counts of [[MAX], [MAX - 1n, 1n], [1n, MAX - 1n], [MAX, 0n], [0n, MAX], [MAX / 2n, MAX / 2n], [1n, 1n, MAX - 2n]]) {
      expect(reason(head(counts)), counts.map(String).join('+')).not.toBe(TX_COUNT);
    }
  });

  it('a total of 2^20 + 1 is refused for its count, however it is split over blocks: the last count is compared with what remains of the bound', () => {
    for (const counts of [[MAX + 1n], [MAX, 1n], [1n, MAX], [MAX / 2n, MAX / 2n + 1n], [MAX / 2n + 1n, MAX / 2n], [1n, 1n, MAX - 1n], [MAX - 1n, 1n, 1n], [MAX - 1n, 2n]]) {
      expect(reason(head(counts)), counts.map(String).join('+')).toBe(TX_COUNT);
    }
  });

  it('a hostile count is refused for its count without any body: 2^63, 2^64 - 1, and a sum that wraps a uint64 ([1, 2^64-1])', () => {
    for (const counts of [[1n << 63n], [(1n << 64n) - 1n], [1n, (1n << 64n) - 1n], [(1n << 64n) - 1n, 1n], [1n << 63n, 1n << 63n]]) {
      expect(reason(head(counts)), counts.map(String).join('+')).toBe(TX_COUNT);
    }
  });

  it('a WELL-FORMED payload of 2^20 + 1 legacy contract-creation transactions in two blocks, smaller than the embedded channel pin, is refused for its count, not decoded', () => {
    const n = (1 << 20) + 1;
    const items = [rlpUint(0n), rlpUint(77n), rlpUint(21000n), rlpBytes(new Uint8Array(0)), rlpUint(1000n), rlpBytes(Uint8Array.of(1, 2, 3))];
    const sig = secp256k1.sign(keccak_256(rlpList([...items, rlpUint(84532n), rlpUint(0n), rlpUint(0n)])), unhex('b71c71a67e1177ad4e901695e1b4b9ee17ae16c6668d313eac2f96dbcda3f291'), { lowS: true });
    const be32 = (x: bigint): Uint8Array => {
      const o = new Uint8Array(32);
      for (let i = 31; i >= 0; i--, x >>= 8n) o[i] = Number(x & 0xffn);
      return o;
    };
    const sigBytes = concatBytes([be32(sig.r), be32(sig.s)]);
    const data = rlpList([rlpUint(1000n), rlpUint(77n), rlpBytes(Uint8Array.of(1, 2, 3))]);
    const gas = uv(21000n);
    const bits = Math.ceil(n / 8);
    const prefix = head([MAX, 1n]);
    const payload = new Uint8Array(prefix.length + 2 * bits + n * (64 + data.length + 1 + gas.length) + bits);
    payload.set(prefix, 0);
    // creation bits: every transaction is a contract creation (no to address); bit i lives in byte bits-1-floor(i/8), so the highest bits are in the first byte; y-parity bits stay zero
    const creation = payload.subarray(prefix.length, prefix.length + bits);
    creation.fill(0xff);
    creation[0] = (1 << (n % 8 || 8)) - 1;
    let o = prefix.length + 2 * bits;
    for (let i = 0; i < n; i++, o += 64) payload.set(sigBytes, o);
    for (let i = 0; i < n; i++, o += data.length) payload.set(data, o);
    o += n; // nonces: uvarint 0
    for (let i = 0; i < n; i++, o += gas.length) payload.set(gas, o);
    expect(o + bits).toBe(payload.length); // the protected bit list (all zero) closes the payload: every section is complete
    expect(BigInt(payload.length)).toBeLessThan(parseBasePins(embeddedPins()).maxRlpBytesPerChannel);
    expect(reason(payload)).toBe(TX_COUNT);
  }, 120_000);
});
