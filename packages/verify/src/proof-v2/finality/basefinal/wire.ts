/**
 * The body of a base-sepolia/finalized/v1 container after the CFE1 header (V2_SPEC_S7 section 3.3; the twin of the validator's
 * pkg/finality/basefinal/wire.go):
 *
 *   LC || LIST<LP> l1Spine || u64 stateBlock || B20 gameProxy || LP gameCode || u32 outputRootIndex || LIST<LP> l2Spine || NODES
 *
 * outputRootIndex 0 = rootClaim, i+1 = intermediate root i; l2Spine: h_0 = the output-root block ... h_k = the leg block. Strict and
 * bounded: every count is checked against its limit and against what remains before anything is allocated.
 */
import { Reader, Writer, encodeNodes, type Limits } from '../codec.js';
import { decodeLCUnder, encodeLC, type LC, type Pins as EthL1Pins } from '../ethl1/index.js';

export interface Body {
  lc: LC;
  l1Spine: Uint8Array[];
  stateBlock: bigint;
  /** 20 bytes */
  gameProxy: Uint8Array;
  gameCode: Uint8Array;
  outputRootIndex: number;
  l2Spine: Uint8Array[];
  /** strictly ascending by keccak256, unique */
  nodes: Uint8Array[];
}

/** The canonical encoding. Nodes are sorted and deduplicated. */
export function encodeBody(b: Body): Uint8Array {
  const w = new Writer();
  w.fixed(encodeLC(b.lc));
  w.lpList(b.l1Spine);
  w.u64(b.stateBlock);
  w.fixed(b.gameProxy);
  w.lp(b.gameCode);
  w.u32(b.outputRootIndex);
  w.lpList(b.l2Spine);
  w.nodes(encodeNodes(b.nodes));
  return w.bytes();
}

/** bounds one SSZ blob of the LC part while it is being delimited; the exact sizes are checked by ethl1 */
const MAX_LC_PART = 1 << 20;

/** Walks the LC part (spec 3.2) and returns its byte length, without interpreting any SSZ. */
export function lcExtent(body: Uint8Array, lim: Limits, maxLinks: number): number {
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
 * The strict inverse of encodeBody under the bounds of lim, the L1 pins (max links, max spine headers) and maxL2 (the pins' max_l2_headers,
 * already clamped to a safe integer). Every refusal is a framework named state; nothing is truncated.
 */
export function decodeBody(body: Uint8Array, lim: Limits, ep: EthL1Pins, maxL2: number): Body {
  const n = lcExtent(body, lim, ep.maxLinks);
  const lc = decodeLCUnder(ep, body.subarray(0, n));
  const r = new Reader(body.subarray(n), lim);
  let spineMax = ep.maxSpineHeaders;
  if (spineMax <= 0 || spineMax > lim.maxSpineHeaders) spineMax = lim.maxSpineHeaders;
  const l1Spine = r.lpList('l1Spine', spineMax, lim.maxNodeBytes);
  const stateBlock = r.u64('stateBlock');
  const gameProxy = r.fixed('gameProxy', 20);
  const gameCode = r.lp('gameCode', lim.maxCodeBytes);
  const outputRootIndex = r.u32('outputRootIndex');
  let l2Max = maxL2;
  if (l2Max <= 0 || l2Max > lim.maxL2Headers) l2Max = lim.maxL2Headers;
  const l2Spine = r.lpList('l2Spine', l2Max, lim.maxNodeBytes);
  const nodes = r.nodes('nodes', lim.maxNodeBytes);
  r.end('body');
  return { lc, l1Spine, stateBlock, gameProxy, gameCode, outputRootIndex, l2Spine, nodes };
}
