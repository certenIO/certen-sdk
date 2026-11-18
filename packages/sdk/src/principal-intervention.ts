/**
 * AGT-3 (transaction-controls docs/agentic/INTERVENTION.md sections 2, 3 and 5): the principal's interventions on an agent.
 *
 *   revokeGrant       the Grant superseded by a new version with an EMPTY validity (notAfter = notBefore), written through issueGrant
 *                     (so the core profile judges it first and the principal's own page signs it);
 *   revokeAgentKey    the owner's book removes the agent's key from the agent's key page: the existing governance remove_key, on the
 *                     agent's page, signed by the owner's own page (the gateway allows it only when the owner's book governs that book);
 *   cancelByRejectVote a required authority casts a REJECT vote on the pending Accumulate transaction (POST /v1/sign, vote reject), the
 *                     signing data rebuilt and matched to that transaction, vote and signer before the signature exists;
 *   replaceAgent      the old agent's registration retired, a new agent registered and its own Grant issued, by the principal.
 *
 * What none of these can do, stated with every result (DEC-2): before final approval a required authority's reject vote or key removal
 * stops the action; after certification exposure is limited to the exact approved action inside its window; there is no on-chain cancel.
 * A certified approval is never described as revoked.
 */
import { CertenError } from './errors.js';
import { checkCosigning, checkGovernanceSigning } from './signing-check.js';
import { hashGrant } from './core/hashes.js';
import { issueGrant, registerAgent, type PrincipalSigner, type PrincipalWriteResult } from './principal-entries.js';
import type { CertenClient } from './client.js';
import { resolveSignTarget } from './sign-target.js';

/** The revocation model in force (DEC-2), verbatim. Every revoke or cancel result carries it. */
export const EXPOSURE_WINDOW_STATEMENT =
  'Before final approval, a required authority\'s reject vote or key removal stops the action. After certification, exposure is limited to the exact approved action inside its window. No on-chain cancel.';

export const INTERVENTION_MALFORMED = 'INTERVENTION_MALFORMED';
const refuse = (message: string): never => { throw new CertenError(message, 0, INTERVENTION_MALFORMED); };
const isObj = (o: unknown): o is Record<string, unknown> => o !== null && typeof o === 'object' && !Array.isArray(o);
const SEAT = /^seat:[a-z0-9][a-z0-9._-]{0,62}$/;
const PAGE = /^acc:\/\/[a-z0-9][a-z0-9._-]*\.acme(\/[a-z0-9][a-z0-9._-]*)+\/[0-9]+$/;

/** A person-held act: a named seat and a reason of at least 10 characters (DECISION.md section 6, INTERVENTION.md). */
function act(a: { seat: unknown; reason: unknown }): { seat: string; reason: string } {
  if (typeof a.seat !== 'string' || !SEAT.test(a.seat)) refuse('a named seat is required (seat:<name>)');
  if (typeof a.reason !== 'string' || a.reason.trim().length < 10) refuse('a reason of at least 10 characters is required');
  return { seat: a.seat as string, reason: (a.reason as string).trim() };
}

/** The superseding version of a Grant: version + 1, prior hash = the head's hash, an EMPTY validity starting where the head's starts. */
export function revocationOf(head: unknown, issuedAt: number): Record<string, unknown> {
  if (!isObj(head) || !isObj(head.validity) || typeof head.version !== 'number') refuse('the current Grant head is required');
  const h = head as Record<string, any>;
  if (!Number.isSafeInteger(issuedAt) || issuedAt <= 0) refuse('issuedAt must be Unix seconds');
  return { ...h, version: h.version + 1, priorHash: hashGrant(h), issuedAt, validity: { notBefore: h.validity.notBefore, notAfter: h.validity.notBefore } };
}

export interface RevokeGrantResult extends PrincipalWriteResult { seat: string; reason: string; exposureWindow: string }

/** Revoke the agent's Grant: write the superseding version with an empty validity (the core judges it; the principal's page signs). */
export async function revokeGrant(client: CertenClient, a: { principal: string; page: string; head: unknown; issuedAt?: number; signer: PrincipalSigner; seat: string; reason: string }): Promise<RevokeGrantResult> {
  const who = act(a);
  const grant = revocationOf(a.head, a.issuedAt ?? Math.floor(Date.now() / 1000));
  const r = await issueGrant(client, { principal: a.principal, page: a.page, grant, signer: a.signer });
  return { ...r, ...who, exposureWindow: EXPOSURE_WINDOW_STATEMENT };
}

/** The governance operation that removes the agent's key, as the gateway names it. */
const hash64 = (h: unknown, what: string): string => {
  if (typeof h !== 'string' || !/^[0-9a-f]{64}$/.test(h.replace(/^0x/, '').toLowerCase())) refuse(`${what} must be 64 hex characters`);
  return (h as string).replace(/^0x/, '').toLowerCase();
};

/**
 * The key half of a revocation (AGT-F32): ONE updateKeyPage that ADDS the owner-held revocation key and then REMOVES the agent's key.
 * Accumulate refuses to delete the last key of a book's page 1 (internal/core/execute/v2/chain/update_key_page.go:248), so a remove
 * alone fails on chain for a one-key agent page; with the owner's key added first the page stays usable.
 */
export function agentKeyRemoval(keyHash: string, revocationKeyHash: string): Array<{ type: 'add_key' | 'remove_key'; public_key_hash: string }> {
  const agent = hash64(keyHash, 'the agent key hash');
  const owner = hash64(revocationKeyHash, 'the owner-held revocation key hash');
  if (agent === owner) refuse('the revocation key must not be the agent key');
  return [{ type: 'add_key', public_key_hash: owner }, { type: 'remove_key', public_key_hash: agent }];
}

export interface RevokeKeyResult { governanceOperationId: string; txHash?: string; agentPage: string; seat: string; reason: string; exposureWindow: string }

/**
 * Remove the agent's key from the agent's key page, signed by the OWNER's page. The signing data is rebuilt and must be exactly an
 * updateKeyPage of the agent's page removing exactly that key, signed by the owner's key on the owner's page; nothing is signed otherwise.
 */
export async function revokeAgentKey(client: CertenClient, a: { principal: string; page: string; agentPage: string; keyHash: string; revocationKeyHash: string; signer: PrincipalSigner; seat: string; reason: string }): Promise<RevokeKeyResult> {
  const who = act(a);
  const agentPage = typeof a.agentPage === 'string' ? a.agentPage.toLowerCase() : '';
  if (!PAGE.test(agentPage)) refuse('the agent key page must be a key page URL');
  const ops = agentKeyRemoval(a.keyHash, a.revocationKeyHash);
  const created = await client.governance.create({ identity: a.principal, operations: ops, keyPageUrl: agentPage, signerKeyPage: a.page, signerPublicKey: a.signer.publicKey });
  if (created.signing_mode !== 'provider' && created.signing_data) {
    await checkGovernanceSigning(created.signing_data, { adiUrl: agentPage.split('/').slice(0, 3).join('/'), operations: ops, signerPublicKey: a.signer.publicKey, signerKeyPage: a.page });
    const hash = String((created.signing_data as { hash_to_sign?: unknown }).hash_to_sign ?? '');
    const submitted = await client.governance.submitSignature(created.governance_op_id, { signature: a.signer.sign(hash), publicKey: a.signer.publicKey });
    const tx = (submitted as { tx_hash?: string }).tx_hash;
    return { governanceOperationId: created.governance_op_id, ...(tx ? { txHash: tx } : {}), agentPage, ...who, exposureWindow: EXPOSURE_WINDOW_STATEMENT };
  }
  return { governanceOperationId: created.governance_op_id, ...(created.tx_hash ? { txHash: created.tx_hash } : {}), agentPage, ...who, exposureWindow: EXPOSURE_WINDOW_STATEMENT };
}

export interface CancelResult { signRequestId: string; status: string; txHash: string; vote: 'reject'; seat: string; reason: string; exposureWindow: string }

/**
 * Cancel by reject vote: a required authority's REJECT on the pending transaction. The reject is a verdict only when the book can no
 * longer reach its threshold; then Accumulate rejects the transaction and nothing executes. It stops an action only before final approval.
 */
export async function cancelByRejectVote(client: CertenClient, a: { identity: string; txHash: string; signerUrl: string; signer: PrincipalSigner; seat: string; reason: string }): Promise<CancelResult> {
  const who = act(a);
  let tx = '';
  try {
    const t = resolveSignTarget(String(a.txHash));
    if (t.type === 'pending_tx') tx = t.targetId;
  } catch { /* refused below */ }
  if (tx === '') refuse('the pending transaction must be a transaction hash or TxID');
  if (typeof a.signerUrl !== 'string' || !PAGE.test(a.signerUrl.toLowerCase())) refuse('the signing page must be a key page URL');
  const created = await client.sign.create({ type: 'pending_tx', targetId: tx, identity: a.identity, signerUrl: a.signerUrl, publicKey: a.signer.publicKey, vote: 'reject' });
  if (created.signing_mode === 'provider' || !created.signing_data) {
    return { signRequestId: created.sign_request_id, status: created.status, txHash: tx, vote: 'reject', ...who, exposureWindow: EXPOSURE_WINDOW_STATEMENT };
  }
  // The transaction, the vote (reject) and the signer are rebuilt and matched before the signature exists.
  await checkCosigning(created.signing_data, { transactionHash: tx, signerPublicKey: a.signer.publicKey, signerKeyPage: a.signerUrl, vote: 'reject' });
  const hash = String((created.signing_data as { hash_to_sign?: unknown; data_for_signature?: unknown }).hash_to_sign ?? (created.signing_data as { data_for_signature?: unknown }).data_for_signature ?? '');
  const submitted = await client.sign.submitSignature(created.sign_request_id, { signature: a.signer.sign(hash), publicKey: a.signer.publicKey });
  return { signRequestId: created.sign_request_id, status: String((submitted as { status?: unknown }).status ?? created.status), txHash: tx, vote: 'reject', ...who, exposureWindow: EXPOSURE_WINDOW_STATEMENT };
}

export interface ReplaceResult { retired: PrincipalWriteResult; registered: PrincipalWriteResult; grant: PrincipalWriteResult; seat: string; reason: string; exposureWindow: string }

/**
 * Replace: the old agent's registration goes to `retired` (its next version), the new agent is registered under the same principal, and
 * its own Grant is issued (a new grantId: GR-22 keeps a lineage's subject). Each document is judged by the core before anything is signed.
 */
export async function replaceAgent(client: CertenClient, a: { principal: string; page: string; signer: PrincipalSigner; retiredRegistration: unknown; newRegistration: unknown; newGrant: unknown; seat: string; reason: string }): Promise<ReplaceResult> {
  const who = act(a);
  if (!isObj(a.retiredRegistration) || a.retiredRegistration.status !== 'retired') refuse('the old agent\'s registration must be its next version with status retired');
  if (!isObj(a.newRegistration) || !isObj(a.newGrant)) refuse('the new registration and the new Grant are required');
  const nr = a.newRegistration as Record<string, any>;
  const ng = a.newGrant as Record<string, any>;
  const old = a.retiredRegistration as Record<string, any>;
  if (nr.adi === old.adi) refuse('the new agent must be another ADI than the retired one');
  if (!isObj(ng.subject) || ng.subject.adi !== nr.adi) refuse('the new Grant must name the new agent as its subject');
  const retired = await registerAgent(client, { principal: a.principal, page: a.page, registration: old, signer: a.signer });
  const registered = await registerAgent(client, { principal: a.principal, page: a.page, registration: nr, signer: a.signer });
  const grant = await issueGrant(client, { principal: a.principal, page: a.page, grant: ng, signer: a.signer });
  return { retired, registered, grant, ...who, exposureWindow: EXPOSURE_WINDOW_STATEMENT };
}
