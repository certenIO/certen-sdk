/** finality_arb_final2: every vector judged by the TypeScript kind equals the Go-written verdict byte for byte (the superseded worlds by their verdict now). */
import { describe, expect, it } from 'vitest';
import { FINAL2, expectedOf, runVector, shard } from './vectorset.js';

describe('finality_arb_final2', () => {
  for (const v of shard(FINAL2, 0, 1)) {
    it(
      v.name,
      async () => {
        expect(await runVector(FINAL2, v), v.note).toBe(expectedOf(FINAL2, v));
      },
      300_000,
    );
  }
});
