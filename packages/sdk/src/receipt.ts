import type { CertenClient } from './client.js';
import { chainInfo, chainSlug, gasReserveFor, nativeSymbolFor } from './chains.js';
import { describeReasonCode } from './reason-codes.js';
import { intentOutcome, type IntentOutcomeName, type IntentStatusClass } from './intent-states.js';
import { noEffectToCheck, type ReceiptEffect, type RecipientSnapshot } from './effect.js';
import type { ChainsListResponse, TransactionResponse } from './types.js';

/**
 * The receipt: the one record the docs have always told people to keep, assembled for them.
 *
 * After a transfer the walkthrough sent a person to four commands (`tx status`, `proof get`, `proof verify`, `proof verify --rpc`) and a
 * hand-comparison, to find out what happened and to write down the intent id, the Accumulate transaction, the destination transaction and
 * the proof. Every one of those facts was already in a response. This puts them in one document, says which are established and which are
 * not, and gives the document a version so a script can rely on its shape.
 *
 * **This module is pure.** It takes what was fetched and verified and returns the record; it makes no request. The fetching and the
 * verifying are `buildReceipt` in `@certen.io/sdk/verify`, which needs the verifier, and nothing here does.
 *
 * **The verdict is the weakest honest reading, and it has five values** (`ReceiptVerdict`):
 *  - `verified`: the action completed, the proof verifies, and nothing the receipt checked contradicts it;
 *  - `partial`: it completed, and something is not established. The gaps are named, one by one, in `gaps`. PARTIAL and NO EVIDENCE are
 *    never shown as verified, here or anywhere that renders this;
 *  - `failed`: the intent failed, or a layer of the proof was checked and does not hold;
 *  - `pending`: it has not finished, or it executed and the proof is still being produced;
 *  - `unproven`: it executed and its proof can never be produced (declared by an operator). Nothing can be verified, and it says so.
 *
 * **Unknown is not OK.** A proof that could not be fetched is `unavailable`, a recipient that could not be read is `unreadable`; neither is
 * ever turned into `verified` or `confirmed` by the absence of bad news.
 */

export const RECEIPT_VERSION = 1;

export type ReceiptVerdict = 'verified' | 'partial' | 'failed' | 'pending' | 'unproven';
export type ProofVerdict = 'verified' | 'partial' | 'failed' | 'no_evidence' | 'pending' | 'unavailable' | 'not_applicable';
export type StageState = 'done' | 'pending' | 'failed' | 'unknown' | 'skipped';

export interface ReceiptRequest {
  kind: 'transfer' | 'contract_call' | 'intent';
  chain: string;
  chain_id: number | null;
  identity_id: string;
  adi_url: string | null;
  from: string | null;
  to: string | null;
  /** Whole units; null for a call that forwards no value or a request that is not a transfer. */
  amount: string | null;
  asset: string | null;
  contract_call: { target: string; function_signature: string; value_wei: string } | null;
}

export interface ReceiptSigner {
  key: string | null;
  public_key_hash: string | null;
}

export interface ReceiptStage {
  id: 'signed' | 'anchored' | 'executed' | 'proof_verified';
  label: string;
  state: StageState;
  detail?: string;
}

export interface ReceiptProofLayer {
  id: string;
  title: string;
  verdict: 'verified' | 'failed' | 'not_checked' | 'not_in_document';
  reason?: string;
  /** The statement of the proof format this layer establishes (`S6`), when the verifier names one. */
  statement?: string;
  /** What it was checked against (hashes, heights, counts). For `certen receipt --explain`. */
  evidence?: Record<string, unknown>;
}

export interface ReceiptProof {
  verdict: ProofVerdict;
  detail: string;
  /** True only when a verifier ran in this process over bytes the gateway served. */
  checked_here: boolean;
  /** True when the bundle's receipts root and block hash were compared with a header from a node the caller named. */
  node_checked: boolean;
  layers: ReceiptProofLayer[];
  /** Layers the document carries (everything not `not_in_document`), and how many of those were verified. */
  layers_total: number;
  layers_verified: number;
  layers_not_carried: number;
  /** The carried layers that are not established, with the reason each gives. */
  not_established: Array<{ id: string; title: string; reason: string }>;
  proof_id: string | null;
  evidence: { found: boolean; code?: string; reason?: string; bundle_error?: string };
}

export interface ReceiptGap {
  code:
    | 'INTENT_NOT_TERMINAL' | 'PROOF_PENDING' | 'PROOF_NOT_FETCHED' | 'PROOF_NO_EVIDENCE' | 'PROOF_LAYER_NOT_ESTABLISHED' | 'PROOF_LAYER_FAILED'
    | 'NODE_NOT_CONSULTED' | 'EFFECT_UNCHECKED' | 'EFFECT_UNREADABLE' | 'EFFECT_NOT_OBSERVED';
  text: string;
}

export interface Receipt {
  receipt_version: typeof RECEIPT_VERSION;
  intent_id: string;
  kind: ReceiptRequest['kind'] | 'unknown';
  created_at: string;
  updated_at: string;
  gateway: string | null;
  request: ReceiptRequest | null;
  signed_with: ReceiptSigner | null;
  status: {
    gateway_status: string;
    class: IntentStatusClass;
    outcome: IntentOutcomeName;
    terminal: boolean;
    reason_code: string | null;
    reason: string | null;
    completion_basis: string | null;
    validator_state: string | null;
  };
  ids: {
    intent_id: string;
    accumulate_tx: string | null;
    accumulate_tx_hash: string | null;
    destination_tx: string | null;
    /** Where the destination hash came from: the verified execution proof, or the validators' own record. Never a guess. */
    destination_tx_source: 'proof' | 'validators' | null;
    destination_chain: string | null;
    destination_block: number | null;
    proof_id: string | null;
    write_back_tx: string | null;
  };
  links: { destination_tx: string | null; accumulate_explorer: string | null };
  stages: ReceiptStage[];
  effect: ReceiptEffect;
  proof: ReceiptProof;
  verdict: ReceiptVerdict;
  /** One line, in plain words, that a person can read instead of the rest. */
  headline: string;
  /** What is not established, one entry each. Empty exactly when `verdict` is `verified` (or `unproven`, where nothing can be). */
  gaps: ReceiptGap[];
  /** The recipient's balance taken before signing, kept so a later `receipt --rpc` can still measure the rise. */
  recipient_snapshot: RecipientSnapshot | null;
}

/** What `verifyBundle` (from `@certen.io/sdk/verify`) returns, in the part this module reads. Structural, so no verifier is imported here. */
export interface VerificationLike {
  overall: 'verified' | 'partial' | 'failed' | 'no_evidence';
  layers: Array<{
    id: string; title: string; verdict: 'verified' | 'failed' | 'not_checked' | 'not_in_document'; reason?: string;
    statement?: string; evidence?: Record<string, unknown>;
  }>;
  failure?: { layer: string; message: string };
  evidenceFound: boolean;
  execution?: { ok: boolean; txHash: string; blockNumber: number; chainId: string } | null;
  headerCheck?: { ok: boolean } | null;
}

export interface ReceiptProofInput {
  /** The verdict, or null when no verification was attempted or it could not be. */
  verification: VerificationLike | null;
  /** The gateway served no portable document: why. */
  notServed?: { code: string; reason: string } | null;
  bundleError?: string | null;
  /** The evidence could not be fetched at all (a network failure, a 5xx): why. Not the same as there being none. */
  unavailable?: string | null;
  /** A header from the caller's own node was compared. */
  nodeConsulted?: boolean;
  /** A node was given and could not be used (unreachable, or not answering as a node): why. The proof was checked without it. */
  nodeError?: string | null;
}

export interface AssembleReceiptInput {
  intentId: string;
  transaction: TransactionResponse;
  request?: ReceiptRequest | null;
  signedWith?: ReceiptSigner | null;
  gateway?: string | null;
  registry?: Pick<ChainsListResponse, 'accumulate' | 'chains'> | null;
  proof?: ReceiptProofInput | null;
  effect?: ReceiptEffect | null;
  snapshot?: RecipientSnapshot | null;
  /** An earlier receipt for the same intent: its creation time and request are kept, so a refresh never forgets what was asked. */
  previous?: Receipt | null;
  now?: () => Date;
}

const HEX64 = /([a-f0-9]{64})/i;

const proofIdOf = (tx: TransactionResponse): string | null => (typeof tx.proof_id === 'string' && tx.proof_id ? tx.proof_id : null);

function explorerTxUrl(registry: AssembleReceiptInput['registry'], chain: string | null, hash: string | null): string | null {
  if (!registry || !chain || !hash) return null;
  // A registry that came back malformed costs the link and nothing else: a receipt must not fail to exist because an explorer URL could not be built.
  const entry = Array.isArray(registry.chains) ? registry.chains.find((c) => chainSlug(c.id) === chainSlug(chain)) : undefined;
  // Only an EVM explorer has a path this module is sure of; other families differ enough that a guessed path would 404.
  if (!entry || entry.family !== 'evm' || !entry.explorer) return null;
  return `${entry.explorer.replace(/\/+$/, '')}/tx/${hash}`;
}

/** The weakest honest reading of the proof, from what was fetched and verified. */
function proofOf(
  outcome: ReturnType<typeof intentOutcome>,
  input: ReceiptProofInput | null | undefined,
  proofId: string | null,
): ReceiptProof {
  const base = { proof_id: proofId, layers: [] as ReceiptProofLayer[], layers_total: 0, layers_verified: 0, layers_not_carried: 0, not_established: [] as ReceiptProof['not_established'] };
  const noEvidence = (extra: Partial<ReceiptProof['evidence']> = {}): ReceiptProof['evidence'] => ({ found: false, ...extra });

  if (outcome.outcome === 'failed') {
    return { ...base, verdict: 'not_applicable', detail: 'The intent failed, so there is no execution to prove.', checked_here: false, node_checked: false, evidence: noEvidence() };
  }
  if (outcome.outcome === 'completed_unproven') {
    return {
      ...base, verdict: 'not_applicable', checked_here: false, node_checked: false, evidence: noEvidence(),
      detail: 'The action executed and its proof can never be produced (declared by an operator with the evidence). Nothing can be verified for it.',
    };
  }
  if (outcome.outcome === 'pending' || outcome.outcome === 'unknown') {
    return { ...base, verdict: 'pending', detail: 'The intent has not finished, so there is nothing to prove yet.', checked_here: false, node_checked: false, evidence: noEvidence() };
  }
  if (outcome.outcome === 'executed') {
    return { ...base, verdict: 'pending', detail: 'The action executed on its chain and its proof bundle is still being produced.', checked_here: false, node_checked: false, evidence: noEvidence() };
  }

  // completed: the proof is what makes that claim checkable.
  const v = input?.verification ?? null;
  if (!v) {
    const why = input?.unavailable ?? 'no verification was made';
    return { ...base, verdict: 'unavailable', detail: `The proof could not be checked: ${why}.`, checked_here: false, node_checked: false, evidence: noEvidence({ reason: why }) };
  }
  const layers: ReceiptProofLayer[] = v.layers.map((l) => ({
    id: l.id, title: l.title, verdict: l.verdict, ...(l.reason ? { reason: l.reason } : {}),
    ...(l.statement ? { statement: l.statement } : {}), ...(l.evidence && Object.keys(l.evidence).length > 0 ? { evidence: l.evidence } : {}),
  }));
  const carried = layers.filter((l) => l.verdict !== 'not_in_document');
  const verified = carried.filter((l) => l.verdict === 'verified').length;
  const notEstablished = carried.filter((l) => l.verdict === 'not_checked').map((l) => ({ id: l.id, title: l.title, reason: l.reason ?? 'not established' }));
  const evidence: ReceiptProof['evidence'] = {
    found: v.evidenceFound,
    ...(input?.notServed ? { code: input.notServed.code, reason: input.notServed.reason } : {}),
    ...(input?.bundleError ? { bundle_error: input.bundleError } : {}),
  };
  const common = {
    proof_id: proofId, layers, layers_total: carried.length, layers_verified: verified, layers_not_carried: layers.length - carried.length,
    not_established: notEstablished, checked_here: true, node_checked: Boolean(input?.nodeConsulted && v.headerCheck), evidence,
  };
  if (v.overall === 'verified') {
    return { ...common, verdict: 'verified', detail: `${verified} of ${carried.length} layers carried, all checked here from the proof's own bytes.` };
  }
  if (v.overall === 'failed') {
    return { ...common, verdict: 'failed', detail: `A layer was checked and does not hold: ${v.failure?.layer ?? 'unknown'}: ${v.failure?.message ?? 'failed'}.` };
  }
  if (v.overall === 'no_evidence') {
    return { ...common, verdict: 'no_evidence', detail: input?.notServed ? `${input.notServed.code}: ${input.notServed.reason}` : 'Nothing about the Accumulate side could be checked.' };
  }
  return {
    ...common, verdict: 'partial',
    detail: `${verified} of ${carried.length} layers carried are established; ${notEstablished.map((l) => l.id).join(', ') || 'a layer'} ${notEstablished.length === 1 ? 'is' : 'are'} not.`,
  };
}

function stagesOf(
  outcome: ReturnType<typeof intentOutcome>, tx: TransactionResponse, proof: ReceiptProof, ids: Receipt['ids'], chain: string | null,
): ReceiptStage[] {
  const on = chain ? ` on ${chain}` : '';
  const beyondSigning = !['created', 'signing_required', ''].includes(outcome.status);
  const failed = outcome.outcome === 'failed';
  const ranOnChain = outcome.outcome === 'executed' || outcome.outcome === 'completed' || outcome.outcome === 'completed_unproven';
  const hasAccum = Boolean(ids.accumulate_tx_hash);

  const signed: ReceiptStage = failed && !hasAccum
    ? { id: 'signed', label: 'signed', state: 'unknown', detail: 'the intent failed before an Accumulate transaction was recorded' }
    : { id: 'signed', label: 'signed', state: beyondSigning ? 'done' : 'pending' };
  const anchored: ReceiptStage = ranOnChain
    ? { id: 'anchored', label: 'anchored on Accumulate', state: 'done', ...(ids.accumulate_tx_hash ? { detail: ids.accumulate_tx_hash } : {}) }
    : failed ? { id: 'anchored', label: 'anchored on Accumulate', state: hasAccum ? 'unknown' : 'skipped' }
      : { id: 'anchored', label: 'anchored on Accumulate', state: beyondSigning ? 'pending' : 'skipped' };
  const executed: ReceiptStage = ranOnChain
    ? { id: 'executed', label: `executed${on}`, state: 'done', ...(ids.destination_tx ? { detail: ids.destination_tx } : {}) }
    : failed ? { id: 'executed', label: `executed${on}`, state: 'failed', detail: outcome.reason ? describeReasonCode(outcome.reason) ?? outcome.reason : (tx as { error_message?: string }).error_message ?? undefined }
      : { id: 'executed', label: `executed${on}`, state: 'pending' };
  const stateOfProof: StageState = proof.verdict === 'verified' ? 'done'
    : proof.verdict === 'failed' ? 'failed'
      : proof.verdict === 'pending' ? 'pending'
        : proof.verdict === 'not_applicable' ? 'skipped'
          : 'unknown';
  const verifiedStage: ReceiptStage = { id: 'proof_verified', label: 'proof verified locally', state: stateOfProof, ...(proof.verdict === 'verified' ? {} : { detail: proof.detail }) };
  return [signed, anchored, executed, verifiedStage];
}

/**
 * Put everything known about one intent into a receipt.
 *
 * Idempotent in the sense that matters: assembling again from fresher inputs (a proof that has since been served, a node that is now
 * given) replaces what was uncertain and keeps `created_at`, the request and the pre-signing snapshot.
 */
export function assembleReceipt(input: AssembleReceiptInput): Receipt {
  const now = (input.now?.() ?? new Date()).toISOString();
  const tx = input.transaction;
  const outcome = intentOutcome(tx);
  const previous = input.previous ?? null;
  const request = input.request ?? previous?.request ?? null;
  const proofId = proofIdOf(tx) ?? previous?.ids.proof_id ?? null;
  const proof = proofOf(outcome, input.proof, proofId);

  const verification = input.proof?.verification ?? null;
  const execution = verification?.execution && verification.execution.ok ? verification.execution : null;
  const members = tx.validator?.members ?? [];
  const settlement = members.find((m) => typeof m.settlement_tx === 'string' && m.settlement_tx)?.settlement_tx ?? null;
  const destinationTx = execution?.txHash ?? settlement ?? previous?.ids.destination_tx ?? null;
  const source: Receipt['ids']['destination_tx_source'] = execution?.txHash ? 'proof' : settlement ? 'validators' : previous?.ids.destination_tx ? previous.ids.destination_tx_source : null;
  const executionChain = execution ? chainInfo(execution.chainId)?.slug ?? null : null;
  const memberChain = members[0]?.chain_id !== undefined ? chainInfo(members[0].chain_id)?.slug ?? null : null;
  const destinationChain = request ? chainSlug(request.chain) : executionChain ?? memberChain ?? previous?.ids.destination_chain ?? null;
  const accumTx = typeof tx.accum_tx_hash === 'string' && tx.accum_tx_hash ? tx.accum_tx_hash : previous?.ids.accumulate_tx ?? null;
  const writeBack = tx.proofs?.find((p) => p.write_back_tx)?.write_back_tx ?? members.find((m) => m.write_back_tx)?.write_back_tx ?? previous?.ids.write_back_tx ?? null;

  const ids: Receipt['ids'] = {
    intent_id: input.intentId,
    accumulate_tx: accumTx,
    accumulate_tx_hash: accumTx ? accumTx.match(HEX64)?.[1]?.toLowerCase() ?? null : null,
    destination_tx: destinationTx,
    destination_tx_source: source,
    destination_chain: destinationChain,
    destination_block: execution?.blockNumber ?? previous?.ids.destination_block ?? null,
    proof_id: proofId,
    write_back_tx: writeBack,
  };

  // Nothing supplied is not "nothing to check": a transfer has an effect, and not looking at it is UNCHECKED, which keeps a receipt from being
  // verified. A call with no expected event, or an intent with no request on record, has nothing to compare, and says so.
  // Says what is true: a failed intent has nothing to compare; one that has not finished has not been looked at YET; only a finished transfer
  // that nobody checked is "not checked".
  const effect: ReceiptEffect = input.effect ?? previous?.effect ?? (request?.kind === 'transfer'
    ? outcome.outcome === 'failed'
      ? noEffectToCheck('The intent failed, so there is no transfer to check.')
      : { kind: 'native_transfer', state: 'unchecked', amount: request.amount ?? undefined, detail: outcome.outcome === 'completed' || outcome.outcome === 'completed_unproven'
        ? 'The effect of this transfer was not checked.' : 'Not checked yet: the transfer has not completed.' }
    : noEffectToCheck(request?.kind === 'contract_call'
      ? 'A contract call has no balance to compare; pass an expected event to check one.'
      : 'There is no request on record to check an effect against.'));

  const stages = stagesOf(outcome, tx, proof, ids, destinationChain);

  // ── gaps: what is not established, one by one ────────────────────────────────────────────────────────
  const gaps: ReceiptGap[] = [];
  if (outcome.outcome === 'pending' || outcome.outcome === 'unknown') {
    gaps.push({ code: 'INTENT_NOT_TERMINAL', text: `The intent is still ${outcome.status || 'unknown'}; it has not finished.` });
  } else if (outcome.outcome === 'executed') {
    gaps.push({ code: 'PROOF_PENDING', text: 'The action executed; its proof bundle is still being produced.' });
  } else if (outcome.outcome === 'completed') {
    if (proof.verdict === 'unavailable') gaps.push({ code: 'PROOF_NOT_FETCHED', text: proof.detail });
    if (proof.verdict === 'no_evidence') gaps.push({ code: 'PROOF_NO_EVIDENCE', text: proof.detail });
    if (proof.verdict === 'failed') gaps.push({ code: 'PROOF_LAYER_FAILED', text: proof.detail });
    const outcomeLayer = proof.layers.find((l) => l.id === 'outcome');
    const nodeGap = Boolean(outcomeLayer && outcomeLayer.verdict === 'not_checked' && !proof.node_checked);
    for (const l of proof.not_established) {
      // With no evidence at all every layer reads "not checked" for the one same reason, which PROOF_NO_EVIDENCE already states: eleven copies
      // of it would bury the single fact.
      if (proof.verdict === 'no_evidence') break;
      // The execution layer's own reason ("until it is compared with a header from your own RPC") is the node gap below, which says it with
      // the actionable cause; listing both would be the same fact twice.
      if (l.id === 'outcome' && nodeGap) continue;
      gaps.push({ code: 'PROOF_LAYER_NOT_ESTABLISHED', text: `${l.title} (${l.id}): ${l.reason}` });
    }
    if (nodeGap) {
      gaps.push({
        code: 'NODE_NOT_CONSULTED',
        text: input.proof?.nodeError
          ? `The node you gave could not be used (${input.proof.nodeError}), so the execution layer rests on the validators' own statement of the block.`
          : 'The execution layer rests on the validators\' own statement of the block until it is compared with a header from a node you trust.',
      });
    }
    if (effect.state === 'unchecked') gaps.push({ code: 'EFFECT_UNCHECKED', text: effect.detail });
    if (effect.state === 'unreadable') gaps.push({ code: 'EFFECT_UNREADABLE', text: effect.detail });
    if (effect.state === 'not_observed') gaps.push({ code: 'EFFECT_NOT_OBSERVED', text: effect.detail });
  }

  // ── the verdict: the weakest honest reading ─────────────────────────────────────────────────────────
  let verdict: ReceiptVerdict;
  let headline: string;
  if (outcome.outcome === 'failed') {
    verdict = 'failed';
    const why = outcome.reason ? describeReasonCode(outcome.reason) ?? outcome.reason : (tx as { error_message?: string }).error_message;
    headline = `FAILED: the intent ${outcome.status}${why ? `. ${why}` : ''}`;
  } else if (outcome.outcome === 'completed_unproven') {
    verdict = 'unproven';
    headline = 'EXECUTED, NOT PROVABLE: the action ran and its proof can never be produced. Nothing is verified for it.';
  } else if (outcome.outcome !== 'completed') {
    verdict = 'pending';
    headline = outcome.outcome === 'executed' ? 'PENDING: executed; the proof is still being produced' : `PENDING: the intent is ${outcome.status || 'not finished'}`;
  } else if (proof.verdict === 'failed') {
    verdict = 'failed';
    headline = `FAILED: ${proof.detail} Do not rely on this proof.`;
  } else if (proof.verdict === 'verified' && (effect.state === 'confirmed' || effect.state === 'not_applicable')) {
    verdict = 'verified';
    headline = `VERIFIED: ${proof.layers_verified} of ${proof.layers_total} layers carried, checked here`;
  } else if (proof.verdict === 'verified') {
    // The proof holds and the second look at the value does not agree, or could not be made. Unknown is not ok: a receipt that says VERIFIED
    // over a balance nobody read would be the lie this exists to avoid, so it is PARTIAL, naming which.
    verdict = 'partial';
    headline = `PARTIAL: the proof verifies, but ${effect.state === 'not_observed'
      ? 'the recipient\'s balance did not rise as expected'
      : effect.state === 'unreadable' ? 'the recipient\'s balance could not be read' : 'the recipient\'s balance was not checked'}`;
  } else {
    verdict = 'partial';
    headline = proof.verdict === 'partial' ? `PARTIAL: ${proof.detail}`
      : proof.verdict === 'no_evidence' ? `NO EVIDENCE: ${proof.detail}`
        : `PARTIAL: ${proof.detail}`;
  }

  return {
    receipt_version: RECEIPT_VERSION,
    intent_id: input.intentId,
    kind: request?.kind ?? previous?.kind ?? 'unknown',
    created_at: previous?.created_at ?? now,
    updated_at: now,
    gateway: input.gateway ?? previous?.gateway ?? null,
    request,
    signed_with: input.signedWith ?? previous?.signed_with ?? null,
    status: {
      gateway_status: outcome.status,
      class: outcome.class,
      outcome: outcome.outcome,
      terminal: outcome.terminal,
      reason_code: typeof tx.reason_code === 'string' && tx.reason_code ? tx.reason_code : null,
      reason: outcome.reason,
      completion_basis: typeof tx.completion_basis === 'string' && tx.completion_basis ? tx.completion_basis : null,
      validator_state: tx.validator?.state ?? null,
    },
    ids,
    links: {
      destination_tx: explorerTxUrl(input.registry, destinationChain, destinationTx),
      accumulate_explorer: input.registry?.accumulate?.explorer ?? null,
    },
    stages,
    effect,
    proof,
    verdict,
    headline,
    gaps,
    recipient_snapshot: input.snapshot ?? previous?.recipient_snapshot ?? null,
  };
}

// ── what it costs, as far as anyone has said ────────────────────────────────────────────────────────

export interface FeeEstimate {
  state: 'estimated' | 'unavailable';
  sku: string;
  chain: string;
  /** The platform's own fee, USD. Null when the price book has no entry. */
  platform_fee_usd: string | null;
  /** `flat` is all-in; `quoted` adds gas dynamically at execution, so this is the platform component only. */
  mode: string | null;
  max_charge_usd: string | null;
  /** The catalogue's gas reserve for the chain, whole native units: an estimate, not a quote. */
  gas_reserve: string | null;
  gas_symbol: string | null;
  price_book_version: string | null;
  /** Always says it is an estimate. */
  note: string;
}

/** The price-book entry for a proof-gated execution. */
export const EXECUTION_SKU = 'proof.execute';

/**
 * What a send will cost, as far as the gateway has published it.
 *
 * The price book, not a quote: `POST /v1/quote` creates a binding quote and the gateway publishes no per-execution gas figure (PLAN G5), so the
 * most that can be said before signing is the platform's own fee and a reserve for gas. Both are labelled estimates wherever they are shown.
 * Never throws: a price book that cannot be read is "unavailable", and the card says so rather than showing a number it does not have.
 */
export async function estimateFee(client: Pick<CertenClient, 'billing'>, chain: string): Promise<FeeEstimate> {
  const slug = chainSlug(chain);
  const gas = gasReserveFor(slug) ?? null;
  const symbol = nativeSymbolFor(slug) ?? null;
  const unavailable = (why: string, version: string | null = null): FeeEstimate => ({
    state: 'unavailable', sku: EXECUTION_SKU, chain: slug, platform_fee_usd: null, mode: null, max_charge_usd: null, gas_reserve: gas, gas_symbol: symbol,
    price_book_version: version, note: `Not available: ${why}. The fee is estimated only from the price book (certen pricing), never quoted.`,
  });
  try {
    const book = await client.billing.pricing();
    const items = (book.items ?? []).filter((i) => i.sku === EXECUTION_SKU);
    const item = items.find((i) => chainSlug(i.chain) === slug) ?? items.find((i) => i.chain === '*');
    if (!item) return unavailable(`the price book has no ${EXECUTION_SKU} entry for ${slug}`, book.price_book_version ?? null);
    return {
      state: 'estimated', sku: EXECUTION_SKU, chain: slug, platform_fee_usd: item.platform_fee_usd ?? null, mode: item.mode ?? null,
      max_charge_usd: item.max_charge_usd ?? null, gas_reserve: gas, gas_symbol: symbol, price_book_version: book.price_book_version ?? null,
      note: item.mode === 'quoted'
        ? 'An estimate from the price book: the platform fee only. Gas is priced when it executes, up to a ceiling.'
        : 'An estimate from the price book, not a binding quote.',
    };
  } catch (err) {
    return unavailable(err instanceof Error ? err.message.replace(/^certen: /, '') : 'the price book could not be read');
  }
}
