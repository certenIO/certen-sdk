/**
 * Types and protocol constants of the Ethereum L1 finalized-head verifier (V2_SPEC_S7 sections 3.2, 4.2, 5.2): the TypeScript twin
 * of the validator's pkg/finality/ethl1/types.go. Slots, epochs and periods are bigint (uint64 in Go); byte strings are Uint8Array.
 */

/** ProfileLC is the only LC container profile. */
export const ProfileLC = 'eth-lc/1';
/** SlotsPerEpoch and EpochsPerPeriod are the mainnet/Sepolia preset values. */
export const SlotsPerEpoch = 32n;
export const EpochsPerPeriod = 256n;
/** SyncCommitteeSize is the number of seats; MinParticipantsFloor is the smallest set-bit count with 3*n >= 2*512. */
export const SyncCommitteeSize = 512;
export const MinParticipantsFloor = 342;
/** SepoliaChainID is the execution chain id whose beacon chain the shipped pins describe. */
export const SepoliaChainID = 11155111n;

/** The light-client container layout of a carried object (the LB layout byte of spec section 3.2). */
export const Layout = {
  /** valid only for the kind-1 SyncCommittee body */
  None: 0,
  /** Electra and Fulu: variable-size headers with an ExecutionPayloadHeader */
  Electra: 1,
  /** the fixed-size layout of Gloas (execution_block_hash plus an 11-node branch) */
  Gloas: 2,
} as const;
export type LayoutByte = number;

/** The layout name used in fault fields. */
export function layoutName(l: LayoutByte): string {
  if (l === Layout.Electra) return 'electra';
  if (l === Layout.Gloas) return 'gloas';
  return 'none';
}

/** One entry of the fork schedule. layout is Layout.None for the forks whose objects cannot occur in evidence. */
export interface Fork {
  name: string;
  epoch: bigint;
  /** 4 bytes */
  version: Uint8Array;
  layout: LayoutByte;
}

/** The trusted network section of the pins. */
export interface Network {
  chainId: bigint;
  /** 32 bytes */
  genesisValidatorsRoot: Uint8Array;
  forks: Fork[];
}

/** One ledger entry: a configured weak-subjectivity pin of one sync-committee period. */
export interface Anchor {
  period: bigint;
  /** 32 bytes */
  committeeRoot: Uint8Array;
  /** 32 bytes, or null when the entry has no block root */
  blockRoot: Uint8Array | null;
  wspEpochs: bigint;
}

/** The trust inputs of the L1 head verifier (the Sepolia part of spec section 4.2). */
export interface Pins {
  network: Network;
  anchors: Anchor[];
  minParticipants: number;
  maxLinks: number;
  maxSpineHeaders: number;
}

/** One layout-tagged SSZ blob (spec section 3.2). */
export interface LB {
  layout: LayoutByte;
  ssz: Uint8Array;
}

/**
 * The Ethereum L1-finality part of an evidence container (spec section 3.2). profile is byte-faithful: each character is one byte
 * (latin1), so its length is the byte length Go's len() reports and a profile that is not UTF-8 survives a decode and an encode.
 */
export interface LC {
  profile: string;
  /** 1 committee_root, 2 block_root */
  anchorKind: number;
  anchorPeriod: bigint;
  /** 32 bytes */
  anchorRoot: Uint8Array;
  anchorBody: LB;
  links: LB[];
  finalUpdate: LB;
}

/** The result of verifyFinalizedHead. The execution number is not in a Gloas LC header; covers finds it. */
export interface FinalizedHead {
  slot: bigint;
  epoch: bigint;
  beaconRoot: Uint8Array;
  execHash: Uint8Array;
  participants: number;
  periodsCrossed: bigint;
}

/** One header of a covered spine, read positionally from its raw RLP. */
export interface L1Block {
  hash: Uint8Array;
  number: bigint;
  stateRoot: Uint8Array;
  timestamp: bigint;
}

/** The fork in force at epoch: the last entry with epoch <= the given one (sort.Search over the ascending schedule); undefined for an empty schedule. */
export function forkAt(n: Network, epoch: bigint): Fork | undefined {
  let lo = 0;
  let hi = n.forks.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (n.forks[mid]!.epoch > epoch) hi = mid;
    else lo = mid + 1;
  }
  return lo === 0 ? undefined : n.forks[lo - 1]!;
}

/** The ledger entry of exactly this period. */
export function anchorFor(p: Pins, period: bigint): Anchor | undefined {
  for (const a of p.anchors) if (a.period === period) return a;
  return undefined;
}

/** The largest period in the ledger; undefined when the ledger is empty. */
export function ledgerHead(p: Pins): bigint | undefined {
  let head: bigint | undefined;
  for (let i = 0; i < p.anchors.length; i++) {
    const a = p.anchors[i]!;
    if (i === 0 || a.period > head!) head = a.period;
  }
  return head;
}
