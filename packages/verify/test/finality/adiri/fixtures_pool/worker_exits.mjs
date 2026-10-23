// A pool worker whose thread ends (a crash) while it holds a job.
import { parentPort } from 'node:worker_threads';
parentPort.on('message', () => {
  process.exit(3);
});
