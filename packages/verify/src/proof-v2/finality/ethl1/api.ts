/**
 * The exported helpers of the L1 head verifier that the vector generators and the kinds use (the twin of pkg/finality/ethl1/api.go),
 * and the conversion of the framework's parsed `eth_sepolia` pins section into this verifier's Pins.
 */
import type { AnchorPin, EthSepoliaPins } from '../pins.js';
import { pinsCorrupt, PinsReason } from '../state.js';
import { computeDomain, signingRoot } from './bls.js';
import { decodeLC } from './lccodec.js';
import { evidenceMalformed } from './fault.js';
import {
  BeaconBlockHeaderSize,
  LightClientBootstrapSize,
  LightClientFinalityUpdateSize,
  LightClientHeaderSize,
  LightClientUpdateSize,
  SyncCommitteeBytes,
  decodeBeaconHeader,

  floorLog2,
  hashTreeRootBeaconHeader,
  hashTreeRootSyncCommittee,
  sha2,
} from './ssz.js';
import { Layout, type Anchor, type Fork, type LC, type LayoutByte, type Pins } from './types.js';

/** hash_tree_root(SyncCommittee) of its 24,624-byte SSZ encoding. Any other length is a finality_evidence_malformed state. */
export function hashTreeRootSyncCommitteeChecked(b: Uint8Array): Uint8Array {
  if (b.length !== SyncCommitteeBytes) throw evidenceMalformed('sync_committee', 0, 'length', b.length, SyncCommitteeBytes);
  return hashTreeRootSyncCommittee(b);
}

/** Decodes the LC part of an evidence container under the link bound of these pins (Pins.maxLinks), so a caller cannot decode with another bound. */
export function decodeLCUnder(p: Pins, b: Uint8Array): LC {
  return decodeLC(b, p.maxLinks);
}

/** hash_tree_root(BeaconBlockHeader) of its 112-byte SSZ encoding. */
export function hashTreeRootBeaconBlockHeader(b: Uint8Array): Uint8Array {
  if (b.length !== BeaconBlockHeaderSize) throw evidenceMalformed('beacon_block_header', 0, 'length', b.length, BeaconBlockHeaderSize);
  return hashTreeRootBeaconHeader(decodeBeaconHeader(b));
}

const gloasSizes: Record<string, number> = {
  BeaconBlockHeader: BeaconBlockHeaderSize,
  LightClientHeader: LightClientHeaderSize,
  SyncCommittee: SyncCommitteeBytes,
  LightClientBootstrap: LightClientBootstrapSize,
  LightClientUpdate: LightClientUpdateSize,
  LightClientFinalityUpdate: LightClientFinalityUpdateSize,
};

/**
 * Strictly validates one SSZ blob of the Gloas layout against its fixed size. kind is one of "BeaconBlockHeader" (112),
 * "LightClientHeader" (496), "SyncCommittee" (24,624), "LightClientBootstrap" (25,472), "LightClientUpdate" (26,424) or
 * "LightClientFinalityUpdate" (1,448). Every Gloas container is fixed-size, so the length is the whole of the validation.
 */
export function validateContainer(kind: string, b: Uint8Array): void {
  const want = Object.prototype.hasOwnProperty.call(gloasSizes, kind) ? gloasSizes[kind]! : undefined;
  if (want === undefined) throw evidenceMalformed('container', 0, 'unknown_kind', 0, 0);
  if (b.length !== want) throw evidenceMalformed(kind, 0, 'length', b.length, want);
}

/** Folds a leaf up a (zero-extended) branch to the generalized index gindex and returns the root the branch commits to. */
export function rootFromNormalizedBranch(leaf: Uint8Array, branch: Uint8Array[], gindex: bigint): Uint8Array {
  const depth = floorLog2(gindex);
  const index = gindex % (1n << BigInt(depth));
  const extra = branch.length - depth;
  let v = leaf;
  for (let i = 0; i < depth; i++) {
    if (((index >> BigInt(i)) & 1n) === 1n) v = sha2(branch[extra + i]!, v);
    else v = sha2(v, branch[extra + i]!);
  }
  return v;
}

/** compute_signing_root(attested_header.beacon, compute_domain(DOMAIN_SYNC_COMMITTEE, version, genesis_validators_root)) for a 112-byte header. */
export function syncCommitteeSigningRoot(beaconHeader: Uint8Array, version: Uint8Array, gvr: Uint8Array): Uint8Array {
  return signingRoot(hashTreeRootBeaconBlockHeader(beaconHeader), computeDomain(version, gvr));
}

// ---- the framework's pins section ----

function hexBytes(s: string, n: number, what: string): Uint8Array {
  const h = s.startsWith('0x') ? s.slice(2) : s;
  if (h.length !== n * 2 || !/^[0-9a-fA-F]*$/.test(h)) throw pinsCorrupt(PinsReason.BadValue, { field: what });
  return Uint8Array.from(h.match(/../g) ?? [], (x) => parseInt(x, 16));
}

const layoutOf = (name: string | null): LayoutByte => (name === 'electra' ? Layout.Electra : name === 'gloas' ? Layout.Gloas : Layout.None);

/**
 * The L1 head verifier's Pins from the framework's parsed `eth_sepolia` section (loadPins output): the fork schedule with its layouts
 * ("electra" and "gloas"; null is Layout.None), the ledger (an empty block_root is no block root) and the bounds. `ledger` replaces
 * the section's own anchors (the twin of EthSepoliaPins.L1Pins(anchors): the ledger judges one step with a two-entry list).
 */
export function ethl1PinsFrom(e: EthSepoliaPins, ledger: readonly AnchorPin[] = e.anchors): Pins {
  const forks: Fork[] = e.forks.map((f) => ({ name: f.name, epoch: f.epoch, version: hexBytes(f.version, 4, 'version'), layout: layoutOf(f.layout) }));
  const anchors: Anchor[] = ledger.map((a) => ({
    period: a.period,
    committeeRoot: hexBytes(a.committeeRoot, 32, 'committee_root'),
    blockRoot: a.blockRoot === '' ? null : hexBytes(a.blockRoot, 32, 'block_root'),
    wspEpochs: a.wspEpochs,
  }));
  return {
    network: { chainId: e.chainId, genesisValidatorsRoot: hexBytes(e.genesisValidatorsRoot, 32, 'genesis_validators_root'), forks },
    anchors,
    minParticipants: Number(e.minParticipants),
    maxLinks: Number(e.maxLinks),
    maxSpineHeaders: Number(e.maxSpineHeaders),
  };
}

