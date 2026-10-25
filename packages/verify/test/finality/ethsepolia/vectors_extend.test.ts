/** The 9 Pins.Extend cases of finality_eth_sepolia1: the same extension and links judged by extendPins, the Go-written verdict byte for byte. */
import { describe, expect, it } from 'vitest';
import { extendIds, loadExtendCase, runExtendCase } from './vectorset.js';

describe('finality_eth_sepolia1 extend cases', () => {
  const ids = extendIds('eth_sepolia1');
  it('there are 9 extend cases', () => {
    expect(ids.length).toBe(9);
  });
  for (const id of ids) {
    it(
      id,
      () => {
        const c = loadExtendCase(id);
        expect(runExtendCase(c)).toBe(c.expect_canonical);
      },
      300_000,
    );
  }
});
