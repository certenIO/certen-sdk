/**
 * Load the vendored gateway spec and flatten it into one operation model.
 *
 * The spec has no `operationId` and no `components.schemas` — every schema is inline. So the
 * operation id is synthesized from method + path, and type rendering has to walk the inline
 * schema rather than resolve a $ref.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from './paths.mjs';

export const SPEC_PATH = join(REPO_ROOT, 'spec', 'openapi.json');

const HTTP_METHODS = ['get', 'post', 'patch', 'put', 'delete'];

/** `/v1/identity/{id}` + POST -> `post:/v1/identity/{id}` — stable across spec refreshes. */
export function opId(method, path) {
  return `${method.toLowerCase()}:${path}`;
}

/**
 * Render an inline schema as a short type string. Deliberately shallow: an agent reading
 * llms-full.txt needs "is this a string or an array of objects", not a full JSON Schema dump.
 */
export function renderType(schema) {
  if (!schema || typeof schema !== 'object') return 'any';
  if (Array.isArray(schema.enum)) return schema.enum.map((v) => JSON.stringify(v)).join(' | ');
  if (schema.oneOf || schema.anyOf) {
    const variants = schema.oneOf ?? schema.anyOf;
    return variants.map(renderType).join(' | ');
  }
  switch (schema.type) {
    case 'array':
      return `${renderType(schema.items)}[]`;
    case 'object': {
      const keys = Object.keys(schema.properties ?? {});
      if (keys.length === 0) return schema.additionalProperties ? 'object' : 'object';
      return `{ ${keys.join(', ')} }`;
    }
    case undefined:
      return schema.properties ? `{ ${Object.keys(schema.properties).join(', ')} }` : 'any';
    default:
      return schema.type;
  }
}

/** Collapse a description to one line — the spec has multi-sentence prose with newlines. */
export function oneLine(text) {
  if (!text) return '';
  return String(text).replace(/\s+/g, ' ').trim();
}

/** Flatten a body schema's top-level properties into rows. */
function bodyFields(schema) {
  if (!schema?.properties) return [];
  const required = new Set(schema.required ?? []);
  return Object.entries(schema.properties).map(([name, sub]) => ({
    name,
    type: renderType(sub),
    required: required.has(name),
    description: oneLine(sub.description),
    // Nested one level: enough to show an agent the shape of `intent` or `signing_data`.
    children: sub.properties
      ? Object.entries(sub.properties).map(([k, v]) => ({
          name: k,
          type: renderType(v),
          description: oneLine(v.description),
        }))
      : [],
  }));
}

function responseFields(responses) {
  const out = [];
  for (const [code, r] of Object.entries(responses ?? {})) {
    if (!code.startsWith('2')) continue;
    const schema = r?.content?.['application/json']?.schema;
    const unwrapped = schema?.type === 'array' ? schema.items : schema;
    const props = unwrapped?.properties ? Object.keys(unwrapped.properties) : [];
    if (props.length === 0) continue;
    out.push({
      code,
      isArray: schema?.type === 'array',
      description: oneLine(r.description),
      fields: Object.entries(unwrapped.properties).map(([name, sub]) => ({
        name,
        type: renderType(sub),
        description: oneLine(sub.description),
      })),
    });
  }
  return out;
}

/**
 * Scopes are not in a `security` block — the gateway states them in prose, as
 * "Requires the `transaction:write` scope". Pull them out so the MCP write-tier gate and the
 * docs agree on which operations are privileged.
 */
function scopesFrom(description) {
  const found = new Set();
  for (const m of String(description ?? '').matchAll(/`([a-z]+:(?:read|write|admin))`/g)) {
    found.add(m[1]);
  }
  return [...found].sort();
}

export function loadSpec(specPath = SPEC_PATH) {
  return JSON.parse(readFileSync(specPath, 'utf8'));
}

/** The flat operation list every emitter works from. */
export function operations(spec) {
  const ops = [];
  for (const [path, methods] of Object.entries(spec.paths ?? {})) {
    for (const [method, op] of Object.entries(methods)) {
      if (!HTTP_METHODS.includes(method)) continue;
      const bodySchema = op.requestBody?.content?.['application/json']?.schema ?? {};
      const params = op.parameters ?? [];
      ops.push({
        id: opId(method, path),
        method: method.toUpperCase(),
        path,
        tag: op.tags?.[0] ?? 'Other',
        summary: oneLine(op.summary),
        description: oneLine(op.description),
        scopes: scopesFrom(op.description),
        body: bodyFields(bodySchema),
        query: params
          .filter((p) => p.in === 'query')
          .map((p) => ({
            name: p.name,
            type: renderType(p.schema),
            required: Boolean(p.required),
            description: oneLine(p.description),
          })),
        pathParams: params
          .filter((p) => p.in === 'path')
          .map((p) => ({ name: p.name, type: renderType(p.schema), description: oneLine(p.description) })),
        responses: responseFields(op.responses),
      });
    }
  }
  ops.sort((a, b) => a.id.localeCompare(b.id));
  return ops;
}
