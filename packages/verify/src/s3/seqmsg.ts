/**
 * A delivered messaging.SequencedMessage from its portable JSON, as Go's Import re-encodes it (portable.go importSequenced / importAnchor:
 * json.Unmarshal into the message, then MarshalBinary). The messages a proof carries are the transaction message (an anchor), the
 * signature message (a vote's production) and the sequenced message that wraps them. Their JSON is read with the rules of the generated
 * unmarshalers (jsonwire.ts), their binary encoding is the generated MarshalBinary: the field number and value of each member present.
 */
import { fail, sha256 } from '../proof-v2/bytes.js';
import { binaryBytes, binaryString, canonicalAccTxId } from '../sigtypes/gourl.js';
import { transactionHash } from '../sigtypes/txhash.js';
import { encodeNode, type WireNode } from '../sigtypes/wire.js';
import { AccUrl } from './acc.js';
import { enumByName } from './enum-names.js';
import { nodeFromJson, unionFromJson } from './jsonwire.js';
import { nodeToJson } from './nodejson.js';

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

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** An object's member by Go's key matching: the exact name, else a case-insensitive one. */
function member(o: Record<string, unknown>, name: string): unknown {
  if (Object.prototype.hasOwnProperty.call(o, name)) return o[name];
  let hit: unknown;
  for (const k of Object.keys(o)) if (k.toLowerCase() === name.toLowerCase()) hit = o[k];
  return hit;
}

const describe = (v: unknown): string => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);

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
const lenBytes = (b: Uint8Array | number[]): number[] => [...uvarint(b.length), ...b];

/** A message's declared type must be its own; absent keeps its own (<Type>.UnmarshalJSON: "field Type: not equal"). */
function checkMessageType(o: Record<string, unknown>, want: string, label: string): void {
  const t = member(o, 'type');
  if (t === undefined) return;
  if (typeof t !== 'string') return fail(`${label}: json: cannot unmarshal ${describe(t)} into Go value of type string`);
  const e = enumByName('MessageType', t);
  if (e === undefined) return fail(`${label}: invalid Message Type ${JSON.stringify(t)}`);
  if (e !== enumByName('MessageType', want)) fail(`${label}: field Type: not equal: want ${want}, got ${t}`);
}

function urlField(o: Record<string, unknown>, name: string, label: string): AccUrl | undefined {
  const v = member(o, name);
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') return fail(`${label}: json: cannot unmarshal ${typeof v} into Go struct field .${name} of type url.URL`);
  const u = AccUrl.parse(v);
  if (!u) return fail(`${label}.${name}: ${JSON.stringify(v)} is not a URL`);
  return u;
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
  if (!isObj(j)) return fail(`${label}: json: cannot unmarshal ${describe(j)} into Go value of type Message`);
  const t = member(j, 'type');
  if (t === undefined) return fail(`${label}: invalid Message type (none)`);
  if (typeof t !== 'string') return fail(`${label}: json: cannot unmarshal ${describe(t)} into Go value of type string`);
  const tag = enumByName('MessageType', t);
  if (tag === undefined) return fail(`${label}: invalid Message Type ${JSON.stringify(t)}`);
  if (tag === enumByName('MessageType', 'transaction')) {
    checkMessageType(j, 'transaction', label);
    const tx = member(j, 'transaction');
    const out: number[] = [...uvarint(1), ...uvarint(tag)];
    let txn: WireNode | undefined;
    if (tx !== undefined && tx !== null) {
      txn = nodeFromJson('Transaction', tx, `${label}.transaction`);
      out.push(...uvarint(2), ...lenBytes(encodeNode(txn)));
    }
    return { kind: 'transaction', bin: Uint8Array.from(out), txn, canonical: { type: 'transaction', ...(txn ? { transaction: nodeToJson(txn) } : {}) } };
  }
  if (tag === enumByName('MessageType', 'signature')) {
    checkMessageType(j, 'signature', label);
    const sg = member(j, 'signature');
    const out: number[] = [...uvarint(1), ...uvarint(tag)];
    let sigHash: Uint8Array | undefined;
    const canonical: Record<string, unknown> = { type: 'signature' };
    if (sg !== undefined && sg !== null) {
      const node = unionFromJson('Signature', sg, `${label}.signature`);
      if (node) {
        const b = encodeNode(node);
        sigHash = sha256(b);
        out.push(...uvarint(2), ...lenBytes(b));
        canonical.signature = nodeToJson(node, 'Signature');
      }
    }
    const id = member(j, 'txID');
    if (id !== undefined && id !== null) {
      if (typeof id !== 'string') return fail(`${label}: json: cannot unmarshal ${typeof id} into Go struct field .txID of type url.TxID`);
      const c = canonicalAccTxId(binaryString(new TextEncoder().encode(id)));
      if (c === undefined) return fail(`${label}.txID: ${JSON.stringify(id)} is not a transaction id`);
      out.push(...uvarint(3), ...lenBytes(binaryBytes(c)));
      canonical.txID = new TextDecoder().decode(binaryBytes(c));
    }
    return { kind: 'signature', bin: Uint8Array.from(out), sigHash, canonical };
  }
  if (tag === enumByName('MessageType', 'sequenced')) {
    const inner = sequencedFromJson(j, label);
    return { kind: 'sequenced', bin: inner.bin, canonical: inner.canonical };
  }
  return fail(`${label}: a ${t} message is not read from JSON by this verifier`);
}

function sequencedFromJson(j: Record<string, unknown>, label: string): SeqMsg {
  checkMessageType(j, 'sequenced', label);
  const m = messageFromJson(member(j, 'message'), `${label}.message`);
  const source = urlField(j, 'source', label);
  const destination = urlField(j, 'destination', label);
  const nraw = member(j, 'number');
  let number = 0n;
  if (nraw !== undefined && nraw !== null) {
    if (typeof nraw !== 'number' || !Number.isInteger(nraw) || nraw < 0 || Object.is(nraw, -0)) {
      return fail(`${label}: json: cannot unmarshal ${typeof nraw === 'number' ? `number ${nraw}` : typeof nraw} into Go struct field .number of type uint64`);
    }
    number = BigInt(nraw);
  }
  const out: number[] = [...uvarint(1), ...uvarint(enumByName('MessageType', 'sequenced')!)];
  if (m) out.push(...uvarint(2), ...lenBytes(m.bin));
  if (source) out.push(...uvarint(3), ...lenBytes(new TextEncoder().encode(source.toString())));
  if (destination) out.push(...uvarint(4), ...lenBytes(new TextEncoder().encode(destination.toString())));
  if (number !== 0n) out.push(...uvarint(5), ...uvarint(number));
  const bin = Uint8Array.from(out);
  const canonical: Record<string, unknown> = { type: 'sequenced' };
  if (m) canonical.message = m.canonical;
  if (source) canonical.source = source.toString();
  if (destination) canonical.destination = destination.toString();
  if (number !== 0n) canonical.number = Number(number);
  const res: SeqMsg = { source, destination, number, hash: sha256(bin), bin, kind: m?.kind ?? 'nil', canonical };
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

/** importSequenced: a SequencedMessage from its JSON (portable.go importSequenced / importAnchor). */
export function importSequenced(j: unknown, label: string): SeqMsg {
  // JSON null unmarshals to the zero message; an absent value is not JSON at all.
  if (j === null) return sequencedFromJson({}, label);
  if (!isObj(j)) return fail(`${label}: json: cannot unmarshal ${describe(j)} into Go value of type messaging.SequencedMessage`);
  return sequencedFromJson(j, label);
}
