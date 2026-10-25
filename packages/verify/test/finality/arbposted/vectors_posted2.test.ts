/** finality_arb_posted2 (the Go-published set at cbb6373): every case judged by the TypeScript kind equals the Go-written verdict byte for byte. */
import { describe, expect, it } from 'vitest';
import { SET2 } from './vectorsets.js';

describe('finality_arb_posted2', () => {
  for (const id of SET2.caseNames()) {
    it(
      id,
      () => {
        const c = SET2.loadCase(id);
        expect(SET2.runCase(c)).toBe(c.expect_canonical);
      },
      300_000,
    );
  }
});
