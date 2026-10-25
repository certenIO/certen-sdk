/**
 * Unit twins of the validator's derive_test.go, derive_gate_test.go, seqmsg_test.go, completeness_test.go and strict_test.go (pv2/rb11-e1-raise
 * @cbb6373): the zero-heavy layer, the derivation of every delayed message kind (expected encodings restated here from the field order of
 * go-ethereum's arb_types.go, not taken from the derivation), the all-or-nothing sequencer message, the delayed gate, the size boundaries and
 * the strict Brotli layer inside a batch. Inputs and expectations are those of the Go tests.
 */
import { keccak_256 } from '@noble/hashes/sha3';
import { brotliCompressSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { MSG_KIND_ETH_DEPOSIT, TX_DEPOSIT } from '../../../src/proof-v2/finality/arbposted/delayed.js';
import { deriveDelayed } from '../../../src/proof-v2/finality/arbposted/derive.js';
import {
  L2_BATCH,
  L2_SIGNED_TX,
  MAX_L2_MESSAGE_SIZE,
  PayloadOK,
  PayloadTooLarge,
  PayloadUndecodable,
  PayloadUnknownHeader,
  decodePayload,
  parseL2,
} from '../../../src/proof-v2/finality/arbposted/nitro.js';
import { zeroheavyDecode } from '../../../src/proof-v2/finality/arbposted/zeroheavy.js';
import type { Delayed } from '../../../src/proof-v2/finality/arbposted/wire.js';
import { rlpUint } from '../../../src/proof-v2/finality/baseposted/ethtx.js';
import { rlpBytes, rlpListOf } from '../../../src/proof-v2/finality/baseposted/trie.js';
import { FinalityStateError } from '../../../src/proof-v2/finality/state.js';
import { concat, depositMessage, hex, internalTx, makeSynth, msgBatch, msgTx, payloadOf, seg, u64be, w32, zhEncode, zhPayload, type SynthOpts } from './synth.js';

const CID = 421614n;
const same = (a: readonly Uint8Array[] | null, b: readonly Uint8Array[]): boolean => a !== null && a.length === b.length && a.every((x, i) => Buffer.from(x).equals(Buffer.from(b[i]!)));
const addr = (b: number): Uint8Array => new Uint8Array(20).fill(b);
const wordU = (v: bigint | number): Uint8Array => w32(BigInt(v));
const wordA = (a: Uint8Array): Uint8Array => concat(new Uint8Array(12), a);
const word = (v: bigint): Uint8Array => {
  const o = new Uint8Array(32);
  for (let i = 31; i >= 0 && v > 0n; i--, v >>= 8n) o[i] = Number(v & 0xffn);
  return o;
};
/** a valid legacy signed transaction encoding (nine canonical fields): decodes under go-ethereum's rules, signature unchecked */
const legacyTx = (n: number): Uint8Array =>
  rlpListOf([rlpUint(BigInt(n)), rlpUint(1n), rlpUint(21000n), rlpBytes(addr(0x22)), rlpUint(1n), rlpBytes(new Uint8Array(0)), rlpUint(27n), rlpUint(1n), rlpUint(1n)]);
const signedTxMsg = (tx: Uint8Array): Uint8Array => concat(Uint8Array.of(L2_SIGNED_TX), tx);
const B = (...xs: number[]): Uint8Array => Uint8Array.from(xs);
const typed = (t: number, fields: Uint8Array[]): Uint8Array => concat(Uint8Array.of(t), rlpListOf(fields));
const req = (k: bigint): Uint8Array => w32(k);
const sub = (r: Uint8Array, i: bigint): Uint8Array => keccak_256(concat(r, w32(i)));

describe('the zero-heavy layer (nitro zeroheavy.ZeroheavyDecoder)', () => {
  it('decodes what nitro\'s encoder writes: the empty input, every single byte, 300 seeded mixes of zeros and noise, and the bound is exact (n passes, n-1 exceeds)', () => {
    expect(zeroheavyDecode(new Uint8Array(0), 10)).toEqual({ out: new Uint8Array(0), exceeded: false });
    for (let i = 0; i < 256; i++) {
      const r = zeroheavyDecode(zhEncode(Uint8Array.of(i)), 10);
      expect([r.exceeded, Array.from(r.out)], `byte ${i}`).toEqual([false, [i]]);
    }
    let x = 9;
    const rnd = (n: number): number => {
      x = (Math.imul(x, 1103515245) + 12345) & 0x7fffffff;
      return x % n;
    };
    for (let n = 0; n < 300; n++) {
      const input = Uint8Array.from({ length: 1 + rnd(300) }, () => (rnd(3) !== 0 ? 0 : rnd(256)));
      const r = zeroheavyDecode(zhEncode(input), input.length);
      expect(r.exceeded).toBe(false);
      expect(Buffer.from(r.out).equals(Buffer.from(input))).toBe(true);
      expect(zeroheavyDecode(zhEncode(input), input.length - 1).exceeded, `bound ${input.length - 1}`).toBe(true);
    }
  });
  it('hostile input: a run of 0xff bytes grows the deferred ones but allocates and decodes in bounded time; a bound of zero exceeds on the first byte; bits left over are never emitted', () => {
    const t0 = Date.now();
    const ones = new Uint8Array(4 * 1024 * 1024).fill(0xff);
    ones[0] = 0x00; // a leading zero byte defers the ones that follow
    const r = zeroheavyDecode(ones, 100);
    expect(r.out.length === 0 || r.out.length <= 100).toBe(true);
    expect(Date.now() - t0).toBeLessThan(10_000);
    // a zero byte is two bits and the last zero stays deferred: four zero bytes hold seven bits, five hold the first byte (n passes, n-1 exceeds)
    expect(zeroheavyDecode(new Uint8Array(4), 0)).toEqual({ out: new Uint8Array(0), exceeded: false });
    expect(zeroheavyDecode(new Uint8Array(5), 0).exceeded).toBe(true);
    expect(zeroheavyDecode(new Uint8Array(5), 1)).toEqual({ out: Uint8Array.of(0), exceeded: false });
    expect(zeroheavyDecode(Uint8Array.of(0), 5)).toEqual({ out: new Uint8Array(0), exceeded: false }); // two bits are not a byte
  });
});

describe('a zero-heavy payload is decoded once and then read as a Brotli payload (nitro arbstate/inbox.go Stage 2)', () => {
  const a = legacyTx(1);
  const b = legacyTx(2);
  const inner = payloadOf(concat(seg(0, signedTxMsg(a)), seg(0, msgBatch([signedTxMsg(a), signedTxMsg(b)]))));
  it('the decoded layer is the payload: two messages, the second holds both transactions', () => {
    const r = decodePayload(zhPayload(inner), 1 << 20, 100);
    expect([r.status, r.messages.length]).toEqual([PayloadOK, 2]);
    expect(same(r.messages[1]!.txs, [a, b])).toBe(true);
  });
  it('the first byte after the layer is judged: DAS, a second zero-heavy flag and an unknown byte are l1_batch_header_unknown with that byte; the flag alone is undecodable', () => {
    const cases: [string, Uint8Array, number][] = [
      ['das after the layer is not a DAS payload', concat(B(0x80), inner.subarray(1)), 0x80],
      ['a second zero-heavy layer is not decoded', zhPayload(inner), 0x20],
      ['unknown byte', concat(B(0x07), inner.subarray(1)), 0x07],
    ];
    for (const [name, innerBytes, hdr] of cases) {
      const r = decodePayload(zhPayload(innerBytes), 1 << 20, 100);
      expect([name, r.status, r.headerByte]).toEqual([name, PayloadUnknownHeader, hdr]);
    }
    expect(decodePayload(B(0x20), 1 << 20, 100).status).toBe(PayloadUndecodable);
  });
  it('a Brotli stream cut short inside the layer is refused like any other; the layer\'s own bound is 101% of the batch bound plus 64 (n passes, n+1 is a bomb)', () => {
    expect(decodePayload(zhPayload(inner.subarray(0, inner.length - 1)), 1 << 20, 100).status).toBe(PayloadUndecodable);
    const bomb = concat(B(0), new Uint8Array(5000));
    const r = decodePayload(zhPayload(bomb), 1000, 100);
    expect([r.status, r.exceededUncompressed]).toEqual([PayloadTooLarge, true]);
    // the exact bound: maxUncompressed 1000 -> 1000 + 10 + 64 = 1074 decoded bytes pass the layer, 1075 do not
    const at = concat(B(0), new Uint8Array(1073)); // 1074 bytes, a Brotli header byte then zeros: passes the layer, fails as Brotli
    const over = concat(B(0), new Uint8Array(1074));
    expect(decodePayload(zhPayload(at), 1000, 100).status).toBe(PayloadUndecodable);
    expect(decodePayload(zhPayload(over), 1000, 100)).toMatchObject({ status: PayloadTooLarge, exceededUncompressed: true });
  });
});

describe('delayed messages derive what Nitro builds (known answers from the field order of arb_types.go)', () => {
  const sender = addr(0x11);
  const to = addr(0x22);
  // two DIFFERENT refund addresses: the wire order is feeRefund (the excess-fee refund address) then callvalueRefund (the beneficiary), and the
  // transaction carries Beneficiary before FeeRefundAddr; one address for both let a swap of the two pass every test (RB12-ARBFINAL-FIX, G3).
  const feeRefund = addr(0x33);
  const beneficiary = addr(0x44);
  const k = 77n;
  const baseMsg = (kind: number, data: Uint8Array): Delayed => ({ msgKind: kind, sender, msgBlockNumber: 5n, msgTimestamp: 6n, baseFeeL1: w32(9n), data, k });
  const optTo = (a: Uint8Array | null): Uint8Array => rlpBytes(a ?? new Uint8Array(0));
  const unsignedTx = (nonce: bigint, fee: bigint, gas: bigint, t: Uint8Array | null, value: bigint, data: Uint8Array): Uint8Array =>
    typed(0x65, [rlpUint(CID), rlpBytes(sender), rlpUint(nonce), rlpUint(fee), rlpUint(gas), optTo(t), rlpUint(value), rlpBytes(data)]);
  const contractTx = (r: Uint8Array, fee: bigint, gas: bigint, t: Uint8Array | null, value: bigint, data: Uint8Array): Uint8Array =>
    typed(0x66, [rlpUint(CID), rlpBytes(r), rlpBytes(sender), rlpUint(fee), rlpUint(gas), optTo(t), rlpUint(value), rlpBytes(data)]);
  const retryableTx = (callvalue: bigint, deposit: bigint, retryTo: Uint8Array | null, data: Uint8Array): Uint8Array =>
    typed(0x69, [rlpUint(CID), rlpBytes(req(k)), rlpBytes(sender), rlpUint(9n), rlpUint(deposit), rlpUint(3n), rlpUint(21000n), optTo(retryTo), rlpUint(callvalue), rlpBytes(beneficiary), rlpUint(7n), rlpBytes(feeRefund), rlpBytes(data)]);
  const depositTx = (r: Uint8Array, from: Uint8Array, t: Uint8Array, value: bigint): Uint8Array =>
    typed(0x64, [rlpUint(CID), rlpBytes(r), rlpBytes(from), rlpBytes(t), rlpUint(value)]);
  const unsignedBody = concat(wordU(50000), wordU(8), wordU(4), wordA(to), wordU(11), B(9, 9));
  const contractBody = concat(wordU(60000), wordU(8), wordA(to), wordU(12), B(8));

  it('submit retryable (kind 9): the 13 fields in order; the zero address as the retry target is the empty string; a short body and a gas limit over 2^64 are refused', () => {
    const retryData = B(1, 2, 3, 4);
    const rd = concat(wordA(to), wordU(5), wordU(100), wordU(7), wordA(feeRefund), wordA(beneficiary), wordU(21000), wordU(3), wordU(retryData.length), retryData);
    expect(same(deriveDelayed(CID, baseMsg(9, rd)), [retryableTx(5n, 100n, to, retryData)])).toBe(true);
    const zero = concat(wordA(new Uint8Array(20)), wordU(5), wordU(100), wordU(7), wordA(feeRefund), wordA(beneficiary), wordU(21000), wordU(3), wordU(0));
    expect(same(deriveDelayed(CID, baseMsg(9, zero)), [retryableTx(5n, 100n, null, new Uint8Array(0))])).toBe(true);
    expect(deriveDelayed(CID, baseMsg(9, rd.subarray(0, rd.length - 2)))).toBeNull();
    expect(deriveDelayed(CID, baseMsg(9, concat(wordA(to), wordU(5), wordU(100), wordU(7), wordA(feeRefund), wordA(beneficiary), word(1n << 70n), wordU(3), wordU(0))))).toBeNull();
  });
  it('L2 message (kind 3): unsigned (0x65), contract (0x66, request id = the delayed index), a batch (the contract tx gets keccak(requestId || index)), a signed tx kept as is', () => {
    const wantU = unsignedTx(4n, 8n, 50000n, to, 11n, B(9, 9));
    expect(same(deriveDelayed(CID, baseMsg(3, concat(B(0), unsignedBody))), [wantU])).toBe(true);
    expect(same(deriveDelayed(CID, baseMsg(3, concat(B(1), contractBody))), [contractTx(req(k), 8n, 60000n, to, 12n, B(8))])).toBe(true);
    const batch = msgBatch([concat(B(0), unsignedBody), concat(B(1), contractBody)]);
    expect(same(deriveDelayed(CID, baseMsg(3, batch)), [wantU, contractTx(sub(req(k), 1n), 8n, 60000n, to, 12n, B(8))])).toBe(true);
    const tx = legacyTx(5);
    expect(same(deriveDelayed(CID, baseMsg(3, signedTxMsg(tx))), [tx])).toBe(true);
  });
  it('a nested failure fails the whole message, and so does every L2 kind Nitro refuses; 16 nested batches are the most', () => {
    expect(deriveDelayed(CID, baseMsg(3, msgBatch([concat(B(0), unsignedBody), B(2, 0, 0)])))).toBeNull();
    for (const kind of [2, 5, 6, 7, 8, 9]) expect(deriveDelayed(CID, baseMsg(3, B(kind, 1, 2, 3))), `L2 kind ${kind}`).toBeNull();
    let deep = concat(B(1), contractBody);
    for (let i = 0; i < 16; i++) deep = msgBatch([deep]);
    expect(deriveDelayed(CID, baseMsg(3, deep))?.length).toBe(1);
    expect(deriveDelayed(CID, baseMsg(3, msgBatch([deep])))).toBeNull();
  });
  it('L2 funded by L1 (kind 7): a deposit to the poster with From unset, then the unsigned tx under the second sub-request id; L2 kind 4 is refused', () => {
    const depID = sub(req(k), 0n);
    const unID = sub(req(k), 1n);
    const want = [depositTx(depID, new Uint8Array(20), sender, 12n), contractTx(unID, 8n, 60000n, to, 12n, B(8))];
    expect(same(deriveDelayed(CID, baseMsg(7, concat(B(1), contractBody))), want)).toBe(true);
    expect(deriveDelayed(CID, baseMsg(7, concat(B(4), contractBody)))).toBeNull();
  });
  it('ETH deposit (kind 12) is the 0x64 transaction of the first 52 bytes; kinds with no derivation and an oversize message are refused', () => {
    const data = concat(to, wordU(77));
    expect(same(deriveDelayed(CID, baseMsg(MSG_KIND_ETH_DEPOSIT, data)), [depositTx(req(k), sender, to, 77n)])).toBe(true);
    expect(TX_DEPOSIT).toBe(0x64);
    // the request id is the delayed message index, not the block number or the timestamp of the message
    expect(same(deriveDelayed(CID, baseMsg(MSG_KIND_ETH_DEPOSIT, data)), [depositTx(req(5n), sender, to, 77n)])).toBe(false);
    // From is the poster and To the address in the first 20 bytes: a swap of the two, or of either with the value, changes the bytes
    expect(same(deriveDelayed(CID, baseMsg(MSG_KIND_ETH_DEPOSIT, data)), [depositTx(req(k), to, sender, 77n)])).toBe(false);
    for (const kind of [0, 1, 2, 4, 5, 6, 8, 10, 11, 13, 255]) expect(deriveDelayed(CID, baseMsg(kind, B(1))), `message kind ${kind}`).toBeNull();
    expect(deriveDelayed(CID, baseMsg(MSG_KIND_ETH_DEPOSIT, new Uint8Array(MAX_L2_MESSAGE_SIZE + 1)))).toBeNull();
  });
});

describe('malformed delayed messages are not derived (every refusal path)', () => {
  const sender = addr(0x11);
  const to = addr(0x22);
  const mk = (kind: number, data: Uint8Array): Delayed => ({ msgKind: kind, sender, msgBlockNumber: 0n, msgTimestamp: 0n, baseFeeL1: new Uint8Array(32), data, k: 5n });
  const over64 = word(1n << 70n);
  it('each by a message that reaches exactly that path', () => {
    const cases: Record<string, Delayed> = {
      'ETH deposit with 51 bytes': mk(12, new Uint8Array(51)),
      'ETH deposit empty': mk(12, new Uint8Array(0)),
      'L2 message empty': mk(3, new Uint8Array(0)),
      'unsigned tx with a gas limit >= 2^64': mk(3, concat(B(0), over64, wordU(1), wordU(1), wordA(to), wordU(1))),
      'unsigned tx with a nonce >= 2^64': mk(3, concat(B(0), wordU(1), wordU(1), over64, wordA(to), wordU(1))),
      'unsigned tx cut after the gas limit': mk(3, concat(B(0), wordU(1))),
      'contract tx cut before the value': mk(3, concat(B(1), wordU(1), wordU(1), wordA(to))),
      'signed tx that is not a transaction': mk(3, B(4, 0xde, 0xad)),
      'signed tx of an Arbitrum type': mk(3, B(4, 0x64, 0xc0)),
      'signed tx of the blob type': mk(3, B(4, 0x03, 0xc0)),
      'funded by L1 empty': mk(7, new Uint8Array(0)),
      'funded by L1 cut': mk(7, B(1, 1, 2)),
      'retryable cut before the data': mk(9, concat(wordA(to), wordU(1), wordU(1), wordU(1), wordA(to), wordA(to), wordU(1), wordU(1), wordU(10), B(1, 2))),
      'retryable data length >= 2^64': mk(9, concat(wordA(to), wordU(1), wordU(1), wordU(1), wordA(to), wordA(to), wordU(1), wordU(1), over64)),
      'retryable data length over the limit': mk(9, concat(wordA(to), wordU(1), wordU(1), wordU(1), wordA(to), wordA(to), wordU(1), wordU(1), wordU(MAX_L2_MESSAGE_SIZE + 1))),
    };
    for (const [name, d] of Object.entries(cases)) expect(deriveDelayed(CID, d), name).toBeNull();
  });
  it('a batch whose last length prefix is cut, oversize, or whose nested message is cut ends quietly with what it has; an empty nested message fails the whole message; a message of exactly the size limit passes the size check', () => {
    const good = concat(B(1), wordU(1), wordU(1), wordA(to), wordU(1));
    const one = msgBatch([good]);
    const tails: Record<string, Uint8Array> = { 'cut length': B(0, 0, 0), 'oversize length': u64be(MAX_L2_MESSAGE_SIZE + 1), 'cut nested': concat(u64be(50), B(1, 2)) };
    for (const [name, tail] of Object.entries(tails)) expect(deriveDelayed(CID, mk(3, concat(one, tail)))?.length, name).toBe(1);
    expect(deriveDelayed(CID, mk(3, concat(one, u64be(0))))).toBeNull();
    expect(deriveDelayed(CID, mk(12, new Uint8Array(MAX_L2_MESSAGE_SIZE)))).not.toBeNull();
  });
});

describe('the delayed gate under the synthetic Bridge', () => {
  const k = 41n;
  const wantOf = (msg: Delayed): Uint8Array[] => deriveDelayed(CID, msg)!;
  const world = (msg: Delayed, blockTxs: Uint8Array[], extra: SynthOpts = {}): SynthOpts => ({
    segments: [seg(2, new Uint8Array(0)), seg(3, B(1))],
    blockTxs,
    afterDelayed: msg.k + 1n,
    delayed: { msg },
    ...extra,
  });
  const noContent = '{"code":"l1_posted_content_not_found","fields":{"batch":"77","reason":"no_standard_transactions"}}';
  const user = addr(0x11);
  const emptyBatch = (kk: bigint = k): Delayed => ({ msgKind: 3, sender: user, msgBlockNumber: 10n, msgTimestamp: 20n, baseFeeL1: new Uint8Array(32), data: B(L2_BATCH), k: kk });
  const run = (o: SynthOpts): string => {
    try {
      return JSON.stringify(makeSynth(o).run().fields, (_k, v) => (typeof v === 'bigint' ? v.toString() : v instanceof Uint8Array ? hex(v) : v));
    } catch (e) {
      if (e instanceof FinalityStateError) return e.canonical();
      throw e;
    }
  };

  it('a delayed message that derives nothing proves nothing: a block of only the internal / retry transactions, or no transaction, is no_standard_transactions, never l1_posted', () => {
    expect(deriveDelayed(CID, emptyBatch())).toEqual([]);
    for (const [name, txs] of Object.entries({
      'only the internal start-block transaction': [internalTx()],
      'no transactions at all': [],
      'internal and retry transactions only': [internalTx(), concat(B(0x68), B(0xc0))],
    })) {
      expect(run(world(emptyBatch(), txs)), name).toBe(noContent);
    }
  });
  it('the guard sits after the byte-for-byte comparison: a block holding a transaction the message does not derive keeps l1_posted_delayed_origin_unproven', () => {
    const got = run(world(emptyBatch(), [internalTx(), legacyTx(1)]));
    expect(got).toBe(
      `{"code":"l1_posted_delayed_origin_unproven","fields":{"block_tx_types":["106","0"],"header_nonce":"2224515","k":"41","message_kind":"3"}}`,
    );
  });
  it('a kind with no derivation is unproven even for a block of internal transactions only (the empty derivation would otherwise equal the empty block)', () => {
    const m: Delayed = { ...emptyBatch(4n), msgKind: 13, data: B(1, 2, 3) };
    expect(run(world(m, [internalTx()]))).toBe(
      `{"code":"l1_posted_delayed_origin_unproven","fields":{"block_tx_types":["106"],"header_nonce":"2224515","k":"4","message_kind":"13"}}`,
    );
  });
  it('a delayed section on a block of standard transactions only is judged by the derivation too (no message ordinal)', () => {
    const m = depositMessage(k);
    const v = makeSynth(world(m, [internalTx(), ...wantOf(m)])).run();
    expect(v.fields.delayed_message_index).toBe(41n);
    expect(v.fields.message_ordinal).toBeUndefined();
    const std = world(m, [internalTx(), legacyTx(1)]);
    expect(run(std)).toContain('l1_posted_delayed_origin_unproven');
  });
  it('the accumulators of k and of its predecessor must be PROVEN (a missing node is a state-proof failure, not a mismatch); k = 0 reads no predecessor', () => {
    const m = depositMessage(k);
    const ok = makeSynth(world(m, [internalTx(), ...wantOf(m)]));
    expect(ok.run().fields.delayed_message_index).toBe(41n);
    // k = 0: a value at the index just below the array (2^256 - 1 wraps there) is never taken for a predecessor
    const m0 = depositMessage(0n);
    const z = makeSynth({ ...world(m0, [internalTx(), ...wantOf(m0)]), poisonBeforeFirst: true });
    expect(z.run().fields.delayed_message_index).toBe(0n);
    // k = 1 reads slot 0
    const m1 = depositMessage(1n);
    expect(makeSynth(world(m1, [internalTx(), ...wantOf(m1)])).run().fields.delayed_message_index).toBe(1n);
  });
});

describe('nested size limit and the first byte of a signed transaction (parseL2)', () => {
  const t1 = legacyTx(1);
  const tx = (n: number): Uint8Array => concat(B(L2_SIGNED_TX, 0xc0), new Uint8Array(n - 2)); // a message of n bytes
  const biggest = MAX_L2_MESSAGE_SIZE - 1 - 8 - signedTxMsg(t1).length - 8;
  it('the largest nested message that fits a top-level message within the limit is read in full; one byte more makes the TOP-LEVEL message too large and Nitro drops it whole', () => {
    const fits = msgBatch([signedTxMsg(t1), tx(biggest)]);
    expect(fits.length).toBe(MAX_L2_MESSAGE_SIZE);
    expect(parseL2(fits, 0)?.length).toBe(2);
    expect(parseL2(msgBatch([signedTxMsg(t1), tx(biggest + 1)]), 0)).toBeNull();
    for (const n of [MAX_L2_MESSAGE_SIZE, MAX_L2_MESSAGE_SIZE + 1]) expect(parseL2(msgBatch([signedTxMsg(t1), tx(n)]), 0), `nested ${n}`).toBeNull();
    expect(parseL2(concat(msgBatch([signedTxMsg(t1)]), u64be(MAX_L2_MESSAGE_SIZE + 1)), 0)?.length).toBe(1);
  });
  it('the first byte of the transaction is judged at the 0xc0 boundary: 0xc0 and 0xc1 are kept, 0xbf and 0xbe fail the message; a length with every bit set ends the batch quietly', () => {
    const cases: [string, Uint8Array, boolean][] = [['0xc0', B(0xc0), true], ['0xc1', B(0xc1, 0x00), true], ['0xbf', B(0xbf, 0x00), false], ['0xbe', B(0xbe), false]];
    for (const [name, t, ok] of cases) {
      const got = parseL2(signedTxMsg(t), 0);
      if (ok) expect([name, got?.length]).toEqual([name, 1]);
      else expect([name, got]).toEqual([name, null]);
    }
    expect(parseL2(concat(msgBatch([signedTxMsg(t1)]), B(255, 255, 255, 255, 255, 255, 255, 255, 0)), 0)?.length).toBe(1);
  });
});

describe('a sequencer message is all or nothing (nitro parseL2Message with no request id)', () => {
  const t1 = legacyTx(1);
  const t2 = legacyTx(2);
  const unsignedOK = concat(B(0), wordU(50000), wordU(8), wordU(1), wordU(7), wordU(0), B(1));
  const both = (...extra: Uint8Array[]): Uint8Array => msgBatch([signedTxMsg(t1), signedTxMsg(t2), ...extra]);
  const contract = concat(B(1), wordU(1), wordU(1), wordU(1), wordU(1));
  const cases: [string, Uint8Array, boolean, number][] = [
    ['two signed', both(), true, 2],
    ['one signed alone', signedTxMsg(t1), true, 1],
    ['valid unsigned nested adds none', both(unsignedOK), true, 2],
    ['unsigned alone adds none', unsignedOK, true, 0],
    ['cut length tail', concat(both(), B(0, 0, 0)), true, 2],
    ['oversize length tail', concat(both(), u64be(MAX_L2_MESSAGE_SIZE + 1)), true, 2],
    ['cut nested tail', concat(both(), u64be(40), B(1)), true, 2],
    ['empty batch', B(L2_BATCH), true, 0],
    ['nested kind 2', both(B(2)), false, 0],
    ['nested kind 6', both(B(6)), false, 0],
    ['nested kind 7', both(B(7, 1)), false, 0],
    ['nested unknown kind', both(B(0x7f)), false, 0],
    ['nested contract tx', both(contract), false, 0],
    ['nested unsigned cut', both(concat(B(0), wordU(1))), false, 0],
    ['nested unsigned gas >= 2^64', both(concat(B(0), concat(B(1), new Uint8Array(31)), wordU(1), wordU(1), wordU(1), wordU(1))), false, 0],
    ['nested unsigned nonce >= 2^64', both(concat(B(0), wordU(1), wordU(1), concat(B(1), new Uint8Array(31)), wordU(1), wordU(1))), false, 0],
    ['nested empty signed', both(B(4)), false, 0],
    ['nested empty message', both(new Uint8Array(0)), false, 0],
    ['nested Arbitrum type', both(B(4, 0x64, 0xc0)), false, 0],
    ['nested blob type', both(B(4, 0x03, 0xc0)), false, 0],
    ['nested unknown type', both(B(4, 0x05, 0xc0)), false, 0],
    ['nested type zero byte', both(B(4, 0x00, 0xc0)), false, 0],
    ['nested access-list type is kept', msgBatch([signedTxMsg(B(1, 0xc0))]), true, 1],
    ['nested dynamic-fee type is kept', msgBatch([signedTxMsg(B(2, 0xc0))]), true, 1],
    ['nested set-code type is kept', msgBatch([signedTxMsg(B(4, 0xc0))]), true, 1],
    ['inner batch with a failing nested', both(msgBatch([signedTxMsg(t1), B(2)])), false, 0],
    ['inner batch with a good nested', both(msgBatch([signedTxMsg(t1)])), true, 3],
    ['top-level kind 2', B(2, 1), false, 0],
    ['top-level kind 6', B(6), false, 0],
    ['top-level kind 7', B(7), false, 0],
    ['top-level contract tx', contract, false, 0],
    ['empty message', new Uint8Array(0), false, 0],
    ['unsigned with trailing calldata', concat(unsignedOK, B(9, 9, 9)), true, 0],
  ];
  it('every case of the Go table: ok, and the number of signed transactions', () => {
    expect(cases.length).toBe(33);
    for (const [name, msg, ok, count] of cases) {
      const got = parseL2(msg, 0);
      expect([name, got !== null, got?.length ?? 0], name).toEqual([name, ok, count]);
    }
  });
  it('a failed message keeps its ordinal and yields no transactions', () => {
    const r = decodePayload(payloadOf(concat(seg(0, both(B(2))), seg(0, both()))), 1 << 20, 100);
    expect([r.status, r.messages.length, r.messages[0]!.txs.length, r.messages[1]!.txs.length, r.messages[1]!.ordinal]).toEqual([PayloadOK, 2, 0, 2, 1]);
  });
});

describe('a top-level sequencer message is capped like ParseL2Transactions', () => {
  const a = legacyTx(1);
  const quietBatch = (total: number): Uint8Array => {
    const m = concat(msgBatch([signedTxMsg(a)]), u64be(MAX_L2_MESSAGE_SIZE + 1));
    return m.length >= total ? m : concat(m, new Uint8Array(total - m.length));
  };
  it('the cap is exactly the size limit: cap-1 and cap parse, cap+1 and cap+50 are a failed message', () => {
    for (const [total, ok] of [[MAX_L2_MESSAGE_SIZE - 1, true], [MAX_L2_MESSAGE_SIZE, true], [MAX_L2_MESSAGE_SIZE + 1, false], [MAX_L2_MESSAGE_SIZE + 50, false]] as const) {
      const m = quietBatch(total);
      expect(m.length).toBe(total);
      const txs = parseL2(m, 0);
      expect([total, txs !== null && txs.length === 1 && Buffer.from(txs[0]!).equals(Buffer.from(a))]).toEqual([total, ok]);
    }
  });
  it('an oversize message matches no block but keeps its ordinal: the real message after it is found at ordinal 1 of 2', () => {
    const blockTxs = [internalTx(), a];
    const at = makeSynth({ segments: [seg(0, quietBatch(MAX_L2_MESSAGE_SIZE))], blockTxs }).run();
    expect(at.fields.message_ordinal).toBe(0n);
    let refused = '';
    try {
      makeSynth({ segments: [seg(0, quietBatch(MAX_L2_MESSAGE_SIZE + 1))], blockTxs }).run();
    } catch (e) {
      refused = (e as FinalityStateError).canonical();
    }
    expect(refused).toBe('{"code":"l1_posted_content_not_found","fields":{"batch":"77","messages_scanned":"1","reason":"no_matching_message","segments":"1"}}');
    const over = makeSynth({ segments: [seg(0, quietBatch(MAX_L2_MESSAGE_SIZE + 1)), seg(0, msgBatch([signedTxMsg(a)]))], blockTxs }).run();
    expect([over.fields.message_ordinal, over.fields.messages]).toEqual([1n, 2n]);
  });
});

describe('the strict Brotli layer inside a batch (Go strict_test.go)', () => {
  const needed = legacyTx(1);
  const tail = Uint8Array.from({ length: 400 }, (_, i) => (i * 37 + 11) & 0xff);
  const full = payloadOf(concat(seg(0, signedTxMsg(needed)), seg(0, signedTxMsg(tail))));
  it('a batch stream cut short is undecodable at every byte; a header only, an empty payload and a trailing byte are undecodable', () => {
    const r = decodePayload(full, 1 << 20, 100);
    expect([r.status, r.messages.length]).toEqual([PayloadOK, 2]);
    for (let i = 2; i < full.length; i++) expect(decodePayload(full.subarray(0, i), 1 << 20, 100).status, `cut ${i}/${full.length}`).toBe(PayloadUndecodable);
    expect(decodePayload(B(0), 1 << 20, 100).status).toBe(PayloadUndecodable);
    expect(decodePayload(new Uint8Array(0), 1 << 20, 100).status).toBe(PayloadUndecodable);
    expect(decodePayload(concat(full, B(0)), 1 << 20, 100).status).toBe(PayloadUndecodable);
  });
  it('a per-message Brotli segment cut short, empty or trailed is dropped like Nitro drops it, not kept as a partial message', () => {
    const big = Uint8Array.from({ length: 600 }, (_, i) => (i === 0 ? 0xc0 : (i * 131 + 7) & 0xff)); // a valid first byte: the transaction is complete well before the stream's last byte
    const msg = msgBatch([signedTxMsg(legacyTx(1)), signedTxMsg(big)]);
    const comp = brotliCompressSync(msg);
    const whole = decodePayload(payloadOf(seg(1, comp)), 1 << 20, 100);
    expect([whole.status, whole.messages.length, whole.messages[0]!.txs.length]).toEqual([PayloadOK, 1, 2]);
    for (let i = 1; i < comp.length; i++) {
      const r = decodePayload(payloadOf(seg(1, comp.subarray(0, i))), 1 << 20, 100);
      expect([`cut ${i}`, r.status, r.messages.length]).toEqual([`cut ${i}`, PayloadOK, 0]);
    }
    for (const body of [new Uint8Array(0), concat(comp, B(0))]) {
      const r = decodePayload(payloadOf(seg(1, body)), 1 << 20, 100);
      expect([r.status, r.messages.length]).toEqual([PayloadOK, 0]);
    }
  });
});
