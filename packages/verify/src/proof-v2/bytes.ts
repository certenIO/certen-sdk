/**
 * Byte and hash primitives for the proof v2 verifier. Every function here mirrors a named Go function in
 * gitlab.com/accumulatenetwork/accumulate (pkg/database/merkle) or certen-validator (pkg/proof, pkg/proof/v2); the
 * comment on each says which, so a reviewer can hold the two side by side.
 */
import { createHash } from 'node:crypto';

export class VerifyError extends Error {}

export function fail(msg: string): never {
  throw new VerifyError(msg);
}

export function sha256(...parts: Uint8Array[]): Uint8Array {
  const h = createHash('sha256');
  for (const p of parts) h.update(p);
  return new Uint8Array(h.digest());
}

/** Strict lowercase-or-uppercase hex of an exact length (in bytes when given). */
export function hexBytes(s: unknown, label: string, len?: number): Uint8Array {
  if (typeof s !== 'string') fail(`${label}: not a hex string`);
  const t = s.toLowerCase().replace(/^0x/, '');
  if (t.length % 2 !== 0 || !/^[0-9a-f]*$/.test(t)) fail(`${label}: invalid hex`);
  const b = new Uint8Array(Buffer.from(t, 'hex'));
  if (len !== undefined && b.length !== len) fail(`${label}: ${b.length} bytes, want ${len}`);
  return b;
}

/**
 * encoding/hex.DecodeString and nothing else: an even number of hex digits of either case, no 0x prefix, no space, no trim. Go reads the
 * document members evidence.txHash, pin, genesis.rootChainAnchor / stateTreeAnchor and the like with it (hex.DecodeString, then len == 32).
 * `hexBytes` above is Go's more tolerant `pkg/proof hexBytes` (lower-cases, strips one 0x); a member Go reads strictly must not use it.
 */
export function goHexStrict(s: unknown, label: string, len?: number): Uint8Array {
  if (typeof s !== 'string') fail(`${label}: not a hex string`);
  if (s.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(s)) fail(`${label}: invalid hex: encoding/hex: invalid byte or odd length`);
  const b = new Uint8Array(Buffer.from(s, 'hex'));
  if (len !== undefined && b.length !== len) fail(`${label}: ${b.length} bytes, want ${len}`);
  return b;
}

/** The characters strings.TrimSpace removes (Unicode White_Space); String.prototype.trim differs (it removes U+FEFF and keeps U+0085). */
function isGoSpace(c: number): boolean {
  return (c >= 0x09 && c <= 0x0d) || c === 0x20 || c === 0x85 || c === 0xa0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000;
}

/** strings.TrimSpace. The one copy: every TrimSpace in this package is this function, never String.prototype.trim. */
export function goTrimSpace(s: string): string {
  let a = 0;
  let b = s.length;
  while (a < b && isGoSpace(s.charCodeAt(a))) a++;
  while (b > a && isGoSpace(s.charCodeAt(b - 1))) b--;
  return s.slice(a, b);
}

/** strings.ToLower: unicode.ToLower one code point at a time (JavaScript's full mapping differs for U+0130, which Go lowers to "i"). */
export function goLower(s: string): string {
  let out = '';
  for (const ch of s) out += ch.codePointAt(0) === 0x130 ? 'i' : ch.toLowerCase();
  return out;
}

export function toHex(b: Uint8Array): string {
  return Buffer.from(b).toString('hex');
}

export function equal(a: Uint8Array | undefined, b: Uint8Array | undefined): boolean {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** encoding/binary.PutUvarint. */
export function uvarint(v: number | bigint): Uint8Array {
  let x = BigInt(v);
  const out: number[] = [];
  while (x >= 0x80n) {
    out.push(Number(x & 0x7fn) | 0x80);
    x >>= 7n;
  }
  out.push(Number(x));
  return new Uint8Array(out);
}

/**
 * merkle.State: a sparse list of subtree roots and the count of entries. AddEntry and Anchor mirror state.go exactly, including pad() and
 * the rule that a state whose Count is 0 has no anchor, whatever its pending list holds.
 */
export class MerkleState {
  pending: (Uint8Array | null)[];
  count: number;
  constructor(pending: (Uint8Array | null)[] = [], count = 0) {
    this.pending = [...pending];
    this.count = count;
  }

  static fromJSON(pending: unknown, label: string, count = 0): MerkleState {
    if (pending === undefined || pending === null) return new MerkleState([], count);
    if (!Array.isArray(pending)) fail(`${label}: pending is not a list`);
    return new MerkleState(pending.map((p, i) => (p === null ? null : hexBytes(p, `${label}.pending[${i}]`, 32))), count);
  }

  addEntry(h: Uint8Array): void {
    let hash = h;
    this.count++;
    if (this.pending.length === 0 || this.pending[this.pending.length - 1] !== null) this.pending.push(null);
    for (let i = 0; i < this.pending.length; i++) {
      const v = this.pending[i];
      if (v === null) {
        this.pending[i] = hash;
        return;
      }
      hash = sha256(v, hash);
      this.pending[i] = null;
    }
  }

  /** merkle.State.Anchor: nil when the count is 0. */
  anchor(): Uint8Array | undefined {
    if (this.count === 0) return undefined;
    let anchor: Uint8Array | undefined;
    for (const v of this.pending) {
      if (anchor === undefined) {
        if (v !== null) anchor = v;
      } else if (v !== null) {
        anchor = sha256(v, anchor);
      }
    }
    return anchor;
  }
}

/** merkle.Hasher.MerkleHash over already-hashed leaves; an empty list is 32 zero bytes (pkg/proof merkleHashList). */
export function merkleHashList(leaves: Uint8Array[]): Uint8Array {
  if (leaves.length === 0) return new Uint8Array(32);
  const s = new MerkleState();
  for (const l of leaves) s.addEntry(l);
  return s.anchor() ?? new Uint8Array(32);
}

export interface ReceiptEntry {
  hash: Uint8Array;
  right: boolean;
}

export interface Receipt {
  start: Uint8Array;
  anchor: Uint8Array;
  entries: ReceiptEntry[];
}

/**
 * Set on the canonical JSON of a receipt (or a record) whose binary form merkle.Receipt.UnmarshalBinary does not decode: the importer cannot refuse it
 * where it is read, because Go refuses it where it is USED (decodeReceipt, decodeMinorRoot), so the reader of the receipt refuses it there.
 */
export const UNDECODABLE: unique symbol = Symbol('undecodable receipt');

/** A merkle.Receipt as Go marshals it to JSON (start, anchor, entries[{hash, right}]). */
export function receiptFromJSON(j: unknown, label: string): Receipt {
  if (!j || typeof j !== 'object') fail(`${label}: not a receipt`);
  if ((j as { [UNDECODABLE]?: boolean })[UNDECODABLE]) fail(`${label}: receipt: fields are out of order`);
  const r = j as Record<string, unknown>;
  const entries = r.entries === undefined || r.entries === null ? [] : r.entries;
  if (!Array.isArray(entries)) fail(`${label}: entries is not a list`);
  return {
    start: hexBytes(r.start, `${label}.start`),
    anchor: hexBytes(r.anchor, `${label}.anchor`),
    entries: entries.map((e, i) => {
      const x = e as Record<string, unknown>;
      return { hash: hexBytes(x.hash, `${label}.entries[${i}].hash`), right: x.right === true };
    }),
  };
}

/** One step of merkle.ReceiptEntry.apply. */
function apply(e: ReceiptEntry, h: Uint8Array): Uint8Array {
  return e.right ? sha256(h, e.hash) : sha256(e.hash, h);
}

/** merkle.Receipt.Validate. */
export function receiptValid(r: Receipt): boolean {
  let h = r.start;
  for (const e of r.entries) h = apply(e, h);
  return equal(h, r.anchor);
}

/** The leading steps of r ending at value (proofv2.prefixTo), or undefined when no intermediate value equals it. */
export function receiptPrefixTo(r: Receipt, value: Uint8Array): Receipt | undefined {
  let h = r.start;
  for (let i = 0; ; i++) {
    if (equal(h, value)) return { start: r.start, anchor: h, entries: r.entries.slice(0, i) };
    if (i === r.entries.length) return undefined;
    h = apply(r.entries[i], h);
  }
}

/** merkle.State.Count (int64): absent or null is 0, and anything but a whole number is not a count. */
function merkleCount(v: unknown, label: string): number {
  if (v === undefined || v === null) return 0;
  if (typeof v !== 'number' || !Number.isInteger(v)) fail(`${label}: count is not a whole number`);
  return v;
}

/** merkle.ReceiptList.Validate. */
export function receiptListValid(j: unknown, label: string): { start: Uint8Array; anchor: Uint8Array; end: Uint8Array } {
  const p = receiptListParts(j, label);
  const end = p.validate();
  return { start: p.start, anchor: p.anchor, end };
}

/**
 * A root proof in the phases Go judges it in (AdvanceEpoch): present, where it starts and where it ends are read first; whether the chain from one
 * to the other validates is judged by validate(), which returns the recomputed end or fails with `invalid root proof`.
 */
export function receiptListParts(j: unknown, label: string): { start: Uint8Array; anchor: Uint8Array; validate: () => Uint8Array } {
  if (!j || typeof j !== 'object') fail(`${label}: missing`);
  const rl = j as Record<string, unknown>;
  const ms = rl.merkleState as Record<string, unknown> | undefined;
  if (!ms || !rl.receipt) fail(`${label}: incomplete root proof`);
  const state = MerkleState.fromJSON(ms.pending, `${label}.merkleState`, merkleCount(ms.count, `${label}.merkleState`));
  const start = state.anchor();
  const receiptAnchor = (() => {
    try {
      return receiptFromJSON(rl.receipt, `${label}.receipt`).anchor;
    } catch {
      return new Uint8Array(0);
    }
  })();
  return { start: start ?? new Uint8Array(0), anchor: receiptAnchor, validate: () => validateReceiptList(rl, state, label) };
}

function validateReceiptList(rl: Record<string, unknown>, state: MerkleState, label: string): Uint8Array {
  const elements = rl.elements;
  if (!Array.isArray(elements) || elements.length === 0) fail(`${label}: invalid root proof`);
  const work = new MerkleState(state.pending, state.count);
  let last: Uint8Array | undefined;
  for (const [i, e] of elements.entries()) {
    last = hexBytes(e, `${label}.elements[${i}]`);
    if (last.length !== 32) fail(`${label}: invalid root proof`);
    work.addEntry(last);
  }
  const anchor = work.anchor();
  const receipt = receiptFromJSON(rl.receipt, `${label}.receipt`);
  if (!anchor || !equal(last, receipt.start) || !equal(receipt.anchor, anchor) || !receiptValid(receipt)) {
    fail(`${label}: invalid root proof`);
  }
  if (rl.continuedReceipt !== undefined && rl.continuedReceipt !== null) {
    const c = receiptFromJSON(rl.continuedReceipt, `${label}.continuedReceipt`);
    if (!equal(anchor, c.start) || !receiptValid(c)) fail(`${label}: invalid root proof`);
  }
  return anchor;
}
