/**
 * RB12-TS-FIX-POSTED D4 (audit mutant A32): the data-length word of a submit-retryable message (kind 9) is refused above MAX_L2_MESSAGE_SIZE
 * (derive.ts: `dataLenW > MAX_L2_MESSAGE_SIZE`). The mutant `>=` is an equivalent: a word equal to the bound can never be satisfied, because the
 * message already fails the top-level `d.data.length > MAX_L2_MESSAGE_SIZE` when it is long enough to carry that many data bytes (nine 32-byte
 * words precede the data), and a shorter message fails the data read. These tests pin the whole boundary region so that the argument is checked, not
 * assumed: the largest retryable that passes is 288 + 261856 bytes, one byte more fails the top-level cap, and a word equal to the bound fails
 * for every body length.
 */
import { describe, expect, it } from 'vitest';
import { deriveDelayed } from '../../../src/proof-v2/finality/arbposted/derive.js';
import { MAX_L2_MESSAGE_SIZE } from '../../../src/proof-v2/finality/arbposted/nitro.js';
import type { Delayed } from '../../../src/proof-v2/finality/arbposted/wire.js';
import { concat, w32 } from './synth.js';

const CID = 421614n;
const addr = (b: number): Uint8Array => new Uint8Array(20).fill(b);
const word = (v: bigint): Uint8Array => {
  const o = new Uint8Array(32);
  for (let i = 31; i >= 0 && v > 0n; i--, v >>= 8n) o[i] = Number(v & 0xffn);
  return o;
};
const wordA = (a: Uint8Array): Uint8Array => concat(new Uint8Array(12), a);
const mk = (data: Uint8Array): Delayed => ({ msgKind: 9, sender: addr(0x11), msgBlockNumber: 5n, msgTimestamp: 6n, baseFeeL1: w32(9n), data, k: 77n });
/** the nine fixed words of a retryable: to, callvalue, deposit, maxSubmission, feeRefund, callvalueRefund, gas, maxFee, data length; then the data */
const HEAD_BYTES = 9 * 32;
const retryable = (lenWord: bigint, data: Uint8Array): Uint8Array =>
  concat(wordA(addr(0x22)), word(5n), word(100n), word(7n), wordA(addr(0x44)), wordA(addr(0x33)), word(21000n), word(3n), word(lenWord), data);

const MAX = MAX_L2_MESSAGE_SIZE;
/** the longest data a retryable can carry under the top-level cap */
const MAX_DATA = MAX - HEAD_BYTES;

describe('the retryable data-length bound and the top-level message cap', () => {
  it('the geometry: the cap is 262144, a retryable has 288 bytes before its data, so a word equal to the cap needs a message longer than the cap', () => {
    expect(MAX).toBe(262144);
    expect(HEAD_BYTES).toBe(288);
    expect(HEAD_BYTES + MAX).toBeGreaterThan(MAX);
    expect(MAX_DATA).toBe(261856);
  });

  it('the largest retryable that fits the cap derives (data 261856, message 262144) and one more data byte is refused by the top-level cap (N passes, N+1 fails)', () => {
    const d = new Uint8Array(MAX_DATA).fill(7);
    const m = retryable(BigInt(MAX_DATA), d);
    expect(m.length).toBe(MAX);
    expect(deriveDelayed(CID, mk(m))?.length).toBe(1);
    const over = retryable(BigInt(MAX_DATA + 1), new Uint8Array(MAX_DATA + 1).fill(7));
    expect(over.length).toBe(MAX + 1);
    expect(deriveDelayed(CID, mk(over))).toBeNull();
    // the declared length counts: a message of the maximal size that declares one byte more than it carries is refused by the data read
    expect(deriveDelayed(CID, mk(retryable(BigInt(MAX_DATA + 1), d)))).toBeNull();
    expect(deriveDelayed(CID, mk(retryable(BigInt(MAX_DATA - 1), d)))?.length).toBe(1);
  });

  it('a data-length word equal to the cap, and the words around it, are refused for every body length from the bare head to past the cap', () => {
    for (const lenWord of [BigInt(MAX - 1), BigInt(MAX), BigInt(MAX + 1)]) {
      for (const dataLen of [0, 1, 255, MAX_DATA - 1, MAX_DATA, MAX_DATA + 1, MAX - 1, MAX, MAX + 1]) {
        const m = retryable(lenWord, new Uint8Array(dataLen));
        expect(deriveDelayed(CID, mk(m)), `word ${lenWord} with ${dataLen} data bytes (message ${m.length})`).toBeNull();
      }
    }
  });

  it('a data-length word that is not a uint64, and the largest uint64, are refused', () => {
    const u64 = (1n << 64n) - 1n;
    for (const lenWord of [u64, u64 + 1n, 1n << 255n]) expect(deriveDelayed(CID, mk(retryable(lenWord, new Uint8Array(10))))).toBeNull();
  });
});
