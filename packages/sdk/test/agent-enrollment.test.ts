import { describe, it, expect } from 'vitest';
import { agentEnrollmentState, agentAuthorityOperation, isUnderAdi, type AgentEnrollmentFacts } from '../src/index.js';

/**
 * AGT-2 WP1: agent enrollment state (transaction-controls docs/agentic/AGENT-IDENTITY.md section 3). FICTIONAL parties.
 * Enrolled only when every step holds; a pending acceptance is NOT enrolled (F3); binding is by registry, never a name (AGT-F6);
 * the Grant and the mandate are signed by the principal's book, and their accounts never list the agent's book.
 */
const AGENT = 'acc://agent-7.harbor-mfg.acme';
const PRINCIPAL = 'acc://harbor-mfg.acme';
const BOOK = `${PRINCIPAL}/book`;
const both = [{ url: `${AGENT}/book`, disabled: false }, { url: BOOK, disabled: false }];
const doc = { signerBook: BOOK, accountAuthorities: [{ url: BOOK, disabled: false }] };
const full = (over: Partial<AgentEnrollmentFacts> = {}): AgentEnrollmentFacts => ({
  agentAdi: AGENT, principalAdi: PRINCIPAL, principalBook: BOOK, adiAuthorities: both, keyBookAuthorities: both,
  pendingAuthorityAdds: {}, registryResolve: { ok: true, subject: { adi: AGENT, type: 'agent' } }, grant: doc, mandate: doc, ...over,
});

describe('agent enrollment state', () => {
  it('every step holds: enrolled, nothing next', () => {
    expect(agentEnrollmentState(full())).toEqual({ enrolled: true, state: 'enrolled', next: null });
  });
  it('no authority on the ADI: the agent proposes addAuthority on its identity', () => {
    const v = agentEnrollmentState(full({ adiAuthorities: [{ url: `${AGENT}/book`, disabled: false }] }));
    expect(v).toMatchObject({ enrolled: false, state: 'enrollment_owner_not_on_adi', next: { step: 'add_authority', signer: 'agent', account: 'identity' } });
  });
  it('F3: the addAuthority on the ADI waits for the principal\'s acceptance: NOT enrolled, the principal signs the pending tx', () => {
    const v = agentEnrollmentState(full({ adiAuthorities: [{ url: `${AGENT}/book`, disabled: false }], pendingAuthorityAdds: { adi: 'ab'.repeat(32) } }));
    expect(v).toMatchObject({ enrolled: false, state: 'enrollment_acceptance_pending', next: { step: 'accept_authority', signer: 'principal', pendingTx: 'ab'.repeat(32) } });
  });
  it('F3 on the key book: pending acceptance is not enrolled', () => {
    const v = agentEnrollmentState(full({ keyBookAuthorities: [{ url: `${AGENT}/book`, disabled: false }], pendingAuthorityAdds: { keyBook: 'cd'.repeat(32) } }));
    expect(v).toMatchObject({ enrolled: false, state: 'enrollment_acceptance_pending', next: { account: 'book', signer: 'principal' } });
  });
  it('principal on the ADI only, not on the key book: not enrolled', () => {
    const v = agentEnrollmentState(full({ keyBookAuthorities: [{ url: `${AGENT}/book`, disabled: false }] }));
    expect(v).toMatchObject({ enrolled: false, state: 'enrollment_owner_not_on_keybook', next: { step: 'add_authority', account: 'book' } });
  });
  it('a disabled authority entry does not count', () => {
    const v = agentEnrollmentState(full({ adiAuthorities: [{ url: BOOK, disabled: true }] }));
    expect(v.state).toBe('enrollment_owner_not_on_adi');
  });
  it('AGT-F6: a prefix squatter with authorities in place but not registered by the principal is not enrolled', () => {
    const squat = 'acc://agent-7-squat.harbor-mfg.acme';
    const v = agentEnrollmentState(full({ agentAdi: squat, adiAuthorities: [{ url: BOOK, disabled: false }], keyBookAuthorities: [{ url: BOOK, disabled: false }],
      registryResolve: { ok: false, reason: 'not_registered' } }));
    expect(v).toMatchObject({ enrolled: false, state: 'enrollment_subject_unproven', cause: 'not_registered' });
  });
  it('a registry answer for another ADI or another type is a mismatch', () => {
    expect(agentEnrollmentState(full({ registryResolve: { ok: true, subject: { adi: AGENT, type: 'merchant' } } })).state).toBe('enrollment_subject_mismatch');
  });
  it('a Grant signed by the agent\'s own book is not the principal\'s Grant', () => {
    expect(agentEnrollmentState(full({ grant: { signerBook: `${AGENT}/book`, accountAuthorities: [{ url: BOOK, disabled: false }] } })).state).toBe('grant_not_signed_by_principal');
  });
  it('a Grant account whose authority set includes the agent\'s book: the agent could rewrite its own Grant', () => {
    expect(agentEnrollmentState(full({ grant: { signerBook: BOOK, accountAuthorities: [{ url: BOOK, disabled: false }, { url: `${AGENT}/book`, disabled: false }] } })).state)
      .toBe('grant_authority_includes_agent');
  });
  it('no mandate yet, or one signed by someone else: not enrolled, the principal issues it', () => {
    expect(agentEnrollmentState(full({ mandate: { signerBook: null, accountAuthorities: [{ url: BOOK, disabled: false }] } })))
      .toMatchObject({ state: 'mandate_not_signed_by_principal', next: { step: 'issue_mandate', signer: 'principal' } });
  });
  it('a mandate account whose authority set includes the agent\'s book is refused', () => {
    expect(agentEnrollmentState(full({ mandate: { signerBook: BOOK, accountAuthorities: [{ url: `${AGENT}/book`, disabled: false }] } })).state).toBe('mandate_authority_includes_agent');
  });
  it('a principal book under the agent ADI is refused (the agent cannot oversee itself)', () => {
    expect(agentEnrollmentState(full({ principalAdi: 'acc://x.agent-7.harbor-mfg.acme', principalBook: 'acc://x.agent-7.harbor-mfg.acme/book' })).state).toBe('enrollment_owner_is_agent');
  });
  it('malformed facts fail closed', () => {
    expect(agentEnrollmentState({ ...full(), adiAuthorities: 'x' as never }).state).toBe('enrollment_input_malformed');
    expect(agentEnrollmentState({ ...full(), agentAdi: 'agent-7' }).state).toBe('enrollment_input_malformed');
  });
});

describe('the agent-side governance operation', () => {
  it('names the principal book on the identity, and on the key book with its account', () => {
    expect(agentAuthorityOperation({ agentAdi: AGENT, principalBook: BOOK }, 'identity')).toEqual({ type: 'add_authority', authority_url: BOOK });
    expect(agentAuthorityOperation({ agentAdi: AGENT, principalBook: BOOK }, 'book')).toEqual({ type: 'add_authority', authority_url: BOOK, account_url: `${AGENT}/book` });
  });
  it('refuses an authority under the agent itself', () => {
    expect(() => agentAuthorityOperation({ agentAdi: AGENT, principalBook: `${AGENT}/book` }, 'identity')).toThrow('agent_authority_operation_malformed');
  });
  it('isUnderAdi: path, sub-ADI and the ADI itself are under it; a name sharing only a prefix is not', () => {
    expect(isUnderAdi(`${AGENT}/book`, AGENT)).toBe(true);
    expect(isUnderAdi('acc://x.agent-7.harbor-mfg.acme', AGENT)).toBe(true);
    expect(isUnderAdi('acc://agent-7-squat.harbor-mfg.acme', AGENT)).toBe(false);
  });
});
