/**
 * Agent enrollment (AGT-2 WP1; specification transaction-controls docs/agentic/AGENT-IDENTITY.md section 3, AGENT-GRANT.md).
 *
 * An agent is enrolled only when EVERY step holds on chain, in the ceremony order:
 *   1. the principal's book is an active required authority on the agent ADI,
 *   2. ... and on the agent's KEY BOOK (seats and thresholds then need the principal too),
 *      each added authority ACCEPTED by the principal's book: Accumulate keeps an addAuthority pending until a key of the
 *      added book signs (fact F3), and a pending acceptance is NOT enrolled,
 *   3. the principal's registry resolves the agent as `type: agent` (GR-62) with the agent's acceptance in force - never a
 *      name or a name prefix (finding AGT-F6),
 *   4. the Grant and the mandate are each signed by the PRINCIPAL's book, and the agent's book is in neither the signers nor
 *      the authority set of the account that holds them.
 *
 * This module decides the state from facts read off the chain and plans the next step; it holds no key and signs nothing.
 * Whoever carries out a step signs with its own key: the agent for the addAuthority it proposes, the principal for the
 * acceptance, the registration, the Grant and the mandate.
 */

export interface AuthorityEntry { url: string; disabled: boolean }

export interface SignedDocumentFacts {
  /** the key book whose page the verified envelope signature resolved to (null when the document is absent or unverified) */
  signerBook: string | null;
  /** the authority set of the data account that holds the document */
  accountAuthorities: AuthorityEntry[];
}

export interface AgentEnrollmentFacts {
  agentAdi: string;
  principalAdi: string;
  principalBook: string;
  adiAuthorities: AuthorityEntry[];
  keyBookAuthorities: AuthorityEntry[];
  /** addAuthority transactions naming the principal's book that Accumulate still holds pending (awaiting the principal's signature) */
  pendingAuthorityAdds: { adi?: string; keyBook?: string };
  /** the registry resolution through the principal's registry (gateway / core resolveSubject answer) */
  registryResolve: { ok: true; subject: { adi: string; type: string } } | { ok: false; reason: string };
  grant: SignedDocumentFacts;
  mandate: SignedDocumentFacts;
}

export type AgentEnrollmentState =
  | 'enrolled'
  | 'enrollment_input_malformed'
  | 'enrollment_owner_is_agent'
  | 'enrollment_owner_not_on_adi'
  | 'enrollment_acceptance_pending'
  | 'enrollment_owner_not_on_keybook'
  | 'enrollment_subject_unproven'
  | 'enrollment_subject_mismatch'
  | 'grant_not_signed_by_principal'
  | 'grant_authority_includes_agent'
  | 'mandate_not_signed_by_principal'
  | 'mandate_authority_includes_agent';

export interface AgentEnrollmentStep {
  step: 'add_authority' | 'accept_authority' | 'register_subject' | 'issue_grant' | 'issue_mandate';
  /** who must sign this step */
  signer: 'agent' | 'principal';
  account?: 'identity' | 'book';
  /** the pending Accumulate transaction the principal accepts */
  pendingTx?: string;
}

export interface AgentEnrollmentVerdict {
  enrolled: boolean;
  state: AgentEnrollmentState;
  cause?: string;
  next: AgentEnrollmentStep | null;
}

const ACC = /^acc:\/\/[a-z0-9][a-z0-9.-]*\.acme(\/[a-z0-9._-]+)*$/;
const hostOf = (u: string): string => u.replace(/^acc:\/\//, '').split('/')[0];
/** the URL is the ADI, a path under it, or a sub-ADI of it (GR-36 reading) */
export function isUnderAdi(url: string, adi: string): boolean {
  if (!ACC.test(url) || !ACC.test(adi)) return false;
  const h = hostOf(url);
  const a = hostOf(adi);
  return h === a || h.endsWith(`.${a}`);
}

const active = (list: AuthorityEntry[], url: string): boolean => list.some((a) => a.url === url && a.disabled === false);
const validList = (l: unknown): l is AuthorityEntry[] =>
  Array.isArray(l) && l.every((a) => a !== null && typeof a === 'object' && typeof (a as AuthorityEntry).url === 'string' && typeof (a as AuthorityEntry).disabled === 'boolean');

function documentState(doc: SignedDocumentFacts | undefined, f: AgentEnrollmentFacts, kind: 'grant' | 'mandate'): AgentEnrollmentState | null {
  if (!doc || !validList(doc.accountAuthorities)) return 'enrollment_input_malformed';
  if (doc.accountAuthorities.some((a) => a.disabled === false && isUnderAdi(a.url, f.agentAdi))) return `${kind}_authority_includes_agent`;
  if (doc.signerBook === null || doc.signerBook !== f.principalBook || isUnderAdi(doc.signerBook, f.agentAdi)) return `${kind}_not_signed_by_principal`;
  return null;
}

/** The enrollment state from chain facts, and the next step to carry out (null when enrolled). Fail closed on any malformed fact. */
export function agentEnrollmentState(f: AgentEnrollmentFacts): AgentEnrollmentVerdict {
  const no = (state: AgentEnrollmentState, next: AgentEnrollmentStep | null, cause?: string): AgentEnrollmentVerdict =>
    ({ enrolled: false, state, next, ...(cause !== undefined ? { cause } : {}) });
  if (!f || typeof f.agentAdi !== 'string' || !ACC.test(f.agentAdi) || typeof f.principalAdi !== 'string' || !ACC.test(f.principalAdi)
    || typeof f.principalBook !== 'string' || !f.principalBook.startsWith(`${f.principalAdi}/`)
    || !validList(f.adiAuthorities) || !validList(f.keyBookAuthorities) || f.pendingAuthorityAdds === null || typeof f.pendingAuthorityAdds !== 'object'
    || !f.registryResolve || typeof f.registryResolve.ok !== 'boolean') return no('enrollment_input_malformed', null);
  if (isUnderAdi(f.principalBook, f.agentAdi) || isUnderAdi(f.principalAdi, f.agentAdi)) return no('enrollment_owner_is_agent', null);

  if (!active(f.adiAuthorities, f.principalBook)) {
    return f.pendingAuthorityAdds.adi
      ? no('enrollment_acceptance_pending', { step: 'accept_authority', signer: 'principal', account: 'identity', pendingTx: f.pendingAuthorityAdds.adi })
      : no('enrollment_owner_not_on_adi', { step: 'add_authority', signer: 'agent', account: 'identity' });
  }
  if (!active(f.keyBookAuthorities, f.principalBook)) {
    return f.pendingAuthorityAdds.keyBook
      ? no('enrollment_acceptance_pending', { step: 'accept_authority', signer: 'principal', account: 'book', pendingTx: f.pendingAuthorityAdds.keyBook })
      : no('enrollment_owner_not_on_keybook', { step: 'add_authority', signer: 'agent', account: 'book' });
  }
  const r = f.registryResolve;
  if (r.ok !== true) return no('enrollment_subject_unproven', { step: 'register_subject', signer: 'principal' }, r.reason);
  if (r.subject.adi !== f.agentAdi || r.subject.type !== 'agent') return no('enrollment_subject_mismatch', null);
  const g = documentState(f.grant, f, 'grant');
  if (g) return no(g, g === 'enrollment_input_malformed' ? null : { step: 'issue_grant', signer: 'principal' });
  const m = documentState(f.mandate, f, 'mandate');
  if (m) return no(m, m === 'enrollment_input_malformed' ? null : { step: 'issue_mandate', signer: 'principal' });
  return { enrolled: true, state: 'enrolled', next: null };
}

/**
 * The governance operation for an `add_authority` step, in the gateway's governance shape (types.ts: add_authority with
 * `authority_url`, and `account_url` for the key book). Only the agent-side step has an operation: the acceptance is the
 * principal's signature on the pending transaction, never an operation the agent can submit.
 */
export function agentAuthorityOperation(f: Pick<AgentEnrollmentFacts, 'agentAdi' | 'principalBook'>, account: 'identity' | 'book'): Record<string, string> {
  if (!ACC.test(f.agentAdi) || !ACC.test(f.principalBook) || isUnderAdi(f.principalBook, f.agentAdi)) throw new Error('agent_authority_operation_malformed');
  return account === 'book'
    ? { type: 'add_authority', authority_url: f.principalBook, account_url: `${f.agentAdi}/book` }
    : { type: 'add_authority', authority_url: f.principalBook };
}
