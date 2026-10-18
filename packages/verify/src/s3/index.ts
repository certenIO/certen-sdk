/**
 * S3 completeness in TypeScript (RB9, Phase D): the verifier of evidence 2.1 - governing pages on every partition, each at its own
 * partition's block, with delegation to the protocol depth limit - reaching the same verdicts as the validator's Go verifier
 * (pkg/proof/v2: xverify.go, xtimeline.go, xdirectory.go, xroles.go, xoverride.go, xexecutor_table.go, evidence_decode.go), and the
 * consensus-side judgements that bind it (pkg/intentcert, pkg/consensus).
 *
 * The shared conformance vectors are the Go validator's files byte for byte (test/fixtures/s3); a verdict this package and Go disagree on
 * is a defect in one of them, never a vector to change.
 */
import { verifyPortableDecoded, type Report } from '../proof-v2/verify.js';
import { VerifyError } from '../proof-v2/bytes.js';
import { verifyPortable21 } from './portable21.js';
import { decodePortable } from './gotree.js';
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
 * VerifyPortable (portable.go) from the document's TEXT: json.Unmarshal into Portable (every member the type it has in Go: whole-number literals for
 * a uint64, duplicate and differently cased keys decoded in document order, invalid UTF-8 replaced byte by byte, null leaving a value as it was),
 * then evidence 2.0 exactly as before or evidence 2.1 with the 2.1 verifier. A document Go refuses to decode is refused here, and no document
 * Go refuses is verified. This is the entry that reproduces Go's verdict on arbitrary bytes.
 */
export function verifyPortableAnyBytes(input: Uint8Array | string): { version: '2.0'; report: Report } | { version: '2.1'; report: Report21 } {
  return verifyDecoded(decodePortable(input));
}

/**
 * VerifyPortable for a document that was already parsed with JSON.parse. A parsed tree has lost what the text said (65.0 is 65, a repeated key
 * is its last value, a lone surrogate is kept), so this is the bytes entry over the tree's re-serialisation: it agrees with Go on every document
 * whose text JSON.stringify(document) reproduces, and verifyPortableAnyBytes is the entry for a document received as text.
 */
export function verifyPortableAny(document: unknown): { version: '2.0'; report: Report } | { version: '2.1'; report: Report21 } {
  const text = JSON.stringify(document);
  if (text === undefined) throw new VerifyError('portable proof is not JSON');
  return verifyPortableAnyBytes(text);
}

function verifyDecoded(doc: Record<string, unknown>): { version: '2.0'; report: Report } | { version: '2.1'; report: Report21 } {
  const ev = doc.evidence as Record<string, unknown>;
  if (ev.version === VERSION_21) return { version: '2.1', report: verifyPortable21(doc) };
  return { version: '2.0', report: verifyPortableDecoded(doc) };
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
