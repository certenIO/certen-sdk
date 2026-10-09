import { describe, it, expect } from 'vitest';
import http from 'node:http';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CertenClient } from '../src/client.js';
import { CertenError } from '../src/errors.js';
import { apiPath } from '../src/internal.js';

/**
 * Every id, hash and token that reaches a request path is encoded as exactly one segment.
 *
 * Fail-before, recorded in RUNLOG_RB7b (F17/F28): 25 call sites interpolated their argument raw. An id of `a/b?x=1` reached the
 * server as the path `/v1/identity/a/b` with a query, and an id of `..` named a different route once any proxy normalised it.
 */
const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');

describe('apiPath', () => {
  it('encodes each interpolated value as one segment and leaves the route alone', () => {
    expect(apiPath`/v1/proof/${'abc'}/bundle`).toBe('/v1/proof/abc/bundle');
    expect(apiPath`/v1/identity/${'a/b'}`).toBe('/v1/identity/a%2Fb');
    expect(apiPath`/v1/identity/${'a?x=1#f'}`).toBe('/v1/identity/a%3Fx%3D1%23f');
    expect(apiPath`/v1/x/${'100%'}`).toBe('/v1/x/100%25');
    expect(apiPath`/v1/x/${'a b'}`).toBe('/v1/x/a%20b');
    expect(apiPath`/v1/x/${'café'}`).toBe('/v1/x/caf%C3%A9');
    expect(apiPath`/v1/x/${'%2e%2e'}`).toBe('/v1/x/%252e%252e'); // an already-encoded dot is data, not a traversal
  });

  it('refuses a value made only of dots, which the url parser resolves away even when written as %2E', () => {
    for (const dots of ['.', '..', '...']) {
      expect(() => apiPath`/v1/proof/${dots}`, dots).toThrow(/INVALID|cannot be/);
      expect(() => apiPath`/v1/proof/${dots}`).toThrowError(expect.objectContaining({ code: 'INVALID_PATH_PARAMETER' }));
    }
    expect(apiPath`/v1/proof/${'a.b'}`).toBe('/v1/proof/a.b'); // only a segment made entirely of dots is special
    expect(apiPath`/v1/proof/${'..a'}`).toBe('/v1/proof/..a');
  });

  it('accepts numbers and bigints, as a chain id or a tree size is', () => {
    expect(apiPath`/v1/chains/${11155111}`).toBe('/v1/chains/11155111');
    expect(apiPath`/v1/transparency/heads/${12n}`).toBe('/v1/transparency/heads/12');
  });

  it('refuses an empty, missing or non-scalar value by name instead of requesting a different route', () => {
    for (const bad of ['', undefined, null, {}, [], true]) {
      let err: unknown;
      try { apiPath`/v1/identity/${bad}`; } catch (e) { err = e; }
      expect(err, String(bad)).toBeInstanceOf(CertenError);
      expect(err, String(bad)).toMatchObject({ code: 'INVALID_PATH_PARAMETER', status: 0 });
    }
    expect(() => apiPath`/v1/identity/${''}`).toThrow(/identity parameter is empty/);
    expect(() => apiPath`/v1/x/${'\ud800'}`).toThrow(/not valid text/);
  });
});

describe('no request path interpolates a raw value', () => {
  /** Every .ts file under src, so a new resource cannot reintroduce the defect unseen. */
  const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true })
    .flatMap((d) => d.isDirectory() ? files(join(dir, d.name)) : d.name.endsWith('.ts') ? [join(dir, d.name)] : []);

  it('has no `/v1/...${}` template literal outside apiPath, and no encodeURIComponent outside it', () => {
    const offenders: string[] = [];
    for (const f of files(SRC)) {
      if (f.endsWith('internal.ts')) continue;
      const text = readFileSync(f, 'utf8');
      for (const m of text.matchAll(/(.?)`(\/v1\/[^`]*\$\{[^`]*)`/g)) {
        // a template literal tagged with apiPath is preceded by the tag name, which the pattern captures as the char before the backtick
        if (!text.slice(Math.max(0, (m.index ?? 0) - 7), (m.index ?? 0) + 1).endsWith('apiPath')) offenders.push(`${f}: \`${m[2]}\``);
      }
      if (/encodeURIComponent\(/.test(text)) offenders.push(`${f}: encodeURIComponent (use apiPath)`);
    }
    expect(offenders).toEqual([]);
  });
});

describe('through the real resources', () => {
  const seen: string[] = [];
  const serve = async (): Promise<{ client: CertenClient; close: () => Promise<void> }> => {
    const srv = http.createServer((req, res) => { seen.push(req.url ?? ''); res.setHeader('content-type', 'application/json'); res.end('{}'); });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
    return { client: new CertenClient({ apiKey: 'k', baseUrl: url, maxRetries: 0 }), close: () => new Promise<void>((r) => { srv.closeAllConnections?.(); srv.close(() => r()); }) };
  };

  it('delivers hostile ids to the server as a single encoded segment', async () => {
    const { client, close } = await serve();
    try {
      seen.length = 0;
      await client.identity.get('a/b?x=1#f', { include: [] });
      await client.transaction.get('a..b');
      await client.proof.get('a/../admin');
      await client.proof.byTxHash('x?y');
      await client.proof.receipt('.a');
      await client.governance.get('a b');
      await client.admin.revokeApiKey('k/1').catch(() => undefined);
      await client.chains.get('eth/../x');
      await client.transparency.fx('f%2Fg');
      await client.execute.proof('i/../../x').catch(() => undefined);
      expect(seen).toEqual([
        '/v1/identity/a%2Fb%3Fx%3D1%23f?include=',
        '/v1/transaction/a..b',
        '/v1/proof/a%2F..%2Fadmin',
        '/v1/proof/tx/x%3Fy',
        '/v1/proof/tx/.a/receipt',
        '/v1/governance/a%20b',
        '/v1/admin/api-keys/k%2F1',
        '/v1/chains/eth%2F..%2Fx',
        '/v1/transparency/fx/f%252Fg',
        '/v1/transaction/i%2F..%2F..%2Fx',
      ]);
    } finally { await close(); }
  });

  it('refuses an empty or dot-only id before sending anything, instead of calling another route', async () => {
    const { client, close } = await serve();
    try {
      seen.length = 0;
      await expect(client.identity.get('')).rejects.toMatchObject({ code: 'INVALID_PATH_PARAMETER' });
      await expect(client.transaction.get('')).rejects.toMatchObject({ code: 'INVALID_PATH_PARAMETER' });
      await expect(client.transaction.get('..')).rejects.toMatchObject({ code: 'INVALID_PATH_PARAMETER' });
      await expect(client.proof.receipt('.')).rejects.toMatchObject({ code: 'INVALID_PATH_PARAMETER' });
      expect(seen).toEqual([]);
    } finally { await close(); }
  });
});
