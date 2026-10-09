import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { verifyBundle, portableDocumentOf, PROOF_V2_EVIDENCE_NOT_SERVED } from '../src/verify.js';
import { executionComponentOf } from '../src/execution-proof.js';

/**
 * `@certen.io/sdk/verify`: one verdict per layer from a bundle, the Accumulate side from the proof v2 portable document and the
 * outcome from the bundle's real execution component. The flags a bundle carries about itself are reported and never used.
 */
const confDir = new URL('../../verify/test/fixtures/proofv2/', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('manifest.json', confDir), 'utf8'));
const portable = JSON.parse(gunzipSync(readFileSync(new URL(manifest.base, confDir))).toString('utf8'));
const execBundle = JSON.parse(readFileSync(new URL('./fixtures/execution-proof-base-46437431.json', import.meta.url), 'utf8'));
const component = executionComponentOf(execBundle)!;
const headerOf = () => ({ hash: component.block_hash, receiptsRoot: component.receipts_root, number: '0x' + Number(component.block_number).toString(16) });

const ids = (v: { layers: { id: string; verdict: string }[] }) => Object.fromEntries(v.layers.map((l) => [l.id, l.verdict]));

describe('portableDocumentOf', () => {
  it('finds the document itself, or one embedded as proof_v2 (also inside a share wrapper)', () => {
    expect(portableDocumentOf(portable)).toBe(portable);
    expect(portableDocumentOf({ proof_v2: portable })).toBe(portable);
    expect(portableDocumentOf({ bundle: { proof_v2: portable } })).toBe(portable);
  });
  it('finds nothing otherwise', () => {
    for (const x of [null, undefined, 'x', {}, execBundle, { proof_v2: 3 }]) expect(portableDocumentOf(x)).toBeNull();
  });
});

describe('verifyBundle', () => {
  it('without proof v2 evidence: nothing is verified, whatever the bundle says about itself', () => {
    const v = verifyBundle({ ...execBundle, verified: true, proof_components: { ...execBundle.proof_components, '3_chained_proof': { verified: true } } });
    expect(v.overall).not.toBe('verified');
    expect(v.independent).toBe(false);
    expect(v.evidenceFound).toBe(false);
    expect(ids(v).L4).toBe('not_checked');
    expect(v.layers.find((l) => l.id === 'L4')?.reason).toContain(PROOF_V2_EVIDENCE_NOT_SERVED);
    // the bundle's statements are shown as such
    expect(v.bundleStatements).toEqual({ verified: true, chainedProofVerified: true });
  });

  it('with no evidence at all (a bare flag): no_evidence', () => {
    const v = verifyBundle({ verified: true });
    expect(v.overall).toBe('no_evidence');
    expect(v.independent).toBe(false);
    expect(v.covers).toEqual([]);
  });

  it('with the document and the real execution component: every Accumulate layer and the outcome, per layer', () => {
    const v = verifyBundle({ ...execBundle, proof_v2: portable }, { header: headerOf() });
    const r = ids(v);
    for (const id of ['trust_base', 'L4', 'L1', 'L2', 'L3', 'G0', 'G1', 'L4_set', 'govRootV3', 'outcome']) expect(r[id], id).toBe('verified');
    expect(v.execution?.ok).toBe(true);
    expect(v.headerCheck?.ok).toBe(true);
    // G1_chains is not bound in the recorded capture, so the overall verdict is partial and says so
    expect(r.G1_chains).toBe('not_checked');
    expect(v.overall).toBe('partial');
    expect(v.independent).toBe(false);
  });

  it('without a header the receipt is only in the validators\' receipts root: the outcome is not_checked, not verified', () => {
    const v = verifyBundle({ ...execBundle, proof_v2: portable });
    const o = v.layers.find((l) => l.id === 'outcome')!;
    expect(o.verdict).toBe('not_checked');
    expect(o.reason).toMatch(/validators' statement/);
    expect(o.evidence.headerChecked).toBeNull();
  });

  it('a header that disagrees fails the outcome', () => {
    const v = verifyBundle({ ...execBundle, proof_v2: portable }, { header: { ...headerOf(), receiptsRoot: '0x' + '11'.repeat(32) } });
    expect(v.overall).toBe('failed');
    expect(v.failure?.layer).toBe('outcome');
  });

  it('an expected event that is not there fails the outcome', () => {
    const v = verifyBundle({ ...execBundle, proof_v2: portable }, { header: headerOf(), expect: { address: '0x' + '22'.repeat(20), topic0: '0x' + '33'.repeat(32) } });
    expect(v.layers.find((l) => l.id === 'outcome')?.verdict).toBe('failed');
    expect(v.overall).toBe('failed');
  });

  it('a tampered document fails at its layer even when the bundle claims verified', () => {
    const bad = JSON.parse(JSON.stringify(portable));
    bad.evidence.receipt.entries[0].hash = 'ab'.repeat(32);
    const v = verifyBundle({ ...execBundle, verified: true, proof_v2: bad }, { header: headerOf() });
    expect(v.overall).toBe('failed');
    expect(v.failure?.layer).toBe('L1');
    expect(v.independent).toBe(false);
  });

  it('a tampered execution receipt fails the outcome while the document verifies', () => {
    const bad = JSON.parse(JSON.stringify(execBundle));
    const c = bad.proof_components['5_execution_proof'];
    c.receipts_root = '0x' + '00'.repeat(32);
    const v = verifyBundle({ ...bad, proof_v2: portable }, { header: headerOf() });
    expect(v.layers.find((l) => l.id === 'outcome')?.verdict).toBe('failed');
    expect(v.overall).toBe('failed');
  });
});

describe('no code path turns a bundle flag into a verdict', () => {
  const SOURCES = ['../../sdk/src/verify.ts', '../../cli/src/commands/proof.ts', '../../mcp/src/tools.ts', '../../verify/src/layers.ts'];
  it('reads `verified` only to report it', () => {
    for (const rel of SOURCES) {
      const text = readFileSync(new URL(rel, import.meta.url), 'utf8');
      // every read of the bundle's flags goes through bundleStatements, labelled as the validators' statement
      const reads = [...text.matchAll(/\.verified\b|\bverified\s*===|\bverified\s*\?/g)].map((m) => text.slice(Math.max(0, m.index! - 80), m.index! + 60));
      for (const ctx of reads) expect(ctx, `${rel}: ${ctx}`).toMatch(/bundleStatements|chained\?\.verified|statement|validators|comparedWith|Statements|bundle\.verified|chainedProofVerified/i);
    }
  });
});
