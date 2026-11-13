import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { bindProofV21, governingFactsFromVoteEvidence, NamedState, verifyPortableAnyBytes, type Report21 } from '../src/s3/index.js';

/**
 * The binding is NOT changed by DAX-1G (validator bind_v21.go is untouched; this package's bind-v21.ts is untouched): it refuses a report with anything unproven, and
 * a page whose initiator-signer role is only Declared. What changes is the verifier's report, which now PROVES the role for a document that carries the member. This is
 * the TypeScript twin of the Go tests TestNonVotingInitiatorIsProvenAndBound and TestBindingAcceptsTheReportAProvenNonVotingInitiatorProduces, run over the shared
 * vectors: the report of the carried vector is bound as it stands; the report of the same document without the member is refused by its own first named state.
 */
const vector = (name: string): { text: string; ev: Record<string, any> } => {
  const text = readFileSync(new URL(`./fixtures/s3-dax1g/xpartition7/${name}.json`, import.meta.url), 'utf8');
  return { text, ev: (JSON.parse(text) as { evidence: Record<string, any> }).evidence };
};
const report = (text: string): Report21 => {
  const out = verifyPortableAnyBytes(text);
  if (out.version !== '2.1') throw new Error('not 2.1');
  return out.report;
};

const ERP = 'acc://pv2-erp-5.acme/book/1';
const ERP_BOOK = 'acc://pv2-erp-5.acme/book';
const BVN1 = 12_600_050;

/** The intent's own vote evidence as the binding reads it: the vote's key signature, the initiating signature as the transaction's signature set holds it, the vote. */
function facts(ev: Record<string, any>, withInitiating: boolean) {
  const vote = ev.votes[0];
  const signatures = vote.hops.map((h: any) => ({ signer: h.page, block: h.block, signature: h.signature }));
  if (withInitiating) signatures.push({ signer: ev.initiatingSignature.page, block: ev.initiatingSignature.block, signature: ev.initiatingSignature.signature });
  return governingFactsFromVoteEvidence({
    account: ev.account,
    transaction: ev.transaction,
    authorities: [{ url: 'acc://pv2-bank-5.acme/book', disabled: false }],
    extra: [],
    signatures,
    votes: [{ authority: vote.authority, origin: vote.origin, block: BVN1 - 1 }],
    arrivals: [],
  });
}

function bind(rep: Report21, f: ReturnType<typeof facts>): void {
  const g0 = { entryHashExec: rep.txHash, receiptStart: rep.txHash, execWitness: rep.anchorRootChainAnchor, execMBI: rep.anchorBlock };
  bindProofV21(rep, g0, { authoritySnapshotPage: ERP }, ERP, ERP_BOOK, f);
}

const refusalOf = (f: () => void): NamedState | Error | undefined => {
  try {
    f();
  } catch (e) {
    return e as Error;
  }
  return undefined;
};

describe('a proven non-voting initiator is bound as the unchanged binding stands', () => {
  const { text, ev } = vector('initiator-nonvoting-carried');

  it('the intent names the initiating page (a page that is no authority and no voter)', () => {
    const f = facts(ev, true);
    expect(f.initiators).toEqual([ERP]);
    expect(f.authorities.map((a) => a.url)).not.toContain(ERP_BOOK);
  });

  it('the carried vector: verified, nothing unproven, initiator-signer proven on the page, and the binding accepts the report', () => {
    const rep = report(text);
    expect(rep.unproven).toEqual([]);
    const erp = rep.proven.find((p) => p.url === ERP)!;
    expect(erp.roles).toContain('initiator-signer');
    expect(erp.declared).toEqual(['certified-key-page']);
    // the document's vote carries its production bound or not: a disclosure of it would be refused by the binding by name, never accepted
    const err = refusalOf(() => bind(rep, facts(ev, true)));
    expect(err === undefined ? 'bound' : `${err instanceof NamedState ? err.code : 'plain'}: ${err.message}`).toBe('bound');
  });

  it('the same report with the role not proven is refused by the initiator state (the role is what the binding needs)', () => {
    const rep = report(text);
    const erp = rep.proven.find((p) => p.url === ERP)!;
    erp.roles = erp.roles.filter((r) => r !== 'initiator-signer');
    erp.roles.push('synthetic-chain'); // some other proven role, so the certified page still proves something
    const err = refusalOf(() => bind(rep, facts(ev, true)));
    expect(err).toBeInstanceOf(NamedState);
    expect((err as NamedState).code).toBe('g1_initiator_page_unproven');
  });
});

describe('the document without the member is still refused by the binding (the verifier names what it cannot prove, the binding refuses it)', () => {
  const { text } = vector('initiator-member-absent');
  // the intent's vote evidence holds the initiating signature whether or not the document carries it (the same world, the same transaction)
  const { ev } = vector('initiator-nonvoting-carried');
  it('the report says g1_initiator_signature_not_carried and the binding refuses it by that entry, before anything else is judged', () => {
    const rep = report(text);
    expect(rep.unproven.map((u) => u.code)).toEqual(['g1_initiator_signature_not_carried']);
    const err = refusalOf(() => bind(rep, facts(ev, true)));
    expect(err).toBeInstanceOf(NamedState);
    expect((err as NamedState).code).toBe('g1_initiator_signature_not_carried');
  });
  it('a report whose initiator-signer is only Declared is refused even with nothing in the unproven list (the page is also the certified key page, which the binding judges first)', () => {
    const rep = report(text);
    rep.unproven = [];
    const err = refusalOf(() => bind(rep, facts(ev, true)));
    expect(err).toBeInstanceOf(NamedState);
    expect((err as NamedState).code).toBe('g1_certified_page_unproven');
    expect((err as NamedState).message).toContain('proves no role of the governing set');
  });
});
