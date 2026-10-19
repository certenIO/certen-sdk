import { describe, expect, it } from 'vitest';
import { CertifyCode } from '../src/s3/certify.js';
import { judgeCertify, read, type CertJudged } from './helpers/certify1.js';

/**
 * RB9-F6, F-VE-2 option (b) (owner decision 2026-10-19): the OFFLINE walk of an evidence 2.1 document requires the genesis link of EVERY document, the
 * continuous form (no links) included, and refuses a document without it as certify_link_missing{genesis} - the existing name, names.json unchanged.
 * Validator pkg/proof/v2/evidence.go verifyFrom(..., requireGenesisLink): true for verifyFromGenesis (VerifyPortable, Verify21FromGenesis), false for
 * the spine-log entry point (consensus), which this package does not have. The refusal is made AFTER verify21 has judged everything else, so a
 * document that fails for another reason keeps that refusal, and a document with links or a genesis link is judged as it always was. Evidence 2.0 is
 * untouched.
 *
 * The documents are built from the certify1 fixtures (Go-written, byte for byte) by taking a member out, so the tests hold whichever way a re-sync of
 * the suite moves the documents that carry no link.
 */
const load = (name: string): any => JSON.parse(read(`certify1/${name}`).toString('utf8'));
const without = (doc: any, path: string[]): any => {
  const d = structuredClone(doc);
  let o = d;
  for (const k of path.slice(0, -1)) o = o[k];
  delete o[path[path.length - 1]!];
  return d;
};
const flip = (hex: string): string => hex.replace(/^./, (c) => (c === '0' ? '1' : '0'));

const isLinkMissingGenesis = (j: CertJudged): boolean => j.v === 'certify' && j.code === CertifyCode.CertifyLinkMissing && j.fields.length === 1 && j.fields[0] === 'genesis';

describe('evidence 2.1: the offline walk requires the genesis link of every document', () => {
  const continuous = load('continuous-chain-verified-g.json');

  it('the continuous document (no links) that carries the genesis link verifies', () => {
    expect((continuous.evidence.links ?? []).length).toBe(0);
    expect(continuous.evidence.genesisLink).toBeTruthy();
    expect(judgeCertify(continuous).v).toBe('verified');
  });

  it('the same document without its genesis link is refused certify_link_missing{genesis}', () => {
    const j = judgeCertify(without(continuous, ['evidence', 'genesisLink']));
    expect(isLinkMissingGenesis(j), JSON.stringify(j)).toBe(true);
    if (j.v === 'certify') expect(j.message.startsWith('certify_link_missing{genesis}')).toBe(true);
  });

  it('a JSON null genesisLink is no link either', () => {
    const d = structuredClone(continuous);
    d.evidence.genesisLink = null;
    expect(isLinkMissingGenesis(judgeCertify(d))).toBe(true);
  });

  // the refusal is made after verify21: every other reason a document can fail keeps its own refusal, link or no link
  const others: [string, string, (d: any) => void][] = [
    ['the transaction hash is altered (the first walk check)', 'plain', (d) => (d.evidence.txHash = flip(d.evidence.txHash))],
    ['the set check account does not hash to its proven leaf', 'plain', (d) => (d.evidence.check.network.stateReceipt.start = flip(d.evidence.check.network.stateReceipt.start))],
    ['a page receipt does not start at the page state', 'plain', (d) => (d.evidence.pages[0].receipt.start = flip(d.evidence.pages[0].receipt.start))],
    ['the partition anchor receipt does not prove the anchor', 'plain', (d) => (d.evidence.anchor.receipt.start = flip(d.evidence.anchor.receipt.start))],
    ['the document carries no page (verify21: a named state)', 'named', (d) => delete d.evidence.pages],
    ['the vote is missing (verify21: a named state)', 'named', (d) => delete d.evidence.votes],
  ];
  for (const [what, kind, mutate] of others) {
    it(`keeps its own refusal when ${what}`, () => {
      const linked = structuredClone(continuous);
      mutate(linked);
      const bare = without(continuous, ['evidence', 'genesisLink']);
      mutate(bare);
      const a = judgeCertify(linked);
      const b = judgeCertify(bare);
      expect(a.v).toBe(kind);
      expect(isLinkMissingGenesis(b), `refused as link missing: ${JSON.stringify(b)}`).toBe(false);
      // the same refusal, by the same name, with and without the link
      expect(b.v).toBe(a.v);
      if (a.v === 'named' && b.v === 'named') {
        expect(b.code).toBe(a.code);
        expect(b.partition).toBe(a.partition);
        expect(b.block).toBe(a.block);
      }
      if (a.v === 'plain' && b.v === 'plain') expect(b.message).toBe(a.message);
    });
  }

  it('a document with links but no genesis link was and is refused certify_link_missing{genesis}', () => {
    const d = load('anchored-chain-verified-g.json');
    expect((d.evidence.links ?? []).length).toBeGreaterThan(0);
    expect(judgeCertify(d).v).toBe('verified');
    expect(isLinkMissingGenesis(judgeCertify(without(d, ['evidence', 'genesisLink'])))).toBe(true);
  });

  it('a document with a genesis link and hops verifies, and is refused without the link', () => {
    const d = load('hops-anchored-verified-g.json');
    expect(judgeCertify(d).v).toBe('verified');
    expect(isLinkMissingGenesis(judgeCertify(without(d, ['evidence', 'genesisLink'])))).toBe(true);
  });

  it('a genesis link that does not hold is still refused by its own name (the check is not weakened)', () => {
    const d = load('genesis-link-start-altered.json');
    const j = judgeCertify(d);
    expect(j.v).toBe('certify');
    if (j.v === 'certify') {
      expect(j.code).toBe(CertifyCode.CertifyLinkStart);
      expect(j.fields).toEqual(['genesis']);
    }
  });

  it('evidence 2.0 is untouched: a 2.0 document without any genesis link member still verifies', () => {
    const d = load('genesis-link-member-in-an-evidence-2.0-document.json');
    expect(d.evidence.version).toBe('2.0');
    const bare = without(d, ['evidence', 'genesisLink']);
    expect(bare.evidence.genesisLink).toBeUndefined();
    const a = judgeCertify(d);
    const b = judgeCertify(bare);
    expect(a.v).toBe('verified');
    expect(b.v).toBe('verified');
  });
});
