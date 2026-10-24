// A pool worker that answers every job with an error reply (the protocol of src/proof-v2/finality/adiri/pool-worker.ts).
import { parentPort, threadId } from 'node:worker_threads';
parentPort.on('message', (m) => {
  m.port.postMessage({ ok: false, error: 'Error: injected failure', threadId });
  Atomics.sub(m.pending, 0, 1);
  Atomics.notify(m.pending, 0);
});
