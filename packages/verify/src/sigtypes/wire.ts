/**
 * Accumulate's binary encoding, decoded and re-encoded with the field metadata of accumulate-sdk-opendlt's own classes.
 *
 * Why this exists: a signature (or the transaction it signs) reaches the verifier as the bytes Accumulate's marshaller wrote,
 * and the SDK has an encoder but no decoder. Verification needs the decoded fields (the public key, the signer, the delegator
 * chain, the transaction body) and needs to re-derive the signature's metadata hash, which is a hash of the signature
 * re-marshalled with its signature and transaction hash cleared. Both are done here from the SDK's declared fields: the field
 * numbers, the wire kinds, the repetition and the embedded structs come from the SDK's own `@encodeAs` metadata. Two things are
 * added, both read from Accumulate and not typed by hand: the class a nested object belongs to (the SDK's metadata does not
 * record it; Accumulate's type registry does, in the generated eip712-schema.ts) and which struct- and big.Int-valued fields are
 * values rather than pointers (the same file). Four classes the SDK predates, and the Factom entry whose body is not
 * Accumulate's field encoding, are described below from Accumulate's source.
 *
 * It follows pkg/types/encoding/reader.go of the pinned Accumulate (e1d1db9ebb7c) rule for rule:
 *   - an object whose first byte is 0x80 is the empty object (the rest is ignored); an empty union value is Accumulate's nil;
 *   - fields are read in ascending order; a number lower than the next expected one is ErrFieldsOutOfOrder; the number is a
 *     uvarint that must not exceed 32; a zero number ends the fields ("extension with zeros");
 *   - the first field number that no declared field has starts the object's extra data, which is kept verbatim (Accumulate
 *     keeps it as `extraData` and writes it back, so it is part of a re-marshalled signature's hash);
 *   - a bool is a uvarint of 0 or 1; a time is a signed varint of Unix seconds; a bigint is big-endian bytes; a value of
 *     16 MiB or more is refused; an enum value Accumulate does not define is refused;
 *   - every URL is parsed by Accumulate's URL parser and held as the string its writer emits (gourl.ts), and a URL it cannot
 *     parse refuses the whole object;
 *   - a struct-valued or big.Int-valued field equal to its zero value is the zero value: the writer leaves it out.
 * A violation is a WireError: the caller reports "undecodable", which is neither a signature rejection nor a pass.
 */
import { core } from 'accumulate-sdk-opendlt';
import {
  BigInt as EBigInt,
  Bool,
  Bytes,
  Duration,
  Encoding,
  Enum,
  Hash,
  Int,
  RawJson,
  Reference,
  String as EString,
  Time,
  TxID,
  Uint,
  Union,
  Url,
} from 'accumulate-sdk-opendlt/encoding';
import { SCHEMA, TRANSACTION_BODIES, TRANSACTION_TYPE_NAMES, VALUE_BIGINTS, VALUE_STRUCTS } from './eip712-schema.js';
import { binaryBytes, binaryString, canonicalAccTxId, canonicalAccUrl } from './gourl.js';

export class WireError extends Error {}
function bad(msg: string): never {
  throw new WireError(msg);
}

export type Kind = 'embedded' | 'int' | 'uint' | 'bool' | 'string' | 'hash' | 'bytes' | 'url' | 'time' | 'duration' | 'bigint' | 'txid' | 'enum' | 'union' | 'reference' | 'rawjson';

export interface EnumNames {
  getName(v: number): string;
}
export interface FieldDesc {
  number: number;
  name: string;
  kind: Kind;
  repeatable: boolean;
  keepEmpty: boolean;
  enumType?: EnumNames;
  /** An embedded struct (the field is a nested value whose own fields are numbered from 1): its fields, flattened into the parent. */
  embedded?: FieldDesc[];
}

/** A signed Unix time in seconds, as the wire carries it. */
export class TimeValue {
  constructor(readonly seconds: bigint) {}
}
/** A duration as the wire carries it: whole seconds and nanoseconds. */
export class DurationValue {
  constructor(
    readonly seconds: bigint,
    readonly nanos: bigint,
  ) {}
}
/** A nested object whose class Accumulate's type registry does not give (kept as the bytes it arrived as). */
export class OpaqueValue {
  constructor(readonly bytes: Uint8Array) {}
}

/**
 * A decoded field. Strings, URLs and transaction ids are BINARY strings (one char per byte, see gourl.ts), because Accumulate's
 * strings are byte strings; a URL is held in the form Accumulate's writer emits. `null` is a union value that arrived as the empty
 * object (Accumulate's nil interface).
 */
export type Value = bigint | boolean | string | Uint8Array | TimeValue | DurationValue | OpaqueValue | WireNode | null | Value[];

export interface WireNode {
  /** The SDK class name, which is Accumulate's struct name. */
  cls: string;
  /** Field name -> value (a repeatable field holds an array). */
  fields: Map<string, Value>;
  /** The unknown trailing fields, verbatim (Accumulate's extraData). Empty when there are none. */
  extra: Uint8Array;
  /** The object arrived as the single empty-object byte. */
  empty: boolean;
}

type Ctor = new (a: unknown) => object;
const classes = core as unknown as Record<string, unknown>;

function ctorOf(cls: string): Ctor {
  const c = classes[cls];
  if (typeof c !== 'function') bad(`no class ${cls} in accumulate-sdk-opendlt`);
  return c as Ctor;
}

export const hasClass = (cls: string): boolean => cls === FACTOM || Object.prototype.hasOwnProperty.call(EXTRA_CLASSES, cls) || typeof classes[cls] === 'function';

/**
 * TransactionType.String() for every value Accumulate defines. The SDK's own enum lacks some (setLiteAccountDelegate, the
 * deprecated 19 and 20, remote and the synthetic and system types), so names come from the table generated out of Accumulate.
 */
const TRANSACTION_TYPE: EnumNames = {
  getName(v: number): string {
    const n = Object.prototype.hasOwnProperty.call(TRANSACTION_TYPE_NAMES, v) ? TRANSACTION_TYPE_NAMES[v] : undefined;
    if (n === undefined) throw new Error(`Unknown TransactionType ${v}`);
    return n;
  },
};
/** The enum names the SDK does not attach to a field (its `@encodeAs.field(n).enum` carries no enum type). */
const FIELD_ENUMS: Readonly<Record<string, EnumNames>> = {
  'HashLockOptions.hashAlgorithm': core.HashAlgorithm as unknown as EnumNames,
  'UpdateAllowedKeyPageOperation.allow': TRANSACTION_TYPE,
  'UpdateAllowedKeyPageOperation.deny': TRANSACTION_TYPE,
  'ActivateProtocolVersion.version': core.ExecutorVersion as unknown as EnumNames,
};
const VOTE = core.VoteType as unknown as EnumNames;

interface ExtraClass {
  fields: FieldDesc[];
  /** Nested class of each reference field (Accumulate's registry does not name the merkle package's types). */
  refs?: Readonly<Record<string, string>>;
}
const f = (number: number, name: string, kind: Kind, extra: Partial<FieldDesc> = {}): FieldDesc => ({ number, name, kind, repeatable: false, keepEmpty: false, ...extra });

/**
 * Classes Accumulate has and accumulate-sdk-opendlt 2.5.2 does not (the SDK predates them, or they live in Accumulate's merkle
 * package). Their layout is Accumulate's: protocol/types_gen.go for SetLiteAccountDelegate (type 1, delegate URL 2, KeyBookProof
 * 3) and KeyBookProof (key book 1, receipt 2), pkg/database/merkle/types_gen.go for Receipt (start 1, startIndex 2, end 3, endIndex
 * 4, anchor 5, entries 6) and ReceiptEntry (right 1, hash 2).
 */
const EXTRA_CLASSES: Readonly<Record<string, ExtraClass>> = {
  SetLiteAccountDelegate: {
    fields: [f(1, 'type', 'enum', { keepEmpty: true, enumType: TRANSACTION_TYPE }), f(2, 'delegate', 'url'), f(3, 'proof', 'reference')],
    refs: { proof: 'KeyBookProof' },
  },
  KeyBookProof: { fields: [f(1, 'keyBook', 'reference'), f(2, 'receipt', 'reference')], refs: { keyBook: 'KeyBook', receipt: 'merkle.Receipt' } },
  'merkle.Receipt': {
    fields: [f(1, 'start', 'bytes'), f(2, 'startIndex', 'int'), f(3, 'end', 'bytes'), f(4, 'endIndex', 'int'), f(5, 'anchor', 'bytes'), f(6, 'entries', 'reference', { repeatable: true })],
    refs: { entries: 'merkle.ReceiptEntry' },
  },
  'merkle.ReceiptEntry': { fields: [f(1, 'right', 'bool'), f(2, 'hash', 'bytes')] },
};

/**
 * The factom data entry is written as its type (1) and then ONE value (2): the entry in the Factom binary layout (version byte,
 * account id, total ext-id length, ext ids, data), which is not Accumulate's field encoding. The numbers here are only an order
 * for rendering; the wire is read and written by the Factom functions below.
 */
const FACTOM = 'FactomDataEntryWrapper';
const FACTOM_DESCS: FieldDesc[] = [
  { number: 1, name: 'type', kind: 'enum', repeatable: false, keepEmpty: true, enumType: core.DataEntryType as unknown as EnumNames },
  { number: 2, name: 'accountId', kind: 'hash', repeatable: false, keepEmpty: false },
  { number: 3, name: 'data', kind: 'bytes', repeatable: false, keepEmpty: false },
  { number: 4, name: 'extIds', kind: 'bytes', repeatable: true, keepEmpty: false },
];

const descCache = new Map<string, FieldDesc[]>();

function kindOf(t: unknown): Kind {
  if (t instanceof Int) return 'int';
  if (t instanceof Uint) return 'uint';
  if (t instanceof Bool) return 'bool';
  if (t instanceof EString) return 'string';
  if (t instanceof Hash) return 'hash';
  if (t instanceof Bytes) return 'bytes';
  if (t instanceof Url) return 'url';
  if (t instanceof Time) return 'time';
  if (t instanceof Duration) return 'duration';
  if (t instanceof EBigInt) return 'bigint';
  if (t instanceof TxID) return 'txid';
  if (t instanceof Enum) return 'enum';
  if (t instanceof Union) return 'union';
  if (t instanceof Reference) return 'reference';
  if (t instanceof RawJson) return 'rawjson';
  return bad('a field of a kind this decoder does not know');
}

/** The declared fields of an SDK class, ascending by number. */
export function fieldsOf(cls: string): FieldDesc[] {
  const hit = descCache.get(cls);
  if (hit) return hit;
  if (cls === FACTOM) return FACTOM_DESCS;
  const extra = Object.prototype.hasOwnProperty.call(EXTRA_CLASSES, cls) ? EXTRA_CLASSES[cls] : undefined;
  if (extra) return extra.fields;
  interface SdkField {
    number: number;
    name: string;
    type: unknown;
    repeatable: boolean;
    keepEmpty: boolean;
    embedded?: SdkField[];
  }
  const enc = Encoding.forClass(ctorOf(cls) as never) as { fields: SdkField[] } | undefined;
  if (!enc) bad(`class ${cls} has no encoding metadata`);
  const describe = (f: SdkField): FieldDesc => {
    const kind = kindOf(f.type);
    const d: FieldDesc = { number: f.number, name: f.name, kind, repeatable: !!f.repeatable, keepEmpty: !!f.keepEmpty };
    if (kind === 'enum') {
      const declared = (f.type as { type?: EnumNames }).type;
      d.enumType = (declared === (core.TransactionType as unknown) ? TRANSACTION_TYPE : declared) ?? FIELD_ENUMS[`${cls}.${f.name}`] ?? (f.name === 'vote' ? VOTE : undefined);
    }
    return d;
  };
  const out: FieldDesc[] = [];
  for (const f of enc.fields) {
    if (f.embedded && f.embedded.length) {
      // the SDK's placeholder for field N holding an embedded struct: its own fields are numbered from 1
      out.push({ number: f.number, name: '', kind: 'embedded', repeatable: false, keepEmpty: false, embedded: f.embedded.map(describe).sort((a, b) => a.number - b.number) });
    } else out.push(describe(f));
  }
  out.sort((a, b) => a.number - b.number);
  descCache.set(cls, out);
  return out;
}

/** The fields of a class with embedded structs flattened into it (what its JSON shows). */
export function flatFields(cls: string): FieldDesc[] {
  return fieldsOf(cls).flatMap((d) => (d.kind === 'embedded' ? d.embedded! : [d]));
}

/** Accumulate's registry type of a field ("ExpireOptions", "Signature", "KeyPageOperation[]" ...), without the array suffix. */
export function registryType(cls: string, field: string): string | undefined {
  const extra = Object.prototype.hasOwnProperty.call(EXTRA_CLASSES, cls) ? EXTRA_CLASSES[cls]!.refs?.[field] : undefined;
  if (extra) return extra;
  const def = SCHEMA[cls];
  const hit = def?.find(([n]) => n === field);
  return hit ? hit[1].replace(/\[\]$/, '') : undefined;
}

/** The member class of a union value with the given type tag. */
export function unionMember(union: string, tag: bigint): string {
  const u = classes[union] as { fromObject?: (o: unknown) => object } | undefined;
  if (!u || typeof u.fromObject !== 'function') bad(`${union} is not a union of accumulate-sdk-opendlt`);
  try {
    return u.fromObject({ type: Number(tag) }).constructor.name;
  } catch {
    // A transaction body the SDK predates: Accumulate's own tables name it, and EXTRA_CLASSES describes it.
    if (union === 'TransactionBody') {
      const name = Object.prototype.hasOwnProperty.call(TRANSACTION_TYPE_NAMES, Number(tag)) ? TRANSACTION_TYPE_NAMES[Number(tag)] : undefined;
      const struct = TRANSACTION_BODIES.find(([n]) => n === name)?.[1];
      if (struct && Object.prototype.hasOwnProperty.call(EXTRA_CLASSES, struct)) return struct;
    }
    return bad(`${union}: type ${tag} is not a member`);
  }
}

class Reader {
  pos = 0;
  constructor(readonly buf: Uint8Array) {}
  get left(): number {
    return this.buf.length - this.pos;
  }
  uvarint(): bigint {
    let x = 0n;
    let shift = 0n;
    for (let i = 0; i < 10; i++) {
      if (this.pos >= this.buf.length) bad('unexpected end of data in a varint');
      const b = this.buf[this.pos++]!;
      if (b < 0x80) {
        if (i === 9 && b > 1) bad('varint overflows 64 bits');
        return x | (BigInt(b) << shift);
      }
      x |= BigInt(b & 0x7f) << shift;
      shift += 7n;
    }
    return bad('varint overflows 64 bits');
  }
  varint(): bigint {
    const ux = this.uvarint();
    const x = ux >> 1n;
    return ux & 1n ? ~x : x;
  }
  raw(n: number): Uint8Array {
    if (n > this.left) bad(`want ${n} bytes, ${this.left} remain`);
    const out = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }
  bytes(): Uint8Array {
    const n = this.uvarint();
    if (n >= 1n << 24n) bad(`value of ${n} bytes is too big`);
    return this.raw(Number(n));
  }
}

const EMPTY = new Uint8Array(0);
/** Go's zero time.Time (January 1, year 1, UTC) in Unix seconds: a writer leaves it out. */
const ZERO_TIME_SECONDS = -62135596800n;

function enumChecked(d: FieldDesc, v: bigint): bigint {
  if (d.enumType && v <= BigInt(Number.MAX_SAFE_INTEGER)) {
    try {
      d.enumType.getName(Number(v));
    } catch {
      bad(`${d.name}: ${v} is not a valid value`);
    }
  }
  return v;
}

function readValue(owner: string, d: FieldDesc, r: Reader): Value {
  switch (d.kind) {
    case 'uint':
      return r.uvarint();
    case 'int':
      return r.varint();
    case 'enum':
      return enumChecked(d, r.uvarint());
    case 'bool': {
      const v = r.uvarint();
      if (v > 1n) bad(`${d.name}: ${v} is not a valid boolean`);
      return v === 1n;
    }
    case 'string':
      return binaryString(r.bytes());
    case 'url':
    case 'txid': {
      const raw = binaryString(r.bytes());
      if (raw === '') return '';
      const canonical = d.kind === 'url' ? canonicalAccUrl(raw) : canonicalAccTxId(raw);
      if (canonical === undefined) bad(`field ${d.name}: failed to parse url`);
      return canonical;
    }
    case 'bytes':
      return r.bytes().slice();
    case 'hash':
      return r.raw(32).slice();
    case 'time':
      return new TimeValue(r.varint());
    case 'duration': {
      const s = r.uvarint();
      return new DurationValue(s, r.uvarint());
    }
    case 'bigint': {
      let n = 0n;
      for (const b of r.bytes()) n = (n << 8n) | BigInt(b);
      return n;
    }
    case 'rawjson':
      return new OpaqueValue(r.bytes().slice());
    case 'union': {
      const type = registryType(owner, d.name);
      if (!type) bad(`${owner}.${d.name}: Accumulate's registry does not name the union`);
      return decodeUnion(type, r.bytes());
    }
    case 'reference': {
      const type = registryType(owner, d.name);
      const body = r.bytes();
      if (!type || !hasClass(type)) return new OpaqueValue(body.slice());
      return decodeObject(type, body);
    }
    case 'embedded':
      return bad('an embedded struct is read by readFields');
  }
}

/** FactomDataEntry.UnmarshalBinary (protocol/factom_data_entry.go): the Factom entry layout, not Accumulate's field encoding. */
function parseFactomEntry(data: Uint8Array): { accountId: Uint8Array; data: Uint8Array; extIds: Uint8Array[] } {
  if (data.length < 1 + 32 + 2) bad('malformed entry header');
  const accountId = data.slice(1, 33);
  const totalExtIdSize = (data[33]! << 8) | data[34]!;
  const rest = data.subarray(35);
  if (totalExtIdSize > rest.length || totalExtIdSize === 1) bad('malformed entry payload');
  const payload = rest.slice(totalExtIdSize);
  let ext = rest.subarray(0, totalExtIdSize);
  const extIds: Uint8Array[] = [];
  while (ext.length > 0) {
    if (ext.length < 2) bad('malformed extId');
    const n = (ext[0]! << 8) | ext[1]!;
    ext = ext.subarray(2);
    if (n > ext.length) bad('malformed extId');
    extIds.push(ext.slice(0, n));
    ext = ext.subarray(n);
  }
  return { accountId, data: payload, extIds };
}

/** FactomDataEntry.MarshalBinary: version 0, the account id, the ext ids each with a 2-byte length, then the data. */
export function marshalFactomEntry(accountId: Uint8Array, data: Uint8Array, extIds: Uint8Array[]): Uint8Array {
  if (accountId.length === 0 || accountId.every((b) => b === 0)) bad('missing ChainID');
  const ex: number[] = [];
  for (const d of extIds) {
    ex.push((d.length >> 8) & 0xff, d.length & 0xff);
    for (const b of d) ex.push(b);
  }
  return Uint8Array.from([0, ...accountId, (ex.length >> 8) & 0xff, ex.length & 0xff, ...ex, ...data]);
}

function decodeFactom(buf: Uint8Array): WireNode {
  const node: WireNode = { cls: FACTOM, fields: new Map(), extra: EMPTY, empty: false };
  if (buf.length > 0 && buf[0] === 0x80) {
    node.empty = true;
    return node;
  }
  const r = new Reader(buf);
  if (r.left === 0 || r.uvarint() !== 1n) bad('a factom entry must begin with its type');
  const tag = r.uvarint();
  if (tag !== 1n) bad(`field Type: not equal: want 1, got ${tag}`);
  node.fields.set('type', tag);
  if (r.left === 0) return node;
  const mark = r.pos;
  const field = r.uvarint();
  if (field > 32n) bad(`invalid field number ${field}`);
  if (field === 1n) bad('field 1 is out of order');
  if (field === 2n) {
    const e = parseFactomEntry(r.bytes());
    node.fields.set('accountId', e.accountId);
    node.fields.set('data', e.data);
    node.fields.set('extIds', e.extIds);
    if (r.left > 0) node.extra = buf.slice(r.pos);
  } else {
    node.extra = buf.slice(mark);
  }
  return node;
}

function encodeFactom(node: WireNode): Uint8Array {
  const out: number[] = [];
  writeUvarint(out, 1n);
  writeUvarint(out, 1n);
  const accountId = node.fields.get('accountId');
  if (accountId !== undefined || node.fields.has('data') || node.fields.has('extIds')) {
    writeUvarint(out, 2n);
    writeBytes(
      out,
      marshalFactomEntry(
        accountId instanceof Uint8Array ? accountId : new Uint8Array(0),
        (node.fields.get('data') as Uint8Array | undefined) ?? EMPTY,
        (node.fields.get('extIds') as Uint8Array[] | undefined) ?? [],
      ),
    );
  }
  for (const b of node.extra) out.push(b);
  return Uint8Array.from(out);
}

const own = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);

/**
 * A struct-valued or big.Int-valued field that arrived equal to the zero value is the zero value: Accumulate's reader stores it in
 * a value field and its writer leaves a zero value out (though a struct-valued field is still {} in its JSON). A pointer field
 * that arrived is kept, empty or not. A zero struct keeps its node because its extra data still counts where Accumulate hashes it.
 */
function equalsZero(cls: string, d: FieldDesc, v: Value): boolean {
  if (d.kind === 'bigint') return v === 0n && own(VALUE_BIGINTS, cls) && VALUE_BIGINTS[cls]!.includes(d.name);
  if (d.kind === 'reference' && typeof v === 'object' && v !== null && 'cls' in v) {
    return own(VALUE_STRUCTS, cls) && VALUE_STRUCTS[cls]!.some(([json]) => json === d.name) && isZeroStruct(v as WireNode);
  }
  return false;
}

/** The generated Equal(new(T)): every declared field is its zero value (extra data is not compared). */
function isZeroStruct(n: WireNode): boolean {
  for (const d of flatFields(n.cls)) {
    const v = n.fields.get(d.name);
    if (v === undefined) continue;
    if (d.repeatable) {
      if ((v as Value[]).length > 0) return false;
      continue;
    }
    switch (d.kind) {
      case 'uint':
      case 'int':
      case 'enum':
        if (v !== 0n) return false;
        break;
      case 'bool':
        if (v !== false) return false;
        break;
      case 'string':
      case 'url':
      case 'txid':
        if (v !== '') return false;
        break;
      case 'bytes':
        if ((v as Uint8Array).length !== 0) return false;
        break;
      case 'hash':
        if (!(v as Uint8Array).every((b) => b === 0)) return false;
        break;
      case 'time':
        if ((v as TimeValue).seconds !== ZERO_TIME_SECONDS) return false;
        break;
      case 'bigint':
        if (!(v === 0n && own(VALUE_BIGINTS, n.cls) && VALUE_BIGINTS[n.cls]!.includes(d.name))) return false;
        break;
      default:
        if (!(typeof v === 'object' && v !== null && 'cls' in v && equalsZero(n.cls, d, v))) return false;
    }
  }
  return true;
}

/**
 * Read the fields of `descs` from `buf` into `node` (reader.go rules) and return the extra data: whatever remains from the field
 * number that was read but not consumed, or from the current position.
 */
function readFields(node: WireNode, descs: FieldDesc[], buf: Uint8Array): Uint8Array {
  const cls = node.cls;
  const r = new Reader(buf);
  let cur = 0; // the next field number, read but not yet consumed
  let curStart = 0;
  let ended = false; // a zero field number ends the fields
  const peek = (): void => {
    if (cur !== 0 || ended || r.left === 0) return;
    curStart = r.pos;
    const n = r.uvarint();
    if (n < 1n) {
      ended = true;
      return;
    }
    if (n > 32n) bad(`invalid field number ${n}`);
    cur = Number(n);
  };
  for (const d of descs) {
    peek();
    if (cur !== 0 && cur < d.number) bad(`field ${cur} is out of order (expected ${d.number} or later)`);
    if (cur !== d.number) continue;
    if (d.kind === 'embedded') {
      cur = 0;
      const body = r.bytes();
      if (!(body.length > 0 && body[0] === 0x80)) readFields(node, d.embedded!, body); // the embedded struct's own extra data is not kept
      continue;
    }
    for (;;) {
      cur = 0;
      const v = readValue(cls, d, r);
      if (d.repeatable) {
        const list = (node.fields.get(d.name) as Value[] | undefined) ?? [];
        list.push(v);
        node.fields.set(d.name, list);
        peek();
        if (cur === d.number) continue;
        // the generated reader loops on ReadX(n) until it answers false, and answers an out-of-order error (not false) when the next field is below n
        if (cur !== 0 && cur < d.number) bad(`field ${cur} is out of order (expected ${d.number} or later)`);
      } else if (v !== null && !(d.kind === 'bigint' && equalsZero(cls, d, v))) {
        // A struct-valued field that is the zero struct stays: its extra data still counts where Accumulate hashes it (a transaction
        // header), though the writer leaves it out.
        node.fields.set(d.name, v);
      }
      break;
    }
  }
  const rest = cur !== 0 || ended ? curStart : r.pos;
  return rest < buf.length ? buf.slice(rest) : EMPTY;
}

/** Decode `buf` as an object of SDK class `cls` (reader.go rules, see the file comment). */
export function decodeObject(cls: string, buf: Uint8Array): WireNode {
  if (cls === FACTOM) return decodeFactom(buf);
  const descs = fieldsOf(cls);
  const node: WireNode = { cls, fields: new Map(), extra: EMPTY, empty: false };
  if (buf.length > 0 && buf[0] === 0x80) {
    node.empty = true;
    return node;
  }
  node.extra = readFields(node, descs, buf);
  return node;
}

/** Decode a union value: the first field is the type tag, which names the member class. */
export function decodeUnion(union: string, buf: Uint8Array): WireNode | null {
  if (buf.length === 0) bad(`${union}: field Type: missing`);
  // The empty object (a leading 0x80, or a zero field number) is Accumulate's nil value: UnmarshalSignatureFrom returns it with no error.
  if (buf[0] === 0x80) return null;
  const r = new Reader(buf);
  const field = r.uvarint();
  if (field === 0n) return null;
  if (field > 32n) bad(`${union}: invalid field number ${field}`);
  if (field !== 1n) bad(`${union}: the first field is ${field}, not the type`);
  const tag = r.uvarint();
  const member = unionMember(union, tag);
  return decodeObject(member, buf);
}

function writeUvarint(out: number[], v: bigint): void {
  let x = v;
  while (x >= 0x80n) {
    out.push(Number(x & 0x7fn) | 0x80);
    x >>= 7n;
  }
  out.push(Number(x));
}
function writeVarint(out: number[], v: bigint): void {
  const ux = v << 1n;
  writeUvarint(out, v < 0n ? ~ux & ((1n << 64n) - 1n) : ux);
}
function writeBytes(out: number[], b: Uint8Array): void {
  writeUvarint(out, BigInt(b.length));
  for (const x of b) out.push(x);
}

function isZero(d: FieldDesc, v: Value): boolean {
  if (d.keepEmpty) return false;
  switch (d.kind) {
    case 'uint':
    case 'int':
    case 'enum':
      return v === 0n;
    case 'bool':
      return v === false;
    case 'string':
    case 'url':
    case 'txid':
      return v === '';
    case 'bytes':
      return (v as Uint8Array).length === 0;
    case 'hash':
      return (v as Uint8Array).every((b) => b === 0);
    case 'time':
      return (v as TimeValue).seconds === ZERO_TIME_SECONDS;
    default:
      return false;
  }
}

function writeValue(out: number[], d: FieldDesc, v: Value): void {
  switch (d.kind) {
    case 'uint':
    case 'enum':
      return writeUvarint(out, v as bigint);
    case 'int':
      return writeVarint(out, v as bigint);
    case 'bool':
      return writeUvarint(out, v ? 1n : 0n);
    case 'string':
    case 'url':
    case 'txid':
      return writeBytes(out, binaryBytes(v as string));
    case 'bytes':
      return writeBytes(out, v as Uint8Array);
    case 'hash':
      for (const b of v as Uint8Array) out.push(b);
      return;
    case 'time':
      return writeVarint(out, (v as TimeValue).seconds);
    case 'duration':
      writeUvarint(out, (v as DurationValue).seconds);
      return writeUvarint(out, (v as DurationValue).nanos);
    case 'bigint': {
      let h = (v as bigint).toString(16);
      if (h.length % 2) h = `0${h}`;
      const b = (v as bigint) === 0n ? EMPTY : Uint8Array.from(h.match(/../g)!.map((x) => parseInt(x, 16)));
      return writeBytes(out, b);
    }
    case 'embedded':
      return;
    case 'rawjson':
    case 'reference':
    case 'union':
      return writeBytes(out, v === null ? Uint8Array.of(0x80) : v instanceof OpaqueValue ? v.bytes : encodeNode(v as WireNode));
  }
}

/**
 * Marshal a decoded object back the way Accumulate's writer does: fields ascending, a zero value left out unless the field is
 * keepEmpty, a nested object that would encode to nothing written as the single byte 0x80, and the extra data appended.
 * `omit` names fields to leave out (a signature's `signature` and `transactionHash`, for its metadata).
 */
export function encodeNode(node: WireNode, omit: ReadonlySet<string> = new Set()): Uint8Array {
  if (node.cls === FACTOM) return node.empty ? Uint8Array.of(0x80) : encodeFactom(node);
  const out: number[] = [];
  encodeFields(out, node, fieldsOf(node.cls), omit);
  if (out.length === 0) out.push(0x80);
  for (const b of node.extra) out.push(b);
  return Uint8Array.from(out);
}

function encodeFields(out: number[], node: WireNode, descs: FieldDesc[], omit: ReadonlySet<string>): void {
  for (const d of descs) {
    if (d.kind === 'embedded') {
      // an embedded struct is written whether or not it has anything in it
      const sub: number[] = [];
      encodeFields(sub, node, d.embedded!, omit);
      writeUvarint(out, BigInt(d.number));
      writeBytes(out, sub.length === 0 ? Uint8Array.of(0x80) : Uint8Array.from(sub));
      continue;
    }
    if (omit.has(d.name)) continue;
    const v = node.fields.get(d.name);
    if (v === undefined) {
      if (d.keepEmpty && !d.repeatable) {
        // A keepEmpty field that arrived absent is the zero value, and is written.
        writeUvarint(out, BigInt(d.number));
        writeValue(out, d, d.kind === 'bool' ? false : 0n);
      }
      continue;
    }
    const items = d.repeatable ? (v as Value[]) : [v];
    for (const item of items) {
      if (!d.repeatable && (isZero(d, item) || equalsZero(node.cls, d, item))) continue;
      writeUvarint(out, BigInt(d.number));
      writeValue(out, d, item);
    }
  }
}

/** A node's own field by name, typed by the caller. */
export function field<T extends Value>(node: WireNode, name: string): T | undefined {
  return node.fields.get(name) as T | undefined;
}
