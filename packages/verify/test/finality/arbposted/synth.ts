/**
 * A synthetic Arbitrum batch on a synthetic Bridge, built at test time from fixed labels (the twin of the validator's buildertest). It drives
 * ArbPostedKind.verifyState directly with a state built in memory: the light-client part is exercised by the live vectors and by the ethl1
 * set; the Nitro payload layer (calldata flag, brotli, segments, messages, delayed segments, deposits), the Bridge identity and the
 * accumulator need a synthetic L1 whose storage the test controls.
 */
import { keccak_256 } from '@noble/hashes/sha3';
import { sha256 } from '@noble/hashes/sha2';
import { brotliCompressSync } from 'node:zlib';
import { buildTrie, rlpBytes, rlpListOf } from '../../../src/proof-v2/finality/baseposted/trie.js';
import { rlpUint } from '../../../src/proof-v2/finality/baseposted/ethtx.js';
import type { BlockRef } from '../../../src/proof-v2/finality/evidence.js';
import type { ArbPins } from '../../../src/proof-v2/finality/arbposted/pins.js';
import { ArbPostedKind } from '../../../src/proof-v2/finality/arbposted/verify.js';
import { accumulator, arrayElementSlot, dataHash, delayedMessageHash } from '../../../src/proof-v2/finality/arbposted/delayed.js';
import { DataBlobs, DataCalldata, type Blob, type Delayed, type Evidence } from '../../../src/proof-v2/finality/arbposted/wire.js';
import type { Verdict } from '../../../src/proof-v2/finality/registry.js';

export const hex = (b: Uint8Array): string => `0x${Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')}`;
export const unhex = (s: string): Uint8Array => Uint8Array.from(s.replace(/^0x/, '').match(/../g) ?? [], (h) => parseInt(h, 16));
export const concat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};
export const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
export const u64be = (v: bigint | number): Uint8Array => {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, BigInt(v), false);
  return b;
};
const label = (s: string): Uint8Array => keccak_256(utf8(`finality_arb_posted1/${s}`));
const trimmed = (v: bigint): Uint8Array => {
  const out: number[] = [];
  for (let x = v; x > 0n; x >>= 8n) out.unshift(Number(x & 0xffn));
  return Uint8Array.from(out);
};

export const BRIDGE = unhex('0x38f918D0E9F1b721EDaA41302E399fa1B79333a9');
export const IMPL = unhex('0xed26e46f38957763f83f2c45f6fb6702cfebc7d8');
export const IMPL_CODE_HASH = label('bridge implementation code');
export const EIP1967_IMPL_SLOT = unhex('0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc');
export const DEPOSITOR = unhex('0x1111111111111111111111111111111111111111');
export const RECIPIENT = unhex('0x2222222222222222222222222222222222222222');

export function newPins(): ArbPins {
  return {
    chainId: 421614n,
    parentChainId: 11155111n,
    boldGenesisL2Block: 100n,
    bridge: BRIDGE,
    layout: { assertionsSlot: 117n, accArraySlot: 7n, delayedAccArraySlot: 6n },
    logicPins: new Map([[hex(IMPL_CODE_HASH), 'bridge_impl']]),
    maxBlobs: 16,
    maxSegments: 102400,
    maxUncompressedBatch: 16777216,
  };
}

/** A type-2 style transaction (the content is irrelevant, only its encoding is compared): 0x02 || label. */
export const userTx = (n: number): Uint8Array => concat(Uint8Array.of(0x02), label(`user tx ${n}`));
/** An internal start-block transaction (type 0x6a). */
export const internalTx = (): Uint8Array => concat(Uint8Array.of(0x6a), label('start block'));

/** An ArbitrumDepositTx (type 0x64): [chainId, requestId, from, to, value]. */
export function depositTx(requestId: Uint8Array, from: Uint8Array, to: Uint8Array, value: bigint): Uint8Array {
  return concat(Uint8Array.of(0x64), rlpListOf([rlpUint(421614n), rlpBytes(requestId), rlpBytes(from), rlpBytes(to), rlpUint(value)]));
}

export const w32 = (v: bigint): Uint8Array => {
  const b = new Uint8Array(32);
  new DataView(b.buffer).setBigUint64(24, v, false);
  return b;
};

/** L2 message kind 4 carrying one signed transaction. */
export const msgTx = (tx: Uint8Array): Uint8Array => concat(Uint8Array.of(4), tx);
/** L2 message kind 3: a batch of nested messages (each prefixed by its u64 length). */
export const msgBatch = (subs: Uint8Array[]): Uint8Array => concat(Uint8Array.of(3), ...subs.map((s) => concat(u64be(s.length), s)));
/** A batch segment: kind byte then body, RLP-wrapped into the stream. */
export const seg = (kind: number, body: Uint8Array): Uint8Array => rlpBytes(concat(Uint8Array.of(kind), body));

/** The calldata payload of a segment stream: header byte 0x00 then the brotli stream. */
export const payloadOf = (stream: Uint8Array): Uint8Array => concat(Uint8Array.of(0), brotliCompressSync(stream));

export interface SynthOpts {
  /** the segments of the batch (default: one kind-0 message holding userTx(1), userTx(2); then a second message holding userTx(3)) */
  segments?: Uint8Array[];
  /** overrides the whole calldata */
  calldata?: Uint8Array;
  /** the block's transactions (default: [internal, userTx(1), userTx(2)]) */
  blockTxs?: Uint8Array[];
  batchSeq?: bigint;
  /** afterDelayedMessagesRead (default 0) */
  afterDelayed?: bigint;
  /** a delayed message to carry and to anchor in the Bridge (k, message) */
  delayed?: { msg: Delayed; prev?: Uint8Array; anchor?: boolean };
  /** the Bridge account exists (default true) */
  bridgeExists?: boolean;
  /** the implementation word of the Bridge (default IMPL) */
  implWord?: Uint8Array;
  /** the code hash of the implementation account (default IMPL_CODE_HASH) */
  implCodeHash?: Uint8Array;
  /** leave the implementation account out of the state */
  noImplAccount?: boolean;
  /** the accumulator stored for the batch (default: the recomputed one) */
  storedAcc?: Uint8Array;
  /** carry these blobs instead of calldata (the versioned hashes are derived from their commitments) */
  blobs?: Blob[];
  /** a non-zero word in the delayed accumulator slot just BEFORE element 0 (the slot k = 0 must not read) */
  poisonBeforeFirst?: boolean;
}

export interface Synth {
  pins: ArbPins;
  s: { hash: Uint8Array; number: bigint; stateRoot: Uint8Array };
  ref: BlockRef;
  ev: Evidence;
  kind: ArbPostedKind;
  /** the leg header (RLP, 15 items, item 14 = the 8-byte nonce) */
  header: Uint8Array;
  run: () => Verdict;
}

export function headerWithNonce(nonce: bigint): Uint8Array {
  const items: Uint8Array[] = [];
  for (let i = 0; i < 14; i++) items.push(rlpBytes(i === 8 ? Uint8Array.of(1) : new Uint8Array(i === 0 || i === 3 || i === 4 || i === 5 ? 32 : 0).fill(i + 1)));
  items.push(rlpBytes(u64be(nonce)));
  return rlpListOf(items);
}

export function makeSynth(o: SynthOpts = {}): Synth {
  const batchSeq = o.batchSeq ?? 77n;
  const segments = o.segments ?? [seg(0, msgTx(userTx(1))), seg(0, msgBatch([msgTx(userTx(2)), msgTx(userTx(3))]))];
  const calldata = o.calldata ?? payloadOf(concat(...segments));
  const blockTxs = o.blockTxs ?? [internalTx(), userTx(2), userTx(3)];
  const header40: [bigint, bigint, bigint, bigint, bigint] = [1n, 2n, 3n, 4n, o.afterDelayed ?? 0n];
  const beforeAcc = label('before acc');
  const delayedAcc = label('delayed acc');
  const ev: Evidence = {
    lc: { profile: 'eth-lc/1', anchorKind: 1, anchorPeriod: 0n, anchorRoot: new Uint8Array(32), anchorBody: { layout: 0, ssz: new Uint8Array(0) }, links: [], finalUpdate: { layout: 0, ssz: new Uint8Array(0) } },
    l1Spine: [],
    stateBlock: 7_000_000n,
    blockTxs,
    batchSeq,
    header40,
    beforeAcc,
    delayedAcc,
    dataKind: DataCalldata,
    versionedHashes: [],
    blobs: [],
    calldata,
    delayed: o.delayed?.msg ?? null,
    nodes: [],
  };
  if (o.blobs !== undefined) {
    ev.dataKind = DataBlobs;
    ev.blobs = o.blobs;
    ev.calldata = new Uint8Array(0);
    ev.versionedHashes = o.blobs.map((b) => {
      const h = sha256(b.commitment);
      h[0] = 0x01;
      return h;
    });
  }
  const pins = newPins();
  // the Bridge storage: the implementation word, acc[N] and (optionally) the delayed accumulators
  const acc = o.storedAcc ?? accumulator(beforeAcc, dataHash(ev), delayedAcc);
  const storage: { key: Uint8Array; value: Uint8Array }[] = [];
  const put = (slot: Uint8Array, value: Uint8Array): void => {
    let i = 0;
    while (i < value.length && value[i] === 0) i++;
    storage.push({ key: keccak_256(slot), value: rlpBytes(value.subarray(i)) });
  };
  put(EIP1967_IMPL_SLOT, o.implWord ?? concat(new Uint8Array(12), IMPL));
  put(arrayElementSlot(pins.layout.accArraySlot, batchSeq), acc);
  if (o.delayed !== undefined && o.delayed.anchor !== false) {
    const d = o.delayed.msg;
    const prev = o.delayed.prev ?? label('delayed prev');
    if (d.k > 0n) put(arrayElementSlot(pins.layout.delayedAccArraySlot, d.k - 1n), prev);
    put(arrayElementSlot(pins.layout.delayedAccArraySlot, d.k), keccak_256(concat(d.k > 0n ? prev : new Uint8Array(32), delayedMessageHash(d))));
  }
  if (o.poisonBeforeFirst) put(arrayElementSlot(pins.layout.delayedAccArraySlot, (1n << 256n) - 1n), label('poison'));
  const st = buildTrie(storage);
  const account = (storageRoot: Uint8Array, codeHash: Uint8Array): Uint8Array =>
    rlpListOf([rlpBytes(trimmed(1n)), rlpBytes(trimmed(0n)), rlpBytes(storageRoot), rlpBytes(codeHash)]);
  const emptyRoot = unhex('0x56e81f171bcc55a6ff8345e692c0f86e5b48e01b996cadc001622fb5e363b421');
  const stateEntries: { key: Uint8Array; value: Uint8Array }[] = [];
  if (o.bridgeExists !== false) stateEntries.push({ key: keccak_256(BRIDGE), value: account(st.root, label('bridge proxy code')) });
  if (!o.noImplAccount) stateEntries.push({ key: keccak_256(IMPL), value: account(emptyRoot, o.implCodeHash ?? IMPL_CODE_HASH) });
  const sta = buildTrie(stateEntries);
  ev.nodes = [...st.nodes, ...sta.nodes];
  const s = { hash: label('l1 block'), number: ev.stateBlock, stateRoot: sta.root };
  const header = headerWithNonce(2224515n);
  const ref: BlockRef = { chain: 421614n, number: 320996260n, hash: label('l2 block'), headerRlp: header };
  const kind = new ArbPostedKind();
  return { pins, s, ref, ev, kind, header, run: () => kind.verifyState(pins, s, ref, ev) };
}

/** The delayed ETH-deposit message of the synthetic batch: kind 12, data = recipient || value. */
export function depositMessage(k: bigint, value: bigint = 5n): Delayed {
  return {
    msgKind: 12,
    sender: DEPOSITOR,
    msgBlockNumber: 6_999_990n,
    msgTimestamp: 1_700_000_000n,
    baseFeeL1: w32(7n),
    data: concat(RECIPIENT, w32(value)),
    k,
  };
}

/** nitro@ccc5c82 zeroheavy.ZeroheavyEncoder over a byte slice (the inverse the zero-heavy decoder is tested against; the twin of Go's zhEncode test helper). */
export function zhEncode(input: Uint8Array): Uint8Array {
  const out: number[] = [];
  let pos = 0;
  let bitsRead = 8;
  let buffer = 0;
  let padding = false;
  let atEOF = false;
  const next = (): boolean => {
    if (padding) return true;
    if (bitsRead === 8) {
      if (pos >= input.length) {
        padding = true;
        return false;
      }
      buffer = input[pos++]!;
      bitsRead = 0;
    }
    const r = (buffer & (1 << (7 - bitsRead))) !== 0;
    bitsRead++;
    return r;
  };
  while (!atEOF) {
    let ret = 0;
    if (!next()) {
      if (next()) {
        ret = 1;
        for (let i = 0; i < 6; i++) {
          ret <<= 1;
          if (next()) ret++;
        }
        if (ret === 64) {
          ret = 1;
        } else {
          ret = (ret << 1) & 0x7f;
          if (next()) ret++;
        }
      }
    } else {
      ret = 1;
      for (let i = 0; i < 7; i++) {
        ret <<= 1;
        if (next()) ret++;
      }
    }
    out.push(ret);
    if (padding) atEOF = true;
  }
  return Uint8Array.from(out);
}

/** A zero-heavy payload: the flag 0x20, then the layer encoding of the inner payload. */
export const zhPayload = (inner: Uint8Array): Uint8Array => concat(Uint8Array.of(0x20), zhEncode(inner));
