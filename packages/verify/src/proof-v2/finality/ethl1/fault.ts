/**
 * The named states of the L1 head verifier (V2_SPEC_S7 section 7, "L1 head R"): the twin of pkg/finality/ethl1/fault.go. Each is a
 * FinalityStateError of the framework with the same code and the same field names as Go; its canonical form
 * (`{"code":...,"fields":{...}}`, sorted keys, every integer a decimal string, every byte string 0x-lower-case hex) is byte-identical
 * to Go's CanonicalJSON on identical faults.
 */
import { FinalityStateError, newState } from '../state.js';

export const CodeNetworkMismatch = 'finality_network_mismatch';
export const CodeForkUnsupported = 'finality_fork_unsupported';
export const CodeEvidenceMalformed = 'finality_evidence_malformed';
export const CodePinUnknown = 'finality_pin_unknown';
export const CodePinMismatch = 'finality_pin_mismatch';
export const CodePinWindow = 'finality_pin_window';
export const CodeBootstrapInvalid = 'finality_bootstrap_invalid';
export const CodeLinkInvalid = 'finality_link_invalid';
export const CodeParticipationInsuff = 'finality_participation_insufficient';
export const CodeSignatureInvalid = 'finality_signature_invalid';
export const CodePeriodGap = 'finality_period_gap';
export const CodeBlockNotCovered = 'finality_block_not_covered';
export const CodeLedgerBehind = 'finality_ledger_behind';
export const CodeHeaderChainBroken = 'finality_header_chain_broken';
export const CodeEvidenceTooLarge = 'finality_evidence_too_large';
export const CodeL1FinalityUnproven = 'l1_finality_unproven';

/** Every code this package can raise, in the order of spec section 7 (Go AllCodes). */
export const AllCodes: readonly string[] = [
  CodeNetworkMismatch,
  CodeForkUnsupported,
  CodePinUnknown,
  CodePinMismatch,
  CodePinWindow,
  CodeBootstrapInvalid,
  CodeLinkInvalid,
  CodeParticipationInsuff,
  CodeSignatureInvalid,
  CodePeriodGap,
  CodeBlockNotCovered,
  CodeLedgerBehind,
  CodeHeaderChainBroken,
  CodeEvidenceMalformed,
  CodeEvidenceTooLarge,
  CodeL1FinalityUnproven,
];

type Q = FinalityStateError;

/** The pins' network is not the chain the caller is judging. */
export const networkMismatch = (chainId: bigint, wantChainId: bigint): Q =>
  newState(CodeNetworkMismatch, { chain_id: chainId, want_chain_id: wantChainId });

/** The object's attested (or bootstrap) header lies in a fork whose layout this verifier does not carry. */
export const forkUnsupported = (slot: bigint, epoch: bigint, layout: string): Q => newState(CodeForkUnsupported, { slot, epoch, layout });

/** A part does not parse at its layout's lengths or has a forbidden value. */
export const evidenceMalformed = (part: string, index: number, reason: string, gotLen: number, wantLen: number): Q =>
  newState(CodeEvidenceMalformed, { part, index, reason, got_len: gotLen, want_len: wantLen });

/** The anchor period has no ledger entry (or no block_root for a kind-2 anchor) although it lies inside the ledger. */
export const pinUnknown = (kind: number, period: bigint, root: Uint8Array): Q => newState(CodePinUnknown, { kind, period, root });

/** A committee or bootstrap root the walk met differs from the ledger entry of its period. */
export const pinMismatch = (period: bigint, wantRoot: Uint8Array, gotRoot: Uint8Array): Q =>
  newState(CodePinMismatch, { period, want_root: wantRoot, got_root: gotRoot });

/** A step moved the finalized epoch further than the weak-subjectivity period published with the anchor. */
export const pinWindow = (anchorEpoch: bigint, finalizedEpoch: bigint, wspEpochs: bigint): Q =>
  newState(CodePinWindow, { anchor_epoch: anchorEpoch, finalized_epoch: finalizedEpoch, wsp_epochs: wspEpochs });

/** The kind-2 anchor's bootstrap failed an initialize_light_client_store check. */
export const bootstrapInvalid = (check: string, slot: bigint): Q => newState(CodeBootstrapInvalid, { check, slot });

/** Update number index (the final update has index len(links)) failed a validate/apply check. */
export const linkInvalid = (index: number, check: string, attestedSlot: bigint, signatureSlot: bigint, period: bigint): Q =>
  newState(CodeLinkInvalid, { index, check, attested_slot: attestedSlot, signature_slot: signatureSlot, period });

/** Fewer than 342 of 512 sync-committee bits are set. */
export const participationInsufficient = (index: number, participants: number, required: number, committee: number): Q =>
  newState(CodeParticipationInsuff, { index, participants, required, committee });

/** The aggregate signature does not verify (or a key or the signature is not a valid non-identity point). */
export const signatureInvalid = (index: number, signatureSlot: bigint, forkVersion: Uint8Array, participants: number): Q =>
  newState(CodeSignatureInvalid, { index, signature_slot: signatureSlot, fork_version: forkVersion, participants });

/** The final update was signed in a period the walk has no committee for. */
export const periodGap = (signaturePeriod: bigint, storePeriod: bigint): Q =>
  newState(CodePeriodGap, { signature_period: signaturePeriod, store_period: storePeriod });

/** The block lies above the finalized execution head of the spine (the builder maps this to pending). */
export const blockNotCovered = (blockNumber: bigint, spineTopNumber: bigint): Q =>
  newState(CodeBlockNotCovered, { block_number: blockNumber, finalized_exec_number: spineTopNumber });

/** The proof needs a ledger period beyond the ledger's head (the verifier is older than the proof). */
export const ledgerBehind = (neededPeriod: bigint, ledgerHeadPeriod: bigint): Q =>
  newState(CodeLedgerBehind, { needed_period: neededPeriod, ledger_head_period: ledgerHeadPeriod });

/** A spine header does not follow its child. spine is "l1" for this package; reason is hash, number or rlp. */
export const headerChainBroken = (spine: string, atNumber: bigint, wantHash: Uint8Array, gotHash: Uint8Array, reason: string): Q =>
  newState(CodeHeaderChainBroken, { spine, at_number: atNumber, want_hash: wantHash, got_hash: gotHash, reason });

/** A count exceeds its bound; the number is reported, nothing is truncated. */
export const evidenceTooLarge = (part: string, count: number, limit: number): Q => newState(CodeEvidenceTooLarge, { part, count, limit });

/** The wrapper a rollup kind returns when its LC part is refused: reason is the inner code. */
export const l1FinalityUnproven = (innerCode: string): Q => newState(CodeL1FinalityUnproven, { reason: innerCode });
