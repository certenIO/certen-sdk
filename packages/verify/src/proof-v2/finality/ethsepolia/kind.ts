/**
 * The Kind eth-sepolia/finalized/v1 (V2_SPEC_S7 sections 3.3 and 5.3; the twin of pkg/finality/ethsepolia): a block of Ethereum Sepolia
 * is final iff it is an ancestor of the execution block that Ethereum's finalized checkpoint commits, attested by at least 342 of 512
 * sync-committee signatures chained from a published pin. The kind is the container codec and a thin judgement over ethl1 (which does
 * the beacon light-client work); the builder is the validator's.
 *
 * Registration is explicit (registerEthSepolia); the module has no side effect.
 */
import { keccak_256 } from '@noble/hashes/sha3';
import { Reader, Writer, decodeContainer, defaultLimits, encodeContainer, type Limits } from '../codec.js';
import { blockAt, covers, encodeLC, ethl1PinsFrom, verifyFinalizedHead, type FinalizedHead, type L1Block, type LB, type LC } from '../ethl1/index.js';
import { sameBytes, type BlockRef } from '../evidence.js';
import { Level } from '../level.js';
import { sepoliaPins, type Pins } from '../pins.js';
import type { Kind, Registry, Verdict } from '../registry.js';
import { readHeader } from '../rlpheader.js';
import { EvidenceReason, FinalityStateError, blockMismatch, malformed, newState } from '../state.js';
import { ChainSepolia } from '../table.js';
import { stateOf } from './states.js';

/** The kind string (V2_SPEC_S7 section 1). */
export const KIND_NAME = 'eth-sepolia/finalized/v1';

/** The kind's body after the CFE1 header (3.3): LC || LIST<LP> spine, with the spine h_0 = the finalized execution head down to h_k = the leg block. */
export interface Body {
  lc: LC;
  spine: Uint8Array[];
}

/** The canonical body: encodeLC followed by the spine as LIST<LP>. */
export function encodeBody(b: Body): Uint8Array {
  const w = new Writer();
  w.fixed(encodeLC(b.lc));
  w.lpList(b.spine);
  return w.bytes();
}

/**
 * Reads the LC part from the container stream (spec 3.2). The layout byte of each LB and the ssz lengths are judged by ethl1; this reader
 * only frames them, strictly and under the link bound: the link count is bounded by maxLinks and by the bytes left (5 bytes per link at
 * least) before anything is allocated.
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

/**
 * Decodes the body strictly: the spine count is bounded by min(maxSpine, lim.maxSpineHeaders) and the link count by maxLinks before
 * anything is allocated, a trailing byte is refused, and encode(decode(x)) == x.
 */
export function decodeBody(body: Uint8Array, lim: Limits, maxLinks: number, maxSpine: number): Body {
  const r = new Reader(body, lim);
  const lc = readLC(r, maxLinks);
  let limit = lim.maxSpineHeaders;
  if (maxSpine > 0 && maxSpine < limit) limit = maxSpine;
  const spine = r.lpList('spine', limit, lim.maxNodeBytes);
  if (spine.length === 0) throw malformed('spine', EvidenceReason.SpineEmpty, 0, 1);
  r.end('body');
  return { lc, spine };
}

/** Wraps a body in the CFE1 container for the leg block. */
export function buildContainer(leg: BlockRef, b: Body): Uint8Array {
  return encodeContainer({
    header: { kind: KIND_NAME, chain: ChainSepolia, level: Level.Finalized, blockNumber: leg.number, blockHash: leg.hash },
    body: encodeBody(b),
  });
}

/** Adds the spine index to a framework malformed state (Go indexed). */
function indexed(err: unknown, i: number): unknown {
  if (err instanceof FinalityStateError) {
    const out = newState(err.code, err.fields);
    out.fields.part = 'spine';
    out.fields.index = BigInt(i);
    return out;
  }
  return err;
}

/** The eth-sepolia/finalized/v1 Kind. It is pure: the pins, the leg block and the evidence are its only inputs. */
export class EthSepoliaKind implements Kind {
  /**
   * lim overrides the generic bounds (defaultLimits() when absent); the chain-specific ones (max_links, max_spine_headers) always come
   * from the pins.
   */
  constructor(private readonly lim?: Limits) {}

  name(): string {
    return KIND_NAME;
  }
  chain(): bigint {
    return ChainSepolia;
  }
  level(): Level {
    return Level.Finalized;
  }

  /** Spec 5.3, step by step. The result fields are those of 5.3 step 4. */
  verify(p: Pins | null, leg: BlockRef, evidence: Uint8Array): Verdict {
    const e = sepoliaPins(p);
    const l1 = ethl1PinsFrom(e);
    const lim = this.lim ?? defaultLimits();
    const c = decodeContainer(evidence, lim);
    // 5.3 step 1 [PIN]: chain 11155111, level 3, this kind, and the leg's own block.
    const h = c.header;
    if (h.kind !== KIND_NAME) throw malformed('header.kind', EvidenceReason.DiffersFromAddendum, 0, 0);
    if (h.chain !== ChainSepolia) throw blockMismatch('chain', ChainSepolia, h.chain);
    if (h.level !== Level.Finalized) throw malformed('header.level', EvidenceReason.LevelNotFinalized, h.level, Level.Finalized);
    if (leg.chain !== ChainSepolia) throw blockMismatch('chain', ChainSepolia, leg.chain);
    if (h.blockNumber !== leg.number) throw blockMismatch('blockNumber', leg.number, h.blockNumber);
    if (!sameBytes(h.blockHash, leg.hash)) throw blockMismatch('blockHash', leg.hash, h.blockHash);
    const body = decodeBody(c.body, lim, l1.maxLinks, l1.maxSpineHeaders);
    // every spine header is read positionally by the framework first, so a header that cannot be read is a malformed part with its
    // index, never a header-chain reason outside the registry's set.
    for (let i = 0; i < body.spine.length; i++) {
      try {
        readHeader(body.spine[i]!);
      } catch (err) {
        throw indexed(err, i);
      }
    }
    let head: FinalizedHead;
    let covered: L1Block[];
    let at: L1Block;
    try {
      // 5.3 step 2 [L1]
      head = verifyFinalizedHead(l1, body.lc);
      // 5.3 step 3 [C]: covers(spine) returns the leg's block.
      covered = covers(head, body.spine, l1.maxSpineHeaders);
      at = blockAt(covered, leg.number);
    } catch (err) {
      throw stateOf(err);
    }
    if (!sameBytes(at.hash, leg.hash)) throw blockMismatch('hash', leg.hash, at.hash);
    if (at.number !== leg.number) throw blockMismatch('number', leg.number, at.number);
    // h_k is the leg block itself: the spine ends there (section 0), and its last element is byte-identical to Settlement.Header.
    const last = body.spine.length - 1;
    if (covered[last]!.number !== leg.number) {
      throw malformed('spine', EvidenceReason.SpineNotEndingAtBlock, body.spine.length, Number(covered[0]!.number - leg.number) + 1);
    }
    if (leg.headerRlp !== undefined && !sameBytes(body.spine[last]!, leg.headerRlp)) {
      throw blockMismatch('header', keccak_256(leg.headerRlp), covered[covered.length - 1]!.hash);
    }
    return {
      level: Level.Finalized,
      kind: KIND_NAME,
      fields: {
        finalized_slot: head.slot,
        finalized_exec_number: covered[0]!.number,
        participants: BigInt(head.participants),
        periods_crossed: head.periodsCrossed,
        headers_walked: BigInt(body.spine.length),
        anchor_period: body.lc.anchorPeriod,
      },
    };
  }
}

/** Adds the kind to a registry. It is explicit: there is no import-time registration. */
export function registerEthSepolia(reg: Registry): void {
  reg.registerKind(new EthSepoliaKind());
}
