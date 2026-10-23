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
import { carriesFinality, judgeFinalityDocument, type DocumentFinality, type FinalityOptions } from './proof-v2/finality/docreport.js';
import { LEVELS, levelName } from './proof-v2/finality/level.js';
import { hexLower } from './proof-v2/finality/state.js';

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
  /**
   * The finality section (S7): present only when the document carries a finality member or the caller passed VerifyOptions.finality, and then also as the
   * layer `S7`. A document with neither is verified exactly as before.
   */
  finality?: DocumentFinality;
  /** The first layer that failed. */
  failure?: { layer: string; message: string };
  govRootV3?: string;
}

export interface VerifyOptions {
  /** A govRoot v3 to compare the one computed here with (for example the one a V8.2 anchor committed). */
  expectGovRoot?: string;
  /**
   * Judge the finality section against the caller's Settlement, pins and Kinds (see FinalityOptions). The synchronous verifyProofDocument registers no Kind of
   * its own: pass `registry`, or use finality.verifyProofDocumentWithKinds, which registers every ported Kind first.
   */
  finality?: FinalityOptions;
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
  return verifyProofDocumentWith(doc, opts, undefined);
}

/**
 * verifyProofDocument with the finality judgement already made (the asynchronous entries judge it after registering the Kinds). The core layers are verified
 * first and untouched; the section is added to the result only when the document carries one, the caller asked for one, or `supplied` is given.
 */
export function verifyProofDocumentWith(doc: unknown, opts: VerifyOptions, supplied: DocumentFinality | undefined): Verification {
  const core = verifyCore(doc, opts);
  const finality = supplied ?? (opts.finality !== undefined || carriesFinality(doc) ? judgeFinalityDocument(doc, opts.finality) : undefined);
  return finality === undefined ? core : applyFinality(core, finality);
}

/**
 * Adds the finality section to a verification as the layer S7, after the in-document layers and before the layers outside the document. The overall verdict is then
 * the one the layers give, exactly as before: failed if any layer failed, verified if every layer in scope is verified, else partial. That is Go's combined
 * proofverify (cmd/proofverify/main.go): the section's class (VERIFIED / SUMMARY-ONLY / FAILED, exit 0 / 3 / 1) is combined with worseExit over the core result, so
 * the section can weaken the overall and never strengthen it. A core failure stays the first failure; `covers` names S7 at the level reached only for a verified overall.
 */
export function applyFinality(core: Verification, finality: DocumentFinality): Verification {
  const s7 = finalityLayer(finality);
  const at = core.layers.findIndex((l) => l.verdict === 'not_in_document');
  const layers = at < 0 ? [...core.layers, s7] : [...core.layers.slice(0, at), s7, ...core.layers.slice(at)];
  const inScope = layers.filter((l) => l.verdict !== 'not_in_document');
  const overall: Overall = inScope.some((l) => l.verdict === 'failed') ? 'failed' : inScope.every((l) => l.verdict === 'verified') ? 'verified' : 'partial';
  const covered = overall === 'verified' ? [...COVERED_STATEMENTS, `S7(${levelName(finality.headline ?? 0)})`] : [];
  const failure = core.failure ?? (s7.verdict === 'failed' ? { layer: s7.id, message: s7.reason ?? 'the finality section does not verify' } : undefined);
  return {
    overall,
    independent: overall === 'verified',
    layers,
    covers: covered,
    notCovered: overall === 'verified' ? NOT_COVERED_STATEMENTS.filter((x) => x !== 'S7') : [...COVERED_STATEMENTS, ...NOT_COVERED_STATEMENTS],
    ...(core.report ? { report: core.report } : {}),
    finality,
    ...(failure ? { failure } : {}),
    ...(core.govRootV3 ? { govRootV3: core.govRootV3 } : {}),
  };
}

/** The S7 layer: verified (VERIFIED, exit 0), not_checked (SUMMARY-ONLY, exit 3) or failed (FAILED, exit 1), with the levels it judged. */
function finalityLayer(f: DocumentFinality): Layer {
  const base = { id: 'S7', statement: 'S7', title: 'Staged finality of the settled leg, judged against the Settlement the caller named' };
  const lines = f.text.split('\n');
  const head = lines.findIndex((l) => /^(FAILED|SUMMARY-ONLY|VERIFIED) \(finality\)/.test(l));
  const why = (head >= 0 ? lines.slice(head + 1) : lines).map((l) => l.trim()).filter((l) => l !== '').join(' ');
  const rep = f.report;
  const evidence: Record<string, unknown> = { class: f.class, exit: f.exit };
  if (rep) {
    evidence.headline = levelName(rep.headline);
    evidence.block = { chain: String(rep.block.chain), number: String(rep.block.number), hash: hexLower(rep.block.hash) };
    evidence.pins = { sha256: rep.pinsSha256, source: rep.pinsSource };
    evidence.levels = Object.fromEntries(
      LEVELS.map((l) => {
        const st = rep.levels.get(l);
        return [levelName(l), { status: st?.status ?? 'absent', ...(st?.state ? { state: st.state.toString() } : {}) }];
      }),
    );
  } else if (f.state) {
    evidence.state = f.state.toString();
  }
  if (f.class === 'verified') return { ...base, verdict: 'verified', evidence };
  return { ...base, verdict: f.class === 'failed' ? 'failed' : 'not_checked', evidence, reason: why };
}

function verifyCore(doc: unknown, opts: VerifyOptions): Verification {
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
  } else if (report.setVerdict !== 'verified') {
    // govRoot v3 commits a validator set proven from genesis (it fails closed on anything weaker, as Go does). A set that changed after genesis is a
    // capability limit of the evidence, not a tamper, so this is not_checked and the overall result is partial, never failed.
    layers.push({ ...grBase, verdict: 'not_checked', evidence: { setVerdict: report.setVerdict }, reason: `the validator set is ${String(report.setVerdict)}, not verified from genesis, so govRoot v3 cannot be derived` });
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
