/**
 * The TS-held supplement arb_final_x: worlds with L1 headers the light-client spine reader accepts and the framework's positional header reader
 * refuses, judged by the Go verifier (see its README; re-judged at origin/main e9aefbf5). The framework reader is applied to K's header only: an odd
 * header anywhere else (the head, S, the others) is judged; an odd header at K is finality_block_header_unreadable{block_number, finalized_exec_number,
 * reason, index} (it was finality_block_not_covered before RB12-ARBFINAL-FIX). arb_final4 publishes the same worlds.
 */
import { describe, expect, it } from 'vitest';
import { FINALX, expectedOf, loadSet, manifestOf, readIn, runVector, sha256Hex } from './vectorset.js';

describe('arb_final_x identity', () => {
  it('MANIFEST.json hashes to MANIFEST.json.sha256 and the pinned value; every listed file is byte-identical; 8 vectors', () => {
    expect(sha256Hex(readIn(FINALX.dir, 'MANIFEST.json'))).toBe(FINALX.manifestSha256);
    expect(readIn(FINALX.dir, 'MANIFEST.json.sha256').toString('utf8').trim()).toBe(FINALX.manifestSha256);
    for (const [f, want] of Object.entries(manifestOf(FINALX).files)) expect(sha256Hex(readIn(FINALX.dir, f)), f).toBe(want);
    expect(loadSet(FINALX).vectors.length).toBe(8);
    expect(Object.keys(manifestOf(FINALX).files).length).toBe(10);
  });
});

describe('arb_final_x vectors: the verdict equals the Go-recorded one', () => {
  for (const v of loadSet(FINALX).vectors) {
    it(v.name, async () => {
      expect(await runVector(FINALX, v)).toBe(expectedOf(FINALX, v));
    }, 300_000);
  }
  it('five worlds are accepted (route direct) and three are finality_block_header_unreadable at K (indexes 4, 5, 16)', () => {
    const e = loadSet(FINALX).vectors.map((v) => v.expect);
    expect(e.filter((x) => x.includes('"confirmation_route":"direct"')).length).toBe(5);
    expect(e.filter((x) => x.includes('"code":"finality_block_header_unreadable"') && x.includes('"block_number":"11999995"')).length).toBe(3);
    expect(e.filter((x) => x.includes('"code":"finality_block_not_covered"')).length).toBe(0);
  });
});
