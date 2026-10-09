import { CertenError } from './errors.js';

/**
 * Strip keys whose value is `undefined` before sending a body.
 *
 * Fastify validates against a declared schema and strips properties it does not know, but an explicit
 * `"field": null`-shaped absence is not the same as omission for an endpoint that treats presence as
 * intent — and a body full of `undefined` keys serialises to nothing useful when debugging a request log.
 * Building bodies through this keeps the wire payload exactly the set of fields the caller actually set.
 */
export function omitUndefined<T extends Record<string, unknown>>(o: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined) out[k] = v;
  return out as Partial<T>;
}

/**
 * Build a request path from a template, encoding every interpolated value as exactly ONE path segment.
 *
 *     apiPath`/v1/proof/${proofId}/bundle`
 *
 * Every id, hash and token reaching a url goes through here. Interpolating one raw let it change which route a call reached:
 * an id containing `/` or `?` added segments or a query, and an id of `..` or `.` is resolved away by any proxy or server that
 * normalises paths (`/v1/proof/../admin` is not `/v1/proof/<id>`). So:
 *
 * - `/`, `?`, `#`, `%`, spaces and every other reserved character are percent-encoded (`encodeURIComponent`);
 * - a value that is only dots (`.`, `..`) is REFUSED, not encoded: `encodeURIComponent` leaves it alone, and even as `%2E%2E` the url
 *   parser treats it as `..` (measured: a request for `/v1/transaction/%2E%2E` arrived as `/v1/`). No genuine id is made of dots;
 * - an empty, null or undefined value is REFUSED (`INVALID_PATH_PARAMETER`) rather than dropped: `identity.get('')` would otherwise
 *   request `/v1/identity/`, a different route, and answer with a list where a record was asked for.
 *
 * Only the interpolated values are encoded; the literal parts of the template are the route.
 */
export function apiPath(strings: TemplateStringsArray, ...values: unknown[]): string {
  let out = strings[0];
  values.forEach((v, i) => {
    out += segment(v, i + 1, strings) + strings[i + 1];
  });
  return out;
}

function segment(v: unknown, position: number, strings: TemplateStringsArray): string {
  const where = `${strings[position - 1].split('/').filter(Boolean).pop() ?? 'path'} parameter`;
  if (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'bigint') {
    throw new CertenError(`certen: ${where} must be a string or number, got ${v === null ? 'null' : typeof v}`, 0, 'INVALID_PATH_PARAMETER');
  }
  const s = String(v);
  if (s === '') throw new CertenError(`certen: ${where} is empty`, 0, 'INVALID_PATH_PARAMETER');
  let enc: string;
  try {
    enc = encodeURIComponent(s);
  } catch {
    throw new CertenError(`certen: ${where} is not valid text (a lone surrogate cannot be encoded)`, 0, 'INVALID_PATH_PARAMETER');
  }
  if (/^\.+$/.test(s)) throw new CertenError(`certen: ${where} cannot be "${s}": a path segment of dots would be resolved away by the url parser`, 0, 'INVALID_PATH_PARAMETER');
  return enc;
}
