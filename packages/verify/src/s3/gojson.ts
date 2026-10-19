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

/**
 * The refusal of a value that follows a JSON null in a member the generated UnmarshalJSON holds as *encoding.JsonUnmarshalWith[T] (a union: a transaction body,
 * a data entry, a signature, a message, ...) or *encoding.JsonUnmarshalListWith[T] (a list of a union: the key signatures of a minor-root record)
 * (pkg/types/encoding/json_list.go of accumulate v1.4.7-0.20260926030013-e1d1db9ebb7c). The pointer the decoder starts with carries the Func that decodes the
 * value; encoding/json sets that pointer to nil on a null and allocates a FRESH zero one for the next value, whose Func is nil, and its UnmarshalJSON calls the nil
 * Func and panics (a list calls it for its first element, so an empty list does not). Go's Import recovers from the panic and refuses the document as one
 * Accumulate's codec cannot decode; a null after the last value, which the objsweep corpus writes, only empties the member. Any value of any type counts: the
 * Func is called before the value is looked at.
 */
export function valueAfterNull(): never {
  throw new JsonError("a value Accumulate's codec cannot decode (a member it needs is null or absent)");
}

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

/**
 * What json.Unmarshal makes of several occurrences of a member that is a slice (encoding/json decode.go array): each array is decoded INTO the slice the earlier
 * occurrences left, element by element - a slot keeps what was decoded into it before (a struct its members, merged with the new ones; the occurrences of a slot are
 * an Occ), the length becomes the new array's, and the slots beyond it are not cleared, so a later longer array decodes into what an earlier longer one left there
 * (Go's backing array). An empty array allocates a new empty slice (nothing is kept), a null sets the slice to nil (nothing is kept either), and a JsonList's
 * single value allocates a new one-element slice. undefined: nil. RB9-F6 review V-Q D1.
 */
export function intoSlice(vals: readonly unknown[], single = false): unknown[] | undefined {
  let store: unknown[] = []; // the backing array: slot i holds what was decoded into it
  let len = 0;
  let isNil = true;
  for (const x of vals) {
    if (x === undefined) continue;
    if (x === null) {
      store = [];
      len = 0;
      isNil = true;
      continue;
    }
    const arr = Array.isArray(x);
    const els: unknown[] = arr ? (x as unknown[]) : [x];
    if (!arr && single) store = [];
    if (els.length === 0) {
      store = [];
      len = 0;
      isNil = false;
      continue;
    }
    for (let i = 0; i < els.length; i++) {
      const e = els[i];
      const old = store[i];
      // a struct element decoded again takes the new members on top of the old (an Occ, merged where it is read); any other element (a string, a number, a list) is
      // overwritten
      const structs = (isObject(old) || old instanceof Occ) && (isObject(e) || e instanceof Occ || e === null);
      store[i] = i >= store.length || !structs ? e : old instanceof Occ ? new Occ([...old.vals, e]) : new Occ([old, e]);
    }
    len = els.length;
    isNil = false;
  }
  return isNil ? undefined : store.slice(0, len);
}

/**
 * encoding.JsonUnmarshalListWith (a list of an interface type, decoded one element at a time by a function): a later list is written over the elements already read,
 * index by index, and never shortens what an earlier one made; a single value replaces the whole list and a null drops it. The elements are the raw values of the
 * last list that reached each index.
 */
export function overwriteList(vals: readonly unknown[]): unknown[] | undefined {
  let out: unknown[] | undefined;
  for (const x of vals) {
    if (x === undefined) continue;
    if (x === null) {
      out = undefined;
      continue;
    }
    const els = Array.isArray(x) ? (x as unknown[]) : [x];
    if (!Array.isArray(x)) {
      out = els;
      continue;
    }
    const next = out === undefined ? [] : out.slice();
    els.forEach((el, i) => {
      next[i] = el;
    });
    out = next;
  }
  return out;
}

/** A slice: undefined is Go's nil slice (absent or null - a null after a list clears it), otherwise the elements (possibly none; several occurrences: intoSlice). */
export function list(v: unknown, what: string): unknown[] | undefined {
  const vals = v instanceof Occ ? v.vals : [v];
  for (const x of vals) if (x !== undefined && x !== null && !Array.isArray(x)) bad(`json: cannot unmarshal ${typeName(x)} into Go struct field ${what} of type slice`);
  return intoSlice(vals);
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

/** encoding.JsonList[T]: a list, or - failing that - a single value, which is a list of one; a null clears it, a later list is decoded into the elements the earlier left (intoSlice). */
export function jsonList(v: unknown, what: string): unknown[] | undefined {
  void what;
  return intoSlice(v instanceof Occ ? v.vals : [v], true);
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
