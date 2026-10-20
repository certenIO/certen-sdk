/**
 * The Electra layout (V2_SPEC_S7 section 3.2): Electra and Fulu light-client objects (the twin of pkg/finality/ethl1/electra.go). Their
 * header is the Deneb LightClientHeader
 *
 *     { beacon: BeaconBlockHeader (112), execution: ExecutionPayloadHeader (variable), execution_branch: Vector[Bytes32, 4] }
 *
 * so every container holding one is variable-size and is decoded through SSZ offsets, strictly: each offset is the exact value the
 * fixed parts imply, each variable part lies inside the blob, and the blob ends where its last part ends. The only variable-length
 * datum is ExecutionPayloadHeader.extra_data (ByteList[32]). Electra changed only the three BeaconState generalized indices
 * (consensus-specs electra/light-client/sync-protocol.md): finalized root 169, current committee 86, next committee 87; the execution
 * payload sits at gindex 25 of the BeaconBlockBody. Every decoder throws a finality_evidence_malformed state.
 */
import { evidenceMalformed } from './fault.js';
import {
  BeaconBlockHeaderSize,
  SyncCommitteeBytes,
  decodeBeaconHeader,
  decodeBranch,
  decodeSyncAggregate,
  gindexCurrentCommitteeGloas,
  gindexFinalizedRootGloas,
  gindexNextCommitteeGloas,
  sha2,
  syncAggregateSize,
  u32le,
  u64le,
  type BootstrapObj,
  type LcHeader,
  type UpdateObj,
} from './ssz.js';
import { Layout, type LayoutByte } from './types.js';

// ExecutionPayloadHeader (Deneb, Electra, Fulu: 17 fields): fixed part 584 bytes, extra_data offset at 436.
export const electraExecFixed = 584;
export const electraExecExtraOffAt = 436;
export const electraMaxExtraData = 32;
// Offsets of the fields the verifier reads inside the fixed part.
const execOffParentHash = 0;
const execOffFeeRecip = 32;
const execOffStateRoot = 52;
const execOffReceipts = 84;
const execOffLogsBloom = 116;
const execOffPrevRandao = 372;
const execOffNumber = 404;
const execOffGasLimit = 412;
const execOffGasUsed = 420;
const execOffTimestamp = 428;
const execOffBaseFee = 440;
const execOffBlockHash = 472;
const execOffTxRoot = 504;
const execOffWithdrawal = 536;
const execOffBlobGas = 568;
const execOffExcessBlob = 576;

export const electraExecBranchLen = 4;
/** beacon(112) + offset(4) + execution_branch(4 x 32) */
export const electraHeaderFixed = BeaconBlockHeaderSize + 4 + 32 * electraExecBranchLen; // 244
export const electraHeaderMin = electraHeaderFixed + electraExecFixed; // 828
export const electraHeaderMax = electraHeaderMin + electraMaxExtraData; // 860
export const electraFinalityBranchLen = 7; // floorlog2(169)
export const electraCommitteeBranchLen = 6; // floorlog2(86) = floorlog2(87)

export const electraBootstrapFixed = 4 + SyncCommitteeBytes + 32 * electraCommitteeBranchLen; // 24,820
export const electraUpdateFixed = 4 + SyncCommitteeBytes + 32 * electraCommitteeBranchLen + 4 + 32 * electraFinalityBranchLen + syncAggregateSize + 8;
export const electraFinalityUpdateFixed = 4 + 4 + 32 * electraFinalityBranchLen + syncAggregateSize + 8;

// Minimum sizes of the electra layout (two minimum headers plus the fixed part), spec section 3.2 (e).
export const electraMinBootstrap = electraBootstrapFixed + electraHeaderMin;
export const electraMinUpdate = electraUpdateFixed + 2 * electraHeaderMin;
export const electraMinFinalityUpdate = electraFinalityUpdateFixed + 2 * electraHeaderMin;

// Generalized indices of the Electra and Fulu forks.
export const gindexFinalizedRootElectra = 169n;
export const gindexCurrentCommitteeElectra = 86n;
export const gindexNextCommitteeElectra = 87n;
export const gindexExecPayloadInBody = 25n;

/** The BeaconState generalized indices of a layout's light-client branches. */
export interface Gindices {
  finalized: bigint;
  current: bigint;
  next: bigint;
}

export function gindicesOf(l: LayoutByte): Gindices {
  if (l === Layout.Electra) {
    return { finalized: gindexFinalizedRootElectra, current: gindexCurrentCommitteeElectra, next: gindexNextCommitteeElectra };
  }
  return { finalized: gindexFinalizedRootGloas, current: gindexCurrentCommitteeGloas, next: gindexNextCommitteeGloas };
}

/** Strictly decodes one SSZ LightClientHeader of the electra layout (the whole of b). */
export function decodeElectraHeader(b: Uint8Array, part: string, index: number): LcHeader {
  if (b.length < electraHeaderMin || b.length > electraHeaderMax) throw evidenceMalformed(part, index, 'header_length', b.length, electraHeaderMin);
  const execOff = u32le(b, BeaconBlockHeaderSize);
  if (execOff !== electraHeaderFixed) throw evidenceMalformed(part, index, 'execution_offset', execOff, electraHeaderFixed);
  const exec = b.subarray(electraHeaderFixed);
  const extraOff = u32le(exec, electraExecExtraOffAt);
  if (extraOff !== electraExecFixed) throw evidenceMalformed(part, index, 'extra_data_offset', extraOff, electraExecFixed);
  const n = exec.length - electraExecFixed;
  if (n > electraMaxExtraData) throw evidenceMalformed(part, index, 'extra_data_length', n, electraMaxExtraData);
  return {
    shape: Layout.Electra,
    beacon: decodeBeaconHeader(b.subarray(0, BeaconBlockHeaderSize)),
    execHash: Uint8Array.from(exec.subarray(execOffBlockHash, execOffBlockHash + 32)),
    branch: decodeBranch(b.subarray(BeaconBlockHeaderSize + 4, electraHeaderFixed), electraExecBranchLen),
    exec,
  };
}

function chunk(src: Uint8Array, from: number, n: number): Uint8Array {
  const c = new Uint8Array(32);
  c.set(src.subarray(from, from + n), 0);
  return c;
}

function merkleize(level: Uint8Array[]): Uint8Array {
  while (level.length > 1) {
    const next: Uint8Array[] = [];
    for (let i = 0; i < level.length / 2; i++) next.push(sha2(level[2 * i]!, level[2 * i + 1]!));
    level = next;
  }
  return level[0]!;
}

/**
 * hash_tree_root(ExecutionPayloadHeader) for the 17-field Deneb/Electra/Fulu container: seventeen leaves zero-padded to thirty-two.
 * logs_bloom (ByteVector[256]) merkleizes as eight chunks; extra_data (ByteList[32]) as one chunk mixed with its length; the uint64
 * and uint256 fields are their little-endian bytes zero-padded to a chunk.
 */
export function executionHeaderRoot(e: Uint8Array): Uint8Array {
  const leaf: Uint8Array[] = [];
  for (let i = 0; i < 32; i++) leaf.push(new Uint8Array(32));
  leaf[0] = chunk(e, execOffParentHash, 32);
  leaf[1] = chunk(e, execOffFeeRecip, 20);
  leaf[2] = chunk(e, execOffStateRoot, 32);
  leaf[3] = chunk(e, execOffReceipts, 32);
  const bloom: Uint8Array[] = [];
  for (let i = 0; i < 8; i++) bloom.push(chunk(e, execOffLogsBloom + 32 * i, 32));
  leaf[4] = merkleize(bloom);
  leaf[5] = chunk(e, execOffPrevRandao, 32);
  leaf[6] = chunk(e, execOffNumber, 8);
  leaf[7] = chunk(e, execOffGasLimit, 8);
  leaf[8] = chunk(e, execOffGasUsed, 8);
  leaf[9] = chunk(e, execOffTimestamp, 8);
  const extra = e.subarray(electraExecFixed);
  const length = new Uint8Array(32);
  new DataView(length.buffer).setBigUint64(0, BigInt(extra.length), true);
  leaf[10] = sha2(chunk(extra, 0, extra.length), length);
  leaf[11] = chunk(e, execOffBaseFee, 32);
  leaf[12] = chunk(e, execOffBlockHash, 32);
  leaf[13] = chunk(e, execOffTxRoot, 32);
  leaf[14] = chunk(e, execOffWithdrawal, 32);
  leaf[15] = chunk(e, execOffBlobGas, 8);
  leaf[16] = chunk(e, execOffExcessBlob, 8);
  return merkleize(leaf);
}

/**
 * Strictly decodes a LightClientBootstrap of the electra layout:
 * offset(header) || current_sync_committee (24,624) || current_sync_committee_branch (6 nodes) || header.
 */
export function decodeElectraBootstrap(b: Uint8Array): BootstrapObj {
  if (b.length < electraMinBootstrap) throw evidenceMalformed('anchor_body', 0, 'length', b.length, electraMinBootstrap);
  const off = u32le(b, 0);
  if (off !== electraBootstrapFixed) throw evidenceMalformed('anchor_body', 0, 'header_offset', off, electraBootstrapFixed);
  const header = decodeElectraHeader(b.subarray(electraBootstrapFixed), 'anchor_body', 0);
  return {
    shape: Layout.Electra,
    header,
    committee: b.subarray(4, 4 + SyncCommitteeBytes),
    committeeBranch: decodeBranch(b.subarray(4 + SyncCommitteeBytes, electraBootstrapFixed), electraCommitteeBranchLen),
  };
}

/**
 * Strictly decodes a LightClientUpdate of the electra layout:
 * offset(attested) || next_sync_committee || next_sync_committee_branch (6) || offset(finalized) || finality_branch (7) ||
 * sync_aggregate (160) || signature_slot (8) || attested_header || finalized_header.
 */
export function decodeElectraUpdate(b: Uint8Array, index: number): UpdateObj {
  if (b.length < electraMinUpdate) throw evidenceMalformed('link', index, 'length', b.length, electraMinUpdate);
  const finOffAt = 4 + SyncCommitteeBytes + 32 * electraCommitteeBranchLen;
  const attOff = u32le(b, 0);
  if (attOff !== electraUpdateFixed) throw evidenceMalformed('link', index, 'attested_offset', attOff, electraUpdateFixed);
  const fin = u32le(b, finOffAt);
  if (fin < electraUpdateFixed + electraHeaderMin || fin > electraUpdateFixed + electraHeaderMax || fin > b.length) {
    throw evidenceMalformed('link', index, 'finalized_offset', fin, b.length);
  }
  const attested = decodeElectraHeader(b.subarray(electraUpdateFixed, fin), 'link', index);
  const finalized = decodeElectraHeader(b.subarray(fin), 'link', index);
  let o = 4;
  const nextCommittee = b.subarray(o, o + SyncCommitteeBytes);
  o += SyncCommitteeBytes;
  const nextBranch = decodeBranch(b.subarray(o, o + 32 * electraCommitteeBranchLen), electraCommitteeBranchLen);
  o += 32 * electraCommitteeBranchLen + 4;
  const finalityBranch = decodeBranch(b.subarray(o, o + 32 * electraFinalityBranchLen), electraFinalityBranchLen);
  o += 32 * electraFinalityBranchLen;
  const aggregate = decodeSyncAggregate(b.subarray(o, o + syncAggregateSize));
  o += syncAggregateSize;
  const signatureSlot = u64le(b, o);
  return { shape: Layout.Electra, attested, nextCommittee, nextBranch, finalized, finalityBranch, aggregate, signatureSlot, hasNextContainer: true };
}

/**
 * Strictly decodes a LightClientFinalityUpdate of the electra layout:
 * offset(attested) || offset(finalized) || finality_branch (7) || sync_aggregate || signature_slot || attested || finalized.
 */
export function decodeElectraFinalityUpdate(b: Uint8Array): UpdateObj {
  if (b.length < electraMinFinalityUpdate) throw evidenceMalformed('final_update', 0, 'length', b.length, electraMinFinalityUpdate);
  const attOff = u32le(b, 0);
  if (attOff !== electraFinalityUpdateFixed) throw evidenceMalformed('final_update', 0, 'attested_offset', attOff, electraFinalityUpdateFixed);
  const fin = u32le(b, 4);
  if (fin < electraFinalityUpdateFixed + electraHeaderMin || fin > electraFinalityUpdateFixed + electraHeaderMax || fin > b.length) {
    throw evidenceMalformed('final_update', 0, 'finalized_offset', fin, b.length);
  }
  const attested = decodeElectraHeader(b.subarray(electraFinalityUpdateFixed, fin), 'final_update', 0);
  const finalized = decodeElectraHeader(b.subarray(fin), 'final_update', 0);
  let o = 8;
  const finalityBranch = decodeBranch(b.subarray(o, o + 32 * electraFinalityBranchLen), electraFinalityBranchLen);
  o += 32 * electraFinalityBranchLen;
  const aggregate = decodeSyncAggregate(b.subarray(o, o + syncAggregateSize));
  o += syncAggregateSize;
  const signatureSlot = u64le(b, o);
  return { shape: Layout.Electra, attested, nextCommittee: null, nextBranch: [], finalized, finalityBranch, aggregate, signatureSlot, hasNextContainer: false };
}
