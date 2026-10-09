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
 * A SequencedMessage from JSON. The SDK's generated message types resolve a nested message through a loader that is
 * never installed (messaging/types_gen.ts getMessageClass falls back to returning the plain object), so the nested
 * message is built here through the union factory, which is wired.
 */
export function sequencedMessage(j: unknown, label: string): any {
  if (!j || typeof j !== 'object') fail(`${label}: missing`);
  const n = j as Record<string, unknown>;
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
  return new (core as any).Transaction(j);
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
  const n = j as Record<string, unknown>;
  const a = (core as any).Account.fromObject(n);
  if (n.type === 'keyPage' && n.transactionBlacklist !== undefined) a.transactionBlacklist = blacklistMask(n.transactionBlacklist, label);
  return a;
}

export function networkDefinition(j: unknown): any {
  return new (core as any).NetworkDefinition(j);
}

export function networkGlobals(j: unknown): any {
  return new (core as any).NetworkGlobals(j);
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
  const s = sigJson as Record<string, unknown>;
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
