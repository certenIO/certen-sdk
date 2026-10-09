import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
// @ts-expect-error - plain .mjs generator modules
import { toJsonSchema, successSchemaOf } from '../../../tools/agentgen/lib/jsonschema.mjs';
// @ts-expect-error - plain .mjs
import { emitMcpOutputSchemas, EXTENDED_TOOLS, CUSTOM_TOOLS } from '../../../tools/agentgen/emit/mcp-output-schemas.mjs';
import { GENERATED_OUTPUT_SCHEMAS } from '../src/output-schemas.generated.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SPEC = JSON.parse(readFileSync(join(ROOT, 'spec', 'openapi.json'), 'utf8'));

describe('OpenAPI -> JSON Schema for outputSchema', () => {
  it('turns nullable into a union with null, for plain, enum and untyped schemas', () => {
    expect(toJsonSchema({ type: 'string', nullable: true })).toEqual({ type: ['string', 'null'] });
    expect(toJsonSchema({ type: 'string', enum: ['a'], nullable: true })).toEqual({ type: ['string', 'null'], enum: ['a', null] });
    expect(toJsonSchema({ nullable: true, description: 'any' })).toEqual({ anyOf: [{ description: 'any' }, { type: 'null' }] });
    expect(toJsonSchema({ type: ['string', 'integer'], nullable: true })).toEqual({ type: ['string', 'integer', 'null'] });
  });

  it('drops what only OpenAPI understands, or what would reject a value the gateway really sends', () => {
    const out = toJsonSchema({ type: 'string', format: 'date-time', example: 'x', default: 'y', deprecated: true, 'x-internal': 1, readOnly: true, title: 'T', description: 'kept' });
    expect(out).toEqual({ type: 'string', description: 'kept' });
  });

  it('keeps structure: properties, required, items, closed objects, combinators and enums', () => {
    const s = { type: 'object', required: ['a'], additionalProperties: false, properties: { a: { type: 'array', items: { oneOf: [{ type: 'string' }, { type: 'integer', nullable: true }] } }, b: { type: 'string', enum: ['x', 'y'] } } };
    expect(toJsonSchema(s)).toEqual({
      type: 'object', required: ['a'], additionalProperties: false,
      properties: { a: { type: 'array', items: { oneOf: [{ type: 'string' }, { type: ['integer', 'null'] }] } }, b: { type: 'string', enum: ['x', 'y'] } },
    });
  });

  it('follows a $ref and refuses a missing or recursive one rather than emitting a dangling reference', () => {
    const comps = { Id: { type: 'string', nullable: true }, Node: { type: 'object', properties: { next: { $ref: '#/components/schemas/Node' } } } };
    expect(toJsonSchema({ $ref: '#/components/schemas/Id' }, comps)).toEqual({ type: ['string', 'null'] });
    expect(() => toJsonSchema({ $ref: '#/components/schemas/Nope' }, comps)).toThrow(/unresolved/);
    expect(() => toJsonSchema({ $ref: '#/components/schemas/Node' }, comps)).toThrow(/recursive/);
  });

  it('finds the first documented JSON success response, and nothing for a 204', () => {
    expect(successSchemaOf(SPEC, 'GET /v1/transaction/{id}')).toBeDefined();
    expect(successSchemaOf(SPEC, 'DELETE /v1/admin/api-keys/{id}')).toBeUndefined();
    expect(successSchemaOf(SPEC, 'GET /v1/nope')).toBeUndefined();
  });
});

describe('the generated schemas', () => {
  const toolsSource = readFileSync(join(ROOT, 'packages', 'mcp', 'src', 'tools.ts'), 'utf8');

  it('are exactly what the generator emits now (npm run agentgen rewrites the file; agentgen:check fails when it is stale)', () => {
    const emitted = emitMcpOutputSchemas({ spec: SPEC, toolsSource }) as string;
    expect(readFileSync(join(ROOT, 'packages', 'mcp', 'src', 'output-schemas.generated.ts'), 'utf8')).toBe(emitted);
  });

  it('are the converted response schema of the tool\'s own endpoint, with only the declared additions', () => {
    for (const [name, schema] of Object.entries(GENERATED_OUTPUT_SCHEMAS)) {
      const endpoint = new RegExp(`name: '${name}'[\\s\\S]*?endpoint: '([A-Z]+ /[^']*)'`).exec(toolsSource)![1];
      const expected = toJsonSchema(successSchemaOf(SPEC, endpoint), SPEC.components?.schemas ?? {});
      const ext = (EXTENDED_TOOLS as Record<string, { add: Record<string, unknown>; required: string[] }>)[name];
      if (ext) {
        expect((schema as { properties: object }).properties).toEqual({ ...expected.properties, ...ext.add });
        expect((schema as { required: string[] }).required).toEqual([...new Set([...(expected.required ?? []), ...ext.required])]);
      } else {
        expect(schema, name).toEqual(expected);
      }
    }
  });

  it('refuse to be generated for a tool with no documented object response, instead of leaving it without a schema', () => {
    const noSchemaSpec = { ...SPEC, paths: { ...SPEC.paths, '/v1/identity/{id}': { get: { responses: { 200: { description: 'ok' } } } } } };
    expect(() => emitMcpOutputSchemas({ spec: noSchemaSpec, toolsSource })).toThrow(/certen_identity_get: GET \/v1\/identity\/\{id\} documents no JSON success response/);
  });

  it('lists as custom exactly the tools whose result the tool builds', () => {
    expect([...CUSTOM_TOOLS].sort()).toEqual([
      'certen_admin_revoke_api_key', 'certen_billing_verify_receipt', 'certen_chains_enabled', 'certen_doctor', 'certen_identity_create',
      'certen_proof_get', 'certen_proof_verify', 'certen_whoami',
    ]);
  });
});
