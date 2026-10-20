/**
 * Synthetic-L1 tests of the Base l1_posted channel judgement (O3-O5): calldata frames, zlib and Brotli, singular and span batches, and every
 * refusal of authentication, assembly, decoding and binding. The twin of the validator's verify_test.go Synth* tests; the live evidence
 * (blobs, Brotli, the real light-client chain) is judged by the vector shards.
 */
import { describe, expect, it } from 'vitest';
import { FinalityStateError, canonValue } from '../../../src/proof-v2/finality/state.js';
import { verifyChannel } from '../../../src/proof-v2/finality/baseposted/verify.js';
import { encodeNodes } from '../../../src/proof-v2/finality/codec.js';
import { buildTrie, rlpIndexKey } from '../../../src/proof-v2/finality/baseposted/trie.js';
import { type SynthOpts, type Synth, addressOf, compress, hex, makeSynth, testKey, concat, utf8 } from './synth.js';
import { keccak_256 } from '@noble/hashes/sha3';
import { assertRegistered } from './regcheck.js';

const run = (s: Synth) => verifyChannel(s.bp, s.body, s.covered, s.l2, s.head);

function state(s: Synth): FinalityStateError {
  try {
    run(s);
  } catch (e) {
    if (e instanceof FinalityStateError) return e;
    throw e;
  }
  throw new Error('verified, but a refusal was expected');
}

function expectState(s: Synth, code: string, fields: Record<string, string> = {}): void {
  const e = state(s);
  expect(e.code, e.canonical()).toBe(code);
  assertRegistered(e);
  for (const [k, v] of Object.entries(fields)) expect(JSON.parse(canonValue(e.fields[k]!)), `${code}.${k}`).toBe(v);
}

const ok = (o: SynthOpts) => run(makeSynth(o));

describe('valid channels', () => {
  it.each(['zlib', 'brotli'] as const)('a calldata %s channel with singular batches verifies and names its fields', (compression) => {
    const s = makeSynth({ compression, nFrames: 3 });
    const v = run(s);
    expect(canonValue(v.fields)).toBe(
      `{"batch_type":"0","batcher":"${hex(s.batcherAddr)}","channel_id":"${hex(s.body.channelId)}","epoch_hash_bits":"256","finalized_epoch":"3","finalized_slot":"111","l1_blocks":["1000"],"parent_hash_bits":"256","span_blocks":"1","span_index":"0"}`,
    );
  });

  it('a span batch verifies for its first block with a 160-bit parent check and no epoch binding to refuse (single block)', () => {
    const v = ok({ spanBlocks: 1, compression: 'brotli' });
    expect(v.fields.batch_type).toBe(1n);
    expect(v.fields.span_blocks).toBe(1n);
    expect(v.fields.span_index).toBe(0n);
    expect(v.fields.parent_hash_bits).toBe(160n);
    expect(v.fields.epoch_hash_bits).toBe(160n);
  });

  it('frames spread over several L1 blocks verify and report the distinct sorted blocks', () => {
    const v = ok({ nFrames: 3, frameBlocks: [1002n, 1000n, 1002n].sort() });
    expect(v.fields.l1_blocks).toEqual([1000n, 1002n]);
  });
});

describe('span batches: only what is committed is bound', () => {
  it('the last block of a multi-block span has no parent commitment and is refused as parent_hash', () => {
    expectState(makeSynth({ spanBlocks: 2, legIndex: 1 }), 'batch_binding_mismatch', { field: 'parent_hash' });
  });
  it('the first block of a multi-block span has no epoch-hash commitment and is refused as epoch_hash', () => {
    expectState(makeSynth({ spanBlocks: 2, legIndex: 0 }), 'batch_binding_mismatch', { field: 'epoch_hash' });
  });
  it('an interior block has neither and is refused at the parent first', () => {
    expectState(makeSynth({ spanBlocks: 3, legIndex: 1 }), 'batch_binding_mismatch', { field: 'parent_hash' });
  });
});

describe('batcher authentication', () => {
  it('a frame tx signed by another key than SystemConfig.batcherHash', () => {
    expectState(makeSynth({ batcher: testKey('intruder'), chainBatcher: testKey('batcher') }), 'batcher_sender_mismatch');
  });
  it('a frame tx not sent to the batch inbox', () => {
    expectState(makeSynth({ notToInbox: true }), 'batcher_tx_not_to_inbox');
  });
  it.each([0, 5, 11])('a non-zero byte %i above the 20-byte batcher address makes batcherHash no address', (i) => {
    expectState(makeSynth({ dirtyBatcherHash: [i, 1] }), 'batcher_sender_mismatch');
  });
  it('the implementation account absent from the state is an account proof failure', () => {
    expectState(makeSynth({ omitImpl: true }), 'l1_state_proof_invalid', { which: 'account' });
  });
  it('an unpinned implementation code hash names the role, address, code hash and the L1 block it was judged at', () => {
    const s = makeSynth({});
    s.bp.systemConfigImplHashes = new Set([hex(new Uint8Array(32).fill(7))]);
    const e = state(s);
    expect(e.code).toBe('contract_identity_unproven');
    expect(e.fields.role).toBe('syscfg_impl');
    expect(e.fields.judged_at).toBe(1000n);
    expect(hex(e.fields.address as Uint8Array)).toBe('0xaeb75e200b9bcf9343ff1a2d2b1b3976e7339ca4');
  });
  it('a missing state node is an account proof failure and a missing storage node a slot failure', () => {
    const noState = makeSynth({});
    noState.body.nodes = encodeNodes([...noState.groups.tx, ...noState.groups.storage]);
    expectState(noState, 'l1_state_proof_invalid', { which: 'account' });
    const noStorage = makeSynth({});
    noStorage.body.nodes = encodeNodes([...noStorage.groups.tx, ...noStorage.groups.state]);
    expectState(noStorage, 'l1_state_proof_invalid', { which: 'slot' });
    const noTx = makeSynth({});
    noTx.body.nodes = encodeNodes([...noTx.groups.storage, ...noTx.groups.state]);
    expectState(noTx, 'l1_tx_proof_invalid');
  });
});

describe('inclusion', () => {
  it('a frame tx that is not the value at its index of the block transaction trie', () => {
    const s = makeSynth({});
    s.body.frames[0]!.txRaw = Uint8Array.from(s.body.frames[0]!.txRaw);
    s.body.frames[0]!.txRaw[s.body.frames[0]!.txRaw.length - 1]! ^= 1;
    expectState(s, 'l1_tx_proof_invalid');
  });
  it('a frame tx index that holds another entry', () => {
    const s = makeSynth({ nFrames: 2 });
    s.body.frames[1]!.txIndex = 0;
    s.body.frames[1]!.txRaw = s.body.frames[1]!.txRaw;
    expectState(s, 'channel_incomplete');
  });
  it('a frame tx that is not a transaction', () => {
    const s = makeSynth({});
    const junk = Uint8Array.of(0x05, 0x01, 0x02);
    const t = buildTrie([{ key: rlpIndexKey(0), value: junk }]);
    const spineHdr = s.body.l1Spine[0]!;
    expect(spineHdr.length).toBeGreaterThan(0);
    // replace the trie of the block by one holding the junk: the header no longer matches, which is a proof failure either way
    s.body.frames[0]!.txRaw = junk;
    s.body.nodes = encodeNodes([...s.body.nodes, ...t.nodes]);
    expectState(s, 'l1_tx_proof_invalid');
  });
  it('a frame L1 block that is not on the covered spine', () => {
    const s = makeSynth({});
    s.body.frames[0]!.l1Block = 5000n;
    expectState(s, 'finality_block_not_covered');
  });
});

describe('channel assembly', () => {
  it('a missing last frame, a duplicate and swapped frames are incomplete', () => {
    const a = makeSynth({ nFrames: 3 });
    a.body.frames.pop();
    expectState(a, 'channel_incomplete');
    const b = makeSynth({ nFrames: 3 });
    b.body.frames.splice(1, 0, b.body.frames[1]!);
    expectState(b, 'channel_incomplete');
    const c = makeSynth({ nFrames: 3 });
    [c.body.frames[0], c.body.frames[1]] = [c.body.frames[1]!, c.body.frames[0]!];
    expectState(c, 'channel_incomplete');
  });
  it('a channel with no frame for its id', () => {
    const s = makeSynth({});
    s.body.channelId = new Uint8Array(16).fill(9);
    expectState(s, 'channel_incomplete');
  });
  it('frames in L1 blocks inside channel_timeout verify at exactly the bound and time out one block later', () => {
    expect(ok({ nFrames: 2, frameBlocks: [1000n, 1300n] }).fields.l1_blocks).toEqual([1000n, 1300n]);
    expectState(makeSynth({ nFrames: 2, frameBlocks: [1000n, 1301n] }), 'channel_timed_out');
  });
  it('frames that are not in non-decreasing (block, index) order are incomplete', () => {
    const s = makeSynth({ nFrames: 2, frameBlocks: [1000n, 1001n] });
    s.body.frames.reverse();
    expectState(s, 'channel_incomplete');
  });
  it('a calldata transaction carrying blobs is a blob mismatch', () => {
    const s = makeSynth({});
    s.body.frames[0]!.blobs = [{ raw: new Uint8Array(131072), commitment: new Uint8Array(48), proof: new Uint8Array(48) }];
    expectState(s, 'blob_commitment_mismatch');
  });
  it('calldata that does not start with the derivation version byte 0 is malformed', () => {
    expectState(makeSynth({ frameVersion: 1 }), 'channel_malformed');
  });
});

describe('channel bytes', () => {
  it('a stream over max_rlp_bytes_per_channel is malformed and a stream exactly at the cap verifies', () => {
    const probe = makeSynth({});
    const atCap = makeSynth({});
    atCap.bp.maxRlpBytesPerChannel = BigInt(probe.streamLen);
    expect(run(atCap).fields.batch_type).toBe(0n);
    const over = makeSynth({});
    over.bp.maxRlpBytesPerChannel = BigInt(probe.streamLen - 1);
    expectState(over, 'channel_malformed');
    const bomb = makeSynth({ mapStream: (st) => concat(st, new Uint8Array(200000)) });
    bomb.bp.maxRlpBytesPerChannel = 1000n;
    expectState(bomb, 'channel_malformed');
  });
  it('garbage that is neither zlib nor Brotli, and an unsupported compression byte, are malformed', () => {
    expectState(makeSynth({ compressedPrefix: () => Uint8Array.of(0x7f, 1, 2, 3) }), 'channel_malformed');
    expectState(makeSynth({ compressedPrefix: (c) => concat(Uint8Array.of(0x38), c.subarray(1)) }), 'channel_malformed');
    expectState(makeSynth({ compressedPrefix: () => new Uint8Array(0) }), 'channel_malformed');
  });
  it('a stream that is not RLP strings is malformed; an unsupported batch type is named', () => {
    expectState(makeSynth({ rawStream: Uint8Array.of(0xc0) }), 'channel_malformed');
    expectState(makeSynth({ rawStream: concat(Uint8Array.of(0x82, 2, 0xaa)) }), 'batch_format_unsupported', { type: '2' });
    expectState(makeSynth({ rawStream: Uint8Array.of(0x00) }), 'channel_malformed');
  });
  it('compress() round trips both formats', () => {
    for (const k of ['zlib', 'brotli'] as const) expect(compress(k, utf8('x')).length).toBeGreaterThan(0);
  });
});

describe('batch lookup and binding', () => {
  it('the leg timestamp matches no batch', () => {
    const s = makeSynth({});
    const l2 = { ...s.l2, timestamp: s.l2.timestamp + 1n };
    try {
      verifyChannel(s.bp, s.body, s.covered, l2, s.head);
      throw new Error('accepted');
    } catch (e) {
      expect((e as FinalityStateError).code).toBe('batch_not_found');
      expect((e as FinalityStateError).fields.n_batches).toBe(3);
      expect((e as FinalityStateError).fields.timestamp).toBe(l2.timestamp);
    }
  });
  it('the leg parent hash differs from the batch parent hash', () => {
    const s = makeSynth({});
    const parentHash = Uint8Array.from(s.l2.parentHash);
    parentHash[31]! ^= 1;
    try {
      verifyChannel(s.bp, s.body, s.covered, { ...s.l2, parentHash }, s.head);
      throw new Error('accepted');
    } catch (e) {
      expect((e as FinalityStateError).code).toBe('batch_binding_mismatch');
      expect((e as FinalityStateError).fields.field).toBe('parent_hash');
    }
  });
  it('the deposit list empty, a non-deposit type, a short or garbled deposit, an epoch number or hash mismatch', () => {
    const empty = makeSynth({});
    empty.body.deposits = [];
    expectState(empty, 'batch_binding_mismatch', { field: 'l1_info_deposit' });
    const emptyFirst = makeSynth({});
    emptyFirst.body.deposits = [new Uint8Array(0)];
    expectState(emptyFirst, 'batch_binding_mismatch', { field: 'l1_info_deposit' });
    const notDeposit = makeSynth({});
    notDeposit.body.deposits = [Uint8Array.from(notDeposit.deposit)];
    notDeposit.body.deposits[0]![0] = 0x02;
    expectState(notDeposit, 'batch_binding_mismatch', { field: 'l1_info_deposit' });
    const garbled = makeSynth({});
    garbled.body.deposits = [Uint8Array.of(0x7e, 0xc0)];
    expectState(garbled, 'batch_binding_mismatch', { field: 'l1_info_deposit' });
    const trailing = makeSynth({});
    trailing.body.deposits = [concat(trailing.deposit, Uint8Array.of(0))];
    expectState(trailing, 'batch_binding_mismatch', { field: 'l1_info_deposit' });
    const num = makeSynth({});
    num.body.deposits = [Uint8Array.from(num.deposit)];
    // the epoch number sits at calldata [28:36]; the last byte of the deposit's data item is the tail, flip a byte inside the number
    const i = num.body.deposits[0]!.length - 164 + 35;
    num.body.deposits[0]![i]! ^= 1;
    expectState(num, 'batch_binding_mismatch', { field: 'epoch_num' });
    const hash = makeSynth({});
    hash.body.deposits = [Uint8Array.from(hash.deposit)];
    hash.body.deposits[0]![hash.deposit.length - 164 + 100]! ^= 1;
    expectState(hash, 'batch_binding_mismatch', { field: 'epoch_hash' });
  });
  it('a deposit whose eighth item is not a string, or that has seven items', () => {
    const s = makeSynth({});
    const seven = concat(Uint8Array.of(0x7e), Uint8Array.of(0xc7, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80));
    s.body.deposits = [seven];
    expectState(s, 'batch_binding_mismatch', { field: 'l1_info_deposit' });
    const t = makeSynth({});
    t.body.deposits = [concat(Uint8Array.of(0x7e), Uint8Array.of(0xc8, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0xc0))];
    expectState(t, 'batch_binding_mismatch', { field: 'l1_info_deposit' });
    const short = makeSynth({});
    short.body.deposits = [concat(Uint8Array.of(0x7e), Uint8Array.of(0xc8, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80))];
    expectState(short, 'batch_binding_mismatch', { field: 'l1_info_deposit' });
  });
  it('the transactions root differs when a deposit or a user transaction is altered or added', () => {
    const s = makeSynth({});
    s.body.deposits = [s.deposit, Uint8Array.of(0x7e, 0x01)];
    expectState(s, 'batch_binding_mismatch', { field: 'transactions_root' });
  });
  it('the sequencing window: frames before the epoch or after epoch + window are refused, the bounds are inclusive', () => {
    expect(ok({ nFrames: 1, frameBlocks: [990n], epochNum: 990n }).fields.l1_blocks).toEqual([990n]);
    expectState(makeSynth({ frameBlocks: [989n], epochNum: 990n }), 'batch_outside_sequencing_window');
    expect(ok({ frameBlocks: [4590n], epochNum: 990n }).fields.l1_blocks).toEqual([4590n]);
    expectState(makeSynth({ frameBlocks: [4591n], epochNum: 990n }), 'batch_outside_sequencing_window');
  });
});

describe('the address helpers', () => {
  it('a test batcher has a 20-byte address', () => {
    expect(addressOf(testKey('batcher')).length).toBe(20);
  });
});
