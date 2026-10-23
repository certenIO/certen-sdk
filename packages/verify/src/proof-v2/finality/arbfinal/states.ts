/**
 * The named states of arb-sepolia/finalized/v1 beyond the framework's (V2_SPEC_S7 section 7: Arbitrum R, Base R shared, L1 head R; the
 * twin of pkg/finality/arbfinal/states.go). Each is a FinalityStateError with the same code and the same field names as Go; the machine
 * registry is test/fixtures/finality/finality/states.json (byte-identical to the validator's), and the conformance test asserts that every
 * code and every closed set below is the registry's.
 */
import { FinalityStateError, newState } from '../state.js';

export const CodePreBold = 'pre_bold_block';
export const CodePinMismatch = 'pin_mismatch';
export const CodeL1FinalityUnproven = 'l1_finality_unproven';
export const CodeContractIdentity = 'contract_identity_unproven';
export const CodeStateProofInvalid = 'l1_state_proof_invalid';
export const CodeTxProofInvalid = 'l1_tx_proof_invalid';
export const CodeMachineNotFinished = 'assertion_machine_not_finished';
export const CodeNotConfirmed = 'assertion_not_confirmed';
export const CodeAssertionUnknown = 'assertion_unknown';
export const CodePreimageMismatch = 'assertion_preimage_mismatch';
export const CodeHeaderChainExceeds = 'header_chain_exceeds_bound';
export const CodeHeaderChainBroken = 'finality_header_chain_broken';
export const CodeConfirmedByOwner = 'confirmed_by_owner_force';
export const CodeConfirmationUnproven = 'confirmation_path_unproven';

/** The reason of l1_finality_unproven (a closed set in states.json). */
export const L1FinalityReason = {
  LCRefused: 'lc_refused',
  SpineRefused: 'spine_refused',
} as const;

/** The part of assertion_preimage_mismatch (a closed set in states.json): which recomputed value disagrees with the value proven on L1. */
export const PreimagePart = {
  ParentConfig: 'parent_config',
  ConfirmationLog: 'confirmation_log',
} as const;

/** The reason of confirmation_path_unproven (a closed set in states.json). */
export const ConfirmReason = {
  /** the transaction's caller is code the verifier does not decode (a statement about unknown code, never a weaker level) */
  Indirect: 'indirect',
  /** the confirmation receipt's status is not 1 */
  ReceiptStatus: 'receipt_status_not_one',
  /** the receipt holds no AssertionConfirmed log of the Rollup for this assertion hash */
  LogMissing: 'confirmation_log_missing',
  /** a ValidatorWallet call decoded, but no decoded call targets the Rollup with confirmAssertion */
  WalletNoConfirm: 'wallet_no_confirm_call',
  /** the transaction selects a ValidatorWallet entry point whose arguments do not decode */
  WalletUndecodable: 'wallet_calldata_undecodable',
  /** a wallet confirmation while anyTrustFastConfirmer is not the zero address at K */
  FastConfirmerSet: 'fast_confirmer_set',
} as const;

/** The reason of finality_header_chain_broken for the L2 spine. */
export const HeaderChainReason = {
  ParentHash: 'parent_hash_mismatch',
  NumberGap: 'number_gap',
} as const;

/** The spine field of finality_header_chain_broken for the Arbitrum L2 spine. */
export const SPINE_L2 = 'l2';

/** The forced-path names of confirmed_by_owner_force. */
export const PathForce = 'force';
export const PathFast = 'fast';

/** The roles of the logic_pins this kind reads. */
export const RoleAdminLogic = 'rollup_admin_logic';
export const RoleUserLogic = 'rollup_user_logic';
export const RoleRollup = 'rollup';
/**
 * The exact runtime code of a ValidatorWallet proxy: the OpenZeppelin 4.7.3 TransparentUpgradeableProxy that
 * ValidatorWalletCreator.createWallet deploys (it has no immutables, so every wallet of the build has this code hash).
 */
export const RoleWalletProxy = 'validator_wallet_proxy';
/**
 * The exact runtime code of the pinned ValidatorWallet implementation (the creator's template, which embeds its own address as the
 * DelegateCallAware immutable, so the code hash names one deployment).
 */
export const RoleWalletLogic = 'validator_wallet_logic';

/** pin_mismatch{field}. */
export const pinMismatch = (field: string): FinalityStateError => newState(CodePinMismatch, { field });

/** l1_state_proof_invalid{which}. */
export const stateProofInvalid = (which: string): FinalityStateError => newState(CodeStateProofInvalid, { which });

/** l1_tx_proof_invalid{which}. */
export const txProofInvalid = (which: string): FinalityStateError => newState(CodeTxProofInvalid, { which });

/** contract_identity_unproven{role, address, code_hash, judged_at}: judged_at is the L1 block number whose state (S or K) was read. */
export const contractIdentity = (role: string, address: Uint8Array, codeHash: Uint8Array, judgedAt: bigint): FinalityStateError =>
  newState(CodeContractIdentity, { role, address, code_hash: codeHash, judged_at: judgedAt });

/** l1_finality_unproven{reason, inner}: the inner code of the refusal of the L1 head verifier. */
export const l1FinalityUnproven = (reason: string, inner: string): FinalityStateError => newState(CodeL1FinalityUnproven, { reason, inner });

/** finality_header_chain_broken{spine:"l2", at_number, want_hash, got_hash, reason}. */
export const headerChainBroken = (atNumber: bigint, want: Uint8Array, got: Uint8Array, reason: string): FinalityStateError =>
  newState(CodeHeaderChainBroken, { spine: SPINE_L2, at_number: atNumber, want_hash: want, got_hash: got, reason });

/** header_chain_exceeds_bound{needed, max}. */
export const headerChainExceeds = (needed: bigint, max: bigint): FinalityStateError => newState(CodeHeaderChainExceeds, { needed, max });

/** confirmed_by_owner_force{path, tx, l1_block}. */
export const confirmedByOwnerForce = (path: string, tx: Uint8Array, l1Block: bigint): FinalityStateError =>
  newState(CodeConfirmedByOwner, { path, tx, l1_block: l1Block });

/** confirmation_path_unproven{reason, tx, l1_block}. */
export const confirmationUnproven = (reason: string, tx: Uint8Array, l1Block: bigint): FinalityStateError =>
  newState(CodeConfirmationUnproven, { reason, tx, l1_block: l1Block });

/** assertion_preimage_mismatch{part}. */
export const preimageMismatch = (part: string): FinalityStateError => newState(CodePreimageMismatch, { part });
