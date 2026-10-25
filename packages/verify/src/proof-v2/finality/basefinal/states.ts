/**
 * The named states of base-sepolia/finalized/v1 beyond the framework's (V2_SPEC_S7 section 7: Base R, L1 head R; the twin of the
 * validator's pkg/finality/basefinal verify.go). Each is a FinalityStateError with the same code and the same field names as Go; the
 * machine registry is test/fixtures/finality/base_final1_registry/states.json (byte-identical to the validator's).
 */
import { FinalityStateError, newState } from '../state.js';

export const CodeL1FinalityUnproven = 'l1_finality_unproven';
export const CodeContractIdentity = 'contract_identity_unproven';
export const CodeGameUnrecognised = 'game_unrecognised';
export const CodeGameTypeUnsupported = 'game_type_unsupported';
export const CodeGameNotRegistered = 'game_not_registered';
export const CodeGameBlacklisted = 'game_blacklisted';
export const CodeGameRetired = 'game_retired';
export const CodeL1SystemPaused = 'l1_system_paused';
export const CodeGameNotRespected = 'game_not_respected';
export const CodeGameNotResolved = 'game_not_resolved';
export const CodeGameWithinDelay = 'game_within_finality_delay';
export const CodeGameChallengerWins = 'game_challenger_wins';
export const CodeOutputRootMismatch = 'output_root_mismatch';
export const CodeL2NotCanonical = 'l2_block_not_canonical';
export const CodeL1StateProofInvalid = 'l1_state_proof_invalid';

/** The reason of l1_finality_unproven when the LC part of the container is refused; the inner fault code rides in `inner`. */
export const LC_REFUSED = 'lc_refused';

/** The reasons of game_unrecognised (a closed set in states.json). */
export const GameReason = {
  Prefix: 'prefix',
  Trailer: 'trailer',
  ArgsLen: 'args_len',
  NMismatch: 'n_mismatch',
  IntervalPair: 'interval_pair',
} as const;

/** OP Types.GameStatus. */
export const StatusInProgress = 0;
export const StatusChallengerWins = 1;
export const StatusDefenderWins = 2;

/** The roles of impl_pins and proxy_pins rows (V2_SPEC_S7 section 4.2) and the name of the game layout. */
export const RoleGameImpl = 'game_impl';
export const RoleASRImpl = 'asr_impl';
export const RolePortalImpl = 'portal_impl';
export const RoleSysCfgImpl = 'syscfg_impl';
export const RoleDGFImpl = 'dgf_impl';
export const RoleSuperchainImpl = 'superchain_impl';
export const RoleOPProxy = 'op_proxy';
export const RoleSuperchainPrx = 'superchain_proxy';
export const LayoutAggregateV1 = 'aggregate_v1';

/** The Base R codes this kind raises (not the framework's, not the L1 head's). */
export const AllCodes: readonly string[] = [
  CodeL1FinalityUnproven,
  CodeContractIdentity,
  CodeGameUnrecognised,
  CodeGameTypeUnsupported,
  CodeGameNotRegistered,
  CodeGameBlacklisted,
  CodeGameRetired,
  CodeL1SystemPaused,
  CodeGameNotRespected,
  CodeGameNotResolved,
  CodeGameWithinDelay,
  CodeGameChallengerWins,
  CodeOutputRootMismatch,
  CodeL2NotCanonical,
  CodeL1StateProofInvalid,
];

export const stateProofInvalid = (which: string): FinalityStateError => newState(CodeL1StateProofInvalid, { which });

export const contractIdentity = (role: string, address: Uint8Array, codeHash: Uint8Array, judgedAt: bigint): FinalityStateError =>
  newState(CodeContractIdentity, { role, address, code_hash: codeHash, judged_at: judgedAt });

export const gameUnrecognised = (reason: string, extra: Record<string, bigint> = {}): FinalityStateError =>
  newState(CodeGameUnrecognised, { reason, ...extra });

export const l1FinalityUnproven = (reason: string, inner: string): FinalityStateError => newState(CodeL1FinalityUnproven, { reason, inner });
