/**
 * Per-layer verification of a proof v2 portable document: what was checked here, against which evidence, and what the
 * document does not carry. verifyPortable (proof-v2/verify.ts) throws on the first thing that does not check; this runs it
 * with a trace and turns the stages it completed into one verdict per layer, so a failure names the layer and a layer that
 * could not be checked is named instead of being passed over.
 *
 * The verdicts are about the document, never about a flag in it: nothing here reads a `verified` field.
 *
 *   verified          checked here, from the document's own bytes
 *   failed            checked here and it does not hold (the message says why)
 *   not_checked       inside the document's scope but not established (the reason says why)
 *   not_in_document   a layer this document type does not carry (G1(b), G2, L5, the execution outcome)
 *
 * The overall verdict is `verified` only when every layer in the document's scope is verified. A layer outside the document
 * never turns a failure into a pass, and is always listed in `notCovered`, so "verified" cannot be read as more than the
 * statements it covers (S1, S2 and S3(a) of docs/proof/PROOF_V2.md §3).
 */
import { govRootV3FromPortable } from './proof-v2/govroot-v3.js';
import { PORTABLE_FORMAT, verifyPortable, type Report, type Stage } from './proof-v2/verify.js';
import { VerifyError } from './proof-v2/bytes.js';

export type LayerVerdict = 'verified' | 'failed' | 'not_checked' | 'not_in_document';
export type Overall = 'verified' | 'partial' | 'failed' | 'no_evidence';

export interface Layer {
  id: string;
  /** The statement of PROOF_V2 §3 this layer establishes. */
  statement: string;
  title: string;
  verdict: LayerVerdict;
  /** What it was checked against (hashes, heights, counts), or the reason it was not checked. */
  evidence: Record<string, unknown>;
  /** For failed / not_checked / not_in_document: why. */
  reason?: string;
}

export interface Verification {
  overall: Overall;
  /** True only for `verified`: the statements in `covers` were derived here, from the document and genesis, with CERTEN not trusted. */
  independent: boolean;
  layers: Layer[];
  /** Statements this verification establishes (when overall is verified) and statements the document cannot speak to. */
  covers: string[];
  notCovered: string[];
  report?: Report;
  /** The first layer that failed. */
  failure?: { layer: string; message: string };
  govRootV3?: string;
}

export interface VerifyOptions {
  /** A govRoot v3 to compare the one computed here with (for example the one a V8.2 anchor committed). */
  expectGovRoot?: string;
}

const IN_DOCUMENT: { id: string; statement: string; title: string; stage: Stage | 'derived' }[] = [
  { id: 'trust_base', statement: 'S2', title: 'Genesis network values are bound to the pinned incarnation', stage: 'trust_base' },
  { id: 'L4', statement: 'S2', title: 'Directory anchors carry a quorum of the validator set tracked from genesis', stage: 'spine' },
  { id: 'L1', statement: 'S1', title: 'The transaction receipt starts at the transaction and validates', stage: 'receipt' },
  { id: 'L2', statement: 'S1', title: 'The partition anchor is proven into the certified root and the receipt passes through it', stage: 'anchor' },
  { id: 'L3', statement: 'S1', title: 'The receipt ends at a Directory root the quorum certified', stage: 'receipt' },
  { id: 'G0', statement: 'S3', title: 'The execution receipt is bound to that certified root', stage: 'receipt' },
  { id: 'G1', statement: 'S3', title: 'Each governing page is proven into the anchor\'s state root', stage: 'pages' },
  { id: 'G1_chains', statement: 'S3', title: 'Each page\'s chain history is bound to its proof', stage: 'pages' },
  { id: 'L4_set', statement: 'S2', title: 'The validator set in force is proven at a certified root and equals the derived one', stage: 'set' },
  { id: 'govRootV3', statement: 'S3', title: 'govRoot v3 is derived from the verified facts', stage: 'derived' },
];

const OUTSIDE: { id: string; statement: string; title: string; reason: string }[] = [
  { id: 'G1b', statement: 'S3', title: 'The authority set judged is the complete set in force', reason: 'G1(b) completeness is not carried by the portable document (PROOF_V2 §5.3: reported by name as unproven until the argument is implemented)' },
  { id: 'G2', statement: 'S4', title: 'Accumulate\'s status and outcome for the transaction', reason: 'the portable document carries a hash of G2\'s result (govRootV3Inputs.g2Hash), not the evidence' },
  { id: 'L5', statement: 'S9', title: 'CERTEN validators\' BLS attestation (supplementary)', reason: 'an execution-chain layer: it needs the chain\'s registered keys, which this document does not carry' },
  { id: 'outcome', statement: 'S6', title: 'The execution on the destination chain', reason: 'an execution-chain layer: checked from the bundle\'s execution component, not from this document' },
];

export const COVERED_STATEMENTS = ['S1', 'S2', 'S3(a)'];
export const NOT_COVERED_STATEMENTS = ['S3(b)', 'S4', 'S5', 'S6', 'S7', 'S8', 'S9'];

/** Run verifyPortable and report each layer. Never throws for a document that does not check: that is a `failed` verification. */
export function verifyProofDocument(doc: unknown, opts: VerifyOptions = {}): Verification {
  const done = new Map<Stage, Record<string, unknown>>();
  let report: Report | undefined;
  let failure: { stage: Stage; message: string } | undefined;

  if (!doc || typeof doc !== 'object' || (doc as { format?: unknown }).format !== PORTABLE_FORMAT) {
    const got = doc && typeof doc === 'object' ? JSON.stringify((doc as { format?: unknown }).format) : typeof doc;
    failure = { stage: 'trust_base', message: `not a proof v2 portable document: format ${got} is not ${PORTABLE_FORMAT}` };
  } else {
    try {
      report = verifyPortable(doc, (stage, facts) => void done.set(stage, facts));
    } catch (e) {
      if (!(e instanceof VerifyError)) throw e;
      failure = { stage: nextStage(done), message: e.message };
    }
  }

  const layers: Layer[] = [];
  let failedLayer: string | undefined;
  for (const l of IN_DOCUMENT) {
    const base = { id: l.id, statement: l.statement, title: l.title };
    if (l.stage === 'derived') continue;
    const facts = done.get(l.stage);
    if (facts) {
      layers.push({ ...base, ...inDocumentVerdict(l.id, facts) });
    } else if (failure && failure.stage === l.stage && !failedLayer) {
      failedLayer = l.id;
      layers.push({ ...base, verdict: 'failed', evidence: {}, reason: failure.message });
    } else {
      layers.push({ ...base, verdict: 'not_checked', evidence: {}, reason: failedLayer ? `not reached: ${failedLayer} failed` : 'not reached' });
    }
  }

  // govRoot v3 comes last among the in-document layers: it is derived from the report, so it exists only for a verified one.
  const gr = IN_DOCUMENT.find((l) => l.id === 'govRootV3')!;
  const grBase = { id: gr.id, statement: gr.statement, title: gr.title };
  let govRootV3: string | undefined;
  if (!report) {
    layers.push({ ...grBase, verdict: 'not_checked', evidence: {}, reason: failedLayer ? `not reached: ${failedLayer} failed` : 'not reached' });
  } else if (!(doc as { govRootV3Inputs?: unknown }).govRootV3Inputs) {
    layers.push({ ...grBase, verdict: 'not_checked', evidence: {}, reason: 'the document carries no govRootV3Inputs' });
  } else {
    try {
      govRootV3 = govRootV3FromPortable(report, doc).root;
      const want = opts.expectGovRoot?.toLowerCase().replace(/^0x/, '');
      if (want !== undefined && want !== govRootV3) {
        failedLayer ??= gr.id;
        failure = { stage: 'set', message: `govRoot v3 computed here is ${govRootV3}, not the ${want} expected` };
        layers.push({ ...grBase, verdict: 'failed', evidence: { computed: govRootV3, expected: want }, reason: failure.message });
      } else {
        layers.push({ ...grBase, verdict: 'verified', evidence: { root: govRootV3, comparedWith: want ?? null } });
      }
    } catch (e) {
      if (!(e instanceof VerifyError)) throw e;
      failedLayer ??= gr.id;
      failure = { stage: 'set', message: e.message };
      layers.push({ ...grBase, verdict: 'failed', evidence: {}, reason: e.message });
    }
  }

  for (const o of OUTSIDE) layers.push({ id: o.id, statement: o.statement, title: o.title, verdict: 'not_in_document', evidence: {}, reason: o.reason });

  const inScope = layers.filter((l) => l.verdict !== 'not_in_document');
  const anyFailed = inScope.some((l) => l.verdict === 'failed');
  const allVerified = inScope.every((l) => l.verdict === 'verified');
  const overall: Overall = anyFailed ? 'failed' : allVerified ? 'verified' : 'partial';
  return {
    overall,
    independent: overall === 'verified',
    layers,
    covers: overall === 'verified' ? COVERED_STATEMENTS : [],
    notCovered: overall === 'verified' ? NOT_COVERED_STATEMENTS : [...COVERED_STATEMENTS, ...NOT_COVERED_STATEMENTS],
    ...(report ? { report } : {}),
    ...(failedLayer ? { failure: { layer: failedLayer, message: failure!.message } } : {}),
    ...(govRootV3 ? { govRootV3 } : {}),
  };
}

/** The verification for evidence that is not there at all: nothing was checked, and nothing is claimed. */
export function noEvidence(reason: string): Verification {
  return {
    overall: 'no_evidence',
    independent: false,
    layers: [...IN_DOCUMENT.map((l) => ({ id: l.id, statement: l.statement, title: l.title, verdict: 'not_checked' as const, evidence: {}, reason })), ...OUTSIDE.map((o) => ({ id: o.id, statement: o.statement, title: o.title, verdict: 'not_in_document' as const, evidence: {}, reason: o.reason }))],
    covers: [],
    notCovered: [...COVERED_STATEMENTS, ...NOT_COVERED_STATEMENTS],
  };
}

const ORDER: Stage[] = ['trust_base', 'spine', 'receipt', 'anchor', 'pages', 'set'];
function nextStage(done: Map<Stage, unknown>): Stage {
  return ORDER.find((s) => !done.has(s)) ?? 'set';
}

function inDocumentVerdict(id: string, f: Record<string, unknown>): Pick<Layer, 'verdict' | 'evidence' | 'reason'> {
  switch (id) {
    case 'trust_base':
      return { verdict: 'verified', evidence: { incarnation: f.incarnation, pin: f.pin } };
    case 'L4':
      return { verdict: 'verified', evidence: { majorBlocks: f.majors, certifiedDirectoryBlock: f.certifiedBlock, validators: f.validators, quorumThreshold: f.threshold, networkUpdatesApplied: f.networkUpdatesApplied } };
    case 'L1':
      return { verdict: 'verified', evidence: { transaction: f.txHash, receiptSteps: f.steps } };
    case 'L3':
    case 'G0':
      return { verdict: 'verified', evidence: { certifiedRoot: f.root, certifiedDirectoryBlock: f.certifiedBlock } };
    case 'L2':
      return { verdict: 'verified', evidence: { partition: f.partition, anchorBlock: f.anchorBlock, anchorTransaction: f.anchorTxHash, partitionStateRoot: f.stateRoot } };
    case 'G1': {
      const pages = f.pages as { url: string }[];
      return pages.length > 0
        ? { verdict: 'verified', evidence: { pages: pages.map((p) => p.url) } }
        : { verdict: 'not_checked', evidence: {}, reason: 'the document carries no governing pages' };
    }
    case 'G1_chains': {
      const pages = f.pages as { url: string; bound: boolean; mainHeight: number; note?: string }[];
      const unbound = pages.filter((p) => !p.bound);
      if (pages.length === 0) return { verdict: 'not_checked', evidence: {}, reason: 'the document carries no governing pages' };
      return unbound.length === 0
        ? { verdict: 'verified', evidence: { pages: pages.map((p) => ({ url: p.url, mainChainHeight: p.mainHeight })) } }
        : { verdict: 'not_checked', evidence: { unbound: unbound.map((p) => ({ url: p.url, why: p.note })) }, reason: `${unbound.length} of ${pages.length} pages\' chains are not bound (${unbound.map((p) => p.note ?? 'g1_chain_uncaptured').join(', ')})` };
    }
    case 'L4_set':
      return f.verdict === 'verified'
        ? { verdict: 'verified', evidence: { checkedAtDirectoryBlock: f.checkBlock, validators: f.validators, quorumThreshold: f.threshold, networkMainChainHeight: f.networkMainHeight, accumulateSetRoot: f.accumulateSetRoot } }
        : { verdict: 'not_checked', evidence: { setVerdict: f.verdict, accumulateSetRoot: f.accumulateSetRoot }, reason: `the validator set is ${String(f.verdict)}, not verified from genesis` };
  }
  return { verdict: 'not_checked', evidence: {}, reason: 'unknown layer' };
}
