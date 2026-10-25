/** finality_arb_final3 shard 0/2: every vector judged by the TypeScript kind equals the Go-written verdict byte for byte (the superseded worlds by their verdict now). */
import { describe, expect, it } from 'vitest';
import { FINAL3, expectedOf, runVector, shard } from './vectorset.js';

describe('finality_arb_final3 shard 0/2', () => {
  for (const v of shard(FINAL3, 0, 2)) {
    it(
      v.name,
      async () => {
        expect(await runVector(FINAL3, v), v.note).toBe(expectedOf(FINAL3, v));
      },
      300_000,
    );
  }
});
