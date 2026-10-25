/** Shard 1 of 4 of the finality_base_posted1 parity oracle: every case judged by the TypeScript kind equals the Go-written verdict byte for byte. */
import { describe, expect, it } from 'vitest';
import { expectedOf, loadCase, runCase, shard } from './vectorset.js';

describe('finality_base_posted1 shard 1/4', () => {
  for (const id of shard(1, 4)) {
    it(
      id,
      () => {
        const c = loadCase(id);
        expect(runCase(c)).toBe(expectedOf(c));
      },
      300_000,
    );
  }
});
