/**
 * The body of a base-sepolia/l1_posted/v1 container after the CFE1 header (V2_SPEC_S7 section 3.3; the twin of the validator's
 * pkg/finality/baseposted/wire.go): LC || LIST<LP> l1Spine || B16 channelId || LIST<FrameTx> || LIST<LP> depositTxs || NODES.
 * Strict and bounded: every count is checked against its limit and against what remains before anything is allocated.
 */
import { Reader, Writer, encodeNodes, type Limits } from '../codec.js';
import { decodeLCUnder, encodeLC, type LC, type Pins as EthL1Pins } from '../ethl1/index.js';
import { EvidenceReason, evidenceTooLarge, malformedAt } from '../state.js';

/** A raw EIP-4844 blob. */
export const BLOB_SIZE = 131072;

/** Blob = LP raw(131072) || B48 commitment || B48 proof. */
export interface Blob {
  raw: Uint8Array;
  commitment: Uint8Array;
  proof: Uint8Array;
}

/** FrameTx = u64 l1Block || u32 txIndex || LP txRaw || LIST<Blob>. */
export interface FrameTx {
  l1Block: bigint;
  txIndex: number;
  txRaw: Uint8Array;
  blobs: Blob[];
}

export interface Body {
  lc: LC;
  l1Spine: Uint8Array[];
  /** 16 bytes */
  channelId: Uint8Array;
  frames: FrameTx[];
  deposits: Uint8Array[];
  /** strictly ascending by keccak256, unique */
  nodes: Uint8Array[];
}

/** The canonical encoding. Nodes are sorted and deduplicated. */
export function encodeBody(b: Body): Uint8Array {
  const w = new Writer();
  w.fixed(encodeLC(b.lc));
  w.lpList(b.l1Spine);
  w.fixed(b.channelId);
  w.count(b.frames.length);
  for (const f of b.frames) {
    w.u64(f.l1Block);
    w.u32(f.txIndex);
    w.lp(f.txRaw);
    w.count(f.blobs.length);
    for (const bl of f.blobs) {
      w.lp(bl.raw);
      w.fixed(bl.commitment);
      w.fixed(bl.proof);
    }
  }
  w.lpList(b.deposits);
  w.nodes(encodeNodes(b.nodes));
  return w.bytes();
}

/** bounds one SSZ blob of the LC part while it is being delimited; the exact sizes are checked by ethl1 */
const MAX_LC_PART = 1 << 20;

/** Walks the LC part (spec 3.2) and returns its byte length, without interpreting any SSZ. */
function lcExtent(body: Uint8Array, lim: Limits, maxLinks: number): number {
  const r = new Reader(body, lim);
  r.str('lc.profile');
  r.u8('lc.anchorKind');
  r.u64('lc.anchorPeriod');
  r.fixed('lc.anchorRoot', 32);
  const lb = (part: string): void => {
    r.u8(`${part}.layout`);
    r.lp(part, MAX_LC_PART);
  };
  lb('lc.anchorBody');
  const n = r.count('lc.links', maxLinks, 5);
  for (let i = 0; i < n; i++) lb('lc.links');
  lb('lc.finalUpdate');
  return body.length - r.left();
}

/**
 * The strict inverse of encodeBody under the bounds of lim and the pins (maxBlobs, max spine headers, max links). Every refusal is a
 * framework named state; nothing is truncated.
 */
export function decodeBody(body: Uint8Array, lim: Limits, ep: EthL1Pins, maxBlobs: number): Body {
  const n = lcExtent(body, lim, ep.maxLinks);
  const lc = decodeLCUnder(ep, body.subarray(0, n));
  const r = new Reader(body.subarray(n), lim);
  let spineMax = ep.maxSpineHeaders;
  if (spineMax <= 0 || spineMax > lim.maxSpineHeaders) spineMax = lim.maxSpineHeaders;
  const l1Spine = r.lpList('l1Spine', spineMax, lim.maxNodeBytes);
  const channelId = r.fixed('channelId', 16);
  const fc = r.count('frameTxs', lim.maxFrameTxs, 8 + 4 + 4 + 4);
  const frames: FrameTx[] = [];
  let totalBlobs = 0;
  for (let i = 0; i < fc; i++) {
    const l1Block = r.u64('frameTx.l1Block');
    const txIndex = r.u32('frameTx.txIndex');
    const txRaw = r.lp('frameTx.txRaw', lim.maxTxLeafBytes);
    const bc = r.count('frameTx.blobs', maxBlobs, 4 + 48 + 48);
    totalBlobs += bc;
    if (totalBlobs > maxBlobs) throw evidenceTooLarge('blobs', totalBlobs, maxBlobs);
    const blobs: Blob[] = [];
    for (let j = 0; j < bc; j++) {
      const raw = r.lp('blob.raw', BLOB_SIZE);
      if (raw.length !== BLOB_SIZE) throw malformedAt('blob.raw', j, EvidenceReason.Truncated, raw.length, BLOB_SIZE);
      blobs.push({ raw, commitment: r.fixed('blob.commitment', 48), proof: r.fixed('blob.proof', 48) });
    }
    frames.push({ l1Block, txIndex, txRaw, blobs });
  }
  const deposits = r.lpList('depositTxs', lim.maxDepositTxs, lim.maxTxLeafBytes);
  const nodes = r.nodes('nodes', lim.maxTxLeafBytes);
  r.end('body');
  return { lc, l1Spine, channelId, frames, deposits, nodes };
}
