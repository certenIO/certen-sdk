/**
 * The S7 outcome for ONE leg (the twin of pkg/finality/report.go): the pair (Settlement block, addenda) it judged, with the rules
 *
 *   R1 included is derived, never stored.          R2 levels are independent; the headline is the highest verified.
 *   R3 a broken chain voids all addenda.           R4 an absent level is finality_pending{no_evidence_in_file}.
 *   R5 not-applicable comes from the table.        R6 finalized exposes finalized_block.
 *   R7 one chain of addenda per leg (D0 is the leg binding).
 */
import { checkLegChain, type Addendum } from './addendum.js';
import { deriveIncluded, type BlockRef, type Settlement } from './evidence.js';
import { Level } from './level.js';
import { pinsIdentity, type Pins } from './pins.js';
import { Registry, defaultRegistry, type Verdict } from './registry.js';
import { readHeader } from './rlpheader.js';
import { chainSupported, kindFor } from './table.js';
import {
  Code,
  FinalityStateError,
  FinalizedBlockReason,
  asNamed,
  chainUnsupported,
  finalizedBlockUnavailable,
  newState,
  noEvidenceInFile,
} from './state.js';

/** Status of one level in a Report (R2). */
export type Status = 'verified' | 'level_not_applicable' | 'pending' | 'refused';

/**
 * One level's outcome: verified (with the Kind's Verdict), level_not_applicable (the table's reason), pending (finality_pending,
 * always with the level reached) or refused{code} (evidence present, predicate false).
 */
export interface LevelStatus {
  status: Status;
  verdict?: Verdict;
  /** the not-applicable, pending or refusal state; absent when verified */
  state?: FinalityStateError;
}

/** The leg's own block as S7 finalized it, for S8 (R6). */
export interface FinalizedBlock {
  number: bigint;
  hash: Uint8Array;
  stateRoot: Uint8Array;
}

export interface Report {
  block: BlockRef;
  /** finality_chain_unsupported when the chain is not a row of the table (R5): no S7 statement at all. */
  unsupported?: FinalityStateError;
  /** Level 1 is derived from the Settlement (R1); levels[Level.Included] mirrors it. */
  levels: Map<Level, LevelStatus>;
  /** The highest verified level (Level.None if the Settlement itself did not verify). */
  headline: Level;
  /** finality_chain_broken when the addendum chain, or the carried leg, does not verify: it voids every addendum (R3). */
  broken?: FinalityStateError;
  finalizedBlock?: FinalizedBlock;
  /** Raised when finalized is verified and the leg block still cannot be exposed: R6 is never silently omitted. */
  finalizedBlockState?: FinalityStateError;
  pinsSha256: string;
  pinsSource: string;
}

/** The status of a level with no addendum: level_not_applicable from the table (never from the file), else pending (R4), or `fallback`. */
function absentOrNA(chain: bigint, l: Level, reached: Level, fallback?: LevelStatus): LevelStatus {
  try {
    kindFor(chain, l);
  } catch (e) {
    const st = asNamed(e);
    if (st && st.code === Code.NotApplicable) return { status: 'level_not_applicable', state: st };
  }
  if (fallback) return fallback;
  return { status: 'pending', state: noEvidenceInFile(chain, reached, l) };
}

/**
 * Judges addenda against an already verified leg block b (the triple of a verified Settlement). The carried leg is compared with b
 * FIRST, then the chain is verified against D0 recomputed from b, then each addendum is judged alone. The addenda never supply D0.
 */
export function verifyLeg(reg: Registry, b: BlockRef, carried: BlockRef, adds: readonly Addendum[], p: Pins | null): Report {
  const [pinsSha256, pinsSource] = pinsIdentity(p);
  const rep: Report = { block: b, levels: new Map(), headline: Level.None, pinsSha256, pinsSource };
  if (!chainSupported(b.chain)) {
    rep.unsupported = chainUnsupported(b.chain);
    return rep;
  }
  rep.levels.set(Level.Included, { status: 'verified' });
  rep.headline = Level.Included;

  try {
    checkLegChain(b, carried, adds);
  } catch (e) {
    const st = asNamed(e);
    if (!st) throw e;
    rep.broken = st;
    for (const l of [Level.L1Posted, Level.Finalized] as const) {
      rep.levels.set(l, absentOrNA(b.chain, l, Level.Included, { status: 'refused', state: st }));
    }
    return rep;
  }
  const byLevel = new Map<number, Addendum>();
  for (const a of adds) byLevel.set(a.level, a);
  // independent judgement per level (R2); the headline is the highest verified
  for (const l of [Level.L1Posted, Level.Finalized] as const) {
    const a = byLevel.get(l);
    if (a === undefined) continue;
    try {
      const v = reg.judgeAddendum(b, a, p);
      rep.levels.set(l, { status: 'verified', verdict: v });
      if (l > rep.headline) rep.headline = l;
    } catch (e) {
      const st = asNamed(e) ?? newState(Code.VerifierFailed, { chain: b.chain, kind: a.kind, cause: e instanceof Error ? e.message : String(e) });
      rep.levels.set(l, { status: 'refused', state: st });
    }
  }
  for (const l of [Level.L1Posted, Level.Finalized] as const) {
    if (!rep.levels.has(l)) rep.levels.set(l, absentOrNA(b.chain, l, rep.headline));
  }
  if (rep.levels.get(Level.Finalized)?.status === 'verified') {
    if (b.headerRlp === undefined || b.headerRlp.length === 0) {
      rep.finalizedBlockState = finalizedBlockUnavailable(b.chain, b.number, FinalizedBlockReason.NoHeader);
    } else {
      try {
        const h = readHeader(b.headerRlp);
        rep.finalizedBlock = { number: b.number, hash: b.hash, stateRoot: h.stateRoot };
      } catch (e) {
        const hs = asNamed(e);
        const extra = hs && 'index' in hs.fields ? { index: hs.fields.index } : {};
        rep.finalizedBlockState = finalizedBlockUnavailable(b.chain, b.number, FinalizedBlockReason.HeaderUnreadable, extra);
      }
    }
  }
  return rep;
}

/**
 * The pure S7 judgement of one leg: the Settlement is verified (S6, level 1 derived, R1), the carried leg is compared with the
 * verified Settlement's triple, the chain is verified against D0 recomputed from that triple, and each addendum is judged alone.
 */
export function verifyWith(reg: Registry, chain: bigint, s: Settlement | null | undefined, carried: BlockRef, adds: readonly Addendum[], p: Pins | null): Report {
  let b: BlockRef;
  try {
    b = deriveIncluded(chain, s);
  } catch (e) {
    const st = asNamed(e);
    if (!st) throw e;
    const [pinsSha256, pinsSource] = pinsIdentity(p);
    return { block: { chain, number: 0n, hash: new Uint8Array(32) }, levels: new Map([[Level.Included, { status: 'refused', state: st }]]), headline: Level.None, pinsSha256, pinsSource };
  }
  return verifyLeg(reg, b, carried, adds, p);
}

/** verifyWith over the default registry. */
export const verify = (chain: bigint, s: Settlement | null | undefined, carried: BlockRef, adds: readonly Addendum[], p: Pins | null): Report =>
  verifyWith(defaultRegistry, chain, s, carried, adds, p);
