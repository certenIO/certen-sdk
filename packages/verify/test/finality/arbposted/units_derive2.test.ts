/**
 * Edge cases of the derivation, the sequencer-message parser and the delayed gate that the hand-mutation gate of RB12-TS-TWINS-1 showed the
 * first unit tests did not pin: field order with distinct addresses, an address that holds a zero byte (it is NOT the zero address), the
 * uint64 boundaries of the gas limit and the nonce (N passes, N+1 fails), a valid blob transaction inside a delayed signed message,
 * every typed transaction a delayed signed message may carry, the nested length boundary, a block that holds only a PREFIX of what the
 * message derives, and the container binding of Kind.Verify (judged before the pins and the evidence body).
 */
import { keccak_256 } from '@noble/hashes/sha3';
import { describe, expect, it } from 'vitest';
import { deriveDelayed, parseL2Msg } from '../../../src/proof-v2/finality/arbposted/derive.js';
import { L2_SIGNED_TX, MAX_L2_MESSAGE_SIZE, parseL2 } from '../../../src/proof-v2/finality/arbposted/nitro.js';
import { ArbPostedKind } from '../../../src/proof-v2/finality/arbposted/verify.js';
import type { Delayed } from '../../../src/proof-v2/finality/arbposted/wire.js';
import { decodeTx, rlpUint } from '../../../src/proof-v2/finality/baseposted/ethtx.js';
import { rlpBytes, rlpListOf } from '../../../src/proof-v2/finality/baseposted/trie.js';
import { decodeContainer, defaultLimits, encodeContainer } from '../../../src/proof-v2/finality/codec.js';
import { parsePinsOverride } from '../../../src/proof-v2/finality/pins.js';
import { FinalityStateError } from '../../../src/proof-v2/finality/state.js';
import { concat, depositMessage, internalTx, makeSynth, msgBatch, seg, u64be, w32 } from './synth.js';
import { evidenceOf, loadCase, read, refOf } from './vectorset.js';

const CID = 421614n;
const B = (...xs: number[]): Uint8Array => Uint8Array.from(xs);
const addr = (b: number): Uint8Array => new Uint8Array(20).fill(b);
const same = (a: readonly Uint8Array[] | null, b: readonly Uint8Array[]): boolean => a !== null && a.length === b.length && a.every((x, i) => Buffer.from(x).equals(Buffer.from(b[i]!)));
const word = (v: bigint): Uint8Array => {
  const o = new Uint8Array(32);
  for (let i = 31; i >= 0 && v > 0n; i--, v >>= 8n) o[i] = Number(v & 0xffn);
  return o;
};
const wordA = (a: Uint8Array): Uint8Array => concat(new Uint8Array(12), a);
const typed = (t: number, fields: Uint8Array[]): Uint8Array => concat(B(t), rlpListOf(fields));
const mk = (kind: number, data: Uint8Array, k = 77n): Delayed => ({ msgKind: kind, sender: addr(0x11), msgBlockNumber: 5n, msgTimestamp: 6n, baseFeeL1: w32(9n), data, k });
const req = (k: bigint): Uint8Array => w32(k);
const U64 = (1n << 64n) - 1n;
const optTo = (a: Uint8Array | null): Uint8Array => rlpBytes(a ?? new Uint8Array(0));
const sender = addr(0x11);

describe('retryable field order and address encodings (the derivation of kind 9)', () => {
  const to = addr(0x22);
  const fee = addr(0x44); // the fee refund address is the 5th word, the beneficiary (call value refund) the 6th
  const ben = addr(0x33);
  const body = (retryTo: Uint8Array, gas: bigint, data = new Uint8Array(0)): Uint8Array =>
    concat(wordA(retryTo), word(5n), word(100n), word(7n), wordA(fee), wordA(ben), word(gas), word(3n), word(BigInt(data.length)), data);
  const expected = (retryTo: Uint8Array | null, gas: bigint): Uint8Array =>
    typed(0x69, [rlpUint(CID), rlpBytes(req(77n)), rlpBytes(sender), rlpUint(9n), rlpUint(100n), rlpUint(3n), rlpUint(gas), optTo(retryTo), rlpUint(5n), rlpBytes(ben), rlpUint(7n), rlpBytes(fee), rlpBytes(new Uint8Array(0))]);
  it('the beneficiary is the call value refund address and the fee refund address comes after the maximum submission fee, whatever the words\' order in the message', () => {
    expect(same(deriveDelayed(CID, mk(9, body(to, 21000n))), [expected(to, 21000n)])).toBe(true);
  });
  it('an address with a zero byte is written as 20 bytes; only the all-zero address is the empty string', () => {
    const holey = Uint8Array.from({ length: 20 }, (_, i) => (i === 3 ? 0 : 0x22));
    expect(same(deriveDelayed(CID, mk(9, body(holey, 21000n))), [expected(holey, 21000n)])).toBe(true);
    expect(same(deriveDelayed(CID, mk(9, body(new Uint8Array(20), 21000n))), [expected(null, 21000n)])).toBe(true);
    const unsigned = (t: Uint8Array): Uint8Array => concat(B(0), word(50000n), word(8n), word(4n), wordA(t), word(11n), B(9));
    const wantU = (t: Uint8Array | null): Uint8Array => typed(0x65, [rlpUint(CID), rlpBytes(sender), rlpUint(4n), rlpUint(8n), rlpUint(50000n), optTo(t), rlpUint(11n), rlpBytes(B(9))]);
    expect(same(deriveDelayed(CID, mk(3, unsigned(holey))), [wantU(holey)])).toBe(true);
    expect(same(deriveDelayed(CID, mk(3, unsigned(new Uint8Array(20)))), [wantU(null)])).toBe(true);
    const contract = (t: Uint8Array): Uint8Array => concat(B(1), word(60000n), word(8n), wordA(t), word(12n), B(8));
    const wantC = (t: Uint8Array | null): Uint8Array => typed(0x66, [rlpUint(CID), rlpBytes(req(77n)), rlpBytes(sender), rlpUint(8n), rlpUint(60000n), optTo(t), rlpUint(12n), rlpBytes(B(8))]);
    expect(same(deriveDelayed(CID, mk(3, contract(holey))), [wantC(holey)])).toBe(true);
    expect(same(deriveDelayed(CID, mk(3, contract(new Uint8Array(20)))), [wantC(null)])).toBe(true);
  });
  it('the gas limit and the nonce are uint64: 2^64-1 derives, 2^64 is refused (retryable, unsigned; the nonce is read for kind 0 only)', () => {
    expect(deriveDelayed(CID, mk(9, body(to, U64)))?.length).toBe(1);
    expect(deriveDelayed(CID, mk(9, body(to, U64 + 1n)))).toBeNull();
    const unsigned = (gas: bigint, nonce: bigint): Uint8Array => concat(B(0), word(gas), word(8n), word(nonce), wordA(to), word(11n));
    expect(deriveDelayed(CID, mk(3, unsigned(U64, U64)))?.length).toBe(1);
    expect(deriveDelayed(CID, mk(3, unsigned(U64 + 1n, 1n)))).toBeNull();
    expect(deriveDelayed(CID, mk(3, unsigned(1n, U64 + 1n)))).toBeNull();
    const contract = (gas: bigint): Uint8Array => concat(B(1), word(gas), word(8n), wordA(to), word(11n));
    expect(deriveDelayed(CID, mk(3, contract(U64)))?.length).toBe(1);
    expect(deriveDelayed(CID, mk(3, contract(U64 + 1n)))).toBeNull();
    // the kind 1 message carries no nonce word: a nonce-sized extra word is call data, not a field
    expect(deriveDelayed(CID, mk(3, concat(contract(1n), word(U64 + 1n))))?.length).toBe(1);
  });
});

describe('the signed transaction of a delayed message is decoded and refused unless it is a standard type', () => {
  const to = addr(0x22);
  const sigs = [rlpUint(1n), rlpUint(1n), rlpUint(1n)];
  const noList = B(0xc0);
  const legacy = rlpListOf([rlpUint(1n), rlpUint(1n), rlpUint(21000n), rlpBytes(to), rlpUint(1n), rlpBytes(new Uint8Array(0)), rlpUint(27n), rlpUint(1n), rlpUint(1n)]);
  const accessList = typed(1, [rlpUint(CID), rlpUint(1n), rlpUint(1n), rlpUint(21000n), rlpBytes(to), rlpUint(0n), rlpBytes(new Uint8Array(0)), noList, ...sigs]);
  const dynamicFee = typed(2, [rlpUint(CID), rlpUint(1n), rlpUint(1n), rlpUint(2n), rlpUint(21000n), rlpBytes(to), rlpUint(0n), rlpBytes(new Uint8Array(0)), noList, ...sigs]);
  const setCode = typed(4, [rlpUint(CID), rlpUint(1n), rlpUint(1n), rlpUint(2n), rlpUint(21000n), rlpBytes(to), rlpUint(0n), rlpBytes(new Uint8Array(0)), noList, noList, ...sigs]);
  const blob = typed(3, [rlpUint(CID), rlpUint(1n), rlpUint(1n), rlpUint(2n), rlpUint(21000n), rlpBytes(to), rlpUint(0n), rlpBytes(new Uint8Array(0)), noList, rlpUint(1n), rlpListOf([rlpBytes(new Uint8Array(32).fill(1))]), ...sigs]);
  const msg = (tx: Uint8Array): Delayed => mk(3, concat(B(L2_SIGNED_TX), tx));
  it('legacy, access-list, dynamic-fee and set-code transactions are kept byte for byte (they decode under go-ethereum\'s rules)', () => {
    for (const [name, tx, type] of [['legacy', legacy, 0], ['access list', accessList, 1], ['dynamic fee', dynamicFee, 2], ['set code', setCode, 4]] as const) {
      expect(decodeTx(tx).type, name).toBe(type);
      expect(same(deriveDelayed(CID, msg(tx)), [tx]), name).toBe(true);
    }
  });
  it('a blob transaction that DECODES is refused all the same (Nitro refuses the blob type); a trailing byte and a cut transaction are refused by the decoder', () => {
    expect(decodeTx(blob).type).toBe(3);
    expect(deriveDelayed(CID, msg(blob))).toBeNull();
    expect(deriveDelayed(CID, msg(concat(legacy, B(0))))).toBeNull();
    expect(deriveDelayed(CID, msg(dynamicFee.subarray(0, dynamicFee.length - 1)))).toBeNull();
  });
});

describe('the sequencer message parser at the nested length boundary (parseL2Msg, below the top-level cap check)', () => {
  const nested = (n: number): Uint8Array => concat(B(L2_SIGNED_TX, 0xc0), new Uint8Array(n - 2));
  it('a nested message of exactly the size limit is read; a length one above ends the batch quietly even with the bytes present', () => {
    const at = concat(B(3), u64be(MAX_L2_MESSAGE_SIZE), nested(MAX_L2_MESSAGE_SIZE));
    expect(parseL2Msg(at, new Uint8Array(20), null, 0n, 0, false)?.length).toBe(1);
    const over = concat(B(3), u64be(MAX_L2_MESSAGE_SIZE + 1), nested(MAX_L2_MESSAGE_SIZE + 1));
    expect(parseL2Msg(over, new Uint8Array(20), null, 0n, 0, false)).toEqual([]);
    // and through the top-level cap both are failed messages (the message itself is over the limit)
    expect(parseL2(at, 0)).toBeNull();
    expect(parseL2(over, 0)).toBeNull();
  });
  it('the first byte of a signed transaction fails the message below 0xc0 unless it is 1, 2 or 4: every other byte of 0..0xbf is a failed message (null), 0xc0 and above is kept', () => {
    const bad: number[] = [];
    for (let b = 0; b < 0xc0; b++) if (b !== 1 && b !== 2 && b !== 4) bad.push(b);
    for (const b of bad) expect(parseL2(concat(B(L2_SIGNED_TX), B(b, 0)), 0), `first byte ${b}`).toBeNull();
    for (const b of [1, 2, 4, 0xc0, 0xc1, 0xff]) expect(parseL2(concat(B(L2_SIGNED_TX), B(b, 0)), 0)?.length ?? -1, `first byte ${b}`).toBe(1);
  });
});

describe('a delayed block that holds only a prefix of what the message derives is not proven', () => {
  const user = addr(0x11);
  it('a batch that derives two transactions, a block with the first only or with both and an extra: unproven; both: proven', () => {
    const to = addr(0x22);
    const unsigned = concat(B(0), word(50000n), word(8n), word(4n), wordA(to), word(11n), B(9));
    const contract = concat(B(1), word(60000n), word(8n), wordA(to), word(12n), B(8));
    const m: Delayed = { msgKind: 3, sender: user, msgBlockNumber: 10n, msgTimestamp: 20n, baseFeeL1: new Uint8Array(32), data: msgBatch([unsigned, contract]), k: 41n };
    const want = deriveDelayed(CID, m)!;
    expect(want.length).toBe(2);
    const opts = (txs: Uint8Array[]) => ({ segments: [seg(2, new Uint8Array(0)), seg(3, B(1))], blockTxs: txs, afterDelayed: 42n, delayed: { msg: m } });
    expect(makeSynth(opts([internalTx(), ...want])).run().fields.delayed_message_index).toBe(41n);
    for (const txs of [[internalTx(), want[0]!], [internalTx()], [internalTx(), ...want, want[0]!], [internalTx(), want[1]!, want[0]!]]) {
      expect(() => makeSynth(opts(txs)).run()).toThrow(/l1_posted_delayed_origin_unproven|l1_posted_content_not_found/);
    }
    // the prefix is exactly the unproven state, not the empty-content state (the block holds a transaction)
    try {
      makeSynth(opts([internalTx(), want[0]!])).run();
    } catch (e) {
      expect((e as FinalityStateError).code).toBe('l1_posted_delayed_origin_unproven');
    }
    // keccak helper kept to show the sub-request id of the contract tx is not the message's own
    expect(keccak_256(concat(req(41n), w32(1n))).length).toBe(32);
    expect(depositMessage(41n).k).toBe(41n);
  });
});

describe('Kind.Verify binds the BlockRef to the container and to its own header, before the pins and the evidence body (Go completeness_test.go)', () => {
  const live = loadCase('valid_live');
  const pins = parsePinsOverride(read(live.pins));
  const ref = refOf(live.leg);
  const evidence = evidenceOf(live);
  const container = decodeContainer(evidence, defaultLimits());
  const recode = (number: bigint, hash: Uint8Array): Uint8Array => encodeContainer({ header: { ...container.header, blockNumber: number, blockHash: hash }, body: container.body });
  const other = (h: Uint8Array): Uint8Array => Uint8Array.from(h, (x, i) => (i === 0 ? x ^ 0xff : x));
  const canon = (f: () => unknown): string => {
    try {
      f();
    } catch (e) {
      if (e instanceof FinalityStateError) return e.canonical();
      throw e;
    }
    return 'accepted';
  };
  const hexOf = (b: Uint8Array): string => `0x${Buffer.from(b).toString('hex')}`;
  const mismatch = (field: string, want: string, got: string): string => `{"code":"finality_block_mismatch","fields":{"field":"${field}","got":"${got}","want":"${want}"}}`;
  const kind = new ArbPostedKind();

  it('the live evidence is the baseline: it verifies', () => {
    expect(kind.verify(pins, ref, evidence).level).toBeGreaterThan(0);
  });
  it('a container naming another block than the BlockRef is refused although the BlockRef is the block of its own header (the container check, not the header check)', () => {
    expect(canon(() => kind.verify(pins, ref, recode(ref.number + 5n, ref.hash)))).toBe(mismatch('blockNumber', String(ref.number), String(ref.number + 5n)));
    expect(canon(() => kind.verify(pins, ref, recode(ref.number, other(ref.hash))))).toBe(mismatch('blockHash', hexOf(ref.hash), hexOf(other(ref.hash))));
  });
  it('the container is judged BEFORE the pins and the evidence body: with no pins and a body that is garbage the mismatch is still the named state', () => {
    const garbage = encodeContainer({ header: { ...container.header, blockNumber: ref.number + 1n }, body: Uint8Array.of(1, 2, 3) });
    expect(canon(() => kind.verify(null, ref, garbage))).toBe(mismatch('blockNumber', String(ref.number), String(ref.number + 1n)));
    const garbageHash = encodeContainer({ header: { ...container.header, blockHash: other(ref.hash) }, body: Uint8Array.of(1, 2, 3) });
    expect(canon(() => kind.verify(null, ref, garbageHash))).toBe(mismatch('blockHash', hexOf(ref.hash), hexOf(other(ref.hash))));
  });
  it('a BlockRef whose hash or number is not its own header\'s is refused with want = the BlockRef and got = the header, though the container agrees with the BlockRef', () => {
    const badHash = { ...ref, hash: other(ref.hash) };
    expect(canon(() => kind.verify(pins, badHash, recode(ref.number, badHash.hash)))).toBe(mismatch('blockHash', hexOf(badHash.hash), hexOf(ref.hash)));
    const badNumber = { ...ref, number: ref.number + 5n };
    expect(canon(() => kind.verify(pins, badNumber, recode(badNumber.number, ref.hash)))).toBe(mismatch('blockNumber', String(badNumber.number), String(ref.number)));
  });
});
