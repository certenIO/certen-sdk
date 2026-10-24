/**
 * The speed target (owner rule 2026-10-23: the largest Adiri vector verifies in under 5 s in TypeScript with IDENTICAL verdicts) and
 * the identity of the verdicts in every mode of the batched check on the live vectors of finality_adiri3: sequential multi-scalar
 * multiplication ('off'), a pool of workers, and 'auto' (the shared pool), each against the verdict the Go verifier wrote.
 */
import os from 'node:os';
import { afterAll, describe, expect, it } from 'vitest';
import { FinalityStateError } from '../../../src/proof-v2/finality/state.js';
import { WorkerPool, disposeSharedPool, maxPoolSize, parsePins, verifyCommitteeChain, type CFA1, type Mode } from '../../../src/proof-v2/finality/adiri/index.js';
import { live } from './live.js';
import { embeddedAdiriPins, judge, vectors } from './vectorset.js';

const liveVectors = vectors().filter((v) => v.group === 'live');
const pool = new WorkerPool({ size: maxPoolSize() });
afterAll(() => {
  pool.dispose();
  disposeSharedPool();
});

describe('the live vectors judge identically in every mode of the batched check', () => {
  it('the three live vectors are the three the Go set published', () => {
    expect(liveVectors.map((v) => v.name)).toEqual(['live-513643-epoch651', 'live-500749-epoch600', 'live-500980-epoch602']);
  });

  for (const v of liveVectors) {
    it(`${v.name}: sequential, pool and auto equal the Go verdict`, { timeout: 600_000 }, () => {
      expect(judge(v, { parallel: 'off' }), 'sequential').toBe(v.expect);
      expect(judge(v, { parallel: pool }), 'pool').toBe(v.expect);
      expect(judge(v), 'auto').toBe(v.expect);
    });
  }

  it('a pool that did the work is not an idle pool: the workers answered and none was this thread', () => {
    expect(pool.jobsRun).toBeGreaterThan(0);
    expect(pool.threads.has(0)).toBe(false);
  });
});

describe('a failure on a long chain is localised to the same record in every mode', () => {
  const LEN = 70;
  const { cfa1 } = live('live-513643-epoch651');
  const par = parsePins(embeddedAdiriPins());
  const prefix = (corrupt: (c: CFA1) => void): CFA1 => {
    const c: CFA1 = { tables: cfa1.tables, records: cfa1.records.slice(0, LEN).map((r) => ({ ...r, signature: Uint8Array.from(r.signature) })) };
    corrupt(c);
    return c;
  };
  const verdict = (c: CFA1, mode: Mode, parallel: 'off' | 'auto' | WorkerPool): string => {
    try {
      const r = verifyCommitteeChain(par, c, mode, undefined, parallel);
      return `ok ${r.epoch}`;
    } catch (e) {
      if (e instanceof FinalityStateError) return e.canonical();
      throw e;
    }
  };

  it('the unmodified prefix verifies in all four ways', () => {
    const c = prefix(() => undefined);
    for (const [mode, parallel] of [['batched', 'off'], ['batched', pool], ['batched', 'auto'], ['oneByOne', 'off']] as const) expect(verdict(c, mode, parallel), `${mode} ${String(parallel)}`).toBe(`ok ${LEN - 1}`);
  });

  for (const k of [0, 1, 32, 63, 64, 69]) {
    it(`a flipped signature bit at record ${k} (a long chain, the pool engaged) is named at ${k} by sequential, pool, auto and one-by-one`, { timeout: 600_000 }, () => {
      const c = prefix((x) => {
        x.records[k]!.signature[30]! ^= 0x04;
      });
      const want = verdict(c, 'oneByOne', 'off');
      expect(want).toContain(`"epoch":"${k}"`);
      expect(want).toContain('signature_invalid');
      expect(verdict(c, 'batched', 'off')).toBe(want);
      expect(verdict(c, 'batched', pool)).toBe(want);
      expect(verdict(c, 'batched', 'auto')).toBe(want);
    });
  }

  it('two bad records: the lower one is named, whichever order the workers finish in', () => {
    const c = prefix((x) => {
      x.records[41]!.signature[10]! ^= 0x10;
      x.records[17]!.signature[40]! ^= 0x01;
    });
    const want = verdict(c, 'oneByOne', 'off');
    expect(want).toContain('"epoch":"17"');
    expect(verdict(c, 'batched', pool)).toBe(want);
    expect(verdict(c, 'batched', 'off')).toBe(want);
  });
});

describe('the speed target', () => {
  /**
   * A MEASURED target, not a bound that holds on any machine: live-513643-epoch651 (652 records) took 12.2 s in TypeScript before the
   * multi-scalar multiplication, the deferred cofactor clearing and the worker pool (Go: 0.27 s), and takes about 1.4 s with them on the
   * 12-core development PC while the other agents were using it (RB12-TS-SPEED check-in has the loads). The assertion is the owner's:
   * the median of three warm runs is under 5000 ms. On a machine with fewer than three cores the pool is a single worker or absent and
   * this number is not meaningful; the verdict is asserted either way.
   */
  it('verifies the 652-record vector in under 5 s (median of 3 warm runs), with the verdict the Go verifier wrote', { timeout: 900_000 }, () => {
    const v = liveVectors[0]!;
    expect(judge(v)).toBe(v.expect); // warm-up: starts the shared pool and compiles the hot paths
    const times: number[] = [];
    for (let i = 0; i < 3; i++) {
      const t0 = performance.now();
      const out = judge(v);
      times.push(performance.now() - t0);
      expect(out).toBe(v.expect);
    }
    times.sort((a, b) => a - b);
    // eslint-disable-next-line no-console
    console.log(`live-513643-epoch651: ${times.map((x) => x.toFixed(0)).join('/')} ms, median ${times[1]!.toFixed(0)} ms, loadavg ${os.loadavg().map((x) => x.toFixed(2)).join('/')} (0 on Windows), cores ${os.cpus().length}, pool ${maxPoolSize()}`);
    expect(times[1]!).toBeLessThan(5000);
  });
});
