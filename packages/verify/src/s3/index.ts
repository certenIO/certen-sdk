/**
 * S3 completeness in TypeScript (RB9, Phase D): the verifier of evidence 2.1 - governing pages on every partition, each at its own
 * partition's block, with delegation to the protocol depth limit - reaching the same verdicts as the validator's Go verifier
 * (pkg/proof/v2: xverify.go, xtimeline.go, xdirectory.go, xroles.go, xoverride.go, xexecutor_table.go, evidence_decode.go), and the
 * consensus-side judgements that bind it (pkg/intentcert, pkg/consensus).
 *
 * The shared conformance vectors are the Go validator's files byte for byte (test/fixtures/s3); a verdict this package and Go disagree on
 * is a defect in one of them, never a vector to change.
 */
import { verifyPortable, type Report } from '../proof-v2/verify.js';
import { VerifyError } from '../proof-v2/bytes.js';
import { verifyPortable21 } from './portable21.js';
import type { Report21 } from './xtypes.js';
import { VERSION_21 } from './states.js';

export { verifyPortable21 } from './portable21.js';
export { NamedState, State, Role, KNOWN_ROLES, canonicalRoles, DOMAIN_G1_V4, DOMAIN_GOVROOT_V4, VERSION_21, refusal21 } from './states.js';
export type { PageRole, StateEntry } from './states.js';
export type { Report21, ProvenPage, ArrivalReport } from './xtypes.js';
export { MODE_ALL_AUTHORITIES_DISABLED, MODE_AUTHORITIES_REQUIRED } from './xtypes.js';
export { hasExecutorOverride, executorOverrideTypes, executorFloorAt, kermitExecutorActivations, normalizeExecutorPartition } from './executor.js';
export { routePartition } from './routing.js';
export { receiptPositions } from './timeline.js';

/**
 * VerifyPortable (portable.go): a portable proof as a verifier in another language reads it - evidence 2.0 exactly as before, evidence
 * 2.1 (pages on more than one partition) with the 2.1 verifier.
 */
export function verifyPortableAny(document: unknown): { version: '2.0'; report: Report } | { version: '2.1'; report: Report21 } {
  const doc = document && typeof document === 'object' && !Array.isArray(document) ? (document as Record<string, unknown>) : undefined;
  const ev = doc?.evidence && typeof doc.evidence === 'object' && !Array.isArray(doc.evidence) ? (doc.evidence as Record<string, unknown>) : undefined;
  if (!doc) throw new VerifyError('portable proof is not an object');
  if (versionOf(ev) === VERSION_21) return { version: '2.1', report: verifyPortable21(doc) };
  return { version: '2.0', report: verifyPortable(doc) };
}

/** The "version" member as Go's decode reads it: the exact key, else a case-insensitive match; a non-string is not a version. */
function versionOf(ev: Record<string, unknown> | undefined): string | undefined {
  if (!ev) return undefined;
  let v: unknown;
  for (const [k, val] of Object.entries(ev)) {
    if (k === 'version' || k.toLowerCase() === 'version') v = val;
  }
  return typeof v === 'string' ? v : undefined;
}

export { govRootV4FromHashes, govRootV4FromPortable, computeGovRootV4, govRootV4G1, govRootV4G2, encodeVoteV4, votesRootV4, pagesRootV4, pagesRootInputs, pageCounts, voteWire, GOVROOT_V4_DOMAIN, GOVROOT_V4_TAGS, VOTE_RECORD_TAG_V4 } from './govroot-v4.js';
export type { GovRootV4, GovRootV4Inputs, GovRootV4Slots, GovRootReport, VoteWire, PagesRootPage, PageCounts } from './govroot-v4.js';
export { bindProofV21, bindProofV2, bindG0, governingFactsFromVoteEvidence } from './bind-v21.js';
export { govRootV3FromHashes } from './govroot-v3.js';
export { proofV2Root } from './proofroot.js';
export type { ProofRoot, ProofRootInputs } from './proofroot.js';
export type { GoverningFacts, G0Result, G1Result, VoteEvidenceView } from './bind-v21.js';
export { decodeVoteEvidence } from './voteevidence.js';
export { unmarshalCertifiedEvidence, decodeEvidenceFull, evidence20View, marshalEvidence, judgeProofV2, IntentProofError, BindError } from './consensus.js';
export type { EvidenceVal, JudgeInputs } from './consensus.js';
