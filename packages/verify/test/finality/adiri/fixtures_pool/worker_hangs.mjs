// A pool worker that takes a job and then never answers and never makes progress (a hung thread).
import { parentPort } from 'node:worker_threads';
parentPort.on('message', () => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3_600_000);
});
