import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import { intentOutcome, INTENT_STATUS_CLASS } from '@certen.io/sdk';
import { dispatch } from '../src/protocol.js';
import { createHandlers } from '../src/server.js';
import { ALL_TOOLS, type ToolDef } from '../src/tools.js';
import { CUSTOM_OUTPUT_SCHEMAS, outputSchemaFor } from '../src/output-schemas.js';
import { GENERATED_OUTPUT_SCHEMAS } from '../src/output-schemas.generated.js';
// @ts-expect-error - plain .mjs generator module, shared so the test and the generator cannot disagree about what is custom
import { CUSTOM_TOOLS, INTENT_OUTCOME_SCHEMA, toolEndpoints } from '../../../tools/agentgen/emit/mcp-output-schemas.mjs';
import { startSpecGateway, type SpecGateway } from './spec-gateway.js';

/**
 * Every tool declares an `outputSchema` and returns `structuredContent` that conforms to it (MCP: "Servers MUST provide structured
 * results that conform to this schema"). This runs ALL tools through the real server and the real SDK against a stub gateway that
 * answers each route with an example built from that route's own response schema in the vendored spec, then validates what each tool
 * actually returned against the schema a client reads in `tools/list`.
 *
 * It is what catches a tool that reshapes the gateway's body (the schema says one thing, the tool returns another) and a custom
 * schema that has drifted from what its tool builds.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const SPEC = JSON.parse(readFileSync(join(HERE, '..', '..', '..', 'spec', 'openapi.json'), 'utf8'));
const PV = 'io.modelcontextprotocol/protocolVersion';
const CAPS = 'io.modelcontextprotocol/clientCapabilities';

// ── the stand-in gateway ────────────────────────────────────────────────────────────────────────────
let gateway: SpecGateway;
let baseUrl = '';
beforeAll(async () => { gateway = await startSpecGateway(); baseUrl = gateway.url; });
afterAll(async () => { await gateway.close(); });

// ── arguments for each tool ────────────────────────────────────────────────────────────────────────
const UUID = '396f863c-879c-4046-8591-3f0405c5f6bd';
const HEX64 = 'ab'.repeat(32);
function argsFor(tool: ToolDef): Record<string, unknown> {
  const props = (tool.inputSchema.properties ?? {}) as Record<string, any>;
  const out: Record<string, unknown> = {};
  for (const name of (tool.inputSchema.required ?? []) as string[]) {
    const p = props[name] ?? {};
    if (name === 'confirm') out[name] = true;
    else if (name === 'chain') out[name] = 'base-sepolia';
    else if (name === 'intent') out[name] = { legs: [{ chain: 'base-sepolia', toAddress: `0x${'22'.repeat(20)}`, amount: '0' }] };
    else if (name === 'link') out[name] = `${baseUrl}/v1/proof/shared/token123`;
    else if (name === 'targetId') out[name] = UUID;
    else if (name === 'address') out[name] = `0x${'11'.repeat(20)}`;
    else if (name === 'signature') out[name] = 'cd'.repeat(64);
    else if (/hash|publicKey/i.test(name)) out[name] = HEX64;
    else if (/Id$|^id$/.test(name)) out[name] = UUID;
    else if (p.type === 'number') out[name] = 1;
    else if (p.type === 'boolean') out[name] = true;
    else if (p.type === 'array') out[name] = ['base-sepolia'];
    else out[name] = 'example';
  }
  return out;
}

const modernMeta = { [PV]: '2026-07-28', [CAPS]: {} };
const rpc = async (handlers: ReturnType<typeof createHandlers>, method: string, params: Record<string, unknown>) =>
  (await dispatch({ jsonrpc: '2.0', id: 1, method, params }, handlers))?.result as any;
const handlersFor = () => createHandlers({ env: { CERTEN_API_KEY: 'k', CERTEN_API_URL: baseUrl, CERTEN_MCP_ALLOW_WRITES: '1' } as NodeJS.ProcessEnv });

describe('every tool declares an outputSchema', () => {
  it('has one for each of the tools, generated for most and written for the rest', () => {
    expect(ALL_TOOLS.length).toBe(48);
    for (const t of ALL_TOOLS) expect(outputSchemaFor(t.name), t.name).toBeDefined();
    expect(Object.keys(GENERATED_OUTPUT_SCHEMAS).length + Object.keys(CUSTOM_OUTPUT_SCHEMAS).length).toBe(ALL_TOOLS.length);
    expect(Object.keys(CUSTOM_OUTPUT_SCHEMAS).sort()).toEqual([...CUSTOM_TOOLS].sort());
    for (const name of CUSTOM_TOOLS) expect(GENERATED_OUTPUT_SCHEMAS[name], `${name} must not be generated as well`).toBeUndefined();
  });

  it('is an object schema everywhere (a result is an object in every protocol version that has structured output)', () => {
    for (const t of ALL_TOOLS) {
      const s = outputSchemaFor(t.name)! as { type?: unknown };
      expect(s.type, t.name).toBe('object');
    }
  });

  it('reads every tool\'s endpoint from the source the same way the server does', () => {
    const src = readFileSync(join(HERE, '..', 'src', 'tools.ts'), 'utf8');
    const endpoints = toolEndpoints(src) as Map<string, string>;
    expect([...endpoints.keys()].sort()).toEqual(ALL_TOOLS.map((t) => t.name).sort());
    for (const t of ALL_TOOLS) expect(endpoints.get(t.name), t.name).toBe(t.endpoint);
  });

  it('puts the schemas in tools/list for every era that has structured output, and not for those that predate it', async () => {
    const modern = await rpc(handlersFor(), 'tools/list', { _meta: modernMeta });
    expect(modern.tools.every((t: any) => t.outputSchema?.type === 'object')).toBe(true);
    for (const [v, expected] of [['2025-11-25', true], ['2025-06-18', true], ['2025-03-26', false], ['2024-11-05', false]] as const) {
      const h = handlersFor();
      await rpc(h, 'initialize', { protocolVersion: v });
      const list = await rpc(h, 'tools/list', {});
      expect(list.tools.every((t: any) => (t.outputSchema !== undefined) === expected), v).toBe(true);
    }
  });
});

describe('every tool returns structuredContent that conforms to its outputSchema', () => {
  const ajv = new Ajv2020({ strict: false, allErrors: true });

  for (const tool of ALL_TOOLS) {
    it(`${tool.name}`, async () => {
      const h = handlersFor();
      const listed = (await rpc(h, 'tools/list', { _meta: modernMeta })).tools.find((t: any) => t.name === tool.name);
      const validate = ajv.compile(listed.outputSchema);

      const res = await rpc(h, 'tools/call', { name: tool.name, arguments: argsFor(tool), _meta: modernMeta });
      const text = res.content?.[0]?.text;
      expect(res.isError, `${tool.name} returned an error: ${text}`).not.toBe(true);
      expect(res.resultType).toBe('complete');
      expect(res.structuredContent, `${tool.name} returned no structuredContent`).toBeDefined();
      expect(validate(res.structuredContent), `${tool.name}: ${JSON.stringify(validate.errors)}\n${JSON.stringify(res.structuredContent).slice(0, 400)}`).toBe(true);
      // the text block carries the same value, for clients that read only text
      expect(JSON.parse(text)).toEqual(res.structuredContent);
    });
  }

  it('actually reached the gateway for each family of route (the stub was exercised, not bypassed)', () => {
    expect(gateway.seen.length).toBeGreaterThan(40);
    expect(gateway.seen.some((r) => r.startsWith('GET /v1/transaction/'))).toBe(true);
    expect(gateway.seen.some((r) => r.startsWith('POST /v1/transaction'))).toBe(true);
  });
});

describe('what is not a tool result is not shaped like one', () => {
  it('flags a confirmation stop as an error with no structuredContent, so it is never validated against the tool\'s schema', async () => {
    const res = await rpc(handlersFor(), 'tools/call', { name: 'certen_identity_retire', arguments: { identityId: UUID }, _meta: modernMeta });
    expect(res.isError).toBe(true);
    expect(res.structuredContent).toBeUndefined();
    expect(JSON.parse(res.content[0].text).status).toBe('confirmation_required');
  });

  it('flags a gateway failure as an error with no structuredContent', async () => {
    const h = createHandlers({ env: { CERTEN_API_KEY: 'k', CERTEN_API_URL: `${baseUrl}/nope-nothing-here`, CERTEN_MCP_ALLOW_WRITES: '1' } as NodeJS.ProcessEnv });
    const res = await rpc(h, 'tools/call', { name: 'certen_transaction_get', arguments: { intentId: UUID }, _meta: modernMeta });
    expect(res.isError).toBe(true);
    expect(res.structuredContent).toBeUndefined();
  });

  it('reports a non-object result by name instead of wrapping or coercing it', async () => {
    const h = createHandlers({ env: { CERTEN_API_KEY: 'k' } as NodeJS.ProcessEnv, client: { identity: { get: async () => 'not an object' } } as never });
    const res = await rpc(h, 'tools/call', { name: 'certen_identity_get', arguments: { identityId: UUID }, _meta: modernMeta });
    expect(res.isError).toBe(true);
    expect(JSON.parse(res.content[0].text).error.code).toBe('UNEXPECTED_RESULT');
    expect(res.structuredContent).toBeUndefined();
  });
});

describe('structured output by protocol era', () => {
  const call = async (version: string | 'modern') => {
    const h = handlersFor();
    if (version !== 'modern') await rpc(h, 'initialize', { protocolVersion: version });
    return rpc(h, 'tools/call', { name: 'certen_transaction_get', arguments: { intentId: UUID }, ...(version === 'modern' ? { _meta: modernMeta } : {}) });
  };

  it('sends structuredContent on 2026-07-28, 2025-11-25 and 2025-06-18', async () => {
    for (const v of ['modern', '2025-11-25', '2025-06-18']) {
      const res = await call(v);
      expect(res.structuredContent, v).toBeDefined();
      expect(res.content[0].type).toBe('text');
    }
  });

  it('sends text only to 2025-03-26 and 2024-11-05 clients, which predate structured output', async () => {
    for (const v of ['2025-03-26', '2024-11-05']) {
      const res = await call(v);
      expect(res.structuredContent, v).toBeUndefined();
      expect(JSON.parse(res.content[0].text)).toBeTypeOf('object');
    }
  });
});

describe('the status outcome schema matches intentOutcome()', () => {
  it('validates the outcome of every known status and an unknown one', () => {
    const validate = new Ajv2020({ strict: false }).compile(INTENT_OUTCOME_SCHEMA);
    for (const status of [...Object.keys(INTENT_STATUS_CLASS), 'brand_new_state', '']) {
      for (const reason_code of [undefined, 'expired']) {
        const o = intentOutcome({ status, reason_code });
        expect(validate(o), `${status}/${reason_code}: ${JSON.stringify(validate.errors)}`).toBe(true);
      }
    }
  });
});
