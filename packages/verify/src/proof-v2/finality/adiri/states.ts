/**
 * The Adiri group of V2_SPEC_S7 section 7 (the twin of pkg/finality/adiri states.go): field names are exactly those of the validator's
 * testdata/finality/states.json. Integers are bigint (they render as decimal strings), byte strings are Uint8Array (0x-hex).
 */
import { FinalityStateError, newState, type FieldValue, type Fields } from '../state.js';

export const CodeIncarnationMismatch = 'adiri_incarnation_mismatch';
export const CodePinMismatch = 'evidence_pin_mismatch';
export const CodeCommitteeBroken = 'committee_chain_broken';
export const CodeCodecUnsupported = 'epoch_record_codec_unsupported';
export const CodeLinkBroken = 'finality_link_broken';
export const CodeCommitteeShrunk = 'committee_shrunk';
export const CodeHeaderChainBroken = 'finality_header_chain_broken';
export const CodeSourceUnavailable = 'finality_source_unavailable';

/** The checks of committee_chain_broken that the compact encoding can reach. */
export const CheckCommitteeIncompatible = 'committee_incompatible';
export const CheckDuplicateKey = 'committee_duplicate_key';
export const CheckBelowQuorum = 'signers_below_quorum';
export const CheckSignerIndexInvalid = 'signer_index_invalid';
export const CheckPublicKeyInvalid = 'public_key_invalid';
export const CheckSignatureInvalid = 'signature_invalid';

/** The checks of finality_link_broken. */
export const LinkTipNotFinalState = 'tip_not_final_state';
export const LinkBlockAfterSeal = 'block_after_seal';
export const LinkSlotValueMismatch = 'slot_value_mismatch';
export const LinkCodeHashMismatch = 'account_codehash_mismatch';
export const LinkProofInvalid = 'proof_invalid';
export const LinkHeaderDecode = 'header_decode';
export const SpineName = 'adiri';

/** The reason of committee_chain_broken{check:"committee_incompatible"}. */
export const ReasonLargerThanExpected = 'larger_than_expected';
export const ReasonSetMismatch = 'set_mismatch';
export const ReasonNotSubset = 'not_subset';
export const ReasonBelowTwoThirds = 'below_two_thirds';
export const ReasonBelowMinCommitteeSize = 'below_min_committee_size';

/** The reason of committee_chain_broken{check:"signature_invalid"}. */
export const ReasonEncoding = 'encoding';
export const ReasonIdentity = 'identity';
export const ReasonSubgroup = 'subgroup';
export const ReasonPairing = 'pairing';
export type SignatureReason = typeof ReasonEncoding | typeof ReasonIdentity | typeof ReasonSubgroup | typeof ReasonPairing;

/** The reason of finality_header_chain_broken{spine:"adiri"}. */
export const ReasonParentHash = 'parent_hash_mismatch';
export const ReasonNumberGap = 'number_gap';

/** committee_chain_broken{epoch, check, ...}. */
export function chainBroken(epoch: bigint | number, check: string, extra: Fields = {}): FinalityStateError {
  return newState(CodeCommitteeBroken, { epoch: BigInt(epoch), check, ...extra });
}

/** evidence_pin_mismatch{pin, want, got}. */
export function pinMismatch(pin: string, want: FieldValue, got: FieldValue): FinalityStateError {
  return newState(CodePinMismatch, { pin, want, got });
}

export interface NumHash {
  number: bigint;
  hash: Uint8Array;
}

/** adiri_incarnation_mismatch: the pinned epoch0_final_state against record(0).final_state. */
export function incarnationMismatch(want: NumHash, got: NumHash): FinalityStateError {
  return newState(CodeIncarnationMismatch, {
    expected_genesis: want.hash,
    served_genesis: got.hash,
    expected_number: want.number,
    served_number: got.number,
    pin: 'epoch0_final_state',
  });
}

/** epoch_record_codec_unsupported{epoch, pinned, supported}. */
export function codecUnsupported(epoch: bigint | number, pinned: string, supported: string): FinalityStateError {
  return newState(CodeCodecUnsupported, { epoch: BigInt(epoch), pinned, supported });
}

/** finality_link_broken{from, to, at, check, ...}: from = the seal F, to = the leg block, at = the block number the check failed at. */
export function linkBroken(check: string, from: bigint, to: bigint, at: bigint, extra: Fields = {}): FinalityStateError {
  return newState(CodeLinkBroken, { from, to, at, check, ...extra });
}

/** finality_header_chain_broken{spine:"adiri", at_number, want_hash, got_hash, reason}. */
export function headerChainBroken(atNumber: bigint, want: Uint8Array, got: Uint8Array, reason: string): FinalityStateError {
  return newState(CodeHeaderChainBroken, { spine: SpineName, at_number: atNumber, want_hash: want, got_hash: got, reason });
}

/** The reported attribute committee_shrunk{epoch, size, expected}. */
export function shrunk(epoch: bigint | number, size: number, expected: number): FinalityStateError {
  return newState(CodeCommitteeShrunk, { epoch: BigInt(epoch), size: BigInt(size), expected: BigInt(expected) });
}
