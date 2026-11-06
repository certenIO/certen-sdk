import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import { dispatch } from '../src/protocol.js';
import { createHandlers } from '../src/server.js';

/**
 * `certen_proof_verify` on a REAL proof of the evidence the validators emit today (2.1, with a finality section): what the tool returns must conform to the
 * `outputSchema` a client reads in `tools/list`. The structured-output test runs every tool against documents built from the spec, which carry no real
 * Accumulate proof, so the verifier stops at its first layer there and never produces the members a real verification does (`govRootV4`, `finality`). A closed
 * schema that does not name them makes a strict MCP client refuse the result of the one tool this release is for, and only a real document shows it.
 *
 * The document and bundle are the frozen capture in the verifier's fixtures (see its PROVENANCE.json): public testnet data, unmodified.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, '..', '..', 'verify', 'test', 'fixtures', 'live21-base-sepolia');
const PORTABLE = gunzipSync(readFileSync(join(FIXTURE, 'portable.json.gz')));
const BUNDLE = readFileSync(join(FIXTURE, 'bundle.json'));
const PROVENANCE = JSON.parse(readFileSync(join(FIXTURE, 'PROVENANCE.json'), 'utf8')) as { proof_id: string; govRootV4_computed_by_this_verifier: string };
const PROOF_ID = PROVENANCE.proof_id;

const PV = 'io.modelcontextprotocol/protocolVersion';
const CAPS = 'io.modelcontextprotocol/clientCapabilities';
const modernMeta = { [PV]: '2026-07-28', [CAPS]: {} };

let server: http.Server;
let baseUrl = '';
const asked: string[] = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const path = (req.url ?? '').split('?')[0] ?? '';
    asked.push(`${req.method} ${path}`);
    req.resume();
    req.on('end', () => {
      if (req.method === 'GET' && path === `/v1/proof/${PROOF_ID}/bundle`) {
        res.setHeader('content-type', 'application/octet-stream');
        return void res.end(BUNDLE);
      }
      if (req.method === 'GET' && path === `/v1/proof/${PROOF_ID}/v2`) {
        res.setHeader('content-type', 'application/json');
        return void res.end(PORTABLE);
      }
      // the target is a proof id, not an intent: the intent lookup says so, as the gateway does
      res.statusCode = 404;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ code: 'NOT_FOUND', error: `no route ${req.method} ${path}` }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => {
  await new Promise<void>((r) => {
    server.closeAllConnections?.();
    server.close(() => r());
  });
});

const rpc = async (handlers: ReturnType<typeof createHandlers>, method: string, params: Record<string, unknown>) =>
  (await dispatch({ jsonrpc: '2.0', id: 1, method, params }, handlers))?.result as any;

describe('certen_proof_verify on a real evidence-2.1 proof', () => {
  it('returns structuredContent that conforms to its outputSchema, and says what the verifier established', async () => {
    const handlers = createHandlers({ env: { CERTEN_API_KEY: 'k', CERTEN_API_URL: baseUrl } as NodeJS.ProcessEnv });
    const listed = (await rpc(handlers, 'tools/list', { _meta: modernMeta })).tools.find((t: any) => t.name === 'certen_proof_verify');
    const validate = new Ajv2020({ strict: false, allErrors: true }).compile(listed.outputSchema);

    const res = await rpc(handlers, 'tools/call', { name: 'certen_proof_verify', arguments: { target: PROOF_ID }, _meta: modernMeta });
    const text = res.content?.[0]?.text as string;
    expect(res.isError, `returned an error: ${text}`).not.toBe(true);
    const out = res.structuredContent;

    expect(validate(out), `${JSON.stringify(validate.errors)}`).toBe(true);
    expect(JSON.parse(text)).toEqual(out);

    // the document was found and judged by the verifier: the Accumulate side holds, and the root derived from it is the one this proof has
    expect(asked).toContain(`GET /v1/proof/${PROOF_ID}/v2`);
    expect(out.evidenceFound).toBe(true);
    const layers: Array<{ id: string; verdict: string }> = out.layers;
    for (const id of ['trust_base', 'L4', 'L1', 'L2', 'L3', 'G0', 'G1', 'govRootV4']) {
      expect(layers.find((l) => l.id === id)?.verdict, `layer ${id}`).toBe('verified');
    }
    expect(out.govRootV4).toBe(PROVENANCE.govRootV4_computed_by_this_verifier);
    // the finality section (S7) is reported, and with no header from the caller's own node the outcome is not claimed
    expect(out.finality).toBeTypeOf('object');
    expect(layers.find((l) => l.id === 'outcome')?.verdict).toBe('not_checked');
    expect(out.overall).toBe('partial');
    expect(out.independent).toBe(false);
  }, 120_000);
});
