/**
 * The named states of arb-sepolia/l1_posted/v1 beyond the framework's (V2_SPEC_S7 section 7: Arbitrum R, Base R shared, L1 head R; the
 * twin of pkg/finality/arbposted/states.go). Each is a FinalityStateError with the same code and the same field names as Go; the
 * machine registry is test/fixtures/finality/arb_posted1_registry/states.json (byte-identical to the validator's).
 */
import { FinalityStateError, newState } from '../state.js';

export const CodeContentNotFound = 'l1_posted_content_not_found';
export const CodeBatchDataOffL1 = 'l1_batch_data_off_l1';
export const CodeBatchHeaderUnknown = 'l1_batch_header_unknown';
export const CodeDelayedOriginUnproven = 'l1_posted_delayed_origin_unproven';
export const CodePreBold = 'pre_bold_block';
export const CodePinMismatch = 'pin_mismatch';
export const CodeL1FinalityUnproven = 'l1_finality_unproven';
export const CodeContractIdentity = 'contract_identity_unproven';
export const CodeStateProofInvalid = 'l1_state_proof_invalid';
export const CodeBlobCommitment = 'blob_commitment_mismatch';

/** The reason of l1_posted_content_not_found (a closed set in states.json). */
export const ContentReason = {
  NoDataBatch: 'no_data_batch',
  AccumulatorMismatch: 'accumulator_mismatch',
  BlockTxsRootMismatch: 'block_txs_root_mismatch',
  NoStandardTransactions: 'no_standard_transactions',
  NoMatchingMessage: 'no_matching_message',
  PayloadUndecodable: 'payload_undecodable',
  UnsupportedTxType: 'unsupported_tx_type',
} as const;

/** The reason of l1_finality_unproven (a closed set in states.json). */
export const L1FinalityReason = {
  LCRefused: 'lc_refused',
  SpineRefused: 'spine_refused',
} as const;

/** The evidence-malformed reason Go's finality package names ReasonBadEnumValue (a closed-set value of states.json enums.reason). */
export const REASON_BAD_ENUM_VALUE = 'bad_enum_value';

/** pin_mismatch{field}. */
export const pinMismatch = (field: string): FinalityStateError => newState(CodePinMismatch, { field });

export const contentNotFound = (reason: string, extra: Record<string, bigint | number> = {}): FinalityStateError =>
  newState(CodeContentNotFound, { reason, ...extra });

export const stateProofInvalid = (which: string): FinalityStateError => newState(CodeStateProofInvalid, { which });

export const contractIdentity = (role: string, address: Uint8Array, codeHash: Uint8Array, judgedAt: bigint): FinalityStateError =>
  newState(CodeContractIdentity, { role, address, code_hash: codeHash, judged_at: judgedAt });

export const blobMismatch = (): FinalityStateError => newState(CodeBlobCommitment, {});

export const l1FinalityUnproven = (reason: string, inner: string): FinalityStateError => newState(CodeL1FinalityUnproven, { reason, inner });
