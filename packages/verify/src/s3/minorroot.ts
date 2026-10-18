/**
 * An api.MinorRootRecord (a certify run, a set-check hop) and an api.MajorHeaderRecord (a record of the spine) from their JSON, as Go's
 * Import reads them: the binary form Go's MarshalBinary writes for a minor-root record (the evidence document carries it as hex and the
 * evidence budget measures it), and the canonical JSON - exact keys, canonical names, lower-case hex - that the spine's walk reads.
 */
import { VerifyError, sha256 } from '../proof-v2/bytes.js';
import { encodeNode } from '../sigtypes/wire.js';
import { goHex, JsonError, list, str, struct } from './gojson.js';
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
const field = (n: number, body: Uint8Array | number[]): number[] => [...uvarint(n), ...uvarint(body.length), ...body];
const bytesWithLen = (b: Uint8Array): number[] => [...uvarint(b.length), ...b];

/** encoding.JsonList: a list, or a single value (a list of one). */
function jsonList(v: unknown, what: string): unknown[] | undefined {
  if (v === undefined || v === null) return undefined;
  return Array.isArray(v) ? v : (list([v], what) as unknown[]);
}

const canonReceipt = (r: Rcpt): Record<string, unknown> => ({
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
  let count = 0n;
  if (s.count !== undefined && s.count !== null) {
    if (typeof s.count !== 'number' || !Number.isInteger(s.count)) throw new JsonError('json: cannot unmarshal into Go struct field State.count of type int64');
    count = BigInt(s.count);
  }
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
    if ((height & 1n) === 1n) out.push(...bytesWithLen(pending[i] ?? new Uint8Array(0)));
    height >>= 1n;
  }
  out.push(...uvarint(hashes.length));
  for (const h of hashes) out.push(...bytesWithLen(h ?? new Uint8Array(0)));
  const hx = (b: Uint8Array | null): string | null => (b === null ? null : Buffer.from(b).toString('hex'));
  return { bin: Uint8Array.from(out), canonical: { count: Number(count), pending: pending.map(hx), hashList: hashes.map(hx) } };
}

function receiptListFromJson(j: unknown): State {
  const s = struct(j, ['merkleState', 'elements', 'receipt', 'continuedReceipt'], 'merkle.ReceiptList');
  const out: number[] = [];
  const canonical: Record<string, unknown> = {};
  if (s.merkleState !== undefined && s.merkleState !== null) {
    const st = stateFromJson(s.merkleState);
    out.push(...field(1, st.bin));
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
    out.push(...uvarint(2), ...bytesWithLen(b));
    elements.push(Buffer.from(b).toString('hex'));
  }
  canonical.elements = elements;
  if (s.receipt !== undefined && s.receipt !== null) {
    const r = importReceipt(s.receipt, 'rootProof.receipt');
    out.push(...field(3, r.bin));
    canonical.receipt = canonReceipt(r);
  }
  if (s.continuedReceipt !== undefined && s.continuedReceipt !== null) {
    const r = importReceipt(s.continuedReceipt, 'rootProof.continuedReceipt');
    out.push(...field(4, r.bin));
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

function keySignatures(v: unknown, label: string): { bin: Uint8Array; canonical: Record<string, unknown> }[] {
  return (jsonList(v, 'Signatures') ?? []).map((x, i) => {
    const n = unionFromJson('Signature', x, `${label}.signatures[${i}]`);
    if (!n || !KEY_SIGNATURES.has(n.cls)) throw new JsonError(`${label}.signatures[${i}]: ${n?.cls ?? 'nil'} is not a key signature`);
    return { bin: encodeNode(n), canonical: nodeToJson(n, 'Signature') };
  });
}

/** minorRootHex: an api.MinorRootRecord from its JSON (MinorRootRecord.UnmarshalJSON, then MarshalBinary). */
export function minorRootFromJson(j: unknown, label: string): MinorRoot {
  const s = struct(j, ['anchor', 'signatures', 'updates', 'rootProof'], `api.MinorRootRecord (${label})`);
  const out: number[] = [];
  const canonical: Record<string, unknown> = {};
  let anchor: SeqMsg | undefined;
  if (s.anchor !== undefined && s.anchor !== null) {
    anchor = importSequenced(s.anchor, `${label}.anchor`);
    out.push(...field(1, anchor.bin));
    canonical.anchor = anchor.canonical;
  }
  const sigs = keySignatures(s.signatures, label);
  for (const sg of sigs) out.push(...field(2, sg.bin));
  canonical.signatures = sigs.map((x) => x.canonical);
  const updates: Record<string, unknown>[] = [];
  for (const u of jsonList(s.updates, 'Updates') ?? []) {
    if (u === null) {
      out.push(...field(3, Uint8Array.of(0x80)));
      continue;
    }
    const us = struct(u, ['transaction', 'receipt'], 'NetworkUpdateProof');
    const inner: number[] = [];
    const cu: Record<string, unknown> = {};
    if (us.transaction !== undefined && us.transaction !== null) {
      const txn = nodeFromJson('Transaction', us.transaction, `${label}.updates.transaction`);
      inner.push(...field(1, encodeNode(txn)));
      cu.transaction = nodeToJson(txn);
    }
    if (us.receipt !== undefined && us.receipt !== null) {
      const r = importReceipt(us.receipt, `${label}.updates.receipt`);
      inner.push(...field(2, r.bin));
      cu.receipt = canonReceipt(r);
    }
    out.push(...field(3, Uint8Array.from(inner.length === 0 ? [0x80] : inner)));
    updates.push(cu);
  }
  canonical.updates = updates;
  if (s.rootProof !== undefined && s.rootProof !== null) {
    const rp = receiptListFromJson(s.rootProof);
    out.push(...field(4, rp.bin));
    canonical.rootProof = rp.canonical;
  }
  return { bin: Uint8Array.from(out), canonical, anchor };
}

/** An api.MajorHeaderRecord from its JSON, in the spelling the spine's walk reads (the archive is never re-encoded). */
export function majorFromJson(j: unknown, label: string): Record<string, unknown> {
  const s = struct(j, ['index', 'entry', 'anchor', 'signatures', 'updates'], `api.MajorHeaderRecord (${label})`);
  const canonical: Record<string, unknown> = {};
  if (s.index !== undefined && s.index !== null) {
    if (typeof s.index !== 'number' || !Number.isInteger(s.index) || s.index < 0) throw new JsonError(`${label}: json: cannot unmarshal into Go struct field index of type uint64`);
    canonical.index = s.index;
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

void [str, sha256];
