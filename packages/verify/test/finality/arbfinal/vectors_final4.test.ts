/**
 * finality_arb_final4 (RB12-ARBFINAL-FIX, the Go-published set at validator origin/main; byte-identical copy in fixtures/finality/arb_final4): the
 * published twins of the two TS-held supplements arb_final_x and arb_final_sk plus the wallet fast-confirmer worlds. Every vector judged by the
 * TypeScript kind equals the Go-written verdict byte for byte; the three odd-K worlds are finality_block_header_unreadable (indexes 4, 5, 16), no
 * longer finality_block_not_covered.
 */
import { describe, expect, it } from 'vitest';
import { FINAL4, expectedOf, loadSet, manifestOf, readIn, runVector, sha256Hex } from './vectorset.js';

describe('finality_arb_final4 identity', () => {
  it('MANIFEST.json hashes to the Go-written MANIFEST.json.sha256 and the pinned value', () => {
    expect(sha256Hex(readIn(FINAL4.dir, 'MANIFEST.json'))).toBe(FINAL4.manifestSha256);
    expect(readIn(FINAL4.dir, 'MANIFEST.json.sha256').toString('utf8').trim()).toBe(FINAL4.manifestSha256);
  });

  it('every file the manifest lists is byte-identical to the Go copy: 12 evidence files, the pins file and vectors.json', () => {
    const files = manifestOf(FINAL4).files;
    expect(Object.keys(files).length).toBe(14);
    expect(files['vectors.json']).toBeDefined();
    expect(files['pins/synth.json']).toBeDefined();
    for (const [f, want] of Object.entries(files)) expect(sha256Hex(readIn(FINAL4.dir, f)), f).toBe(want);
    // the README stays outside the manifest, as in the Go set
    expect(files['README.md']).toBeUndefined();
  });

  it('holds 12 uniquely named vectors of the format finality_arb_final4/1, each with its evidence file in the manifest', () => {
    const set = loadSet(FINAL4);
    expect(set.vectors.length).toBe(FINAL4.vectors);
    expect(new Set(set.vectors.map((v) => v.name)).size).toBe(12);
    const files = manifestOf(FINAL4).files;
    for (const v of set.vectors) expect(files[`evidence/${v.name}.bin`], v.name).toBeDefined();
  });
});

describe('finality_arb_final4 vectors: the verdict equals the Go-recorded one', () => {
  for (const v of loadSet(FINAL4).vectors) {
    it(
      v.name,
      async () => {
        expect(await runVector(FINAL4, v), v.note).toBe(expectedOf(FINAL4, v));
      },
      300_000,
    );
  }

  it('six worlds are finalized, five are finality_block_header_unreadable at K (indexes 4, 5, 16, then 4 at K = F and K = F-1) and one fast-confirmer world is refused', () => {
    const e = loadSet(FINAL4).vectors.map((v) => v.expect);
    expect(e.filter((x) => x.startsWith('{"code":"finalized"')).length).toBe(6);
    const unreadable = e.filter((x) => x.startsWith('{"code":"finality_block_header_unreadable"'));
    expect(unreadable.length).toBe(5);
    expect(unreadable.map((x) => /"index":"(\d+)"/.exec(x)![1]).sort()).toEqual(['16', '4', '4', '4', '5']);
    expect(e.filter((x) => x.includes('"code":"finality_block_not_covered"')).length).toBe(0);
    expect(e.filter((x) => x.includes('"reason":"fast_confirmer_set"')).length).toBe(1);
  });
});
