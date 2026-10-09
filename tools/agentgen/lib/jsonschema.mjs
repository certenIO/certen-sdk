/**
 * OpenAPI 3.0 schema -> JSON Schema (2020-12), for the MCP tools' `outputSchema`.
 *
 * The gateway's response schemas are the ones Fastify serialises its replies with, so a body that came out of the gateway conforms to
 * them. This keeps what describes the SHAPE of a value (types, properties, required, items, enums, combinators, closed objects) and
 * the human description, and drops what only OpenAPI understands or what would make a conforming value fail validation:
 *
 *   - `nullable: true` becomes a union with `null` (OpenAPI 3.0's spelling is not JSON Schema);
 *   - `format` is dropped: in 2020-12 it is an annotation, and a validator that asserts it (`date-time`, `uuid`) would refuse values
 *     the gateway legitimately sends in a slightly different spelling;
 *   - `example`, `examples`, `default`, `deprecated`, `readOnly`, `writeOnly`, `xml`, `externalDocs`, `discriminator` and `x-*` are dropped.
 *
 * A `$ref` is resolved against `components.schemas` (there are none in the vendored spec today; the converter handles them so the
 * day one appears it is followed rather than silently emitted as a dangling reference).
 */

const DROP = new Set([
  'format', 'example', 'examples', 'default', 'deprecated', 'readOnly', 'writeOnly', 'xml', 'externalDocs', 'discriminator',
  'nullable', '$ref', 'title',
]);

export function toJsonSchema(node, components = {}, seen = new Set()) {
  if (node === null || typeof node !== 'object') return node;
  if (Array.isArray(node)) return node.map((n) => toJsonSchema(n, components, seen));

  if (typeof node.$ref === 'string') {
    const name = node.$ref.replace(/^#\/components\/schemas\//, '');
    if (!components[name]) throw new Error(`unresolved $ref ${node.$ref}`);
    if (seen.has(name)) throw new Error(`recursive $ref ${node.$ref} cannot be inlined`);
    return toJsonSchema(components[name], components, new Set([...seen, name]));
  }

  const out = {};
  for (const [k, v] of Object.entries(node)) {
    if (DROP.has(k) || k.startsWith('x-')) continue;
    if (k === 'properties' && v && typeof v === 'object') {
      out.properties = Object.fromEntries(Object.entries(v).map(([p, s]) => [p, toJsonSchema(s, components, seen)]));
    } else if (k === 'items' || k === 'additionalProperties') {
      out[k] = typeof v === 'object' ? toJsonSchema(v, components, seen) : v;
    } else if (k === 'oneOf' || k === 'anyOf' || k === 'allOf') {
      out[k] = v.map((s) => toJsonSchema(s, components, seen));
    } else {
      out[k] = v;
    }
  }

  if (node.nullable === true) {
    if (typeof out.type === 'string') {
      out.type = [out.type, 'null'];
      if (Array.isArray(out.enum) && !out.enum.includes(null)) out.enum = [...out.enum, null];
    } else if (Array.isArray(out.type)) {
      if (!out.type.includes('null')) out.type = [...out.type, 'null'];
    } else {
      return { anyOf: [out, { type: 'null' }] };
    }
  }
  return out;
}

/** The first success response's JSON schema for `METHOD /path`, or undefined when the spec documents none. */
export function successSchemaOf(spec, endpoint) {
  const [method, path] = endpoint.split(' ');
  const op = spec.paths?.[path]?.[method.toLowerCase()];
  for (const status of ['200', '201', '202']) {
    const s = op?.responses?.[status]?.content?.['application/json']?.schema;
    if (s) return s;
  }
  return undefined;
}
