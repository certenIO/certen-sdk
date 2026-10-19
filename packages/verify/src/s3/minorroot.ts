/**
 * An api.MinorRootRecord (a certify run, a set-check hop) and an api.MajorHeaderRecord (a record of the spine) from their JSON, as Go's
 * Import reads them: the binary form Go's MarshalBinary writes for a minor-root record (the evidence document carries it as hex and the
 * evidence budget measures it), and the canonical JSON - exact keys, canonical names, lower-case hex - that the spine's walk reads.
 */
import { UNDECODABLE, VerifyError, sha256 } from '../proof-v2/bytes.js';
import { app, cat } from './bytebuf.js';
import { decodeObject, encodeNode } from '../sigtypes/wire.js';
import { afterLastNull, mergedPairs, Occ, occurrences } from './occ.js';
import { goHex, i64big, intoSlice, JsonError, jsonList, strptr, struct, u64, valueAfterNull } from './gojson.js';
import { nodeToJson } from './nodejson.js';
import { nodeFromJson, unionFromJson } from './jsonwire.js';
import { decodeReceiptBin, receiptListDecodes, receiptListParts, recordDecodes, recordUpdateBins } from './certify.js';
import { importReceipt, type Rcpt } from './rcpt.js';
import { importSequenced, redecode, type SeqMsg } from './seqmsg.js';

const KEY_SIGNATURES = new Set(['LegacyED25519Signature', 'ED25519Signature', 'RCD1Signature', 'BTCSignature', 'BTCLegacySignature', 'ETHSignature', 'RsaSha256Signature', 'EcdsaSha256Signature', 'TypedDataSignature']);

const uvarint = (v: number | bigint): number[] => {
  let x = BigInt(v);
  const out: number[] = [];
  while (x >= 0x80n) {
    out.push(Number(x & 0x7fn) | 0x80);
    x >>= 7n;
  }
  out.push(Number(x));
  return out;
};
const varint = (v: number | bigint): number[] => uvarint(BigInt.asUintN(64, (BigInt(v) << 1n) ^ (BigInt(v) < 0n ? -1n : 0n)));
const field = (n: number, body: Uint8Array | number[]): number[] => cat(uvarint(n), uvarint(body.length), body);
const bytesWithLen = (b: Uint8Array): number[] => cat(uvarint(b.length), b);

/**
 * The receipt in the spelling the spine's walk reads - as merkle.Receipt.UnmarshalBinary reads its binary form (a trailing field the reader places as an
 * entry is an entry). One that does not decode is marked (UNDECODABLE) and refused by the reader that uses it.
 */
export const canonReceiptJson = (r: Rcpt): Record<string, unknown> => ({
  start: Buffer.from(r.start).toString('hex'),
  anchor: Buffer.from(r.anchor).toString('hex'),
  entries: r.entries.map((e) => ({ hash: Buffer.from(e.hash).toString('hex'), right: e.right })),
});

export const canonReceipt = (r: Rcpt): Record<string, unknown> => {
  const d = decodeReceiptBin(r.bin);
  const x = d ?? r;
  const out: Record<string, unknown> = {
    start: Buffer.from(x.start).toString('hex'),
    anchor: Buffer.from(x.anchor).toString('hex'),
    entries: x.entries.map((e) => ({ hash: Buffer.from(e.hash).toString('hex'), right: e.right })),
  };
  if (d === undefined) Object.defineProperty(out, UNDECODABLE, { value: true });
  return out;
};

/**
 * A receipt nested in a record, as the record's UnmarshalBinary reads it: the receipt its binary form decodes to (a trailing field the reader places
 * as an entry is an entry, whatever the JSON said). A receipt that does not decode - a trailing field it cannot place after the entries - clears
 * ok.v: the record does not decode, and is refused at its turn in the walk (decodeMinorRoot), not at the import.
 */
function nestedReceipt(r: Rcpt, ok: { v: boolean }): Rcpt {
  const d = decodeReceiptBin(r.bin);
  if (d === undefined) {
    ok.v = false;
    return r;
  }
  return d;
}

interface State {
  bin: Uint8Array;
  canonical: Record<string, unknown>;
}

/** merkle.State from its JSON; its MarshalBinary is the varint count, one length-prefixed hash per set bit of the count, then the hash list. */
function stateFromJson(j: unknown): State {
  const s = struct(j, ['count', 'pending', 'hashList'], 'merkle.State');
  const count = i64big(s.count, 'State.count');
  const hexList = (v: unknown, what: string): (Uint8Array | null)[] =>
    (jsonList(v, what) ?? []).map((x) => {
      if (x === null || x === undefined) return null;
      if (typeof x !== 'string') throw new JsonError(`json: cannot unmarshal ${typeof x} into Go value of type string`);
      const b = goHex(x);
      if (!b) throw new JsonError(`error decoding ${what}: encoding/hex: invalid byte`);
      return b;
    });
  const pending = hexList(s.pending, 'Pending');
  const hashes = hexList(s.hashList, 'HashList');
  const out: number[] = varint(count);
  let height = count;
  for (let i = 0; height > 0n; i++) {
    if (i >= pending.length) throw new VerifyError(`missing hash at [${i}]`);
    if ((height & 1n) === 1n) app(out, bytesWithLen(pending[i] ?? new Uint8Array(0)));
    height >>= 1n;
  }
  app(out, uvarint(hashes.length));
  for (const h of hashes) app(out, bytesWithLen(h ?? new Uint8Array(0)));
  const hx = (b: Uint8Array | null): string | null => (b === null ? null : Buffer.from(b).toString('hex'));
  // The record is written in binary and read back (Import does so): the sparse list keeps a hash only where a bit of the count is set, and is as
  // long as the count has bits - the state the walk reads is that one, not the list the JSON carried.
  const kept: (string | null)[] = [];
  for (let i = 0; (count >> BigInt(i)) > 0n; i++) kept.push(((count >> BigInt(i)) & 1n) === 1n && pending[i] && pending[i]!.length > 0 ? hx(pending[i]!) : null);
  return { bin: Uint8Array.from(out), canonical: { count: Number(count), pending: kept, hashList: hashes.map(hx) } };
}

/** A member Go reads into a pointer: what follows its last null (a null sets the pointer to nil); the occurrences before that null are still decoded. */
function ptr(v: unknown, decode: (x: unknown) => unknown): unknown {
  const { value, before } = afterLastNull(v);
  if (before !== undefined) decode(before);
  return value;
}

/**
 * encoding.JsonList[*NetworkUpdateProof]: a list, or - failing that - a single value, which is a list of one; a null drops it, a later occurrence replaces an
 * earlier one, and every element of every occurrence is decoded in turn (a wrongly typed one is an error even when a later list replaces it).
 */
function updateList(v: unknown): unknown[] | undefined {
  const vals = v instanceof Occ ? v.vals : [v];
  for (const x of vals) {
    if (x === undefined || x === null) continue;
    for (const el of Array.isArray(x) ? x : [x]) struct(el, ['transaction', 'receipt'], 'NetworkUpdateProof');
  }
  // a later list is decoded into the elements an earlier one left (intoSlice)
  return intoSlice(vals, true);
}

function receiptListFromJson(j: unknown, ok: { v: boolean }): State {
  const s = struct(j, ['merkleState', 'elements', 'receipt', 'continuedReceipt', '$epilogue'], 'merkle.ReceiptList');
  const out: number[] = [];
  const canonical: Record<string, unknown> = {};
  // merkle.ReceiptList holds its state and both receipts by pointer: a null clears them (what came before it is still decoded)
  const ms = ptr(s.merkleState, stateFromJson);
  if (ms !== undefined) {
    const st = stateFromJson(ms);
    app(out, field(1, st.bin));
    canonical.merkleState = st.canonical;
  }
  const elements: string[] = [];
  for (const e of jsonList(s.elements, 'Elements') ?? []) {
    let b: Uint8Array = new Uint8Array(0);
    if (e !== null && e !== undefined) {
      if (typeof e !== 'string') throw new JsonError(`json: cannot unmarshal ${typeof e} into Go value of type string`);
      const d = goHex(e);
      if (!d) throw new JsonError('error decoding Elements: encoding/hex: invalid byte');
      b = d;
    }
    // WriteBytes writes the field even for an empty element.
    app(out, uvarint(2), bytesWithLen(b));
    elements.push(Buffer.from(b).toString('hex'));
  }
  canonical.elements = elements;
  const rc = ptr(s.receipt, (x) => importReceipt(x, 'rootProof.receipt'));
  if (rc !== undefined) {
    const r = importReceipt(rc, 'rootProof.receipt');
    app(out, field(3, r.bin));
    canonical.receipt = canonReceipt(nestedReceipt(r, ok));
  }
  const cr = ptr(s.continuedReceipt, (x) => importReceipt(x, 'rootProof.continuedReceipt'));
  if (cr !== undefined) {
    const r = importReceipt(cr, 'rootProof.continuedReceipt');
    app(out, field(4, r.bin));
    canonical.continuedReceipt = canonReceipt(nestedReceipt(r, ok));
  }
  if (out.length === 0) out.push(0x80); // nothing written: the empty object (encoding.Writer.Reset)
  // the list's own extra data (merkle.ReceiptList keeps what follows its last known field, and reads it from the member $epilogue)
  const extra = strptr(s.$epilogue, 'rootProof.$epilogue');
  if (extra !== undefined) {
    const b = goHex(extra);
    if (!b) throw new JsonError('error decoding rootProof.$epilogue: encoding/hex: invalid byte');
    app(out, b);
  }
  const bin = Uint8Array.from(out);
  if (!receiptListDecodes(bin)) ok.v = false;
  else {
    // The list is the struct its BINARY form decodes to (decodeMinorRoot reads RootProof from the record's bytes): a trailing field that opens with 2, 3
    // or 4 is one more element, a receipt or a continued receipt, whatever the JSON said.
    const parts = receiptListParts(bin);
    canonical.elements = parts.elements.map((e) => Buffer.from(e).toString('hex'));
    const asReceipt = (b: Uint8Array): Record<string, unknown> => canonReceipt({ start: new Uint8Array(0), anchor: new Uint8Array(0), entries: [], bin: b });
    if (parts.receipt !== undefined) canonical.receipt = asReceipt(parts.receipt);
    else delete canonical.receipt;
    if (parts.continued !== undefined) canonical.continuedReceipt = asReceipt(parts.continued);
    else delete canonical.continuedReceipt;
  }
  return { bin, canonical };
}

export interface MinorRoot {
  /** MarshalBinary of the record. */
  bin: Uint8Array;
  /** The record in the spelling the spine's walk reads. */
  canonical: Record<string, unknown>;
  anchor?: SeqMsg;
  /** Whether every receipt nested in the record (its root proof's two, each update's) decodes as merkle.Receipt.UnmarshalBinary decodes it. */
  nestedDecodes: boolean;
}

/**
 * encoding.JsonUnmarshalListWith (a list of an interface type): a later list is written over the elements already read, index by index, and
 * never shortens what an earlier one made; a null drops it. A single value is a list of one written over index 0 (UnmarshalJSON runs unmarshalList first, which
 * takes a bare value as a list of one; unmarshalSingle, which would replace the list, is reached only when unmarshalList fails). Every element of every occurrence
 * is decoded in turn, so a wrongly typed one is an error even when a later list overwrites it.
 */
function unionList(v: unknown, label: string): unknown[] | undefined {
  let out: unknown[] | undefined;
  // the member is a *encoding.JsonUnmarshalListWith[KeySignature]: a null sets the pointer to nil and what follows allocates one with no Func, which panics as
  // soon as an element is to be decoded (valueAfterNull); an empty list calls nothing
  let nulled = false;
  for (const x of v instanceof Occ ? v.vals : [v]) {
    if (x === undefined) continue;
    if (x === null) {
      nulled = true;
      out = undefined;
      continue;
    }
    const els = Array.isArray(x) ? x : [x];
    if (nulled && els.length > 0) valueAfterNull();
    els.forEach((el, i) => unionFromJson('Signature', el, `${label}.signatures[${i}]`));
    const next = out === undefined ? [] : out.slice();
    els.forEach((el, i) => {
      next[i] = el;
    });
    out = next;
  }
  return out;
}

function keySignatures(v: unknown, label: string): { bin: Uint8Array; canonical: Record<string, unknown> }[] {
  return (unionList(v, label) ?? []).map((x, i) => {
    // The generated unmarshaler of a key signature hands its transactionHash member to ChainFromJSON, which dereferences the pointer a JSON null
    // leaves nil: Go's recovery refuses the document as one Accumulate's codec cannot decode (RB9-L).
    const pairs = x !== null && typeof x === 'object' && !Array.isArray(x) ? mergedPairs(x) : undefined;
    const th = pairs === undefined ? [] : occurrences(pairs, 'transactionHash');
    if (th.length > 0 && th[th.length - 1] === null) throw new JsonError("a value Accumulate's codec cannot decode (a member it needs is null or absent)");
    const n = unionFromJson('Signature', x, `${label}.signatures[${i}]`);
    if (!n || !KEY_SIGNATURES.has(n.cls)) throw new JsonError(`${label}.signatures[${i}]: ${n?.cls ?? 'nil'} is not a key signature`);
    return { bin: encodeNode(n), canonical: nodeToJson(n, 'Signature') };
  });
}

/** minorRootHex: an api.MinorRootRecord from its JSON (MinorRootRecord.UnmarshalJSON, then MarshalBinary). */
export function minorRootFromJson(j: unknown, label: string): MinorRoot {
  const s = struct(j, ['anchor', 'signatures', 'updates', 'rootProof', '$epilogue'], `api.MinorRootRecord (${label})`);
  const out: number[] = [];
  const canonical: Record<string, unknown> = {};
  const ok = { v: true };
  let anchor: SeqMsg | undefined;
  const anchorJ = ptr(s.anchor, (x) => importSequenced(x, `${label}.anchor`));
  if (anchorJ !== undefined) {
    anchor = importSequenced(anchorJ, `${label}.anchor`);
    app(out, field(1, anchor.bin));
    canonical.anchor = anchor.canonical;
  }
  const sigs = keySignatures(s.signatures, label);
  for (const sg of sigs) app(out, field(2, sg.bin));
  canonical.signatures = sigs.map((x) => x.canonical);
  const updates: Record<string, unknown>[] = [];
  for (const u of updateList(s.updates) ?? []) {
    if (u === null) {
      // a nil element of Updates is written as the empty object and is an update with no transaction and no receipt: refused as incomplete where the walk
      // reaches it, and counted among the record's updates
      app(out, field(3, Uint8Array.of(0x80)));
      updates.push({});
      continue;
    }
    const us = struct(u, ['transaction', 'receipt'], 'NetworkUpdateProof');
    const inner: number[] = [];
    const cu: Record<string, unknown> = {};
    // NetworkUpdateProof holds its transaction and its receipt by pointer: a later null clears them
    const txJ = ptr(us.transaction, (x) => nodeFromJson('Transaction', x, `${label}.updates.transaction`));
    const rcJ = ptr(us.receipt, (x) => importReceipt(x, `${label}.updates.receipt`));
    if (txJ !== undefined) {
      const txn = nodeFromJson('Transaction', txJ, `${label}.updates.transaction`);
      app(inner, field(1, encodeNode(txn)));
      // the verifier decodes the record's binary form: the update's transaction is the struct that decoder makes (a trailing field it reads as a known one)
      cu.transaction = nodeToJson(redecode('Transaction', txn, true));
    }
    if (rcJ !== undefined) {
      const r = importReceipt(rcJ, `${label}.updates.receipt`);
      app(inner, field(2, r.bin));
      cu.receipt = canonReceipt(nestedReceipt(r, ok));
    }
    app(out, field(3, Uint8Array.from(inner.length === 0 ? [0x80] : inner)));
    updates.push(cu);
  }
  const rootProof = ptr(s.rootProof, (x) => receiptListFromJson(x, { v: true }));
  if (rootProof !== undefined) {
    const rp = receiptListFromJson(rootProof, ok);
    app(out, field(4, rp.bin));
    canonical.rootProof = rp.canonical;
  }
  // a record with no field written is the single byte 0x80 (encoding.Writer.Reset), whose extra data follows it
  if (out.length === 0) out.push(0x80);
  // the record's extra data (an unknown trailing field, or whatever Go's JSON reads into $epilogue) follows its last known field
  const extra = strptr(s.$epilogue, `${label}.$epilogue`);
  if (extra !== undefined) {
    const b = goHex(extra);
    if (!b) throw new JsonError(`error decoding ${label}.$epilogue: encoding/hex: invalid byte`);
    app(out, b);
  }
  // The updates are those of the record's BINARY form (api.MinorRootRecord.UnmarshalBinaryFrom reads every field 3 of it): what the JSON spelled, then one
  // update more for each field 3 the extra data opens with.
  const binUpdates = recordUpdateBins(Uint8Array.from(out));
  for (let k = updates.length; k < binUpdates.length; k++) {
    const bu = binUpdates[k]!;
    const cu: Record<string, unknown> = {};
    if (bu.tx !== undefined) cu.transaction = nodeToJson(decodeObject('Transaction', bu.tx));
    if (bu.rc !== undefined) cu.receipt = canonReceipt({ start: new Uint8Array(0), anchor: new Uint8Array(0), entries: [], bin: bu.rc });
    updates.push(cu);
  }
  canonical.updates = updates;
  // A record that does not decode (an unplaceable trailing field of its own or of a receipt nested in it) is refused where the walk reaches it.
  const decodes = ok.v && recordDecodes(Uint8Array.from(out));
  if (!decodes) Object.defineProperty(canonical, UNDECODABLE, { value: true });
  return { bin: Uint8Array.from(out), canonical, anchor, nestedDecodes: ok.v };
}

/** An api.MajorHeaderRecord from its JSON, in the spelling the spine's walk reads (the archive is never re-encoded). */
export function majorFromJson(j: unknown, label: string): Record<string, unknown> {
  const s = struct(j, ['index', 'entry', 'anchor', 'signatures', 'updates'], `api.MajorHeaderRecord (${label})`);
  const canonical: Record<string, unknown> = {};
  if (s.index !== undefined && s.index !== null) {
    canonical.index = u64(s.index, `${label}.index`);
  }
  // MajorHeaderRecord holds its entry and its anchor by pointer: a later null clears them (what came before it is still decoded)
  const entryJ = ptr(s.entry, (x) => nodeFromJson('IndexEntry', x, `${label}.entry`));
  if (entryJ !== undefined) canonical.entry = nodeToJson(nodeFromJson('IndexEntry', entryJ, `${label}.entry`));
  const anchorJ = ptr(s.anchor, (x) => importSequenced(x, `${label}.anchor`, false));
  if (anchorJ !== undefined) canonical.anchor = importSequenced(anchorJ, `${label}.anchor`, false).canonical;
  canonical.signatures = keySignatures(s.signatures, label).map((x) => x.canonical);
  const updates: Record<string, unknown>[] = [];
  for (const u of updateList(s.updates) ?? []) {
    const us = struct(u, ['transaction', 'receipt'], 'NetworkUpdateProof');
    const cu: Record<string, unknown> = {};
    const txJ = ptr(us.transaction, (x) => nodeFromJson('Transaction', x, `${label}.updates.transaction`));
    if (txJ !== undefined) cu.transaction = nodeToJson(nodeFromJson('Transaction', txJ, `${label}.updates.transaction`));
    // the archive keeps the structs json.Unmarshal built (portable.go Import): a receipt nested in a major record is not decoded from binary
    const rcJ = ptr(us.receipt, (x) => importReceipt(x, `${label}.updates.receipt`));
    if (rcJ !== undefined) cu.receipt = canonReceiptJson(importReceipt(rcJ, `${label}.updates.receipt`));
    updates.push(cu);
  }
  canonical.updates = updates;
  return canonical;
}

void [strptr, sha256];
