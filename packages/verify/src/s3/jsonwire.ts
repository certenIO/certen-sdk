/**
 * Accumulate's JSON, read the way Go reads it, into the wire objects the binary encoder writes (validator portable.go Import:
 * protocol.UnmarshalAccountJSON, Transaction.UnmarshalJSON, the generated <Type>.UnmarshalJSON of every record, then MarshalBinary).
 *
 * A portable proof carries accounts, transactions, signatures and records as JSON, and every hash and receipt of the proof is over the
 * BINARY encoding Go produces from that JSON. A verifier must therefore produce the same bytes from the same JSON - and refuse the same
 * JSON - or its verdict about a document is a verdict about a different document. The SDK's own JSON constructors are lenient and strict in
 * other places than Go's; this module follows Go's, kind by kind, from Accumulate's class metadata (wire.ts) and the enum tables read from
 * Go (enum-names.ts):
 *
 *   - a key matches a field by its exact name or case-insensitively; an unknown key is ignored; null is a no-op;
 *   - a union value carries its type as a name (case-insensitive, aliases included) and is created as that type;
 *   - uint64/int64 are whole JSON numbers; strings are strings; hashes are hex of at least 32 bytes (the first 32 are kept); bytes are hex;
 *     big integers are base-10 strings; times are RFC 3339; URLs are parsed by Accumulate's parser;
 *   - a key page's `threshold` is the accept threshold when `acceptThreshold` is unset (both are decoded, so both are type-checked), and a
 *     key spec's `publicKey` is its hash when it carries no `publicKeyHash` (generated code, protocol/types_gen.go);
 *   - null is a no-op, except for an enum held by value: its UnmarshalJSON is called with null and refuses it.
 * Anything else is a plain refusal, as a json.Unmarshal error is in Go.
 */
import { canonicalAccTxId, canonicalAccUrl, binaryString } from '../sigtypes/gourl.js';
import {
  encodeNode,
  flatFields,
  hasClass,
  registryType,
  TimeValue,
  unionMember,
  type FieldDesc,
  type Value,
  type WireNode,
} from '../sigtypes/wire.js';
import { enumByName } from './enum-names.js';
import { goHex, JsonError } from './gojson.js';
import { BadNum, mergedPairs, Occ, occurrences } from './occ.js';

const bad = (m: string): never => {
  throw new JsonError(m);
};

const utf8 = (s: string): string => binaryString(new TextEncoder().encode(s));

/** The discriminator enum of each union (the table Go's <Union>JSON looks the type name up in). */
const UNION_ENUM: Readonly<Record<string, string>> = {
  Account: 'AccountType',
  TransactionBody: 'TransactionType',
  Signature: 'SignatureType',
  KeySignature: 'SignatureType',
  DataEntry: 'DataEntryType',
  KeyPageOperation: 'KeyPageOperationType',
  AccountAuthOperation: 'AccountAuthOperationType',
  NetworkMaintenanceOperation: 'NetworkMaintenanceOperationType',
  Message: 'MessageType',
};

/** The enum a non-discriminating field names. */
/** The struct-valued members the protocol's generated types hold by pointer (protocol.NetworkGlobals: FeeSchedule *FeeSchedule, Limits *NetworkLimits). */
const POINTER_STRUCTS: ReadonlySet<string> = new Set(['NetworkGlobals.feeSchedule', 'NetworkGlobals.limits']);

function enumOf(cls: string, field: string): string | undefined {
  if (field === 'vote') return 'VoteType';
  const k = `${cls}.${field}`;
  switch (k) {
    case 'KeyBook.bookType':
      return 'BookType';
    case 'ActivateProtocolVersion.version':
    case 'SystemLedger.executorVersion':
    case 'PartitionExecutorVersion.version':
      return 'ExecutorVersion';
    case 'HashLockOptions.hashAlgorithm':
      return 'HashAlgorithm';
    case 'UpdateAllowedKeyPageOperation.allow':
    case 'UpdateAllowedKeyPageOperation.deny':
      return 'TransactionType';
    case 'PartitionInfo.type':
    case 'PartitionExecutorVersion.type':
      return 'PartitionType';
  }
  return undefined;
}

const U64_MAX = (1n << 64n) - 1n;
const I64_MAX = (1n << 63n) - 1n;

/** The exact integer a JSON number holds: a number, or a BadNum whose literal is a whole number. */
function wholeNumber(x: unknown): bigint | undefined {
  if (typeof x === 'number') return Number.isInteger(x) ? BigInt(x) : undefined;
  if (x instanceof BadNum && /^-?(0|[1-9][0-9]*)$/.test(x.text)) return BigInt(x.text);
  return undefined;
}

function parseTime(s: string): TimeValue {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/.exec(s);
  if (!m) return bad(`parsing time ${JSON.stringify(s)} as "2006-01-02T15:04:05Z07:00": cannot parse`);
  const [, y, mo, d, h, mi, se, , tz] = m;
  const dt = new Date(0);
  dt.setUTCFullYear(Number(y), Number(mo) - 1, Number(d));
  dt.setUTCHours(Number(h), Number(mi), Number(se), 0);
  let secs = BigInt(Math.floor(dt.getTime() / 1000));
  if (tz !== 'Z') {
    const sign = tz![0] === '-' ? -1n : 1n;
    secs -= sign * (BigInt(Number(tz!.slice(1, 3))) * 3600n + BigInt(Number(tz!.slice(4, 6))) * 60n);
  }
  return new TimeValue(secs);
}

/** One scalar field of a Go struct, from its JSON value (null and absent are handled by the caller). */
function scalar(cls: string, d: FieldDesc, v: unknown, label: string): Value {
  switch (d.kind) {
    case 'uint': {
      const n = wholeNumber(v);
      if (n === undefined || n < 0n || n > U64_MAX || Object.is(v, -0)) return bad(`json: cannot unmarshal ${describe(v)} into Go struct field ${label} of type uint64`);
      return n;
    }
    case 'int': {
      const n = wholeNumber(v);
      if (n === undefined || n > I64_MAX || n < -I64_MAX - 1n) return bad(`json: cannot unmarshal ${describe(v)} into Go struct field ${label} of type int64`);
      return n;
    }
    case 'bool':
      if (typeof v !== 'boolean') return bad(`json: cannot unmarshal ${describe(v)} into Go struct field ${label} of type bool`);
      return v;
    case 'string':
      if (typeof v !== 'string') return bad(`json: cannot unmarshal ${describe(v)} into Go struct field ${label} of type string`);
      return utf8(v);
    case 'hash': {
      if (typeof v !== 'string') return bad(`json: cannot unmarshal ${describe(v)} into Go struct field ${label} of type string`);
      const b = goHex(v);
      if (!b) return bad(`error decoding ${d.name}: encoding/hex: invalid byte`);
      if (b.length < 32) return bad(`error decoding ${d.name}: not enough data`);
      return b.slice(0, 32);
    }
    case 'bytes': {
      if (typeof v !== 'string') return bad(`json: cannot unmarshal ${describe(v)} into Go struct field ${label} of type string`);
      const b = goHex(v);
      if (!b) return bad(`error decoding ${d.name}: encoding/hex: invalid byte`);
      return b;
    }
    case 'url':
    case 'txid': {
      if (typeof v !== 'string') return bad(`json: cannot unmarshal ${describe(v)} into Go struct field ${label} of type url`);
      const bin = utf8(v);
      const c = d.kind === 'url' ? canonicalAccUrl(bin) : canonicalAccTxId(bin);
      if (c === undefined) return bad(`${label}: ${JSON.stringify(v)} is not a ${d.kind}`);
      return c;
    }
    case 'time':
      if (typeof v !== 'string') return bad(`json: cannot unmarshal ${describe(v)} into Go struct field ${label} of type time.Time`);
      return parseTime(v);
    case 'bigint': {
      if (typeof v !== 'string' || !/^[+-]?[0-9]+$/.test(v)) return bad(`error decoding ${d.name}: invalid big integer string`);
      return BigInt(v);
    }
    case 'enum': {
      const table = enumOf(cls, d.name);
      // An enum-typed field with no names is a plain number in JSON (Fee, a uint64).
      if (!table) return scalar(cls, { ...d, kind: 'uint' }, v, label);
      if (typeof v !== 'string') return bad(`json: cannot unmarshal ${describe(v)} into Go value of type string`);
      const e = enumByName(table, v);
      if (e === undefined) return bad(`invalid ${table} ${JSON.stringify(v)}`);
      return BigInt(e);
    }
    default:
      return bad(`${label}: a ${d.kind} field is not read from JSON by this verifier`);
  }
}

function describe(v: unknown): string {
  if (v === null) return 'null';
  if (v instanceof BadNum) return 'number';
  if (Array.isArray(v)) return 'array';
  return typeof v === 'object' ? 'object' : typeof v === 'number' ? 'number' : typeof v;
}

/** The union member class for a type name; undefined where the name is not one of the union's. */
function memberOf(union: string, name: string): { cls: string; tag: bigint } | undefined {
  const table = UNION_ENUM[union];
  if (!table) return undefined;
  const tag = enumByName(table, name);
  if (tag === undefined) return undefined;
  try {
    return { cls: unionMember(union, BigInt(tag)), tag: BigInt(tag) };
  } catch {
    return undefined;
  }
}

/**
 * A union value from its JSON (Unmarshal<Union>JSON): the object's `type` names the member, which is then created and decoded. The result
 * is null for JSON null (Accumulate's nil).
 */
export function unionFromJson(union: string, j: unknown, label: string): WireNode | null {
  if (j === null) return null;
  const pairs = mergedPairs(j);
  if (pairs === undefined) return bad(`json: cannot unmarshal ${describe(j)} into Go value of type ${union}`);
  // json.Unmarshal(data, &struct{ Type <Enum> }): every occurrence of "type" is decoded, and a null or a non-name is the enum's error.
  let t: string | undefined;
  for (const x of occurrences(pairs, 'type')) {
    if (typeof x !== 'string') return bad(`json: cannot unmarshal ${describe(x)} into Go value of type string`);
    t = x;
  }
  // An account with no type is an UnknownAccount (AccountTypeUnknown is a type, and NewAccount creates it); every other union refuses none.
  if (t === undefined && union === 'Account') {
    const node = nodeFromJson('UnknownAccount', j, label, true);
    node.fields.set('type', 0n);
    return node;
  }
  if (t === undefined) return bad(`${label}: invalid ${union} type (none)`);
  const m = memberOf(union, t);
  if (!m) return bad(`${label}: invalid ${union} type ${JSON.stringify(t)}`);
  const node = nodeFromJson(m.cls, j, label, true);
  node.fields.set('type', m.tag);
  return node;
}

/** The scalar a member holds after all its occurrences: each is decoded (and so checked) in turn, a null leaves the value as it was. */
function lastScalar(cls: string, d: FieldDesc, vals: unknown[], label: string): Value | undefined {
  let out: Value | undefined;
  // The generated unmarshaler reads binary, hash and big-integer members into *string and urls into *url.URL: a null clears the pointer
  // (the member is then empty), and of several strings only the last is decoded (each is only type-checked); an url is parsed each time.
  const asString = d.kind === 'bytes' || d.kind === 'hash' || d.kind === 'bigint';
  const pointer = asString || d.kind === 'url' || d.kind === 'txid';
  let pending: unknown;
  for (const x of vals) {
    if (x === null) {
      // an enum held by value: its UnmarshalJSON is called with null and refuses it
      if (d.kind === 'enum' && !d.repeatable) return bad(`invalid ${enumOf(cls, d.name) ?? 'enum'} ""`);
      if (pointer) {
        out = undefined;
        pending = undefined;
      }
      continue;
    }
    if (x === undefined) continue;
    if (asString) {
      if (typeof x !== 'string') scalar(cls, d, x, label);
      pending = x;
      out = undefined;
      continue;
    }
    out = scalar(cls, d, x, label);
  }
  if (pending !== undefined) out = scalar(cls, d, pending, label);
  return out;
}

/** The generated <Type>.UnmarshalJSON: the object's members into a wire object of the class. */
export function nodeFromJson(cls: string, j: unknown, label: string, member_ = false): WireNode {
  const node: WireNode = { cls, fields: new Map(), extra: new Uint8Array(0), empty: false };
  if (j === null || j === undefined) return node;
  const pairs = mergedPairs(j);
  if (pairs === undefined) return bad(`json: cannot unmarshal ${describe(j)} into Go value of type ${cls}`);
  if (!hasClass(cls)) return bad(`${label}: ${cls} is not a class this verifier reads from JSON`);
  if (cls === 'KeyPage') {
    // KeyBook is a *url.URL of the generated unmarshaler's struct (derived on write, never stored): every occurrence is still parsed.
    for (const x of occurrences(pairs, 'keyBook')) {
      if (x === undefined || x === null) continue;
      scalar(cls, { name: 'keyBook', kind: 'url' } as unknown as FieldDesc, x, `${label}.keyBook`);
    }
  }
  for (const d of flatFields(cls)) {
    if (d.name === 'type' && member_) continue;
    const vals = occurrences(pairs, d.name);
    const lab = `${label}.${d.name}`;
    // protocol/types_gen.go: the aliases of the generated unmarshalers.
    if (cls === 'KeyPage' && d.name === 'acceptThreshold') {
      const accept = lastScalar(cls, d, vals, `${label}.acceptThreshold`);
      const alt = lastScalar(cls, d, occurrences(pairs, 'threshold'), `${label}.threshold`);
      const set = accept !== undefined && accept !== 0n;
      const v = set ? accept : alt !== undefined ? alt : accept;
      if (v !== undefined) node.fields.set(d.name, v);
      continue;
    }
    if (cls === 'KeySpec' && d.name === 'publicKeyHash') {
      // Both members are *string: both are type-checked; only the one used is hex-decoded (BytesFromJSON).
      const used = (name: string): string | undefined => {
        let last: string | undefined;
        for (const x of occurrences(pairs, name)) {
          if (x === undefined) continue;
          if (x === null) {
            last = undefined;
            continue;
          }
          if (typeof x !== 'string') return bad(`json: cannot unmarshal ${describe(x)} into Go struct field ${label}.${name} of type string`);
          last = x;
        }
        return last;
      };
      const h = used('publicKeyHash');
      const pk = used('publicKey');
      const v = h !== undefined ? h : pk;
      if (v !== undefined) node.fields.set(d.name, scalar(cls, d, v, lab));
      continue;
    }
    if (cls === 'KeyPage' && d.name === 'transactionBlacklist') {
      let mask: bigint | undefined;
      for (const v of vals) {
        if (v === undefined) continue;
        if (v === null) {
          mask = undefined;
          continue;
        }
        if (!Array.isArray(v)) return bad(`json: cannot unmarshal ${describe(v)} into Go value of type []AllowedTransactionBit`);
        let m = 0n;
        for (const b of v) {
          if (typeof b !== 'string') return bad(`json: cannot unmarshal ${describe(b)} into Go value of type string`);
          const e = enumByName('AllowedTransactionBit', b);
          if (e === undefined) return bad(`invalid AllowedTransactionBit ${JSON.stringify(b)}`);
          m |= 1n << BigInt(e);
        }
        mask = m;
      }
      if (mask !== undefined) node.fields.set('transactionBlacklist', mask);
      continue;
    }
    if (d.repeatable) {
      // encoding.JsonList: a list, or - failing that - a single value, which is a list of one; a later occurrence replaces an earlier one
      // and a null clears it.
      let items: Value[] | undefined;
      for (const v of vals) {
        if (v === undefined) continue;
        if (v === null) {
          items = undefined;
          continue;
        }
        const list = Array.isArray(v) ? v : [v];
        const here: Value[] = [];
        list.forEach((e, i) => {
          const x = element(cls, d, e, `${lab}[${i}]`);
          if (x !== null) here.push(x);
          else if (d.kind === 'reference') {
            // A null element is a nil entry, which the generated writer writes as the empty object.
            const c = registryType(cls, d.name);
            if (c) here.push({ cls: c, fields: new Map(), extra: new Uint8Array(0), empty: false });
          } else if (e === null) return bad(`${lab}[${i}]: a nil element of a ${d.kind} list is not read by this verifier`);
        });
        items = here;
      }
      if (items !== undefined) node.fields.set(d.name, items);
      continue;
    }
    if (d.kind === 'union') {
      // each occurrence is unmarshalled by the union's own function; a later one replaces an earlier one
      let x: Value | null | undefined;
      for (const v of vals) {
        if (v === undefined) continue;
        x = element(cls, d, v, lab);
      }
      if (x !== null && x !== undefined) node.fields.set(d.name, x);
      continue;
    }
    if (d.kind === 'reference') {
      // a struct field: the objects of every occurrence decode into the one struct
      // A member Go holds by pointer is set to nil by a null: only what follows the last null decodes (into a fresh struct), and what came
      // before it is still decoded, so a wrongly typed one stays an error.
      let live = vals;
      if (POINTER_STRUCTS.has(`${cls}.${d.name}`)) {
        const at = vals.lastIndexOf(null);
        if (at >= 0) {
          const earlier = vals.slice(0, at).filter((v) => v !== undefined && v !== null);
          if (earlier.length > 0) element(cls, d, earlier.length === 1 ? earlier[0] : new Occ(earlier), lab);
          live = vals.slice(at + 1);
        }
      }
      const objs = live.filter((v) => v !== undefined && v !== null);
      if (objs.length === 0) continue;
      const x = element(cls, d, objs.length === 1 ? objs[0] : new Occ(objs), lab);
      if (x !== null) node.fields.set(d.name, x);
      continue;
    }
    const x = lastScalar(cls, d, vals, lab);
    if (x !== undefined) node.fields.set(d.name, x);
  }
  return node;
}

/** A field's value (or one element of a repeated field). null is Accumulate's nil pointer/union. */
function element(cls: string, d: FieldDesc, v: unknown, label: string): Value | null {
  if (v === null) return null;
  if (d.kind === 'union') {
    const u = registryType(cls, d.name);
    if (!u) return bad(`${label}: Accumulate's registry does not name the union`);
    return unionFromJson(u, v, label);
  }
  if (d.kind === 'reference') {
    const c = registryType(cls, d.name);
    if (!c || !hasClass(c)) return bad(`${label}: ${c ?? 'a nested object'} is not read from JSON by this verifier`);
    return nodeFromJson(c, v, label);
  }
  return scalar(cls, d, v, label);
}

/** protocol.UnmarshalAccountJSON followed by MarshalBinary: the binary state of an account from its JSON. */
export function accountState(j: unknown, label: string): Uint8Array {
  const n = unionFromJson('Account', j, label);
  if (!n) return bad(`${label}: an account of no type`);
  return encodeNode(n);
}

/** The key signatures of a minor-root record and the transactions of its updates, as binary (UnmarshalSignatureJSON / Transaction.UnmarshalJSON). */
export function signatureBytes(j: unknown, label: string): Uint8Array {
  const n = unionFromJson('Signature', j, label);
  if (!n) return bad(`${label}: a signature of no type`);
  return encodeNode(n);
}
export function transactionBytes(j: unknown, label: string): Uint8Array {
  return encodeNode(nodeFromJson('Transaction', j, label));
}

/** A record of the set check (NetworkDefinition, NetworkGlobals, RoutingTable) from its JSON, as binary. */
export function recordBytes(cls: string, j: unknown, label: string): Uint8Array {
  if (j === undefined) return bad(`${label}: unexpected end of JSON input`);
  return encodeNode(nodeFromJson(cls, j, label));
}

