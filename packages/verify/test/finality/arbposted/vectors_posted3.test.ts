/** finality_arb_posted3 (the Go-published set at cbb6373): every case judged by the TypeScript kind equals the Go-written verdict byte for byte. */
import { describe, expect, it } from 'vitest';
import { SET3 } from './vectorsets.js';

describe('finality_arb_posted3', () => {
  for (const id of SET3.caseNames()) {
    it(
      id,
      () => {
        const c = SET3.loadCase(id);
        expect(SET3.runCase(c)).toBe(c.expect_canonical);
      },
      300_000,
    );
  }
});
