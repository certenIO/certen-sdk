import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { noEvidence, verifyProofDocument, type Verification } from '../src/index.js';

/**
 * The per-layer engine over the same conformance suite the Go verifier runs: the valid case yields a verdict per layer, and
 * each tampered case fails at the layer the tamper is in, with every later layer named "not reached" rather than assumed.
 */
const dir = new URL('./fixtures/proofv2/', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('manifest.json', dir), 'utf8'));
const base = gunzipSync(readFileSync(new URL(manifest.base, dir))).toString('utf8');

function applyPatch(doc: any, ops: any[]): void {
  for (const op of ops ?? []) {
    let cur = doc;
    op.path.forEach((k: string | number, i: number) => {
      if (i === op.path.length - 1) {
        if (op.delete) delete cur[k];
        else if (op.truncate !== undefined) cur[k] = cur[k].slice(0, op.truncate);
        else cur[k] = op.set;
      }
      cur = cur[k];
    });
  }
}
const run = (name: string): Verification => {
  const c = manifest.cases.find((x: { name: string }) => x.name === name);
  const doc = JSON.parse(base);
  applyPatch(doc, c.patch);
  return verifyProofDocument(doc);
};
const verdicts = (v: Verification) => Object.fromEntries(v.layers.map((l) => [l.id, l.verdict]));

/** The layer each conformance attack must be reported at. */
const FAILS_AT: Record<string, string> = {
  'receipt-step': 'L1',
  'tx-swap': 'L1',
  'sigs-stripped': 'L4',
  'sig-forged': 'L4',
  'root-fork': 'L4',
  'major-skipped': 'L4',
  'archive-short': 'L4',
  'anchor-major-altered': 'L4',
  'network-entry-altered': 'L4_set',
  'network-record-altered': 'L4_set',
  'main-height-understated': 'L4_set',
  'set-check-majors-mismatch': 'L4_set',
  'page-threshold': 'G1',
  'page-step-dropped': 'G1',
  'page-url-swap': 'G1',
  'anchor-block-altered': 'L2',
  'pin-other': 'trust_base',
  'genesis-record-altered': 'trust_base',
  'genesis-json-altered': 'trust_base',
  'version-unknown': 'trust_base',
  'format-unknown': 'trust_base',
};

describe('per-layer verification of the conformance document', () => {
  const valid = run('valid');

  it('names a verdict for every layer, and checks every layer the document carries', () => {
    expect(valid.layers.map((l) => l.id)).toEqual(['trust_base', 'L4', 'L1', 'L2', 'L3', 'G0', 'G1', 'G1_chains', 'L4_set', 'govRootV3', 'G1b', 'G2', 'L5', 'outcome']);
    const v = verdicts(valid);
    for (const id of ['trust_base', 'L4', 'L1', 'L2', 'L3', 'G0', 'G1', 'L4_set', 'govRootV3']) expect(v[id], id).toBe('verified');
    for (const id of ['G1b', 'G2', 'L5', 'outcome']) expect(v[id], id).toBe('not_in_document');
  });

  it('prints the evidence each layer was checked against', () => {
    const by = Object.fromEntries(valid.layers.map((l) => [l.id, l]));
    expect(by.trust_base.evidence.incarnation).toBe(manifest.cases[0].report.incarnation);
    expect(by.L4.evidence).toMatchObject({ majorBlocks: manifest.cases[0].report.majors, certifiedDirectoryBlock: manifest.cases[0].report.certifiedBlock });
    expect(by.L3.evidence.certifiedRoot).toBe(manifest.cases[0].report.certifiedRoot);
    expect(by.L2.evidence).toMatchObject({ partition: manifest.cases[0].report.partition, anchorBlock: manifest.cases[0].report.anchorBlock });
    expect(by.govRootV3.evidence.root).toBe(manifest.cases[0].report.govRootV3);
    expect(by.L4_set.evidence.accumulateSetRoot).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is partial, not verified, while a page\'s chain history is not bound (the capture could not read it)', () => {
    const chains = valid.layers.find((l) => l.id === 'G1_chains')!;
    if (chains.verdict === 'verified') {
      expect(valid.overall).toBe('verified');
    } else {
      expect(chains.verdict).toBe('not_checked');
      expect(chains.reason).toMatch(/not bound/);
      expect(valid.overall).toBe('partial');
      expect(valid.independent).toBe(false);
      expect(valid.covers).toEqual([]);
    }
  });

  it('never reports covered statements it did not establish, and always lists what the document cannot speak to', () => {
    expect(valid.notCovered).toEqual(expect.arrayContaining(['S3(b)', 'S4', 'S6', 'S9']));
    expect(valid.report?.certifiedBlock).toBe(manifest.cases[0].report.certifiedBlock);
  });

  it('compares the computed govRoot v3 with an expected one and fails on a mismatch', () => {
    const ok = verifyProofDocument(JSON.parse(base), { expectGovRoot: manifest.cases[0].report.govRootV3 });
    expect(ok.layers.find((l) => l.id === 'govRootV3')).toMatchObject({ verdict: 'verified', evidence: { comparedWith: manifest.cases[0].report.govRootV3 } });
    const bad = verifyProofDocument(JSON.parse(base), { expectGovRoot: '0x' + '11'.repeat(32) });
    expect(bad.overall).toBe('failed');
    expect(bad.failure?.layer).toBe('govRootV3');
  });

  it('does not derive govRoot v3 for a document without its inputs', () => {
    const doc = JSON.parse(base);
    delete doc.govRootV3Inputs;
    const v = verifyProofDocument(doc);
    expect(v.layers.find((l) => l.id === 'govRootV3')).toMatchObject({ verdict: 'not_checked', reason: expect.stringMatching(/govRootV3Inputs/) });
    expect(v.overall).not.toBe('verified');
  });
});

describe('each tamper fails at its own layer', () => {
  const attacks = manifest.cases.filter((c: { expect: string }) => c.expect === 'refused');
  it('covers every refused case in the suite', () => {
    expect(attacks.map((c: { name: string }) => c.name).sort()).toEqual(Object.keys(FAILS_AT).sort());
  });
  for (const c of attacks) {
    it(`${c.name} -> ${FAILS_AT[c.name]}`, () => {
      const v = run(c.name);
      expect(v.overall).toBe('failed');
      expect(v.independent).toBe(false);
      expect(v.covers).toEqual([]);
      expect(v.failure?.layer).toBe(FAILS_AT[c.name]);
      const failed = v.layers.filter((l) => l.verdict === 'failed');
      expect(failed.map((l) => l.id)).toEqual([FAILS_AT[c.name]]);
      expect(failed[0].reason).toBeTruthy();
      // nothing after the failure is claimed as checked: layers not yet reached are not_checked, never verified
      const idx = v.layers.findIndex((l) => l.id === FAILS_AT[c.name]);
      expect(v.layers.slice(0, idx).every((l) => l.verdict !== 'failed')).toBe(true);
    }, 30000);
  }
});

describe('input that is not a proof document', () => {
  it('a missing, empty or foreign document fails at the first layer; it is never partial or verified', () => {
    for (const d of [undefined, null, 'x', 7, {}, { format: 'something-else' }]) {
      const v = verifyProofDocument(d);
      expect(v.overall).toBe('failed');
      expect(v.failure?.layer).toBe('trust_base');
    }
  });

  it('no evidence at all is its own verdict, with every in-scope layer unchecked and nothing covered', () => {
    const v = noEvidence('the gateway does not serve proof v2 evidence');
    expect(v.overall).toBe('no_evidence');
    expect(v.independent).toBe(false);
    expect(v.layers.filter((l) => l.verdict === 'verified')).toEqual([]);
    expect(v.layers.find((l) => l.id === 'L4')?.reason).toMatch(/does not serve/);
  });

  it('a flag in the document is never read as a verdict', () => {
    const doc = JSON.parse(base);
    doc.verified = true;
    doc.evidence.verified = true;
    delete doc.evidence.receipt.anchor;
    const v = verifyProofDocument(doc);
    expect(v.overall).toBe('failed');
  });
});
