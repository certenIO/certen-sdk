/** The pinned identity of the Go-published sets finality_arb_posted2, 3 and 4 (copies at pv2/rb11-e1-raise@cbb6373) and the supersession table of set 1. */
import { describe, expect, it } from 'vitest';
import { SUPERSEDED, caseNames, loadCase, read } from './vectorset.js';
import { SET2, SET3, SET4, sha256Hex } from './vectorsets.js';

for (const s of [SET2, SET3, SET4]) {
  describe(`${s.id.set} identity`, () => {
    it('MANIFEST.json hashes to the Go-written MANIFEST.json.sha256 and the pinned value', () => {
      expect(sha256Hex(s.read('MANIFEST.json'))).toBe(s.id.manifestSha256);
      expect(s.read('MANIFEST.json.sha256').toString('utf8').trim()).toBe(s.id.manifestSha256);
      const m = s.manifest();
      expect(m.format).toBe('certen-finality-manifest/1');
      expect(m.set).toBe(s.id.set);
    });

    it('every file the manifest lists is byte-identical to its recorded sha256', () => {
      const m = s.manifest();
      for (const [f, want] of Object.entries(m.files)) expect(sha256Hex(s.read(f)), f).toBe(want);
      expect(Object.keys(m.files).length).toBe(s.id.files);
    });

    it(`holds ${s.id.cases} cases, each listed in the manifest files, ${s.id.accepting.length} accepting and the rest refusals`, () => {
      const names = s.caseNames();
      expect(names.length).toBe(s.id.cases);
      expect(new Set(names).size).toBe(s.id.cases);
      const files = s.manifest().files;
      for (const n of names) expect(files[`cases/${n}.json`], n).toBeDefined();
      const accepted = names.filter((n) => s.loadCase(n).expect_canonical.startsWith('{"code":"verified"'));
      expect(accepted.sort()).toEqual([...s.id.accepting].sort());
    });
  });
}

describe('finality_arb_posted1 supersession (SUPERSEDED.md at cbb6373)', () => {
  it('SUPERSEDED.md is carried and names every case of the table, and only cases of the set', () => {
    const doc = read('SUPERSEDED.md').toString('utf8');
    const names = new Set(caseNames());
    expect(Object.keys(SUPERSEDED).length).toBe(9);
    for (const id of Object.keys(SUPERSEDED)) {
      expect(names.has(id), id).toBe(true);
      expect(doc.includes(id), id).toBe(true);
    }
  });

  it('every superseded case still carries its recorded expectation in the (unedited) file, and the table differs from it', () => {
    for (const [id, now] of Object.entries(SUPERSEDED)) {
      const c = loadCase(id);
      expect(c.expect_canonical, id).not.toBe(now);
    }
  });

  it('the seven re-bound twins exist in set 4 as <id>_container_bound with the set-1 expectation', () => {
    const twins = Object.keys(SUPERSEDED).filter((id) => !id.includes('zeroheavy'));
    expect(twins.length).toBe(7);
    for (const id of twins) {
      const twin = SET4.loadCase(`${id}_container_bound`);
      expect(twin.expect_canonical, id).toBe(loadCase(id).expect_canonical);
    }
  });
});
