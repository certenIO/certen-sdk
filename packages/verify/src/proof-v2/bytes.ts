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
 * merkle.State: a sparse list of subtree roots. AddEntry and Anchor mirror state.go exactly, including pad(); the
 * Count field the Go struct also carries is metadata the root never depends on, so it is not modelled.
 */
export class MerkleState {
  pending: (Uint8Array | null)[];
  constructor(pending: (Uint8Array | null)[] = []) {
    this.pending = [...pending];
  }

  static fromJSON(pending: unknown, label: string): MerkleState {
    if (pending === undefined || pending === null) return new MerkleState();
    if (!Array.isArray(pending)) fail(`${label}: pending is not a list`);
    return new MerkleState(pending.map((p, i) => (p === null ? null : hexBytes(p, `${label}.pending[${i}]`, 32))));
  }

  addEntry(h: Uint8Array): void {
    let hash = h;
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

  /** merkle.State.Anchor: nil when nothing was added. */
  anchor(): Uint8Array | undefined {
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

/** A merkle.Receipt as Go marshals it to JSON (start, anchor, entries[{hash, right}]). */
export function receiptFromJSON(j: unknown, label: string): Receipt {
  if (!j || typeof j !== 'object') fail(`${label}: not a receipt`);
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

/** merkle.ReceiptList.Validate. */
export function receiptListValid(j: unknown, label: string): { start: Uint8Array; anchor: Uint8Array; end: Uint8Array } {
  if (!j || typeof j !== 'object') fail(`${label}: missing`);
  const rl = j as Record<string, unknown>;
  const ms = rl.merkleState as Record<string, unknown> | undefined;
  if (!ms || !rl.receipt) fail(`${label}: incomplete root proof`);
  const state = MerkleState.fromJSON(ms.pending, `${label}.merkleState`);
  const start = state.anchor();
  const elements = rl.elements;
  if (!Array.isArray(elements) || elements.length === 0) fail(`${label}: invalid root proof`);
  const work = new MerkleState(state.pending);
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
  return { start: start ?? new Uint8Array(0), anchor: receipt.anchor, end: anchor };
}
