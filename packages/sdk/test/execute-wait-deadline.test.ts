import { describe, it, expect } from 'vitest';
import http from 'node:http';
import { CertenClient } from '../src/client.js';
import { CertenWaitTimeoutError } from '../src/errors.js';

/**
 * `wait()` gives up at the caller's deadline, not one polling interval after it.
 *
 * It slept a full `intervalMs` after every non-terminal poll, so a 100ms budget with the default 8s interval took about 8s to
 * report a timeout (the MCP tool, which never passes an interval, was the visible case).
 */
describe('execute.wait() and its deadline', () => {
  it('reports a timeout promptly when the interval is far longer than the budget', async () => {
    const srv = http.createServer((_req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ intent_id: 'i1', status: 'processing' }));
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    try {
      const client = new CertenClient({ apiKey: 'k', baseUrl: `http://127.0.0.1:${(srv.address() as { port: number }).port}`, maxRetries: 0 });
      const t0 = Date.now();
      const err = await client.execute.wait('i1', { timeoutMs: 200, intervalMs: 8_000 }).catch((e) => e);
      const elapsed = Date.now() - t0;
      expect(err).toBeInstanceOf(CertenWaitTimeoutError);
      expect(err.lastStatus).toBe('processing');
      // The old behaviour took the full 8s interval; anything under half of it separates the two without depending on machine load.
      expect(elapsed).toBeLessThan(4_000);
    } finally {
      srv.closeAllConnections?.();
      await new Promise<void>((r) => srv.close(() => r()));
    }
  });
});
