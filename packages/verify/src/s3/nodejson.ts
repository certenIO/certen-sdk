/**
 * The JSON Go marshals for a decoded wire object (the generated MarshalJSON of the protocol types): exact field names, enum names in their
 * canonical spelling, hashes and bytes as lower-case hex, URLs as the parser writes them. The proof's older readers (the spine walk of
 * proof-v2/) expect exactly this spelling, so a document whose JSON Go reads in another (equally valid) spelling - another key case, another
 * name case, a URL without its scheme - is handed to them in the spelling they read, after Go's rules have decided what it means.
 */
import { core } from 'accumulate-sdk-opendlt';
import { TRANSACTION_TYPE_NAMES } from '../sigtypes/eip712-schema.js';
import { binaryBytes } from '../sigtypes/gourl.js';
import { flatFields, registryType, type TimeValue, type Value, type WireNode } from '../sigtypes/wire.js';

interface Named {
  getName(v: number): string;
}
const sdk = core as unknown as Record<string, Named>;

/** The canonical name of a union member's type tag. */
function typeName(union: string, tag: bigint): string | number {
  const n = Number(tag);
  try {
    switch (union) {
      case 'TransactionBody':
      case 'TransactionResult': {
        const t = Object.prototype.hasOwnProperty.call(TRANSACTION_TYPE_NAMES, n) ? TRANSACTION_TYPE_NAMES[n] : undefined;
        return t ?? n;
      }
      case 'Account':
        return sdk.AccountType!.getName(n);
      case 'Signature':
      case 'KeySignature':
        return sdk.SignatureType!.getName(n);
      case 'DataEntry':
        return sdk.DataEntryType!.getName(n);
      case 'KeyPageOperation':
        return sdk.KeyPageOperationType!.getName(n);
      case 'AccountAuthOperation':
        return sdk.AccountAuthOperationType!.getName(n);
    }
  } catch {
    /* a tag the SDK has no name for */
  }
  return n;
}

/**
 * The heights a spine compares are uint64 in Go. The canonical JSON carries a number, which holds a uint64 exactly up to 2^53 - 1 only; for the
 * members below it keeps the exact value of a larger one on the side, keyed by the object it is a member of, so that the reader of the anchor
 * (proof-v2/shapes.ts anchorBody) takes the value Go decoded and not its nearest double. A reader that finds an unsafe number without an exact
 * value refuses it: a height is never rounded.
 */
const EXACT_UINTS = new Set(['minorBlockIndex', 'rootChainIndex']);
const exactUints = new WeakMap<object, Map<string, bigint>>();
export function exactUint(o: object, name: string): bigint | undefined {
  return exactUints.get(o)?.get(name);
}

const utf8 = new TextDecoder('utf-8');
const text = (bin: string): string => utf8.decode(binaryBytes(bin));
const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex');

function timeJson(t: TimeValue): string {
  const ms = Number(t.seconds) * 1000;
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '0001-01-01T00:00:00Z';
  const iso = d.toISOString();
  return iso.replace(/\.000Z$/, 'Z');
}

/** union: the name of the union a field of this class holds, for the type tag of its members. */
function jsonOf(v: Value, union: string | undefined): unknown {
  if (v === null) return null;
  if (typeof v === 'bigint') return Number(v);
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') return text(v);
  if (v instanceof Uint8Array) return hex(v);
  if (Array.isArray(v)) return v.map((x) => jsonOf(x, union));
  if ('seconds' in v && !('cls' in v)) return timeJson(v as TimeValue);
  return nodeToJson(v as WireNode, union);
}

/** nodeToJson: the object as Go's MarshalJSON writes it. `union` names the union the object is a member of (its `type` is that union's name). */
export function nodeToJson(n: WireNode, union?: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const tag = n.fields.get('type');
  if (union && typeof tag === 'bigint') out.type = typeName(union, tag);
  for (const d of flatFields(n.cls)) {
    if (d.name === 'type' && union) continue;
    const v = n.fields.get(d.name);
    if (v === undefined) continue;
    let u: string | undefined;
    if (d.kind === 'union') u = unionOf(n.cls, d.name);
    if (d.kind === 'enum' && !d.repeatable && typeof v === 'bigint') {
      const e = d.enumType;
      if (e) {
        try {
          out[d.name] = e.getName(Number(v));
          continue;
        } catch {
          /* no name: the number */
        }
      }
    }
    if (typeof v === 'bigint' && v > BigInt(Number.MAX_SAFE_INTEGER) && EXACT_UINTS.has(d.name)) {
      const m = exactUints.get(out) ?? new Map<string, bigint>();
      m.set(d.name, v);
      exactUints.set(out, m);
    }
    out[d.name] = jsonOf(v, u);
  }
  return out;
}

function unionOf(cls: string, field: string): string | undefined {
  return registryType(cls, field);
}
