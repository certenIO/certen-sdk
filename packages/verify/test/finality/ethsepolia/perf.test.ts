/**
 * Timing of the real valid vectors (no performance claim beyond what is measured here): the largest real vector of each set is judged
 * with a cold and with a warm process-wide key cache. The cache is the only speed work of this package (BLS pairing is the remaining cost;
 * worker threads and WASM belong to the Adiri speed package). The verdict never depends on the cache, and a warm call is never slower than
 * a cold one by more than the noise of a loaded machine.
 */
import { describe, expect, it } from 'vitest';
import { resetDefaultKeyCache } from '../../../src/proof-v2/finality/ethl1/index.js';
import { loadVerifyCase, runVerifyCase } from './vectorset.js';

const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;

function time(set: 'eth_sepolia1' | 'eth_sepolia2', id: string, runs: number, cold: boolean): { ms: number[]; verdicts: Set<string> } {
  const c = loadVerifyCase(set, id);
  const ms: number[] = [];
  const verdicts = new Set<string>();
  for (let i = 0; i < runs; i++) {
    if (cold) resetDefaultKeyCache();
    const t0 = performance.now();
    verdicts.add(runVerifyCase(set, c));
    ms.push(performance.now() - t0);
  }
  verdicts.add(c.expect_canonical);
  return { ms, verdicts };
}

describe('timing of the largest real vectors', () => {
  it(
    'finality_eth_sepolia2/valid_gloas_latest_kind2 (3.5 MB, 13 links, 14 committees): cold and warm medians, one verdict',
    () => {
      const cold = time('eth_sepolia2', 'valid_gloas_latest_kind2', 3, true);
      const warm = time('eth_sepolia2', 'valid_gloas_latest_kind2', 5, false);
      const coldMs = median(cold.ms);
      const warmMs = median(warm.ms);
      console.log(`RB12-TS-SEPOLIA timing: valid_gloas_latest_kind2 cold median ${coldMs.toFixed(0)} ms (runs ${cold.ms.map((x) => x.toFixed(0)).join(',')}), warm median ${warmMs.toFixed(0)} ms (runs ${warm.ms.map((x) => x.toFixed(0)).join(',')})`);
      expect(cold.verdicts.size).toBe(1);
      expect(warm.verdicts.size).toBe(1);
      expect([...cold.verdicts][0]).toContain('"code":"verified"');
      expect(warmMs).toBeLessThanOrEqual(coldMs * 1.25);
    },
    600_000,
  );

  it(
    'finality_eth_sepolia1/valid_gloas_latest (3.2 MB) and valid_legacy (2.7 MB, 4,057 headers): warm medians, verdicts equal the Go-written ones',
    () => {
      for (const id of ['valid_gloas_latest', 'valid_legacy']) {
        const r = time('eth_sepolia1', id, 5, false);
        console.log(`RB12-TS-SEPOLIA timing: ${id} warm median ${median(r.ms).toFixed(0)} ms (runs ${r.ms.map((x) => x.toFixed(0)).join(',')})`);
        expect(r.verdicts.size, id).toBe(1);
      }
    },
    600_000,
  );
});
