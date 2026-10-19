/**
 * Go's encoding/json for the shapes of a certificate's proof v2, in both directions: a strict parser that keeps number literals and the order
 * of keys (Go decodes a document key by key), a schema-driven decode into a struct (the rules of json.Unmarshal: case-insensitive key
 * matching, unknown keys ignored, null a no-op, a wrongly typed value an error) and the matching json.Marshal (field order, omitempty,
 * HTML-safe escapes). The consensus decode of a certificate's evidence (pkg/proof/v2 evidence_decode.go) and the offline judgements are
 * defined by exactly what these two do, so they are reproduced rather than approximated.
 */
import { VerifyError } from '../proof-v2/bytes.js';
import { goJsonString } from './budget.js';
import { foldEqual } from './fold.js';
import { JsonError } from './gojson.js';

// --------------------------------------------------------------------------------------------------------------------------------
// the parser

/** A JSON number as written: Go reads an integer field from the literal, so the literal is what is kept. */
export class JNum {
  constructor(readonly lit: string) {}
}
export class JObj {
  constructor(readonly pairs: [string, JVal][]) {}
}
export type JVal = null | boolean | string | JNum | JVal[] | JObj;

const WS = new Set([0x20, 0x09, 0x0a, 0x0d]);

/**
 * The string Go's unquote makes of raw bytes: a valid UTF-8 sequence is itself, each byte that is not part of one becomes its own U+FFFD
 * (utf8.DecodeRune reports width 1 for it; TextDecoder replaces a whole maximal subpart by one).
 */
export function decodeGoUtf8(b: readonly number[]): string {
  let out = '';
  for (let i = 0; i < b.length; ) {
    const c = b[i]!;
    let n = 0;
    let cp = 0;
    const cont = (k: number, lo = 0x80, hi = 0xbf): boolean => i + k < b.length && b[i + k]! >= lo && b[i + k]! <= hi;
    if (c < 0x80) {
      n = 1;
      cp = c;
    } else if (c >= 0xc2 && c <= 0xdf && cont(1)) {
      n = 2;
      cp = ((c & 0x1f) << 6) | (b[i + 1]! & 0x3f);
    } else if (c >= 0xe0 && c <= 0xef && cont(1, c === 0xe0 ? 0xa0 : 0x80, c === 0xed ? 0x9f : 0xbf) && cont(2)) {
      n = 3;
      cp = ((c & 0x0f) << 12) | ((b[i + 1]! & 0x3f) << 6) | (b[i + 2]! & 0x3f);
    } else if (c >= 0xf0 && c <= 0xf4 && cont(1, c === 0xf0 ? 0x90 : 0x80, c === 0xf4 ? 0x8f : 0xbf) && cont(2) && cont(3)) {
      n = 4;
      cp = ((c & 0x07) << 18) | ((b[i + 1]! & 0x3f) << 12) | ((b[i + 2]! & 0x3f) << 6) | (b[i + 3]! & 0x3f);
    }
    if (n === 0) {
      out += String.fromCharCode(0xfffd);
      i++;
    } else {
      out += String.fromCodePoint(cp);
      i += n;
    }
  }
  return out;
}

/** encoding/json's quoteChar: the byte as a rune, quoted by strconv.Quote with single quotes. */
export function quoteChar(c: number): string {
  const bs = String.fromCharCode(92);
  if (c === 0x27) return `'${bs}''`;
  if (c === 0x22) return `'"'`;
  const esc: Record<number, string> = { 7: 'a', 8: 'b', 9: 't', 10: 'n', 11: 'v', 12: 'f', 13: 'r', 0x5c: bs };
  if (esc[c] !== undefined) return `'${bs}${esc[c]}'`;
  if (c < 0x20 || c === 0x7f) return `'${bs}x${c.toString(16).padStart(2, '0')}'`;
  if (c >= 0x80 && (c <= 0xa0 || c === 0xad)) return `'${bs}u${c.toString(16).padStart(4, '0')}'`;
  return `'${String.fromCharCode(c)}'`;
}

/** encoding/json's maxNestingDepth: the containers the scanner json.Unmarshal uses allows open at once. */
export const GO_JSON_MAX_DEPTH = 10000;

export interface ParseGoJsonOptions {
  /** Containers allowed open at once; `Number.POSITIVE_INFINITY` for none. Default GO_JSON_MAX_DEPTH. */
  maxDepth?: number;
}

/**
 * encoding/json's syntax: RFC 8259, nothing else; invalid UTF-8 in a string is read as U+FFFD.
 *
 * `escaped`, when given, records which string values were written with an escape in their source text: for each object
 * (keyed by its `pairs` array) and each array, the set of indices whose value is such a string. A Go type that reads its
 * raw JSON token instead of the unescaped string (go-ethereum's hexutil.Bytes, common.Hash, common.Address) judges that
 * text, not the string, so a verifier mirroring it needs to know. Without it the parse is unchanged.
 *
 * `opts.maxDepth` is the number of containers that may be open at once (default GO_JSON_MAX_DEPTH, json.Unmarshal's own limit, which
 * every caller whose Go side is json.Unmarshal keeps); a document nested deeper is `exceeded max depth`. A caller whose Go side
 * reads the document with a json.Decoder.Token() pass, which has no limit (the S6 evidence, replaydecode.go parseJSONValue), passes
 * `Number.POSITIVE_INFINITY`: the parse is iterative, so any depth is read, never a stack overflow.
 */
export function parseGoJson(input: Uint8Array | string, escaped?: WeakMap<object, Set<number>>, opts?: ParseGoJsonOptions): JVal {
  const maxDepth = opts?.maxDepth ?? GO_JSON_MAX_DEPTH;
  const b = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  let i = 0;
  const bad = (what: string): never => {
    if (i >= b.length) throw new JsonError('unexpected end of JSON input');
    throw new JsonError(`invalid character ${quoteChar(b[i]!)} ${what}`);
  };
  const ws = (): void => {
    while (i < b.length && WS.has(b[i]!)) i++;
  };
  const lit = (word: string, v: JVal): JVal => {
    for (let k = 0; k < word.length; k++) {
      if (b[i] !== word.charCodeAt(k)) bad(`in literal ${word} (expecting ${JSON.stringify(word[k])})`);
      i++;
    }
    return v;
  };
  const hex4 = (): number => {
    let v = 0;
    for (let k = 0; k < 4; k++) {
      const c = b[i];
      let d: number;
      if (c !== undefined && c >= 0x30 && c <= 0x39) d = c - 0x30;
      else if (c !== undefined && c >= 0x41 && c <= 0x46) d = c - 0x41 + 10;
      else if (c !== undefined && c >= 0x61 && c <= 0x66) d = c - 0x61 + 10;
      else return bad('in \\u hexadecimal character escape');
      v = v * 16 + d;
      i++;
    }
    return v;
  };
  let sawEscape = false;
  const str = (): string => {
    i++; // the opening quote
    sawEscape = false;
    const bytes: number[] = [];
    let out = '';
    const flush = (): void => {
      if (bytes.length > 0) {
        out += decodeGoUtf8(bytes);
        bytes.length = 0;
      }
    };
    for (;;) {
      if (i >= b.length) bad('');
      const c = b[i]!;
      if (c === 0x22) {
        i++;
        flush();
        return out;
      }
      if (c < 0x20) bad('in string literal');
      if (c === 0x5c) {
        sawEscape = true;
        i++;
        const e = b[i];
        flush();
        switch (e) {
          case 0x22: out += '"'; i++; break;
          case 0x5c: out += '\\'; i++; break;
          case 0x2f: out += '/'; i++; break;
          case 0x62: out += '\b'; i++; break;
          case 0x66: out += '\f'; i++; break;
          case 0x6e: out += '\n'; i++; break;
          case 0x72: out += '\r'; i++; break;
          case 0x74: out += '\t'; i++; break;
          case 0x75: {
            i++;
            let r = hex4();
            if (r >= 0xd800 && r < 0xdc00) {
              // a high surrogate pairs with a following \u low surrogate; alone it is U+FFFD
              if (b[i] === 0x5c && b[i + 1] === 0x75) {
                const save = i;
                i += 2;
                const r2 = hex4();
                if (r2 >= 0xdc00 && r2 < 0xe000) r = 0x10000 + ((r - 0xd800) << 10) + (r2 - 0xdc00);
                else {
                  i = save;
                  r = 0xfffd;
                }
              } else r = 0xfffd;
            } else if (r >= 0xdc00 && r < 0xe000) r = 0xfffd;
            out += String.fromCodePoint(r);
            break;
          }
          default:
            bad('in string escape code');
        }
        continue;
      }
      bytes.push(c);
      i++;
    }
  };
  const num = (): JNum => {
    const start = i;
    if (b[i] === 0x2d) i++;
    if (b[i] === 0x30) i++;
    else if (b[i] !== undefined && b[i]! >= 0x31 && b[i]! <= 0x39) {
      while (b[i] !== undefined && b[i]! >= 0x30 && b[i]! <= 0x39) i++;
    } else bad('in numeric literal');
    if (b[i] === 0x2e) {
      i++;
      if (!(b[i] !== undefined && b[i]! >= 0x30 && b[i]! <= 0x39)) bad('after decimal point in numeric literal');
      while (b[i] !== undefined && b[i]! >= 0x30 && b[i]! <= 0x39) i++;
    }
    if (b[i] === 0x65 || b[i] === 0x45) {
      i++;
      if (b[i] === 0x2b || b[i] === 0x2d) i++;
      if (!(b[i] !== undefined && b[i]! >= 0x30 && b[i]! <= 0x39)) bad('in exponent of numeric literal');
      while (b[i] !== undefined && b[i]! >= 0x30 && b[i]! <= 0x39) i++;
    }
    return new JNum(new TextDecoder().decode(b.subarray(start, i)));
  };
  /** One value, with an explicit stack: a document nested to the limit (Go's 10000 containers by default) is read, not a stack overflow. */
  type Frame = { obj: true; pairs: [string, JVal][]; key: string } | { obj: false; arr: JVal[] };
  const parseValue = (): JVal => {
    const stack: Frame[] = [];
    for (;;) {
      // begin a value
      ws();
      if (i >= b.length) bad('');
      const c = b[i]!;
      let v: JVal;
      let vEscaped = false;
      if (c === 0x7b) {
        if (stack.length >= maxDepth) bad('exceeded max depth');
        i++;
        ws();
        if (b[i] === 0x7d) {
          i++;
          v = new JObj([]);
        } else {
          if (b[i] !== 0x22) bad('looking for beginning of object key string');
          const k = str();
          ws();
          if (b[i] !== 0x3a) bad('after object key');
          i++;
          stack.push({ obj: true, pairs: [], key: k });
          continue;
        }
      } else if (c === 0x5b) {
        if (stack.length >= maxDepth) bad('exceeded max depth');
        i++;
        ws();
        if (b[i] === 0x5d) {
          i++;
          v = [];
        } else {
          stack.push({ obj: false, arr: [] });
          continue;
        }
      } else if (c === 0x22) {
        v = str();
        vEscaped = sawEscape;
      }
      else if (c === 0x74) v = lit('true', true);
      else if (c === 0x66) v = lit('false', false);
      else if (c === 0x6e) v = lit('null', null);
      else if (c === 0x2d || (c >= 0x30 && c <= 0x39)) v = num();
      else return bad('looking for beginning of value');
      // a value is complete: attach it to its container and close every container it ends
      const noteEscaped = (container: object, index: number): void => {
        if (vEscaped && escaped !== undefined) {
          let set = escaped.get(container);
          if (set === undefined) escaped.set(container, (set = new Set()));
          set.add(index);
        }
        vEscaped = false;
      };
      for (;;) {
        const f = stack[stack.length - 1];
        if (f === undefined) return v;
        if (f.obj) {
          f.pairs.push([f.key, v]);
          noteEscaped(f.pairs, f.pairs.length - 1);
          ws();
          if (b[i] === 0x2c) {
            i++;
            ws();
            if (b[i] !== 0x22) bad('looking for beginning of object key string');
            f.key = str();
            ws();
            if (b[i] !== 0x3a) bad('after object key');
            i++;
            break;
          }
          if (b[i] === 0x7d) {
            i++;
            stack.pop();
            v = new JObj(f.pairs);
            continue;
          }
          bad('after object key:value pair');
        } else {
          f.arr.push(v);
          noteEscaped(f.arr, f.arr.length - 1);
          ws();
          if (b[i] === 0x2c) {
            i++;
            break;
          }
          if (b[i] === 0x5d) {
            i++;
            stack.pop();
            v = f.arr;
            continue;
          }
          bad('after array element');
        }
      }
    }
  };
  const v = parseValue();
  ws();
  if (i < b.length) bad('after top-level value');
  return v;
}

// --------------------------------------------------------------------------------------------------------------------------------
// schemas

/** A Go type of the proof's JSON: scalars, a nullable string, a raw value, slices, maps, structs and pointers to structs. */
export type Sch = 'string' | 'strptr' | 'u64' | 'i64' | 'vote' | 'bool' | 'raw' | { list: Sch } | { map: Sch } | { struct: StructDef } | { ptr: StructDef };
export interface FieldDef {
  /** The Go field name (the key of the decoded value). */
  name: string;
  json: string;
  sch: Sch;
  omitempty?: boolean;
}
export type StructDef = FieldDef[];

/** A decoded Go value: strings, bigints, booleans, nil as null, slices, maps and structs by Go field name. */
/** A json.RawMessage: the value as the document wrote it (undefined: the member was absent). */
export class Raw {
  constructor(readonly v: JVal | undefined) {}
}

export type GoVal = string | bigint | boolean | null | Raw | GoVal[] | Map<string, GoVal> | { [field: string]: GoVal };

const typeOf = (v: JVal): string => (v === null ? 'null' : typeof v === 'string' ? 'string' : typeof v === 'boolean' ? 'bool' : v instanceof JNum ? 'number' : Array.isArray(v) ? 'array' : 'object');

function mismatch(v: JVal, want: string, label: string): never {
  throw new JsonError(`json: cannot unmarshal ${typeOf(v)} into Go struct field ${label} of type ${want}`);
}

function isStruct(s: Sch): s is { struct: StructDef } {
  return typeof s === 'object' && 'struct' in s;
}
function isPtr(s: Sch): s is { ptr: StructDef } {
  return typeof s === 'object' && 'ptr' in s;
}

/** The backing array of a decoded slice (the slots past its length still hold what an earlier, longer array decoded into them). */
const BACKING: unique symbol = Symbol('goBacking');
function withStore(out: GoVal[], store: GoVal[]): GoVal[] {
  Object.defineProperty(out, BACKING, { value: store, enumerable: false });
  return out;
}

/** The zero Go value of a schema. */
export function zero(s: Sch): GoVal {
  if (s === 'string') return '';
  if (s === 'strptr') return null;
  if (s === 'u64' || s === 'i64' || s === 'vote') return 0n;
  if (s === 'bool') return false;
  if (s === 'raw') return new Raw(undefined);
  if (isStruct(s)) return zeroStruct(s.struct);
  return null; // slices, maps and pointers are nil
}
function zeroStruct(def: StructDef): { [field: string]: GoVal } {
  const o: { [field: string]: GoVal } = {};
  for (const f of def) o[f.name] = zero(f.sch);
  return o;
}

const U64_MAX = (1n << 64n) - 1n;
const I64_MAX = (1n << 63n) - 1n;

/** decode one JSON value into the schema's Go value; `into` is the value already there (struct decoding merges into it). */
export function decodeVal(s: Sch, v: JVal, label: string, into?: GoVal): GoVal {
  if (s === 'raw') return new Raw(v);
  if (s === 'string') {
    if (v === null) return (into as string | undefined) ?? '';
    if (typeof v !== 'string') mismatch(v, 'string', label);
    return v as string;
  }
  if (s === 'strptr') {
    if (v === null) return null;
    if (typeof v !== 'string') mismatch(v, '*string', label);
    return v as string;
  }
  if (s === 'u64') {
    if (v === null) return (into as bigint | undefined) ?? 0n;
    if (!(v instanceof JNum) || !/^[0-9]+$/.test(v.lit)) mismatch(v, 'uint64', label);
    const n = BigInt((v as JNum).lit);
    if (n > U64_MAX) throw new JsonError(`json: cannot unmarshal number ${(v as JNum).lit} into Go struct field ${label} of type uint64`);
    return n;
  }
  if (s === 'i64') {
    if (v === null) return (into as bigint | undefined) ?? 0n;
    if (!(v instanceof JNum) || !/^-?[0-9]+$/.test(v.lit)) mismatch(v, 'int64', label);
    const n = BigInt((v as JNum).lit);
    if (n > I64_MAX || n < -I64_MAX - 1n) throw new JsonError(`json: cannot unmarshal number ${(v as JNum).lit} into Go struct field ${label} of type int64`);
    return n;
  }
  if (s === 'vote') {
    // protocol.VoteType.UnmarshalJSON: a name, case-insensitively; it is called for null too, which is not a name.
    if (typeof v !== 'string') throw new JsonError(`json: cannot unmarshal ${typeOf(v)} into Go value of type string`);
    const i = ['accept', 'reject', 'abstain', 'suggest'].indexOf((v as string).toLowerCase());
    if (i < 0) throw new JsonError(`invalid Vote Type ${JSON.stringify(v)}`);
    return BigInt(i);
  }
  if (s === 'bool') {
    if (v === null) return (into as boolean | undefined) ?? false;
    if (typeof v !== 'boolean') mismatch(v, 'bool', label);
    return v as boolean;
  }
  if ('list' in s) {
    if (v === null) return null;
    if (!Array.isArray(v)) mismatch(v, 'slice', label);
    // encoding/json decode.go array: an array is decoded INTO the slice already there, slot by slot - a slot keeps what was decoded into it before (a struct its members,
    // a string its value when the new one is null), the length becomes the array's, and the slots beyond it are not cleared (Go's backing array: a later longer array
    // decodes into what an earlier longer one left there). An empty array allocates a new empty slice and keeps nothing. RB9-F6 review V-Q D1.
    if ((v as JVal[]).length === 0) return withStore([], []);
    const store: GoVal[] = (Array.isArray(into) && (into as { [BACKING]?: GoVal[] })[BACKING]) || (Array.isArray(into) ? (into as GoVal[]).slice() : []);
    (v as JVal[]).forEach((e, i) => {
      store[i] = decodeVal(s.list, e, `${label}[${i}]`, i < store.length ? store[i] : zero(s.list));
    });
    return withStore(store.slice(0, (v as JVal[]).length), store);
  }
  if ('map' in s) {
    if (v === null) return null;
    if (!(v instanceof JObj)) mismatch(v, 'map', label);
    // json.Unmarshal reuses a map that is not nil: a later object adds its keys (each decoded into a fresh element) and drops none
    const m = into instanceof Map ? (into as Map<string, GoVal>) : new Map<string, GoVal>();
    for (const [k, e] of (v as JObj).pairs) m.set(k, decodeVal(s.map, e, `${label}.${k}`, zero(s.map)));
    return m;
  }
  const def = isStruct(s) ? s.struct : s.ptr;
  if (v === null) return isPtr(s) ? null : ((into as GoVal | undefined) ?? zeroStruct(def));
  if (!(v instanceof JObj)) mismatch(v, 'struct', label);
  const out: { [field: string]: GoVal } = into && typeof into === 'object' && !Array.isArray(into) && !(into instanceof Map) ? (into as { [field: string]: GoVal }) : zeroStruct(def);
  for (const [k, e] of (v as JObj).pairs) {
    const f = def.find((x) => x.json === k) ?? def.find((x) => foldEqual(x.json, k));
    if (!f) continue;
    out[f.name] = decodeVal(f.sch, e, `${label}.${f.name}`, out[f.name]);
  }
  return out;
}

// --------------------------------------------------------------------------------------------------------------------------------
// marshal

const isEmpty = (s: Sch, v: GoVal): boolean => {
  if (s === 'string') return v === '';
  if (s === 'u64' || s === 'i64' || s === 'vote') return v === 0n;
  if (s === 'bool') return v === false;
  if (s === 'strptr') return v === null;
  if (typeof s === 'object' && ('list' in s || 'map' in s)) return v === null || (Array.isArray(v) ? v.length === 0 : v instanceof Map && v.size === 0);
  if (isPtr(s)) return v === null;
  return false; // a struct is never omitted
};

/** json.Marshal of a decoded value: field order, omitempty, nil slices and maps as null, map keys sorted bytewise. */
export function marshalVal(s: Sch, v: GoVal): string {
  if (s === 'raw') throw new JsonError('a raw message is not marshalled by this port');
  if (s === 'string') return goJsonString(v as string);
  if (s === 'strptr') return v === null ? 'null' : goJsonString(v as string);
  if (s === 'u64' || s === 'i64') return (v as bigint).toString();
  if (s === 'vote') return goJsonString(['accept', 'reject', 'abstain', 'suggest'][Number(v as bigint)] ?? `VoteType:${v}`);
  if (s === 'bool') return v ? 'true' : 'false';
  if ('list' in s) return v === null ? 'null' : `[${(v as GoVal[]).map((e) => marshalVal(s.list, e)).join(',')}]`;
  if ('map' in s) {
    if (v === null) return 'null';
    const keys = [...(v as Map<string, GoVal>).keys()].sort((a, b) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8')));
    return `{${keys.map((k) => `${goJsonString(k)}:${marshalVal(s.map, (v as Map<string, GoVal>).get(k)!)}`).join(',')}}`;
  }
  const def = isStruct(s) ? s.struct : s.ptr;
  if (isPtr(s) && v === null) return 'null';
  const o = v as { [field: string]: GoVal };
  const parts: string[] = [];
  for (const f of def) {
    const fv = o[f.name]!;
    if (f.omitempty && isEmpty(f.sch, fv)) continue;
    parts.push(`${goJsonString(f.json)}:${marshalVal(f.sch, fv)}`);
  }
  return `{${parts.join(',')}}`;
}

void VerifyError;
