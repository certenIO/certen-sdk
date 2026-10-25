/** Shard 0/2 of the finality_base_final1 JUDGE-level parity oracle: the world of each case is judged by the TypeScript judge and equals the Go-written verdict byte for byte. */
import { describe, expect, it } from 'vitest';
import { expectedOf, judgeNames, loadJudge, runJudge, shard } from './vectorset.js';

describe('finality_base_final1 judge cases, shard 0/2', () => {
  for (const id of shard(judgeNames(), 0, 2)) {
    it(id, () => {
      const c = loadJudge(id);
      expect(runJudge(c)).toBe(expectedOf(c));
    });
  }
});
