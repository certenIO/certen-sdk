/** Shard 1/4 of the finality_base_final1 LIVE parity oracle: every full-container case judged by the TypeScript kind equals the Go-written verdict byte for byte. */
import { describe, expect, it } from 'vitest';
import { caseNames, expectedOf, loadCase, runCase, shard } from './vectorset.js';

describe('finality_base_final1 live cases, shard 1/4', () => {
  for (const id of shard(caseNames(), 1, 4)) {
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
