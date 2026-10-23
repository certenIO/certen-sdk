/** finality_arb_final1 shard 0/4: every vector judged by the TypeScript kind equals the Go-written verdict byte for byte (the superseded worlds by their verdict now). */
import { describe, expect, it } from 'vitest';
import { FINAL1, expectedOf, runVector, shard } from './vectorset.js';

describe('finality_arb_final1 shard 0/4', () => {
  for (const v of shard(FINAL1, 0, 4)) {
    it(
      v.name,
      async () => {
        expect(await runVector(FINAL1, v), v.note).toBe(expectedOf(FINAL1, v));
      },
      300_000,
    );
  }
});
