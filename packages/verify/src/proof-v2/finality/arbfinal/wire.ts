/**
 * The body of an arb-sepolia/finalized/v1 container after the CFE1 header (V2_SPEC_S7 section 3.3; the twin of pkg/finality/arbfinal codec.go):
 *
 *   LC || LIST<LP> l1Spine || u64 stateBlock || u64 confBlock || B32 parentAssertionHash || AfterState || B32 sequencerBatchAcc ||
 *   ParentConfig || LIST<LP> l2Spine || u32 confTxIndex || LP confTxRaw || LP confReceiptRaw || NODES
 *
 * Strict and bounded: no trailing byte, every count within its bound AND within what remains before anything is allocated, NODES
 * ascending and unique (each at most max_tx_leaf_bytes here: the transaction and receipt proof paths are only known once K is on the
 * covered spine, so checkNodeBounds applies the max_node_bytes bound afterwards). Nothing is truncated; a bound exceeded reports the
 * number and refuses.
 */
import { Reader, Writer, encodeNodes, type Limits } from '../codec.js';
import { encodeLC, type LB, type LC } from '../ethl1/index.js';
import { EvidenceReason, malformed } from '../state.js';
import { headerChainExceeds } from './states.js';

/** bounds one header of a spine (an L1 or L2 header is 0.5-0.7 KB); the bound only keeps a hostile length from allocating */
export const MAX_HEADER_BYTES = 8192;

/** AfterState (spec 3.3): B32 blockHash || B32 sendRoot || u64 inboxPosition || u64 positionInMessage || u8 machineStatus || B32 endHistoryRoot. */
export interface AfterState {
  blockHash: Uint8Array;
  sendRoot: Uint8Array;
  inboxPosition: bigint;
  positionInMessage: bigint;
  machineStatus: number;
  endHistoryRoot: Uint8Array;
}

/** The ConfigData of the assertion's parent (spec 3.3): B32 wasmModuleRoot || B32 requiredStake || B20 challengeManager || u64 confirmPeriodBlocks || u64 nextInboxPosition. */
export interface ParentConfig {
  wasmModuleRoot: Uint8Array;
  requiredStake: Uint8Array;
  challengeManager: Uint8Array;
  confirmPeriodBlocks: bigint;
  nextInboxPosition: bigint;
}

export interface Evidence {
  lc: LC;
  l1Spine: Uint8Array[];
  stateBlock: bigint;
  confBlock: bigint;
  parentAssertionHash: Uint8Array;
  after: AfterState;
  sequencerBatchAcc: Uint8Array;
  parent: ParentConfig;
  l2Spine: Uint8Array[];
  confTxIndex: number;
  confTxRaw: Uint8Array;
  confReceiptRaw: Uint8Array;
  /** strictly ascending by keccak256, unique */
  nodes: Uint8Array[];
}

/** The counts the decoder enforces: the generic limits and the pins' per-chain ones (Go Bounds). */
export interface Bounds {
  lim: Limits;
  maxLinks: number;
  maxSpineHeaders: number;
  /** the pinned max_header_chain (a Go int: kept exact) */
  maxHeaderChain: bigint;
}

/** The canonical encoding. Nodes are sorted and deduplicated. It does not validate (the vector builders build invalid evidence on purpose). */
export function encodeEvidence(e: Evidence): Uint8Array {
  const w = new Writer();
  w.fixed(encodeLC(e.lc));
  w.lpList(e.l1Spine);
  w.u64(e.stateBlock);
  w.u64(e.confBlock);
  w.b32(e.parentAssertionHash);
  w.b32(e.after.blockHash);
  w.b32(e.after.sendRoot);
  w.u64(e.after.inboxPosition);
  w.u64(e.after.positionInMessage);
  w.u8(e.after.machineStatus);
  w.b32(e.after.endHistoryRoot);
  w.b32(e.sequencerBatchAcc);
  w.b32(e.parent.wasmModuleRoot);
  w.b32(e.parent.requiredStake);
  w.fixed(e.parent.challengeManager);
  w.u64(e.parent.confirmPeriodBlocks);
  w.u64(e.parent.nextInboxPosition);
  w.lpList(e.l2Spine);
  w.u32(e.confTxIndex);
  w.lp(e.confTxRaw);
  w.lp(e.confReceiptRaw);
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

/** LIST<LP> l2Spine. A count above max_header_chain is header_chain_exceeds_bound{needed, max}, judged before anything is allocated. */
function readL2Spine(r: Reader, max: bigint): Uint8Array[] {
  const n = r.u32('l2Spine.count');
  if (BigInt(n) > max) throw headerChainExceeds(BigInt(n), max);
  if (n * 4 > r.left()) throw malformed('l2Spine', EvidenceReason.CountExceedsRemaining, r.left(), n * 4);
  const out: Uint8Array[] = [];
  for (let i = 0; i < n; i++) out.push(r.lp('l2Spine', MAX_HEADER_BYTES));
  return out;
}

/** Parses a container body strictly (see the module comment). */
export function decodeEvidence(body: Uint8Array, b: Bounds): Evidence {
  const r = new Reader(body, b.lim);
  const lc = readLC(r, b.maxLinks);
  const l1Spine = r.lpList('l1Spine', b.maxSpineHeaders, MAX_HEADER_BYTES);
  const stateBlock = r.u64('stateBlock');
  const confBlock = r.u64('confBlock');
  const parentAssertionHash = r.b32('parentAssertionHash');
  const after: AfterState = {
    blockHash: r.b32('afterState.blockHash'),
    sendRoot: r.b32('afterState.sendRoot'),
    inboxPosition: r.u64('afterState.inboxPosition'),
    positionInMessage: r.u64('afterState.positionInMessage'),
    machineStatus: r.u8('afterState.machineStatus'),
    endHistoryRoot: r.b32('afterState.endHistoryRoot'),
  };
  const sequencerBatchAcc = r.b32('sequencerBatchAcc');
  const parent: ParentConfig = {
    wasmModuleRoot: r.b32('parentConfig.wasmModuleRoot'),
    requiredStake: r.b32('parentConfig.requiredStake'),
    challengeManager: r.fixed('parentConfig.challengeManager', 20),
    confirmPeriodBlocks: r.u64('parentConfig.confirmPeriodBlocks'),
    nextInboxPosition: r.u64('parentConfig.nextInboxPosition'),
  };
  const l2Spine = readL2Spine(r, b.maxHeaderChain);
  const confTxIndex = r.u32('confTxIndex');
  const confTxRaw = r.lp('confTxRaw', b.lim.maxTxLeafBytes);
  const confReceiptRaw = r.lp('confReceiptRaw', b.lim.maxTxLeafBytes);
  const nodes = r.nodes('nodes', b.lim.maxTxLeafBytes);
  r.end('body');
  return { lc, l1Spine, stateBlock, confBlock, parentAssertionHash, after, sequencerBatchAcc, parent, l2Spine, confTxIndex, confTxRaw, confReceiptRaw, nodes };
}
