/**
 * The two signature strategies return the same canonical verdict on every cheap vector: one by one (a pairing per record, the reference)
 * and batched (one random linear combination, the production form). The long-chain vectors run batched only (vectors_shard0..3): one by
 * one is a pairing per record, minutes for 652 records.
 */
import { describe, expect, it } from 'vitest';
import { isFast, judge, vectors } from './vectorset.js';

describe('finality_adiri3: one-by-one and batched agree', () => {
  for (const v of vectors().filter(isFast)) {
    it(v.name, () => {
      const one = judge(v, { mode: 'oneByOne' });
      expect(one).toBe(v.expect);
      expect(judge(v, { mode: 'batched' })).toBe(one);
    });
  }
});
