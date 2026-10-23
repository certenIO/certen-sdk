/**
 * What the hand-mutation gate found the other tests did not pin: the words of a refusal, an empty subject, the class of a syntax error, the option alone through the
 * asynchronous entries, and where the layer S7 goes in a core with no in-document layer.
 */
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { finality, verifyProofDocument, type Verification } from '../../../src/index.js';
import { applyFinality } from '../../../src/layers.js';
import { judgeFinalityText } from '../../../src/proof-v2/finality/docreport.js';
import { parseSettlementJSON, SettlementJsonError } from '../../../src/proof-v2/finality/settlementjson.js';
import { readSet } from './support.js';

const file = JSON.parse(readSet('settlements', 'base_sepolia_47368146.json').toString('utf8')) as { settlement: Record<string, any> };
const good = (): Record<string, any> => structuredClone(file.settlement);
const read = (o: unknown) => parseSettlementJSON(JSON.stringify(o));

describe('a refusal of the Settlement reader names the JSON type it met', () => {
  const dir = new URL('../../fixtures/proofv2/', import.meta.url);
  void dir;
  it('for each kind of value', () => {
    const expectMsg = (mutate: (o: Record<string, any>) => void, re: RegExp): void => {
      const o = good();
      mutate(o);
      expect(() => read(o)).toThrow(re);
    };
    expectMsg((o) => (o.block_hash = null), /block_hash: null is not a hex string/);
    expectMsg((o) => (o.block_hash = 5), /block_hash: number is not a hex string/);
    expectMsg((o) => (o.block_hash = []), /block_hash: array is not a hex string/);
    expectMsg((o) => (o.block_hash = {}), /block_hash: object is not a hex string/);
    expectMsg((o) => (o.block_hash = true), /block_hash: bool is not a hex string/);
    expectMsg((o) => (o.block_hash = 'x'), /block_hash: missing 0x prefix/);
    expectMsg((o) => (o.tx_inclusion_proof.verified = 'yes'), /tx_inclusion_proof.verified: string is not a bool/);
    expectMsg((o) => (o.tx_inclusion_proof.leaf_index = true), /tx_inclusion_proof.leaf_index: bool is not a uint64/);
    expectMsg((o) => (o.tx_inclusion_proof = 5), /tx_inclusion_proof: number is not an object/);
  });
  it('and a text that is not JSON is a SettlementJsonError, not the parser\'s own error', () => {
    for (const t of ['', '{', '{} x', 'nul', '{"a":}']) expect(() => parseSettlementJSON(t), JSON.stringify(t)).toThrow(SettlementJsonError);
  });
});

describe('an empty subject is a subject', () => {
  it('the report names the document as the caller said, even when that is nothing', () => {
    expect(judgeFinalityText('{}', { subject: '' }).text).toBe('SUMMARY-ONLY (finality)  \n  the document carries no finality section: no level beyond the proof itself is evidenced.\n');
    expect(judgeFinalityText('{}').text.startsWith('SUMMARY-ONLY (finality)  document\n')).toBe(true);
  });
});

describe('the option alone, through the asynchronous entries', () => {
  const dir = new URL('../../fixtures/proofv2/', import.meta.url);
  const manifest = JSON.parse(readFileSync(new URL('manifest.json', dir), 'utf8'));
  const valid = (): Record<string, unknown> => JSON.parse(gunzipSync(readFileSync(new URL(manifest.base, dir))).toString('utf8'));
  it('a document with no member and an empty option is judged, and says there is no finality section', async () => {
    const v = await finality.verifyProofDocumentWithKinds(valid(), { finality: {} });
    expect(v.layers.find((l) => l.id === 'S7')?.verdict).toBe('not_checked');
    expect(v.finality?.text).toContain('the document carries no finality section');
    const r = await finality.verifyPortableWithKinds(valid(), undefined, { finality: {} });
    expect(r.finality?.class).toBe('summary_only');
    expect(r.finality?.text).toContain('the document carries no finality section');
    // and with neither a member nor an option the report has no section at all
    expect((await finality.verifyPortableWithKinds(valid())).finality).toBeUndefined();
    expect((await finality.verifyProofDocumentWithKinds(valid())).finality).toBeUndefined();
  }, 120_000);
});

describe('applyFinality placement', () => {
  it('puts the layer S7 first when the core has no in-document layer, and last of the in-document ones otherwise', () => {
    const outside: Verification = {
      overall: 'partial',
      independent: false,
      layers: [
        { id: 'G2', statement: 'S4', title: 't', verdict: 'not_in_document', evidence: {} },
        { id: 'L5', statement: 'S9', title: 't', verdict: 'not_in_document', evidence: {} },
      ],
      covers: [],
      notCovered: [],
    };
    const f = judgeFinalityText('{}', { subject: 'DOC' });
    expect(applyFinality(outside, f).layers.map((l) => l.id)).toEqual(['S7', 'G2', 'L5']);
    const none: Verification = { ...outside, layers: [] };
    expect(applyFinality(none, f).layers.map((l) => l.id)).toEqual(['S7']);
    void verifyProofDocument;
  });
});
