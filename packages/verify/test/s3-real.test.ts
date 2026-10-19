import { describe, expect, it } from 'vitest';
import { judgeDocument, readS3Json, withRecordedGenesisLink, type Judged } from './helpers/s3.js';
import { evidenceJson } from '../src/s3/budget.js';
import { importEvidence } from '../src/s3/evidence.js';

/**
 * The real evidence 2.1 document: a transaction on certen-protocol.acme/billing-receipts (BVN1 block 14713382) captured live from Kermit
 * on 2026-10-18 and assembled by the validator's Builder.Build21, exported to the portable form by Go (cmd/xtsgen real) and verified by
 * Go's proofv2.VerifyPortable. This is the only real 2.1 document there is: every cross-partition document is a synthetic vector (RB9-J2-F1).
 * The TypeScript verifier reads the portable file and must reach Go's report on every member - the pages with their roles and the declared
 * certified-key-page, the derived arrival blocks of the signature and of the production, the authorization mode, every root - and the
 * length of the evidence document the import produces (the budget measure), which Go computed as len(json.Marshal(evidence)).
 */
const doc = readS3Json<Record<string, unknown>>('go-written/real-bvn1-billing-receipts.portable.json.gz');
const expectG = readS3Json<{ v: string; summary: Record<string, unknown>; evLen: number }>('go-written/real-bvn1-billing-receipts.expect.json');

/**
 * RB9-F6, F-VE-2 (b): the committed real document is a live continuous capture that does not name its chain, so the offline walk refuses it. The suites
 * below judge it with Kermit's recorded genesis link attached (helpers/s3.ts recordedGenesisLink), as the validator's tests do; the file is untouched.
 */
const linked = withRecordedGenesisLink(doc);

describe('the real Kermit document without a genesis link', () => {
  it('is refused certify_link_missing{genesis} by the offline entry: a live continuous capture that does not name its chain cannot be tied to the incarnation', () => {
    const got: Judged = judgeDocument(doc);
    expect(got.verdict).toBe('plain');
    if (got.verdict === 'plain') expect(got.message.startsWith('certify_link_missing{genesis}')).toBe(true);
  });
});

describe('the real Kermit document (BVN1, 14713382)', () => {
  it('is verified with exactly the report Go produced (with Kermit\'s recorded genesis link)', () => {
    const got: Judged = judgeDocument(linked);
    expect(got.verdict).toBe('verified');
    if (got.verdict === 'verified') expect(got.summary).toEqual(expectG.summary);
  });

  it('is complete: nothing unproven, the votes re-evaluated on the certified timeline, only the certificate-dependent role declared', () => {
    const got = judgeDocument(linked);
    if (got.verdict !== 'verified') throw new Error('not verified');
    expect(got.summary.unproven).toEqual([]);
    expect(got.summary.authorizationMode).toBe('authorities_required');
    expect(got.summary.arrivals.map((a) => a.kind)).toEqual(['signature', 'produced']);
    expect(got.summary.routingHeight).toBe(1);
    const declared = got.summary.proven.flatMap((p) => p.declared);
    expect(declared).toEqual(['certified-key-page']);
    expect(got.summary.pagesBound).toBe(got.summary.proven.length);
  });

  it('measures the evidence budget as Go does: len(json.Marshal(evidence))', () => {
    const ev = importEvidence(doc);
    expect(Buffer.byteLength(evidenceJson(ev), 'utf8')).toBe(expectG.evLen);
  });
});
