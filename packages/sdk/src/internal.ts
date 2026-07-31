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
