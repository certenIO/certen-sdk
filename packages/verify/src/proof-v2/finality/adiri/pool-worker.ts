/**
 * The worker thread of pool.ts. It runs the wire jobs of msm.ts (`runWire`): decode a run of signatures, or form the combination sums of a
 * run of records. LEAF MODULE, started by file name (a `.js` from a build, a `.ts` under Node's type stripping): it imports no sibling
 * file by a relative specifier and loads msm.ts through a computed one. It reaches node:worker_threads through process.getBuiltinModule
 * so that a bundler that follows the `new URL(...)` of pool.ts into this file meets no node: import.
 *
 * Protocol, one message per job: { kind, job, port, pending, progress, slot }. The reply { ok, res | error, threadId } is posted on `port`
 * BEFORE `pending` (a shared counter of unfinished jobs) is decremented and notified, which is what the waiting thread's Atomics.wait
 * returns on; `progress[slot]` is incremented after each record, which is how a stalled worker is told from a slow one.
 */
const wt = (process as unknown as { getBuiltinModule(id: string): any }).getBuiltinModule('node:worker_threads');
const ext = import.meta.url.endsWith('.ts') ? '.ts' : '.js';
let core: any;
let loadError: unknown;
try {
  core = await import(new URL(`./msm${ext}`, import.meta.url).href);
} catch (e) {
  loadError = e;
}

interface JobMessage {
  kind: string;
  job: unknown;
  port: { postMessage(m: unknown): void };
  pending: Int32Array;
  progress: Int32Array;
  slot: number;
}

wt.parentPort.on('message', (m: JobMessage) => {
  let reply: Record<string, unknown>;
  try {
    if (core === undefined) throw new Error(`the worker could not load msm${ext}: ${loadError instanceof Error ? loadError.message : String(loadError)}`);
    reply = { ok: true, res: core.runWire(m.kind, m.job, () => Atomics.add(m.progress, m.slot, 1)), threadId: wt.threadId };
  } catch (e) {
    reply = { ok: false, error: e instanceof Error ? `${e.name}: ${e.message}` : String(e), threadId: wt.threadId };
  }
  m.port.postMessage(reply);
  Atomics.sub(m.pending, 0, 1);
  Atomics.notify(m.pending, 0);
});
