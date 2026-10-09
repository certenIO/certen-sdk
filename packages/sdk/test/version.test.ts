import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { SDK_VERSION } from '../src/version.js';
import { CertenClient } from '../src/client.js';

const PKG = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8')) as { version: string };

/**
 * The User-Agent used to read `process.env.npm_package_version`, which is the version of whatever package launched the process: the
 * consumer's own version, or `dev` under plain node. It now names this SDK's version, written into src/version.ts by the build.
 */
describe('the SDK reports its own version', () => {
  it('src/version.ts is the package.json version (the build rewrites it; a bump without a build fails here)', () => {
    expect(SDK_VERSION).toBe(PKG.version);
  });

  it('sends it as the User-Agent from Node, whatever package launched the process', async () => {
    const seen: Array<string | undefined> = [];
    const srv = http.createServer((req, res) => { seen.push(req.headers['user-agent']); res.setHeader('content-type', 'application/json'); res.end('{}'); });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const before = process.env.npm_package_version;
    process.env.npm_package_version = '9.9.9-consumer';
    try {
      const client = new CertenClient({ apiKey: 'k', baseUrl: `http://127.0.0.1:${(srv.address() as { port: number }).port}`, maxRetries: 0 });
      await client.portfolio.get();
      expect(seen).toEqual([`certen-sdk-node/${PKG.version}`]);
    } finally {
      if (before === undefined) delete process.env.npm_package_version; else process.env.npm_package_version = before;
      srv.closeAllConnections?.();
      await new Promise<void>((r) => srv.close(() => r()));
    }
  });
});
