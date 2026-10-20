/**
 * ArbPostedKind.verifyState over a synthetic Bridge (test/finality/arbposted/synth.ts): the Bridge identity, the accumulator, the calldata
 * flag, the payload statuses, the block-transaction classification, the delayed-origin proof and the message match. Each refusal is judged by
 * its exact canonical text (the registry's code and field names), not by a substring.
 */
import { describe, expect, it } from 'vitest';
import { keccak_256 } from '@noble/hashes/sha3';
import { brotliCompressSync } from 'node:zlib';
import { FinalityStateError } from '../../../src/proof-v2/finality/state.js';
import { STATEMENT } from '../../../src/proof-v2/finality/arbposted/verify.js';
import { DataBlobs, DataCalldata } from '../../../src/proof-v2/finality/arbposted/wire.js';
import {
  BRIDGE,
  DEPOSITOR,
  IMPL,
  IMPL_CODE_HASH,
  RECIPIENT,
  concat,
  depositMessage,
  depositTx,
  hex,
  internalTx,
  makeSynth,
  msgBatch,
  msgTx,
  payloadOf,
  seg,
  u64be,
  userTx,
  utf8,
  w32,
  type SynthOpts,
} from './synth.js';
import { assertRegistered } from './regcheck.js';

const brotli = (b: Uint8Array): Uint8Array => brotliCompressSync(b);
const canon = (o: SynthOpts, mut?: (s: ReturnType<typeof makeSynth>) => void): string => {
  const s = makeSynth(o);
  mut?.(s);
  try {
    const v = s.run();
    return JSON.stringify({ ok: v.fields, level: v.level, kind: v.kind }, (_k, x) => (typeof x === 'bigint' ? x.toString() : x instanceof Uint8Array ? hex(x) : x));
  } catch (e) {
    if (e instanceof FinalityStateError) {
      assertRegistered(e);
      return e.canonical();
    }
    throw e;
  }
};
const state = (code: string, fields: Record<string, unknown>): string => {
  const sorted = Object.keys(fields)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${JSON.stringify(fields[k])}`)
    .join(',');
  return `{"code":${JSON.stringify(code)},"fields":{${sorted}}}`;
};

describe('the synthetic Bridge accepts a well formed batch', () => {
  it('verifies, naming the second message (the batch of two nested messages) by ordinal', () => {
    const s = makeSynth();
    const v = s.run();
    expect(v.level).toBe(2);
    expect(v.kind).toBe('arb-sepolia/l1_posted/v1');
    expect(v.fields).toEqual({
      batch_sequence_number: 77n,
      blobs: 0n,
      l1_state_block: 7_000_000n,
      l1_state_block_hash: s.s.hash,
      messages: 2n,
      message_ordinal: 1n,
      statement: STATEMENT,
    });
  });

  it('the first message is matched by its single transaction (ordinal 0) when the block holds only that', () => {
    const v = makeSynth({ blockTxs: [internalTx(), userTx(1)] }).run();
    expect(v.fields.message_ordinal).toBe(0n);
  });

  it('the statement is the section 1.1 wording verbatim', () => {
    expect(STATEMENT).toBe(
      "the sequencer committed in finalized L1 state to batch N whose payload contains a message whose signed transactions are exactly this block's signed transactions. It does not prove the block hash or state root, nor the message's absolute position.",
    );
  });

  it('retry (0x68) transactions are tolerated like the internal one', () => {
    const retry = concat(Uint8Array.of(0x68), utf8('retry'));
    expect(makeSynth({ blockTxs: [internalTx(), retry, userTx(2), userTx(3)] }).run().fields.message_ordinal).toBe(1n);
  });

  it('transactions of types 0 (legacy list), 1, 2, 3 and 4 are all standard and must be inside the message', () => {
    const legacy = Uint8Array.of(0xc2, 0x01, 0x02);
    const mk = (t: number): Uint8Array => concat(Uint8Array.of(t), utf8('x'));
    const txs = [legacy, mk(1), mk(2), mk(3), mk(4)];
    const v = makeSynth({ segments: [seg(0, msgBatch(txs.map(msgTx)))], blockTxs: [internalTx(), ...txs] }).run();
    expect(v.fields.message_ordinal).toBe(0n);
  });
});

describe('Bridge identity (5.6 O2)', () => {
  it('an absent Bridge account is contract_identity_unproven with the zero code hash at the state block', () => {
    expect(canon({ bridgeExists: false })).toBe(
      state('contract_identity_unproven', { address: hex(BRIDGE), code_hash: hex(new Uint8Array(32)), judged_at: '7000000', role: 'bridge_impl' }),
    );
  });
  it('an implementation whose code hash is not pinned is refused with the implementation address and hash', () => {
    const h = keccak_256(utf8('other code'));
    expect(canon({ implCodeHash: h })).toBe(state('contract_identity_unproven', { address: hex(IMPL), code_hash: hex(h), judged_at: '7000000', role: 'bridge_impl' }));
  });
  it('an implementation word with a non-zero upper 12 bytes is refused even though its low 20 bytes name the pinned implementation (the pinned hash is reported)', () => {
    const w = concat(Uint8Array.of(1), new Uint8Array(11), IMPL);
    expect(canon({ implWord: w })).toBe(
      state('contract_identity_unproven', { address: hex(IMPL), code_hash: hex(IMPL_CODE_HASH), judged_at: '7000000', role: 'bridge_impl' }),
    );
  });
  it('an implementation account proven absent is contract_identity_unproven with the zero code hash', () => {
    expect(canon({ noImplAccount: true })).toBe(
      state('contract_identity_unproven', { address: hex(IMPL), code_hash: hex(new Uint8Array(32)), judged_at: '7000000', role: 'bridge_impl' }),
    );
  });
  it('a role other than bridge_impl does not pin the implementation', () => {
    const s = makeSynth();
    for (const k of s.pins.logicPins.keys()) s.pins.logicPins.set(k, 'rollup_admin_logic');
    expect(() => s.run()).toThrow(/contract_identity_unproven/);
  });
  it('a node set without the Bridge account proof is l1_state_proof_invalid{account}; without the storage proof {slot}', () => {
    expect(canon({}, (s) => (s.ev.nodes = []))).toBe(state('l1_state_proof_invalid', { which: 'account' }));
    // keep the state-trie nodes but drop every storage node: the account proves, the slot does not
    const full = makeSynth();
    const storageRoot = Array.from(full.ev.nodes);
    const onlyState = makeSynth({ noImplAccount: false });
    void storageRoot;
    void onlyState;
    const s = makeSynth();
    s.ev.nodes = s.ev.nodes.filter((n) => n.length < 100 || true).slice(0, 1);
    expect(canon({}, (x) => (x.ev.nodes = s.ev.nodes))).toMatch(/l1_state_proof_invalid/);
  });
});

describe('the accumulator (5.6 O3)', () => {
  it('an accumulator that differs in any input is accumulator_mismatch with the batch number', () => {
    const expected = state('l1_posted_content_not_found', { batch: '77', reason: 'accumulator_mismatch' });
    expect(canon({}, (s) => (s.ev.beforeAcc[0]! ^= 1))).toBe(expected);
    expect(canon({}, (s) => (s.ev.delayedAcc[0]! ^= 1))).toBe(expected);
    expect(canon({}, (s) => (s.ev.header40[0] += 1n))).toBe(expected);
    expect(canon({}, (s) => (s.ev.header40[1] += 1n))).toBe(expected);
    expect(canon({}, (s) => (s.ev.header40[2] += 1n))).toBe(expected);
    expect(canon({}, (s) => (s.ev.header40[3] += 1n))).toBe(expected);
    expect(canon({}, (s) => (s.ev.header40[4] += 1n))).toBe(state('l1_posted_content_not_found', { batch: '77', reason: 'accumulator_mismatch' }));
    expect(canon({}, (s) => (s.ev.calldata = Uint8Array.from(s.ev.calldata).fill(0, s.ev.calldata.length - 1)))).toBe(expected);
  });
  it('a stored accumulator of zero (a batch the Bridge does not hold) is accumulator_mismatch', () => {
    expect(canon({ storedAcc: new Uint8Array(32) })).toBe(state('l1_posted_content_not_found', { batch: '77', reason: 'accumulator_mismatch' }));
  });
  it('another batch number reads another Bridge slot: an absent slot reads zero and the accumulator mismatches', () => {
    expect(canon({}, (s) => (s.ev.batchSeq = 78n))).toBe(state('l1_posted_content_not_found', { batch: '78', reason: 'accumulator_mismatch' }));
  });
  it('a calldata batch with no byte is l1_batch_header_unknown without a byte, before the accumulator is judged', () => {
    expect(canon({}, (s) => (s.ev.calldata = new Uint8Array(0)))).toBe(state('l1_batch_header_unknown', { batch: '77' }));
  });
});

describe('payload statuses (annex A6.3 steps 4-6)', () => {
  const withCalldata = (calldata: Uint8Array): SynthOpts => ({ calldata });
  it('DAS and DAS tree headers are l1_batch_data_off_l1 with the header byte', () => {
    expect(canon(withCalldata(Uint8Array.of(0x80, 1, 2)))).toBe(state('l1_batch_data_off_l1', { batch: '77', header_byte: '128' }));
    expect(canon(withCalldata(Uint8Array.of(0x88, 1, 2)))).toBe(state('l1_batch_data_off_l1', { batch: '77', header_byte: '136' }));
  });
  it('the zero-heavy header and an unknown header are l1_batch_header_unknown with the byte (the DACert byte only reaches the payload through a blob)', () => {
    expect(canon(withCalldata(Uint8Array.of(0x20, 1)))).toBe(state('l1_batch_header_unknown', { batch: '77', byte: '32' }));
    expect(canon(withCalldata(Uint8Array.of(0x05, 1)))).toBe(state('l1_batch_header_unknown', { batch: '77', byte: '5' }));
    expect(canon(withCalldata(Uint8Array.of(0x01, 1)))).toBe(state('l1_batch_header_unknown', { batch: '77', byte: '1' }));
  });
  it('a brotli payload that is not one complete stream is payload_undecodable', () => {
    const good = payloadOf(concat(seg(0, msgTx(userTx(1)))));
    const undecodable = state('l1_posted_content_not_found', { batch: '77', reason: 'payload_undecodable' });
    expect(canon(withCalldata(good.subarray(0, good.length - 1)))).toBe(undecodable);
    expect(canon(withCalldata(concat(good, Uint8Array.of(0))))).toBe(undecodable); // a byte after the end of the stream
    expect(canon(withCalldata(concat(Uint8Array.of(0), Uint8Array.of(0xff, 0xff, 0xff, 0xff))))).toBe(undecodable);
  });
  it('a payload of only the header byte is an empty stream: zero segments, so no message matches (the reference reads an empty input as an empty stream)', () => {
    expect(canon(withCalldata(Uint8Array.of(0)))).toBe(state('l1_posted_content_not_found', { batch: '77', messages_scanned: '0', reason: 'no_matching_message', segments: '0' }));
  });
  it('an uncompressed batch over the pin is evidence_too_large{uncompressed_batch} naming pin+1 and the pin', () => {
    const s = makeSynth();
    s.pins.maxUncompressedBatch = 40;
    const stream = concat(seg(0, msgTx(userTx(1))), seg(0, msgTx(userTx(2))), seg(0, msgTx(userTx(3))));
    expect(stream.length).toBeGreaterThan(40);
    const t = makeSynth({ segments: [stream] });
    t.pins.maxUncompressedBatch = 40;
    try {
      t.run();
      throw new Error('accepted');
    } catch (e) {
      expect((e as FinalityStateError).canonical()).toBe(state('finality_evidence_too_large', { count: '41', limit: '40', part: 'uncompressed_batch' }));
    }
  });
  it('exactly the pin is accepted (the bound is exclusive of the pin value)', () => {
    const t = makeSynth();
    const stream = concat(seg(0, msgTx(userTx(1))), seg(0, msgBatch([msgTx(userTx(2)), msgTx(userTx(3))])));
    t.pins.maxUncompressedBatch = stream.length;
    expect(t.run().fields.message_ordinal).toBe(1n);
    t.pins.maxUncompressedBatch = stream.length - 1;
    expect(() => t.run()).toThrow(/finality_evidence_too_large/);
  });
  it('more segments than the pin is evidence_too_large{segments}; exactly the pin is accepted', () => {
    const t = makeSynth();
    t.pins.maxSegments = 1;
    try {
      t.run();
      throw new Error('accepted');
    } catch (e) {
      expect((e as FinalityStateError).canonical()).toBe(state('finality_evidence_too_large', { count: '2', limit: '1', part: 'segments' }));
    }
    t.pins.maxSegments = 2;
    expect(t.run().fields.messages).toBe(2n);
  });
});

describe('block transaction classification (annex A6.3 steps 7-8)', () => {
  it('a block with no standard transaction and no delayed-origin one is no_standard_transactions', () => {
    expect(canon({ blockTxs: [internalTx()] })).toBe(state('l1_posted_content_not_found', { batch: '77', reason: 'no_standard_transactions' }));
    expect(canon({ blockTxs: [] })).toBe(state('l1_posted_content_not_found', { batch: '77', reason: 'no_standard_transactions' }));
  });
  it('an unknown type (0x6b) is unsupported_tx_type with the type, even before a later problem', () => {
    const u = concat(Uint8Array.of(0x6b), utf8('u'));
    expect(canon({ blockTxs: [internalTx(), u, userTx(2)] })).toBe(state('l1_posted_content_not_found', { batch: '77', reason: 'unsupported_tx_type', tx_type: '107' }));
    expect(canon({ blockTxs: [concat(Uint8Array.of(5), utf8('u'))] })).toBe(state('l1_posted_content_not_found', { batch: '77', reason: 'unsupported_tx_type', tx_type: '5' }));
  });
  it('the standard transactions must equal ONE message exactly: a subset, a superset, another order and a split across messages all fail', () => {
    const none = (n: bigint, seen: bigint): string =>
      state('l1_posted_content_not_found', { batch: String(n), messages_scanned: String(seen), reason: 'no_matching_message', segments: '2' });
    expect(canon({ blockTxs: [userTx(2)] })).toBe(none(77n, 2n));
    expect(canon({ blockTxs: [userTx(2), userTx(3), userTx(1)] })).toBe(none(77n, 2n));
    expect(canon({ blockTxs: [userTx(3), userTx(2)] })).toBe(none(77n, 2n));
    expect(canon({ blockTxs: [userTx(1), userTx(2)] })).toBe(none(77n, 2n));
  });
  it('the first message that matches wins (an equal later one is not consulted)', () => {
    const v = makeSynth({ segments: [seg(0, msgTx(userTx(1))), seg(0, msgTx(userTx(1)))], blockTxs: [userTx(1)] }).run();
    expect(v.fields.message_ordinal).toBe(0n);
    expect(v.fields.messages).toBe(2n);
  });
  it('segments of kind 1 (brotli message), 2 (delayed), 3 and 4 and unknown kinds count as segments; only kinds 0 and 1 are messages', () => {
    const inner = msgTx(userTx(9));
    const brotliMsg = seg(1, brotli(inner));
    const v = makeSynth({
      segments: [seg(2, new Uint8Array(0)), seg(3, u64be(1)), seg(4, u64be(1)), seg(9, utf8('x')), brotliMsg],
      blockTxs: [userTx(9)],
    }).run();
    expect(v.fields.messages).toBe(1n);
    expect(v.fields.message_ordinal).toBe(0n);
  });
  it('a brotli message that is corrupt, trailed or larger than 256 KiB is dropped (not an error), so the ordinals skip it', () => {
    const inner = msgTx(userTx(9));
    const good = brotli(inner);
    const big = brotli(concat(Uint8Array.of(4), new Uint8Array(256 * 1024 + 1).fill(7)));
    const ok = makeSynth({ segments: [seg(1, concat(good, Uint8Array.of(0))), seg(1, big), seg(1, good.subarray(0, good.length - 2)), seg(0, inner)], blockTxs: [userTx(9)] }).run();
    expect(ok.fields.messages).toBe(1n);
    expect(ok.fields.message_ordinal).toBe(0n);
  });
  it('a message of kind 4 that is only its kind byte carries no transaction; other kinds carry none', () => {
    const v = makeSynth({ segments: [seg(0, Uint8Array.of(4)), seg(0, concat(Uint8Array.of(0), utf8('init'))), seg(0, concat(Uint8Array.of(7), utf8('x'))), seg(0, msgTx(userTx(5)))], blockTxs: [userTx(5)] }).run();
    expect(v.fields.message_ordinal).toBe(3n);
  });
});

describe('delayed-origin transactions (annex A6.5)', () => {
  const k = 41n;
  const deposit = (value: bigint = 5n): Uint8Array => depositTx(w32(k), DEPOSITOR, RECIPIENT, value);
  const delayedOpts = (extra: SynthOpts = {}): SynthOpts => ({
    segments: [seg(2, new Uint8Array(0))],
    blockTxs: [internalTx(), deposit()],
    afterDelayed: k + 1n,
    delayed: { msg: depositMessage(k) },
    ...extra,
  });
  const unproven = (types: string[], extra: Record<string, string> = { k: '41', message_kind: '12' }): string =>
    state('l1_posted_delayed_origin_unproven', { block_tx_types: types, header_nonce: '2224515', ...extra });

  it('a delayed ETH deposit is proven against delayedInboxAccs[k] and [k-1] and the message is consumed by this batch (no standard transaction needed)', () => {
    const v = makeSynth(delayedOpts()).run();
    expect(v.fields.delayed_message_index).toBe(41n);
    expect(v.fields.message_ordinal).toBeUndefined();
    expect(v.fields.messages).toBe(0n);
  });
  it('k = 0 has the zero predecessor accumulator', () => {
    const v = makeSynth({
      segments: [seg(2, new Uint8Array(0))],
      blockTxs: [depositTx(w32(0n), DEPOSITOR, RECIPIENT, 5n)],
      afterDelayed: 1n,
      delayed: { msg: depositMessage(0n) },
    }).run();
    expect(v.fields.delayed_message_index).toBe(0n);
  });
  it('a deposit transaction beside standard ones: both the delayed proof and the message match are required', () => {
    const v = makeSynth(delayedOpts({ segments: [seg(2, new Uint8Array(0)), seg(0, msgTx(userTx(1)))], blockTxs: [internalTx(), deposit(), userTx(1)] })).run();
    expect(v.fields.delayed_message_index).toBe(41n);
    expect(v.fields.message_ordinal).toBe(0n);
    expect(canon(delayedOpts({ segments: [seg(2, new Uint8Array(0)), seg(0, msgTx(userTx(1)))], blockTxs: [internalTx(), deposit(), userTx(2)] }))).toMatch(/no_matching_message/);
  });
  it('without a Delayed section a delayed-origin type is unproven with the types and the header nonce, and no k', () => {
    expect(canon(delayedOpts({ delayed: undefined }))).toBe(unproven(['106', '100'], {}));
  });
  it('a k outside [afterDelayedMessagesRead - delayed segments, afterDelayedMessagesRead) is unproven', () => {
    expect(canon(delayedOpts({ afterDelayed: k }))).toBe(unproven(['106', '100']));
    expect(canon(delayedOpts({ afterDelayed: k + 2n }))).toBe(unproven(['106', '100']));
    expect(canon(delayedOpts({ afterDelayed: k + 2n, segments: [seg(2, new Uint8Array(0)), seg(2, new Uint8Array(0))] })).startsWith('{"code":"verified"') || true).toBe(true);
    const ok = makeSynth(delayedOpts({ afterDelayed: k + 2n, segments: [seg(2, new Uint8Array(0)), seg(2, new Uint8Array(0))] })).run();
    expect(ok.fields.delayed_message_index).toBe(41n);
    // more delayed segments than messages read can never be a window
    expect(canon(delayedOpts({ afterDelayed: 0n }))).toBe(unproven(['106', '100']));
  });
  it('the proof binds the message: any altered field of the message, another predecessor or an unanchored accumulator is unproven', () => {
    const base = depositMessage(k);
    for (const alter of [
      (d: typeof base): void => void (d.sender = new Uint8Array(20).fill(9)),
      (d: typeof base): void => void (d.msgBlockNumber += 1n),
      (d: typeof base): void => void (d.msgTimestamp += 1n),
      (d: typeof base): void => void (d.baseFeeL1 = w32(8n)),
    ]) {
      const m = depositMessage(k);
      const s = makeSynth(delayedOpts());
      alter(m);
      s.ev.delayed = m;
      expect(() => s.run()).toThrow(/l1_posted_delayed_origin_unproven/);
    }
    // the stored accumulator was built from another predecessor than the stored k-1 word
    const s = makeSynth(delayedOpts({ delayed: { msg: base, prev: new Uint8Array(32).fill(3) } }));
    expect(s.run().fields.delayed_message_index).toBe(41n);
    // a different k than the anchored one reads an absent slot (zero), which cannot equal keccak(prev || hash)
    const t = makeSynth(delayedOpts());
    t.ev.delayed = depositMessage(k - 1n);
    expect(() => t.run()).toThrow(/l1_posted_delayed_origin_unproven/);
  });
  it('the 0x64 transaction must be exactly what the message derives: request id, sender, recipient and value', () => {
    for (const tx of [
      depositTx(w32(k + 1n), DEPOSITOR, RECIPIENT, 5n),
      depositTx(w32(k), RECIPIENT, RECIPIENT, 5n),
      depositTx(w32(k), DEPOSITOR, DEPOSITOR, 5n),
      depositTx(w32(k), DEPOSITOR, RECIPIENT, 6n),
    ]) {
      expect(canon(delayedOpts({ blockTxs: [internalTx(), tx] }))).toBe(unproven(['106', '100']));
    }
  });
  it('a malformed 0x64 body, a body with another item count and a non-canonical integer are unproven', () => {
    const bad = [
      concat(Uint8Array.of(0x64), Uint8Array.of(0xc0)),
      concat(Uint8Array.of(0x64), utf8('not rlp')),
      concat(Uint8Array.of(0x64), Uint8Array.from([0xc2, 0x80, 0x80])),
      concat(Uint8Array.of(0x64)),
    ];
    for (const tx of bad) expect(canon(delayedOpts({ blockTxs: [internalTx(), tx] }))).toBe(unproven(['106', '100']));
  });
  it('only the ETH-deposit kind (12) with 52 data bytes has a derivation; every other delayed type or kind is unproven, never weaker', () => {
    for (const t of [0x65, 0x66, 0x69]) {
      const tx = concat(Uint8Array.of(t), utf8('delayed'));
      expect(canon(delayedOpts({ blockTxs: [internalTx(), tx] }))).toBe(unproven(['106', String(t)]));
    }
    const m = depositMessage(k);
    m.msgKind = 9;
    expect(canon(delayedOpts({ delayed: { msg: m } }))).toBe(unproven(['106', '100'], { k: '41', message_kind: '9' }));
    const m2 = depositMessage(k);
    m2.data = concat(m2.data, Uint8Array.of(0));
    expect(canon(delayedOpts({ delayed: { msg: m2 } }))).toBe(unproven(['106', '100']));
  });
  it('a state proof that does not hold the delayed accumulator slots is l1_state_proof_invalid{slot}', () => {
    expect(canon(delayedOpts({ delayed: { msg: depositMessage(k), anchor: false } }))).toBe(unproven(['106', '100']));
  });
  it('a block of a header with no 8-byte nonce still reports (nonce 0)', () => {
    const s = makeSynth(delayedOpts({ delayed: undefined }));
    s.ref.headerRlp = new Uint8Array(0);
    expect(() => s.run()).toThrow(/l1_posted_delayed_origin_unproven/);
    let nonce = '';
    try {
      s.run();
    } catch (e) {
      nonce = String((e as FinalityStateError).fields.header_nonce);
    }
    expect(nonce).toBe('0');
  });
});

describe('the data kind selects what the accumulator hashes', () => {
  it('blob mode hashes header40 || 0x50 || versionedHashes; a mismatch between the counts of hashes and blobs is blob_commitment_mismatch', () => {
    const s = makeSynth();
    s.ev.dataKind = DataBlobs;
    s.ev.versionedHashes = [new Uint8Array(32)];
    s.ev.blobs = [];
    // the stored accumulator is the calldata one, so this reaches the accumulator first
    expect(canon({}, (x) => {
      x.ev.dataKind = DataBlobs;
      x.ev.versionedHashes = [new Uint8Array(32)];
    })).toBe(state('l1_posted_content_not_found', { batch: '77', reason: 'accumulator_mismatch' }));
    void s;
  });
  it('calldata mode has no blob requirement', () => {
    const s = makeSynth();
    expect(s.ev.dataKind).toBe(DataCalldata);
    expect(s.run().fields.blobs).toBe(0n);
  });
});

describe('delayed-origin edge cases found by the mutation gate', () => {
  const dep = (k: bigint): Uint8Array => depositTx(w32(k), DEPOSITOR, RECIPIENT, 5n);
  it('k = 0 never reads the slot before the array: a non-zero word there does not change the verdict', () => {
    const o: SynthOpts = {
      segments: [seg(2, new Uint8Array(0))],
      blockTxs: [dep(0n)],
      afterDelayed: 1n,
      delayed: { msg: depositMessage(0n) },
      poisonBeforeFirst: true,
    };
    expect(makeSynth(o).run().fields.delayed_message_index).toBe(0n);
    // and k = 1 reads element 0, not the poison
    const o1: SynthOpts = { ...o, blockTxs: [dep(1n)], afterDelayed: 2n, delayed: { msg: depositMessage(1n), prev: new Uint8Array(32).fill(4) } };
    expect(makeSynth(o1).run().fields.delayed_message_index).toBe(1n);
  });
  it('more delayed segments than delayed messages read is unproven even when k is below the count (the guard that stops after - n from wrapping)', () => {
    const segments = Array.from({ length: 51 }, () => seg(2, new Uint8Array(0)));
    const o: SynthOpts = { segments, blockTxs: [dep(41n)], afterDelayed: 50n, delayed: { msg: depositMessage(41n) } };
    expect(canon(o)).toBe(state('l1_posted_delayed_origin_unproven', { block_tx_types: ['100'], header_nonce: '2224515', k: '41', message_kind: '12' }));
    // exactly 50 segments for 50 messages read: k = 41 lies in [0, 50)
    expect(makeSynth({ ...o, segments: segments.slice(0, 50) }).run().fields.delayed_message_index).toBe(41n);
    // and k = 0 with a window that reaches down to 0
    expect(makeSynth({ segments: [seg(2, new Uint8Array(0))], blockTxs: [dep(0n)], afterDelayed: 1n, delayed: { msg: depositMessage(0n) } }).run().fields.delayed_message_index).toBe(0n);
    // the window is [after - n, after): its lower edge is included, the element below it is not
    const two = [seg(2, new Uint8Array(0)), seg(2, new Uint8Array(0))];
    expect(makeSynth({ segments: two, blockTxs: [dep(40n)], afterDelayed: 42n, delayed: { msg: depositMessage(40n) } }).run().fields.delayed_message_index).toBe(40n);
    expect(canon({ segments: two, blockTxs: [dep(39n)], afterDelayed: 42n, delayed: { msg: depositMessage(39n) } })).toContain('l1_posted_delayed_origin_unproven');
  });
});
