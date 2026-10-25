/**
 * The TS-held supplement arb_final_sk: worlds whose Rollup storage at S differs from the storage at K, judged by the Go verifier at cbb6373 (see
 * its README). Each verdict is the Go-recorded one; the hand-built twins of the scenarios are units_sk.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { FINALSK, expectedOf, loadSet, manifestOf, readIn, runVector, sha256Hex } from './vectorset.js';

describe('arb_final_sk identity', () => {
  it('MANIFEST.json hashes to MANIFEST.json.sha256 and the pinned value; every listed file is byte-identical; 16 vectors, 18 files', () => {
    expect(sha256Hex(readIn(FINALSK.dir, 'MANIFEST.json'))).toBe(FINALSK.manifestSha256);
    expect(readIn(FINALSK.dir, 'MANIFEST.json.sha256').toString('utf8').trim()).toBe(FINALSK.manifestSha256);
    for (const [f, want] of Object.entries(manifestOf(FINALSK).files)) expect(sha256Hex(readIn(FINALSK.dir, f)), f).toBe(want);
    expect(loadSet(FINALSK).vectors.length).toBe(16);
    expect(Object.keys(manifestOf(FINALSK).files).length).toBe(18);
  });
});

describe('arb_final_sk vectors: the verdict equals the Go-recorded one', () => {
  for (const v of loadSet(FINALSK).vectors) {
    it(v.name, async () => {
      expect(await runVector(FINALSK, v)).toBe(expectedOf(FINALSK, v));
    }, 300_000);
  }
  it('the recorded verdicts: 8 accepted (2 on the direct route), fast_confirmer_set 3, assertion_not_confirmed 3, assertion_unknown 1, config mismatch 1', () => {
    const e = loadSet(FINALSK).vectors.map((v) => v.expect);
    expect(e.filter((x) => x.includes('"code":"finalized"')).length).toBe(8);
    expect(e.filter((x) => x.includes('"reason":"fast_confirmer_set"')).length).toBe(3);
    expect(e.filter((x) => x.includes('"code":"assertion_not_confirmed"')).length).toBe(3);
    expect(e.filter((x) => x.includes('"code":"assertion_unknown"')).length).toBe(1);
    expect(e.filter((x) => x.includes('"code":"assertion_preimage_mismatch"')).length).toBe(1);
    expect(e.filter((x) => x.includes('"confirmation_route":"direct"')).length).toBe(2);
  });
});
