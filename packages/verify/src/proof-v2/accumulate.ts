/**
 * Accumulate objects, rebuilt from their JSON with accumulate-sdk-opendlt and re-encoded with ITS encoder. Nothing here
 * decodes binary: a value the verifier is handed as JSON is only ever trusted through the bytes the SDK produces from
 * it, which must then hash or verify exactly as the network's did.
 */
import { createPublicKey, verify as nodeVerify } from 'node:crypto';
import { core, messaging } from 'accumulate-sdk-opendlt';
import { bytesMarshalBinary, encode, Encoding, Hash, uvarintMarshalBinary } from 'accumulate-sdk-opendlt/encoding';
import { keccak256 as sdkKeccak256 } from 'accumulate-sdk-opendlt/common';
import { equal, fail, hexBytes, MerkleState, sha256, uvarint } from './bytes.js';

/**
 * Go marshals a zero time.Time to JSON as "0001-01-01T00:00:00Z" but omits it from the binary encoding; the SDK would
 * encode the string as a real time. Dropping it reproduces Go's bytes. Nothing else is altered.
 */
const ZERO_TIME = '0001-01-01T00:00:00Z';
export function normalize<T>(v: T): T {
  if (Array.isArray(v)) return v.map(normalize) as T;
  if (v && typeof v === 'object') {
    const o: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) if (x !== ZERO_TIME) o[k] = normalize(x);
    return o as T;
  }
  return v;
}

export function keccak256(data: Uint8Array): Uint8Array {
  return new Uint8Array(sdkKeccak256(data));
}

/**
 * The binary encoding of an object, as Go's encoding.Writer produces it.
 *
 * This walks the SDK's field metadata exactly as its encode() does (same field order, same skip rules for zero
 * hashes, falsy values and keepEmpty, embedded groups and repeated fields), with one difference that is Go's rule
 * rather than a choice: a struct that writes no field is written as the single byte 0x80 (encoding.EmptyObject,
 * writer.go Reset), at the top level and at every nesting. The SDK writes nothing there, so a data account that
 * inherits its authorities (an empty AccountAuth) would otherwise hash differently from the network's.
 */
const EMPTY_OBJECT = new Uint8Array([0x80]);

export function encodeObject(o: unknown): Uint8Array {
  const enc = (Encoding as any).get(o);
  if (!enc) fail('cannot encode object: no metadata');
  const out = encodeFields(o, enc.fields);
  return out.length === 0 ? EMPTY_OBJECT : out;
}

function encodeFields(target: any, fields: any[]): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const field of fields) {
    const value = field.type?.embedding ? target : target?.[field.name];
    const emit = (v: any) => {
      if (field.type?.embedding) {
        // Embedded fields are always written (encodeValue never skips them).
      } else if (field.type instanceof (Hash as any)) {
        if (!field.keepEmpty && isZeroHash(v)) return;
      } else if (!field.keepEmpty && !v) {
        return;
      }
      parts.push(new Uint8Array(uvarintMarshalBinary(field.number)));
      if (field.type?.embedding) {
        const inner = encodeFields(v, field.embedded ?? []);
        parts.push(new Uint8Array(bytesMarshalBinary(inner.length === 0 ? EMPTY_OBJECT : inner)));
      } else if (field.type?.composite) {
        parts.push(new Uint8Array(bytesMarshalBinary(encodeObject(v))));
      } else {
        parts.push(new Uint8Array(field.type.encode(v)));
      }
    };
    if (!field.repeatable) emit(value);
    else if (value) for (const item of value) emit(item);
  }
  return new Uint8Array(Buffer.concat(parts));
}

function isZeroHash(v: any): boolean {
  if (!v) return true;
  for (const b of v) if (b !== 0) return false;
  return true;
}

/** The SDK's own encode(), kept only to show in tests that the two agree wherever no struct is empty. */
export function sdkEncode(o: unknown): Uint8Array {
  return new Uint8Array(encode(o));
}

/**
 * A SequencedMessage from JSON. The SDK's generated message types resolve a nested message through a loader that is
 * never installed (messaging/types_gen.ts getMessageClass falls back to returning the plain object), so the nested
 * message is built here through the union factory, which is wired.
 */
export function sequencedMessage(j: unknown, label: string): any {
  if (!j || typeof j !== 'object') fail(`${label}: missing`);
  const n = normalize(j) as Record<string, unknown>;
  if (n.type !== 'sequenced') fail(`${label}: is ${String(n.type)}, not a sequenced message`);
  const msg = messaging.Message.fromObject(n as any) as any;
  if (n.message !== undefined) msg.message = messaging.Message.fromObject(n.message as any);
  return msg;
}

/** Message.Hash for a sequenced message: sha256 of its binary encoding (encoding.Hash). */
export function messageHash(msg: any): Uint8Array {
  return sha256(encodeObject(msg));
}

/** protocol.Transaction.GetHash, through the SDK's own TransactionBase.hash. */
export function transactionHash(tx: any): Uint8Array {
  return new Uint8Array(tx.hash());
}

export function transaction(j: unknown, label: string): any {
  if (!j || typeof j !== 'object') fail(`${label}: missing`);
  return new (core as any).Transaction(normalize(j));
}

/**
 * protocol.AllowedTransactionBit (enums.yml): a key page's transaction blacklist is a uint64 bitmask of these, the OR
 * of 1 << bit, marshalled to JSON as the list of names and written as an enum varint. The SDK models the field as a
 * list of transaction types and cannot encode it, so the mask is computed here. An unknown name is refused.
 */
const ALLOWED_TRANSACTION_BITS: Record<string, number> = { updateKeyPage: 1, updateAccountAuth: 2 };

function blacklistMask(names: unknown, label: string): number {
  if (!Array.isArray(names)) fail(`${label}: transactionBlacklist is not a list`);
  let mask = 0;
  for (const n of names) {
    const bit = ALLOWED_TRANSACTION_BITS[String(n)];
    if (bit === undefined) fail(`${label}: unknown transaction blacklist bit ${String(n)}`);
    mask |= 1 << bit;
  }
  return mask;
}

export function account(j: unknown, label: string): any {
  if (!j || typeof j !== 'object') fail(`${label}: missing`);
  const n = normalize(j) as Record<string, unknown>;
  const a = (core as any).Account.fromObject(n);
  if (n.type === 'keyPage' && n.transactionBlacklist !== undefined) a.transactionBlacklist = blacklistMask(n.transactionBlacklist, label);
  return a;
}

export function networkDefinition(j: unknown): any {
  return new (core as any).NetworkDefinition(normalize(j));
}

export function networkGlobals(j: unknown): any {
  return new (core as any).NetworkGlobals(normalize(j));
}

/** URL equality as Go's url.URL.Equal: case-insensitive. */
export function sameUrl(a: unknown, b: string): boolean {
  return typeof a === 'string' || (a && typeof (a as any).toString === 'function')
    ? String(a).toLowerCase() === b.toLowerCase()
    : false;
}

const ED25519_SPKI = Buffer.from('302a300506032b6570032100', 'hex');

function ed25519(pub: Uint8Array, msg: Uint8Array, sig: Uint8Array): boolean {
  try {
    const key = createPublicKey({ key: Buffer.concat([ED25519_SPKI, Buffer.from(pub)]), format: 'der', type: 'spki' });
    return nodeVerify(null, msg, key, sig);
  } catch {
    return false;
  }
}

/**
 * protocol.ED25519Signature.Verify(nil, msg) - verifySig with merkle=true: the signature verifies over
 * sha256(metadataHash || msgHash), where the metadata is the signature with its signature and transaction hash
 * cleared, or else over sha256(initiatorMerkleHash || msgHash) when the initiator can be formed (public key, signer,
 * a non-zero signer version and a non-zero timestamp).
 *
 * Only ed25519 is implemented. Accumulate's validators sign anchors with ed25519 keys; any other type is refused by
 * name rather than guessed at.
 */
export function verifySignature(sigJson: unknown, msgHash: Uint8Array, label: string): boolean {
  if (!sigJson || typeof sigJson !== 'object') fail(`${label}: missing`);
  const s = normalize(sigJson) as Record<string, unknown>;
  if (s.type !== 'ed25519') fail(`${label}: signature type ${String(s.type)} is not supported by this verifier`);
  const pub = hexBytes(s.publicKey, `${label}.publicKey`);
  const sig = hexBytes(s.signature, `${label}.signature`);
  if (pub.length !== 32 || sig.length !== 64) return false;

  const md: Record<string, unknown> = { ...s };
  delete md.signature;
  delete md.transactionHash;
  const mdHash = sha256(encodeObject((core as any).Signature.fromObject(md)));
  if (ed25519(pub, sha256(mdHash, msgHash), sig)) return true;

  const signerVersion = Number(s.signerVersion ?? 0);
  const timestamp = s.timestamp === undefined ? 0n : BigInt(s.timestamp as number);
  if (typeof s.signer !== 'string' || signerVersion === 0 || timestamp === 0n) return false;
  const init = new MerkleState();
  init.addEntry(sha256(pub));
  init.addEntry(sha256(new TextEncoder().encode(s.signer)));
  init.addEntry(sha256(uvarint(signerVersion)));
  init.addEntry(sha256(uvarint(timestamp)));
  const initHash = init.anchor();
  return initHash !== undefined && ed25519(pub, sha256(initHash, msgHash), sig);
}

export { equal };
