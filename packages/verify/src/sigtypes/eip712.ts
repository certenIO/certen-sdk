/**
 * The EIP-712 digest of a typedData signature, as Accumulate computes it: protocol.EIP712Hash (protocol/signature_eip712.go)
 * over pkg/types/encoding/eip712.go, pinned at accumulate e1d1db9ebb7c (the commit Kermit runs).
 *
 * A typedData signature does not sign the transaction hash. It signs
 *
 *     keccak256( 0x19 0x01 || hashStruct(EIP712Domain) || hashStruct(Transaction) )
 *
 * where the domain is { name: "Accumulate", version: "1.0.0", chainId } with the signature's own chain id, and the Transaction
 * message is the transaction's JSON (header, and the body under the name of its type) plus the OUTER signature's metadata
 * under `signature` (its type, public key, signer, version, timestamp, vote, memo, data, and every delegator, outermost
 * first). The type dictionary is not fixed: it is built from the message itself, so a field that is empty is not part of its
 * struct's type string, and the typeHash of each struct follows from which fields the transaction has.
 *
 * This module is a port, not a re-design. The structure, the order of operations and every error case follow the Go: the
 * resolver of a field type (atomic, union, struct, array of any), the nil rules (an absent struct is skipped but its type must
 * still be registered; an absent union is an error; an absent atomic is its zero value and is left out of the type), the
 * sorted insertion of fields into a type, the dependency order of the type string. Where Go would panic or error, this throws
 * an Eip712Error, which the verifier reports as a signature that does not verify (Accumulate's Verify returns false there).
 *
 * Cryptography: keccak256 is @noble/hashes. Nothing here implements a curve.
 */
import { keccak_256 } from '@noble/hashes/sha3';
import { SCHEMA, SIGNATURE_METADATA, TRANSACTION_BODIES, UNIONS, VALUE_STRUCTS } from './eip712-schema.js';
import { goText } from './gourl.js';
import { flatFields, type FieldDesc, type Value, type WireNode, WireError, TimeValue, DurationValue, OpaqueValue } from './wire.js';

export class Eip712Error extends Error {}
function bad(msg: string): never {
  throw new Eip712Error(msg);
}

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
type JsonObject = { [k: string]: Json };
interface TypeField {
  name: string;
  type: string;
}
type TypeSet = Map<string, TypeField[]>;

const keccak = (b: Uint8Array): Uint8Array => keccak_256(b);
const ATOMS = new Set(['bool', 'bytes', 'bytes32', 'int64', 'uint64', 'string', 'address', 'uint256', 'float64', 'float']);

/** schemaDictionary: the protocol structs, plus SignatureMetadata and the domain. */
function structDef(name: string): readonly (readonly [string, string])[] | undefined {
  if (name === 'SignatureMetadata') return SIGNATURE_METADATA;
  return SCHEMA[name];
}

// ---------------------------------------------------------------- JSON of a decoded object (Go's json.Marshal of the struct)

const GO_ZERO_TIME = -62135596800n;

function hex(b: Uint8Array): string {
  let s = '';
  for (const x of b) s += x.toString(16).padStart(2, '0');
  return s;
}

function renderTime(t: TimeValue): string {
  const ms = Number(t.seconds) * 1000;
  const d = new Date(ms);
  const iso = d.toISOString();
  if (!/^\d{4}-/.test(iso) || d.getUTCFullYear() < 0 || d.getUTCFullYear() > 9999) bad('a time outside the years 0000-9999 has no JSON form');
  return iso.replace('.000Z', 'Z');
}

/** `list` is a list element: Go writes every element of a list, a zero one included. */
function renderScalar(owner: string, d: FieldDesc, v: Value, list: boolean): Json | undefined {
  switch (d.kind) {
    case 'uint':
    case 'int': {
      const n = v as bigint;
      return n === 0n && !list ? undefined : Number(n);
    }
    case 'enum': {
      const n = v as bigint;
      if (n === 0n && !d.keepEmpty && !list) return undefined;
      if (!d.enumType) bad(`${owner}.${d.name}: an enum whose names this verifier does not have`);
      return d.enumType.getName(Number(n));
    }
    case 'bool':
      return v === true || list ? (v as boolean) : undefined;
    case 'string':
    case 'url':
    case 'txid':
      return v === '' && !list ? undefined : goText(v as string);
    case 'bytes': {
      const b = v as Uint8Array;
      return b.length === 0 && !list ? undefined : hex(b);
    }
    case 'hash': {
      const b = v as Uint8Array;
      return b.every((x) => x === 0) && !list ? undefined : hex(b);
    }
    case 'time': {
      const t = v as TimeValue;
      return t.seconds === GO_ZERO_TIME && !list ? undefined : renderTime(t);
    }
    case 'bigint':
      return (v as bigint).toString(10);
    case 'duration':
      return bad(`${owner}.${d.name}: a duration has no EIP-712 form this verifier reproduces`);
    default:
      return bad(`${owner}.${d.name}: not a scalar`);
  }
}

/**
 * The JSON of a zero struct-valued field. Go's omitempty does not omit a struct, so a struct-valued (non-pointer) field is in the
 * JSON as {} when it is zero - though it is absent from the wire - and so is every struct-valued field inside it.
 */
function zeroStruct(name: string): JsonObject {
  const o: JsonObject = {};
  for (const [json, type] of Object.prototype.hasOwnProperty.call(VALUE_STRUCTS, name) ? VALUE_STRUCTS[name]! : []) o[json] = zeroStruct(type);
  return o;
}

/** Go's json.Marshal of a protocol struct: zero values left out, nested objects present once set. */
export function toJson(node: WireNode, omit: ReadonlySet<string> = new Set()): JsonObject {
  const out: JsonObject = {};
  for (const d of flatFields(node.cls)) {
    if (omit.has(d.name)) continue;
    const v = node.fields.get(d.name);
    if (v === undefined) continue;
    if (d.repeatable) {
      const list = (v as Value[]).map((x) => renderOne(node.cls, d, x, true)).filter((x): x is Json => x !== undefined);
      if (list.length) out[d.name] = list;
      continue;
    }
    const j = renderOne(node.cls, d, v, false);
    if (j !== undefined) out[d.name] = j;
  }
  for (const [json, type] of Object.prototype.hasOwnProperty.call(VALUE_STRUCTS, node.cls) ? VALUE_STRUCTS[node.cls]! : []) {
    if (!Object.prototype.hasOwnProperty.call(out, json)) out[json] = zeroStruct(type);
  }
  return out;
}

function renderOne(owner: string, d: FieldDesc, v: Value, list: boolean): Json | undefined {
  if (v === null) return null; // a nil union value in a list
  if (d.kind === 'reference' || d.kind === 'union') {
    if (v instanceof OpaqueValue) return bad(`${owner}.${d.name}: a nested object of a type this verifier has no class for`);
    return toJson(v as WireNode);
  }
  if (d.kind === 'rawjson') {
    if (!(v instanceof OpaqueValue)) return bad('raw json');
    try {
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(v.bytes)) as Json;
    } catch {
      return bad(`${owner}.${d.name}: not JSON`);
    }
  }
  if (v instanceof DurationValue || v instanceof OpaqueValue) return bad(`${owner}.${d.name}: unsupported value`);
  return renderScalar(owner, d, v, list);
}

// ---------------------------------------------------------------- the resolver (eip712.go)

interface Resolved {
  types(ts: TypeSet): void;
  hash(ts: TypeSet): Uint8Array;
}

function stripSlice(s: string): { name: string; slice: boolean } {
  const name = s.endsWith('[]') ? s.slice(0, -2) : s;
  return { name, slice: name.length < s.length };
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function addField(ts: TypeSet, base: string, name: string, type: string): void {
  const fields = ts.get(base);
  if (!fields) {
    ts.set(base, [{ name, type }]);
    return;
  }
  if (fields.some((f) => f.name === name)) return;
  fields.push({ name, type });
  fields.sort((a, b) => cmp(a.name, b.name));
}

function getDeps(deps: Set<string>, typeName: string, ts: TypeSet): void {
  const fields = ts.get(typeName);
  if (!fields) return;
  deps.add(typeName);
  for (const f of fields) getDeps(deps, f.type.endsWith('[]') ? f.type.slice(0, -2) : f.type, ts);
}

function hashStruct(typeName: string, ts: TypeSet, values: () => Uint8Array[]): Uint8Array {
  const deps = new Set<string>();
  getDeps(deps, typeName, ts);
  deps.delete(typeName);
  const names = [typeName, ...[...deps].sort(cmp)];
  let header = '';
  for (const n of names) header += `${n}(${(ts.get(n) ?? []).map((f) => `${f.type} ${f.name}`).join(',')})`;
  const parts: Uint8Array[] = [keccak(new TextEncoder().encode(header)), ...values()];
  return keccak(concat(parts));
}

function concat(parts: Uint8Array[]): Uint8Array {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

const ZERO32 = (): Uint8Array => new Uint8Array(32);

function padLeft(b: Uint8Array): Uint8Array {
  if (b.length > 32) bad('a value longer than 32 bytes does not fit a 32-byte slot');
  const out = new Uint8Array(32);
  out.set(b, 32 - b.length);
  return out;
}

function hexToBytes(s: string): Uint8Array {
  const t = s.startsWith('0x') ? s.slice(2) : s;
  if (t.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(t)) bad('invalid eip712 hex encoding');
  const out = new Uint8Array(t.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(t.slice(2 * i, 2 * i + 2), 16);
  return out;
}

function u64Slot(n: bigint): Uint8Array {
  const out = new Uint8Array(32);
  let x = BigInt.asUintN(64, n);
  for (let i = 31; i >= 24; i--) {
    out[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  return out;
}

class Atomic implements Resolved {
  constructor(private readonly h: () => Uint8Array) {}
  types(): void {}
  hash(): Uint8Array {
    return this.h();
  }
}

/** The atomic resolvers (eip712EncoderMap): the Go type each expects of the JSON value, and its 32-byte slot. */
function resolveAtomic(ethType: string, raw: Json | undefined): Atomic {
  const v: Json = raw === undefined || raw === null ? zeroOf(ethType) : raw;
  const wantString = (): string => (typeof v === 'string' ? v : bad(`eip712 value of type ${typeof v} does not match type field ${ethType}`));
  switch (ethType) {
    case 'bool': {
      if (typeof v !== 'boolean') bad('eip712 value does not match type field bool');
      return new Atomic(() => {
        const out = ZERO32();
        if (v) out[31] = 1;
        return out;
      });
    }
    case 'int64':
    case 'uint64': {
      if (typeof v !== 'number') bad(`eip712 value does not match type field ${ethType}`);
      // JSON decodes numbers to float64 and Go converts with int64(u) / uint64(u).
      const t = Math.trunc(v);
      if (!Number.isFinite(t)) bad('not a finite number');
      let n = BigInt(t);
      if (ethType === 'uint64' && (n < 0n || n >= 1n << 64n)) bad('a uint64 out of range');
      if (ethType === 'int64' && (n < -(1n << 63n) || n >= 1n << 63n)) bad('an int64 out of range');
      n = BigInt.asUintN(64, n);
      return new Atomic(() => u64Slot(n));
    }
    case 'string': {
      const s = wantString();
      return new Atomic(() => keccak(new TextEncoder().encode(s)));
    }
    case 'bytes': {
      const s = wantString();
      return new Atomic(() => keccak(hexToBytes(s)));
    }
    case 'bytes32': {
      const s = wantString();
      return new Atomic(() => padLeft(hexToBytes(s)));
    }
    case 'address': {
      const s = wantString();
      return new Atomic(() => padLeft(hexToBytes(s.slice(2))));
    }
    case 'uint256': {
      const s = wantString();
      return new Atomic(() => {
        if (!/^[0-9]+$/.test(s) && s !== '') bad('not a decimal integer');
        const n = s === '' ? 0n : BigInt(s);
        if (n >= 1n << 256n) bad('a uint256 that does not fit 32 bytes');
        const out = ZERO32();
        let x = n;
        for (let i = 31; i >= 0 && x > 0n; i--) {
          out[i] = Number(x & 0xffn);
          x >>= 8n;
        }
        return out;
      });
    }
    case 'float64':
    case 'float': {
      if (typeof v !== 'number') bad('eip712 value does not match type field float');
      return new Atomic(() => keccak(new TextEncoder().encode(v.toFixed(6))));
    }
  }
  return bad(`eip712 field ${ethType}`);
}

function zeroOf(ethType: string): Json {
  switch (ethType) {
    case 'bool':
      return false;
    case 'int64':
    case 'uint64':
    case 'float64':
    case 'float':
      return 0;
    default:
      return '';
  }
}

interface ResolvedField {
  name: string;
  type: string;
  empty: boolean;
  value: Resolved;
}

class ResolvedStruct implements Resolved {
  constructor(
    readonly typeName: string,
    readonly fields: Map<string, ResolvedField>,
  ) {}
  types(ts: TypeSet): void {
    const name = stripSlice(this.typeName).name;
    for (const f of this.fields.values()) {
      if (f.empty) continue;
      addField(ts, name, f.name, f.type);
      f.value.types(ts);
    }
  }
  hash(ts: TypeSet): Uint8Array {
    const name = stripSlice(this.typeName).name;
    return hashStruct(name, ts, () =>
      (ts.get(name) ?? []).map((field) => {
        const f = this.fields.get(field.name);
        return f ? f.value.hash(ts) : ZERO32();
      }),
    );
  }
}

class ResolvedArray implements Resolved {
  constructor(readonly items: Resolved[]) {}
  types(ts: TypeSet): void {
    for (const i of this.items) i.types(ts);
  }
  hash(ts: TypeSet): Uint8Array {
    return keccak(concat(this.items.map((i) => i.hash(ts))));
  }
}

class ResolvedUnion implements Resolved {
  constructor(
    readonly union: string,
    readonly enumName: string,
    readonly member: string,
    readonly value: Resolved,
  ) {}
  types(ts: TypeSet): void {
    addField(ts, this.union, this.enumName, this.member);
    this.value.types(ts);
  }
  hash(ts: TypeSet): Uint8Array {
    return hashStruct(this.union, ts, () =>
      (ts.get(this.union) ?? []).map((f) => (f.name !== this.enumName ? ZERO32() : this.value.hash(ts))),
    );
  }
}

const isObject = (v: unknown): v is JsonObject => typeof v === 'object' && v !== null && !Array.isArray(v);
const has = (o: JsonObject, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);

/** TypeDefinition.Resolve: a struct from its JSON object. */
function resolveStruct(name: string, fields: readonly (readonly [string, string])[], v: unknown): ResolvedStruct {
  if (!isObject(v)) bad('cannot hash type definition with invalid interface');
  const out = new Map<string, ResolvedField>();
  for (const [fname, ftype] of fields) {
    const r = resolveField(fname, ftype, has(v, fname) ? v[fname] : undefined);
    if (r) out.set(fname, r);
  }
  return new ResolvedStruct(name, out);
}

/** The union resolver: the JSON object names its member in `type`, which is removed before the member is resolved. */
function resolveUnion(union: string, v: unknown): ResolvedUnion {
  if (!isObject(v)) bad(`invalid data entry type: ${typeof v}`);
  const enumName = v.type;
  if (typeof enumName !== 'string') bad('invalid data entry type');
  const members = UNIONS[union];
  const member = members && Object.prototype.hasOwnProperty.call(members, enumName) ? members[enumName] : undefined;
  if (member === undefined) bad(`type alias does not exist in map: ${enumName}`);
  const def = structDef(member);
  if (!def) bad(`invalid data entry type: ${enumName}`);
  const copy: JsonObject = { ...v };
  delete copy.type;
  return new ResolvedUnion(union, enumName, member, resolveStruct(member, def, copy));
}

function resolveField(name: string, type: string, v: Json | undefined): ResolvedField | undefined {
  const { name: tn, slice } = stripSlice(type);
  const nil = v === undefined || v === null;
  const encoder: ((x: Json | undefined) => Resolved) | undefined = ATOMS.has(tn)
    ? (x) => resolveAtomic(tn, x)
    : UNIONS[tn]
      ? (x) => resolveUnion(tn, x)
      : undefined;
  if (encoder) {
    if (slice) {
      if (nil) return { name, type, empty: true, value: new ResolvedArray([]) };
      if (!Array.isArray(v)) bad(`eip712 field ${name} is not of an array of interfaces`);
      return { name, type, empty: false, value: new ResolvedArray(v.map((x) => encoder(x))) };
    }
    return { name, type, empty: nil, value: encoder(v) };
  }

  // A struct. Its definition must be registered even when the value is absent.
  const def = structDef(tn);
  if (!def) bad(`eip712 field ${type}`);
  if (nil) return undefined;
  if (slice) {
    if (!Array.isArray(v)) bad(`eip712 field ${name} is not of an array of interfaces`);
    return { name, type, empty: false, value: new ResolvedArray(v.map((x) => resolveStruct(tn, def, x))) };
  }
  return { name, type, empty: false, value: resolveStruct(tn, def, v) };
}

const DOMAIN_FIELDS: readonly TypeField[] = [
  { name: 'name', type: 'string' },
  { name: 'version', type: 'string' },
  { name: 'chainId', type: 'uint256' },
];

/** A transaction (and, separately, the outer signature) as EIP-712 JSON, then hashed. */
function callHash(jtx: JsonObject, chainId: bigint | undefined): Uint8Array {
  // The Transaction envelope: header, signature, one field per user transaction body type.
  const envelope: (readonly [string, string])[] = [['header', 'TransactionHeader'], ['signature', 'SignatureMetadata'], ...TRANSACTION_BODIES];
  const message = resolveStruct('Transaction', envelope, jtx);
  const types: TypeSet = new Map([['EIP712Domain', DOMAIN_FIELDS.map((f) => ({ ...f }))]]);
  message.types(types);
  if (chainId === undefined) bad('missing chain ID');

  const messageHash = message.hash(types);
  const domain = resolveStruct('EIP712Domain', DOMAIN_FIELDS.map((f) => [f.name, f.type] as const), { name: 'Accumulate', version: '1.0.0', chainId: chainId.toString(10) });
  const domainHash = domain.hash(types);
  return keccak(concat([Uint8Array.of(0x19, 0x01), domainHash, messageHash]));
}

const TYPED_DATA_OMIT: ReadonlySet<string> = new Set(['signature', 'transactionHash']);

/**
 * protocol.EIP712Hash(txn, sig): `txn` is the decoded Transaction, `outer` the OUTERMOST signature (a DelegatedSignature chain
 * around a TypedDataSignature, or the TypedDataSignature itself).
 */
export function eip712Hash(txn: WireNode, outer: WireNode): Uint8Array {
  try {
    const delegators: Json[] = [];
    let inner = outer;
    while (inner.cls !== 'TypedDataSignature') {
      if (inner.cls !== 'DelegatedSignature') bad(`unsupported signature type ${inner.cls}`);
      const d = inner.fields.get('delegator');
      delegators.push(typeof d === 'string' ? goText(d) : '');
      const next = inner.fields.get('signature');
      if (!next || typeof next !== 'object' || !('cls' in next)) bad('a delegated signature that wraps nothing');
      inner = next as WireNode;
    }
    const jsig = toJson(inner, TYPED_DATA_OMIT);
    if (delegators.length) jsig.delegators = delegators;

    const headerNode = txn.fields.get('header');
    const jtx: JsonObject = { header: headerNode && typeof headerNode === 'object' && 'cls' in headerNode ? toJson(headerNode as WireNode) : {} };
    const bodyNode = txn.fields.get('body');
    if (!bodyNode || typeof bodyNode !== 'object' || !('cls' in bodyNode)) bad('the transaction has no body');
    const body = toJson(bodyNode as WireNode);
    const bodyType = body.type;
    if (typeof bodyType !== 'string') bad('the transaction body has no type');
    delete body.type;
    jtx[bodyType] = body;
    jtx.signature = jsig;

    const chain = inner.fields.get('chainID');
    return callHash(jtx, typeof chain === 'bigint' ? chain : undefined);
  } catch (e) {
    if (e instanceof Eip712Error) throw e;
    if (e instanceof WireError) throw new Eip712Error(e.message);
    throw e;
  }
}
