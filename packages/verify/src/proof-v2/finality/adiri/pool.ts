/**
 * A bounded pool of worker threads for the batched Adiri signature check (RB12-TS-SPEED), with the SAME synchronous interface as the
 * sequential code: the calling thread blocks (Atomics.wait) while the workers run their jobs, so no Kind, registry or caller has to become
 * asynchronous. The jobs are the pure functions of msm.ts; the result of a run does not depend on how the records are split over workers
 * (the sums are group elements and addition is commutative and associative; units_pool.test.ts asserts it).
 *
 * Failure is NAMED, never a pass and never a silent sequential retry: a worker that reports an error, one that makes no progress for
 * `stallMs` (a crashed or hung thread: nothing is heard from it, because a blocked thread cannot see worker events), a run longer than
 * `maxMs`, or a lost reply is a WorkerPoolError, the pool is torn down, and the caller's verification fails with it (the chain wraps it as
 * finality_verifier_failed with the cause). Where the ENVIRONMENT cannot run workers (a browser, a Node without
 * process.getBuiltinModule, no shared memory, a `.ts` worker file on a Node that cannot strip types, no worker file beside a bundled copy of this module) `parallelUnavailable()` says why and
 * 'auto' runs the same jobs in the calling thread: slower, never different.
 *
 * There is no static import of a Node module here, so the package still bundles for browsers.
 */
import {
  SigNotExamined,
  SigOk,
  combineBatch,
  decodeBatch,
  fromRaw,
  pack,
  toRaw,
  type CombineJob,
  type CombineResult,
  type CombineResultWire,
  type CombineWire,
  type DecodeResult,
  type DecodeResultWire,
  type DecodeWire,
  type G1Point,
  type JobKind,
} from './msm.js';

export type PoolFailure = 'unavailable' | 'worker_error' | 'stalled' | 'timeout' | 'lost_reply' | 'terminated';

/** A named failure of the worker pool. `message` is `adiri signature workers <reason>: <detail>`. */
export class WorkerPoolError extends Error {
  readonly reason: PoolFailure;
  constructor(reason: PoolFailure, detail: string) {
    super(`adiri signature workers ${reason}: ${detail}`);
    this.name = 'WorkerPoolError';
    this.reason = reason;
  }
}

interface PortLike {
  postMessage(v: unknown): void;
  close(): void;
}
interface WorkerLike {
  postMessage(v: unknown, transfer?: unknown[]): void;
  terminate(): unknown;
  unref(): void;
  on(event: string, fn: (...a: any[]) => void): void;
}
interface WorkerThreads {
  Worker: new (url: URL | string, opts?: object) => WorkerLike;
  MessageChannel: new () => { port1: PortLike; port2: PortLike };
  receiveMessageOnPort(p: PortLike): { message: any } | undefined;
}

const builtin = (id: string): any => {
  const proc = (globalThis as { process?: { getBuiltinModule?: (id: string) => unknown } }).process;
  return proc !== undefined && typeof proc.getBuiltinModule === 'function' ? proc.getBuiltinModule(id) : undefined;
};

/** The extension of this module's own file: the worker file beside it has the same one (`.js` from a build, `.ts` from the sources). */
const EXT = import.meta.url.endsWith('.ts') ? '.ts' : '.js';
/** The worker file. The name is assembled so that a bundler does not try to follow it. */
export const defaultWorkerUrl = (): URL => new URL(['./pool-worker', EXT].join(''), import.meta.url);

/** The most workers a pool may have: min(4, cores - 2), at least 1. The PC is shared; the pool must not take it over. */
export function maxPoolSize(): number {
  const os = builtin('node:os') as { availableParallelism?: () => number; cpus?: () => unknown[] } | undefined;
  const cores = os?.availableParallelism?.() ?? os?.cpus?.().length ?? 1;
  return Math.max(1, Math.min(4, cores - 2));
}

/** The Node type-stripping feature of this process (false before 22.18 unless enabled by a flag, 'strip' or 'transform' once available). */
const nodeStripsTypes = (): unknown => (globalThis as { process?: { features?: { typescript?: unknown } } }).process?.features?.typescript;

/** Why workers cannot run here (undefined when they can). `stripsTypes` is what this Node can do for a `.ts` worker file. */
export function parallelUnavailable(workerUrl: URL | string = defaultWorkerUrl(), stripsTypes: unknown = nodeStripsTypes()): string | undefined {
  const wt = builtin('node:worker_threads') as Partial<WorkerThreads> | undefined;
  if (wt === undefined || typeof wt.Worker !== 'function') return 'node:worker_threads is not available (not Node >= 22.3)';
  if (typeof SharedArrayBuffer === 'undefined' || typeof Atomics === 'undefined' || typeof Atomics.wait !== 'function') return 'shared memory and Atomics.wait are not available';
  if (String(workerUrl).endsWith('.ts') && !stripsTypes) return 'the worker is a .ts file and this Node cannot strip types';
  // a consumer that bundles this package into one file has no worker file beside it: the pool is then not runnable HERE
  return workerFileMissing(workerUrl);
}

/** A worker file that is not there fails at start-up inside the worker, where it would only be seen as a stall: name it at construction. */
function workerFileMissing(url: URL | string): string | undefined {
  const u = typeof url === 'string' ? url : url.href;
  const fs = builtin('node:fs') as { existsSync(p: string): boolean } | undefined;
  const nodeUrl = builtin('node:url') as { fileURLToPath(u: string): string } | undefined;
  if (fs === undefined || nodeUrl === undefined || !u.startsWith('file:')) return undefined;
  let path: string;
  try {
    path = nodeUrl.fileURLToPath(u);
  } catch (e) {
    // a file URL that names no path on this platform (for example no drive letter on Windows): the file is not there
    return `the worker file ${u} is not a path on this platform (${e instanceof Error ? e.message : String(e)})`;
  }
  return fs.existsSync(path) ? undefined : `the worker file ${path} does not exist`;
}

export interface PoolOptions {
  /** the number of workers: 1..maxPoolSize() (default maxPoolSize()) */
  size?: number;
  /** the worker file (default: the one beside this module) */
  workerUrl?: URL | string;
  /** how long a worker may make no progress before the run fails as stalled (default 30 s) */
  stallMs?: number;
  /** the longest a run may take before it fails as timeout (default 10 min) */
  maxMs?: number;
}

export class WorkerPool {
  readonly size: number;
  private readonly workers: WorkerLike[] = [];
  private readonly wt: WorkerThreads;
  private readonly progress: Int32Array;
  private readonly stallMs: number;
  private readonly maxMs: number;
  private dead: PoolFailure | undefined;
  private deadDetail = '';
  /** how many jobs the pool has run (a test reads this to prove the workers did the work) */
  jobsRun = 0;
  /** the distinct worker thread ids that have answered */
  readonly threads = new Set<number>();

  constructor(opts: PoolOptions = {}) {
    const url = opts.workerUrl ?? defaultWorkerUrl();
    const why = parallelUnavailable(url);
    if (why !== undefined) throw new WorkerPoolError('unavailable', why);
    const cap = maxPoolSize();
    const size = opts.size ?? cap;
    if (!Number.isInteger(size) || size < 1 || size > cap) throw new RangeError(`worker pool size ${size} is outside 1..${cap} (min(4, cores - 2))`);
    this.size = size;
    this.stallMs = opts.stallMs ?? 30_000;
    this.maxMs = opts.maxMs ?? 600_000;
    this.wt = builtin('node:worker_threads') as WorkerThreads;
    this.progress = new Int32Array(new SharedArrayBuffer(4 * size));
    try {
      for (let i = 0; i < size; i++) {
        // execArgv is empty: the parent's flags (inspector ports, preloads, heap limits) are not the worker's business
        const w = new this.wt.Worker(url, { execArgv: [], name: `adiri-sig-${i}` });
        w.unref();
        w.on('error', (e: unknown) => this.fail('worker_error', e instanceof Error ? e.message : String(e)));
        w.on('exit', (code: number) => {
          if (this.dead === undefined) this.fail('terminated', `a worker exited with code ${code}`);
        });
        this.workers.push(w);
      }
    } catch (e) {
      this.dispose();
      throw new WorkerPoolError('unavailable', `a worker could not be started: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private fail(reason: PoolFailure, detail: string): void {
    if (this.dead === undefined) {
      this.dead = reason;
      this.deadDetail = detail;
    }
    this.dispose();
  }

  /** Terminates every worker. The pool is unusable afterwards (a later verification makes a new one). */
  dispose(): void {
    if (this.dead === undefined) this.dead = 'terminated';
    for (const w of this.workers.splice(0)) {
      try {
        const r = w.terminate() as Promise<unknown> | undefined;
        if (r !== undefined && typeof r.catch === 'function') r.catch(() => undefined);
      } catch {
        // already gone
      }
    }
    if (shared === this) shared = undefined;
  }

  get alive(): boolean {
    return this.dead === undefined;
  }

  /** Runs one wire job per element of `jobs` (job i on worker i mod size) and returns the results in order; blocks until all are done. */
  runWire<R>(kind: JobKind, jobs: readonly unknown[]): R[] {
    if (this.dead !== undefined) throw new WorkerPoolError(this.dead, `the pool is no longer usable (${this.deadDetail || 'it was disposed'})`);
    const n = jobs.length;
    if (n === 0) return [];
    const pending = new Int32Array(new SharedArrayBuffer(4));
    pending[0] = n;
    const channels = jobs.map(() => new this.wt.MessageChannel());
    jobs.forEach((job, i) => {
      const slot = i % this.size;
      this.workers[slot]!.postMessage({ kind, job, port: channels[i]!.port2, pending, progress: this.progress, slot }, [channels[i]!.port2]);
    });
    const sum = (): number => this.progress.reduce((a, b) => a + b, 0);
    const start = Date.now();
    let seen = sum();
    let lastChange = start;
    const slice = Math.max(1, Math.min(250, Math.floor(this.stallMs / 4)));
    for (;;) {
      const left = Atomics.load(pending, 0);
      if (left <= 0) break;
      const now = Date.now();
      if (now - start > this.maxMs) this.abort('timeout', `no result after ${this.maxMs} ms with ${left} of ${n} jobs unfinished`, channels);
      Atomics.wait(pending, 0, left, slice);
      const cur = sum();
      if (cur !== seen) {
        seen = cur;
        lastChange = Date.now();
      } else if (Date.now() - lastChange >= this.stallMs && Atomics.load(pending, 0) > 0) {
        this.abort('stalled', `no worker made progress for ${this.stallMs} ms with ${Atomics.load(pending, 0)} of ${n} jobs unfinished`, channels);
      }
    }
    const out: R[] = [];
    for (let i = 0; i < n; i++) {
      const m = this.wt.receiveMessageOnPort(channels[i]!.port1);
      if (m === undefined) this.abort('lost_reply', `job ${i} of ${n} finished without a reply`, channels);
      const reply = m!.message as { ok: boolean; res?: R; error?: string; threadId?: number };
      if (typeof reply.threadId === 'number') this.threads.add(reply.threadId);
      if (!reply.ok) this.abort('worker_error', reply.error ?? 'unknown error', channels);
      out.push(reply.res as R);
    }
    for (const c of channels) c.port1.close();
    this.jobsRun += n;
    return out;
  }

  private abort(reason: PoolFailure, detail: string, channels: { port1: PortLike }[]): never {
    for (const c of channels) {
      try {
        c.port1.close();
      } catch {
        // already closed
      }
    }
    this.fail(reason, detail);
    throw new WorkerPoolError(reason, detail);
  }
}

let shared: WorkerPool | undefined;

/** The process-wide pool, made on first use. */
export function sharedPool(): WorkerPool {
  if (shared === undefined || !shared.alive) shared = new WorkerPool();
  return shared;
}

/** Terminates the process-wide pool, if there is one. */
export function disposeSharedPool(): void {
  shared?.dispose();
  shared = undefined;
}

/** Where the batched check runs its jobs: 'auto' (the shared pool for a long batch where workers can run), 'off' (this thread), or a pool. */
export type Parallelism = 'auto' | 'off' | WorkerPool;

/** The two jobs of the batched check, behind one interface whether they run here or in workers. */
export interface Engine {
  decode(sigs: Uint8Array[]): DecodeResult;
  combine(job: CombineJob): CombineResult;
}

export const localEngine: Engine = {
  decode: (sigs) => decodeBatch({ sigs }),
  combine: (job) => combineBatch(job),
};

/** The batches shorter than this are not worth a hand-off in 'auto'. */
export const PARALLEL_MIN_ITEMS = 64;
/** In 'auto', a worker is given at least this many records. */
export const PARALLEL_MIN_PER_PART = 16;

const bounds = (n: number, parts: number): number[] => Array.from({ length: parts + 1 }, (_, i) => Math.floor((i * n) / parts));

/** An engine that splits each job over the pool's workers in `parts` contiguous runs (at most size, at least minPer records each). */
export function poolEngine(pool: WorkerPool, minPer = 1): Engine {
  const partsFor = (n: number): number => Math.max(1, Math.min(pool.size, Math.floor(n / minPer)));
  return {
    decode(sigs) {
      const n = sigs.length;
      const b = bounds(n, partsFor(n));
      const wires: DecodeWire[] = [];
      for (let k = 0; k + 1 < b.length; k++) wires.push({ sigs: pack(sigs.slice(b[k], b[k + 1])) });
      const res = pool.runWire<DecodeResultWire>('decode', wires);
      const codes = new Uint8Array(n).fill(SigNotExamined);
      const points: (G1Point | undefined)[] = new Array(n);
      let refused = false;
      for (let k = 0; k + 1 < b.length && !refused; k++) {
        for (let j = 0; j < b[k + 1]! - b[k]!; j++) {
          const code = res[k]!.codes[j]!;
          codes[b[k]! + j] = code;
          if (code !== SigOk) {
            refused = true;
            break;
          }
          points[b[k]! + j] = fromRaw(res[k]!.points[j]!);
        }
      }
      return { codes, points };
    },
    combine(job) {
      const n = job.points.length;
      const b = bounds(n, partsFor(n));
      const wires: CombineWire[] = [];
      for (let k = 0; k + 1 < b.length; k++) {
        const [a, e] = [b[k]!, b[k + 1]!];
        wires.push({ points: job.points.slice(a, e).map(toRaw), msgs: pack(job.msgs.slice(a, e)), scalars: job.scalars.slice(a, e), groups: job.groups.slice(a, e), dst: job.dst });
      }
      const res = pool.runWire<CombineResultWire>('combine', wires);
      let sumSig: G1Point | undefined;
      const byGroup = new Map<number, G1Point>();
      const hashPts: G1Point[] = [];
      for (const r of res) {
        const s = fromRaw(r.sumSig);
        sumSig = sumSig === undefined ? s : sumSig.add(s);
        for (const [g, raw] of r.sumHash) {
          const p = fromRaw(raw);
          const prev = byGroup.get(g);
          byGroup.set(g, prev === undefined ? p : prev.add(p));
        }
        for (const h of r.hashPts) hashPts.push(fromRaw(h));
      }
      const sumHash = new Map<number, G1Point>();
      for (const g of [...byGroup.keys()].sort((x, y) => x - y)) sumHash.set(g, byGroup.get(g)!);
      return { sumSig: sumSig!, sumHash, hashPts };
    },
  };
}

/** The engine for a batch of n records under the parallelism setting (see Parallelism). */
export function engineFor(parallel: Parallelism, n: number): Engine {
  if (parallel === 'off') return localEngine;
  if (parallel !== 'auto') return poolEngine(parallel);
  if (n < PARALLEL_MIN_ITEMS || parallelUnavailable() !== undefined || maxPoolSize() < 2) return localEngine;
  return poolEngine(sharedPool(), PARALLEL_MIN_PER_PART);
}
