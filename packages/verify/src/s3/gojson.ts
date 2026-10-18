/**
 * Readers for untrusted JSON that behave as Go's encoding/json does when it decodes into a struct: a key matches a field by its exact
 * name or, failing that, case-insensitively; an unknown key is ignored; a value of the wrong JSON type is an error; null leaves a
 * non-pointer field at its zero value; a slice is nil (absent or null) or a, possibly empty, list. Every proof document is read through
 * these, so a document that Go refuses to decode is refused here for the same reason, and one it accepts is accepted.
 */
import { VerifyError } from '../proof-v2/bytes.js';
import { foldEqual } from './fold.js';
import { BadNum, isObject, mergedPairs, Occ, oneOf, pairsOf } from './occ.js';

export type Rec = Record<string, unknown>;

/** A JSON decoding error (Go: *json.UnmarshalTypeError, *json.SyntaxError): a plain refusal. */
export class JsonError extends VerifyError {}

const bad = (m: string): never => {
  throw new JsonError(m);
};

/** The JSON type name Go's UnmarshalTypeError reports. */
function typeName(v: unknown): string {
  if (v === null) return 'null';
  if (v instanceof BadNum) return 'number';
  if (Array.isArray(v)) return 'array';
  switch (typeof v) {
    case 'string':
      return 'string';
    case 'number':
      return 'number';
    case 'boolean':
      return 'bool';
    default:
      return 'object';
  }
}

/**
 * Decode a JSON object into a struct with the given field names. Keys are matched as encoding/json matches them (the exact name, else the
 * name under Go's simple case folding), unknown keys are ignored, and a field that occurs more than once keeps every occurrence in document
 * order (an Occ), which the readers below decode one after another as Go does. Absent and null both give undefined. A non-object is an error.
 */
export function struct(v: unknown, fields: readonly string[], what: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (v === undefined || v === null) return out;
  const pairs = mergedPairs(v);
  if (pairs === undefined) bad(`json: cannot unmarshal ${typeName(v)} into Go value of type ${what}`);
  const seen = new Map<string, unknown[]>();
  for (const [k, val] of pairs!) {
    const f = fields.find((x) => x === k) ?? fields.find((x) => foldEqual(x, k));
    if (f === undefined) continue;
    const l = seen.get(f);
    if (l) l.push(val);
    else seen.set(f, [val]);
  }
  for (const [f, vals] of seen) out[f] = oneOf(vals);
  return out;
}

/** Each occurrence of a member in turn: a null is the value Go leaves as it was (for a string, a number, a bool, a struct). */
function each(v: unknown, f: (x: unknown) => void): void {
  if (v instanceof Occ) for (const x of v.vals) f(x);
  else f(v);
}

export function str(v: unknown, what: string): string {
  let out = '';
  each(v, (x) => {
    if (x === undefined || x === null) return;
    if (typeof x !== 'string') bad(`json: cannot unmarshal ${typeName(x)} into Go struct field ${what} of type string`);
    out = x as string;
  });
  return out;
}

const U64_MAX = (1n << 64n) - 1n;
const I64_MAX = (1n << 63n) - 1n;

/** The exact integer a JSON number occurrence holds: a number, or a BadNum whose literal is a whole number; undefined for anything else. */
function wholeNumber(x: unknown): bigint | undefined {
  if (typeof x === 'number') return Number.isInteger(x) ? BigInt(x) : undefined;
  if (x instanceof BadNum && /^-?(0|[1-9][0-9]*)$/.test(x.text)) return BigInt(x.text);
  return undefined;
}

const numText = (x: unknown): string => (x instanceof BadNum ? 'number ' + x.text : typeof x === 'number' ? 'number ' + String(x) : typeName(x));

/** A uint64, exactly: a whole non-negative number literal that fits (strconv.ParseUint: "-0" does not). */
export function u64big(v: unknown, what: string): bigint {
  let out = 0n;
  each(v, (x) => {
    if (x === undefined || x === null) return;
    const n = wholeNumber(x);
    if (n === undefined || n < 0n || n > U64_MAX || Object.is(x, -0)) bad(`json: cannot unmarshal ${numText(x)} into Go struct field ${what} of type uint64`);
    out = n!;
  });
  return out;
}

/** A uint64 as a double (the nearest, above 2^53). */
export function u64(v: unknown, what: string): number {
  return Number(u64big(v, what));
}

export function bool(v: unknown, what: string): boolean {
  let out = false;
  each(v, (x) => {
    if (x === undefined || x === null) return;
    if (typeof x !== 'boolean') bad(`json: cannot unmarshal ${typeName(x)} into Go struct field ${what} of type bool`);
    out = x as boolean;
  });
  return out;
}

/** A slice: undefined is Go's nil slice (absent or null - a null after a list clears it), otherwise the elements (possibly none). */
export function list(v: unknown, what: string): unknown[] | undefined {
  let out: unknown[] | undefined;
  each(v, (x) => {
    if (x === undefined || x === null) {
      out = undefined;
      return;
    }
    if (!Array.isArray(x)) bad(`json: cannot unmarshal ${typeName(x)} into Go struct field ${what} of type slice`);
    out = x as unknown[];
  });
  return out;
}

/** A map[string]T: undefined is nil; the entries of every object occurrence are kept (a later one wins a key). */
export function map(v: unknown, what: string): Rec | undefined {
  let out: Rec | undefined;
  each(v, (x) => {
    if (x === undefined || x === null) {
      out = undefined;
      return;
    }
    if (!isObject(x)) bad(`json: cannot unmarshal ${typeName(x)} into Go struct field ${what} of type map`);
    out = { ...(out ?? {}) };
    for (const [k, e] of pairsOf(x as object)) out[k] = e;
  });
  return out;
}

/** A *string: undefined is nil (absent, or a null after the last string); every occurrence must be a string or null. */
export function strptr(v: unknown, what: string): string | undefined {
  let out: string | undefined;
  each(v, (x) => {
    if (x === undefined) return;
    if (x === null) {
      out = undefined;
      return;
    }
    if (typeof x !== 'string') bad(`json: cannot unmarshal ${typeName(x)} into Go struct field ${what} of type *string`);
    out = x as string;
  });
  return out;
}

/** An int64, exactly: a whole number literal (negative allowed; -0 reads as 0, as strconv.ParseInt reads it). */
export function i64big(v: unknown, what: string): bigint {
  let out = 0n;
  each(v, (x) => {
    if (x === undefined || x === null) return;
    const n = wholeNumber(x);
    if (n === undefined || n > I64_MAX || n < -I64_MAX - 1n) bad(`json: cannot unmarshal ${numText(x)} into Go struct field ${what} of type int64`);
    out = n!;
  });
  return out;
}

export function i64(v: unknown, what: string): number {
  return Number(i64big(v, what));
}

/** encoding.JsonList[T]: a list, or - failing that - a single value, which is a list of one; a null clears it, a later occurrence replaces an earlier one. */
export function jsonList(v: unknown, what: string): unknown[] | undefined {
  let out: unknown[] | undefined;
  each(v, (x) => {
    if (x === undefined) return;
    if (x === null) {
      out = undefined;
      return;
    }
    out = Array.isArray(x) ? x : [x];
  });
  void what;
  return out;
}

/** A []string: every element a string (null elements are the empty string). */
export function strList(v: unknown, what: string): string[] | undefined {
  const l = list(v, what);
  return l?.map((x, i) => str(x, `${what}[${i}]`));
}

/** hex.DecodeString: strict, even length. Undefined where Go returns an error. */
export function goHex(s: string): Uint8Array | undefined {
  if (s.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(s)) return undefined;
  return new Uint8Array(Buffer.from(s, 'hex'));
}

/** strconv.IsPrint for the code points a single byte can name (hex.InvalidByteError formats the byte as a rune). */
function isPrintByte(c: number): boolean {
  return (c >= 0x20 && c < 0x7f) || (c >= 0xa1 && c <= 0xff && c !== 0xad);
}

const hexVal = (c: number): number => (c >= 0x30 && c <= 0x39 ? c - 0x30 : c >= 0x61 && c <= 0x66 ? c - 0x61 + 10 : c >= 0x41 && c <= 0x46 ? c - 0x41 + 10 : 255);

/** The error hex.DecodeString returns for s (its message exactly), undefined when s is hex. */
export function goHexError(s: string): string | undefined {
  const b = Buffer.from(s, 'utf8');
  const invalid = (c: number): string => `encoding/hex: invalid byte: U+${c.toString(16).toUpperCase().padStart(4, '0')}${isPrintByte(c) ? ` '${String.fromCharCode(c)}'` : ''}`;
  let j = 1;
  for (; j < b.length; j += 2) {
    if (hexVal(b[j - 1]!) > 0x0f) return invalid(b[j - 1]!);
    if (hexVal(b[j]!) > 0x0f) return invalid(b[j]!);
  }
  if (b.length % 2 === 1) {
    if (hexVal(b[j - 1]!) > 0x0f) return invalid(b[j - 1]!);
    return 'encoding/hex: odd length hex string';
  }
  return undefined;
}
