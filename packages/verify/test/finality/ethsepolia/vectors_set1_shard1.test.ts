/** Shard 1/4 of the finality_eth_sepolia1 verification cases: every case judged by the TypeScript kind equals the Go-written verdict byte for byte. */
import { describe, expect, it } from 'vitest';
import { loadVerifyCase, runVerifyCase, shard } from './vectorset.js';

describe('finality_eth_sepolia1 verify shard 1/4', () => {
  for (const id of shard('eth_sepolia1', 1, 4)) {
    it(
      id,
      () => {
        const c = loadVerifyCase('eth_sepolia1', id);
        expect(runVerifyCase('eth_sepolia1', c)).toBe(c.expect_canonical);
      },
      300_000,
    );
  }
});
