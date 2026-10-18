/**
 * ProofV2Root (validator pkg/intentcert proofv2_root.go): bind a verified proof v2 report to the intent's governance levels and return the
 * govRoot the intent certificate commits. The version is the evidence's, never a caller's choice:
 *
 *   - 2.0: BindProofV2, then govRoot v3 (govroot-v3.ts);
 *   - 2.1: the facts of the intent's own vote evidence, BindProofV21, then govRoot v4 (govroot-v4.ts).
 *
 * The governance levels come in as the hashes govRoot commits (sha256 of each level's canonical v2 JSON), as a portable proof's govRootV3Inputs
 * block carries them. A refusal of the binding is a BindError (Go: ErrBind), a refusal of the root a plain error.
 */
import { VerifyError } from '../proof-v2/bytes.js';
import type { GovRootV3 } from '../proof-v2/govroot-v3.js';
import { BindError } from './consensus.js';
import { bindProofV2, bindProofV21, governingFactsFromVoteEvidence, type G0Result, type G1Result } from './bind-v21.js';
import { govRootV3FromHashes } from './govroot-v3.js';
import { govRootV4FromHashes, type GovRootV4, type GovRootV4Inputs, type PageCounts, type PagesRootPage, type VoteWire } from './govroot-v4.js';
import { decodeVoteEvidence } from './voteevidence.js';
import { VERSION_21 } from './states.js';
import type { Report21 } from './xtypes.js';

export interface ProofRootInputs {
  /** The verified report. */
  report: Report21;
  /** The evidence's version, its pages as the report proved them with what the evidence claims of each, and its votes. */
  version: string;
  pages: PagesRootPage[];
  counts: PageCounts;
  votes: VoteWire[];
  g0: G0Result;
  g1: G1Result;
  keyPageUrl: string;
  keyBookUrl: string;
  /** The intent's govvote.Evidence as carried (IntentCertificateEvidence.VoteEvidence); undefined when the certificate carries none. */
  voteEvidence: string | Uint8Array | undefined;
  /** The governance levels' hashes, the key page, key book and operation id the root commits. */
  inputs: GovRootV4Inputs;
}

/** What ProofV2Root returns: the root, whether it is govRoot v4, and the roots it was built from (v4 alone has a votes root). */
export type ProofRoot = ({ v4: true } & GovRootV4) | ({ v4: false } & GovRootV3);

const bindFailure = (e: unknown): BindError => {
  const err = e instanceof Error ? e : new Error(String(e));
  return new BindError(`proof v2 binding: ${err.message}`, err);
};

export function proofV2Root(i: ProofRootInputs): ProofRoot {
  switch (i.version) {
    case '2.0': {
      try {
        bindProofV2(i.report, i.g0, i.g1, i.keyPageUrl);
      } catch (e) {
        throw bindFailure(e);
      }
      return { v4: false, ...govRootV3FromHashes(i.report, i.pages, i.counts, i.inputs) };
    }
    case VERSION_21: {
      let view;
      try {
        if (i.voteEvidence === undefined || i.voteEvidence.length === 0) throw new Error('missing');
        view = decodeVoteEvidence(i.voteEvidence);
      } catch {
        throw new VerifyError("proof v2 root: evidence 2.1 is bound to the intent's vote evidence, which is missing or malformed");
      }
      let facts;
      try {
        facts = governingFactsFromVoteEvidence(view);
      } catch (e) {
        throw bindFailure(e);
      }
      try {
        bindProofV21(i.report, i.g0, i.g1, i.keyPageUrl, i.keyBookUrl, facts);
      } catch (e) {
        throw bindFailure(e);
      }
      return { v4: true, ...govRootV4FromHashes(i.report, i.version, i.pages, i.counts, i.votes, i.inputs) };
    }
  }
  throw new VerifyError(`proof v2 root: evidence version ${JSON.stringify(i.version)} is neither 2.0 nor ${VERSION_21}`);
}
