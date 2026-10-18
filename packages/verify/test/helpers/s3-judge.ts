import { decodeEvidenceFull, IntentProofError, judgeProofV2, marshalEvidence, MESSAGES, type EvidenceVal } from '../../src/s3/consensus.js';
import type { PagesRootPage, VoteWire } from '../../src/s3/govroot-v4.js';
import { proofV2Root } from '../../src/s3/proofroot.js';
import { reportOf } from './s3-intent.js';

/**
 * The Go-written corpus of consensus.judgeProofV2 (judge-cases.json): the order in which a v3 certificate's proof v2 is judged. The verifier
 * and the root are the injected steps; the verdict is which refusal (or the govRoot), its message, and the document the verifier was handed.
 */
type J = Record<string, unknown>;
const o = (v: unknown): J => (v && typeof v === 'object' && !Array.isArray(v) ? (v as J) : {});
const s = (v: unknown): string => (typeof v === 'string' ? v : '');
const n = (v: unknown): number => (typeof v === 'number' ? v : typeof v === 'bigint' ? Number(v) : 0);

export interface JudgeScenario {
  name: string;
  claim: string;
  nil: boolean;
  required: boolean;
  verifyErr: string;
  setRootOther: boolean;
  voteEvidence: string;
  unproven: boolean;
  keyPage: string;
  shape20: boolean;
}
export interface JudgeVerdict {
  kind: string;
  msg?: string;
  verifyInput?: string;
  called: boolean;
  govRoot?: string;
}

const list = (v: unknown): J[] => (Array.isArray(v) ? (v as J[]) : []);

// An EvidenceVal vote (Go field names, u64 as bigint) in the wire spelling of the votes root.
function indexProof(v: unknown): { position: number; entry: string; receipt: string } {
  const p = o(v);
  return { position: n(p.Position), entry: s(p.Entry), receipt: s(p.Receipt) };
}
function arrival(v: unknown): { before?: ReturnType<typeof indexProof>; at: ReturnType<typeof indexProof> } {
  const a = o(v);
  return { ...(a.Before ? { before: indexProof(a.Before) } : {}), at: indexProof(a.At) };
}
function hop(v: unknown): VoteWire['hops'][number] {
  const h = o(v);
  return { page: s(h.Page), message: s(h.Message), signature: s(h.Signature), block: n(h.Block), receipt: s(h.Receipt), ...(h.Arrival ? { arrival: arrival(h.Arrival) } : {}) };
}
function voteWire(v: J): VoteWire {
  const t = o(v.Transport);
  const p = v.Produced ? o(v.Produced) : undefined;
  return {
    authority: s(v.Authority),
    origin: s(v.Origin),
    vote: s(v.Vote),
    cause: s(v.Cause),
    transport: { kind: s(t.Kind), source: s(t.Source), destination: s(t.Destination), number: n(t.Number) },
    message: s(v.Message),
    receipt: s(v.Receipt),
    hops: list(v.Hops).map(hop),
    counted: list(v.Counted).map(hop),
    ...(p ? { produced: { account: s(p.Account), chain: s(p.Chain), message: s(p.Message), receipt: s(p.Receipt), arrival: arrival(p.Arrival), sequenced: s(p.Sequenced) } } : {}),
  };
}

export function judgeScenario(base: J, hashes: Record<string, string>, sc: JudgeScenario): JudgeVerdict {
  const report = reportOf(o(base.report));
  if (sc.shape20) {
    report.proven = [];
    report.unproven = [];
  }
  if (sc.unproven) report.unproven = [...report.unproven, { code: 'g1_completeness_unproven', partition: report.partition, block: report.anchorBlock, detail: 'appended' }];
  let accRoot = report.accumulateSetRoot;
  if (sc.setRootOther) accRoot = ((parseInt(accRoot.slice(0, 2), 16) ^ 1).toString(16).padStart(2, '0') + accRoot.slice(2)).toLowerCase();

  // the certificate's proof v2: the Evidence the scenario names, with the version it claims (an in-memory value, as Go's test hands it)
  const ev = o(base.evidence);
  const evPages = list(ev.pages);
  const text = JSON.stringify({
    version: sc.claim,
    account: s(ev.account),
    pages: sc.shape20 ? evPages.map((p) => ({ url: p.url, state: p.state })) : evPages,
    votes: sc.shape20 ? [] : (ev.votes ?? []),
  });
  const proofV2: EvidenceVal | null = sc.nil ? null : decodeEvidenceFull(text);

  let voteEvidence: string | undefined;
  switch (sc.voteEvidence) {
    case 'base':
      voteEvidence = JSON.stringify(base.voteEvidence);
      break;
    case 'null':
      voteEvidence = 'null';
      break;
    case 'malformed':
      voteEvidence = '{"version":7}';
      break;
    case 'other-principal':
      voteEvidence = JSON.stringify({ ...o(base.voteEvidence), account: 'acc://someone.acme/else' });
      break;
    default:
      voteEvidence = undefined;
  }
  const g0c = o(base.g0);
  const keyPageUrl = sc.keyPage !== '' ? sc.keyPage : s(base.keyPage);
  const verdict: JudgeVerdict = { kind: 'ok', called: false };
  try {
    const r = judgeProofV2({
      proofV2,
      activationRequired: sc.required,
      verify: (doc) => {
        verdict.called = true;
        verdict.verifyInput = marshalEvidence(doc);
        if (sc.verifyErr !== '') throw new Error(sc.verifyErr);
        return report;
      },
      accRoot,
      root: (rep, doc) => {
        const docPages = list(doc.Pages);
        const pages: PagesRootPage[] = rep.pages.map((p, i) => ({
          account: p.account,
          evidence: { url: s(docPages[i]?.URL), state: s(docPages[i]?.State), partition: s(docPages[i]?.Partition), roles: Array.isArray(docPages[i]?.Roles) ? (docPages[i]!.Roles as string[]) : [] },
          chain: rep.pageChains[i] ?? { url: '', bound: false, mainHeight: 0 },
          proven: rep.proven[i] ?? { url: '', partition: '', block: 0, roles: [], declared: [] },
        }));
        return proofV2Root({
          report: rep,
          version: s(doc.Version),
          pages,
          counts: { chains: rep.pageChains.length, proven: rep.proven.length, evidence: docPages.length },
          votes: list(doc.Votes).map(voteWire),
          g0: { entryHashExec: s(g0c.entryHashExec), receiptStart: s(g0c.receiptStart), execWitness: s(g0c.execWitness), execMBI: n(g0c.execMBI) },
          g1: { authoritySnapshotPage: s(base.g1Page) },
          keyPageUrl,
          keyBookUrl: s(base.keyBook),
          voteEvidence,
          inputs: { g0Hash: s(hashes.g0Hash), g1Hash: s(hashes.g1Hash), g2Hash: s(hashes.g2Hash), keyPageUrl, keyBookUrl: s(base.keyBook), operationId: s(hashes.operationId) },
        }).root;
      },
    });
    verdict.govRoot = r.govRoot;
  } catch (e) {
    const err = e as Error;
    verdict.kind = err instanceof IntentProofError ? MESSAGES[err.kind] : 'other';
    verdict.msg = err.message;
  }
  return verdict;
}
