import http from 'node:http';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
// @ts-expect-error - plain .mjs generator module
import { toJsonSchema, successSchemaOf } from '../../../tools/agentgen/lib/jsonschema.mjs';

/**
 * A stand-in gateway for the MCP tests: it answers every route the vendored spec documents with an example built from THAT route's own
 * success schema, so what a tool receives is shaped the way the real gateway's replies are (the gateway serialises through the same
 * schemas). Shared by structured-output.test.ts and interop.test.ts.
 */
export const SPEC = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'spec', 'openapi.json'), 'utf8'));

/** An instance that satisfies a JSON Schema. */
export function example(s: any): any {
  if (s === undefined || s === true || (typeof s === 'object' && Object.keys(s).length === 0)) return 'example';
  if (s.const !== undefined) return s.const;
  if (Array.isArray(s.enum)) return s.enum.find((v: unknown) => v !== null) ?? null;
  if (s.oneOf) return example(s.oneOf[0]);
  if (s.anyOf) return example(s.anyOf.find((x: any) => x.type !== 'null') ?? s.anyOf[0]);
  if (s.allOf) return Object.assign({}, ...s.allOf.map(example));
  const type = Array.isArray(s.type) ? s.type.find((t: string) => t !== 'null') ?? 'null' : s.type;
  switch (type) {
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(s.properties ?? {})) out[k] = example(v);
      return out;
    }
    case 'array': return [example(s.items ?? {})];
    case 'string': return 'x'.repeat(Math.max(1, s.minLength ?? 1));
    case 'integer': case 'number': return Math.max(1, s.minimum ?? 1);
    case 'boolean': return true;
    case 'null': return null;
    default: return 'example';
  }
}

const routes = Object.entries(SPEC.paths).flatMap(([template, ops]: [string, any]) =>
  Object.entries(ops).map(([method, op]: [string, any]) => ({
    method: method.toUpperCase(),
    re: new RegExp(`^${template.replace(/[{][^}]+[}]/g, '[^/]+')}$`),
    status: Object.keys(op.responses ?? {}).map(Number).find((c) => c >= 200 && c < 300) ?? 200,
    schema: successSchemaOf(SPEC, `${method.toUpperCase()} ${template}`),
  })));

/** The spec documents a few responses only as "object"; where a tool needs a field the gateway really sends, the stub sends it. */
export const FIXED_RESPONSES: Array<{ method: string; re: RegExp; body: unknown }> = [
  { method: 'GET', re: /^\/v1\/chains$/, body: { chains: [{ id: 'ethereum-sepolia', chainId: 11155111 }, { id: 'base-sepolia', chainId: 84532 }, { id: 'arbitrum-sepolia', chainId: 421614 }] } },
  // a terminal status, so certen_execute_wait returns instead of waiting out its budget on an invented one
  { method: 'GET', re: /^\/v1\/transaction\/[^/]+$/, body: { intent_id: 'i1', status: 'completed', proof_id: 'p1', created_at: '2026-01-01T00:00:00Z' } },
];

export interface SpecGateway { url: string; seen: string[]; close: () => Promise<void> }

export async function startSpecGateway(): Promise<SpecGateway> {
  const seen: string[] = [];
  const server = http.createServer((req, res) => {
    const path = (req.url ?? '').split('?')[0];
    seen.push(`${req.method} ${path}`);
    req.resume();
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      const forced = FIXED_RESPONSES.find((f) => f.method === req.method && f.re.test(path));
      if (forced) { res.statusCode = 200; return void res.end(JSON.stringify(forced.body)); }
      const route = routes.find((r) => r.method === req.method && r.re.test(path));
      if (!route) { res.statusCode = 404; return void res.end(JSON.stringify({ code: 'NOT_FOUND', error: `no route ${req.method} ${path}` })); }
      res.statusCode = route.status;
      if (route.status === 204 || !route.schema) return void res.end();
      res.end(JSON.stringify(example(toJsonSchema(route.schema, SPEC.components?.schemas ?? {}))));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    seen,
    close: () => new Promise<void>((r) => { server.closeAllConnections?.(); server.close(() => r()); }),
  };
}
