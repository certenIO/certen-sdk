/**
 * Receipts and sequenced messages from their portable JSON, with the binary encodings Go's Import computes (portable.go receiptHex,
 * importSequenced): the bytes are what the document commits to wherever it carries the value (govRoot v4's vote encoding, the budget).
 */
import { type Receipt } from '../proof-v2/bytes.js';
import { Occ } from './occ.js';
import { encodeNode, type WireNode } from '../sigtypes/wire.js';
import { bool, goHex, i64big, intoSlice, JsonError, strptr, struct } from './gojson.js';

// --------------------------------------------------------------------------------------------------------------------------------
// receipts

/** A merkle.Receipt in the form the verifier needs, with the binary encoding Go's MarshalBinary writes for it. */
export interface Rcpt extends Receipt {
  /** merkle.Receipt.MarshalBinary of the receipt as the document gave it (start, startIndex, end, endIndex, anchor, entries). */
  bin: Uint8Array;
}

/** encoding.BytesFromJSON over a *string member: every occurrence is a string or null, the last one is hex. */
function bytesJson(member: unknown, label: string): Uint8Array {
  const v = strptr(member, label);
  if (v === undefined) return new Uint8Array(0);
  const b = goHex(v);
  if (!b) throw new JsonError(`error decoding ${label}: encoding/hex: invalid byte`);
  return b;
}

/** receiptHex: a merkle.Receipt from its JSON (Receipt.UnmarshalJSON) and its binary form (MarshalBinary). */
export function importReceipt(j: unknown, label: string): Rcpt {
  // A json.RawMessage that is absent is empty, and json.Unmarshal of nothing is an error; a JSON null is the zero receipt.
  if (j === undefined) throw new JsonError(`${label}: unexpected end of JSON input`);
  const s = struct(j, ['start', 'startIndex', 'end', 'endIndex', 'anchor', 'entries', '$epilogue'], `merkle.Receipt (${label})`);
  const start = bytesJson(s.start, `${label}.start`);
  const end = bytesJson(s.end, `${label}.end`);
  const anchor = bytesJson(s.anchor, `${label}.anchor`);
  const startIndex = i64big(s.startIndex, `${label}.startIndex`);
  const endIndex = i64big(s.endIndex, `${label}.endIndex`);
  // merkle.Receipt.Entries is an encoding.JsonList: a list, or a single entry.
  // Every occurrence of the member is decoded in turn (a wrong one is an error although a later one replaces it); a null clears the list.
  const decodeEntry = (e: unknown, i: number): { right: boolean; hash: Uint8Array; extra: Uint8Array } => {
    const es = struct(e, ['right', 'hash', '$epilogue'], `merkle.ReceiptEntry (${label}.entries[${i}])`);
    return { right: bool(es.right, `${label}.entries[${i}].right`), hash: bytesJson(es.hash, `${label}.entries[${i}].hash`), extra: epilogue(es.$epilogue, `${label}.entries[${i}]`) };
  };
  // A later list is decoded into the elements an earlier one left (intoSlice), so every occurrence is decoded on its own first and then the elements they make.
  const occs = s.entries instanceof Occ ? s.entries.vals : [s.entries];
  const live = occs.filter((x) => x !== undefined && x !== null);
  if (live.length > 1) for (const x of live) (Array.isArray(x) ? x : [x]).forEach(decodeEntry);
  const entries: { right: boolean; hash: Uint8Array; extra: Uint8Array }[] = (intoSlice(occs, true) ?? []).map(decodeEntry);
  const extra = epilogue(s.$epilogue, label);
  const node: WireNode = {
    cls: 'merkle.Receipt',
    fields: new Map<string, never>() as WireNode['fields'],
    extra,
    empty: false,
  };
  node.fields.set('start', start);
  node.fields.set('startIndex', startIndex);
  node.fields.set('end', end);
  node.fields.set('endIndex', endIndex);
  node.fields.set('anchor', anchor);
  node.fields.set(
    'entries',
    entries.map((e) => {
      const en: WireNode = { cls: 'merkle.ReceiptEntry', fields: new Map() as WireNode['fields'], extra: e.extra, empty: false };
      en.fields.set('right', e.right);
      en.fields.set('hash', e.hash);
      return en;
    }),
  );
  return { start, anchor, entries: entries.map((e) => ({ hash: e.hash, right: e.right })), bin: encodeNode(node) };
}

function epilogue(v: unknown, label: string): Uint8Array {
  return bytesJson(v, `${label}.$epilogue`);
}

export { importSequenced, type SeqMsg } from './seqmsg.js';
