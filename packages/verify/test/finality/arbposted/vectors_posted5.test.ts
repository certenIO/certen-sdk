/**
 * finality_arb_posted5 (RB12-ARBFINAL-FIX audit G2, the Go-published set at validator origin/main): the container binding of the kind, judged before
 * the pins and the evidence body. Every case judged by the TypeScript kind equals the Go-written verdict byte for byte.
 */
import { describe, expect, it } from 'vitest';
import { SET5, sha256Hex } from './vectorsets.js';

describe('finality_arb_posted5 identity', () => {
  it('MANIFEST.json hashes to the Go-written MANIFEST.json.sha256 and the pinned value', () => {
    expect(sha256Hex(SET5.read('MANIFEST.json'))).toBe(SET5.id.manifestSha256);
    expect(SET5.read('MANIFEST.json.sha256').toString('utf8').trim()).toBe(SET5.id.manifestSha256);
    expect(SET5.manifest().set).toBe(SET5.id.set);
  });

  it('every file the manifest lists is byte-identical to the Go copy; 3 cases, 5 files', () => {
    const m = SET5.manifest();
    expect(Object.keys(m.files).length).toBe(SET5.id.files);
    for (const [f, want] of Object.entries(m.files)) expect(sha256Hex(SET5.read(f)), f).toBe(want);
    expect(SET5.caseNames().length).toBe(SET5.id.cases);
    for (const n of SET5.caseNames()) expect(m.files[`cases/${n}.json`], n).toBeDefined();
  });

  it('exactly the control is accepted', () => {
    const accepted = SET5.caseNames().filter((n) => SET5.loadCase(n).expect_canonical.startsWith('{"code":"verified"'));
    expect(accepted).toEqual([...SET5.id.accepting]);
  });
});

describe('finality_arb_posted5', () => {
  for (const id of SET5.caseNames()) {
    it(
      id,
      () => {
        const c = SET5.loadCase(id);
        expect(SET5.runCase(c)).toBe(c.expect_canonical);
      },
      300_000,
    );
  }
});
