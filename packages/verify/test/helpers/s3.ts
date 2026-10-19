import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { NamedState, verifyPortableAny, type Report21 } from '../../src/s3/index.js';

/**
 * Helpers of the evidence 2.1 conformance suites: the Go-written vectors (test/fixtures/s3, byte-identical copies pinned by
 * MANIFEST.json) and the TypeScript judgement of a document, reduced to the vocabulary the vectors and the Go-written mutation
 * corpora use: "verified" with a report summary, "named" (a refusal that names a state with the partition and block it was judged
 * at), or "plain" (a refusal that is not a named state).
 */
export const fixtureDir = new URL('../fixtures/s3/', import.meta.url);
export const readS3 = (name: string): Buffer => readFileSync(new URL(name, fixtureDir));
export const readS3Json = <T>(name: string): T => JSON.parse(name.endsWith('.gz') ? gunzipSync(readS3(name)).toString('utf8') : readS3(name).toString('utf8')) as T;
export const sha256hex = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');

export interface StateView {
  code: string;
  partition: string;
  block: number;
}

/** The part of a report both verifiers state: what the manifests and the mutation corpora record for an accepted document. */
export interface ReportSummary {
  version: string;
  tag: string;
  partition: string;
  anchorBlock: number;
  certifiedBlock: number;
  certifiedRoot: string;
  checkBlock: number;
  setVerdict: string;
  routingHeight: number;
  validators: number;
  threshold: number;
  txHash: string;
  anchorTxHash: string;
  anchorStateRoot: string;
  anchorRootChainAnchor: string;
  accumulateSetRoot: string;
  proven: { url: string; partition: string; block: number; roles: string[]; declared: string[] }[];
  pagesBound: number;
  pageChains: { url: string; bound: boolean; mainHeight: number }[];
  unproven: StateView[];
  disclosures: StateView[];
  authorizationMode: string;
  arrivals: { kind: string; account: string; partition: string; message: string; block: number }[];
}

export type Judged = { verdict: 'verified'; summary: ReportSummary; report: Report21 } | { verdict: 'named'; state: StateView; message: string } | { verdict: 'plain'; message: string };

const view = (s: { code: string; partition: string; block: number }): StateView => ({ code: s.code, partition: s.partition, block: s.block });

export function summarize(r: Report21): ReportSummary {
  return {
    version: r.version,
    tag: r.tag,
    partition: r.partition,
    anchorBlock: r.anchorBlock,
    certifiedBlock: r.certifiedBlock,
    certifiedRoot: r.certifiedRoot,
    checkBlock: r.checkBlock,
    setVerdict: r.setVerdict,
    routingHeight: r.routingHeight,
    validators: r.validators,
    threshold: r.threshold,
    txHash: r.txHash,
    anchorTxHash: r.anchorTxHash,
    anchorStateRoot: r.anchorStateRoot,
    anchorRootChainAnchor: r.anchorRootChainAnchor,
    accumulateSetRoot: r.accumulateSetRoot,
    proven: r.proven.map((p) => ({ url: p.url, partition: p.partition, block: p.block, roles: [...p.roles], declared: [...p.declared] })),
    pagesBound: r.pageChains.filter((c) => c.bound).length,
    pageChains: r.pageChains.map((c) => ({ url: c.url, bound: c.bound, mainHeight: c.mainHeight })),
    unproven: r.unproven.map(view),
    disclosures: r.disclosures.map(view),
    authorizationMode: r.authorizationMode,
    arrivals: r.arrivals.map((a) => ({ kind: a.kind, account: a.account, partition: a.partition, message: a.message, block: a.block })),
  };
}

/** Judge a portable document as Go's proofv2.VerifyPortable does: a report, a named state, or a plain refusal. */
export function judgeDocument(doc: unknown): Judged {
  try {
    const out = verifyPortableAny(doc);
    if (out.version !== '2.1') return { verdict: 'plain', message: 'not evidence 2.1' };
    return { verdict: 'verified', summary: summarize(out.report), report: out.report };
  } catch (e) {
    if (e instanceof NamedState) return { verdict: 'named', state: view(e), message: e.message };
    return { verdict: 'plain', message: e instanceof Error ? e.message : String(e) };
  }
}
