/**
 * The verifier of arb-sepolia/finalized/v1 (V2_SPEC_S7 section 5.7; the twin of pkg/finality/arbfinal verify.go). It is pure: no I/O, no
 * clock, no randomness. It trusts only its pins, the Sepolia light-client chain inside the evidence (judged by ethl1), and standard
 * cryptography: the Rollup's logic identity is proven under the state roots of covered L1 blocks S and K, the assertion node and its parent's
 * ConfigData under S, the L2 header spine from the assertion's block down to the leg, and the confirmation path under K.
 *
 * What the level proves, verbatim (spec 1.1) is STATEMENT; nothing here claims more. The order of the checks is the order of annex
 * "Offline verification algorithm / finalized" with the r2 additions: pins and pre-BoLD, L1 finality (head, spine, S and K on it), the logic
 * identity under S and under K, the assertion under S, the L2 spine, the confirmation path under K.
 */
import { keccak_256 } from '@noble/hashes/sha3';
import { MptError, ProofNodes, verifyAccountIn, verifySlotIn, type AccountState } from '../../../s6/mpt.js';
import { RlpError } from '../../../s6/rlp.js';
import { decodeContainer, defaultLimits } from '../codec.js';
import { blockAt, blockNotCovered, covers, ethl1PinsFrom, verifyFinalizedHead, type L1Block } from '../ethl1/index.js';
import { sameBytes, type BlockRef } from '../evidence.js';
import { Level } from '../level.js';
import type { Pins } from '../pins.js';
import { sepoliaPins } from '../pins.js';
import type { Kind, Registry, Verdict } from '../registry.js';
import { readHeader, type HeaderFields } from '../rlpheader.js';
import { EvidenceReason, FinalityStateError, blockMismatch, evidenceUnrecognised, malformed, newState } from '../state.js';
import { classifyConfirmation, proofNodesOf, type ProofSource } from './confirm.js';
import { checkNodeBounds } from './nodebounds.js';
import { CHAIN, KIND_NAME, loadArbFinalPins, roleOf, type ArbFinalPins } from './pins.js';
import {
  CodeAssertionUnknown,
  CodeMachineNotFinished,
  CodeNotConfirmed,
  CodePreBold,
  HeaderChainReason,
  L1FinalityReason,
  PreimagePart,
  RoleAdminLogic,
  RoleRollup,
  RoleUserLogic,
  blockHeaderUnreadable,
  contractIdentity,
  headerChainBroken,
  l1FinalityUnproven,
  pinMismatch,
  preimageMismatch,
  stateProofInvalid,
} from './states.js';
import { decodeEvidence, type AfterState, type Bounds, type Evidence, type ParentConfig } from './wire.js';

/** The section 1.1 wording of what the level proves; the report shows it verbatim and nothing may strengthen it. */
export const STATEMENT = 'an assertion with status Confirmed (normal path) read at a finalized L1 block commits an L2 block that has this block as ancestor.';

const ZERO12 = new Uint8Array(12);

/** The decoder bounds under these pins: the section 8.2 generic limits, the Sepolia link and spine bounds and the pinned max_header_chain. */
export function boundsFor(maxLinks: number, maxSpineHeaders: number, a: ArbFinalPins): Bounds {
  return { lim: defaultLimits(), maxLinks, maxSpineHeaders, maxHeaderChain: a.maxHeaderChain };
}

/** w32 of a uint64: 32 bytes with the value in the last eight. */
export function w32(v: bigint): Uint8Array {
  const out = new Uint8Array(32);
  new DataView(out.buffer).setBigUint64(24, BigInt.asUintN(64, v), false);
  return out;
}

const be64 = (v: bigint): Uint8Array => w32(v).subarray(24);

const concat = (parts: readonly Uint8Array[]): Uint8Array => {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};

const bigOf = (b: Uint8Array): bigint => {
  let v = 0n;
  for (const x of b) v = (v << 8n) | BigInt(x);
  return v;
};

/** keccak256(abi.encode(AssertionState)): six 32-byte words (annex A2). */
export function afterStateHash(a: AfterState): Uint8Array {
  return keccak_256(concat([a.blockHash, a.sendRoot, w32(a.inboxPosition), w32(a.positionInMessage), w32(BigInt(a.machineStatus)), a.endHistoryRoot]));
}

/** keccak256(abi.encodePacked(parentAssertionHash, afterStateHash, sequencerBatchAcc)) (annex A2). */
export function assertionHash(parent: Uint8Array, a: AfterState, sequencerBatchAcc: Uint8Array): Uint8Array {
  return keccak_256(concat([parent, afterStateHash(a), sequencerBatchAcc]));
}

/** keccak256(abi.encodePacked(wasmModuleRoot, requiredStake, challengeManager, confirmPeriodBlocks, nextInboxPosition)) (annex A2): 32 + 32 + 20 + 8 + 8 bytes. */
export function configHash(c: ParentConfig): Uint8Array {
  return keccak_256(concat([c.wasmModuleRoot, c.requiredStake, c.challengeManager, be64(c.confirmPeriodBlocks), be64(c.nextInboxPosition)]));
}

/** The storage slot of word 0 of the assertion node: keccak256(abi.encode(assertionHash, assertionsSlot)). */
export function nodeSlot(assertion: Uint8Array, assertionsSlot: bigint): Uint8Array {
  return keccak_256(concat([assertion, w32(assertionsSlot)]));
}

/** The storage slot of the node's configHash word: the node slot plus the layout's offset (mod 2^256, as common.BigToHash keeps the low 32 bytes). */
export function configSlot(assertion: Uint8Array, assertionsSlot: bigint, offset: bigint): Uint8Array {
  const sum = BigInt.asUintN(256, bigOf(nodeSlot(assertion, assertionsSlot)) + offset);
  const out = new Uint8Array(32);
  let x = sum;
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  return out;
}

/** (word >> shift) & 0xff of a node word. */
export function statusOf(word: Uint8Array, shift: bigint): number {
  return Number((bigOf(word) >> shift) & 0xffn);
}

/** The code of the named state carried by err ("" for an error that is not one), as Go innerCode. */
const innerCode = (err: unknown): string => (err instanceof FinalityStateError ? err.code : '');

/** Wraps an MPT/RLP failure of a proof read as the named state it is. */
function proven<T>(which: 'account' | 'slot', f: () => T): T {
  try {
    return f();
  } catch (e) {
    if (e instanceof MptError || e instanceof RlpError) throw stateProofInvalid(which);
    throw e;
  }
}

/**
 * headerNumbered: the fields of the spine header with this number, read by the framework header reader. top is the number of spine[0], the
 * finalized head. covers has walked the spine (the numbers step down by one) and blockAt found the number on it, so the header is
 * spine[top-number]. The light-client reader that walked the spine reads four items of a header and the framework reader seven: a header the
 * first accepts and the second refuses is finality_block_header_unreadable{block_number, finalized_exec_number, reason}, a statement about a
 * block that IS on the spine. A number that is not on the spine, or whose position holds another number, is finality_block_not_covered, the
 * state of a block above the head or below the spine.
 */
function headerNumbered(spine: readonly Uint8Array[], top: bigint, number: bigint): HeaderFields {
  if (number > top || top - number >= BigInt(spine.length)) throw blockNotCovered(number, top);
  let h: HeaderFields;
  try {
    h = readHeader(spine[Number(top - number)]!);
  } catch (e) {
    throw blockHeaderUnreadable(number, top, e);
  }
  if (h.number !== number) throw blockNotCovered(number, top);
  return h;
}

/**
 * identityAt is O2 for one covered L1 block X: the Rollup account is proven under stateRoot_X, both EIP-1967 slots (admin logic, secondary
 * user logic) are read from its storage and both logic accounts are proven under stateRoot_X; each code hash must be pinned with its role,
 * else contract_identity_unproven{role, address, code_hash, judged_at = X}.
 */
export function identityAt(arb: ArbFinalPins, x: Pick<L1Block, 'number' | 'stateRoot'>, nodes: ProofSource): AccountState {
  const root = x.stateRoot;
  const set = proofNodesOf(nodes);
  const acct = proven('account', () => verifyAccountIn(set, root, arb.rollup));
  if (!acct.exists) throw contractIdentity(RoleRollup, arb.rollup, new Uint8Array(32), x.number);
  for (const r of [
    { slot: arb.adminSlot, role: RoleAdminLogic },
    { slot: arb.userSlot, role: RoleUserLogic },
  ]) {
    const word = proven('slot', () => verifySlotIn(set, acct.storageRoot, r.slot));
    const impl = word.slice(12);
    const logic = proven('account', () => verifyAccountIn(set, root, impl));
    const codeHash = logic.exists ? logic.codeHash : new Uint8Array(32);
    if (!sameBytes(word.subarray(0, 12), ZERO12) || !logic.exists || roleOf(arb, codeHash) !== r.role) {
      throw contractIdentity(r.role, impl, codeHash, x.number);
    }
  }
  return acct;
}

/**
 * The §0 spine rule for the L2 chain: keccak256(h_0) = afterState.blockHash, each further header is the parent of the one before it (hash
 * and number), and h_k is byte-identical to Settlement.Header. It returns m = number(h_0).
 */
export function verifyL2Spine(e: Pick<Evidence, 'l2Spine' | 'after'>, leg: BlockRef): bigint {
  if (e.l2Spine.length === 0) throw malformed('l2Spine', EvidenceReason.SpineEmpty, 0, 1);
  let prev: HeaderFields | undefined;
  let m = 0n;
  for (let i = 0; i < e.l2Spine.length; i++) {
    const h = readHeader(e.l2Spine[i]!);
    if (prev === undefined) {
      if (!sameBytes(h.hash, e.after.blockHash)) throw headerChainBroken(h.number, e.after.blockHash, h.hash, HeaderChainReason.ParentHash);
      m = h.number;
    } else {
      const below = BigInt.asUintN(64, prev.number - 1n);
      if (!sameBytes(h.hash, prev.parentHash)) throw headerChainBroken(below, prev.parentHash, h.hash, HeaderChainReason.ParentHash);
      if (BigInt.asUintN(64, h.number + 1n) !== prev.number) throw headerChainBroken(below, prev.parentHash, h.hash, HeaderChainReason.NumberGap);
    }
    prev = h;
  }
  const last = e.l2Spine[e.l2Spine.length - 1]!;
  if (prev!.number !== leg.number) throw blockMismatch('spineLastNumber', leg.number, prev!.number);
  if (!sameBytes(prev!.hash, leg.hash)) throw blockMismatch('spineLastHash', leg.hash, prev!.hash);
  if (leg.headerRlp !== undefined && !sameBytes(last, leg.headerRlp)) throw blockMismatch('spineLastHeader', keccak_256(leg.headerRlp), keccak_256(last));
  return m;
}

/** The verifier of arb-sepolia/finalized/v1. */
export class ArbFinalKind implements Kind {
  name(): string {
    return KIND_NAME;
  }
  chain(): bigint {
    return CHAIN;
  }
  level(): Level {
    return Level.Finalized;
  }

  /** Judges the whole CFE1 container of one leg block (spec 5.7). The L2 header is b.headerRlp (the leg's Settlement.Header). */
  verify(p: Pins | null, b: BlockRef, evidence: Uint8Array): Verdict {
    const c = decodeContainer(evidence, defaultLimits());
    if (c.header.kind !== KIND_NAME) throw evidenceUnrecognised(c.header.kind, '');
    if (c.header.chain !== CHAIN) throw pinMismatch('chain_id');
    if (c.header.level !== Level.Finalized) throw malformed('header.level', EvidenceReason.LevelNotFinalized, c.header.level, 3);
    // [r2:E1FIX L2] the leg names the chain the container is about, as Registry.JudgeAddendum judges it before dispatch.
    if (c.header.chain !== b.chain) throw blockMismatch('chain', b.chain, c.header.chain);
    if (c.header.blockNumber !== b.number) throw blockMismatch('blockNumber', b.number, c.header.blockNumber);
    if (!sameBytes(c.header.blockHash, b.hash)) throw blockMismatch('blockHash', b.hash, c.header.blockHash);
    const arb = loadArbFinalPins(p);
    const ep = ethl1PinsFrom(sepoliaPins(p));
    const e = decodeEvidence(c.body, boundsFor(ep.maxLinks, ep.maxSpineHeaders, arb));
    const hdr = readHeader(b.headerRlp ?? new Uint8Array(0));
    if (!sameBytes(hdr.hash, b.hash)) throw blockMismatch('settlementHeaderHash', b.hash, hdr.hash);
    if (hdr.number !== b.number) throw blockMismatch('settlementHeaderNumber', b.number, hdr.number);
    if (hdr.number <= arb.boldGenesisL2Block) throw newState(CodePreBold, { n: hdr.number, bold_genesis_l2_block: arb.boldGenesisL2Block });
    // 5.2 / 5.7 O1: the L1 finalized head, S and K on the covered spine.
    let head;
    try {
      head = verifyFinalizedHead(ep, e.lc);
    } catch (err) {
      if (err instanceof FinalityStateError) throw l1FinalityUnproven(L1FinalityReason.LCRefused, innerCode(err));
      throw err;
    }
    let covered: L1Block[];
    try {
      covered = covers(head, e.l1Spine, ep.maxSpineHeaders);
    } catch (err) {
      if (err instanceof FinalityStateError) throw l1FinalityUnproven(L1FinalityReason.SpineRefused, innerCode(err));
      throw err;
    }
    const s = blockAt(covered, e.stateBlock);
    const kb = blockAt(covered, e.confBlock);
    if (kb.number > s.number) throw blockMismatch('confBlockAboveStateBlock', e.stateBlock, e.confBlock);
    const kHeader = headerNumbered(e.l1Spine, covered[0]!.number, kb.number);
    // [r2:E1FIX L3] spec 8.2: a NODES element off the transaction and receipt proof paths is a state or storage node, at most max_node_bytes;
    // judged here, where K's roots are known, before any proof consumes a node.
    // One proof database for the whole verification: every NODES element is hashed once, however many proofs are read (audit N-5).
    const set = new ProofNodes(e.nodes);
    checkNodeBounds(kHeader, e, defaultLimits().maxNodeBytes, set);
    return this.verifyState(arb, s, kb, kHeader, b, e, set);
  }

  /**
   * The part of the judgement that runs under the state roots of the covered L1 blocks S and K; it is separate so that tests can hand it
   * a state built in memory. set is the ProofNodes of e.nodes shared with the node-bound check (a new one when omitted).
   */
  verifyState(arb: ArbFinalPins, s: L1Block, kb: L1Block, kHeader: HeaderFields, b: BlockRef, e: Evidence, set: ProofNodes = new ProofNodes(e.nodes)): Verdict {
    // 5.7 O2: logic identity under stateRoot_S and also under stateRoot_K (r2 C1).
    const acctS = identityAt(arb, s, set);
    const acctK = kb.number === s.number ? acctS : identityAt(arb, kb, set);
    // 5.7 O3: the assertion under S.
    if (e.after.machineStatus !== 1) throw newState(CodeMachineNotFinished, { machine_status: e.after.machineStatus });
    const assertion = assertionHash(e.parentAssertionHash, e.after, e.sequencerBatchAcc);
    const word = proven('slot', () => verifySlotIn(set, acctS.storageRoot, nodeSlot(assertion, arb.layout.assertionsSlot)));
    const status = statusOf(word, arb.layout.statusShiftBits);
    if (status === 0) throw newState(CodeAssertionUnknown, {});
    if (status !== 2) throw newState(CodeNotConfirmed, { status });
    const cfgWord = proven('slot', () =>
      verifySlotIn(set, acctS.storageRoot, configSlot(e.parentAssertionHash, arb.layout.assertionsSlot, arb.layout.configSlotOffset)),
    );
    if (!sameBytes(configHash(e.parent), cfgWord)) throw preimageMismatch(PreimagePart.ParentConfig);
    // 5.7 O3 / O3b: the L2 spine from the assertion's block down to the leg, ending byte-identical at Settlement.Header.
    const m = verifyL2Spine(e, b);
    // 5.7 O4: the confirmation path under K.
    const conf = classifyConfirmation(arb, kb, kHeader, acctK, assertion, e, set);
    const fields: Verdict['fields'] = {
      assertion,
      m,
      s_number: s.number,
      s_hash: s.hash,
      k_number: kb.number,
      k_hash: kb.hash,
      confirm_period_blocks: e.parent.confirmPeriodBlocks,
      confirmation_path: 'honest',
      confirmation_route: conf.route,
      confirmation_tx: conf.txHash,
    };
    return { level: Level.Finalized, kind: KIND_NAME, fields };
  }
}

/** Adds the kind to a registry; there is no import-time registration. */
export function registerArbFinal(reg: Registry): void {
  reg.registerKind(new ArbFinalKind());
}
