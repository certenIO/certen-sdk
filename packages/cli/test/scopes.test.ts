import { describe, it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { AddressInfo } from 'node:net';

/**
 * `certen scopes`, and validating `--permissions` before a key is minted.
 *
 * Run as a SUBPROCESS against a stub gateway, because what matters here is what a process exposes:
 * the exit code, and whether the key-creation request was made at all. A typo in `--permissions`
 * used to produce a key that authenticates fine and then 403s on the one call it exists to make —
 * discovered in production, and unfixable except by issuing a new key, since permissions are set at
 * creation and cannot be edited afterwards.
 */

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'index.js');
const HOME = mkdtempSync(join(tmpdir(), 'certen-scopes-'));

type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => void;

async function stubGateway(handler: Handler): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    try {
      handler(req, res);
    } catch {
      res.statusCode = 500;
      res.end('{}');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections?.();
      server.close(() => resolve());
    }),
  };
}

const run = promisify(execFile);

interface Run { stdout: string; stderr: string; code: number }

async function certen(args: string[], apiUrl?: string): Promise<Run> {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    HOME, USERPROFILE: HOME,
    CERTEN_API_KEY: 'ck_live_test',
    CERTEN_API_URL: apiUrl ?? 'http://127.0.0.1:9',
  };
  try {
    const { stdout, stderr } = await run(process.execPath, [CLI, ...args], { env, encoding: 'utf8' });
    return { stdout, stderr, code: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: number };
    return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', code: e.code ?? -1 };
  }
}

function soleJson(stdout: string): Record<string, unknown> {
  const trimmed = stdout.trim();
  expect(trimmed.length).toBeGreaterThan(0);
  return JSON.parse(trimmed) as Record<string, unknown>;
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body));
}

describe('certen scopes and permission validation', () => {
  const CATALOGUE = {
    scopes: [
      { name: '*', description: 'Everything. Grant only when...', audience: 'customer', operations: [] },
      { name: 'billing:read', description: 'Read balance, quotes, ledger.', audience: 'customer', operations: ['GET /v1/billing/ledger'] },
      { name: 'billing:fund', description: 'Open a payment intent.', audience: 'customer', operations: ['POST /v1/billing/deposits'] },
      { name: 'admin:write', description: 'Operator writes.', audience: 'operator', operations: ['POST /v1/admin/api-keys'] },
    ],
  };

  it('hides operator scopes unless asked, so a customer is not offered admin:write', async () => {
    const s = await stubGateway((req, res) => json(res, 200, CATALOGUE));
    try {
      const r = await certen(['scopes'], s.url);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain('billing:read');
      expect(r.stdout).not.toContain('admin:write');
      expect(r.stdout).toContain('certen scopes --all');
    } finally {
      await s.close();
    }
  });

  it('shows operator scopes with --all', async () => {
    const s = await stubGateway((req, res) => json(res, 200, CATALOGUE));
    try {
      const r = await certen(['scopes', '--all'], s.url);
      expect(r.stdout).toContain('admin:write');
    } finally {
      await s.close();
    }
  });

  it('refuses an unknown permission BEFORE minting the key', async () => {
    // The failure this prevents: a typo produces a key that authenticates fine and then 403s on
    // the one call it exists to make — discovered in production, and fixable only by issuing a new
    // key, because permissions are set at creation and cannot be edited.
    const paths: string[] = [];
    const s = await stubGateway((req, res) => {
      const path = (req.url ?? '').split('?')[0];
      paths.push(path);
      if (path === '/v1/scopes') return json(res, 200, CATALOGUE);
      return json(res, 201, { id: 'k1', key: 'ck_live_x' });
    });
    try {
      const r = await certen(
        ['admin', 'api-keys', 'create', '--name', 'n', '--org-id', 'o', '--permissions', 'billing:reed'],
        s.url,
      );
      expect(r.code).toBe(2);
      expect(r.stderr).toMatch(/Not a permission: billing:reed/);
      expect(r.stderr).toMatch(/certen scopes/);
      // Critically: no key was created.
      expect(paths).not.toContain('/v1/admin/api-keys');
    } finally {
      await s.close();
    }
  });

  it('accepts valid permissions and creates the key', async () => {
    const s = await stubGateway((req, res) => {
      const path = (req.url ?? '').split('?')[0];
      if (path === '/v1/scopes') return json(res, 200, CATALOGUE);
      return json(res, 201, { id: 'k1', key: 'ck_live_x', permissions: ['billing:read'] });
    });
    try {
      const r = await certen(
        ['admin', 'api-keys', 'create', '--name', 'n', '--org-id', 'o', '--permissions', 'billing:read,billing:fund', '--json'],
        s.url,
      );
      expect(r.code).toBe(0);
    } finally {
      await s.close();
    }
  });

  it('does not fetch the catalogue when no permissions are requested', async () => {
    // Validation must not cost a round trip to callers who did not ask for it.
    const paths: string[] = [];
    const s = await stubGateway((req, res) => {
      paths.push((req.url ?? '').split('?')[0]);
      return json(res, 201, { id: 'k1', key: 'ck_live_x' });
    });
    try {
      const r = await certen(['admin', 'api-keys', 'create', '--name', 'n', '--org-id', 'o', '--json'], s.url);
      expect(r.code).toBe(0);
      expect(paths).not.toContain('/v1/scopes');
    } finally {
      await s.close();
    }
  });
});
