/**
 * The worker pool of the batched Adiri check (RB12-TS-SPEED): the same verdicts as the sequential code whatever the number of workers,
 * proof that the workers did the work, the bound on the pool size, and every failure of a worker as a NAMED state that is never a pass.
 * The fixtures in fixtures_pool/ are workers that fail in each way (they speak the protocol of pool-worker.ts).
 */
import { afterAll, describe, expect, it } from 'vitest';
import { FinalityStateError } from '../../../src/proof-v2/finality/state.js';
import {
  KeyCache,
  PARALLEL_MIN_ITEMS,
  WorkerPool,
  WorkerPoolError,
  disposeSharedPool,
  engineFor,
  firstFailure,
  firstOneByOne,
  localEngine,
  maxPoolSize,
  parallelUnavailable,
  parsePins,
  poolEngine,
  sharedPool,
  verifyCommitteeChain,
  type SigItem,
} from '../../../src/proof-v2/finality/adiri/index.js';
import { SigNotExamined, SigOk, pack, unpack } from '../../../src/proof-v2/finality/adiri/msm.js';
import { aggregateSign, buildChain, concat, filled, pinsOfSection, pinsSection, pubKey } from './synth.js';

const fixture = (name: string): URL => new URL(`./fixtures_pool/${name}`, import.meta.url);
const cap = maxPoolSize();
const pools: WorkerPool[] = [];
const make = (opts: ConstructorParameters<typeof WorkerPool>[0] = {}): WorkerPool => {
  const p = new WorkerPool(opts);
  pools.push(p);
  return p;
};
afterAll(() => {
  for (const p of pools) p.dispose();
  disposeSharedPool();
});

const cache = new KeyCache();
const entries = (nums: number[]) => nums.map((n) => cache.get(pubKey(n))!);
const msgOf = (i: number): Uint8Array => concat(Uint8Array.of(1, 0, 1, 0x20), filled(32, i));
const signerSets = [[0, 1, 2], [0, 1, 2, 3], [1, 2, 3], [0, 2, 3]];
const item = (i: number): SigItem => {
  const set = signerSets[i % signerSets.length]!;
  return { epoch: i, sig: aggregateSign(set, msgOf(i)), signer: entries(set), msg: msgOf(i) };
};
const batch = (n: number): SigItem[] => Array.from({ length: n }, (_, i) => item(i));
const counter = (): ((n: number) => Uint8Array) => {
  let c = 1;
  return (n) => {
    const out = new Uint8Array(n);
    out[n - 1] = (c++ % 250) + 1;
    out[n - 2] = (c * 7) % 251;
    return out;
  };
};

describe('where workers can run, and how many', () => {
  it('the pool size is bounded by min(4, cores - 2) and at least 1', () => {
    expect(cap).toBeGreaterThanOrEqual(1);
    expect(cap).toBeLessThanOrEqual(4);
  });

  it('workers are available here, and the reason is named when they are not (no Node module access, no .ts stripping)', () => {
    expect(parallelUnavailable()).toBeUndefined();
    const proc = process as unknown as { getBuiltinModule?: unknown };
    const saved = proc.getBuiltinModule;
    try {
      proc.getBuiltinModule = undefined;
      expect(parallelUnavailable()).toContain('node:worker_threads is not available');
      expect(maxPoolSize()).toBe(1);
      expect(engineFor('auto', 100000)).toBe(localEngine);
    } finally {
      proc.getBuiltinModule = saved;
    }
    expect(parallelUnavailable()).toBeUndefined();
    expect(parallelUnavailable(new URL('file:///x/pool-worker.ts'), false)).toContain('cannot strip types');
    expect(parallelUnavailable(new URL('file:///x/pool-worker.ts'), 'strip')).toBeUndefined();
    expect(parallelUnavailable(new URL('file:///x/pool-worker.js'), false)).toBeUndefined();
  });

  it('a pool size of 0, above the bound, or not an integer is refused; the worker file must exist', () => {
    expect(() => new WorkerPool({ size: 0 })).toThrow(RangeError);
    expect(() => new WorkerPool({ size: cap + 1 })).toThrow(RangeError);
    expect(() => new WorkerPool({ size: 1.5 })).toThrow(RangeError);
    expect(() => new WorkerPool({ size: -1 })).toThrow(RangeError);
    expect(() => new WorkerPool({ workerUrl: fixture('absent.mjs') })).toThrow(/worker file .* does not exist/);
    try {
      new WorkerPool({ workerUrl: fixture('absent.mjs') });
    } catch (e) {
      expect(e).toBeInstanceOf(WorkerPoolError);
      expect((e as WorkerPoolError).reason).toBe('unavailable');
    }
    expect(make({ size: cap }).size).toBe(cap);
    expect(make({ size: 1 }).size).toBe(1);
  });

  it("'auto' uses workers from exactly PARALLEL_MIN_ITEMS records (N passes, N-1 stays here); 'off' never does", () => {
    expect(PARALLEL_MIN_ITEMS).toBe(64);
    expect(engineFor('auto', PARALLEL_MIN_ITEMS - 1)).toBe(localEngine);
    expect(engineFor('off', 100000)).toBe(localEngine);
    if (cap >= 2) expect(engineFor('auto', PARALLEL_MIN_ITEMS)).not.toBe(localEngine);
    else expect(engineFor('auto', PARALLEL_MIN_ITEMS)).toBe(localEngine);
    expect(engineFor(make({ size: 1 }), 1)).not.toBe(localEngine);
  });
});

describe('the bytes sent to a worker', () => {
  it('pack gives every string back, empty ones too, in a fresh buffer of exactly their total size', () => {
    const big = new Uint8Array(1 << 20).fill(7);
    const views = [big.subarray(10, 58), big.subarray(100, 100), big.subarray(5000, 5036), new Uint8Array(0)];
    const p = pack(views);
    expect(p.data.length).toBe(48 + 36);
    expect(p.data.buffer.byteLength).toBe(84);
    expect(Array.from(p.ends)).toEqual([48, 48, 84, 84]);
    const back = unpack(p);
    expect(back.map((b) => b.length)).toEqual([48, 0, 36, 0]);
    expect(back[0]).toEqual(views[0]);
    expect(back[2]).toEqual(views[2]);
    expect(pack([]).data.length).toBe(0);
    expect(unpack(pack([])).length).toBe(0);
  });
});

describe('the pool engine equals the local engine', () => {
  const sigsOf = (items: SigItem[]): Uint8Array[] => items.map((it) => it.sig);
  it('decode: the same codes and points whatever the split, with the first refusal at any position', () => {
    const items = batch(9);
    const id = Uint8Array.of(0xc0, ...new Uint8Array(47));
    for (const size of new Set([1, Math.min(2, cap), cap])) {
      const eng = poolEngine(make({ size }));
      for (let refuse = -1; refuse < 9; refuse++) {
        const sigs = sigsOf(items);
        if (refuse >= 0) sigs[refuse] = id;
        const a = localEngine.decode(sigs);
        const b = eng.decode(sigs);
        expect(Array.from(b.codes), `size ${size} refuse ${refuse}`).toEqual(Array.from(a.codes));
        a.points.forEach((p, i) => {
          if (p === undefined) expect(b.points[i], `point ${i}`).toBeUndefined();
          else expect(b.points[i]!.equals(p), `point ${i}`).toBe(true);
        });
      }
    }
    expect(Array.from(poolEngine(make({ size: 1 })).decode([]).codes)).toEqual([]);
  });

  it('decode: a refusal in a later part does not hide an earlier one, and everything after the first refusal is not examined', () => {
    const items = batch(8);
    const sigs = sigsOf(items);
    sigs[2] = filled(48, 0xff);
    sigs[6] = Uint8Array.of(0xc0, ...new Uint8Array(47));
    const r = poolEngine(make({ size: cap })).decode(sigs);
    expect(r.codes[2]).not.toBe(SigOk);
    expect(Array.from(r.codes.subarray(3))).toEqual(new Array(5).fill(SigNotExamined));
    expect(r.points[0]).toBeDefined();
    expect(r.points[1]).toBeDefined();
    expect(r.points[2]).toBeUndefined();
    expect(r.points[3]).toBeUndefined();
  });

  it('combine: the sums do not depend on the number of workers', () => {
    const items = batch(11);
    const dec = localEngine.decode(sigsOf(items));
    const scalars = items.map((_, i) => (BigInt(i + 3) << 100n) | 0x1234567n);
    const groups = items.map((_, i) => i % 3);
    const job = { points: dec.points as NonNullable<(typeof dec.points)[number]>[], msgs: items.map((it) => it.msg), scalars, groups, dst: 'BLS_SIG_BLS12381G1_XMD:SHA-256_SSWU_RO_NUL_' };
    const want = localEngine.combine(job);
    for (const size of new Set([1, Math.min(2, cap), cap])) {
      const got = poolEngine(make({ size })).combine(job);
      expect(got.sumSig.equals(want.sumSig), `size ${size}`).toBe(true);
      expect([...got.sumHash.keys()], `size ${size}`).toEqual([...want.sumHash.keys()]);
      for (const [g, s] of want.sumHash) expect(got.sumHash.get(g)!.equals(s), `size ${size} group ${g}`).toBe(true);
      expect(got.hashPts).toHaveLength(11);
      got.hashPts.forEach((h, i) => expect(h.equals(want.hashPts[i]!), `size ${size} hash ${i}`).toBe(true));
    }
  });
});

describe('the batched check through the pool returns the sequential verdict', () => {
  const same = (items: SigItem[], pool: WorkerPool, label: string) => {
    const want = firstOneByOne(items);
    const viaPool = firstFailure(items, 'batched', counter(), pool);
    const here = firstFailure(items, 'batched', counter(), 'off');
    expect(here, `${label}: sequential`).toEqual(want);
    expect(viaPool, `${label}: pool`).toEqual(want);
    return viaPool;
  };

  it('valid batches, a bad record at every position (split across workers), decode refusals and an empty signer list', () => {
    const pool = make({ size: cap });
    const jobs0 = pool.jobsRun;
    expect(same(batch(9), pool, 'valid')).toBeUndefined();
    for (let k = 0; k < 9; k++) {
      const items = batch(9);
      items[k] = { ...items[k]!, msg: msgOf(500 + k) };
      expect(same(items, pool, `bad at ${k}`)).toEqual({ index: k, reason: 'pairing' });
    }
    const id = Uint8Array.of(0xc0, ...new Uint8Array(47));
    const refused = batch(9);
    refused[4] = { ...refused[4]!, sig: id };
    expect(same(refused, pool, 'identity at 4')).toEqual({ index: 4, reason: 'identity' });
    const earlier = batch(9);
    earlier[2] = { ...earlier[2]!, msg: msgOf(600) };
    earlier[7] = { ...earlier[7]!, sig: id };
    expect(same(earlier, pool, 'pairing before identity')).toEqual({ index: 2, reason: 'pairing' });
    const empty = batch(9);
    empty[5] = { ...empty[5]!, signer: [] };
    expect(same(empty, pool, 'empty signer list')).toEqual({ index: 5, reason: 'pairing' });
    const every = batch(9).map((it, i) => ({ ...it, msg: msgOf(700 + i) }));
    expect(same(every, pool, 'all failing')).toEqual({ index: 0, reason: 'pairing' });
    expect(pool.jobsRun).toBeGreaterThan(jobs0);
  });

  it('the work is done by worker threads other than this one, and by more than one when the pool has more than one', () => {
    const pool = make({ size: Math.min(2, cap) });
    expect(pool.jobsRun).toBe(0);
    expect(firstFailure(batch(8), 'batched', counter(), pool)).toBeUndefined();
    expect(pool.jobsRun).toBeGreaterThanOrEqual(2);
    expect(pool.threads.has(0)).toBe(false);
    expect(pool.threads.size).toBe(Math.min(2, cap));
  });
});

describe('the verifier uses the shared pool for a long chain and says so', () => {
  const longChain = (n: number, wrongAt?: number) => {
    const keys = [0, 1, 2, 3, 4];
    const specs = Array.from({ length: n }, (_, i) => ({ committee: keys, next: keys, fsNumber: BigInt(100 + i), signers: i % 3 === 2 ? [0, 1, 2, 3] : undefined, signWrong: i === wrongAt }));
    const chain = buildChain(specs);
    const section = pinsSection({ genesisCommittee: keys, epoch0Number: 100n, epoch0Hash: chain.cfa1.records[0]!.finalState.hash, minCommittee: 4 });
    return { chain, par: parsePins(pinsOfSection(section)) };
  };

  it("a chain of PARALLEL_MIN_ITEMS records runs on the shared pool and returns what 'off' returns; one record fewer stays in this thread", () => {
    disposeSharedPool();
    const { chain, par } = longChain(PARALLEL_MIN_ITEMS);
    const off = verifyCommitteeChain(par, chain.cfa1, 'batched', undefined, 'off');
    const auto = verifyCommitteeChain(par, chain.cfa1, 'batched');
    expect(auto).toEqual(off);
    if (cap >= 2) {
      expect(sharedPool().jobsRun).toBeGreaterThanOrEqual(2);
      expect(sharedPool().threads.size).toBeGreaterThanOrEqual(1);
      expect(sharedPool().threads.has(0)).toBe(false);
    }
    disposeSharedPool();
    const short = longChain(PARALLEL_MIN_ITEMS - 1);
    verifyCommitteeChain(short.par, short.chain.cfa1, 'batched');
    expect(sharedPool().jobsRun).toBe(0);
  });

  it('a wrong signature at the last record of a long chain is localised to that record in every mode', () => {
    const n = PARALLEL_MIN_ITEMS + 6;
    const { chain, par } = longChain(n, n - 1);
    const verdict = (mode: 'batched' | 'oneByOne', parallel: 'auto' | 'off') => {
      try {
        verifyCommitteeChain(par, chain.cfa1, mode, undefined, parallel);
      } catch (e) {
        expect(e).toBeInstanceOf(FinalityStateError);
        return (e as FinalityStateError).canonical();
      }
      throw new Error('expected a refusal');
    };
    const want = `{"code":"committee_chain_broken","fields":{"check":"signature_invalid","epoch":"${n - 1}","reason":"pairing"}}`;
    expect(verdict('batched', 'auto')).toBe(want);
    expect(verdict('batched', 'off')).toBe(want);
    expect(verdict('oneByOne', 'off')).toBe(want);
  });
});

describe('a failing worker is a named failure, never a pass', () => {
  const refusal = (f: () => unknown): WorkerPoolError => {
    try {
      f();
    } catch (e) {
      expect(e).toBeInstanceOf(WorkerPoolError);
      return e as WorkerPoolError;
    }
    throw new Error('expected a failure of the pool');
  };

  it('a worker that reports an error: worker_error, the pool is torn down, and a later use of it is refused', () => {
    const pool = make({ size: 1, workerUrl: fixture('worker_throws.mjs') });
    const e = refusal(() => firstFailure(batch(4), 'batched', counter(), pool));
    expect(e.reason).toBe('worker_error');
    expect(e.message).toContain('adiri signature workers worker_error: Error: injected failure');
    expect(pool.alive).toBe(false);
    expect(refusal(() => firstFailure(batch(4), 'batched', counter(), pool)).message).toContain('no longer usable');
  });

  it('a hung worker is stalled after stallMs, a thread that ends is stalled too, and neither is ever answered', () => {
    const t0 = Date.now();
    const hung = make({ size: 1, workerUrl: fixture('worker_hangs.mjs'), stallMs: 500 });
    const e = refusal(() => hung.runWire('decode', [{}]));
    expect(e.reason).toBe('stalled');
    expect(Date.now() - t0).toBeGreaterThanOrEqual(450);
    expect(Date.now() - t0).toBeLessThan(20_000);
    const gone = make({ size: 1, workerUrl: fixture('worker_exits.mjs'), stallMs: 500 });
    expect(refusal(() => gone.runWire('decode', [{}])).reason).toBe('stalled');
  });

  it('a worker that finishes without a reply is a lost reply', () => {
    const silent = make({ size: 1, workerUrl: fixture('worker_silent.mjs') });
    const e = refusal(() => silent.runWire('decode', [{}]));
    expect(e.reason).toBe('lost_reply');
    expect(silent.alive).toBe(false);
  });

  it('a slow worker that keeps reporting progress is waited for; a run past maxMs is a timeout even so', () => {
    const slow = make({ size: 1, workerUrl: fixture('worker_slow.mjs'), stallMs: 600 });
    expect(slow.runWire('decode', [{ x: 1 }])).toEqual([{ x: 1 }]);
    expect(slow.alive).toBe(true);
    const capped = make({ size: 1, workerUrl: fixture('worker_slow.mjs'), stallMs: 60_000, maxMs: 700 });
    expect(refusal(() => capped.runWire('decode', [{}])).reason).toBe('timeout');
  });

  it('through the chain a failed pool is finality_verifier_failed with its cause, for a chain that is valid AND for one that is not', () => {
    const keys = [0, 1, 2, 3, 4];
    const mk = (wrong: boolean) => {
      const chain = buildChain(Array.from({ length: 6 }, (_, i) => ({ committee: keys, next: keys, fsNumber: BigInt(100 + i), signWrong: wrong && i === 3 })));
      const par = parsePins(pinsOfSection(pinsSection({ genesisCommittee: keys, epoch0Number: 100n, epoch0Hash: chain.cfa1.records[0]!.finalState.hash, minCommittee: 4 })));
      return { chain, par };
    };
    for (const wrong of [false, true]) {
      const pool = make({ size: 1, workerUrl: fixture('worker_throws.mjs') });
      const { chain, par } = mk(wrong);
      let text: string | undefined;
      try {
        verifyCommitteeChain(par, chain.cfa1, 'batched', undefined, pool);
      } catch (e) {
        expect(e).toBeInstanceOf(FinalityStateError);
        text = (e as FinalityStateError).canonical();
      }
      expect(text, `wrong=${wrong}`).toBeDefined();
      expect(text).toContain('"code":"finality_verifier_failed"');
      expect(text).toContain('adiri signature workers worker_error');
    }
  });

  it('one-by-one mode never touches the pool, even when one is given', () => {
    const pool = make({ size: 1, workerUrl: fixture('worker_throws.mjs') });
    expect(firstFailure(batch(3), 'oneByOne', counter(), pool)).toBeUndefined();
    expect(pool.alive).toBe(true);
    expect(pool.jobsRun).toBe(0);
  });
});
