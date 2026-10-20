/**
 * A synthetic Base channel on a synthetic Sepolia L1, built at test time from fixed labels (the twin of the validator's synth_test.go
 * builder). It drives verifyChannel directly: the light-client part is exercised by the live vectors and by the ethl1 set, the blob part
 * by the live vectors; calldata frames, zlib, span batches and every authentication refusal need a synthetic L1.
 */
import { keccak_256 } from '@noble/hashes/sha3';
import { secp256k1 } from '@noble/curves/secp256k1';
import { brotliCompressSync, deflateSync } from 'node:zlib';
import type { L1Block } from '../../../src/proof-v2/finality/ethl1/index.js';
import { readHeader, type HeaderFields } from '../../../src/proof-v2/finality/rlpheader.js';
import { marshalFrame } from '../../../src/proof-v2/finality/baseposted/channel.js';
import { rlpBytes as encBytes, rlpIndexKey, rlpListOf, buildTrie, trieRoot } from '../../../src/proof-v2/finality/baseposted/trie.js';
import { encodeDynamicFeeTx, rlpUint } from '../../../src/proof-v2/finality/baseposted/ethtx.js';
import type { BasePins } from '../../../src/proof-v2/finality/baseposted/pins.js';
import type { Body, FrameTx } from '../../../src/proof-v2/finality/baseposted/wire.js';
import { encodeNodes } from '../../../src/proof-v2/finality/codec.js';

export const hex = (b: Uint8Array): string => `0x${Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')}`;
export const unhex = (s: string): Uint8Array => Uint8Array.from(s.replace(/^0x/, '').match(/../g) ?? [], (h) => parseInt(h, 16));
const concat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};
const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
const u64be = (v: bigint | number): Uint8Array => {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, BigInt(v), false);
  return b;
};
const uvarint = (v: bigint | number): Uint8Array => {
  let x = BigInt(v);
  const out: number[] = [];
  while (x >= 0x80n) {
    out.push(Number(x & 0x7fn) | 0x80);
    x >>= 7n;
  }
  out.push(Number(x));
  return Uint8Array.from(out);
};

export const TEST_INBOX = unhex('0xff00000000000000000000000000000000084532');
export const TEST_SYSCFG = unhex('0xf272670eb55e895584501d564afeb048bed26194');
export const TEST_IMPL = unhex('0xaeb75e200b9bcf9343ff1a2d2b1b3976e7339ca4');
export const TEST_IMPL_CODE = keccak_256(utf8('synthetic syscfg implementation'));
export const SEPOLIA = 11155111n;

export const testKey = (label: string): Uint8Array => keccak_256(utf8(`finality_base_posted1/${label}`));
export const addressOf = (priv: Uint8Array): Uint8Array => keccak_256(secp256k1.getPublicKey(priv, false).subarray(1)).slice(12);

export function newPins(): BasePins {
  return {
    chainId: 84532n,
    l1ChainId: SEPOLIA,
    systemConfig: TEST_SYSCFG,
    batchInbox: TEST_INBOX,
    seqWindowSize: 3600n,
    channelTimeout: 300n,
    maxRlpBytesPerChannel: 100_000_000n,
    isthmusTime: 1744905600n,
    denimTime: 1792605600n,
    maxBlobs: 32,
    l2GenesisTime: 1695768288n,
    l2BlockTime: 2n,
    kzgSetupSha256: 'f8e44a31ebf0a6d0734dcb301b0716e2c77f3ae18ed0cab0870fbcc2ca55616f',
    systemConfigImplHashes: new Set([hex(TEST_IMPL_CODE)]),
  };
}

export interface SynthOpts {
  compression?: 'zlib' | 'brotli';
  nFrames?: number;
  /** span batch with this many L2 blocks; the leg is block legIndex */
  spanBlocks?: number;
  legIndex?: number;
  batchTs?: bigint;
  frameBlocks?: bigint[];
  epochNum?: bigint;
  /** signs the frame txs */
  batcher?: Uint8Array;
  /** the batcher recorded in SystemConfig (default: the signing key) */
  chainBatcher?: Uint8Array;
  notToInbox?: boolean;
  /** a non-zero byte above the 20-byte batcher address in batcherHash: [index 0..11, value] */
  dirtyBatcherHash?: [number, number];
  omitImpl?: boolean;
  /** compress the stream of these raw bytes instead of the generated one */
  rawStream?: Uint8Array;
  /** replace the generated stream by this one before compression */
  mapStream?: (s: Uint8Array) => Uint8Array;
  /** the first byte of the compressed channel overrides (for unsupported compression types) */
  compressedPrefix?: (c: Uint8Array) => Uint8Array;
  extraSingular?: number;
  /** the derivation version byte of every frame transaction's calldata (default 0) */
  frameVersion?: number;
}

export interface Synth {
  bp: BasePins;
  body: Body;
  covered: L1Block[];
  l2: HeaderFields;
  l2Raw: Uint8Array;
  head: { slot: bigint; epoch: bigint };
  txs: Uint8Array[];
  deposit: Uint8Array;
  epochHash: Uint8Array;
  parent: Uint8Array;
  batcherAddr: Uint8Array;
  batchTs: bigint;
  /** the length of the uncompressed channel stream */
  streamLen: number;
  /** the trie nodes of the synthetic L1, by the trie they belong to */
  groups: { tx: Uint8Array[]; storage: Uint8Array[]; state: Uint8Array[] };
}

export function l1InfoDeposit(number: bigint, hash: Uint8Array): Uint8Array {
  const data = new Uint8Array(164);
  data.set([0x09, 0x89, 0x99, 0xbe], 0);
  new DataView(data.buffer).setBigUint64(28, number, false);
  data.set(hash, 100);
  const items = [
    encBytes(keccak_256(utf8('deposit source'))),
    encBytes(Uint8Array.of(0xde, 0xad, ...new Uint8Array(18))),
    encBytes(Uint8Array.of(0x42, ...new Uint8Array(19))),
    rlpUint(0n),
    rlpUint(0n),
    rlpUint(1_000_000n),
    Uint8Array.of(0x80),
    encBytes(data),
  ];
  return concat(Uint8Array.of(0x7e), rlpListOf(items));
}

/** A type-2 transaction of the synthetic L2 block (the content is irrelevant, only its encoding is committed). */
export function userTx(nonce: bigint): Uint8Array {
  return encodeDynamicFeeTx({
    chainId: 84532n, nonce, gasTipCap: 1n, gasFeeCap: 2n, gas: 21000n, to: Uint8Array.of(9, ...new Uint8Array(19)), value: 1n,
    data: new Uint8Array(0), accessList: Uint8Array.of(0xc0), v: 0n, r: 1n, s: 1n,
  });
}

function signedFrameTx(priv: Uint8Array, nonce: bigint, to: Uint8Array, data: Uint8Array): Uint8Array {
  const fields = [rlpUint(SEPOLIA), rlpUint(nonce), rlpUint(1n), rlpUint(1000n), rlpUint(100000n), encBytes(to), rlpUint(0n), encBytes(data), Uint8Array.of(0xc0)];
  const hash = keccak_256(concat(Uint8Array.of(2), rlpListOf(fields)));
  const sig = secp256k1.sign(hash, priv);
  return encodeDynamicFeeTx({
    chainId: SEPOLIA, nonce, gasTipCap: 1n, gasFeeCap: 1000n, gas: 100000n, to, value: 0n, data, accessList: Uint8Array.of(0xc0),
    v: BigInt(sig.recovery), r: sig.r, s: sig.s,
  });
}

export function compress(kind: 'zlib' | 'brotli', raw: Uint8Array): Uint8Array {
  if (kind === 'brotli') return concat(Uint8Array.of(1), brotliCompressSync(raw));
  return deflateSync(raw);
}

function rlpStreamItem(typeByte: number, payload: Uint8Array): Uint8Array {
  return encBytes(concat(Uint8Array.of(typeByte), payload));
}

function singularPayload(parent: Uint8Array, epochNum: bigint, epochHash: Uint8Array, ts: bigint, txs: Uint8Array[]): Uint8Array {
  return rlpListOf([encBytes(parent), rlpUint(epochNum), encBytes(epochHash), rlpUint(ts), rlpListOf(txs.map(encBytes))]);
}

/** A span batch of `blocks` L2 blocks with one type-2 transaction each (tx i = userTx(i + 1)). */
export function spanPayload(bp: BasePins, batchTs: bigint, blocks: number, epochNum: bigint, parent: Uint8Array, epochHash: Uint8Array): Uint8Array {
  const out: Uint8Array[] = [];
  out.push(uvarint(batchTs - bp.l2GenesisTime));
  out.push(uvarint(epochNum));
  out.push(parent.slice(0, 20));
  out.push(epochHash.slice(0, 20));
  out.push(uvarint(blocks));
  const bitsLen = (n: number): number => Math.ceil(n / 8);
  out.push(new Uint8Array(bitsLen(blocks))); // origin bits: no block advances the origin
  for (let i = 0; i < blocks; i++) out.push(uvarint(1));
  const n = blocks;
  out.push(new Uint8Array(bitsLen(n))); // contract creation bits
  out.push(new Uint8Array(bitsLen(n))); // y parity bits: all zero (userTx v = 0)
  for (let i = 0; i < n; i++) out.push(concat(new Uint8Array(31).fill(0), Uint8Array.of(1), new Uint8Array(31).fill(0), Uint8Array.of(1))); // r = s = 1
  for (let i = 0; i < n; i++) out.push(Uint8Array.of(9, ...new Uint8Array(19)));
  for (let i = 0; i < n; i++) {
    // type 2 payload: rlp([value, tip, feeCap, data, accessList])
    out.push(concat(Uint8Array.of(2), rlpListOf([rlpUint(1n), rlpUint(1n), rlpUint(2n), encBytes(new Uint8Array(0)), Uint8Array.of(0xc0)])));
  }
  for (let i = 0; i < n; i++) out.push(uvarint(i + 1)); // nonces
  for (let i = 0; i < n; i++) out.push(uvarint(21000)); // gases
  return concat(...out);
}

function rawHeader(f: { parent: Uint8Array; root: Uint8Array; txRoot: Uint8Array; number: bigint; time: bigint }): Uint8Array {
  const z32 = new Uint8Array(32);
  return rlpListOf([
    encBytes(f.parent),
    encBytes(keccak_256(Uint8Array.of(0xc0))),
    encBytes(new Uint8Array(20)),
    encBytes(f.root),
    encBytes(f.txRoot),
    encBytes(keccak_256(Uint8Array.of(0x80))),
    encBytes(new Uint8Array(256)),
    rlpUint(0n),
    rlpUint(f.number),
    rlpUint(30_000_000n),
    rlpUint(0n),
    rlpUint(f.time),
    encBytes(new Uint8Array(0)),
    encBytes(z32),
    encBytes(new Uint8Array(8)),
  ]);
}

const trimLeft = (b: Uint8Array): Uint8Array => {
  let i = 0;
  while (i < b.length && b[i] === 0) i++;
  return b.subarray(i);
};
const pad32 = (b: Uint8Array): Uint8Array => concat(new Uint8Array(32 - b.length), b);
const SLOT_BATCHER = pad32(Uint8Array.of(103));
const SLOT_IMPL = unhex('0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc');
const EMPTY_ROOT = keccak_256(Uint8Array.of(0x80));

const account = (root: Uint8Array, codeHash: Uint8Array): Uint8Array => rlpListOf([rlpUint(1n), rlpUint(0n), encBytes(root), encBytes(codeHash)]);

export function makeSynth(o: SynthOpts = {}): Synth {
  const nFrames = o.nFrames ?? 1;
  const batcher = o.batcher ?? testKey('batcher');
  const chainBatcher = o.chainBatcher ?? batcher;
  const batchTs = o.batchTs ?? 1790000000n;
  const epochNum = o.epochNum ?? 990n;
  const bp = newPins();
  const epochHash = keccak_256(utf8('epoch hash'));
  const parent = keccak_256(utf8('parent'));
  const deposit = l1InfoDeposit(epochNum, epochHash);
  const spanBlocks = o.spanBlocks ?? 0;
  const legIndex = o.legIndex ?? 0;
  const users = [userTx(1n), userTx(2n)];
  let legTxs = users;
  let legTs = batchTs;
  let stream: Uint8Array;
  if (spanBlocks > 0) {
    legTxs = [userTx(BigInt(legIndex + 1))];
    legTs = batchTs + bp.l2BlockTime * BigInt(legIndex);
    stream = rlpStreamItem(1, spanPayload(bp, batchTs, spanBlocks, epochNum, parent, epochHash));
  } else {
    const parts = [rlpStreamItem(0, singularPayload(parent, epochNum, epochHash, batchTs, users))];
    for (let i = 1n; i <= BigInt(o.extraSingular ?? 2); i++) {
      parts.push(rlpStreamItem(0, singularPayload(keccak_256(Uint8Array.of(Number(i))), epochNum, epochHash, batchTs + 2n * i, [])));
    }
    stream = concat(...parts);
  }
  if (o.mapStream) stream = o.mapStream(stream);
  if (o.rawStream) stream = o.rawStream;
  let chData = compress(o.compression ?? 'zlib', stream);
  if (o.compressedPrefix) chData = o.compressedPrefix(chData);
  const id = keccak_256(utf8('channel')).slice(0, 16);
  const per = Math.ceil(chData.length / nFrames);
  const frameBytes: Uint8Array[] = [];
  for (let i = 0; i < nFrames; i++) {
    const hi = Math.min((i + 1) * per, chData.length);
    const lo = Math.min(i * per, hi);
    frameBytes.push(concat(Uint8Array.of(o.frameVersion ?? 0), marshalFrame({ id, number: i, data: chData.subarray(lo, hi), isLast: i === nFrames - 1 })));
  }
  const blocks = o.frameBlocks ?? new Array<bigint>(nFrames).fill(1000n);
  const byBlock = new Map<bigint, number[]>();
  const order: bigint[] = [];
  blocks.forEach((b, i) => {
    if (!byBlock.has(b)) {
      byBlock.set(b, []);
      order.push(b);
    }
    byBlock.get(b)!.push(i);
  });
  const batcherHash = new Uint8Array(32);
  batcherHash.set(addressOf(chainBatcher), 12);
  if (o.dirtyBatcherHash) batcherHash[o.dirtyBatcherHash[0]] = o.dirtyBatcherHash[1];
  const body: Body = {
    lc: undefined as never,
    l1Spine: [],
    channelId: id,
    frames: [],
    deposits: [deposit],
    nodes: [],
  };
  const covered: L1Block[] = [];
  const spine: { n: bigint; raw: Uint8Array; blk: L1Block }[] = [];
  const nodes: Uint8Array[] = [];
  const groups = { tx: [] as Uint8Array[], storage: [] as Uint8Array[], state: [] as Uint8Array[] };
  for (const blk of order) {
    const raws: Uint8Array[] = [];
    for (const i of byBlock.get(blk)!) {
      const to = o.notToInbox ? Uint8Array.of(0xaa, ...new Uint8Array(19)) : TEST_INBOX;
      raws.push(signedFrameTx(batcher, BigInt(i), to, frameBytes[i]!));
    }
    const txT = buildTrie(raws.map((value, k) => ({ key: rlpIndexKey(k), value })));
    const storage = buildTrie([
      { key: keccak_256(SLOT_BATCHER), value: encBytes(trimLeft(batcherHash)) },
      { key: keccak_256(SLOT_IMPL), value: encBytes(trimLeft(pad32(TEST_IMPL))) },
    ]);
    const stateEntries = [{ key: keccak_256(TEST_SYSCFG), value: account(storage.root, keccak_256(utf8('proxy'))) }];
    if (!o.omitImpl) stateEntries.push({ key: keccak_256(TEST_IMPL), value: account(EMPTY_ROOT, TEST_IMPL_CODE) });
    const state = buildTrie(stateEntries);
    nodes.push(...txT.nodes, ...storage.nodes, ...state.nodes);
    groups.tx.push(...txT.nodes);
    groups.storage.push(...storage.nodes);
    groups.state.push(...state.nodes);
    raws.forEach((txRaw, k) => body.frames.push({ l1Block: blk, txIndex: k, txRaw, blobs: [] } satisfies FrameTx));
    const raw = rawHeader({ parent: new Uint8Array(32).fill(Number(blk & 0xffn)), root: state.root, txRoot: txT.root, number: blk, time: 1790000000n + blk });
    spine.push({ n: blk, raw, blk: { hash: keccak_256(raw), number: blk, stateRoot: state.root, timestamp: 1790000000n + blk } });
  }
  // the spine is contiguous: filler headers for every block between the frame blocks
  const lo = order.reduce((a, b) => (a < b ? a : b));
  const hi = order.reduce((a, b) => (a > b ? a : b));
  for (let n = lo; n <= hi; n++) {
    if (byBlock.has(n)) continue;
    const root = new Uint8Array(32).fill(Number(n & 0xffn));
    const raw = rawHeader({ parent: root, root, txRoot: EMPTY_ROOT, number: n, time: 1790000000n + n });
    spine.push({ n, raw, blk: { hash: keccak_256(raw), number: n, stateRoot: root, timestamp: 1790000000n + n } });
  }
  spine.sort((a, b) => (a.n > b.n ? -1 : a.n < b.n ? 1 : 0));
  for (const s of spine) {
    body.l1Spine.push(s.raw);
    covered.push(s.blk);
  }
  body.nodes = encodeNodes(nodes);
  const all = [deposit, ...legTxs];
  const l2Raw = rawHeader({ parent, root: new Uint8Array(32), txRoot: trieRoot(all), number: 5000n, time: legTs });
  return { bp, body, covered, l2: readHeader(l2Raw), l2Raw, head: { slot: 111n, epoch: 3n }, txs: all, deposit, epochHash, parent, batcherAddr: addressOf(chainBatcher), batchTs, streamLen: stream.length, groups };
}

export { concat, utf8, u64be, uvarint };
