/**
 * A delivered messaging.SequencedMessage from its portable JSON, as Go's Import re-encodes it (portable.go importSequenced / importAnchor:
 * json.Unmarshal into the message, then MarshalBinary). The messages a proof carries are the transaction message (an anchor), the
 * signature message (a vote's production) and the sequenced message that wraps them. Their JSON is read with the rules of the generated
 * unmarshalers (jsonwire.ts), their binary encoding is the generated MarshalBinary: the field number and value of each member present.
 */
import { fail, sha256 } from '../proof-v2/bytes.js';
import { app, cat } from './bytebuf.js';
import { binaryBytes, binaryString, canonicalAccTxId } from '../sigtypes/gourl.js';
import { transactionHash } from '../sigtypes/txhash.js';
import { encodeNode, type WireNode } from '../sigtypes/wire.js';
import { AccUrl } from './acc.js';
import { enumByName } from './enum-names.js';
import { nodeFromJson, unionFromJson } from './jsonwire.js';
import { nodeToJson } from './nodejson.js';
import { BadNum, mergedPairs, Occ, occurrences, oneOf } from './occ.js';
import { u64big } from './gojson.js';

/** A delivered messaging.SequencedMessage, decoded: what the verifier reads of an anchor and of a production. */
export interface SeqMsg {
  source?: AccUrl;
  destination?: AccUrl;
  number: bigint;
  /** sha256 of the binary encoding (encoding.Hash). */
  hash: Uint8Array;
  /** The binary encoding (MarshalBinary). */
  bin: Uint8Array;
  /** The wrapped message: 'transaction' (messaging.TransactionMessage), 'signature', 'sequenced', or 'nil'. */
  kind: string;
  /** For a transaction message: the transaction and its hash; absent for a nil transaction. */
  txn?: WireNode;
  txnHash?: Uint8Array;
  /** For a signature message: sha256 of the wrapped signature's binary encoding (SignatureMessage.Hash). */
  sigHash?: Uint8Array;
  /** The message as Go marshals it to JSON: the spelling the spine's walk reads. */
  canonical: Record<string, unknown>;
}

const describe = (v: unknown): string => (v instanceof BadNum ? 'number' : v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);

function uvarint(v: number | bigint): number[] {
  let x = BigInt(v);
  const out: number[] = [];
  while (x >= 0x80n) {
    out.push(Number(x & 0x7fn) | 0x80);
    x >>= 7n;
  }
  out.push(Number(x));
  return out;
}
const lenBytes = (b: Uint8Array | number[]): number[] => cat(uvarint(b.length), b);

type Pairs = [string, unknown][];

/** A message's declared type must be its own; absent keeps its own (<Type>.UnmarshalJSON: "field Type: not equal"). Every occurrence is decoded. */
function checkMessageType(pairs: Pairs, want: string, label: string): void {
  for (const t of occurrences(pairs, 'type')) {
    if (typeof t !== 'string') return fail(`${label}: json: cannot unmarshal ${describe(t)} into Go value of type string`);
    const e = enumByName('MessageType', t);
    if (e === undefined) return fail(`${label}: invalid Message Type ${JSON.stringify(t)}`);
    if (e !== enumByName('MessageType', want)) fail(`${label}: field Type: not equal: want ${want}, got ${t}`);
  }
}

/** A *url.URL member: each occurrence is parsed, a null clears it, the last one stands. */
function urlField(pairs: Pairs, name: string, label: string): AccUrl | undefined {
  let out: AccUrl | undefined;
  for (const v of occurrences(pairs, name)) {
    if (v === undefined) continue;
    if (v === null) {
      out = undefined;
      continue;
    }
    if (typeof v !== 'string') return fail(`${label}: json: cannot unmarshal ${describe(v)} into Go struct field .${name} of type url.URL`);
    const u = AccUrl.parse(v);
    if (!u) return fail(`${label}.${name}: ${JSON.stringify(v)} is not a URL`);
    out = u;
  }
  return out;
}

interface MsgOut {
  kind: string;
  bin: Uint8Array;
  txn?: WireNode;
  sigHash?: Uint8Array;
  canonical: Record<string, unknown>;
}

/** A message from its JSON (UnmarshalMessageJSON, then MarshalBinary): the transaction, signature and sequenced messages. */
function messageFromJson(j: unknown, label: string): MsgOut | null {
  if (j === null || j === undefined) return null;
  const pairs = mergedPairs(j);
  if (pairs === undefined) return fail(`${label}: json: cannot unmarshal ${describe(j)} into Go value of type Message`);
  let t: string | undefined;
  for (const x of occurrences(pairs, 'type')) {
    if (typeof x !== 'string') return fail(`${label}: json: cannot unmarshal ${describe(x)} into Go value of type string`);
    t = x;
  }
  if (t === undefined) return fail(`${label}: invalid Message type (none)`);
  const tag = enumByName('MessageType', t);
  if (tag === undefined) return fail(`${label}: invalid Message Type ${JSON.stringify(t)}`);
  if (tag === enumByName('MessageType', 'transaction')) {
    checkMessageType(pairs, 'transaction', label);
    // Transaction *protocol.Transaction: the objects of every occurrence decode into the one transaction, a null leaves it
    const txs = occurrences(pairs, 'transaction').filter((x) => x !== undefined && x !== null);
    const out: number[] = cat(uvarint(1), uvarint(tag));
    let txn: WireNode | undefined;
    if (txs.length > 0) {
      txn = nodeFromJson('Transaction', txs.length === 1 ? txs[0] : new Occ(txs), `${label}.transaction`);
      app(out, uvarint(2), lenBytes(encodeNode(txn)));
    }
    return { kind: 'transaction', bin: Uint8Array.from(out), txn, canonical: { type: 'transaction', ...(txn ? { transaction: nodeToJson(txn) } : {}) } };
  }
  if (tag === enumByName('MessageType', 'signature')) {
    checkMessageType(pairs, 'signature', label);
    const out: number[] = cat(uvarint(1), uvarint(tag));
    let sigHash: Uint8Array | undefined;
    const canonical: Record<string, unknown> = { type: 'signature' };
    // the signature union: every occurrence is unmarshalled, a later one replaces an earlier one
    let node: WireNode | null = null;
    for (const sg of occurrences(pairs, 'signature')) {
      if (sg === undefined) continue;
      node = unionFromJson('Signature', sg, `${label}.signature`);
    }
    if (node) {
      const b = encodeNode(node);
      sigHash = sha256(b);
      app(out, uvarint(2), lenBytes(b));
      canonical.signature = nodeToJson(node, 'Signature');
    }
    let txid: string | undefined;
    for (const id of occurrences(pairs, 'txID')) {
      if (id === undefined) continue;
      if (id === null) {
        txid = undefined;
        continue;
      }
      if (typeof id !== 'string') return fail(`${label}: json: cannot unmarshal ${describe(id)} into Go struct field .txID of type url.TxID`);
      const c = canonicalAccTxId(binaryString(new TextEncoder().encode(id)));
      if (c === undefined) return fail(`${label}.txID: ${JSON.stringify(id)} is not a transaction id`);
      txid = c;
    }
    if (txid !== undefined) {
      app(out, uvarint(3), lenBytes(binaryBytes(txid)));
      canonical.txID = new TextDecoder().decode(binaryBytes(txid));
    }
    return { kind: 'signature', bin: Uint8Array.from(out), sigHash, canonical };
  }
  if (tag === enumByName('MessageType', 'sequenced')) {
    const inner = sequencedFromPairs(pairs, label);
    return { kind: 'sequenced', bin: inner.bin, canonical: inner.canonical };
  }
  return fail(`${label}: a ${t} message is not read from JSON by this verifier`);
}

function sequencedFromPairs(pairs: Pairs, label: string): SeqMsg {
  checkMessageType(pairs, 'sequenced', label);
  // the message union: every occurrence is unmarshalled, a later one replaces an earlier one
  let m: MsgOut | null = null;
  for (const x of occurrences(pairs, 'message')) {
    if (x === undefined) continue;
    m = messageFromJson(x, `${label}.message`);
  }
  const source = urlField(pairs, 'source', label);
  const destination = urlField(pairs, 'destination', label);
  const number = u64big(oneOf(occurrences(pairs, 'number')), `${label}.number`);
  const out: number[] = cat(uvarint(1), uvarint(enumByName('MessageType', 'sequenced')!));
  if (m) app(out, uvarint(2), lenBytes(m.bin));
  if (source) app(out, uvarint(3), lenBytes(new TextEncoder().encode(source.toString())));
  if (destination) app(out, uvarint(4), lenBytes(new TextEncoder().encode(destination.toString())));
  if (number !== 0n) app(out, uvarint(5), uvarint(number));
  const bin = Uint8Array.from(out);
  const canonical: Record<string, unknown> = { type: 'sequenced' };
  if (m) canonical.message = m.canonical;
  if (source) canonical.source = source.toString();
  if (destination) canonical.destination = destination.toString();
  if (number !== 0n) canonical.number = Number(number);
  const res: SeqMsg = { source, destination, number, hash: sha256(bin), bin, kind: m?.kind ?? 'nil', canonical };
  sequencedHashes.set(canonical, res.hash);
  if (m?.kind === 'transaction' && m.txn) {
    res.txn = m.txn;
    // A transaction with no body has no hash: the anchor check refuses it by name before the hash is read.
    try {
      res.txnHash = transactionHash(m.txn);
    } catch {
      res.txnHash = undefined;
    }
  }
  if (m?.kind === 'signature') res.sigHash = m.sigHash;
  return res;
}

/**
 * The hash of the message a canonical JSON came from: sha256 of its binary form as Go decodes it, extra data included (messaging.SequencedMessage.Hash
 * of the decoded struct). A trailing field in any nested value of the message is part of what the validators signed over, so the quorum is checked
 * against this hash and not against a re-encoding of the canonical JSON, which has no place for it.
 */
const sequencedHashes = new WeakMap<object, Uint8Array>();
export const sequencedHashOf = (canonical: object): Uint8Array | undefined => sequencedHashes.get(canonical);

/** importSequenced: a SequencedMessage from its JSON (portable.go importSequenced / importAnchor). */
export function importSequenced(j: unknown, label: string): SeqMsg {
  // JSON null unmarshals to the zero message; an absent value is not JSON at all.
  if (j === null) return sequencedFromPairs([], label);
  const pairs = mergedPairs(j);
  if (pairs === undefined) return fail(`${label}: json: cannot unmarshal ${describe(j)} into Go value of type messaging.SequencedMessage`);
  return sequencedFromPairs(pairs, label);
}
