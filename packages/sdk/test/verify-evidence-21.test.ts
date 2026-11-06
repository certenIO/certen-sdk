import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { verifyBundle, verifyEvidence } from '../src/verify.js';

/**
 * `verifyEvidence` on evidence 2.1, the version the validators emit: a real proof of a real contract call on Base Sepolia (the verifier's fixtures/live21-base-sepolia).
 *
 * `certen proof verify`, `certen send` / `watch` / `receipt` and the MCP tools all verify through this function, and until it handled 2.1 each answered "failed at
 * trust_base: not a v2 Accumulate proof" for every proof the live gateway served. It now verifies the Accumulate side from the document, judges the finality section
 * (S7) against the Settlement in the bundle's own execution component, and the execution outcome against a header from the caller's own node.
 */
const dir = new URL('../../verify/test/fixtures/live21-base-sepolia/', import.meta.url);
const doc = (): Record<string, any> => JSON.parse(gunzipSync(readFileSync(new URL('portable.json.gz', dir))).toString('utf8'));
const bundle = (): Record<string, any> => JSON.parse(readFileSync(new URL('bundle.json', dir), 'utf8'));
const component = (): Record<string, any> => bundle().proof_components['5_execution_proof'];
const header = () => ({ hash: component().block_hash as string, receiptsRoot: component().receipts_root as string, number: String(component().block_number) });
const EMITTER = '0x12dD00C619C1Ac3F58eC68ed44ec1023fE33B9Ff';
const TOPIC0 = '0x5b0ad3c09f09584bfc917bcf1e3138cdb459d5c6c7e211c5320922f55c0f7fe9';
const GOVROOT_V4 = 'fcf46aa282d2ab79cc9f8b305cd87075745e3d31e48ce5e8077d3a166a3afe17';
const layer = (v: { layers: { id: string }[] }, id: string) => v.layers.find((l) => l.id === id) as { id: string; verdict: string; reason?: string; evidence: Record<string, any> } | undefined;

describe('verifyEvidence on evidence 2.1', () => {
  it('verifies the whole proof: every layer, the finality at the level reached, and the outcome against the caller\'s own header', async () => {
    const v = await verifyEvidence({ bundle: bundle(), portable: doc() }, { header: header(), expect: { address: EMITTER, topic0: TOPIC0 } });
    expect(v.overall).toBe('verified');
    expect(v.independent).toBe(true);
    expect(v.failure).toBeUndefined();
    for (const id of ['trust_base', 'L4', 'L1', 'L2', 'L3', 'G0', 'G1', 'G1_chains', 'L4_set', 'govRootV4', 'S7', 'outcome']) expect(layer(v, id)?.verdict, id).toBe('verified');
    expect(layer(v, 'S7')!.evidence.headline).toBe('l1_posted');
    expect(v.govRootV4).toBe(GOVROOT_V4);
    expect(v.execution?.ok).toBe(true);
    expect(v.execution?.expectedLogFound).toBe(true);
    expect(v.headerCheck).toEqual({ ok: true, reasons: [] });
    expect(v.nodeConsulted).toBe(true);
    // what a verified result covers names what the finality section established, and the execution
    expect(v.covers).toEqual(expect.arrayContaining(['S1', 'S2', 'S3(a)', 'S6', 'S7(l1_posted)']));
    expect(v.notCovered).not.toContain('S7');
    expect(v.notCovered).not.toContain('S6');
  }, 180_000);

  it('without a header of the caller\'s own, the outcome is not checked and the whole is partial, never verified', async () => {
    const v = await verifyEvidence({ bundle: bundle(), portable: doc() }, {});
    expect(layer(v, 'outcome')!.verdict).toBe('not_checked');
    expect(layer(v, 'S7')!.verdict).toBe('verified');
    expect(v.overall).toBe('partial');
    expect(v.independent).toBe(false);
    expect(v.covers).toEqual([]);
    expect(v.nodeConsulted).toBe(false);
  }, 180_000);

  it('a header that disagrees fails the outcome, and so the proof', async () => {
    const h = header();
    const wrong = { ...h, receiptsRoot: `0x${'00'.repeat(32)}` };
    const v = await verifyEvidence({ bundle: bundle(), portable: doc() }, { header: wrong });
    expect(layer(v, 'outcome')!.verdict).toBe('failed');
    expect(layer(v, 'outcome')!.reason).toMatch(/disagrees/);
    expect(v.overall).toBe('failed');
    expect(v.failure?.layer).toBe('outcome');
  }, 180_000);

  it('an event the receipt must contain but does not fails the outcome', async () => {
    const v = await verifyEvidence({ bundle: bundle(), portable: doc() }, { header: header(), expect: { address: EMITTER, topic0: `0x${'11'.repeat(32)}` } });
    expect(layer(v, 'outcome')!.verdict).toBe('failed');
    expect(layer(v, 'outcome')!.reason).toMatch(/expected event is not in the receipt/);
    expect(v.overall).toBe('failed');
  }, 180_000);

  it('the root you expect: the right one verifies, a wrong one fails at govRootV4', async () => {
    const ok = await verifyEvidence({ bundle: bundle(), portable: doc() }, { header: header(), expectGovRoot: `0x${GOVROOT_V4}` });
    expect(layer(ok, 'govRootV4')!.evidence.comparedWith).toBe(GOVROOT_V4);
    expect(ok.overall).toBe('verified');
    const bad = await verifyEvidence({ bundle: bundle(), portable: doc() }, { header: header(), expectGovRoot: `0x${'ab'.repeat(32)}` });
    expect(bad.overall).toBe('failed');
    expect(bad.failure?.layer).toBe('govRootV4');
  }, 180_000);

  it('a bundle with no execution component has no Settlement to judge the finality by: S7 is not checked and the proof is partial', async () => {
    const b = bundle();
    delete b.proof_components['5_execution_proof'];
    const v = await verifyEvidence({ bundle: b, portable: doc() }, {});
    expect(layer(v, 'S7')!.verdict).toBe('not_checked');
    expect(layer(v, 'outcome')!.verdict).toBe('not_checked');
    expect(v.overall).toBe('partial');
  }, 180_000);

  it('a tampered Settlement fails the finality layer: the header in the bundle must hash to the block it names', async () => {
    const b = bundle();
    const c = b.proof_components['5_execution_proof'];
    c.block_header_rlp = `${c.block_header_rlp.slice(0, -2)}${c.block_header_rlp.slice(-2) === '00' ? '01' : '00'}`;
    const v = await verifyEvidence({ bundle: b, portable: doc() }, {});
    expect(layer(v, 'S7')!.verdict).toBe('failed');
    expect(v.overall).toBe('failed');
  }, 180_000);

  it('a document that carries no finality section has no S7 layer and is verified as before (the section is judged only where there is one)', async () => {
    const d = doc();
    delete d.finality;
    const v = await verifyEvidence({ bundle: bundle(), portable: d }, { header: header() });
    expect(v.layers.map((l) => l.id)).not.toContain('S7');
    expect(v.overall).toBe('verified');
  }, 180_000);

  it('verifyBundle, which is synchronous and registers no finality kinds, leaves S7 not checked: the proof is partial, and says why', () => {
    const v = verifyBundle({ ...bundle(), proof_v2: doc() }, { header: header() });
    expect(layer(v, 'S7')!.verdict).toBe('not_checked');
    expect(layer(v, 'govRootV4')!.verdict).toBe('verified');
    expect(v.overall).toBe('partial');
  }, 180_000);
});
