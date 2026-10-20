/**
 * The finality_adiri3 vectors that are decided before any signature is verified (structural and pin refusals of the 652-record base chain,
 * the small synthetic chains): a quick subset the mutation gate runs next to the unit tests. The full set runs in vectors_shard0..3.
 */
import { describe, expect, it } from 'vitest';
import { isFast, judge, vectors } from './vectorset.js';

describe('finality_adiri3: the vectors decided before any signature work', () => {
  const fast = vectors().filter(isFast);
  it('is a substantial subset', () => {
    expect(fast.length).toBeGreaterThanOrEqual(35);
  });
  for (const v of fast) {
    it(v.name, () => {
      expect(judge(v)).toBe(v.expect);
    });
  }
});
