/**
 * The (chain, level, kind) table of V2_SPEC_S7 section 1 as code (the twin of pkg/finality/table.go and profile.go). A chain id that
 * is not a row has no S7 statement at all (finality_chain_unsupported, R5); a level a chain does not offer is level_not_applicable
 * with the chain's published reason (never taken from a file); level 1 (included) is derived and has no kind.
 */
import { EvidenceReason, FinalityStateError, NotApplicableReason, chainUnsupported, malformed, notApplicableState } from './state.js';
import { Level, isStoredLevel } from './level.js';

export const ChainSepolia = 11155111n;
export const ChainBaseSepolia = 84532n;
export const ChainArbitrumSepolia = 421614n;
export const ChainAdiri = 2017n;

/** One row of the table: the evidence kind that proves a stored level on a chain. */
export interface KindRow {
  chain: bigint;
  level: Level;
  kind: string;
}

const kindTable: readonly KindRow[] = [
  { chain: ChainSepolia, level: Level.Finalized, kind: 'eth-sepolia/finalized/v1' },
  { chain: ChainBaseSepolia, level: Level.L1Posted, kind: 'base-sepolia/l1_posted/v1' },
  { chain: ChainBaseSepolia, level: Level.Finalized, kind: 'base-sepolia/finalized/v1' },
  { chain: ChainArbitrumSepolia, level: Level.L1Posted, kind: 'arb-sepolia/l1_posted/v1' },
  { chain: ChainArbitrumSepolia, level: Level.Finalized, kind: 'arb-sepolia/finalized/v1' },
  { chain: ChainAdiri, level: Level.Finalized, kind: 'adiri/finalized/v1' },
];

/** The cells of the table that are not kinds. */
const notApplicableTable = new Map<bigint, Map<number, string>>([
  [ChainSepolia, new Map([[Level.L1Posted, NotApplicableReason.ChainIsL1]])],
  [ChainAdiri, new Map([[Level.L1Posted, NotApplicableReason.NoL1Settlement]])],
]);

/** A copy of the table. */
export const kindRows = (): KindRow[] => kindTable.map((r) => ({ ...r }));

/** Whether chain is a row of the table. */
export const chainSupported = (chain: bigint): boolean => kindTable.some((r) => r.chain === chain);

/** Whether (chain, level, kind) is a row of the table. */
export const isRow = (chain: bigint, level: number, kind: string): boolean =>
  kindTable.some((r) => r.chain === chain && r.level === level && r.kind === kind);

/**
 * What the table says about a stored level on a chain: its kind, or the named state that explains why there is none:
 * finality_chain_unsupported{chain} for a chain that is not a row, level_not_applicable{chain, level, reason} for a level the chain
 * does not have (l1_posted on Sepolia and Adiri). Level 1 (included) is derived and has no kind. Returns the kind or throws.
 */
export function kindFor(chain: bigint, level: number): string {
  if (!chainSupported(chain)) throw chainUnsupported(chain);
  if (!isStoredLevel(level)) throw malformed('level', EvidenceReason.LevelNotStored, level, 2);
  for (const r of kindTable) if (r.chain === chain && r.level === level) return r.kind;
  throw notApplicableState(chain, level, notApplicableTable.get(chain)?.get(level) ?? '');
}

/**
 * For every level 1..3 of a supported chain: '' for a derived level (1) or one that is not applicable, else the kind (2, 3), so a
 * report can name each level without reading the file.
 */
export function levelAvailability(chain: bigint): Map<Level, string> {
  if (!chainSupported(chain)) throw chainUnsupported(chain);
  const out = new Map<Level, string>([[Level.Included, '']]);
  for (const l of [Level.L1Posted, Level.Finalized] as const) {
    try {
      out.set(l, kindFor(chain, l));
    } catch (e) {
      if (!(e instanceof FinalityStateError)) throw e;
      out.set(l, '');
    }
  }
  return out;
}

/** Which levels a chain offers and, for each it does not, why not (profile.go). */
export interface ChainProfile {
  chain: bigint;
  name: string;
  /** Levels the chain offers, ascending. The last is the chain's top level. */
  levels: readonly Level[];
  /** Each level the chain does not offer, with the published reason. */
  notApplicable: ReadonlyMap<Level, string>;
}

/** The profiles of the four live chains. */
export function defaultProfiles(): ChainProfile[] {
  return [
    {
      chain: ChainSepolia,
      name: 'ethereum-sepolia',
      levels: [Level.Included, Level.Finalized],
      notApplicable: new Map([[Level.L1Posted, NotApplicableReason.ChainIsL1]]),
    },
    {
      chain: ChainBaseSepolia,
      name: 'base-sepolia',
      levels: [Level.Included, Level.L1Posted, Level.Finalized],
      notApplicable: new Map(),
    },
    {
      chain: ChainArbitrumSepolia,
      name: 'arbitrum-sepolia',
      levels: [Level.Included, Level.L1Posted, Level.Finalized],
      notApplicable: new Map(),
    },
    {
      chain: ChainAdiri,
      name: 'telcoin-adiri',
      levels: [Level.Included, Level.Finalized],
      notApplicable: new Map([[Level.L1Posted, NotApplicableReason.NoL1Settlement]]),
    },
  ];
}

/** The chain's highest level. */
export const profileTop = (p: ChainProfile): Level => p.levels[p.levels.length - 1]!;

/** The lowest offered level above l, or Level.None when l is the top. */
export function profileNext(p: ChainProfile, l: number): Level {
  for (const o of p.levels) if (o > l) return o;
  return Level.None;
}

/** The named non-level for a level the chain does not offer, if it is one. */
export function profileNotApplicable(p: ChainProfile, l: Level): FinalityStateError | undefined {
  const reason = p.notApplicable.get(l);
  return reason === undefined ? undefined : notApplicableState(p.chain, l, reason);
}

/** Validates a profile: levels ascend and are real, and every level is exactly one of offered or not applicable. */
export function validateProfile(p: ChainProfile): void {
  if (p.chain === 0n || p.levels.length === 0) throw new Error('finality: a profile needs a chain and at least one level');
  let prev: number = Level.None;
  for (const l of p.levels) {
    if (l < 1 || l > 3 || l <= prev) throw new Error(`finality: chain ${p.chain} levels must ascend and be real levels`);
    prev = l;
  }
  for (const l of [Level.Included, Level.L1Posted, Level.Finalized] as const) {
    const offered = p.levels.includes(l);
    const na = p.notApplicable.has(l);
    if (offered === na) throw new Error(`finality: chain ${p.chain} level ${l} must be exactly one of offered or not applicable`);
  }
}
