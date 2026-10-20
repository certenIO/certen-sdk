/**
 * Cost of the heavy verifications on @noble/curves, each with a FRESH key cache (the cost of one real verification): the TIMING lines
 * are the numbers recorded in the work-package report. The bound is generous (this must hold on a loaded CI runner); the measured
 * numbers on the development box are far below it.
 */
import { describe, expect, it } from 'vitest';
import { KeyCache, verifyFinalizedHead } from '../../../src/proof-v2/finality/ethl1/index.js';
import { canon, loadCase, loadPins, lcOf } from './helpers.js';

describe('verification cost with a fresh key cache', () => {
  for (const id of ['valid_k1_k0', 'valid_k2_fulu_k0', 'synth_valid_512', 'valid_k1_chain', 'valid_k2_fulu_chain_to_gloas', 'valid_k1_fulu_chain_to_gloas']) {
    it(id, () => {
      const c = loadCase(id);
      const pins = loadPins(c.pins!);
      const lc = lcOf(c);
      const cache = new KeyCache();
      const t0 = performance.now();
      const h = verifyFinalizedHead(pins, lc, { keyCache: cache });
      const ms = Math.round(performance.now() - t0);
      console.log(`TIMING ${id}: ${lc.links.length} links, ${cache.decoded} distinct keys decoded, ${ms} ms`);
      expect(canon({ slot: h.slot.toString() })).toBe(canon({ slot: c.expect.finalized_head.slot }));
      expect(ms).toBeLessThan(120_000);
    }, 300_000);
  }
});
