/**
 * Readers for untrusted JSON that behave as Go's encoding/json does when it decodes into a struct: a key matches a field by its exact
 * name or, failing that, case-insensitively; an unknown key is ignored; a value of the wrong JSON type is an error; null leaves a
 * non-pointer field at its zero value; a slice is nil (absent or null) or a, possibly empty, list. Every proof document is read through
 * these, so a document that Go refuses to decode is refused here for the same reason, and one it accepts is accepted.
 */
import { VerifyError } from '../proof-v2/bytes.js';

export type Rec = Record<string, unknown>;

/** A JSON decoding error (Go: *json.UnmarshalTypeError, *json.SyntaxError): a plain refusal. */
export class JsonError extends VerifyError {}

const bad = (m: string): never => {
  throw new JsonError(m);
};

/** The JSON type name Go's UnmarshalTypeError reports. */
function typeName(v: unknown): string {
  if (v === null) return 'null';
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

/** strings.EqualFold for the ASCII-and-folding Go uses to match a JSON key to a field name. */
function foldEq(a: string, b: string): boolean {
  return a.length === b.length && a.toLowerCase() === b.toLowerCase();
}

/**
 * Decode a JSON object into a struct with the given field names: the value each field holds after all keys are processed in order
 * (a later key overrides an earlier one). Absent and null both give undefined. A non-object is an error.
 */
export function struct(v: unknown, fields: readonly string[], what: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (v === undefined || v === null) return out;
  if (typeof v !== 'object' || Array.isArray(v)) bad(`json: cannot unmarshal ${typeName(v)} into Go value of type ${what}`);
  for (const [k, val] of Object.entries(v as Rec)) {
    const f = fields.find((x) => x === k) ?? fields.find((x) => foldEq(x, k));
    if (f !== undefined) out[f] = val;
  }
  return out;
}

export function str(v: unknown, what: string): string {
  if (v === undefined || v === null) return '';
  if (typeof v !== 'string') bad(`json: cannot unmarshal ${typeName(v)} into Go struct field ${what} of type string`);
  return v as string;
}

/** A uint64: a whole non-negative number (a double holds the values a proof carries exactly). */
export function u64(v: unknown, what: string): number {
  if (v === undefined || v === null) return 0;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || Object.is(v, -0)) bad(`json: cannot unmarshal ${typeof v === 'number' ? 'number ' + String(v) : typeName(v)} into Go struct field ${what} of type uint64`);
  return v as number;
}

export function bool(v: unknown, what: string): boolean {
  if (v === undefined || v === null) return false;
  if (typeof v !== 'boolean') bad(`json: cannot unmarshal ${typeName(v)} into Go struct field ${what} of type bool`);
  return v as boolean;
}

/** A slice: undefined is Go's nil slice (absent or null), otherwise the elements (possibly none). */
export function list(v: unknown, what: string): unknown[] | undefined {
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v)) bad(`json: cannot unmarshal ${typeName(v)} into Go struct field ${what} of type slice`);
  return v as unknown[];
}

/** A map[string]T: undefined is nil. */
export function map(v: unknown, what: string): Rec | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'object' || Array.isArray(v)) bad(`json: cannot unmarshal ${typeName(v)} into Go struct field ${what} of type map`);
  return v as Rec;
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
