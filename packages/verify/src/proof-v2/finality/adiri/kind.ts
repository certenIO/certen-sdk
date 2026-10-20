/**
 * The Kind adiri/finalized/v1 (V2_SPEC_S7 3.3 and 5.8; the twin of pkg/finality/adiri kind.go): a leg block on Adiri (chain 2017, Telcoin
 * Network) is finalized when it is an ancestor of the last block F of an epoch E whose EpochRecord a super-quorum of committee(E) signed,
 * with committee(E) chained from the pinned genesis committee through certified records 0..E (chain.ts), and linked to F by a header
 * spine (linkKind 1) or by the EIP-2935 history contract's storage slot N mod 8191 under stateRoot_F (linkKind 2).
 *
 * Order of judgement: the pins; the container header; the body; the CFA1; the committee chain (O1-O3); the link (O4).
 */
import { keccak_256 } from '@noble/hashes/sha3';
import { MptError, verifyStorage } from '../../../s6/mpt.js';
import { RlpError, split, splitList } from '../../../s6/rlp.js';
import { Reader, Writer, decodeContainer, defaultLimits, encodeContainer, encodeNodes, type Limits } from '../codec.js';
import { sameBytes, type BlockRef } from '../evidence.js';
import { Level } from '../level.js';
import type { Pins } from '../pins.js';
import type { Kind, Registry, Verdict } from '../registry.js';
import { readHeader, type HeaderFields } from '../rlpheader.js';
import { FinalityStateError, blockMismatch, evidenceUnrecognised, malformed, type Fields } from '../state.js';
import { ChainAdiri } from '../table.js';
import { decodeCFA1 } from './cfa1.js';
import { verifyCommitteeChain, type ChainResult } from './chain.js';
import { Name, parsePins, type Params } from './record.js';
import type { Mode, Rand } from './sigs.js';
import {
  LinkBlockAfterSeal,
  LinkCodeHashMismatch,
  LinkHeaderDecode,
  LinkProofInvalid,
  LinkSlotValueMismatch,
  LinkTipNotFinalState,
  ReasonNumberGap,
  ReasonParentHash,
  headerChainBroken,
  linkBroken,
  pinMismatch,
} from './states.js';

/** Link kinds of the body (V2_SPEC_S7 3.3). */
export const LinkSpine = 1;
export const LinkSlot = 2;
/** the ring size of the EIP-2935 history contract */
export const EIP2935Window = 8191n;

export const ReasonLevelNotFinalized = 'level_not_finalized';
export const ReasonSpineEmpty = 'spine_empty';
export const ReasonLinkKindUnknown = 'link_kind_unknown';
export const ReasonLinkKind2AtSeal = 'link_kind_2_at_seal';

/** The body after the CFE1 header: LP cfa1 || u8 linkKind || (1: LIST<LP> spine | 2: LP finalHeader || NODES). */
export interface Body {
  cfa1: Uint8Array;
  linkKind: number;
  /** linkKind 1, descending from F to the leg block */
  spine: Uint8Array[];
  /** linkKind 2 */
  finalHeader: Uint8Array;
  /** linkKind 2, strictly ascending by keccak256 */
  nodes: Uint8Array[];
}

/** The canonical body. */
export function encodeBody(b: Body): Uint8Array {
  const w = new Writer();
  w.lp(b.cfa1);
  w.u8(b.linkKind);
  if (b.linkKind === LinkSpine) w.lpList(b.spine);
  else if (b.linkKind === LinkSlot) {
    w.lp(b.finalHeader);
    w.nodes(encodeNodes(b.nodes));
  }
  return w.bytes();
}

/** Decodes strictly. The spine is bounded by min(maxHeaders, Limits.maxSpineHeaders). */
export function decodeBody(body: Uint8Array, lim: Limits, maxHeaders: number): Body {
  const r = new Reader(body, lim);
  const cfa1 = r.lp('cfa1', lim.maxEvidenceBytes);
  const linkKind = r.u8('linkKind');
  let spine: Uint8Array[] = [];
  let finalHeader: Uint8Array = new Uint8Array(0);
  let nodes: Uint8Array[] = [];
  switch (linkKind) {
    case LinkSpine: {
      let limit = lim.maxSpineHeaders;
      if (maxHeaders > 0 && maxHeaders < limit) limit = maxHeaders;
      spine = r.lpList('spine', limit, lim.maxNodeBytes);
      if (spine.length === 0) throw malformed('spine', ReasonSpineEmpty, 0, 1);
      break;
    }
    case LinkSlot:
      finalHeader = r.lp('finalHeader', lim.maxNodeBytes);
      nodes = r.nodes('nodes', lim.maxNodeBytes);
      break;
    default:
      throw malformed('linkKind', ReasonLinkKindUnknown, linkKind, 1);
  }
  r.end('body');
  return { cfa1, linkKind, spine, finalHeader, nodes };
}

/** Wraps a body in the CFE1 container for the leg block. */
export function buildContainer(leg: BlockRef, b: Body): Uint8Array {
  return encodeContainer({
    header: { kind: Name, chain: ChainAdiri, level: Level.Finalized, blockNumber: leg.number, blockHash: leg.hash },
    body: encodeBody(b),
  });
}

const U64 = (1n << 64n) - 1n;
const u64 = (v: bigint): bigint => v & U64;

/** parentBeaconBlockRoot (item 19) of a header, or the zero hash when absent; reported, never required. */
export function consensusRootOf(raw: Uint8Array): Uint8Array {
  const zero = new Uint8Array(32);
  try {
    let content = splitList(raw).content;
    for (let i = 0; content.length > 0; i++) {
      const it = split(content);
      if (i === 19 && it.content.length === 32) return Uint8Array.from(it.content);
      content = it.rest;
    }
  } catch (e) {
    if (e instanceof RlpError) return zero;
    throw e;
  }
  return zero;
}

interface LinkResult {
  consensusRootMatches: boolean;
}

/** O4: the seal R = record E with N <= F.number, and the link from F to the leg block. */
function verifyLink(par: Params, res: ChainResult, body: Body, leg: BlockRef): LinkResult {
  const F = res.final;
  if (leg.number > F.number) throw linkBroken(LinkBlockAfterSeal, F.number, leg.number, leg.number);
  return body.linkKind === LinkSpine ? verifySpine(res, body.spine, leg) : verifySlot(par, res, body, leg);
}

/**
 * keccak256(h_0) = F.hash and number(h_0) = F.number; for i >= 1 keccak256(h_i) = parentHash(h_{i-1}) and number(h_i) = number(h_{i-1}) - 1;
 * h_k is the leg's own header (byte-identical to Settlement.Header when the caller holds it, else equal by hash and number). Block numbers are
 * uint64 and wrap as Go's do.
 */
function verifySpine(res: ChainResult, spine: readonly Uint8Array[], leg: BlockRef): LinkResult {
  const F = res.final;
  const out: LinkResult = { consensusRootMatches: false };
  let prev: HeaderFields | undefined;
  for (let i = 0; i < spine.length; i++) {
    const raw = spine[i]!;
    let h: HeaderFields;
    try {
      h = readHeader(raw);
    } catch (e) {
      if (e instanceof FinalityStateError) throw linkBroken(LinkHeaderDecode, F.number, leg.number, u64(F.number - BigInt(i)), { index: BigInt(i) });
      throw e;
    }
    if (prev === undefined) {
      if (!sameBytes(h.hash, F.hash) || h.number !== F.number) {
        throw linkBroken(LinkTipNotFinalState, F.number, leg.number, h.number, { want_hash: F.hash, got_hash: h.hash });
      }
      out.consensusRootMatches = sameBytes(consensusRootOf(raw), res.finalConsensus.hash);
    } else {
      if (!sameBytes(h.hash, prev.parentHash)) throw headerChainBroken(u64(prev.number - 1n), prev.parentHash, h.hash, ReasonParentHash);
      if (u64(h.number + 1n) !== prev.number) throw headerChainBroken(u64(prev.number - 1n), prev.parentHash, h.hash, ReasonNumberGap);
    }
    prev = h;
  }
  const lastH = prev!;
  if (lastH.number !== leg.number) throw blockMismatch('spineLastNumber', leg.number, lastH.number);
  if (!sameBytes(lastH.hash, leg.hash)) throw blockMismatch('spineLastHash', leg.hash, lastH.hash);
  if (leg.headerRlp !== undefined && !sameBytes(spine[spine.length - 1]!, leg.headerRlp)) {
    throw blockMismatch('spineLastHeader', hex(keccak_256(leg.headerRlp)), hex(keccak_256(spine[spine.length - 1]!)));
  }
  return out;
}

const hex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

/**
 * linkKind 2, only when N < F.number. keccak256(finalHeader) = F.hash; the EIP-2935 account (codeHash = pin) and storage slot N mod 8191
 * hold the leg block's hash under stateRoot_F.
 */
function verifySlot(par: Params, res: ChainResult, body: Body, leg: BlockRef): LinkResult {
  const F = res.final;
  if (leg.number === F.number) throw malformed('linkKind', ReasonLinkKind2AtSeal, body.linkKind, 1);
  let h: HeaderFields;
  try {
    h = readHeader(body.finalHeader);
  } catch (e) {
    if (e instanceof FinalityStateError) throw linkBroken(LinkHeaderDecode, F.number, leg.number, F.number);
    throw e;
  }
  if (!sameBytes(h.hash, F.hash) || h.number !== F.number) {
    throw linkBroken(LinkTipNotFinalState, F.number, leg.number, h.number, { want_hash: F.hash, got_hash: h.hash });
  }
  const out: LinkResult = { consensusRootMatches: sameBytes(consensusRootOf(body.finalHeader), res.finalConsensus.hash) };
  const slot = new Uint8Array(32);
  let n = leg.number % EIP2935Window;
  for (let i = 31; i >= 0 && n > 0n; i--) {
    slot[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  let sr: ReturnType<typeof verifyStorage>;
  try {
    sr = verifyStorage(h.stateRoot, par.eip2935Address, body.nodes, slot, body.nodes);
  } catch (e) {
    if (e instanceof MptError || e instanceof RlpError) throw linkBroken(LinkProofInvalid, F.number, leg.number, leg.number);
    throw e;
  }
  if (!sr.account.exists || !sameBytes(sr.account.codeHash, par.eip2935CodeHash)) {
    throw linkBroken(LinkCodeHashMismatch, F.number, leg.number, leg.number, { want: par.eip2935CodeHash, got: sr.account.codeHash });
  }
  if (!sameBytes(sr.value, leg.hash)) throw linkBroken(LinkSlotValueMismatch, F.number, leg.number, leg.number, { want: leg.hash, got: sr.value });
  return out;
}

export interface VerifierOptions {
  /** the signature strategy; the default is batched (the production form) */
  mode?: Mode;
  /** the source of the batch scalars (the default is the platform CSPRNG) */
  rand?: Rand;
  limits?: Limits;
}

/** The adiri/finalized/v1 Kind. */
export class AdiriVerifier implements Kind {
  readonly mode: Mode;
  readonly rand: Rand | undefined;
  private readonly lim: Limits;
  constructor(opts: VerifierOptions = {}) {
    this.mode = opts.mode ?? 'batched';
    this.rand = opts.rand;
    this.lim = opts.limits ?? defaultLimits();
  }
  name(): string {
    return Name;
  }
  chain(): bigint {
    return ChainAdiri;
  }
  level(): 3 {
    return Level.Finalized;
  }

  /** Judges the whole container: a Verdict, or a thrown named state. */
  verify(p: Pins | null, leg: BlockRef, evidence: Uint8Array): Verdict {
    const lim = this.lim;
    const par = parsePins(p);
    if (par.chainId !== ChainAdiri) throw pinMismatch('chain_id', ChainAdiri, par.chainId);
    const c = decodeContainer(evidence, lim);
    const h = c.header;
    if (h.kind !== Name) throw evidenceUnrecognised(h.kind, '');
    if (h.chain !== ChainAdiri) throw pinMismatch('chain_id', par.chainId, h.chain);
    if (h.level !== Level.Finalized) throw malformed('header.level', ReasonLevelNotFinalized, h.level, 3);
    if (h.blockNumber !== leg.number) throw blockMismatch('blockNumber', leg.number, h.blockNumber);
    if (!sameBytes(h.blockHash, leg.hash)) throw blockMismatch('blockHash', leg.hash, h.blockHash);
    const maxHeaders = par.maxHeaders > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(par.maxHeaders);
    const body = decodeBody(c.body, lim, maxHeaders);
    const chain = decodeCFA1(body.cfa1, lim);
    const res = verifyCommitteeChain(par, chain, this.mode, this.rand);
    const link = verifyLink(par, res, body, leg);
    const fields: Fields = {
      epoch: BigInt(res.epoch),
      chain_len: BigInt(res.epoch) + 1n,
      committee_size: BigInt(res.committeeSize),
      signers: BigInt(res.signers),
      final_number: res.final.number,
      final_hash: res.final.hash,
      distance: res.final.number - leg.number,
      link_kind: BigInt(body.linkKind),
      consensus_root_matches: link.consensusRootMatches,
      committee_shrunk: res.shrunk.map((s) => s.canonical()),
    };
    return { level: Level.Finalized, kind: Name, fields };
  }
}

/** Registers the Adiri Kind. It is explicit: the module has no side effect, and wiring into defaultRegistry is the integration package's job. */
export function registerAdiri(reg: Registry, opts: VerifierOptions = {}): void {
  reg.registerKind(new AdiriVerifier(opts));
}
