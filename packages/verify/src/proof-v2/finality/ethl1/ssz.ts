/**
 * SSZ for the Gloas light-client containers and the shared tree-hash helpers (the twin of pkg/finality/ethl1/ssz.go). Every Gloas
 * container is fixed-size, so no SSZ library is needed: a blob is valid iff its length is exactly the fixed size, and then its
 * encoding is the unique encoding of its decoding. The Electra layout (variable-size, offsets) is in electra.ts.
 */
import { sha256 } from '@noble/hashes/sha2';
import { EpochsPerPeriod, Layout, SlotsPerEpoch, SyncCommitteeSize, type LayoutByte } from './types.js';

/** slot(8) + proposer_index(8) + parent_root + state_root + body_root. */
export const BeaconBlockHeaderSize = 112;
/** The depth of EXECUTION_BLOCK_HASH_GINDEX_GLOAS (2856). */
export const GloasExecutionBranchLen = 11;
/** beacon(112) + execution_block_hash(32) + 11 * 32. */
export const LightClientHeaderSize = BeaconBlockHeaderSize + 32 + 32 * GloasExecutionBranchLen;
/** 512 * 48 + 48 (aggregate_pubkey). */
export const SyncCommitteeBytes = SyncCommitteeSize * 48 + 48;
export const gloasFinalityBranchLen = 9;
export const gloasCommitteeBranchLen = 11;
export const syncAggregateSize = SyncCommitteeSize / 8 + 96;
export const LightClientBootstrapSize = LightClientHeaderSize + SyncCommitteeBytes + 32 * gloasCommitteeBranchLen;
export const LightClientUpdateSize =
  LightClientHeaderSize + SyncCommitteeBytes + 32 * gloasCommitteeBranchLen + LightClientHeaderSize + 32 * gloasFinalityBranchLen + syncAggregateSize + 8;
export const LightClientFinalityUpdateSize = LightClientHeaderSize + LightClientHeaderSize + 32 * gloasFinalityBranchLen + syncAggregateSize + 8;

// Generalized indices (consensus-specs gloas light-client sync-protocol.md and the frozen earlier values).
export const gindexFinalizedRootGloas = 735n;
export const gindexCurrentCommitteeGloas = 2945n;
export const gindexNextCommitteeGloas = 2946n;
export const gindexExecHashGloas = 2856n;
/** EXECUTION_BLOCK_HASH_GINDEX_DENEB (the pre-Gloas header brought forward). */
export const gindexExecHashDeneb = 812n;
/** EXECUTION_BLOCK_HASH_GINDEX */
export const gindexExecHashCapella = 412n;

/** A decoded BeaconBlockHeader. */
export interface BeaconHeader {
  slot: bigint;
  proposerIndex: bigint;
  parentRoot: Uint8Array;
  stateRoot: Uint8Array;
  bodyRoot: Uint8Array;
}

const u64At = (b: Uint8Array, o: number): bigint => new DataView(b.buffer, b.byteOffset + o, 8).getBigUint64(0, true);
const copy = (b: Uint8Array, from: number, to: number): Uint8Array => Uint8Array.from(b.subarray(from, to));

export const u64le = u64At;
export const u32le = (b: Uint8Array, o: number): number => new DataView(b.buffer, b.byteOffset + o, 4).getUint32(0, true);

export function decodeBeaconHeader(b: Uint8Array): BeaconHeader {
  return {
    slot: u64At(b, 0),
    proposerIndex: u64At(b, 8),
    parentRoot: copy(b, 16, 48),
    stateRoot: copy(b, 48, 80),
    bodyRoot: copy(b, 80, 112),
  };
}

export function sha2(a: Uint8Array, b: Uint8Array): Uint8Array {
  const buf = new Uint8Array(64);
  buf.set(a.subarray(0, 32), 0);
  buf.set(b.subarray(0, 32), 32);
  return sha256(buf);
}

export const ZERO32: Uint8Array = new Uint8Array(32);

export function eq(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export function allZero(b: Uint8Array): boolean {
  for (const x of b) if (x !== 0) return false;
  return true;
}

function uintLeaf(v: bigint): Uint8Array {
  const l = new Uint8Array(32);
  new DataView(l.buffer).setBigUint64(0, v, true);
  return l;
}

/** hash_tree_root(BeaconBlockHeader): five 32-byte leaves padded with zero chunks to eight. */
export function hashTreeRootBeaconHeader(h: BeaconHeader): Uint8Array {
  const l: Uint8Array[] = [uintLeaf(h.slot), uintLeaf(h.proposerIndex), h.parentRoot, h.stateRoot, h.bodyRoot, ZERO32, ZERO32, ZERO32];
  const a = sha2(l[0]!, l[1]!);
  const b = sha2(l[2]!, l[3]!);
  const c = sha2(l[4]!, l[5]!);
  const d = sha2(l[6]!, l[7]!);
  return sha2(sha2(a, b), sha2(c, d));
}

/** hash_tree_root(Bytes48): two chunks, the second zero-padded. */
function hashTreeRootPubkey(pk: Uint8Array): Uint8Array {
  const second = new Uint8Array(32);
  second.set(pk.subarray(32, 48), 0);
  return sha2(pk.subarray(0, 32), second);
}

/** hash_tree_root(SyncCommittee) of its 24,624-byte SSZ: the root of the 512-pubkey vector mixed with the root of aggregate_pubkey. */
export function hashTreeRootSyncCommittee(b: Uint8Array): Uint8Array {
  let level: Uint8Array[] = [];
  for (let i = 0; i < SyncCommitteeSize; i++) level.push(hashTreeRootPubkey(b.subarray(i * 48, i * 48 + 48)));
  while (level.length > 1) {
    const next: Uint8Array[] = [];
    for (let i = 0; i < level.length / 2; i++) next.push(sha2(level[2 * i]!, level[2 * i + 1]!));
    level = next;
  }
  const agg = hashTreeRootPubkey(b.subarray(SyncCommitteeSize * 48, SyncCommitteeBytes));
  return sha2(level[0]!, agg);
}

export function floorLog2(x: bigint): number {
  return x.toString(2).length - 1;
}

/** The Phase 0 is_valid_merkle_branch. */
export function isValidMerkleBranch(leaf: Uint8Array, branch: Uint8Array[], depth: number, index: bigint, root: Uint8Array): boolean {
  let v = leaf;
  for (let i = 0; i < depth; i++) {
    if (((index >> BigInt(i)) & 1n) === 1n) v = sha2(branch[i]!, v);
    else v = sha2(v, branch[i]!);
  }
  return eq(v, root);
}

/**
 * The Altair is_valid_normalized_merkle_branch: the leading len(branch)-depth nodes of the branch must be zero (a header carried
 * forward from an earlier fork has a longer, zero-extended branch).
 */
export function isValidNormalizedMerkleBranch(leaf: Uint8Array, branch: Uint8Array[], gindex: bigint, root: Uint8Array): boolean {
  const depth = floorLog2(gindex);
  const index = gindex % (1n << BigInt(depth));
  const numExtra = branch.length - depth;
  if (numExtra < 0) return false;
  for (let i = 0; i < numExtra; i++) if (!eq(branch[i]!, ZERO32)) return false;
  return isValidMerkleBranch(leaf, branch.slice(numExtra), depth, index, root);
}

/**
 * A decoded LightClientHeader of either layout. shape is the layout it was parsed by. For the Gloas shape execHash is the
 * execution_block_hash field and branch has 11 nodes; for the Electra shape execHash is execution.block_hash, exec holds the whole SSZ
 * ExecutionPayloadHeader (584 fixed bytes then extra_data) and branch has 4.
 */
export interface LcHeader {
  shape: LayoutByte;
  beacon: BeaconHeader;
  execHash: Uint8Array;
  branch: Uint8Array[];
  exec: Uint8Array | null;
}

export function decodeBranch(b: Uint8Array, n: number): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let i = 0; i < n; i++) out.push(copy(b, i * 32, i * 32 + 32));
  return out;
}

export function decodeLCHeader(b: Uint8Array): LcHeader {
  return {
    shape: Layout.Gloas,
    beacon: decodeBeaconHeader(b.subarray(0, BeaconBlockHeaderSize)),
    execHash: copy(b, BeaconBlockHeaderSize, BeaconBlockHeaderSize + 32),
    branch: decodeBranch(b.subarray(BeaconBlockHeaderSize + 32, LightClientHeaderSize), GloasExecutionBranchLen),
    exec: null,
  };
}

export function branchAllZero(br: Uint8Array[]): boolean {
  for (const n of br) if (!eq(n, ZERO32)) return false;
  return true;
}

function beaconIsZero(h: BeaconHeader): boolean {
  return h.slot === 0n && h.proposerIndex === 0n && allZero(h.parentRoot) && allZero(h.stateRoot) && allZero(h.bodyRoot);
}

/** ExecutionPayloadHeader fixed size and the offset of the extra_data offset (electra.ts owns the layout; isEmpty needs both). */
const electraExecFixed = 584;
const electraExecExtraOffAt = 436;

/** LightClientHeader() with every field default: the empty finalized header of a not-yet-finalized update. */
export function isEmptyHeader(h: LcHeader): boolean {
  if (!beaconIsZero(h.beacon) || !allZero(h.execHash)) return false;
  for (const n of h.branch) if (!allZero(n)) return false;
  // LightClientHeader() has every execution field zero and an empty extra_data; its SSZ still carries the extra_data offset (584), so the
  // offset bytes are not part of the comparison (consensus-specs compares decoded values)
  if (h.shape === Layout.Electra) {
    const e = h.exec!;
    if (e.length !== electraExecFixed || !allZero(e.subarray(0, electraExecExtraOffAt)) || !allZero(e.subarray(electraExecExtraOffAt + 4))) return false;
  }
  return true;
}

/** The decoded SyncAggregate. */
export interface SyncAggregate {
  bits: Uint8Array;
  signature: Uint8Array;
}

export function decodeSyncAggregate(b: Uint8Array): SyncAggregate {
  return { bits: copy(b, 0, SyncCommitteeSize / 8), signature: copy(b, SyncCommitteeSize / 8, syncAggregateSize) };
}

export function aggregateCount(s: SyncAggregate): number {
  let n = 0;
  for (let x of s.bits) {
    while (x) {
      n += x & 1;
      x >>= 1;
    }
  }
  return n;
}

export function aggregateBit(s: SyncAggregate, i: number): boolean {
  return ((s.bits[i >> 3]! >> (i % 8)) & 1) === 1;
}

/** A decoded LightClientBootstrap. committee is 24,624 bytes aliasing the input. */
export interface BootstrapObj {
  shape: LayoutByte;
  header: LcHeader;
  committee: Uint8Array;
  committeeBranch: Uint8Array[];
}

export function decodeBootstrap(b: Uint8Array): BootstrapObj {
  return {
    shape: Layout.Gloas,
    header: decodeLCHeader(b.subarray(0, LightClientHeaderSize)),
    committee: b.subarray(LightClientHeaderSize, LightClientHeaderSize + SyncCommitteeBytes),
    committeeBranch: decodeBranch(b.subarray(LightClientHeaderSize + SyncCommitteeBytes), gloasCommitteeBranchLen),
  };
}

/** A decoded LightClientUpdate or LightClientFinalityUpdate (no next committee for the latter). */
export interface UpdateObj {
  shape: LayoutByte;
  attested: LcHeader;
  /** 24,624 bytes, null for a finality update */
  nextCommittee: Uint8Array | null;
  nextBranch: Uint8Array[];
  finalized: LcHeader;
  finalityBranch: Uint8Array[];
  aggregate: SyncAggregate;
  signatureSlot: bigint;
  hasNextContainer: boolean;
}

export function decodeUpdate(b: Uint8Array): UpdateObj {
  let o = 0;
  const attested = decodeLCHeader(b.subarray(o, o + LightClientHeaderSize));
  o += LightClientHeaderSize;
  const nextCommittee = b.subarray(o, o + SyncCommitteeBytes);
  o += SyncCommitteeBytes;
  const nextBranch = decodeBranch(b.subarray(o), gloasCommitteeBranchLen);
  o += 32 * gloasCommitteeBranchLen;
  const finalized = decodeLCHeader(b.subarray(o, o + LightClientHeaderSize));
  o += LightClientHeaderSize;
  const finalityBranch = decodeBranch(b.subarray(o), gloasFinalityBranchLen);
  o += 32 * gloasFinalityBranchLen;
  const aggregate = decodeSyncAggregate(b.subarray(o, o + syncAggregateSize));
  o += syncAggregateSize;
  const signatureSlot = u64At(b, o);
  return { shape: Layout.Gloas, attested, nextCommittee, nextBranch, finalized, finalityBranch, aggregate, signatureSlot, hasNextContainer: true };
}

export function decodeFinalityUpdate(b: Uint8Array): UpdateObj {
  let o = 0;
  const attested = decodeLCHeader(b.subarray(o, o + LightClientHeaderSize));
  o += LightClientHeaderSize;
  const finalized = decodeLCHeader(b.subarray(o, o + LightClientHeaderSize));
  o += LightClientHeaderSize;
  const finalityBranch = decodeBranch(b.subarray(o), gloasFinalityBranchLen);
  o += 32 * gloasFinalityBranchLen;
  const aggregate = decodeSyncAggregate(b.subarray(o, o + syncAggregateSize));
  o += syncAggregateSize;
  const signatureSlot = u64At(b, o);
  return { shape: Layout.Gloas, attested, nextCommittee: null, nextBranch: [], finalized, finalityBranch, aggregate, signatureSlot, hasNextContainer: false };
}

export const epochOf = (slot: bigint): bigint => slot / SlotsPerEpoch;
export const periodOf = (slot: bigint): bigint => epochOf(slot) / EpochsPerPeriod;
