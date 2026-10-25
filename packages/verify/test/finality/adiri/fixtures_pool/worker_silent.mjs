// A pool worker that reports its job finished WITHOUT posting a reply (a lost reply).
import { parentPort } from 'node:worker_threads';
parentPort.on('message', (m) => {
  Atomics.sub(m.pending, 0, 1);
  Atomics.notify(m.pending, 0);
});
