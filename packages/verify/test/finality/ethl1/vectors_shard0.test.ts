/**
 * Shard 0 of 8 of the validator's finality_ethl1_v2 vector set (143 cases, 128 head and 15 covers): every case is judged by the
 * TypeScript verifier and its canonical verdict compared with the Go-written expected string BYTE FOR BYTE. A difference on any case is
 * stop-the-line. The shards are separate files so that vitest runs them in parallel workers.
 */
import { describe, expect, it } from 'vitest';
import { expectedOf, judge, loadCase, shardOf } from './helpers.js';

describe('finality_ethl1_v2, shard 0 of 8', () => {
  for (const id of shardOf(0, 8)) {
    it(id, () => {
      const c = loadCase(id);
      const t0 = performance.now();
      const got = judge(c);
      const ms = Math.round(performance.now() - t0);
      if (ms > 5000) console.log(`TIMING ${id} ${ms} ms`);
      expect(got).toBe(expectedOf(c));
    }, 300_000);
  }
});
