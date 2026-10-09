/**
 * A binary decoder for the two records a network update writes: protocol.NetworkDefinition (acc://dn.acme/network) and
 * protocol.NetworkGlobals (acc://dn.acme/globals). accumulate-sdk-opendlt encodes them but cannot decode them, and the
 * spine must apply a proven write to either, as Go's GlobalValues.ParseNetwork / ParseGlobals does.
 *
 * The decoder is deliberately small and strict, and it is not trusted on its own. Every decode is checked by building the
 * SDK's object from the result and encoding it again with the SDK's encoder: the bytes must equal the record that was
 * written. A field the decoder misread, skipped or invented cannot survive that, so what the spine goes on to use is
 * exactly what the writer put on the chain. Anything else is refused by name (network_update_undecodable), which only
 * ever refuses more than Go does, and only for a record Go's own marshaller could not have produced.
 *
 * Wire format (encoding.Writer): each present field is `uvarint(field number)` then its value; a nested struct is
 * `uvarint(length) || fields`, an empty struct being the single byte 0x80; strings and bytes are length-prefixed; bool is one
 * byte; ints are uvarints; a duration is uvarint seconds then uvarint nanoseconds; fields ascend.
 */
import { encodeObject, networkDefinition, networkGlobals } from './accumulate.js';
import { equal, fail, toHex } from './bytes.js';

const EMPTY_OBJECT = 0x80;

class Reader {
  pos = 0;
  constructor(readonly b: Uint8Array, readonly label: string) {}

  done(): boolean {
    return this.pos >= this.b.length;
  }

  uvarint(what: string): bigint {
    let x = 0n;
    let shift = 0n;
    for (let i = 0; i < 10; i++) {
      if (this.pos >= this.b.length) fail(`network_update_undecodable: ${this.label}: ${what}: truncated`);
      const c = this.b[this.pos++];
      x |= BigInt(c & 0x7f) << shift;
      if (c < 0x80) return x;
      shift += 7n;
    }
    return fail(`network_update_undecodable: ${this.label}: ${what}: varint overflows`);
  }

  number(what: string): number {
    const v = this.uvarint(what);
    if (v > BigInt(Number.MAX_SAFE_INTEGER)) fail(`network_update_undecodable: ${this.label}: ${what}: ${v} exceeds 2^53`);
    return Number(v);
  }

  bytes(what: string): Uint8Array {
    const n = this.number(`${what} length`);
    if (this.pos + n > this.b.length) fail(`network_update_undecodable: ${this.label}: ${what}: ${n} bytes declared, ${this.b.length - this.pos} left`);
    const out = this.b.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }

  string(what: string): string {
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(this.bytes(what));
    } catch (e) {
      return fail(`network_update_undecodable: ${this.label}: ${what}: ${e instanceof Error ? e.message : 'not UTF-8'}`);
    }
  }

  bool(what: string): boolean {
    if (this.pos >= this.b.length) fail(`network_update_undecodable: ${this.label}: ${what}: truncated`);
    const c = this.b[this.pos++];
    if (c > 1) fail(`network_update_undecodable: ${this.label}: ${what}: ${c} is not a boolean`);
    return c === 1;
  }
}

type Kind = 'string' | 'uint' | 'bool' | 'bytes' | 'hash' | 'url' | 'duration' | 'enum' | { ref: Schema } | { refs: Schema };
interface FieldSpec {
  n: number;
  name: string;
  kind: Kind;
  repeated?: boolean;
}
type Schema = { name: string; fields: FieldSpec[] };

const RATIONAL: Schema = { name: 'Rational', fields: [{ n: 1, name: 'numerator', kind: 'uint' }, { n: 2, name: 'denominator', kind: 'uint' }] };
const FEE_SCHEDULE: Schema = {
  name: 'FeeSchedule',
  fields: [
    { n: 1, name: 'createIdentitySliding', kind: 'enum', repeated: true },
    { n: 2, name: 'createSubIdentity', kind: 'enum' },
    { n: 3, name: 'bareIdentityDiscount', kind: 'enum' },
  ],
};
const LIMITS: Schema = {
  name: 'NetworkLimits',
  fields: [
    { n: 1, name: 'dataEntryParts', kind: 'uint' },
    { n: 2, name: 'accountAuthorities', kind: 'uint' },
    { n: 3, name: 'bookPages', kind: 'uint' },
    { n: 4, name: 'pageEntries', kind: 'uint' },
    { n: 5, name: 'identityAccounts', kind: 'uint' },
    { n: 6, name: 'pendingMajorBlocks', kind: 'uint' },
    { n: 7, name: 'eventsPerBlock', kind: 'uint' },
  ],
};
const GLOBALS: Schema = {
  name: 'NetworkGlobals',
  fields: [
    { n: 1, name: 'operatorAcceptThreshold', kind: { ref: RATIONAL } },
    { n: 2, name: 'validatorAcceptThreshold', kind: { ref: RATIONAL } },
    { n: 3, name: 'majorBlockSchedule', kind: 'string' },
    { n: 4, name: 'anchorEmptyBlocks', kind: 'bool' },
    { n: 5, name: 'feeSchedule', kind: { ref: FEE_SCHEDULE } },
    { n: 6, name: 'limits', kind: { ref: LIMITS } },
    { n: 7, name: 'blockInterval', kind: 'duration' },
  ],
};
const PARTITION: Schema = { name: 'PartitionInfo', fields: [{ n: 1, name: 'id', kind: 'string' }, { n: 2, name: 'type', kind: 'enum' }] };
const VALIDATOR_PARTITION: Schema = { name: 'ValidatorPartitionInfo', fields: [{ n: 1, name: 'id', kind: 'string' }, { n: 2, name: 'active', kind: 'bool' }] };
const VALIDATOR: Schema = {
  name: 'ValidatorInfo',
  fields: [
    { n: 1, name: 'publicKey', kind: 'bytes' },
    { n: 2, name: 'publicKeyHash', kind: 'hash' },
    { n: 3, name: 'operator', kind: 'url' },
    { n: 4, name: 'partitions', kind: { refs: VALIDATOR_PARTITION }, repeated: true },
  ],
};
const DEFINITION: Schema = {
  name: 'NetworkDefinition',
  fields: [
    { n: 1, name: 'networkName', kind: 'string' },
    { n: 2, name: 'version', kind: 'uint' },
    { n: 3, name: 'partitions', kind: { refs: PARTITION }, repeated: true },
    { n: 4, name: 'validators', kind: { refs: VALIDATOR }, repeated: true },
  ],
};

function readStruct(r: Reader, s: Schema, depth = 0): Record<string, unknown> {
  if (depth > 4) fail(`network_update_undecodable: ${r.label}: ${s.name}: nested too deeply`);
  const out: Record<string, unknown> = {};
  // An empty struct is the single byte 0x80 (encoding.Writer).
  if (r.b.length - r.pos === 1 && r.b[r.pos] === EMPTY_OBJECT) {
    r.pos++;
    return out;
  }
  let last = 0;
  while (!r.done()) {
    const n = r.number(`${s.name} field number`);
    const f = s.fields.find((x) => x.n === n);
    if (!f) fail(`network_update_undecodable: ${r.label}: ${s.name}: unknown field ${n}`);
    // Fields ascend; only a repeated field may recur, once per element.
    if (n < last || (n === last && !f.repeated)) fail(`network_update_undecodable: ${r.label}: ${s.name}: field ${n} after ${last} (fields must ascend)`);
    last = n;
    const where = `${s.name}.${f.name}`;
    const one = (): unknown => {
      const k = f.kind;
      if (typeof k === 'object') {
        const inner = new Reader(r.bytes(where), r.label);
        return readStruct(inner, 'ref' in k ? k.ref : k.refs, depth + 1);
      }
      switch (k) {
        case 'string': return r.string(where);
        case 'uint': return r.number(where);
        case 'enum': return r.number(where);
        case 'bool': return r.bool(where);
        case 'bytes': return toHex(r.bytes(where));
        case 'url': return r.string(where);
        case 'hash': {
          if (r.pos + 32 > r.b.length) fail(`network_update_undecodable: ${r.label}: ${where}: truncated hash`);
          const h = r.b.subarray(r.pos, r.pos + 32);
          r.pos += 32;
          return toHex(h);
        }
        case 'duration': return { seconds: r.number(`${where} seconds`), nanoseconds: r.number(`${where} nanoseconds`) };
      }
    };
    // A repeated field is one occurrence per element, in order; a repeated field with no elements is simply absent.
    if (f.repeated) ((out[f.name] ??= []) as unknown[]).push(one());
    else if (f.name in out) fail(`network_update_undecodable: ${r.label}: ${where}: appears twice`);
    else out[f.name] = one();
  }
  return out;
}

function decode(bytes: Uint8Array, schema: Schema, build: (args: unknown) => any, label: string): any {
  const args = readStruct(new Reader(bytes, label), schema);
  let obj: any;
  try {
    obj = build(args);
  } catch (e) {
    return fail(`network_update_undecodable: ${label}: ${e instanceof Error ? e.message : String(e)}`);
  }
  // The proof that the decoder read every byte as the writer meant it.
  if (!equal(encodeObject(obj), bytes)) {
    fail(`network_update_undecodable: ${label}: the decoded ${schema.name} does not encode back to the written record`);
  }
  return obj;
}

/** protocol.NetworkDefinition from the single entry of a write to acc://dn.acme/network. */
export function decodeNetworkDefinition(bytes: Uint8Array): any {
  return decode(bytes, DEFINITION, networkDefinition, 'network definition');
}

/** protocol.NetworkGlobals from the single entry of a write to acc://dn.acme/globals. */
export function decodeNetworkGlobals(bytes: Uint8Array): any {
  return decode(bytes, GLOBALS, networkGlobals, 'network globals');
}

export const NETWORK_RECORD_SCHEMAS = { definition: DEFINITION, globals: GLOBALS } as const;
export type { Schema as NetworkRecordSchema };
