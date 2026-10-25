// WP-S8-CLI (TypeScript half, Part B1): the exported outcome evidence file as the source of the leg for `--contract-identity`. The real Base Sepolia settlement of the
// doc_report1 fixture is re-cut as an OutcomeEvidence (header, transaction, receipt and their trie proofs under the leaf that names the block and the transaction) and read back:
// the Settlement must verify as level 1 exactly as the original does, and every mutation the Go reader refuses (a header or transaction that is not the one the leaf names, a
// block number that is not the header's, a member with no settlement, a malformed file) must be refused here.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { identity } from '../../src/index.js';
import { deriveIncluded } from '../../src/proof-v2/finality/evidence.js';
import { readHeader } from '../../src/proof-v2/finality/rlpheader.js';
import { parseSettlementJSON } from '../../src/proof-v2/finality/settlementjson.js';

const hx = (b: Uint8Array): string => '0x' + Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const fixture = JSON.parse(readFileSync(fileURLToPath(new URL('../fixtures/finality/doc_report1/settlements/outcome_84532.json', import.meta.url)), 'utf8')) as { chain: number; settlement: unknown };
const original = parseSettlementJSON(JSON.stringify(fixture.settlement))!;
const chain = BigInt(fixture.chain);
const word = (n: number): string => '0x' + n.toString(16).padStart(2, '0').repeat(32);

function evidence(over: (e: Record<string, any>) => void = () => undefined): string {
  const h = readHeader(original.headerRlp);
  const e: Record<string, any> = {
    version: 'certen-outcome-evidence/1',
    chainId: fixture.chain,
    anchor: { batchRoot: word(1), batchOperationId: word(2), accumulateSetRoot: word(3), incarnation: word(4), certenSetRoot: word(5) },
    quorum: { thresholdNumerator: 2, thresholdDenominator: 3, validators: [{ address: '0x' + '11'.repeat(20), votingPower: '10', blsPublicKey: '0x' + 'AB'.repeat(96) }, { address: '0x' + '22'.repeat(20), votingPower: '20', blsPublicKey: 'cd'.repeat(96) }] },
    member: {
      leaf: { status: 1, tx: hx(original.txHash), blockNumber: Number(h.number), blockHash: hx(original.blockHash) },
      adiUrl: 'acc://example.acme',
      transaction: {
        header: hx(original.headerRlp), index: Number(original.tx!.leafIndex), transaction: hx(original.tx!.leafValue), transactionProof: original.tx!.proofNodes.map(hx),
        receipt: hx(original.receipt!.leafValue), receiptProof: original.receipt!.proofNodes.map(hx),
      },
    },
  };
  over(e);
  return JSON.stringify(e);
}
const refusal = (over: (e: Record<string, any>) => void): unknown => {
  try {
    identity.settlementFromOutcome(identity.readOutcomeEvidence(evidence(over)));
  } catch (e) {
    return e;
  }
  return undefined;
};

describe('the outcome evidence file as the source of a leg', () => {
  it('yields the Settlement of the member, which verifies as level 1 exactly as the original does', () => {
    const ev = identity.readOutcomeEvidence(evidence());
    const leg = identity.settlementFromOutcome(ev);
    expect(leg.chain).toBe(chain);
    expect(hx(leg.settlement.blockHash)).toBe(hx(original.blockHash));
    expect(hx(leg.settlement.txHash)).toBe(hx(original.txHash));
    expect(hx(leg.settlement.tx!.expectedRoot)).toBe(hx(readHeader(original.headerRlp).transactionRoot));
    expect(hx(leg.settlement.receipt!.expectedRoot)).toBe(hx(readHeader(original.headerRlp).receiptsRoot));
    const want = deriveIncluded(chain, original);
    const got = deriveIncluded(chain, leg.settlement);
    expect([got.chain, got.number, hx(got.hash)]).toEqual([want.chain, want.number, hx(want.hash)]);
  });

  it('reads the batch facts and the S9 registry the file states', () => {
    const ev = identity.readOutcomeEvidence(evidence());
    const b = identity.batchFactsFromOutcome(ev);
    expect([hx(b.batchRoot), hx(b.operationId), hx(b.accSetRoot), hx(b.incarnation)]).toEqual([word(1), word(2), word(3), word(4)]);
    const r = identity.registry9FromOutcome(ev)!;
    expect([r.num, r.den, hx(r.certenSetRoot), r.members.length, r.members[0]!.power, r.members[1]!.power]).toEqual([2n, 3n, word(5), 2, 10n, 20n]);
    expect(r.members[0]!.blsKey).toBe('ab'.repeat(96));
    expect(r.members[1]!.blsKey).toBe('cd'.repeat(96));
    expect(hx(r.members[0]!.address)).toBe('0x' + '11'.repeat(20));
    expect(r.signerCommitment.every((x) => x === 0)).toBe(true);
    expect(identity.registry9FromOutcome(identity.readOutcomeEvidence(evidence((e) => { e['quorum'].validators = []; })))).toBeUndefined();
  });

  it('refuses a header, a transaction or a block number that is not the one the leaf names', () => {
    expect(refusal((e) => { e['member'].leaf.blockHash = word(9); })).toBeInstanceOf(identity.OutcomeFileError);
    expect(refusal((e) => { e['member'].leaf.tx = word(9); })).toBeInstanceOf(identity.OutcomeFileError);
    expect(refusal((e) => { e['member'].leaf.blockNumber += 1; })).toBeInstanceOf(identity.OutcomeFileError);
    expect(refusal((e) => { e['member'].transaction.header = '0x' + e['member'].transaction.header.slice(4); })).toBeInstanceOf(identity.OutcomeFileError);
    // a transaction whose bytes were altered still hashes to something else than the leaf names
    expect(refusal((e) => { const t = e['member'].transaction; t.transaction = t.transaction.slice(0, -2) + (t.transaction.endsWith('00') ? '01' : '00'); })).toBeInstanceOf(identity.OutcomeFileError);
    expect(refusal((e) => { delete e['member'].transaction; })).toBeInstanceOf(identity.OutcomeFileError);
  });

  it('a member with no settlement is the named state finality_included_unavailable, never a Settlement', () => {
    for (const status of [0, 3, 4, 255]) {
      const e = refusal((x) => { x['member'].leaf.status = status; }) as { code?: string };
      expect(e.code, `status ${status}`).toBe('finality_included_unavailable');
    }
    // altered proofs are not read here: they make the Settlement that deriveIncluded refuses
    const leg = identity.settlementFromOutcome(identity.readOutcomeEvidence(evidence((e) => { e['member'].transaction.transactionProof[0] = '0x00'; })));
    expect(() => deriveIncluded(chain, leg.settlement)).toThrow();
  });

  it('refuses a file that is not an outcome evidence this verifier can read', () => {
    expect(identity.OutcomeFileError).toBeTypeOf('function');
    const cases: [string, (e: Record<string, any>) => void][] = [
      ['chain 0', (e) => { e['chainId'] = 0; }],
      ['chain as string', (e) => { e['chainId'] = '84532'; }],
      ['chain beyond 2^53', (e) => { e['chainId'] = 9007199254740993; }],
      ['no anchor', (e) => { delete e['anchor']; }],
      ['anchor member missing', (e) => { delete e['anchor'].incarnation; }],
      ['no quorum', (e) => { delete e['quorum']; }],
      ['validators not a list', (e) => { e['quorum'].validators = {}; }],
      ['validator without a key', (e) => { delete e['quorum'].validators[0].blsPublicKey; }],
      ['no member', (e) => { delete e['member']; }],
      ['no leaf', (e) => { delete e['member'].leaf; }],
      ['negative block number', (e) => { e['member'].leaf.blockNumber = -1; }],
      ['proof node not hex', (e) => { e['member'].transaction.transactionProof[0] = 'zz'; }],
      ['proof node odd length', (e) => { e['member'].transaction.transactionProof[0] = '0xabc'; }],
      ['header without 0x', (e) => { e['member'].transaction.header = e['member'].transaction.header.slice(2); }],
    ];
    for (const [name, over] of cases) expect(() => identity.readOutcomeEvidence(evidence(over)), name).toThrow(identity.OutcomeFileError);
    expect(() => identity.readOutcomeEvidence('{'), 'not JSON').toThrow(identity.OutcomeFileError);
    expect(() => identity.readOutcomeEvidence('[]'), 'not an object').toThrow(identity.OutcomeFileError);
  });

  it('refuses a registry or batch fact the file spells in a form no verifier reads', () => {
    const reg = (over: (e: Record<string, any>) => void): unknown => {
      try { identity.registry9FromOutcome(identity.readOutcomeEvidence(evidence(over))); } catch (e) { return e; }
      return undefined;
    };
    expect(reg((e) => { e['quorum'].validators[0].votingPower = '-1'; })).toBeInstanceOf(identity.OutcomeFileError);
    expect(reg((e) => { e['quorum'].validators[0].votingPower = '18446744073709551616'; })).toBeInstanceOf(identity.OutcomeFileError);
    expect(reg((e) => { e['quorum'].validators[0].votingPower = '01'; })).toBeInstanceOf(identity.OutcomeFileError);
    expect(reg((e) => { e['quorum'].validators[0].address = '0x1234'; })).toBeInstanceOf(identity.OutcomeFileError);
    expect(reg((e) => { e['anchor'].certenSetRoot = '0x1234'; })).toBeInstanceOf(identity.OutcomeFileError);
    expect(() => identity.batchFactsFromOutcome(identity.readOutcomeEvidence(evidence((e) => { e['anchor'].batchRoot = 'xyz'; })))).toThrow(identity.OutcomeFileError);
  });
});
