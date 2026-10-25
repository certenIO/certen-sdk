/**
 * finality_adiri4 (pv2/rb11-gate-a@a74f662; a byte-identical copy under test/fixtures/finality/adiri4): the pins-strictness verdicts
 * (vectors.json, 21 vectors, the same shape as finality_adiri3) and the load-time checks of the genesis link (genesis_link.json, 12 vectors,
 * judged by checkGenesisLink). Every expectation is the Go-written literal.
 */
import { describe, expect, it } from 'vitest';
import { checkGenesisLink } from '../../../src/proof-v2/finality/adiri/index.js';
import { FinalityStateError, asNamed } from '../../../src/proof-v2/finality/state.js';
import { MANIFEST4_SHA256, bytesOfHex, judge, pinsWithSection, readSet4, sha256Hex, vectors4 } from './vectorset.js';
import { registry } from './regcheck.js';

describe('finality_adiri4 identity', () => {
  it('MANIFEST.json hashes to the Go-written MANIFEST.json.sha256 and the pinned value; every listed file is byte-identical', () => {
    expect(sha256Hex(readSet4('MANIFEST.json'))).toBe(MANIFEST4_SHA256);
    expect(readSet4('MANIFEST.json.sha256').toString('utf8').trim()).toBe(MANIFEST4_SHA256);
    const m = JSON.parse(readSet4('MANIFEST.json').toString('utf8')) as { files: Record<string, string> };
    expect(Object.keys(m.files).sort()).toEqual(['README.md', 'evidence/syn-rotation.bin', 'genesis_link.json', 'link/genesis_link_1_290.bin', 'vectors.json']);
    for (const [f, want] of Object.entries(m.files)) expect(sha256Hex(readSet4(f)), f).toBe(want);
  });
  it('holds 21 pins vectors and 12 genesis-link vectors', () => {
    expect(vectors4().length).toBe(21);
    expect(new Set(vectors4().map((v) => v.name)).size).toBe(21);
    expect(vectors4().every((v) => v.group === 'pins')).toBe(true);
    const g = JSON.parse(readSet4('genesis_link.json').toString('utf8')) as { format: string; vectors: unknown[] };
    expect(g.format).toBe('finality_adiri4-genesis-link/1');
    expect(g.vectors.length).toBe(12);
  });
  it('every pins expectation is inside the closed registry', () => {
    for (const v of vectors4()) {
      const j = JSON.parse(v.expect) as { code: string; fields: Record<string, unknown> };
      if (j.code === 'finalized') continue;
      const r = registry.states[j.code]!;
      expect(r, v.name).toBeDefined();
      const allowed = new Set([...r.required, ...r.optional]);
      for (const f of r.required) expect(Object.keys(j.fields), `${v.name} lacks ${f}`).toContain(f);
      for (const [f, val] of Object.entries(j.fields)) {
        expect(allowed.has(f), `${v.name}: ${f}`).toBe(true);
        const set = r.enums?.[f];
        if (set) expect(set, `${v.name}: ${f}`).toContain(val);
      }
    }
  });
});

describe('finality_adiri4 pins vectors', () => {
  for (const v of vectors4()) {
    it(v.name, () => {
      const one = judge(v, { mode: 'oneByOne' }, 4);
      expect(one).toBe(v.expect);
      expect(judge(v, { mode: 'batched' }, 4)).toBe(one);
    });
  }
});

interface LinkVec {
  name: string;
  note: string;
  pins: unknown;
  link?: string;
  link_hex?: string;
  edits?: { offset: number; delete: number; insert: string }[];
  expect: string;
}

function linkFile(v: LinkVec): Uint8Array {
  if (v.link_hex !== undefined) return bytesOfHex(v.link_hex);
  let out = Uint8Array.from(readSet4(v.link!));
  for (const e of [...(v.edits ?? [])].sort((a, b) => b.offset - a.offset)) {
    const ins = bytesOfHex(e.insert);
    const next = new Uint8Array(e.offset + ins.length + (out.length - e.offset - e.delete));
    next.set(out.subarray(0, e.offset), 0);
    next.set(ins, e.offset);
    next.set(out.subarray(e.offset + e.delete), e.offset + ins.length);
    out = next;
  }
  return out;
}

describe('finality_adiri4 genesis-link vectors (the load-time check)', () => {
  const vs = (JSON.parse(readSet4('genesis_link.json').toString('utf8')) as { vectors: LinkVec[] }).vectors;
  for (const v of vs) {
    it(v.name, () => {
      let got = 'ok';
      try {
        checkGenesisLink(linkFile(v), pinsWithSection(v.pins));
      } catch (e) {
        const s = asNamed(e);
        got = s instanceof FinalityStateError ? s.canonical() : `ERROR: ${e instanceof Error ? e.message : String(e)}`;
      }
      expect(got).toBe(v.expect);
    });
  }
});
