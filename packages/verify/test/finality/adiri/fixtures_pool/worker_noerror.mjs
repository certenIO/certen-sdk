// A pool worker that answers with a failure reply that carries no error text.
import { parentPort, threadId } from 'node:worker_threads';
parentPort.on('message', (m) => {
  m.port.postMessage({ ok: false, threadId });
  Atomics.sub(m.pending, 0, 1);
  Atomics.notify(m.pending, 0);
});
