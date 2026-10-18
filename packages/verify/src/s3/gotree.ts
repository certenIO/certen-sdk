/**
 * A portable document from its TEXT, the way Go reads it. json.Unmarshal into Portable fixes what each member may be (a uint64 is a whole number
 * literal - 65.0, 6.5e1 and 2^64 are errors -, a string is a string, null leaves a value in place), takes duplicate and differently cased keys in
 * document order, and replaces invalid UTF-8 byte by byte; a tree from JSON.parse has already lost every one of those facts. This module
 * parses the text with the literal-preserving parser (jsonx.ts parseGoJson), decodes the document's own types with the schema of Portable
 * (portable-schema.ts), and gives the rest - the json.RawMessage members, which Go decodes later, type by type - as plain trees that keep what the
 * later readers need to decode them the same way:
 *
 *   - a whole-number literal of at most 2^53 is a number; any other literal is a BadNum, which keeps its text: Go reads no float anywhere in a
 *     proof, so a readers' integer decode refuses a BadNum that is not a whole number or does not fit the Go type, and reads the exact value
 *     of one that does (a uint64 above 2^53 inside an account, a receipt index, a sequence number: those are encoded exactly);
 *   - an object with a repeated key keeps its pairs in document order (PAIRS), so that every occurrence is decoded in turn, as Go does.
 */
import { decodeVal, JNum, parseGoJson, type Raw, type GoVal, type JVal, type Sch, type StructDef } from './jsonx.js';
import { BadNum, PAIRS } from './occ.js';
import { PORTABLE } from './portable-schema.js';

export { BadNum, PAIRS };


const MAX_EXACT = 1n << 53n;

function numberOf(lit: string): number | BadNum {
  if (/^-?(0|[1-9][0-9]*)$/.test(lit)) {
    const n = BigInt(lit);
    if (n >= -MAX_EXACT && n <= MAX_EXACT) return Number(lit);
  }
  return new BadNum(lit);
}

/** o[k] = v for any key, "__proto__" included (a plain assignment would set the prototype). */
function put(o: Record<string, unknown>, k: string, v: unknown): void {
  if (k === '__proto__') Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true });
  else o[k] = v;
}

/** A raw JSON value as a plain tree. */
export function rawTree(v: JVal): unknown {
  if (v === null || typeof v === 'boolean' || typeof v === 'string') return v;
  if (v instanceof JNum) return numberOf(v.lit);
  if (Array.isArray(v)) return v.map(rawTree);
  const o = {} as Record<string, unknown>;
  const seen = new Set<string>();
  let repeated = false;
  for (const [k, e] of v.pairs) {
    if (seen.has(k)) repeated = true;
    seen.add(k);
    put(o, k, rawTree(e));
  }
  if (repeated) Object.defineProperty(o, PAIRS, { value: v.pairs.map(([k, e]) => [k, rawTree(e)] as [string, unknown]), enumerable: false });
  return o;
}

/** The decoded Go value of a schema as a plain tree: JSON keys, nil as null, a raw member as its tree (absent: not there). */
export function toTree(s: Sch, v: GoVal): unknown {
  if (s === 'raw') {
    const r = v as Raw;
    return r.v === undefined ? undefined : rawTree(r.v);
  }
  if (s === 'string' || s === 'strptr' || s === 'bool') return v;
  // the members of Portable's own types are read as doubles (blocks, counts, positions: the values a chain of this size holds); the nearest
  // double of a uint64 above 2^53 compares as Go compares it against every value a verifier derives, and an exact value is only needed inside
  // the raw members, which keep their literals.
  if (s === 'u64' || s === 'i64' || s === 'vote') return Number(v as bigint);
  if (typeof s !== 'object') return v;
  if ('list' in s) return v === null ? null : (v as GoVal[]).map((e) => toTree(s.list, e));
  if ('map' in s) {
    if (v === null) return null;
    const o = {} as Record<string, unknown>;
    for (const [k, e] of v as Map<string, GoVal>) put(o, k, toTree(s.map, e));
    return o;
  }
  const def: StructDef = 'struct' in s ? s.struct : s.ptr;
  if ('ptr' in s && v === null) return null;
  const o = {} as Record<string, unknown>;
  for (const f of def) {
    const x = toTree(f.sch, (v as { [field: string]: GoVal })[f.name]!);
    if (x !== undefined) put(o, f.json, x);
  }
  return o;
}

/**
 * json.Unmarshal(text, &Portable) as a plain tree with exactly the keys of the type: a document Go refuses to decode is refused here for the
 * reason Go gives (a JsonError, a plain refusal).
 */
export function decodePortable(text: Uint8Array | string): Record<string, unknown> {
  const tree = parseGoJson(text);
  const val = decodeVal(PORTABLE, tree, 'Portable');
  return toTree(PORTABLE, val) as Record<string, unknown>;
}

