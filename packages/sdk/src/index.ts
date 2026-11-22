/**
 * The SDK's default entry (Node): everything in the browser-safe surface, plus the two parts that need Node.
 * See browser.ts for the portable half and why the split exists.
 */
export * from './browser.js';

// Standalone on purpose: redeeming a share link needs no API key and therefore no client. Node-only because a shared bundle may be
// gzipped (node:zlib). See shared-proof.ts.
export { fetchSharedProof, decodeSharedBundle } from './shared-proof.js';

// An autonomous agent's identity and every proof-gated verb it needs, composed once. Node-only: it holds and uses a local ed25519 key
// through node:crypto. See agent.ts.
export { CertenAgent, ed25519Signer } from './agent.js';
export type { AgentSigner, CertenAgentState, ProvisionParams } from './agent.js';

export {
  CertenSigningDataError, checkIntentSigning, checkCosigning, checkGovernanceSigning, inspectSigningData, legsFromIntent, toBaseUnits,
  SIGNING_DATA_MISMATCH, SIGNING_DATA_ABSENT, SIGNING_VERIFIER_UNAVAILABLE, SIGNING_EXPECTATION_UNAVAILABLE,
} from './signing-check.js';
export type { SigningSummary, ExpectedLeg, ExpectedOperation, Expectation } from './signing-check.js';
export type { BeforeSign } from './resources/execute.js';
export { agentEnrollmentState, agentAuthorityOperation, agentBookDisableOperation, isUnderAdi } from './agent-enrollment.js';
export { buildPrincipalEntry, canonicalJson, coreVerdict, PRINCIPAL_ENTRY_REFUSED_BY_CORE, entryHash, entryTag, envelopeDigestHex, issueGrant, issueMandate, registerAgent, taggedPreimage, writePrincipalEntry, ENTRY_TAGS, PRINCIPAL_ACCOUNTS, PRINCIPAL_ENTRY_MALFORMED, PRINCIPAL_ENTRY_NOT_PRINCIPALS, PRINCIPAL_PAGE_INVALID, PRINCIPAL_WRITE_UNSIGNED } from './principal-entries.js';
export type { PrincipalEntry, PrincipalEntryKind, PrincipalSigner, PrincipalWriteResult } from './principal-entries.js';
export { agentKeyRemoval, cancelByRejectVote, replaceAgent, revocationOf, revokeAgentKey, revokeGrant, revokeSeatRecord, EXPOSURE_WINDOW_STATEMENT, INTERVENTION_MALFORMED, SEAT_RECORD_ROUTE, SEAT_RECORD_STATEMENT } from './principal-intervention.js';
export type { CancelResult, InterventionAct, ReplaceResult, RevokeGrantResult, RevokeKeyResult, SeatRecord, SeatRecordAbsence, SeatRecordAbsenceCode, SeatRecordPart } from './principal-intervention.js';
export type { AgentEnrollmentFacts, AgentEnrollmentState, AgentEnrollmentStep, AgentEnrollmentVerdict, AuthorityEntry, SignedDocumentFacts } from './agent-enrollment.js';
