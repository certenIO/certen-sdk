import http from 'node:http';
import { AddressInfo } from 'node:net';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { newHome } from './run-cli.js';

/**
 * A gateway that answers exactly what a test tells it to, and records exactly what it was sent.
 *
 * The fake gateways in this directory model a whole journey. The commands that came with the gateway's newer routes (a balance read, the
 * readiness facts, a quote, a credit top-up, a drip) each answer one request, and what matters about them is what did and did NOT reach the
 * wire, in what order, with which headers: so these tests script the answer per request and read the log afterwards.
 */

export interface Seen {
  method: string;
  path: string;
  query: string;
  headers: http.IncomingHttpHeaders;
  raw: string;
  body: any;
}

export interface Reply {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
  /** Hold the socket open and never answer (a gateway that hangs). */
  hang?: boolean;
  /** Drop the connection without a response, after the request was read: the caller cannot know whether it was acted on. */
  destroy?: boolean;
}

export interface Stub {
  url: string;
  seen: Seen[];
  /** Requests that were not `GET /v1/chains` (which a command may read for the registry and which is not what a test is about). */
  calls(): Seen[];
  close(): Promise<void>;
}

export type Handler = (request: Seen) => Reply | undefined;

export async function startStub(handler: Handler): Promise<Stub> {
  const seen: Seen[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const [path = '', query = ''] = (req.url ?? '').split('?');
      let body: any;
      try { body = raw ? JSON.parse(raw) : undefined; } catch { body = undefined; }
      const request: Seen = { method: req.method ?? 'GET', path, query, headers: req.headers, raw, body };
      seen.push(request);
      const reply = handler(request) ?? { status: 404, body: { message: `no route for ${request.method} ${path} in the stub`, error: 'Not Found' } };
      if (reply.hang) return;
      if (reply.destroy) { req.socket.destroy(); return; }
      res.writeHead(reply.status ?? 200, { 'content-type': 'application/json', ...(reply.headers ?? {}) });
      res.end(JSON.stringify(reply.body ?? {}));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    seen,
    calls: () => seen.filter((r) => !(r.method === 'GET' && r.path === '/v1/chains')),
    close: () => new Promise<void>((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); }),
  };
}

/** The identity every one of these tests acts as. */
export const WHO = Object.freeze({
  id: '00000000-0000-4000-8000-000000000001',
  adi: 'acc://probe.acme',
  keyPage: 'acc://probe.acme/book/1',
  account: '0xe293e95Ec1471155d977448B99B0922C2828cAcB',
  chain: 'base-sepolia',
  chainId: 84532,
});

/** The key a test puts in the config. It must never appear in anything the CLI prints. */
export const API_KEY = 'ck_live_stub_secret_do_not_print_0123456789abcdef';

export interface HomeOptions {
  /** Record the identity (and its chain) in the config, as `certen setup` does. Default true. */
  identity?: boolean;
  /** Chains the recorded identity is linked to. Default one: base-sepolia. */
  chains?: string[];
  /** A profile value for the chain (so the chain comes from context rather than a flag). */
  contextChain?: string;
}

/**
 * A throwaway HOME holding an API key and, by default, one recorded identity.
 *
 * The config file is written owner-only (0600): off Windows the CLI refuses to read a file that group or world can read before it looks inside,
 * and a fixture that forgot would pass here and fail on the Linux runners.
 */
export function homeFor(apiUrl: string, options: HomeOptions = {}): string {
  const home = newHome();
  const dir = join(home, '.certen');
  mkdirSync(dir, { recursive: true });
  const config: Record<string, unknown> = {
    api_key: API_KEY, storage: 'file', api_url: apiUrl,
    ...(options.identity === false ? {} : {
      identities: [{ id: WHO.id, adi_url: WHO.adi, chains: options.chains ?? [WHO.chain], created_at: '2026-10-15T00:00:00Z', name: 'probe' }],
    }),
    ...(options.contextChain ? { profiles: { default: { chain: options.contextChain } } } : {}),
  };
  writeFileSync(join(dir, 'config.json'), JSON.stringify(config, null, 2), { mode: 0o600 });
  return home;
}

/**
 * A gateway in front of another one: every request is passed on and every answer comes back unchanged, except where `rewrite` says otherwise.
 * It lets a test add what the shared fake does not model (a quote route, the `destination` of a transaction) without editing the fake.
 */
export async function frontGateway(
  upstream: string,
  rewrite: (request: Seen, forwarded: () => Promise<{ status: number; body: any }>) => Promise<Reply | undefined> | Reply | undefined,
): Promise<Stub> {
  const seen: Seen[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', async () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const [path = '', query = ''] = (req.url ?? '').split('?');
      let body: any;
      try { body = raw ? JSON.parse(raw) : undefined; } catch { body = undefined; }
      const request: Seen = { method: req.method ?? 'GET', path, query, headers: req.headers, raw, body };
      seen.push(request);
      const forwarded = async (): Promise<{ status: number; body: any }> => {
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string' && k !== 'host' && k !== 'content-length' && k !== 'connection') headers[k] = v;
        const response = await fetch(`${upstream}${req.url ?? ''}`, { method: request.method, headers, ...(raw ? { body: raw } : {}) });
        const text = await response.text();
        let parsed: any;
        try { parsed = text ? JSON.parse(text) : undefined; } catch { parsed = text; }
        return { status: response.status, body: parsed };
      };
      const reply = (await rewrite(request, forwarded)) ?? (await forwarded());
      res.writeHead(reply.status ?? 200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(reply.body ?? {}));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    seen,
    calls: () => seen.filter((r) => !(r.method === 'GET' && r.path === '/v1/chains')),
    close: () => new Promise<void>((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); }),
  };
}
