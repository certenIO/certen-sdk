/**
 * The verifier of base-sepolia/finalized/v1 (V2_SPEC_S7 section 5.5; the twin of the validator's pkg/finality/basefinal verify.go): an
 * AggregateVerifier game (type 621) replayed through AnchorStateRegistry.isGameClaimValid from L1 storage proofs at a finalized L1 block A,
 * an output root recomputed from an L2 header, and an L2 header spine down to the leg's block. It is pure: no I/O, no clock, no randomness.
 * It trusts only its pins, the Sepolia light-client chain inside the evidence (judged by ethl1), and standard cryptography; A's state root
 * and timestamp are read from the covered header, never from the evidence.
 *
 * Every 64-bit quantity is a bigint, compared and summed exactly (no Number wrap); the places where Go wraps by construction (uint64
 * subtraction of a spine number, int64 row arithmetic, uint16 truncation of the template length) are reproduced with BigInt.asUintN/asIntN.
 */
import { keccak_256 } from '@noble/hashes/sha3';
import { RlpError, bytesOf, fixedOf, split, structItems, uintOf } from '../../../s6/rlp.js';
import { MptError, ProofDb, verifyProofIn } from '../../../s6/mpt.js';
import { decodeContainer, defaultLimits } from '../codec.js';
import { sameBytes, type BlockRef } from '../evidence.js';
import { blockAt, covers, ethl1PinsFrom, headerChainBroken, verifyFinalizedHead, type FinalizedHead, type L1Block } from '../ethl1/index.js';
import { Level } from '../level.js';
import type { Pins } from '../pins.js';
import { sepoliaPins } from '../pins.js';
import type { Kind, Registry, Verdict } from '../registry.js';
import { readHeader } from '../rlpheader.js';
import {
  EvidenceReason,
  FinalityStateError,
  blockMismatch,
  evidenceTooLarge,
  evidenceUnrecognised,
  hexLower,
  malformed,
  newState,
  pinsCorrupt,
  PinsReason,
  type Fields,
} from '../state.js';
import { CHAIN, KIND_NAME, parseBasePins, rowComplete, type BaseFinalPins, type ImplRow } from './pins.js';
import {
  CodeGameBlacklisted,
  CodeGameChallengerWins,
  CodeGameNotRegistered,
  CodeGameNotRespected,
  CodeGameNotResolved,
  CodeGameRetired,
  CodeGameTypeUnsupported,
  CodeGameWithinDelay,
  CodeL1SystemPaused,
  CodeL2NotCanonical,
  CodeOutputRootMismatch,
  GameReason,
  LC_REFUSED,
  LayoutAggregateV1,
  RoleASRImpl,
  RoleDGFImpl,
  RoleGameImpl,
  RoleOPProxy,
  RolePortalImpl,
  RoleSuperchainImpl,
  RoleSuperchainPrx,
  RoleSysCfgImpl,
  StatusChallengerWins,
  StatusDefenderWins,
  contractIdentity,
  gameUnrecognised,
  l1FinalityUnproven,
  stateProofInvalid,
} from './states.js';
import { decodeBody, type Body } from './wire.js';

/** keccak256("eip1967.proxy.implementation") - 1 */
const EIP1967_IMPL_SLOT = Uint8Array.from('360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc'.match(/../g)!, (h) => parseInt(h, 16));
/** SystemConfig's OPTIMISM_PORTAL_SLOT = keccak256("systemconfig.optimismportal") - 1 ([BASE Q9]). */
const OPTIMISM_PORTAL_SLOT = Uint8Array.from('4b6c74f9e688cb39801f2112c14a8c57232a3fc5202e1444126d4bce86eb19ac'.match(/../g)!, (h) => parseInt(h, 16));

/** The storage slots read (V2_SPEC_S7 5.5, [BASE Q9], [B30 Q4(g)]). */
const slotPortalSystemConfig = 55n;
const slotPortalASR = 62n;
const slotSysCfgSuperchain = 108n;
const slotASRSystemConfig = 0n; // systemConfig at byte offset 2 of the word (bytes [10,30))
const slotASRDGF = 1n;
const slotASRRespectedRetire = 6n; // respectedGameType u32 @0, retirementTimestamp u64 @4
const mapASRBlacklist = 5n;
const mapDGFGames = 103n;
const slotGameMain = 0n;
const slotGameStartL2Seq = 2n;
const slotGameCountered = 5n;
const mapGameProver = 6n;
const slotGameExpectedRes = 7n;

const ZERO32 = new Uint8Array(32);
const isZero = (b: Uint8Array): boolean => b.every((x) => x === 0);
const eq = sameBytes;
const hex0x = (b: Uint8Array): string => `0x${hexLower(b)}`;

/** The proof database keeps no empty node: an empty node can never be a trie node and is never looked up. */
const nonEmpty = (nodes: readonly Uint8Array[]): Uint8Array[] => nodes.filter((n) => n.length > 0);

/** be32 of a uint64: 32 bytes with the value in the last eight. */
function be32(v: bigint): Uint8Array {
  const out = new Uint8Array(32);
  new DataView(out.buffer).setBigUint64(24, BigInt.asUintN(64, v), false);
  return out;
}

function pad32Addr(a: Uint8Array): Uint8Array {
  const out = new Uint8Array(32);
  out.set(a, 12);
  return out;
}

const addrWord = (w: Uint8Array): Uint8Array => Uint8Array.from(w.subarray(12));

/** The uint64 at big-endian byte offset [32-off-8, 32-off) of a word. */
function u64Of(w: Uint8Array, offFromRight: number): bigint {
  return new DataView(w.buffer, w.byteOffset, 32).getBigUint64(32 - offFromRight - 8, false);
}

/** keccak256(key || be32(slot)): the storage slot of a mapping entry. */
function mapSlot(key: Uint8Array, slot: bigint): Uint8Array {
  const buf = new Uint8Array(64);
  buf.set(key, 0);
  buf.set(be32(slot), 32);
  return keccak_256(buf);
}

/** common.BytesToHash: the last 32 bytes of b, or b right-aligned in 32 zero bytes. */
function bytesToHash(b: Uint8Array): Uint8Array {
  const out = new Uint8Array(32);
  if (b.length >= 32) out.set(b.subarray(b.length - 32));
  else out.set(b, 32 - b.length);
  return out;
}

/** The code hash as the pins are keyed by it: copy(h[:], CodeHash), left-aligned, truncated to 32 bytes. */
function codeHashOf(a: AcctRead): Uint8Array {
  const h = new Uint8Array(32);
  if (a.exists) h.set(a.codeHash.subarray(0, 32));
  return h;
}

interface AcctRead {
  exists: boolean;
  /** the 32-byte storage root */
  root: Uint8Array;
  /** any length, as the account encodes it */
  codeHash: Uint8Array;
}

/**
 * Reads accounts and slots from the proof node set under one state root (spec 5.5 O2). Every read is an MPT proof from NODES: account
 * key keccak256(address), slot key keccak256(slot), an absent key reads zero.
 */
class StateReader {
  private readonly db: ProofDb;
  private readonly accts = new Map<string, AcctRead>();
  constructor(
    nodes: readonly Uint8Array[],
    private readonly root: Uint8Array,
  ) {
    this.db = new ProofDb(nonEmpty(nodes));
  }

  /** trie.VerifyProof: ok is false for any proof failure; v is undefined for a proven absence. */
  private value(root: Uint8Array, key: Uint8Array): { ok: boolean; v: Uint8Array | undefined } {
    try {
      return { ok: true, v: verifyProofIn(this.db, root, key) };
    } catch (e) {
      if (e instanceof MptError || e instanceof RlpError) return { ok: false, v: undefined };
      throw e;
    }
  }

  /** An account under the state root; exists=false is a proven absence. A missing or inconsistent node is l1_state_proof_invalid{which:"account"}. */
  account(addr: Uint8Array): AcctRead {
    const k = hexLower(addr);
    const hit = this.accts.get(k);
    if (hit !== undefined) return hit;
    const r = this.value(this.root, keccak_256(addr));
    if (!r.ok) throw stateProofInvalid('account');
    let out: AcctRead = { exists: false, root: ZERO32, codeHash: new Uint8Array(0) };
    if (r.v !== undefined && r.v.length !== 0) {
      try {
        const it = structItems(r.v, 4);
        uintOf(it[0]!, 8);
        uintOf(it[1]!, 32);
        out = { exists: true, root: Uint8Array.from(fixedOf(it[2]!, 32)), codeHash: Uint8Array.from(bytesOf(it[3]!)) };
      } catch (e) {
        if (e instanceof RlpError) throw stateProofInvalid('account');
        throw e;
      }
    }
    this.accts.set(k, out);
    return out;
  }

  /** A storage slot of an existing account; an absent slot reads zero. A slot of an absent account is l1_state_proof_invalid{which:"account"}. */
  slot(addr: Uint8Array, slot: Uint8Array): Uint8Array {
    const a = this.account(addr);
    if (!a.exists) throw stateProofInvalid('account');
    const r = this.value(a.root, keccak_256(slot));
    if (!r.ok) throw stateProofInvalid('slot');
    const out = new Uint8Array(32);
    if (r.v === undefined || r.v.length === 0) return out;
    let raw: Uint8Array;
    try {
      const it = split(r.v);
      if (it.rest.length !== 0) throw new RlpError('input contains more than one value');
      raw = bytesOf(it);
    } catch (e) {
      if (e instanceof RlpError) throw stateProofInvalid('slot');
      throw e;
    }
    if (raw.length > 32 || raw.length === 0) throw stateProofInvalid('slot');
    out.set(raw, 32 - raw.length);
    return out;
  }
}

/** What the proven L1 state says about the game, decoded before any predicate is applied. */
export interface GameState {
  createdAt: bigint;
  resolvedAt: bigint;
  status: number;
  initialized: number;
  respected: number;
  countered: Uint8Array;
  teeProver: Uint8Array;
  zkProver: Uint8Array;
  expectedResolution: bigint;
  proofCount: bigint;
  retirementTimestamp: bigint;
  respectedGameType: number;
  pause0: Uint8Array;
  pauseOnPortal: Uint8Array;
}

function proofSystem(g: GameState): string {
  const tee = !isZero(g.teeProver);
  const zk = !isZero(g.zkProver);
  if (tee && zk) return 'tee+zk';
  if (tee) return 'tee';
  if (zk) return 'zk';
  return 'none';
}

function finalizationPath(g: GameState, slow: bigint): string | undefined {
  if (g.expectedResolution < g.createdAt) return undefined;
  const d = g.expectedResolution - g.createdAt;
  if (d === slow) return 'slow';
  if (d > slow) return 'extended';
  if (g.proofCount === 2n && isZero(g.countered)) return 'fast';
  return undefined;
}

/** DGF's keccak256(abi.encode(gameType, rootClaim, extraData)) for a uint32 type, bytes32 root and bytes extraData. */
export function gameUUID(gameType: number, rootClaim: Uint8Array, extra: Uint8Array): Uint8Array {
  const pad = (32 - (extra.length % 32)) % 32;
  const b = new Uint8Array(32 * 4 + extra.length + pad);
  b.set(be32(BigInt(gameType)), 0);
  b.set(rootClaim, 32);
  b.set(be32(0x60n), 64);
  b.set(be32(BigInt(extra.length)), 96);
  b.set(extra, 128);
  return keccak_256(b);
}

/** Everything the L1-state part needs once the L1 finalized head has been proven and A located on its spine. */
export interface JudgeInput {
  a: L1Block;
  body: Body;
  leg: BlockRef;
  pins: BaseFinalPins;
  head: Pick<FinalizedHead, 'slot' | 'participants'>;
}

const st = (code: string, fields: Fields = {}): FinalityStateError => newState(code, fields);

/** The L1-state half of 5.5 (O2-O6) over a proven A. It is pure. */
export function judge(inp: JudgeInput): Fields {
  const { pins: p, a: A, body } = inp;
  const rd = new StateReader(body.nodes, A.stateRoot);
  const identity = (role: string, addr: Uint8Array, ch: Uint8Array): FinalityStateError => contractIdentity(role, addr, ch, A.number);
  const pinKey = (ch: Uint8Array): string => hex0x(ch);
  /** proxy proves the account of a pinned-by-graph proxy and its runtime code against proxy_pins. */
  const proxy = (name: string, addr: Uint8Array, want: string): AcctRead => {
    const a = rd.account(addr);
    if (!a.exists || p.proxy.get(pinKey(codeHashOf(a))) !== want) throw identity(`${name}_proxy`, addr, codeHashOf(a));
    return a;
  };
  /** impl proves the EIP-1967 implementation behind a proxy and its role in impl_pins. */
  const impl = (role: string, prx: Uint8Array): ImplRow => {
    const w = rd.slot(prx, EIP1967_IMPL_SLOT);
    const ia = addrWord(w);
    const a = rd.account(ia);
    const row = p.impl.get(pinKey(codeHashOf(a)));
    if (!a.exists || row === undefined || row.role !== role) throw identity(role, ia, codeHashOf(a));
    return row;
  };

  // -- identity: the contract graph from the two address pins (5.5 O3) --
  const pa = proxy('portal', p.portal, RoleOPProxy);
  let w = rd.slot(p.portal, be32(slotPortalSystemConfig));
  if (!eq(addrWord(w), p.systemConfig)) throw identity('portal.systemConfig', addrWord(w), codeHashOf(pa));
  impl(RolePortalImpl, p.portal);
  const sa = proxy('system_config', p.systemConfig, RoleOPProxy);
  w = rd.slot(p.systemConfig, OPTIMISM_PORTAL_SLOT);
  if (!eq(addrWord(w), p.portal)) throw identity('systemconfig.portal', addrWord(w), codeHashOf(sa));
  impl(RoleSysCfgImpl, p.systemConfig);
  w = rd.slot(p.portal, be32(slotPortalASR));
  const asr = addrWord(w);
  const aa = proxy('asr', asr, RoleOPProxy);
  w = rd.slot(asr, be32(slotASRSystemConfig));
  if (!eq(w.subarray(10, 30), p.systemConfig)) throw identity('asr.systemConfig', Uint8Array.from(w.subarray(10, 30)), codeHashOf(aa));
  const asrRow = impl(RoleASRImpl, asr);
  if (asrRow.finalityDelaySeconds === null) throw identity(RoleASRImpl, asr, codeHashOf(aa));
  const delay = asrRow.finalityDelaySeconds;
  w = rd.slot(asr, be32(slotASRDGF));
  const dgf = addrWord(w);
  proxy('dgf', dgf, RoleOPProxy);
  impl(RoleDGFImpl, dgf);
  w = rd.slot(p.systemConfig, be32(slotSysCfgSuperchain));
  const sup = addrWord(w);
  proxy('superchain', sup, RoleSuperchainPrx);
  impl(RoleSuperchainImpl, sup);

  // -- the game proxy: code, clone template, decoded args (5.5 O3) --
  const ga = rd.account(body.gameProxy);
  const code = body.gameCode;
  if (!ga.exists || !eq(keccak_256(code), bytesToHash(ga.codeHash))) throw stateProofInvalid('account');
  const lay = p.layouts.get(LayoutAggregateV1);
  if (lay === undefined) throw pinsCorrupt(PinsReason.BadValue, { key: 'base_sepolia.game_layout' });
  const tmplLen = lay.cloneHead.length + 2 + lay.cloneMid.length + 20 + lay.cloneTail.length;
  const implOff = lay.cloneHead.length + 2 + lay.cloneMid.length;
  if (code.length < tmplLen + 2) throw gameUnrecognised(GameReason.Prefix);
  const gimpl = Uint8Array.from(code.subarray(implOff, implOff + 20));
  const gia = rd.account(gimpl);
  const row = p.impl.get(pinKey(codeHashOf(gia)));
  if (!gia.exists || row === undefined || row.role !== RoleGameImpl || !rowComplete(row, p.layouts) || !eq(row.impl, gimpl) || row.cwia !== LayoutAggregateV1) {
    throw identity(RoleGameImpl, gimpl, codeHashOf(gia));
  }
  const rest = BigInt(code.length - tmplLen - 2);
  if (rest < lay.argsBaseLen || (rest - lay.argsBaseLen) % lay.argsPerRoot !== 0n) throw gameUnrecognised(GameReason.ArgsLen);
  if ((rest - lay.argsBaseLen) / lay.argsPerRoot !== row.nIntermediate) throw gameUnrecognised(GameReason.NMismatch);
  // the template with the length field as uint16(args_len + 2): a Go int64 sum truncated to 16 bits
  const argsLen2 = Number(BigInt.asUintN(16, BigInt.asIntN(64, row.argsLen + 2n)));
  const want = new Uint8Array(tmplLen);
  want.set(lay.cloneHead, 0);
  want[lay.cloneHead.length] = argsLen2 >> 8;
  want[lay.cloneHead.length + 1] = argsLen2 & 0xff;
  want.set(lay.cloneMid, lay.cloneHead.length + 2);
  want.set(gimpl, implOff);
  want.set(lay.cloneTail, implOff + 20);
  if (!eq(code.subarray(0, tmplLen), want)) throw gameUnrecognised(GameReason.Prefix);
  if (((code[code.length - 2]! << 8) | code[code.length - 1]!) !== argsLen2) throw gameUnrecognised(GameReason.Trailer);
  const args = code.subarray(tmplLen, code.length - 2);
  const argsBase = Number(lay.argsBaseLen);
  const rootClaim = Uint8Array.from(args.subarray(20, 52));
  const extraData = args.subarray(84);
  const l2seqW = Uint8Array.from(args.subarray(84, 116));
  const nInter = Number(row.nIntermediate);
  const roots: Uint8Array[] = [];
  for (let i = 0; i < nInter; i++) roots.push(Uint8Array.from(args.subarray(argsBase + 32 * i, argsBase + 32 * i + 32)));

  // -- registration: DGF._disputeGames[uuid] = gameType || createdAt || proxy (5.5 O4) --
  const uuid = gameUUID(row.gameType, rootClaim, extraData);
  const reg = rd.slot(dgf, mapSlot(uuid, mapDGFGames));
  if (isZero(reg)) throw st(CodeGameNotRegistered);
  const gt = new DataView(reg.buffer, reg.byteOffset, 32).getUint32(0, false);
  if (gt !== row.gameType) throw st(CodeGameTypeUnsupported, { type: BigInt(gt) });

  // -- the proven game state: slots 0, 2, 5, 6 (TEE and ZK keys), 7 --
  const slot = (s: Uint8Array): Uint8Array => rd.slot(body.gameProxy, s);
  const w0 = slot(be32(slotGameMain));
  const createdAt = u64Of(w0, 0);
  const resolvedAt = u64Of(w0, 8);
  // Initialized and (below) RespectedGameType are decoded for the record and gate nothing: isGameClaimValid is proper, respected (the
  // game's own wasRespectedGameTypeWhenCreated flag, not the current respected type), finalized and DEFENDER_WINS (R11 Q5).
  const status = w0[15]!;
  const initialized = w0[14]!;
  const respected = w0[13]!;
  const w2 = slot(be32(slotGameStartL2Seq));
  const countered = slot(be32(slotGameCountered));
  const teeProver = slot(mapSlot(be32(0n), mapGameProver));
  const zkProver = slot(mapSlot(be32(1n), mapGameProver));
  const w7 = slot(be32(slotGameExpectedRes));
  const g: GameState = {
    createdAt,
    resolvedAt,
    status,
    initialized,
    respected,
    countered,
    teeProver,
    zkProver,
    expectedResolution: u64Of(w7, 0),
    proofCount: u64Of(w7, 8),
    retirementTimestamp: 0n,
    respectedGameType: 0,
    pause0: ZERO32,
    pauseOnPortal: ZERO32,
  };
  if (!eq(reg.subarray(12, 32), body.gameProxy) || new DataView(reg.buffer, reg.byteOffset, 32).getBigUint64(4, false) !== g.createdAt) {
    throw st(CodeGameNotRegistered);
  }

  // -- isGameClaimValid as of A (5.5 O4) --
  const bl = rd.slot(asr, mapSlot(pad32Addr(body.gameProxy), mapASRBlacklist));
  const rr = rd.slot(asr, be32(slotASRRespectedRetire));
  g.respectedGameType = new DataView(rr.buffer, rr.byteOffset, 32).getUint32(28, false);
  g.retirementTimestamp = u64Of(rr, 4);
  g.pause0 = rd.slot(sup, mapSlot(be32(0n), 0n));
  g.pauseOnPortal = rd.slot(sup, mapSlot(pad32Addr(p.portal), 0n));
  if (!isZero(bl)) throw st(CodeGameBlacklisted);
  if (g.createdAt <= g.retirementTimestamp) throw st(CodeGameRetired, { createdAt: g.createdAt, retirementTimestamp: g.retirementTimestamp });
  const word = (b: Uint8Array): string => BigInt(`0x${hexLower(b)}`).toString();
  if (!isZero(g.pause0)) throw st(CodeL1SystemPaused, { identifier: new Uint8Array(20), pauseTimestamp: word(g.pause0) });
  if (!isZero(g.pauseOnPortal)) throw st(CodeL1SystemPaused, { identifier: p.portal, pauseTimestamp: word(g.pauseOnPortal) });
  if (g.respected !== 1) throw st(CodeGameNotRespected);
  if (g.resolvedAt === 0n || (g.status !== StatusChallengerWins && g.status !== StatusDefenderWins)) throw st(CodeGameNotResolved, { status: BigInt(g.status) });
  // wrap-free: ResolvedAt+delay wraps for a delay near 2^64, so the difference is compared instead
  if (A.timestamp <= g.resolvedAt || A.timestamp - g.resolvedAt <= delay) {
    throw st(CodeGameWithinDelay, { resolvedAt: g.resolvedAt, delay, T: A.timestamp });
  }
  if (g.status !== StatusDefenderWins) throw st(CodeGameChallengerWins);
  // consistency of the proven slots (5.5 O4, [r2:E4]): a DEFENDER_WINS game has slot 5 = 0, at least one prover key, an expectedResolution
  // it was resolved after, and a finalization path its proof count explains.
  const ps = proofSystem(g);
  const path = finalizationPath(g, row.slowDelay);
  if (!isZero(g.countered) || ps === 'none' || g.resolvedAt < g.expectedResolution || path === undefined) throw stateProofInvalid('slot');

  // -- output root (5.5 O5) --
  // the l2 sequence numbers are uint256 words that must fit 64 bits
  const pairErr = (total: bigint, n: bigint): FinalityStateError => gameUnrecognised(GameReason.IntervalPair, { total, n: BigInt.asUintN(64, n) });
  if (!isZero(l2seqW.subarray(0, 24)) || !isZero(w2.subarray(0, 24))) throw pairErr(0n, row.nIntermediate);
  const l2seq = new DataView(l2seqW.buffer, l2seqW.byteOffset, 32).getBigUint64(24, false);
  const start = new DataView(w2.buffer, w2.byteOffset, 32).getBigUint64(24, false);
  if (l2seq < start) throw pairErr(0n, row.nIntermediate);
  const total = l2seq - start;
  let interval = 0n;
  let matched = false;
  for (const [t, step] of row.intervalPairs) {
    if (t === total) {
      const n = BigInt.asIntN(64, total / step);
      if (n !== row.nIntermediate) throw pairErr(total, n);
      interval = step;
      matched = true;
      break;
    }
  }
  if (!matched) throw pairErr(total, row.nIntermediate);
  const k = body.outputRootIndex;
  if (BigInt(k) > row.nIntermediate) throw evidenceTooLarge('outputRootIndex', BigInt(k), row.nIntermediate);
  let outBlock = l2seq;
  let claimed: Uint8Array = rootClaim;
  let rootKind = 'root_claim';
  if (k > 0) {
    outBlock = BigInt.asUintN(64, start + interval * BigInt(k));
    claimed = roots[k - 1]!;
    rootKind = 'intermediate';
  }
  if (body.l2Spine.length === 0) throw st(CodeL2NotCanonical);
  const h0 = readHeader(body.l2Spine[0]!);
  let computed: Uint8Array = ZERO32;
  if (h0.withdrawalsRoot !== undefined) {
    const buf = new Uint8Array(128);
    buf.set(h0.stateRoot, 32);
    buf.set(h0.withdrawalsRoot, 64);
    buf.set(h0.hash, 96);
    computed = keccak_256(buf);
  }
  if (!eq(computed, claimed)) throw st(CodeOutputRootMismatch, { computed, claimed });

  // -- the L2 spine from the output-root block down to the leg's block (5.5 O6) --
  let prev = h0;
  for (const raw of body.l2Spine.slice(1)) {
    const prevBelow = BigInt.asUintN(64, prev.number - 1n);
    let cur;
    try {
      cur = readHeader(raw);
    } catch (e) {
      if (e instanceof FinalityStateError) throw headerChainBroken('l2', prevBelow, prev.parentHash, keccak_256(raw), 'rlp');
      throw e;
    }
    if (!eq(cur.hash, prev.parentHash)) throw headerChainBroken('l2', prevBelow, prev.parentHash, cur.hash, 'hash');
    if (prev.number === 0n || cur.number !== prev.number - 1n) throw headerChainBroken('l2', prevBelow, prev.parentHash, cur.hash, 'number');
    prev = cur;
  }
  const last = body.l2Spine[body.l2Spine.length - 1]!;
  const leg = inp.leg;
  if (prev.number !== leg.number || !eq(prev.hash, leg.hash) || (leg.headerRlp !== undefined && !eq(last, leg.headerRlp))) throw st(CodeL2NotCanonical);

  return {
    a_number: A.number,
    a_hash: A.hash,
    a_timestamp: A.timestamp,
    game: body.gameProxy,
    game_type: BigInt(row.gameType),
    game_version: row.version,
    created_at: g.createdAt,
    resolved_at: g.resolvedAt,
    status: BigInt(g.status),
    output_root_block: outBlock,
    output_root_index: BigInt(k),
    root_kind: rootKind,
    proof_system: ps,
    proof_count: g.proofCount,
    expected_resolution: g.expectedResolution,
    finalization_path: path,
    l1_finalized_slot: inp.head.slot,
    l1_participants: BigInt(inp.head.participants),
  };
}

/** The verifier of base-sepolia/finalized/v1. */
export class BaseFinalKind implements Kind {
  name(): string {
    return KIND_NAME;
  }
  chain(): bigint {
    return CHAIN;
  }
  level(): Level {
    return Level.Finalized;
  }

  /**
   * Judges the whole CFE1 container `evidence` about the leg block b (spec 5.5). The LC part is proven first (a refusal is
   * l1_finality_unproven{reason:lc_refused, inner}), the L1 spine must cover `stateBlock`, and A's state root and timestamp are read from
   * the covered header, never from the evidence.
   */
  verify(p: Pins | null, b: BlockRef, evidence: Uint8Array): Verdict {
    const lim = defaultLimits();
    const c = decodeContainer(evidence, lim);
    if (c.header.kind !== KIND_NAME) throw evidenceUnrecognised(c.header.kind, '');
    if (c.header.chain !== CHAIN || c.header.level !== Level.Finalized) throw malformed('header', EvidenceReason.DiffersFromAddendum, 0, 0);
    if (c.header.blockNumber !== b.number || !sameBytes(c.header.blockHash, b.hash) || b.chain !== CHAIN) {
      throw blockMismatch('blockHash', b.hash, c.header.blockHash);
    }
    const bp = parseBasePins(p);
    const eth = sepoliaPins(p);
    const ep = ethl1PinsFrom(eth);
    // Go's int: a max_l2_headers above the framework bound is clamped to it by the decoder
    const maxL2 = bp.maxL2Headers > BigInt(lim.maxL2Headers) ? lim.maxL2Headers : Number(bp.maxL2Headers);
    const body = decodeBody(c.body, lim, ep, maxL2);
    let head: FinalizedHead;
    try {
      head = verifyFinalizedHead(ep, body.lc);
    } catch (e) {
      if (e instanceof FinalityStateError) throw l1FinalityUnproven(LC_REFUSED, e.code);
      throw e;
    }
    const covered = covers(head, body.l1Spine, ep.maxSpineHeaders);
    const a = blockAt(covered, body.stateBlock);
    const fields = judge({ a, body, leg: b, pins: bp, head });
    return { level: Level.Finalized, kind: KIND_NAME, fields };
  }
}

/** Adds the kind to a registry; there is no import-time registration. */
export function registerBaseFinal(reg: Registry): void {
  reg.registerKind(new BaseFinalKind());
}

/**
 * The L1-state, output-root and L2-spine half of 5.5 (O2-O6) over an L1 block A that the caller has already located on a covered spine.
 * verify calls it after the LC and the spine; the conformance harness calls it on the judge-level vectors (a synthetic world's state root).
 */
export function judgeBase(p: BaseFinalPins, a: L1Block, body: Body, leg: BlockRef, head: Pick<FinalizedHead, 'slot' | 'participants'>): Fields {
  return judge({ a, body, leg, pins: p, head });
}

