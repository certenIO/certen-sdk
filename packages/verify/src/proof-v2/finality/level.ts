/**
 * The finality levels of PROOF_V2 S7, as pkg/finality/level.go names them. 1 included is derived and never stored; 2 l1_posted and
 * 3 finalized are the stored levels.
 */

export type Level = 0 | 1 | 2 | 3;

export const Level = {
  /** The absence of any proven level. */
  None: 0,
  /** The settlement transaction and receipt are in a block whose header is in the proof. */
  Included: 1,
  /** The block's data is posted to the chain's L1. */
  L1Posted: 2,
  /** The block is final under the chain's own consensus or rollup L1 contracts. */
  Finalized: 3,
} as const;

/** The real levels in ascending order. */
export const LEVELS: readonly Level[] = [Level.Included, Level.L1Posted, Level.Finalized];

/** The level's published name; the zero value is "none"; anything else is `invalid(n)` exactly as Go prints it. */
export function levelName(l: number): string {
  switch (l) {
    case 0:
      return 'none';
    case 1:
      return 'included';
    case 2:
      return 'l1_posted';
    case 3:
      return 'finalized';
  }
  return `invalid(${l & 0xff})`;
}

/** Whether l is one of the three real levels. */
export const isValidLevel = (l: number): l is 1 | 2 | 3 => l >= 1 && l <= 3;

/** Whether an addendum can carry l: only l1_posted (2) and finalized (3). Level 1 is derived and never stored. */
export const isStoredLevel = (l: number): l is 2 | 3 => l === 2 || l === 3;

/** The inverse of levelName for the three real levels; undefined for anything else (including "none"). */
export function parseLevel(s: string): Level | undefined {
  for (const l of LEVELS) if (levelName(l) === s) return l;
  return undefined;
}

/** A set of levels (the levels already present for a leg, in any order, R1). */
export class LevelSet {
  private constructor(private readonly bits: number) {}
  static readonly empty = new LevelSet(0);
  static of(...levels: number[]): LevelSet {
    let s: LevelSet = LevelSet.empty;
    for (const l of levels) s = s.with(l);
    return s;
  }
  has(l: number): boolean {
    return isValidLevel(l) && (this.bits & (1 << l)) !== 0;
  }
  with(l: number): LevelSet {
    return isValidLevel(l) ? new LevelSet(this.bits | (1 << l)) : this;
  }
}
