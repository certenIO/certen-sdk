/**
 * Accumulate objects, rebuilt from their JSON with accumulate-sdk-opendlt and re-encoded with ITS encoder. Nothing here
 * decodes binary: a value the verifier is handed as JSON is only ever trusted through the bytes the SDK produces from
 * it, which must then hash or verify exactly as the network's did.
 */
import { createPublicKey, verify as nodeVerify } from 'node:crypto';
import { core, messaging } from 'accumulate-sdk-opendlt';
import { encode } from 'accumulate-sdk-opendlt/encoding';
import { keccak256 as sdkKeccak256 } from 'accumulate-sdk-opendlt/common';
import { equal, fail, hexBytes, MerkleState, sha256, uvarint } from './bytes.js';

/**
 * The parts of accumulate-sdk-opendlt's objects this verifier uses, stated once. The SDK's classes are not exported with
 * types that cover every record, so each is reached through this narrow surface instead of `any`; what the verifier reads
 * back from them is the SDK's own rendering (`asObject`) or its own hash, never the document's JSON.
 */
export interface Rendered {
  asObject(): Record<string, unknown>;
}
export interface Hashable {
  hash(): Uint8Array;
}
interface SdkCore {
  Transaction: new (j: unknown) => Hashable & Rendered;
  NetworkDefinition: new (j: unknown) => Rendered;
  NetworkGlobals: new (j: unknown) => Rendered;
  Account: { fromObject(j: unknown): { url?: unknown } };
  Signature: { fromObject(j: unknown): object };
}
const sdk = core as unknown as SdkCore;

export function keccak256(data: Uint8Array): Uint8Array {
  return new Uint8Array(sdkKeccak256(data));
}

/**
 * The binary encoding of an object, as Go's encoding.Writer produces it: accumulate-sdk-opendlt's own encoder, which since
 * 2.5.0 writes an empty struct as the single byte 0x80 at every nesting and omits Go's zero time. test/upstream-encoder.test.ts
 * pins both against bytes Go produced.
 */
export function encodeObject(o: unknown): Uint8Array {
  if (!o || typeof o !== 'object') fail('cannot encode object: not an object');
  return new Uint8Array(encode(o));
}

/**
 * A SequencedMessage from JSON. accumulate-sdk-opendlt >= 2.5.0 registers the message classes, so the nested message is
 * built as its real class by Message.fromObject (test/upstream-encoder.test.ts pins its bytes against Go's).
 */
export function sequencedMessage(j: unknown, label: string): { message: { transaction: Hashable } } {
  if (!j || typeof j !== 'object') fail(`${label}: missing`);
  const n = j as Record<string, unknown>;
  if (n.type !== 'sequenced') fail(`${label}: is ${String(n.type)}, not a sequenced message`);
  return messaging.Message.fromObject(n as Parameters<typeof messaging.Message.fromObject>[0]) as unknown as { message: { transaction: Hashable } };
}

/** Message.Hash for a sequenced message: sha256 of its binary encoding (encoding.Hash). */
export function messageHash(msg: unknown): Uint8Array {
  return sha256(encodeObject(msg));
}

/** protocol.Transaction.GetHash, through the SDK's own TransactionBase.hash. */
export function transactionHash(tx: Hashable): Uint8Array {
  return new Uint8Array(tx.hash());
}

export function transaction(j: unknown, label: string): Hashable & Rendered {
  return build(label, j, (x) => new sdk.Transaction(x));
}

/**
 * An account from its JSON. A key page's transactionBlacklist arrives as a list of bit names and is a uint64 bitmask on
 * the wire (protocol.AllowedTransactionBit): accumulate-sdk-opendlt >= 2.5.0 packs it. A name the SDK does not know is
 * refused here by name, as a VerifyError, rather than escaping as a generic error.
 */
export function account(j: unknown, label: string): { url?: unknown } {
  if (!j || typeof j !== 'object') fail(`${label}: missing`);
  try {
    return sdk.Account.fromObject(j);
  } catch (e) {
    return fail(`${label}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** An SDK object from untrusted JSON: missing input, or anything the SDK's constructor rejects, is a named VerifyError. */
function build<T>(label: string, j: unknown, make: (j: unknown) => T): T {
  if (!j || typeof j !== 'object') fail(`${label}: missing`);
  try {
    return make(j);
  } catch (e) {
    return fail(`${label}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export function networkDefinition(j: unknown): Rendered {
  return build('network definition', j, (x) => new sdk.NetworkDefinition(x));
}

export function networkGlobals(j: unknown): Rendered {
  return build('network globals', j, (x) => new sdk.NetworkGlobals(x));
}

/** URL equality as Go's url.URL.Equal: case-insensitive. */
export function sameUrl(a: unknown, b: string): boolean {
  return typeof a === 'string' || (a && typeof (a as { toString?: unknown }).toString === 'function')
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
 * The signature types the Directory spine accepts. Go checks `protocol.KeySignature.Verify(nil, anchor)` and then matches
 * the signer's public key to an active Directory validator's, whose key is a 32-byte ed25519 key. The key signatures that
 * can carry such a key are ed25519, rcd1 and legacyED25519, and they are the three implemented; every other type (the
 * btc / eth / rsa / ecdsa / typed-data families carry keys that cannot equal a validator's, and Go's Verify rejects a key of
 * the wrong length) is refused by name here rather than guessed at.
 */
export const SPINE_SIGNATURE_TYPES = ['ed25519', 'rcd1', 'legacyED25519'] as const;

/**
 * KeySignature.Verify(nil, msg) for ed25519, rcd1 (verifySig, merkle=true: ed25519 over sha256(metadataHash || msgHash),
 * the metadata being the signature with its signature and transaction hash cleared, or else over sha256(initiatorMerkleHash
 * || msgHash) when the initiator can be formed: public key, signer, a non-zero signer version, a non-zero timestamp) and
 * legacyED25519 (verifySigSplit with sha256(that hash || uvarint(timestamp) || msgHash)).
 */
export function verifySignature(sigJson: unknown, msgHash: Uint8Array, label: string): boolean {
  if (!sigJson || typeof sigJson !== 'object') fail(`${label}: missing`);
  const s = sigJson as Record<string, unknown>;
  const type = String(s.type);
  if (!(SPINE_SIGNATURE_TYPES as readonly string[]).includes(type)) fail(`signature_type_unsupported: ${label}: signature type ${type} is not one this verifier supports (${SPINE_SIGNATURE_TYPES.join(', ')})`);
  const pub = hexBytes(s.publicKey, `${label}.publicKey`);
  const sig = hexBytes(s.signature, `${label}.signature`);
  if (pub.length !== 32 || sig.length !== 64) return false;

  const timestamp = s.timestamp === undefined ? 0n : BigInt(s.timestamp as number);
  const combine = (first: Uint8Array): Uint8Array => (type === 'legacyED25519' ? sha256(first, uvarint(timestamp), msgHash) : sha256(first, msgHash));

  const md: Record<string, unknown> = { ...s };
  delete md.signature;
  delete md.transactionHash;
  const mdHash = sha256(encodeObject(sdk.Signature.fromObject(md)));
  if (ed25519(pub, combine(mdHash), sig)) return true;

  const signerVersion = Number(s.signerVersion ?? 0);
  if (typeof s.signer !== 'string' || signerVersion === 0 || timestamp === 0n) return false;
  const init = new MerkleState();
  init.addEntry(sha256(pub));
  init.addEntry(sha256(new TextEncoder().encode(s.signer)));
  init.addEntry(sha256(uvarint(signerVersion)));
  init.addEntry(sha256(uvarint(timestamp)));
  const initHash = init.anchor();
  return initHash !== undefined && ed25519(pub, combine(initHash), sig);
}

export { equal };
