/**
 * `@certen.io/sdk/verify`: verify a CERTEN proof instead of trusting a flag in it.
 *
 * A separate entry point, so the API client does not pull in the verifier (and its Accumulate encoder). It needs the
 * optional peer `@certen.io/proof-verify`; without it the import fails at once, naming the package.
 *
 * `verifyBundle` takes a proof bundle (or the proof v2 portable document itself) and returns one verdict per layer:
 *
 *   - the Accumulate side (trust base, L1-L4, G0, G1, the validator set, govRoot v3) is checked from the portable document
 *     `@certen.io/proof-verify` understands, and
 *   - the execution outcome (S6) from the bundle's own execution component, with the destination chain's block header
 *     when the caller supplies it.
 *
 * Nothing here reads a `verified` field of a bundle as a verdict. The bundle's own statements are returned under
 * `bundleStatements`, labelled as what the validators claimed, so a caller can show them and can see they were not used.
 */
import { decodeSharedBundle } from './shared-proof.js';
import {
  noEvidence,
  verifyProofDocument,
  PORTABLE_FORMAT,
  COVERED_STATEMENTS,
  NOT_COVERED_STATEMENTS,
  type Layer,
  type Verification,
  type VerifyOptions,
} from '@certen.io/proof-verify';
import { checkAgainstHeader, executionComponentOf, verifyExecutionProof, type ExecutionVerification } from './execution-proof.js';
import { CertenError } from './errors.js';
import { checkEvmRpcEndpoint, readEvmBlockHeader } from './evm-rpc.js';
import { checkNativeTransferEffect, type ReceiptEffect, type RecipientSnapshot } from './effect.js';
import { intentOutcome } from './intent-states.js';
import { assembleReceipt, type Receipt, type ReceiptProofInput, type ReceiptRequest, type ReceiptSigner } from './receipt.js';
import type { CertenClient } from './client.js';
import type { ChainReceipt, ChainsListResponse, TransactionResponse } from './types.js';

export * from '@certen.io/proof-verify';

/** Why a live proof has no portable document: the gateway route that serves it is not there (RB7b-F30). */
export const PROOF_V2_EVIDENCE_NOT_SERVED = 'PROOF_V2_EVIDENCE_NOT_SERVED';

export interface VerifyBundleOptions extends VerifyOptions {
  /** An event the execution receipt must contain. */
  expect?: { address?: string; topic0?: string; topic1?: string };
  /** The block header (number, hash, receiptsRoot) from the destination chain's own RPC. Without it the receipts root is the validators' statement. */
  header?: { hash?: string; receiptsRoot?: string; number?: string };
}

/** The execution component's verification as plain JSON (no bigint), so a result can be printed or returned as it is. */
export interface ExecutionSummary {
  ok: boolean;
  chainId: string;
  txHash: string;
  blockNumber: number;
  blockHash?: string;
  receiptsRoot: string;
  transactionIndex: number;
  status?: number;
  logs: { address: string; topics: string[]; data: string }[];
  expectedLogFound?: boolean;
  caveats: string[];
  error?: string;
}

function summarise(v: ExecutionVerification): ExecutionSummary {
  return {
    ok: v.ok, chainId: v.chainId, txHash: v.txHash, blockNumber: v.blockNumber, ...(v.blockHash ? { blockHash: v.blockHash } : {}), receiptsRoot: v.receiptsRoot,
    transactionIndex: v.transactionIndex, ...(v.receipt ? { status: v.receipt.status } : {}), logs: v.receipt?.logs ?? [],
    ...(v.expectedLogFound !== undefined ? { expectedLogFound: v.expectedLogFound } : {}), caveats: v.caveats, ...(v.error ? { error: v.error } : {}),
  };
}

export interface BundleVerification extends Verification {
  /** The execution component's verification, when the bundle carries one. */
  execution: ExecutionSummary | null;
  /** The block-header comparison, when a header was supplied. */
  headerCheck: { ok: boolean; reasons: string[] } | null;
  /** What the bundle itself says about its verification. Reported, never used. */
  bundleStatements: { verified?: unknown; chainedProofVerified?: unknown };
  /** True when the portable document was found in the input. */
  evidenceFound: boolean;
}

/** The portable document in whatever the caller has: the document itself, or a bundle that embeds it as `proof_v2`. */
export function portableDocumentOf(input: unknown): Record<string, unknown> | null {
  const o = input && typeof input === 'object' ? (input as Record<string, unknown>) : null;
  if (!o) return null;
  if (o.format === PORTABLE_FORMAT) return o;
  const inner = (o.bundle && typeof o.bundle === 'object' ? (o.bundle as Record<string, unknown>) : o).proof_v2;
  return inner && typeof inner === 'object' ? (inner as Record<string, unknown>) : null;
}

export function verifyBundle(input: unknown, opts: VerifyBundleOptions = {}): BundleVerification {
  const doc = portableDocumentOf(input);
  const base: Verification = doc
    ? verifyProofDocument(doc, opts)
    : noEvidence(`${PROOF_V2_EVIDENCE_NOT_SERVED}: the input carries no proof v2 portable document, so the Accumulate side cannot be checked here`);

  const component = executionComponentOf(input);
  let execution: ExecutionSummary | null = null;
  let headerCheck: BundleVerification['headerCheck'] = null;
  let outcome: Layer;
  const outcomeBase = { id: 'outcome', statement: 'S6', title: 'The execution on the destination chain' };
  if (!component) {
    outcome = { ...outcomeBase, verdict: 'not_checked', evidence: {}, reason: 'the bundle carries no execution proof (component 5); read the destination chain' };
  } else {
    const raw = verifyExecutionProof(component, opts.expect);
    if (opts.header && raw.ok) headerCheck = checkAgainstHeader(raw, opts.header);
    execution = summarise(raw);
    const evidence = { chainId: raw.chainId, transaction: raw.txHash, block: raw.blockNumber, receiptsRoot: raw.receiptsRoot, status: raw.receipt?.status, expectedEventFound: raw.expectedLogFound ?? null, headerChecked: headerCheck?.ok ?? null };
    if (!raw.ok) outcome = { ...outcomeBase, verdict: 'failed', evidence, reason: raw.error ?? 'the receipt does not verify' };
    else if (raw.expectedLogFound === false) outcome = { ...outcomeBase, verdict: 'failed', evidence, reason: 'the expected event is not in the receipt' };
    else if (headerCheck && !headerCheck.ok) outcome = { ...outcomeBase, verdict: 'failed', evidence, reason: `the block header from your RPC disagrees: ${headerCheck.reasons.join('; ')}` };
    else if (!headerCheck) outcome = { ...outcomeBase, verdict: 'not_checked', evidence, reason: 'the receipt is in the bundle\'s receipts root, which is still the validators\' statement until it is compared with a block header from your own RPC' };
    else outcome = { ...outcomeBase, verdict: 'verified', evidence };
  }

  const layers = base.layers.map((l) => (l.id === 'outcome' ? outcome : l));
  const inScope = layers.filter((l) => l.verdict !== 'not_in_document');
  const anyFailed = inScope.some((l) => l.verdict === 'failed');
  const allVerified = inScope.every((l) => l.verdict === 'verified');
  const overall: Verification['overall'] = !doc && !component ? 'no_evidence' : anyFailed ? 'failed' : allVerified ? 'verified' : 'partial';
  const verified = overall === 'verified';
  const failedLayer = layers.find((l) => l.verdict === 'failed');

  const bundle = (input && typeof input === 'object' ? (((input as Record<string, unknown>).bundle as Record<string, unknown> | undefined) ?? (input as Record<string, unknown>)) : {}) as Record<string, unknown>;
  const chained = (bundle.proof_components as Record<string, Record<string, unknown>> | undefined)?.['3_chained_proof'];
  return {
    ...base,
    overall,
    independent: verified,
    layers,
    covers: verified ? [...COVERED_STATEMENTS, 'S6'] : [],
    notCovered: verified ? NOT_COVERED_STATEMENTS.filter((s) => s !== 'S6') : [...COVERED_STATEMENTS, ...NOT_COVERED_STATEMENTS],
    ...(failedLayer ? { failure: { layer: failedLayer.id, message: failedLayer.reason ?? 'failed' } } : {}),
    execution,
    headerCheck,
    bundleStatements: { verified: bundle.verified, chainedProofVerified: chained?.verified },
    evidenceFound: Boolean(doc),
  };
}

// ── fetching the evidence for a live target ─────────────────────────────────────────────────────────

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX64 = /^(0x)?[0-9a-f]{64}$/i;

export interface LoadedEvidence {
  /** The bundle, when the gateway served one as JSON. */
  bundle: Record<string, unknown> | null;
  /** Why there is no bundle: the gateway served none, or served bytes that are not JSON. Reported; never replaced by a guess. */
  bundleError: string | null;
  /** The proof v2 portable document, when the gateway served one. */
  portable: unknown;
  /** Why there is no portable document: PROOF_V2_EVIDENCE_NOT_SERVED (none for this proof) or PROOF_SERVICE_UNAVAILABLE (a 5xx; not the same as none). */
  notServed: { code: string; reason: string } | null;
  /** The gateway's own receipt, fetched for information only. It is never part of a verdict. */
  gateway: ChainReceipt | null;
}

/**
 * Fetch what a verifier needs for an intent id, a proof id or an Accumulate transaction hash: the bundle, the portable
 * document, and (for information only) the gateway's receipt. A missing document is returned as `notServed`, never thrown, and
 * never replaced by anything the gateway merely asserts.
 */
export async function loadProofEvidence(
  client: CertenClient,
  target: string,
  /** The intent, when the caller has just read it (a wait ends holding one): the target is then not read a second time. */
  known?: { proof_id?: string | null; accum_tx_hash?: string | null },
): Promise<LoadedEvidence> {
  let proofId: string | undefined;
  let txHash: string | undefined;
  if (HEX64.test(target)) {
    txHash = target.replace(/^0x/, '');
  } else if (UUID.test(target)) {
    try {
      const intent = known ?? ((await client.transaction.get(target)) as unknown as { proof_id?: string; accum_tx_hash?: string });
      proofId = intent.proof_id || undefined;
      txHash = intent.accum_tx_hash?.match(/([a-f0-9]{64})/i)?.[1];
    } catch (err) {
      if (err instanceof CertenError && err.status === 404) proofId = target; // not an intent: a proof id
      else throw err;
    }
  } else {
    throw new CertenError(`"${target}" is not a proof id, an intent id, or a transaction hash. Pass a UUID or a 64-character hex hash.`, 0, 'INVALID_PROOF_TARGET');
  }
  if (!proofId && !txHash) {
    throw new CertenError(`Nothing to verify for ${target}: it has neither a proof id nor an Accumulate transaction hash.`, 0, 'NOTHING_TO_VERIFY');
  }

  let bundle: Record<string, unknown> | null = null;
  let bundleError: string | null = null;
  let portable: unknown = null;
  let notServed: LoadedEvidence['notServed'] = null;
  if (proofId) {
    try {
      const raw = await client.proof.bundle(proofId);
      // The bytes decide, not the content type: the gateway serves a JSON bundle as application/octet-stream (it streams whatever the
      // proof service stored), and a bundle can be gzip-compressed. Refusing on the header would drop the execution component from a bundle
      // that has one, and report an outcome layer as unchecked for the wrong reason.
      const parsed = decodeSharedBundle({ data: Array.from(raw.data) });
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) bundle = parsed;
      else bundleError = `the gateway served the bundle as ${raw.contentType}, and its bytes are not a JSON proof bundle this tool can read`;
    } catch (err) {
      if (!(err instanceof CertenError) || err.status < 400) throw err; // the bundle may be unavailable; the document is asked for separately
      bundleError = `the bundle could not be fetched (${err.status})`;
    }
    try {
      portable = await client.proof.portable(proofId);
    } catch (err) {
      if (!(err instanceof CertenError)) throw err;
      if (err.code === PROOF_V2_EVIDENCE_NOT_SERVED) notServed = { code: err.code, reason: err.message };
      else if (err.status >= 500) notServed = { code: 'PROOF_SERVICE_UNAVAILABLE', reason: `the proof service answered ${err.status}, so no proof v2 document could be fetched (that is not the same as there being none)` };
      else throw err;
    }
  } else {
    notServed = { code: PROOF_V2_EVIDENCE_NOT_SERVED, reason: 'this transaction has no proof id, so the gateway holds no proof v2 document for it' };
  }
  let gateway: ChainReceipt | null = null;
  if (txHash) {
    try { gateway = await client.proof.receipt(txHash); } catch { gateway = null; }
  }
  return { bundle, bundleError, portable, notServed, gateway };
}

/** The input verifyBundle takes for loaded evidence. */
export function bundleInputOf(e: Pick<LoadedEvidence, 'bundle' | 'portable'>): unknown {
  return e.portable ? { ...(e.bundle ?? {}), proof_v2: e.portable } : e.bundle;
}

// ── checking loaded evidence ────────────────────────────────────────────────────────────────────────

export interface VerifyEvidenceOptions {
  /** A JSON-RPC endpoint of the execution chain you trust: the bundle's receipts root and block hash are compared with the header it returns. */
  rpc?: string;
  /** An event the execution receipt must contain. */
  expect?: { address?: string; topic0?: string; topic1?: string };
  /** A govRoot v3 to compare the one computed here with. */
  expectGovRoot?: string;
  /** Injectable for tests; defaults to the platform `fetch`. */
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/**
 * Verify evidence that has been loaded (from the gateway, a file or a share link), with the caller's own node closing the execution layer.
 *
 * This is the part of `certen proof verify` that used to live inline in the CLI: fetch the header of the block the bundle says the action ran
 * in, from a node the caller named, and hand it to `verifyBundle`, which compares the receipts root and block hash. It is here so the CLI's
 * `proof verify`, `send`, `watch` and `receipt` cannot disagree about what a header check means.
 *
 * It does NOT ask the node which chain it is on: the comparison of block hash and receipts root fails for another chain's block, which is
 * `failed` with the reason. A node that cannot be reached throws (`EVM_RPC_UNREADABLE`), and so does one that has no such block or sends no
 * receipts root (`EVM_RPC_NO_BLOCK`): a person who asked for an independent check must not be handed a result that quietly lacks it, and
 * "the node compared nothing" is never "the node agrees".
 */
export async function verifyEvidence(
  evidence: Pick<LoadedEvidence, 'bundle' | 'portable'>,
  options: VerifyEvidenceOptions = {},
): Promise<BundleVerification & { nodeConsulted: boolean }> {
  const component = evidence.bundle ? executionComponentOf(evidence.bundle) : null;
  let header: { hash?: string; receiptsRoot?: string; number?: string } | undefined;
  if (options.rpc && component) {
    const first = verifyExecutionProof(component, options.expect);
    if (first.ok) {
      const node = { rpc: options.rpc, fetch: options.fetch, timeoutMs: options.timeoutMs };
      header = await readEvmBlockHeader(node, first.blockNumber);
      // A node with no such block, or one that sends a header without the receipts root, has compared NOTHING. The old fallback handed
      // `verifyBundle` a bare `{ number }`, which `checkAgainstHeader` passes (the number matches what was asked), so a node that did not
      // have the block made the execution layer read VERIFIED. It is an error instead: not "the proof disagrees" (a pruned or lagging node
      // says nothing about the proof) and never a pass. Only the host is named: the URL can carry the node's key.
      if (!header || !header.receiptsRoot) {
        const { host } = checkEvmRpcEndpoint(options.rpc);
        throw new CertenError(
          header
            ? `certen: the node at ${host} sent the header of block ${first.blockNumber} without a receipts root, so nothing could be compared with the proof.`
            : `certen: the node at ${host} has no block ${first.blockNumber} (it may be pruned, lagging or on another network), so nothing could be compared with the proof.`,
          0, 'EVM_RPC_NO_BLOCK', { details: { host, block: first.blockNumber } },
        );
      }
    }
  }
  const v = verifyBundle(bundleInputOf(evidence), { expect: options.expect, header, expectGovRoot: options.expectGovRoot });
  return Object.assign(v, { nodeConsulted: header !== undefined });
}

// ── the receipt ─────────────────────────────────────────────────────────────────────────────────────

export interface BuildReceiptOptions {
  /** The gateway's address, recorded in the receipt. */
  gateway?: string | null;
  /** What was asked for. Kept from `previous` when omitted. */
  request?: ReceiptRequest | null;
  signedWith?: ReceiptSigner | null;
  /** The receipt as it was last saved: its creation time, request and pre-signing snapshot are kept. */
  previous?: Receipt | null;
  /** The intent as the caller last read it (a wait ends holding one), so it is not read again. */
  transaction?: TransactionResponse;
  /** The chain registry, when the caller holds it (for explorer links). Read once if omitted; a registry that cannot be read only costs the links. */
  registry?: ChainsListResponse | null;
  /** A node you trust on the execution chain: closes the proof's execution layer, and reads the recipient's balance. */
  rpc?: string;
  /** An event the execution receipt must contain. */
  expect?: { address?: string; topic0?: string; topic1?: string };
  /** The recipient's balance taken before signing. */
  snapshot?: RecipientSnapshot | null;
  /** The abstract account's native balance (whole units) before signing and now, as the gateway reports them. */
  sender?: { address: string; before: string | null; after: string | null };
  fetch?: typeof fetch;
  timeoutMs?: number;
  now?: () => Date;
}

/**
 * Everything known about one intent, in one record: what happened, the ids to keep, whether the proof holds, and whether the value arrived.
 *
 * The steps, each of which may fail without failing the receipt (a gap is data, and is named in `gaps`):
 *  1. read the intent (unless the caller just did);
 *  2. if it completed, load its proof evidence and verify it HERE with `verifyBundle`, never taking a flag in the bundle as a verdict;
 *  3. with a node of the caller's, compare the proof's block header and read the recipient's balance;
 *  4. assemble the record (`assembleReceipt`, pure).
 *
 * It reads and verifies; it signs and sends nothing. A proof that cannot be fetched is `unavailable`, which is a gap and not a verdict.
 */
export async function buildReceipt(client: CertenClient, intentId: string, options: BuildReceiptOptions = {}): Promise<Receipt> {
  const transaction = options.transaction ?? (await client.transaction.get(intentId));
  const outcome = intentOutcome(transaction);
  const request = options.request ?? options.previous?.request ?? null;

  let proof: ReceiptProofInput | null = null;
  let verification: (BundleVerification & { nodeConsulted: boolean }) | null = null;
  if (outcome.outcome === 'completed') {
    let evidence: LoadedEvidence | null = null;
    let unavailable: string | null = null;
    try {
      evidence = await loadProofEvidence(client, intentId, transaction);
    } catch (err) {
      if (!(err instanceof CertenError)) throw err;
      unavailable = err.message.replace(/^certen: /, '');
    }
    // The proof service answering 5xx is "unavailable", which is not "there is none": `loadProofEvidence` reports it as not served, and reading
    // that as NO EVIDENCE would tell someone their proof does not exist when the service had a bad moment (and would skip the retry).
    if (evidence && !evidence.bundle && !evidence.portable && evidence.notServed?.code === 'PROOF_SERVICE_UNAVAILABLE') {
      unavailable = evidence.notServed.reason;
      evidence = null;
    }
    if (evidence) {
      let nodeError: string | null = null;
      try {
        verification = await verifyEvidence(evidence, { rpc: options.rpc, expect: options.expect, fetch: options.fetch, timeoutMs: options.timeoutMs });
      } catch (err) {
        // The node was asked for and could not be used. The proof is still checked, without it, and the gap names why.
        if (!(err instanceof CertenError)) throw err;
        nodeError = err.message.replace(/^certen: /, '');
        verification = await verifyEvidence(evidence, { expect: options.expect });
      }
      proof = {
        verification, notServed: evidence.notServed, bundleError: evidence.bundleError, nodeConsulted: verification.nodeConsulted, nodeError,
      };
    } else {
      proof = { verification: null, unavailable };
    }
  }

  // The effect, once there is something to compare. A transfer is judged from the recipient's side with the caller's node; a call by the
  // event it was told to expect.
  let effect: ReceiptEffect | null = null;
  if (request?.kind === 'transfer' && request.amount && request.to) {
    effect = outcome.outcome === 'completed'
      ? await checkNativeTransferEffect({
        chain: request.chain, recipient: request.to, amount: request.amount, rpc: options.rpc,
        atBlock: verification?.execution?.ok ? verification.execution.blockNumber : undefined,
        before: options.snapshot ?? options.previous?.recipient_snapshot ?? undefined,
        sender: options.sender, fetch: options.fetch, timeoutMs: options.timeoutMs,
      })
      : { kind: 'native_transfer', state: 'unchecked', amount: request.amount, detail: 'Not checked yet: the transfer has not completed.' };
  } else if (request?.kind === 'contract_call' && options.expect && outcome.outcome === 'completed') {
    const found = verification?.execution?.expectedLogFound ?? null;
    effect = {
      kind: 'contract_call', state: found === true ? 'confirmed' : found === false ? 'not_observed' : 'unchecked',
      detail: found === true ? 'The expected event is in the proof\'s receipt.' : found === false ? 'The expected event is NOT in the proof\'s receipt.' : 'The expected event could not be looked for: the proof carries no execution receipt.',
      expected_event: { found },
    };
  }

  let registry = options.registry ?? null;
  if (registry === null && options.registry === undefined) {
    try { registry = await client.chains.list(); } catch { registry = null; }
  }

  return assembleReceipt({
    intentId, transaction, request, signedWith: options.signedWith, gateway: options.gateway, registry, proof, effect,
    snapshot: options.snapshot, previous: options.previous, now: options.now,
  });
}
