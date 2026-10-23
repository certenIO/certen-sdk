/** Shard 0/3 of the finality_eth_sepolia2 cases (anchored at the embedded root pin 1378, up to 13 in-evidence links): the Go-written verdict byte for byte. */
import { describe, expect, it } from 'vitest';
import { loadVerifyCase, runVerifyCase, shard } from './vectorset.js';

describe('finality_eth_sepolia2 shard 0/3', () => {
  for (const id of shard('eth_sepolia2', 0, 3)) {
    it(
      id,
      () => {
        const c = loadVerifyCase('eth_sepolia2', id);
        expect(runVerifyCase('eth_sepolia2', c)).toBe(c.expect_canonical);
      },
      300_000,
    );
  }
});
