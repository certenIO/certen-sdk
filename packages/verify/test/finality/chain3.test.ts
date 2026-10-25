/**
 * The parity oracle of finality_chain3 (validator pv2/rb12-outcome-tx, R12-OUTCOME-TX): the optional `leg.headerRlp` of the portable finality
 * member. The files are a byte-identical copy of the validator's set (never edited); every vector is judged here as Go judges it (parseSection,
 * then carriedLegRef when the parse succeeded) and compared with the Go-written expected string BYTE FOR BYTE.
 */
import { describe, expect, it } from 'vitest';
import { carriedLegRef, newSectionWithHeader, parseSection, sectionToJSON } from '../../src/proof-v2/finality/addendum.js';
import { judgeFinalityText } from '../../src/proof-v2/finality/docreport.js';
import { canonOf } from '../../src/proof-v2/finality/state.js';
import { fixtureJSON, hexToBytes, readFixture, sha256Hex } from './helpers.js';

const MANIFEST_SHA256 = '867e31da9b0a10ab25d647e776ce3bb60165a20f62eee831fbc0d1f4a884a178';
const headers = fixtureJSON('finality_chain3', 'generator', 'headers.json').headers as Record<string, { chain: number; number: number; hash: string; headerRlp: string }>;

describe('finality_chain3 identity', () => {
  it('the manifest is the Go-written one and pins every file', () => {
    const manifest = readFixture('finality_chain3', 'MANIFEST.json');
    expect(sha256Hex(manifest)).toBe(MANIFEST_SHA256);
    expect(readFixture('finality_chain3', 'MANIFEST.json.sha256').toString('utf8').trim()).toBe(MANIFEST_SHA256);
    const files = JSON.parse(manifest.toString('utf8')).files as Record<string, string>;
    expect(Object.keys(files).sort()).toEqual(['README.md', 'generator/gen_chain3.mjs', 'generator/headers.json', 'legs.json']);
    for (const [name, sha] of Object.entries(files)) expect(sha256Hex(readFixture('finality_chain3', ...name.split('/')))).toBe(sha);
  });
});

describe('finality_chain3/legs.json', () => {
  const vectors = fixtureJSON('finality_chain3', 'legs.json').vectors as { name: string; input: string; expect: string; headerBytes?: number }[];
  it('has the 14 vectors of the Go suite', () => expect(vectors.length).toBe(14));
  it.each(vectors.map((v) => [v.name, v] as const))('%s', (_n, v) => {
    let got = 'ok';
    let headerBytes = 0;
    try {
      const ref = carriedLegRef(parseSection(v.input).leg);
      headerBytes = ref.headerRlp?.length ?? 0;
    } catch (e) {
      got = canonOf(e);
    }
    expect(got).toBe(v.expect);
    if (v.expect === 'ok') expect(headerBytes).toBe(v.headerBytes);
  });
});

describe('a section that carries its header, judged from the document alone', () => {
  const base = headers.base_sepolia_47368146!;
  const other = headers.telcoin_adiri_498759!;
  const ref = (h: (typeof base)) => ({ chain: BigInt(h.chain), number: BigInt(h.number), hash: hexToBytes(h.hash), headerRlp: hexToBytes(h.headerRlp) });
  const doc = (section: string) => `{"format":"certen-proof-v2-accumulate-portable/1","finality":${section}}`;

  it('round-trips through sectionToJSON and parseSection, and a header-less leg renders without the member', () => {
    const s = newSectionWithHeader(ref(base), []);
    const back = parseSection(sectionToJSON(s));
    expect(back.leg.headerRlp).toBe(base.headerRlp);
    expect(carriedLegRef(back.leg).headerRlp).toEqual(hexToBytes(base.headerRlp));
    expect(sectionToJSON(newSectionWithHeader({ ...ref(base), headerRlp: undefined }, []))).not.toContain('headerRlp');
  });
  it('is judged with no Settlement source: D0 is recomputed from the carried block and level 1 is not claimed', () => {
    const d = judgeFinalityText(doc(sectionToJSON(newSectionWithHeader(ref(base), []))), { subject: 'doc' });
    expect(d.class).not.toBe('failed');
    expect(d.text).toContain('Settlement source: none; the leg carries its block header');
    expect(d.text).toContain('finality_included_unavailable');
    expect(d.text).toContain('no_settlement');
    expect(d.text).not.toContain('no_settlement_to_recompute_d0');
  });
  it('without a header and without a Settlement it stays summary-only, as before', () => {
    const plain = sectionToJSON(newSectionWithHeader({ ...ref(base), headerRlp: undefined }, []));
    const d = judgeFinalityText(doc(plain), { subject: 'doc' });
    expect(d.class).toBe('summary_only');
    expect(d.text).toContain('no_settlement_to_recompute_d0');
  });
  it('a header of another block, and a block number other than the header\'s, are leg_binding failures', () => {
    const wrongBlock = sectionToJSON({ ...newSectionWithHeader(ref(base), []), leg: { ...newSectionWithHeader(ref(base), []).leg, headerRlp: other.headerRlp } });
    const a = judgeFinalityText(doc(wrongBlock), { subject: 'doc' });
    expect(a.class).toBe('failed');
    expect(a.text).toContain('leg_binding');
    expect(a.text).toContain('blockHash');
    const s = newSectionWithHeader(ref(base), []);
    const wrongNumber = sectionToJSON({ ...s, leg: { ...s.leg, blockNumber: s.leg.blockNumber + 1n } });
    const b = judgeFinalityText(doc(wrongNumber), { subject: 'doc' });
    expect(b.class).toBe('failed');
    expect(b.text).toContain('blockNumber');
  });
});
