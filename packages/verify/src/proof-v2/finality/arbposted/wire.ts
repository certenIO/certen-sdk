/**
 * The body of an arb-sepolia/l1_posted/v1 container after the CFE1 header (V2_SPEC_S7 section 3.3; the twin of pkg/finality/arbposted
 * codec.go):
 *
 *   LC || LIST<LP> l1Spine || u64 stateBlock || LIST<LP> blockTxs || u64 batchSeq || 5 x u64 header40 || B32 beforeAcc || B32 delayedAcc
 *   || u8 dataKind || Data || u8 delayedFlag || [Delayed] || NODES
 *
 * Strict and bounded: no trailing byte, every count within its bound AND within what remains before anything is allocated, NODES
 * ascending and unique. Nothing is truncated; a bound exceeded reports the number and refuses.
 */
import { Reader, Writer, encodeNodes, type Limits } from '../codec.js';
import { encodeLC, type LB, type LC } from '../ethl1/index.js';
import { EvidenceReason, malformed, malformedAt } from '../state.js';
import { REASON_BAD_ENUM_VALUE } from './states.js';

/** Data kinds of the container (spec 3.3: Data = (1 blobs) | (2 calldata) | (3 none)). */
export const DataBlobs = 1;
export const DataCalldata = 2;
export const DataNone = 3;

/** The size of one raw blob. */
export const BLOB_BYTES = 131072;

/** bounds one L1 spine header (a header is about 600-700 bytes; the bound only keeps a hostile length from allocating) */
export const MAX_HEADER_BYTES = 8192;

/** Blob = LP raw(131072) || B48 commitment || B48 proof. */
export interface Blob {
  raw: Uint8Array;
  commitment: Uint8Array;
  proof: Uint8Array;
}

/** The delayed-message section (annex A6.5): the message and the index k of its Bridge delayed accumulator. */
export interface Delayed {
  msgKind: number;
  /** 20 bytes */
  sender: Uint8Array;
  msgBlockNumber: bigint;
  msgTimestamp: bigint;
  /** 32 bytes */
  baseFeeL1: Uint8Array;
  data: Uint8Array;
  k: bigint;
}

export interface Evidence {
  lc: LC;
  l1Spine: Uint8Array[];
  stateBlock: bigint;
  blockTxs: Uint8Array[];
  batchSeq: bigint;
  /** minTimestamp, maxTimestamp, minBlockNumber, maxBlockNumber, afterDelayedMessagesRead, in that order */
  header40: [bigint, bigint, bigint, bigint, bigint];
  beforeAcc: Uint8Array;
  delayedAcc: Uint8Array;
  dataKind: number;
  /** DataBlobs */
  versionedHashes: Uint8Array[];
  /** DataBlobs, one per versioned hash */
  blobs: Blob[];
  /** DataCalldata */
  calldata: Uint8Array;
  delayed: Delayed | null;
  /** strictly ascending by keccak256, unique */
  nodes: Uint8Array[];
}

/** The counts the decoder enforces: the generic limits of defaultLimits and the pins' per-chain ones. */
export interface Bounds {
  lim: Limits;
  maxLinks: number;
  maxSpineHeaders: number;
  maxBlobs: number;
}

/** The decoder bounds of the shipped pins. */
export function defaultBounds(lim: Limits): Bounds {
  return { lim, maxLinks: 64, maxSpineHeaders: 16384, maxBlobs: 16 };
}

/** The canonical encoding. Nodes are sorted and deduplicated. It does not validate (the vector builders build invalid evidence on purpose). */
export function encodeEvidence(e: Evidence): Uint8Array {
  const w = new Writer();
  w.fixed(encodeLC(e.lc));
  w.lpList(e.l1Spine);
  w.u64(e.stateBlock);
  w.lpList(e.blockTxs);
  w.u64(e.batchSeq);
  for (const v of e.header40) w.u64(v);
  w.b32(e.beforeAcc);
  w.b32(e.delayedAcc);
  w.u8(e.dataKind);
  if (e.dataKind === DataBlobs) {
    w.count(e.versionedHashes.length);
    for (const h of e.versionedHashes) w.b32(h);
    w.count(e.blobs.length);
    for (const b of e.blobs) {
      w.lp(b.raw);
      w.fixed(b.commitment);
      w.fixed(b.proof);
    }
  } else if (e.dataKind === DataCalldata) {
    w.lp(e.calldata);
  }
  if (e.delayed === null) {
    w.u8(0);
  } else {
    const d = e.delayed;
    w.u8(1);
    w.u8(d.msgKind);
    w.fixed(d.sender);
    w.u64(d.msgBlockNumber);
    w.u64(d.msgTimestamp);
    w.b32(d.baseFeeL1);
    w.lp(d.data);
    w.u64(d.k);
  }
  w.nodes(encodeNodes(e.nodes));
  return w.bytes();
}

/**
 * Reads the LC part from the container stream (spec 3.2) into an ethl1 LC. Layout bytes and ssz lengths are judged by ethl1 itself; here
 * only the framing is strict (the part names are Go's readLC).
 */
function readLC(r: Reader, maxLinks: number): LC {
  const profile = r.str('lc.profile');
  const anchorKind = r.u8('lc.anchorKind');
  const anchorPeriod = r.u64('lc.anchorPeriod');
  const anchorRoot = r.b32('lc.anchorRoot');
  const lb = (part: string): LB => {
    const layout = r.u8(`${part}.layout`);
    const ssz = r.lp(part, -1);
    return { layout, ssz };
  };
  const anchorBody = lb('lc.anchorBody');
  const n = r.count('lc.links', maxLinks, 5);
  const links: LB[] = [];
  for (let i = 0; i < n; i++) links.push(lb('lc.link'));
  const finalUpdate = lb('lc.finalUpdate');
  return { profile, anchorKind, anchorPeriod, anchorRoot, anchorBody, links, finalUpdate };
}

/** Parses a container body strictly (see the module comment). */
export function decodeEvidence(body: Uint8Array, b: Bounds): Evidence {
  const r = new Reader(body, b.lim);
  const lc = readLC(r, b.maxLinks);
  const l1Spine = r.lpList('l1Spine', b.maxSpineHeaders, MAX_HEADER_BYTES);
  const stateBlock = r.u64('stateBlock');
  const blockTxs = r.lpList('blockTxs', b.lim.maxBlockTxs, b.lim.maxTxLeafBytes);
  const batchSeq = r.u64('batchSeq');
  const header40: bigint[] = [];
  for (let i = 0; i < 5; i++) header40.push(r.u64('header40'));
  const beforeAcc = r.b32('beforeAcc');
  const delayedAcc = r.b32('delayedAcc');
  const dataKind = r.u8('dataKind');
  const versionedHashes: Uint8Array[] = [];
  const blobs: Blob[] = [];
  let calldata: Uint8Array = new Uint8Array(0);
  switch (dataKind) {
    case DataBlobs: {
      const n = r.count('versionedHashes', b.maxBlobs, 32);
      for (let i = 0; i < n; i++) versionedHashes.push(r.b32('versionedHashes'));
      const m = r.count('blobs', b.maxBlobs, 4 + BLOB_BYTES + 96);
      for (let i = 0; i < m; i++) {
        const raw = r.lp('blobs.raw', BLOB_BYTES);
        if (raw.length !== BLOB_BYTES) throw malformedAt('blobs.raw', i, EvidenceReason.Truncated, raw.length, BLOB_BYTES);
        const commitment = r.fixed('blobs.commitment', 48);
        const proof = r.fixed('blobs.proof', 48);
        blobs.push({ raw, commitment, proof });
      }
      break;
    }
    case DataCalldata:
      calldata = r.lp('calldata', b.lim.maxTxLeafBytes);
      break;
    case DataNone:
      break;
    default:
      throw malformed('dataKind', REASON_BAD_ENUM_VALUE, dataKind, 3);
  }
  const flag = r.u8('delayedFlag');
  let delayed: Delayed | null = null;
  if (flag === 1) {
    const msgKind = r.u8('delayed.msgKind');
    const sender = r.fixed('delayed.sender', 20);
    const msgBlockNumber = r.u64('delayed.msgBlockNumber');
    const msgTimestamp = r.u64('delayed.msgTimestamp');
    const baseFeeL1 = r.b32('delayed.baseFeeL1');
    const data = r.lp('delayed.data', b.lim.maxTxLeafBytes);
    const k = r.u64('delayed.k');
    delayed = { msgKind, sender, msgBlockNumber, msgTimestamp, baseFeeL1, data, k };
  } else if (flag !== 0) {
    throw malformed('delayedFlag', REASON_BAD_ENUM_VALUE, flag, 1);
  }
  const nodes = r.nodes('nodes', b.lim.maxNodeBytes);
  r.end('body');
  return {
    lc,
    l1Spine,
    stateBlock,
    blockTxs,
    batchSeq,
    header40: header40 as [bigint, bigint, bigint, bigint, bigint],
    beforeAcc,
    delayedAcc,
    dataKind,
    versionedHashes,
    blobs,
    calldata,
    delayed,
    nodes,
  };
}
