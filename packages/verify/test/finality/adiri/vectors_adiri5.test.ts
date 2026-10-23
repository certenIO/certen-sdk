/**
 * finality_adiri5 (RB11-F1-FIX; pv2/rb11-f1-fix@690ceb6, the same bytes at pv2/rb11-e1-raise@cbb6373; a byte-identical copy under
 * test/fixtures/finality/adiri5): 10 linkKind 2 vectors (the leg is bound to the EIP-2935 ring: F.number - N <= 8190, a non-zero hash, its own
 * header) and 4 min_committee_size vectors (the pin floor is Telcoin's own shrink floor of four). Every expectation is the Go-written literal;
 * the verdict is compared in BOTH signature modes.
 */
import { describe, expect, it } from 'vitest';
import { MANIFEST5_SHA256, judge, readSet5, sha256Hex, vectors5 } from './vectorset.js';
import { registry } from './regcheck.js';

describe('finality_adiri5 identity', () => {
  it('MANIFEST.json hashes to the Go-written MANIFEST.json.sha256 and the pinned value; every listed file is byte-identical', () => {
    expect(MANIFEST5_SHA256).toBe('03d404a86420d20a652bc3057a045e55d63082b8948df4e0d35f104bdff00b9a');
    expect(sha256Hex(readSet5('MANIFEST.json'))).toBe(MANIFEST5_SHA256);
    expect(readSet5('MANIFEST.json.sha256').toString('utf8').trim()).toBe(MANIFEST5_SHA256);
    const m = JSON.parse(readSet5('MANIFEST.json').toString('utf8')) as { format: string; files: Record<string, string> };
    expect(m.format).toBe('finality_adiri5/manifest/1');
    expect(Object.keys(m.files).sort()).toEqual([
      'evidence/slot5-alias-9000-claimed-809-no-leg-header.bin',
      'evidence/slot5-alias-9000-claimed-809.bin',
      'evidence/slot5-leg-hash-absent-slot.bin',
      'evidence/slot5-leg-header-hash-mismatch.bin',
      'evidence/slot5-leg-header-number-mismatch.bin',
      'evidence/slot5-leg-header-ok.bin',
      'evidence/slot5-leg-header-undecodable.bin',
      'evidence/slot5-window-8191-refused.bin',
      'evidence/slot5-window-edge-8190-accepted.bin',
      'evidence/slot5-zero-leg-hash-absent-slot.bin',
      'evidence/syn-rotation.bin',
      'vectors.json',
    ]);
    for (const [f, want] of Object.entries(m.files)) expect(sha256Hex(readSet5(f)), f).toBe(want);
  });

  it('holds 14 vectors: 10 slot and 4 pins, format finality_adiri5/1, names unique', () => {
    const vs = vectors5();
    const groups: Record<string, number> = {};
    for (const v of vs) groups[v.group] = (groups[v.group] ?? 0) + 1;
    expect(vs.length).toBe(14);
    expect(groups).toEqual({ slot: 10, pins: 4 });
    expect(new Set(vs.map((v) => v.name)).size).toBe(14);
    expect((JSON.parse(readSet5('vectors.json').toString('utf8')) as { format: string }).format).toBe('finality_adiri5/1');
  });

  it('every expectation is inside the closed registry (the slot refusals carry the free-form block-mismatch field)', () => {
    for (const v of vectors5()) {
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

describe('finality_adiri5 vectors', () => {
  for (const v of vectors5()) {
    it(v.name, () => {
      const one = judge(v, { mode: 'oneByOne' }, 5);
      expect(one).toBe(v.expect);
      expect(judge(v, { mode: 'batched' }, 5)).toBe(one);
    });
  }
});
