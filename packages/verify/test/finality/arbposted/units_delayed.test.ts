/**
 * The Bridge arithmetic and delayed-inbox helpers (delayed.ts): slot derivation, the accumulator and data hash formulas, the delayed
 * message hash, the L2 header nonce reader and the transaction type reader.
 */
import { keccak_256 } from '@noble/hashes/sha3';
import { describe, expect, it } from 'vitest';
import {
  verifyDelayed,
  accumulator,
  arrayElementSlot,
  dataHash,
  delayedMessageHash,
  header40Bytes,
  headerNonce,
  isDelayedOriginType,
  txType,
  w32,
} from '../../../src/proof-v2/finality/arbposted/delayed.js';
import { DataBlobs, DataCalldata } from '../../../src/proof-v2/finality/arbposted/wire.js';
import { rlpBytes, rlpListOf } from '../../../src/proof-v2/finality/baseposted/trie.js';
import { verifyAccount } from '../../../src/s6/mpt.js';
import { FinalityStateError } from '../../../src/proof-v2/finality/state.js';
import type { PayloadResult } from '../../../src/proof-v2/finality/arbposted/nitro.js';
import { BRIDGE, DEPOSITOR, RECIPIENT, concat, depositMessage, depositTx, headerWithNonce, hex, makeSynth, seg, u64be, unhex, utf8 } from './synth.js';

describe('w32 and header40', () => {
  it('w32 is the big-endian 32-byte word of a uint64; header40 is five big-endian uint64', () => {
    expect(hex(w32(1n))).toBe(`0x${'00'.repeat(31)}01`);
    expect(hex(w32(0x0102030405060708n))).toBe(`0x${'00'.repeat(24)}0102030405060708`);
    expect(hex(header40Bytes([1n, 2n, 3n, 4n, 5n]))).toBe(`0x${[1, 2, 3, 4, 5].map((x) => `${'00'.repeat(7)}0${x}`).join('')}`);
    expect(header40Bytes([0n, 0n, 0n, 0n, (1n << 64n) - 1n]).subarray(32)).toEqual(new Uint8Array(8).fill(255));
  });
});

describe('arrayElementSlot (keccak256(w(base)) + n)', () => {
  it('slot 0 of base 0 is keccak256 of 32 zero bytes (the well-known first dynamic array slot)', () => {
    expect(hex(arrayElementSlot(0n, 0n))).toBe('0x290decd9548b62a8d60345a988386fc84ba6bc95484008f6362f93160ef3e563');
  });
  it('element n adds n to the 256-bit number, with carries through every byte', () => {
    expect(hex(arrayElementSlot(0n, 1n))).toBe('0x290decd9548b62a8d60345a988386fc84ba6bc95484008f6362f93160ef3e564');
    expect(hex(arrayElementSlot(0n, 0x1bn))).toBe('0x290decd9548b62a8d60345a988386fc84ba6bc95484008f6362f93160ef3e57e');
    // 0xe563 + 0x1a9d = 0x10000: the carry runs through two bytes
    expect(hex(arrayElementSlot(0n, 0x1a9dn)).slice(-12)).toBe('93160ef40000');
    const base = keccak_256(w32(7n));
    const n = 883753n;
    let v = 0n;
    for (const b of base) v = (v << 8n) | BigInt(b);
    v += n;
    expect(hex(arrayElementSlot(7n, n))).toBe(`0x${v.toString(16).padStart(64, '0')}`);
    expect(hex(arrayElementSlot(6n, 41n))).not.toBe(hex(arrayElementSlot(7n, 41n)));
  });
  it('a large n carries into higher bytes and a sum past 2^256 wraps (common.BigToHash keeps the low 32 bytes)', () => {
    const big = (1n << 64n) - 1n;
    const base = keccak_256(w32(7n));
    let v = 0n;
    for (const b of base) v = (v << 8n) | BigInt(b);
    expect(hex(arrayElementSlot(7n, big))).toBe(`0x${((v + big) & ((1n << 256n) - 1n)).toString(16).padStart(64, '0')}`);
  });
});

describe('dataHash and accumulator (annex A6.2)', () => {
  const h40: [bigint, bigint, bigint, bigint, bigint] = [11n, 22n, 33n, 44n, 55n];
  const vh = [new Uint8Array(32).fill(1), new Uint8Array(32).fill(2)];
  it('calldata: keccak256(header40 || data); blobs: keccak256(header40 || 0x50 || versionedHashes...) in order', () => {
    const data = utf8('batch data');
    expect(dataHash({ header40: h40, dataKind: DataCalldata, versionedHashes: [], calldata: data })).toEqual(keccak_256(concat(header40Bytes(h40), data)));
    expect(dataHash({ header40: h40, dataKind: DataBlobs, versionedHashes: vh, calldata: data })).toEqual(keccak_256(concat(header40Bytes(h40), Uint8Array.of(0x50), vh[0]!, vh[1]!)));
    expect(dataHash({ header40: h40, dataKind: DataBlobs, versionedHashes: [vh[1]!, vh[0]!], calldata: data })).not.toEqual(dataHash({ header40: h40, dataKind: DataBlobs, versionedHashes: vh, calldata: data }));
    expect(dataHash({ header40: h40, dataKind: DataBlobs, versionedHashes: [], calldata: data })).toEqual(keccak_256(concat(header40Bytes(h40), Uint8Array.of(0x50))));
  });
  it('the accumulator is keccak256(beforeAcc || dataHash || delayedAcc) and each input matters', () => {
    const a = new Uint8Array(32).fill(1);
    const b = new Uint8Array(32).fill(2);
    const c = new Uint8Array(32).fill(3);
    expect(accumulator(a, b, c)).toEqual(keccak_256(concat(a, b, c)));
    expect(accumulator(b, a, c)).not.toEqual(accumulator(a, b, c));
    expect(accumulator(a, c, b)).not.toEqual(accumulator(a, b, c));
  });
});

describe('delayedMessageHash (Messages.messageHash)', () => {
  const d = depositMessage(41n);
  const base = keccak_256(concat(Uint8Array.of(12), d.sender, u64be(d.msgBlockNumber), u64be(d.msgTimestamp), w32(41n), d.baseFeeL1, keccak_256(d.data)));
  it('keccak256(kind, sender, blockNumber, timestamp, k as u256, baseFeeL1, keccak256(data))', () => {
    expect(delayedMessageHash(d)).toEqual(base);
  });
  it('each field changes the hash', () => {
    const variants = [
      { ...d, msgKind: 9 },
      { ...d, sender: new Uint8Array(20).fill(7) },
      { ...d, msgBlockNumber: d.msgBlockNumber + 1n },
      { ...d, msgTimestamp: d.msgTimestamp + 1n },
      { ...d, k: 42n },
      { ...d, baseFeeL1: w32(9n) },
      { ...d, data: concat(d.data, Uint8Array.of(0)) },
    ];
    for (const v of variants) expect(delayedMessageHash(v)).not.toEqual(base);
  });
});

describe('headerNonce (RLP item 14 as an 8-byte string)', () => {
  it('reads the 15th item', () => {
    expect(headerNonce(headerWithNonce(2224515n))).toBe(2224515n);
    expect(headerNonce(headerWithNonce(0n))).toBe(0n);
    expect(headerNonce(headerWithNonce((1n << 64n) - 1n))).toBe((1n << 64n) - 1n);
  });
  it('anything else is undefined: fewer than 15 items, a shorter or longer string, a single byte, a list, not a list, garbage, empty', () => {
    const items = (n: number, at14: Uint8Array): Uint8Array => rlpListOf([...Array.from({ length: n }, (_, i) => rlpBytes(Uint8Array.of(i + 1, 9))), ...(n >= 14 ? [at14] : [])]);
    expect(headerNonce(items(13, rlpBytes(u64be(5))))).toBeUndefined();
    expect(headerNonce(rlpListOf(Array.from({ length: 14 }, () => rlpBytes(Uint8Array.of(1, 2)))))).toBeUndefined();
    expect(headerNonce(items(14, rlpBytes(u64be(5)).subarray(0, 0)))).toBeUndefined();
    const with14 = (v: Uint8Array): Uint8Array => rlpListOf([...Array.from({ length: 14 }, () => rlpBytes(Uint8Array.of(1, 2))), v]);
    expect(headerNonce(with14(rlpBytes(new Uint8Array(7).fill(3))))).toBeUndefined();
    expect(headerNonce(with14(rlpBytes(new Uint8Array(9).fill(3))))).toBeUndefined();
    expect(headerNonce(with14(rlpBytes(Uint8Array.of(5))))).toBeUndefined();
    expect(headerNonce(with14(rlpListOf([])))).toBeUndefined();
    expect(headerNonce(with14(rlpBytes(u64be(5))))).toBe(5n);
    expect(headerNonce(utf8('not a list'))).toBeUndefined();
    expect(headerNonce(new Uint8Array(0))).toBeUndefined();
    expect(headerNonce(Uint8Array.of(0xf8))).toBeUndefined();
    // an item before item 14 that does not parse
    expect(headerNonce(concat(Uint8Array.of(0xc3, 0xb8, 0x05, 0x01)))).toBeUndefined();
  });
  it('bytes after the list are ignored, as rlp.SplitList ignores them', () => {
    expect(headerNonce(concat(headerWithNonce(77n), Uint8Array.of(1, 2, 3)))).toBe(77n);
  });
});

describe('txType and the delayed-origin types', () => {
  it('the type is the first byte; a legacy RLP list (>= 0xc0) and the empty string are type 0', () => {
    expect(txType(Uint8Array.of(0x02, 1))).toBe(2);
    expect(txType(Uint8Array.of(0x64))).toBe(0x64);
    expect(txType(Uint8Array.of(0xc0))).toBe(0);
    expect(txType(Uint8Array.of(0xff))).toBe(0);
    expect(txType(Uint8Array.of(0xbf))).toBe(0xbf);
    expect(txType(new Uint8Array(0))).toBe(0);
    expect(txType(unhex('0x00'))).toBe(0);
  });
  it('0x64, 0x65, 0x66 and 0x69 are delayed-origin; 0x67, 0x68, 0x6a and the standard types are not', () => {
    for (const t of [0x64, 0x65, 0x66, 0x69]) expect(isDelayedOriginType(t)).toBe(true);
    for (const t of [0, 1, 2, 3, 4, 0x63, 0x67, 0x68, 0x6a, 0x6b]) expect(isDelayedOriginType(t)).toBe(false);
  });
});

describe('verifyDelayed reads the Bridge storage through proofs', () => {
  const res: PayloadResult = { messages: [], segments: 1, delayedSegments: 1, headerByte: 0, status: 0, exceededUncompressed: false, exceededSegments: false };
  const make = () => {
    const s = makeSynth({ segments: [seg(2, new Uint8Array(0))], blockTxs: [depositTx(w32(41n), DEPOSITOR, RECIPIENT, 5n)], afterDelayed: 42n, delayed: { msg: depositMessage(41n) } });
    const acct = verifyAccount(s.s.stateRoot, BRIDGE, s.ev.nodes);
    return { s, root: acct.storageRoot };
  };
  const named = (f: () => unknown): FinalityStateError => {
    try {
      f();
    } catch (e) {
      if (e instanceof FinalityStateError) return e;
      throw e;
    }
    throw new Error('accepted');
  };
  it('proves k and k-1 with the full node set', () => {
    const { s, root } = make();
    expect(verifyDelayed(s.pins, root, s.ev, res, [106n, 100n], 5n)).toBe(41n);
  });
  it('a node set that cannot prove the slots is l1_state_proof_invalid{slot}, not a raw proof error', () => {
    const { s, root } = make();
    expect(named(() => verifyDelayed(s.pins, root, { ...s.ev, nodes: [] }, res, [106n, 100n], 5n)).canonical()).toBe(
      '{"code":"l1_state_proof_invalid","fields":{"which":"slot"}}',
    );
    expect(named(() => verifyDelayed(s.pins, root, { ...s.ev, nodes: [new Uint8Array([0xc0])] }, res, [106n], 5n)).code).toBe('l1_state_proof_invalid');
    const wrongRoot = new Uint8Array(32).fill(5);
    expect(named(() => verifyDelayed(s.pins, wrongRoot, s.ev, res, [106n], 5n)).fields).toEqual({ which: 'slot' });
  });
  it('no Delayed section is unproven with only the types and the nonce', () => {
    const { s, root } = make();
    expect(named(() => verifyDelayed(s.pins, root, { ...s.ev, delayed: null }, res, [106n, 100n], 5n)).canonical()).toBe(
      '{"code":"l1_posted_delayed_origin_unproven","fields":{"block_tx_types":["106","100"],"header_nonce":"5"}}',
    );
  });
});
