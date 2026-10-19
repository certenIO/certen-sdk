/**
 * An api.MinorRootRecord (a certify run, a set-check hop) and an api.MajorHeaderRecord (a record of the spine) from their JSON, as Go's
 * Import reads them: the binary form Go's MarshalBinary writes for a minor-root record (the evidence document carries it as hex and the
 * evidence budget measures it), and the canonical JSON - exact keys, canonical names, lower-case hex - that the spine's walk reads.
 */
import { VerifyError, sha256 } from '../proof-v2/bytes.js';
import { app, cat } from './bytebuf.js';
import { encodeNode } from '../sigtypes/wire.js';
import { afterLastNull, mergedPairs, Occ, occurrences } from './occ.js';
import { goHex, i64big, JsonError, jsonList, strptr, struct, u64 } from './gojson.js';
import { nodeToJson } from './nodejson.js';
import { nodeFromJson, unionFromJson } from './jsonwire.js';
import { importReceipt, type Rcpt } from './rcpt.js';
import { importSequenced, type SeqMsg } from './seqmsg.js';

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

export const canonReceipt = (r: Rcpt): Record<string, unknown> => ({
  start: Buffer.from(r.start).toString('hex'),
  anchor: Buffer.from(r.anchor).toString('hex'),
  entries: r.entries.map((e) => ({ hash: Buffer.from(e.hash).toString('hex'), right: e.right })),
});

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

function receiptListFromJson(j: unknown): State {
  const s = struct(j, ['merkleState', 'elements', 'receipt', 'continuedReceipt'], 'merkle.ReceiptList');
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
    canonical.receipt = canonReceipt(r);
  }
  const cr = ptr(s.continuedReceipt, (x) => importReceipt(x, 'rootProof.continuedReceipt'));
  if (cr !== undefined) {
    const r = importReceipt(cr, 'rootProof.continuedReceipt');
    app(out, field(4, r.bin));
    canonical.continuedReceipt = canonReceipt(r);
  }
  return { bin: Uint8Array.from(out), canonical };
}

export interface MinorRoot {
  /** MarshalBinary of the record. */
  bin: Uint8Array;
  /** The record in the spelling the spine's walk reads. */
  canonical: Record<string, unknown>;
  anchor?: SeqMsg;
}

/**
 * encoding.JsonUnmarshalListWith (a list of an interface type): a later list is written over the elements already read, index by index, and
 * never shortens what an earlier one made; a single value replaces the whole list and a null drops it. Every element of every occurrence is
 * decoded in turn, so a wrongly typed one is an error even when a later list overwrites it.
 */
function unionList(v: unknown, label: string): unknown[] | undefined {
  let out: unknown[] | undefined;
  for (const x of v instanceof Occ ? v.vals : [v]) {
    if (x === undefined) continue;
    if (x === null) {
      out = undefined;
      continue;
    }
    const els = Array.isArray(x) ? x : [x];
    els.forEach((el, i) => unionFromJson('Signature', el, `${label}.signatures[${i}]`));
    if (!Array.isArray(x)) {
      out = els;
      continue;
    }
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
  let anchor: SeqMsg | undefined;
  if (s.anchor !== undefined && s.anchor !== null) {
    anchor = importSequenced(s.anchor, `${label}.anchor`);
    app(out, field(1, anchor.bin));
    canonical.anchor = anchor.canonical;
  }
  const sigs = keySignatures(s.signatures, label);
  for (const sg of sigs) app(out, field(2, sg.bin));
  canonical.signatures = sigs.map((x) => x.canonical);
  const updates: Record<string, unknown>[] = [];
  for (const u of jsonList(s.updates, 'Updates') ?? []) {
    if (u === null) {
      app(out, field(3, Uint8Array.of(0x80)));
      continue;
    }
    const us = struct(u, ['transaction', 'receipt'], 'NetworkUpdateProof');
    const inner: number[] = [];
    const cu: Record<string, unknown> = {};
    if (us.transaction !== undefined && us.transaction !== null) {
      const txn = nodeFromJson('Transaction', us.transaction, `${label}.updates.transaction`);
      app(inner, field(1, encodeNode(txn)));
      cu.transaction = nodeToJson(txn);
    }
    if (us.receipt !== undefined && us.receipt !== null) {
      const r = importReceipt(us.receipt, `${label}.updates.receipt`);
      app(inner, field(2, r.bin));
      cu.receipt = canonReceipt(r);
    }
    app(out, field(3, Uint8Array.from(inner.length === 0 ? [0x80] : inner)));
    updates.push(cu);
  }
  canonical.updates = updates;
  const rootProof = ptr(s.rootProof, receiptListFromJson);
  if (rootProof !== undefined) {
    const rp = receiptListFromJson(rootProof);
    app(out, field(4, rp.bin));
    canonical.rootProof = rp.canonical;
  }
  // the record's extra data (an unknown trailing field, or whatever Go's JSON reads into $epilogue) follows its last known field
  const extra = strptr(s.$epilogue, `${label}.$epilogue`);
  if (extra !== undefined) {
    const b = goHex(extra);
    if (!b) throw new JsonError(`error decoding ${label}.$epilogue: encoding/hex: invalid byte`);
    app(out, b);
  }
  return { bin: Uint8Array.from(out), canonical, anchor };
}

/** An api.MajorHeaderRecord from its JSON, in the spelling the spine's walk reads (the archive is never re-encoded). */
export function majorFromJson(j: unknown, label: string): Record<string, unknown> {
  const s = struct(j, ['index', 'entry', 'anchor', 'signatures', 'updates'], `api.MajorHeaderRecord (${label})`);
  const canonical: Record<string, unknown> = {};
  if (s.index !== undefined && s.index !== null) {
    canonical.index = u64(s.index, `${label}.index`);
  }
  if (s.entry !== undefined && s.entry !== null) canonical.entry = nodeToJson(nodeFromJson('IndexEntry', s.entry, `${label}.entry`));
  if (s.anchor !== undefined && s.anchor !== null) canonical.anchor = importSequenced(s.anchor, `${label}.anchor`).canonical;
  canonical.signatures = keySignatures(s.signatures, label).map((x) => x.canonical);
  const updates: Record<string, unknown>[] = [];
  for (const u of jsonList(s.updates, 'Updates') ?? []) {
    const us = struct(u, ['transaction', 'receipt'], 'NetworkUpdateProof');
    const cu: Record<string, unknown> = {};
    if (us.transaction !== undefined && us.transaction !== null) cu.transaction = nodeToJson(nodeFromJson('Transaction', us.transaction, `${label}.updates.transaction`));
    if (us.receipt !== undefined && us.receipt !== null) cu.receipt = canonReceipt(importReceipt(us.receipt, `${label}.updates.receipt`));
    updates.push(cu);
  }
  canonical.updates = updates;
  return canonical;
}

void [strptr, sha256];
