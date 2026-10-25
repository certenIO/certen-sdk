// WP-S8-CLI (TypeScript half, Part B2): the LegContext of an outcome evidence file (S6 derivation over every published replay-guard vector, the receipt, the batch facts, the S7 report)
// and the judgement of a portable document with it: the S7 phase, then the S8 row, joined by combineExit. The positive path (a document the verifier accepts as VERIFIED) needs a
// producer-exported outcome file and member that this suite does not carry; every other path is exercised, and none of the hostile ones may exit 0.
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { identity } from '../../src/index.js';
import { judgeS6Replay } from '../../src/index.js';
import type { S6Settlement, S6Verdict } from '../../src/index.js';
import { readHeader } from '../../src/proof-v2/finality/rlpheader.js';
import { parseSettlementJSON } from '../../src/proof-v2/finality/settlementjson.js';

const hx = (b: Uint8Array): string => '0x' + Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const unhex = (s: string): Uint8Array => Uint8Array.from((s.slice(2).match(/../g) ?? []).map((x) => parseInt(x, 16)));
const N = identity.names;

// ---- S6 over the published replay-guard vectors ----

type Vector = { name: string; settlement: S6Settlement; evidence: string; expect: S6Verdict };
const vectors = (set: string): Vector[] => {
  const dir = new URL(`../fixtures/${set}/`, import.meta.url);
  return readdirSync(dir).filter((f) => /^\d{3}_.*\.json$/.test(f)).map((f) => JSON.parse(readFileSync(new URL(f, dir), 'utf8')) as Vector);
};

describe('deriveS6 mirrors the Go deriver over every published replay-guard vector', () => {
  it('derives s6_proven with the link of the proof, s6_not_proven with the named state of the verdict, s6_silent for a call of no pinned generation', () => {
    const seen = { proven: 0, notProven: 0, silent: 0 };
    for (const set of ['s6replay1', 's6replay2', 's6replay3']) {
      for (const v of vectors(set)) {
        const txRlp = unhex(v.settlement.txRlp);
        let data: Uint8Array;
        try { data = identity.parseTx(txRlp).data; } catch { continue; }
        const receipt: identity.ReceiptLeaf = {
          type: 2, postStateOrStatus: Uint8Array.of(v.settlement.receiptStatus), cumulativeGasUsed: 0n, bloom: new Uint8Array(256),
          logs: v.settlement.logs.map((l) => ({ address: unhex(l.address), topics: l.topics.map(unhex), data: unhex(l.data) })),
        };
        const at = `${set}/${v.name}`;
        // the reference is the TS judge, which the conformance suite holds equal to Go on every vector (a few published expectations are superseded: s6replay1/SUPERSEDED.md)
        const ref = judgeS6Replay(v.settlement, new TextEncoder().encode(v.evidence));
        const got = identity.deriveS6({ headerRlp: unhex(v.settlement.headerRlp), txRlp, txData: data }, receipt, v.evidence);
        const sel = Array.from(data.slice(0, 4), (x) => x.toString(16).padStart(2, '0')).join('');
        if (data.length < 4 || !['606f2c8d', '329fe012', '57f8567d', 'b7daa901'].includes(sel)) {
          expect([got.status, got.reason], at).toEqual([N.S6S6Silent, 'unsupported_generation']);
          seen.silent++;
        } else if (ref.result === 'proven') {
          expect(got.status, at).toBe(N.S6S6Proven);
          expect(got.link && hx(got.link.contract).length, at).toBe(42);
          expect(got.link!.settlementBlock.number, at).toBe(readHeader(unhex(v.settlement.headerRlp)).number);
          expect(got.link!.provenAt.number > 0n && got.link!.codeHash.length === 32, at).toBe(true);
          seen.proven++;
        } else {
          expect(got.status, at).toBe(N.S6S6NotProven);
          expect(got.link, at).toBeUndefined();
          expect(got.state, at).toBe(`${ref.state}{reason=${ref.reason}}`);
          seen.notProven++;
        }
      }
    }
    expect(seen.proven, 'proven vectors').toBeGreaterThanOrEqual(15);
    expect(seen.notProven, 'not-proven vectors').toBeGreaterThanOrEqual(50);
    expect(seen.silent, 'silent vectors').toBeGreaterThan(0);
  });

  it('a pinned call with no evidence is s6_silent{absent}', () => {
    const data = Uint8Array.of(0x60, 0x6f, 0x2c, 0x8d, 1, 2, 3);
    const got = identity.deriveS6({ headerRlp: new Uint8Array(0), txRlp: new Uint8Array(0), txData: data }, { type: 2, postStateOrStatus: Uint8Array.of(1), cumulativeGasUsed: 0n, bloom: new Uint8Array(256), logs: [] }, undefined);
    expect([got.status, got.reason]).toEqual([N.S6S6Silent, 'absent']);
  });
});

// ---- the document, judged with an outcome evidence ----

const fixture = JSON.parse(readFileSync(fileURLToPath(new URL('../fixtures/finality/doc_report1/settlements/outcome_84532.json', import.meta.url)), 'utf8')) as { chain: number; settlement: unknown };
const original = parseSettlementJSON(JSON.stringify(fixture.settlement))!;
const word = (n: number): string => '0x' + n.toString(16).padStart(2, '0').repeat(32);
function outcome(over: (e: Record<string, any>) => void = () => undefined): string {
  const e: Record<string, any> = {
    chainId: fixture.chain,
    anchor: { batchRoot: word(1), batchOperationId: word(2), accumulateSetRoot: word(3), incarnation: word(4), certenSetRoot: word(5) },
    quorum: { thresholdNumerator: 2, thresholdDenominator: 3, validators: [{ address: '0x' + '11'.repeat(20), votingPower: '10', blsPublicKey: 'ab'.repeat(96) }] },
    member: {
      leaf: { status: 1, tx: hx(original.txHash), blockNumber: Number(readHeader(original.headerRlp).number), blockHash: hx(original.blockHash) }, adiUrl: 'acc://example.acme',
      transaction: { header: hx(original.headerRlp), index: Number(original.tx!.leafIndex), transaction: hx(original.tx!.leafValue), transactionProof: original.tx!.proofNodes.map(hx), receipt: hx(original.receipt!.leafValue), receiptProof: original.receipt!.proofNodes.map(hx) },
    },
  };
  over(e);
  return JSON.stringify(e);
}
const legOf = (): { ev: identity.OutcomeEvidence; leg: ReturnType<typeof identity.settlementFromOutcome> } => {
  const ev = identity.readOutcomeEvidence(outcome());
  return { ev, leg: identity.settlementFromOutcome(ev) };
};

describe('legContextFromOutcome', () => {
  it('builds the context of the real settlement: transaction, receipt, batch facts, registry, ADI, S6 and the absence of an S7 report', () => {
    const { ev, leg } = legOf();
    const ctx = identity.legContextFromOutcome(ev, leg, undefined);
    expect(ctx.chain).toBe(BigInt(fixture.chain));
    expect(hx(ctx.settlement!.blockHash)).toBe(hx(original.blockHash));
    expect(ctx.settlement!.hasTx && ctx.settlement!.hasReceipt).toBe(true);
    expect(ctx.tx).toBeDefined();
    expect(ctx.receipt!.logs.every((l) => l.address.length === 20 && l.topics.every((t) => t.length === 32))).toBe(true);
    expect(ctx.receipt!.bloom.length).toBe(256);
    expect(ctx.adiUrl).toBe('acc://example.acme');
    expect(hx(ctx.batch.batchRoot)).toBe(word(1));
    expect(ctx.registry9?.members.length).toBe(1);
    expect([N.S6S6Silent]).toContain(ctx.s6Status);
    expect(ctx.s7).toBeUndefined();
  });

  it('refuses an outcome whose proofs do not verify as a settlement', () => {
    const ev = identity.readOutcomeEvidence(outcome((e) => { e['member'].transaction.transactionProof[0] = '0x00'; }));
    const leg = identity.settlementFromOutcome(ev);
    expect(() => identity.legContextFromOutcome(ev, leg, undefined)).toThrow(identity.OutcomeFileError);
  });
});

describe('judgeContractIdentityDocument', () => {
  const memberLine = /^contract identity: /m;
  it('joins the S7 phase and the S8 row, and an absent or hostile member never exits 0', async () => {
    for (const [name, doc, exit, text] of [
      ['no member', '{}', undefined, 'contract identity: '],
      ['null member', '{"contractIdentity":null}', undefined, 'contract identity: '],
      ['unknown member key', `{"contractIdentity":{"format":"${identity.CI_MEMBER_FORMAT}","x":1}}`, 2, 'proofverify: contractIdentity member'],
      ['other format', '{"contractIdentity":{"format":"certen-contract-identity/2"}}', 40, 'contract identity: REFUSED: contract_identity_evidence_unrecognised{'],
      ['case-folded key, last wins', '{"ContractIdentity":{"format":"certen-contract-identity/1"},"contractidentity":{"format":"certen-contract-identity/2"}}', 40, 'contract identity: REFUSED:'],
      ['duplicate key in the member', `{"contractIdentity":{"format":"${identity.CI_MEMBER_FORMAT}","format":"${identity.CI_MEMBER_FORMAT}"}}`, 2, 'proofverify: contractIdentity member'],
    ] as const) {
      const r = await identity.judgeContractIdentityDocument(doc, outcome(), { subject: name });
      expect(r.exit, `${name}: ${r.text}`).not.toBe(0);
      expect(r.text, name).toContain(text);
      if (exit !== undefined) expect(r.exit, name).toBe(exit);
      expect(r.text.startsWith('SUMMARY-ONLY (finality)') || r.text.startsWith('  S7') || r.text.startsWith('FAILED (finality)'), `${name}: S7 phase first`).toBe(true);
      expect(memberLine.test(r.text) || r.text.includes('proofverify: '), name).toBe(true);
      expect(r.s7).toBeDefined();
    }
  });

  it('a document that is not one JSON object ends with the S7 phase alone (FAILED, exit 1) and prints no S8 row', async () => {
    const r = await identity.judgeContractIdentityDocument('[1]', outcome(), { subject: 'doc' });
    expect(r.exit).toBe(1);
    expect(r.text).not.toContain('contract identity');
  });

  it('an outcome evidence that cannot be read or settles nothing is exit 2 with proofverify: and no report at all', async () => {
    for (const bad of ['{', '[]', outcome((e) => { e['member'].leaf.status = 3; }), outcome((e) => { e['member'].leaf.blockNumber += 1; })]) {
      const r = await identity.judgeContractIdentityDocument('{}', bad);
      expect(r.exit).toBe(2);
      expect(r.text.startsWith('proofverify: ')).toBe(true);
      expect(r.s7).toBeUndefined();
    }
  });

  it('a member of this leg that carries a container the verifier cannot accept is judged by the verifier, never VERIFIED', async () => {
    const { ev, leg } = legOf();
    const ctx = identity.legContextFromOutcome(ev, leg, undefined);
    const container = new TextEncoder().encode('CIE1-not-a-container');
    const d = identity.digestOf(ctx.chain, readHeader(original.headerRlp).number, original.blockHash, container);
    const member = { format: identity.CI_MEMBER_FORMAT, leg: { chain: Number(ctx.chain), blockNumber: Number(readHeader(original.headerRlp).number), blockHash: hx(original.blockHash) }, evidence: hx(container), digest: hx(d) };
    const r = await identity.judgeContractIdentityDocument(JSON.stringify({ contractIdentity: member }), outcome());
    expect(r.exit).not.toBe(0);
    expect(r.text).not.toContain('VERIFIED at');
    expect(r.s8?.text.startsWith('contract identity: ') || r.s8?.text.startsWith('proofverify: ')).toBe(true);
  });
});
