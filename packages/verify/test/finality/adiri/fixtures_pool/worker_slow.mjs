// A pool worker that is slow but alive: it reports progress every 100 ms for 1.5 s, then answers with the job it was given.
import { parentPort, threadId } from 'node:worker_threads';
parentPort.on('message', (m) => {
  const wait = new Int32Array(new SharedArrayBuffer(4));
  for (let i = 0; i < 15; i++) {
    Atomics.wait(wait, 0, 0, 100);
    Atomics.add(m.progress, m.slot, 1);
  }
  m.port.postMessage({ ok: true, res: m.job, threadId });
  Atomics.sub(m.pending, 0, 1);
  Atomics.notify(m.pending, 0);
});
