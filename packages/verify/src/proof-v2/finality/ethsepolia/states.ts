/**
 * The named states of eth-sepolia/finalized/v1 (V2_SPEC_S7 section 7; the twin of pkg/finality/ethsepolia states.go).
 */
import { CodeHeaderChainBroken } from '../ethl1/fault.js';
import { EvidenceReason, FinalityStateError, malformed, newState } from '../state.js';

/** The pending reasons of this kind (finality_pending{reason}; the closed set of the registry). */
export const PendingBlockNotYetCovered = 'block_not_yet_covered';
export const PendingLCUnavailable = 'finality_lc_unavailable';
export const PendingLedgerIncomplete = 'finality_ledger_incomplete';
export const PendingHistoryProof = 'history_proof_unavailable';

/** The reason values of finality_header_chain_broken{spine:"l1"}: the registry's closed set (shared with Adiri). */
export const SpineL1 = 'l1';
const reasonParentHash = 'parent_hash_mismatch';
const reasonNumberGap = 'number_gap';

/**
 * Adapts an L1-head fault (ethl1) to the framework's state with the SAME code and fields. The header-chain reasons of ethl1 ("hash",
 * "number", "rlp") are mapped onto the registry's closed set (parent_hash_mismatch, number_gap); an unreadable header cannot reach here
 * because the kind reads every spine header first, but if it did it would be finality_evidence_malformed, never a header-chain reason
 * outside the set. Anything that is not an L1 head fault is returned unchanged.
 */
export function stateOf(err: unknown): unknown {
  if (!(err instanceof FinalityStateError) || err.code !== CodeHeaderChainBroken) return err;
  const s = newState(err.code, err.fields);
  switch (err.fields.reason) {
    case 'hash':
      s.fields.reason = reasonParentHash;
      return s;
    case 'number':
      s.fields.reason = reasonNumberGap;
      return s;
    default:
      return malformed('spine', EvidenceReason.HeaderBadItem, 0, 0);
  }
}
