/**
 * VerifyFinalizedHead (V2_SPEC_S7 section 5.2 steps 1-4; the twin of pkg/finality/ethl1/verify.go): it establishes, from the pins and
 * the LC part alone, a finalized beacon head and its finalized execution block hash. It throws a named state (FinalityStateError) for
 * every other outcome and never a weaker answer. current_slot is each update's own signature_slot;
 * process_light_client_store_force_update is never called.
 */
import { Committee, KeyCache, computeDomain, fastAggregateVerify, signingRoot } from './bls.js';
import {
  decodeElectraBootstrap,
  decodeElectraFinalityUpdate,
  decodeElectraUpdate,
  executionHeaderRoot,
  gindexExecPayloadInBody,
  gindicesOf,
} from './electra.js';
import {
  bootstrapInvalid,
  evidenceMalformed,
  evidenceTooLarge,
  forkUnsupported,
  ledgerBehind,
  linkInvalid,
  networkMismatch,
  participationInsufficient,
  periodGap,
  pinMismatch,
  pinUnknown,
  pinWindow,
  signatureInvalid,
} from './fault.js';
import {
  LightClientBootstrapSize,
  SyncCommitteeBytes,
  LightClientFinalityUpdateSize,
  LightClientUpdateSize,
  aggregateCount,
  branchAllZero,
  decodeBootstrap,
  decodeFinalityUpdate,
  decodeUpdate,
  eq,
  epochOf,
  floorLog2,
  gindexExecHashDeneb,
  gindexExecHashGloas,
  hashTreeRootBeaconHeader,
  isEmptyHeader,
  isValidMerkleBranch,
  isValidNormalizedMerkleBranch,
  periodOf,
  type BootstrapObj,
  type LcHeader,
  type UpdateObj,
} from './ssz.js';
import {
  EpochsPerPeriod,
  Layout,
  MinParticipantsFloor,
  ProfileLC,
  SepoliaChainID,
  SlotsPerEpoch,
  SyncCommitteeSize,
  anchorFor,
  forkAt,
  layoutName,
  ledgerHead,
  type Anchor,
  type FinalizedHead,
  type LB,
  type LC,
  type LayoutByte,
  type Pins,
} from './types.js';

/** The epoch whose fork version signs an update: epoch(saturating_sub(signature_slot, 1)) (spec 5.2 step 3). */
export function signingDomainEpoch(signatureSlot: bigint): bigint {
  return signatureSlot === 0n ? 0n : epochOf(signatureSlot - 1n);
}

/** Throws finality_network_mismatch unless the pins describe the chain the caller is judging. */
export function checkNetwork(p: Pins, chainId: bigint): void {
  if (p.network.chainId !== chainId) throw networkMismatch(chainId, p.network.chainId);
}

/** Options of a verification: a key cache to share with other verifications (default: a fresh one per call). */
export interface VerifyOptions {
  keyCache?: KeyCache;
}

/**
 * The checks of spec section 5.2 for one LC part under the pins. The signing-domain epoch is epoch(saturating_sub(signature_slot, 1));
 * the participation floor (342 of 512) applies to EVERY update including the last.
 */
export function verifyFinalizedHead(p: Pins, lc: LC, opts: VerifyOptions = {}): FinalizedHead {
  checkNetwork(p, SepoliaChainID);
  const cache = opts.keyCache ?? new KeyCache();
  const w = new Walker(p, cache);

  // Step 1: profile, bounds, shapes, forks.
  if (lc.profile !== ProfileLC) throw evidenceMalformed('profile', 0, 'unsupported_profile', lc.profile.length, ProfileLC.length);
  if (lc.links.length > p.maxLinks) throw evidenceTooLarge('links', lc.links.length, p.maxLinks);
  if (lc.anchorKind !== 1 && lc.anchorKind !== 2) throw evidenceMalformed('anchor_kind', 0, 'unknown_kind', lc.anchorKind, 2);

  let boot: BootstrapObj | undefined;
  let committeeRaw: Uint8Array | undefined;
  if (lc.anchorKind === 1) {
    if (lc.anchorBody.layout !== Layout.None) throw evidenceMalformed('anchor_body', 0, 'layout_byte_not_zero', lc.anchorBody.layout, 0);
    if (lc.anchorBody.ssz.length !== SyncCommitteeBytes) throw evidenceMalformed('anchor_body', 0, 'length', lc.anchorBody.ssz.length, SyncCommitteeBytes);
    committeeRaw = lc.anchorBody.ssz;
  } else {
    boot = w.parseBootstrap(lc.anchorBody);
    w.checkForkOfSlot(boot.header.beacon.slot, boot.shape);
  }
  const links: UpdateObj[] = [];
  lc.links.forEach((lb, i) => {
    const u = w.parseUpdate(i, lb);
    w.checkForkOfSlot(u.attested.beacon.slot, u.shape);
    links.push(u);
  });
  const final = w.parseFinalityUpdate(lc.finalUpdate);
  w.checkForkOfSlot(final.attested.beacon.slot, final.shape);

  // Step 2: the anchor.
  const a = anchorFor(p, lc.anchorPeriod);
  if (a === undefined) {
    const head = ledgerHead(p);
    if (head !== undefined && lc.anchorPeriod > head) throw ledgerBehind(lc.anchorPeriod, head);
    throw pinUnknown(lc.anchorKind, lc.anchorPeriod, lc.anchorRoot);
  }
  w.anchor = a;
  if (lc.anchorKind === 1) {
    const c = new Committee(committeeRaw!, cache);
    if (!eq(c.root, a.committeeRoot)) throw pinMismatch(lc.anchorPeriod, a.committeeRoot, c.root);
    if (!eq(lc.anchorRoot, a.committeeRoot)) throw pinMismatch(lc.anchorPeriod, a.committeeRoot, lc.anchorRoot);
    w.finSlot = lc.anchorPeriod * EpochsPerPeriod * SlotsPerEpoch;
    w.cur = c;
  } else {
    const b = boot!;
    if (a.blockRoot === null) throw pinUnknown(lc.anchorKind, lc.anchorPeriod, lc.anchorRoot);
    if (!eq(lc.anchorRoot, a.blockRoot)) throw pinMismatch(lc.anchorPeriod, a.blockRoot, lc.anchorRoot);
    const slot = b.header.beacon.slot;
    if (periodOf(slot) !== lc.anchorPeriod) throw bootstrapInvalid('anchor_period', slot);
    if (!w.headerValid(b.header)) throw bootstrapInvalid('header_exec_branch', slot);
    const root = hashTreeRootBeaconHeader(b.header.beacon);
    if (!eq(root, a.blockRoot)) throw pinMismatch(lc.anchorPeriod, a.blockRoot, root);
    const c = new Committee(b.committee, cache);
    if (!isValidNormalizedMerkleBranch(c.root, b.committeeBranch, gindicesOf(b.shape).current, b.header.beacon.stateRoot)) {
      throw bootstrapInvalid('committee_branch', slot);
    }
    if (!eq(c.root, a.committeeRoot)) throw pinMismatch(lc.anchorPeriod, a.committeeRoot, c.root);
    w.finSlot = slot;
    w.cur = c;
  }

  // Step 3: every link, then the final update.
  for (let i = 0; i < links.length; i++) w.update(i, links[i]!, false);
  w.update(links.length, final, true);

  // Step 4: the result.
  return {
    slot: final.finalized.beacon.slot,
    epoch: epochOf(final.finalized.beacon.slot),
    beaconRoot: hashTreeRootBeaconHeader(final.finalized.beacon),
    execHash: final.finalized.execHash,
    participants: aggregateCount(final.aggregate),
    periodsCrossed: periodOf(final.signatureSlot) - lc.anchorPeriod,
  };
}


/** Validates the layout byte of a carried object. */
function layoutByte(part: string, index: number, lb: LB): void {
  switch (lb.layout) {
    case Layout.Gloas:
    case Layout.Electra:
      return;
    case Layout.None:
      throw evidenceMalformed(part, index, 'layout_byte_zero', 0, 1);
  }
  throw evidenceMalformed(part, index, 'layout_byte_unknown', lb.layout, 2);
}

class Walker {
  anchor!: Anchor;
  finSlot = 0n;
  cur!: Committee;
  /** undefined while unknown */
  next: Committee | undefined;
  readonly gvr: Uint8Array;

  constructor(
    readonly p: Pins,
    readonly cache: KeyCache,
  ) {
    this.gvr = p.network.genesisValidatorsRoot;
  }

  parseBootstrap(lb: LB): BootstrapObj {
    layoutByte('anchor_body', 0, lb);
    if (lb.layout === Layout.Electra) return decodeElectraBootstrap(lb.ssz);
    if (lb.ssz.length !== LightClientBootstrapSize) throw evidenceMalformed('anchor_body', 0, 'length', lb.ssz.length, LightClientBootstrapSize);
    return decodeBootstrap(lb.ssz);
  }

  parseUpdate(index: number, lb: LB): UpdateObj {
    layoutByte('link', index, lb);
    if (lb.layout === Layout.Electra) return decodeElectraUpdate(lb.ssz, index);
    if (lb.ssz.length !== LightClientUpdateSize) throw evidenceMalformed('link', index, 'length', lb.ssz.length, LightClientUpdateSize);
    return decodeUpdate(lb.ssz);
  }

  parseFinalityUpdate(lb: LB): UpdateObj {
    layoutByte('final_update', 0, lb);
    if (lb.layout === Layout.Electra) return decodeElectraFinalityUpdate(lb.ssz);
    if (lb.ssz.length !== LightClientFinalityUpdateSize) throw evidenceMalformed('final_update', 0, 'length', lb.ssz.length, LightClientFinalityUpdateSize);
    return decodeFinalityUpdate(lb.ssz);
  }

  /** Requires the fork at the slot's epoch to carry the layout the object was parsed by (spec 3.2 b). */
  checkForkOfSlot(slot: bigint, layout: LayoutByte): void {
    const f = forkAt(this.p.network, epochOf(slot));
    if (f === undefined || f.layout !== layout) throw forkUnsupported(slot, epochOf(slot), layoutName(layout));
  }

  /**
   * is_valid_light_client_header keyed on the fork of the header's OWN slot (spec 3.2 c). An electra-shaped header is hashed as
   * ExecutionPayloadHeader and its 4-node branch is checked at gindex 25 of the body, valid only in a fork of the electra layout. A
   * Gloas-shaped header is checked at gindex 2856 from the Gloas fork on, and at the Deneb gindex 812 over a zero-extended branch (as
   * upgrade_lc_header_to_gloas builds it) for an Electra or Fulu header carried forward. A fork with no layout, and any shape/fork
   * combination the specification has no rule for, is finality_fork_unsupported.
   */
  headerValid(h: LcHeader): boolean {
    const slot = h.beacon.slot;
    const f = forkAt(this.p.network, epochOf(slot));
    if (f === undefined) throw forkUnsupported(slot, epochOf(slot), layoutName(h.shape));
    if (h.shape === Layout.Electra) {
      if (f.layout !== Layout.Electra) throw forkUnsupported(slot, epochOf(slot), layoutName(h.shape));
      const depth = floorLog2(gindexExecPayloadInBody);
      return isValidMerkleBranch(executionHeaderRoot(h.exec!), h.branch, depth, gindexExecPayloadInBody % (1n << BigInt(depth)), h.beacon.bodyRoot);
    }
    let g: bigint;
    switch (f.layout) {
      case Layout.Gloas:
        g = gindexExecHashGloas;
        break;
      case Layout.Electra:
        g = gindexExecHashDeneb;
        break;
      default:
        throw forkUnsupported(slot, epochOf(slot), layoutName(h.shape));
    }
    return isValidNormalizedMerkleBranch(h.execHash, h.branch, g, h.beacon.bodyRoot);
  }

  enforce(label: bigint, root: Uint8Array): void {
    const a = anchorFor(this.p, label);
    if (a !== undefined && !eq(a.committeeRoot, root)) throw pinMismatch(label, a.committeeRoot, root);
  }

  /**
   * validate_light_client_update followed by the window rule and, for a link, apply_light_client_update, with current_slot := the
   * update's own signature_slot. idx is the link's index; the final update has idx == len(links).
   */
  update(idx: number, u: UpdateObj, isFinal: boolean): void {
    const as = u.attested.beacon.slot;
    const fs = u.finalized.beacon.slot;
    const ss = u.signatureSlot;
    const sigPeriod = periodOf(ss);
    const li = (check: string) => linkInvalid(idx, check, as, ss, sigPeriod);
    const gi = gindicesOf(u.shape);

    // participation: 3n >= 2*512 (342) on every update, the final one included.
    const n = aggregateCount(u.aggregate);
    if (n * 3 < SyncCommitteeSize * 2 || n < this.p.minParticipants) throw participationInsufficient(idx, n, MinParticipantsFloor, SyncCommitteeSize);

    if (!this.headerValid(u.attested)) throw li('attested_header_exec_branch');
    if (!(ss > as && as >= fs)) throw li('slot_order'); // current_slot >= signature_slot holds by construction (current_slot := signature_slot)
    const storePeriod = periodOf(this.finSlot);
    if (this.next !== undefined) {
      if (sigPeriod !== storePeriod && sigPeriod !== storePeriod + 1n) {
        if (isFinal) throw periodGap(sigPeriod, storePeriod);
        throw li('period_skip');
      }
    } else if (sigPeriod !== storePeriod) {
      if (isFinal) throw periodGap(sigPeriod, storePeriod);
      throw li('period_skip');
    }
    const attestedPeriod = periodOf(as);
    const isSyncUpdate = !isFinal && !branchAllZero(u.nextBranch);
    const hasNextCommittee = this.next === undefined && isSyncUpdate && attestedPeriod === storePeriod;
    if (!(as > this.finSlot || hasNextCommittee)) throw li('not_relevant');

    // finality
    if (branchAllZero(u.finalityBranch)) throw li('not_finality');
    // A final update must establish a finalized execution head: a finalized slot of 0 (the empty finalized header, whose zero root a
    // zero branch of the right shape can prove) establishes none, and is refused explicitly.
    if (isFinal && fs === 0n) throw li('not_finality');
    let finalizedRoot: Uint8Array = new Uint8Array(32);
    if (fs === 0n) {
      if (!isEmptyHeader(u.finalized)) throw li('finality_branch');
    } else {
      if (!this.headerValid(u.finalized)) throw li('finalized_header_exec_branch');
      finalizedRoot = hashTreeRootBeaconHeader(u.finalized.beacon);
    }
    if (!isValidNormalizedMerkleBranch(finalizedRoot, u.finalityBranch, gi.finalized, u.attested.beacon.stateRoot)) throw li('finality_branch');

    // next sync committee (links only; a finality update has none)
    let learned: Committee | undefined;
    if (!isFinal) {
      if (!isSyncUpdate) throw li('not_sync_committee_update');
      learned = new Committee(u.nextCommittee!, this.cache);
      if (attestedPeriod === storePeriod && this.next !== undefined && !eq(this.next.root, learned.root)) throw li('next_committee_mismatch');
      if (!isValidNormalizedMerkleBranch(learned.root, u.nextBranch, gi.next, u.attested.beacon.stateRoot)) throw li('next_committee_branch');
    }

    // signature
    const signing = sigPeriod !== storePeriod ? this.next : this.cur;
    if (signing === undefined) {
      // the period rules above make this unreachable; a named state, never a missing committee
      if (isFinal) throw periodGap(sigPeriod, storePeriod);
      throw li('period_skip');
    }
    if (isFinal) this.enforce(sigPeriod, signing.root);
    // the signing-domain fork version is that of epoch(saturating_sub(signature_slot, 1))
    const fk = forkAt(this.p.network, signingDomainEpoch(ss));
    if (fk === undefined) throw forkUnsupported(ss, epochOf(ss), layoutName(u.shape));
    const version = fk.version;
    const domain = computeDomain(version, this.gvr);
    const msg = signingRoot(hashTreeRootBeaconHeader(u.attested.beacon), domain);
    try {
      fastAggregateVerify(signing, u.aggregate, msg);
    } catch {
      throw signatureInvalid(idx, ss, version, n);
    }

    // weak-subjectivity window (spec 5.2 step 3, r2 F10): the finalized epoch of this update may lie at most wsp_epochs past the epoch
    // 256*period at which the signing committee's period (its ledger label) begins; for the anchor that is the "previous epoch =
    // 256*period" of step 2. Measured on the live chain: the finalized epochs of consecutive best updates are up to 338 and 402 epochs
    // apart, so a step-to-step reading refuses genuine chains (RB11-C1A finding F1).
    const prevEpoch = EpochsPerPeriod * sigPeriod;
    const newEpoch = epochOf(fs);
    if (newEpoch > prevEpoch && newEpoch - prevEpoch > this.anchor.wspEpochs) throw pinWindow(prevEpoch, newEpoch, this.anchor.wspEpochs);
    if (isFinal) return;

    // process_light_client_update's apply condition, then apply_light_client_update.
    const updateHasFinalizedNext = this.next === undefined && periodOf(fs) === attestedPeriod;
    if (!(fs > this.finSlot || updateHasFinalizedNext)) throw li('not_applied');
    const finalizedPeriod = periodOf(fs);
    if (this.next === undefined) {
      if (finalizedPeriod !== storePeriod) throw li('finalized_period');
      this.enforce(attestedPeriod + 1n, learned!.root);
      this.next = learned;
    } else if (finalizedPeriod === storePeriod + 1n) {
      this.enforce(attestedPeriod + 1n, learned!.root);
      this.cur = this.next;
      this.next = learned;
    }
    if (fs > this.finSlot) this.finSlot = fs;
  }
}
