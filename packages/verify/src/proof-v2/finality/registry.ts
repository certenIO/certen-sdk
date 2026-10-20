/**
 * The registry of per-chain, per-level Kinds and the per-addendum judgement (the twin of pkg/finality/registry.go). Only the OFFLINE
 * half exists here: a Kind is PURE (no I/O, no clock, no randomness), and the builders (provers) are the validator's.
 */
import { decodeContainer, defaultLimits } from './codec.js';
import { sameBytes, type BlockRef } from './evidence.js';
import { levelName, type Level } from './level.js';
import { defaultProfiles, isRow, validateProfile, type ChainProfile } from './table.js';
import type { Addendum } from './addendum.js';
import type { Pins } from './pins.js';
import {
  Code,
  EvidenceReason,
  FinalityStateError,
  blockMismatch,
  chainUnsupported,
  evidenceUnrecognised,
  malformed,
  newState,
  type Fields,
} from './state.js';

/** What a Kind returns for evidence it accepted: the level proven and the fields of the "Result" of its V2_SPEC_S7 section 5 subsection. */
export interface Verdict {
  level: Level;
  kind: string;
  fields: Fields;
}

/**
 * The offline half for one (chain, level) row of the table. `verify` judges the whole CFE1 container `evidence` about the leg block b
 * against the pins and returns the verdict, or throws a named state (a FinalityStateError). The dispatcher has already checked the
 * container header against the addendum and the leg.
 */
export interface Kind {
  name(): string;
  chain(): bigint;
  level(): Level;
  verify(p: Pins | null, b: BlockRef, evidence: Uint8Array): Verdict;
}

/** The "/vN" suffix of a kind name ("v1"), the version field of finality_evidence_unrecognised. */
export function kindVersion(kind: string): string {
  const i = kind.lastIndexOf('/');
  return i >= 0 ? kind.slice(i + 1) : '';
}

/** Holds the Kinds and profiles of every chain package. Chain packages register into `defaultRegistry` from an explicit call. */
export class Registry {
  private readonly kinds = new Map<string, Kind>();
  private readonly profiles = new Map<bigint, ChainProfile>();

  /** A registry holding the chain profiles. No Kind is registered: level 1 is derived and the kinds of levels 2 and 3 are the chain packages'. */
  constructor() {
    for (const p of defaultProfiles()) this.registerProfile(p);
  }

  registerProfile(p: ChainProfile): void {
    validateProfile(p);
    if (this.profiles.has(p.chain)) throw new Error(`finality: chain ${p.chain} already has a profile`);
    this.profiles.set(p.chain, p);
  }

  /** Adds the Kind of one table row; a Kind that is not a row of the table, or a second Kind for a name, is refused. */
  registerKind(k: Kind): void {
    if (!isRow(k.chain(), k.level(), k.name())) {
      throw new Error(`finality: kind "${k.name()}" (chain ${k.chain()}, level ${levelName(k.level())}) is not a row of the V2_SPEC_S7 section 1 table`);
    }
    if (this.kinds.has(k.name())) throw new Error(`finality: kind "${k.name()}" already has a verifier`);
    this.kinds.set(k.name(), k);
  }

  /** A chain's profile, or finality_chain_unsupported{chain}. */
  profile(chain: bigint): ChainProfile {
    const p = this.profiles.get(chain);
    if (p === undefined) throw chainUnsupported(chain);
    return p;
  }

  /** The profiled chains, ascending. */
  chains(): bigint[] {
    return [...this.profiles.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  }

  kind(name: string): Kind | undefined {
    return this.kinds.get(name);
  }

  /**
   * The per-addendum judgement after verifyChain: the container decodes (bounded, strict), its header's kind, chain and level equal
   * the addendum's, it is about the leg block b (else finality_block_mismatch), a Kind is registered for it (else
   * finality_evidence_unrecognised) and that Kind accepts it at exactly the row's level. A refusal here affects no other level (R3).
   */
  judgeAddendum(b: BlockRef, a: Addendum, p: Pins | null): Verdict {
    const c = decodeContainer(a.evidence, defaultLimits());
    const h = c.header;
    for (const [part, differs] of [
      ['header.kind', h.kind !== a.kind],
      ['header.chain', h.chain !== a.chain],
      ['header.level', h.level !== a.level],
    ] as const) {
      if (differs) throw malformed(part, EvidenceReason.DiffersFromAddendum, 0, 0);
    }
    if (h.chain !== b.chain) throw blockMismatch('chain', b.chain, h.chain);
    if (h.blockNumber !== b.number) throw blockMismatch('blockNumber', b.number, h.blockNumber);
    if (!sameBytes(h.blockHash, b.hash)) throw blockMismatch('blockHash', b.hash, h.blockHash);
    const k = this.kind(a.kind);
    if (k === undefined) throw evidenceUnrecognised(a.kind, kindVersion(a.kind));
    let v: Verdict;
    try {
      v = k.verify(p, b, a.evidence);
    } catch (e) {
      if (e instanceof FinalityStateError) throw e;
      throw newState(Code.VerifierFailed, { chain: a.chain, kind: a.kind, cause: e instanceof Error ? e.message : String(e) });
    }
    if (v.level !== k.level() || v.level !== a.level) {
      throw newState(Code.VerifierFailed, {
        chain: a.chain,
        kind: a.kind,
        cause: `the kind returned level ${levelName(v.level)} for a ${levelName(k.level())} row`,
      });
    }
    return v.kind === '' ? { ...v, kind: a.kind } : v;
  }
}

/** The registry the offline verifier uses. */
export const defaultRegistry = new Registry();

