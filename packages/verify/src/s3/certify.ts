/**
 * The anchored certify form of evidence 2.1 (RB9-F5; validator pkg/proof/v2: certify_names.go, window.go, spine.go AdvanceAnchored,
 * consensus_spine.go CheckpointLag): the named refusals with their fields, the decoding a link must survive, the genesis link, the window of an
 * update, and the checkpoint lag. The names, their fields and their detail text come from the Go-written names file (certify-names.ts).
 */
import { equal, receiptValid, toHex, VerifyError } from '../proof-v2/bytes.js';
import { CERTIFY_DETAILS, CertifyCode } from './certify-names.js';
import type { Rcpt } from './rcpt.js';

export { CertifyCode, CERTIFY_DETAILS, CERTIFY_FIELDS, CERTIFY_SIDE, CERTIFY_NAMES_SHA256 } from './certify-names.js';

/**
 * CertifyState is a named refusal of the certify form: the code, the fields it was judged at (decimal integers, lower-case hex hashes) and the fixed
 * detail of its code. Its text is Go's CertifyState.Error(): code{field,field}: detail.
 */
export class CertifyState extends VerifyError {
  constructor(
    readonly code: string,
    readonly fields: string[],
    tail = '',
  ) {
    super(`${code}{${fields.join(',')}}: ${CERTIFY_DETAILS[code] ?? ''}${tail}`);
    this.name = 'CertifyState';
  }
}

export const certifyState = (code: string, ...fields: string[]): CertifyState => new CertifyState(code, fields);

/** The ordinal a certify_link_* state carries for the genesis link, which has none in the links member. */
export const GENESIS_LINK_INDEX = 'genesis';

/**
 * CheckpointLag is how many major blocks behind the newest verified checkpoint a 2.1 document may build on (V-E F-VE-1): a document that builds on
 * majors with majors + CheckpointLag < newest names keys that were in force at an old checkpoint and is refused by name.
 */
export const CHECKPOINT_LAG = 2;

/**
 * The consensus-facing judgement of verifyFromSpine (consensus_spine.go): evidence 2.1 that builds on a checkpoint more than CHECKPOINT_LAG major
 * blocks behind the newest the chain holds is checkpoint_stale{majors,newest,lag}. Evidence 2.0 is judged as ever.
 */
export function checkCheckpointLag(version: string, majors: number, newest: number): void {
  if (version === '2.1' && majors + CHECKPOINT_LAG < newest) {
    throw certifyState(CertifyCode.CheckpointStale, String(majors), String(newest), String(CHECKPOINT_LAG));
  }
}

/**
 * The same rule for the set check's starting point (F5-3c): evidence 2.1 whose check builds on a checkpoint more than CHECKPOINT_LAG major blocks
 * behind the newest is checkpoint_stale too. The certification's majors are judged first, then the check's.
 */
export function checkEvidenceCheckpointLags(version: string, majors: number, checkMajors: number, newest: number): void {
  checkCheckpointLag(version, majors, newest);
  checkCheckpointLag(version, checkMajors, newest);
}

// --------------------------------------------------------------------------------------------------------------------------------
// Accumulate's binary reader, as far as merkle.Receipt needs it

const EMPTY_OBJECT = 0x80;
const MAX_VALUE_SIZE = 1 << 24;

type Uv = { v: bigint } | { eof: true } | undefined;

/** The part of encoding.Reader that decoding a merkle.Receipt and its entries uses (readField, nextField, Reset, ReadAll). */
class Rd {
  err = false;
  private current = 0;
  private seen = 0;
  constructor(
    private readonly b: Uint8Array,
    private pos: number,
    private readonly end: number,
  ) {}

  /** binary.ReadUvarint: eof when the stream ended before the first byte, undefined (err set) on any other failure. */
  private uvarint(): Uv {
    let v = 0n;
    for (let i = 0; i < 10; i++) {
      if (this.pos >= this.end) {
        if (i === 0) return { eof: true };
        this.err = true;
        return undefined;
      }
      const c = this.b[this.pos++]!;
      if (c < 0x80) {
        if (i === 9 && c > 1) {
          this.err = true;
          return undefined;
        }
        return { v: v | (BigInt(c) << BigInt(7 * i)) };
      }
      v |= BigInt(c & 0x7f) << BigInt(7 * i);
    }
    this.err = true;
    return undefined;
  }

  private nextField(): boolean {
    if (this.seen === 0) {
      if (this.pos >= this.end) return false;
      if (this.b[this.pos] === EMPTY_OBJECT) {
        this.current = EMPTY_OBJECT;
        return false;
      }
    }
    const r = this.uvarint();
    if (r === undefined || 'eof' in r) return false;
    if (r.v < 1n) {
      this.current = EMPTY_OBJECT;
      return false;
    }
    if (r.v > 32n) {
      this.err = true;
      return false;
    }
    this.current = Number(r.v);
    this.seen++;
    return true;
  }

  private readField(n: number): boolean {
    if (this.err) return false;
    if (this.current === 0 && !this.nextField()) return false;
    if (this.current < n) {
      this.err = true; // ErrFieldsOutOfOrder
      return false;
    }
    if (this.current > n) return false;
    this.current = 0;
    return true;
  }

  private value(): bigint | undefined {
    if (this.err) return undefined;
    const r = this.uvarint();
    if (r === undefined) return undefined;
    if ('eof' in r) {
      this.err = true;
      return undefined;
    }
    return r.v;
  }

  readBytes(n: number): Uint8Array | undefined {
    if (!this.readField(n)) return undefined;
    const l = this.value();
    if (l === undefined) return undefined;
    if (l === 0n) return new Uint8Array(0);
    if (BigInt(this.end - this.pos) < l || l >= BigInt(MAX_VALUE_SIZE)) {
      this.err = true;
      return undefined;
    }
    const out = this.b.slice(this.pos, this.pos + Number(l));
    this.pos += Number(l);
    return out;
  }

  readInt(n: number): void {
    if (!this.readField(n)) return;
    this.value();
  }

  readBool(n: number): boolean | undefined {
    if (!this.readField(n)) return undefined;
    const v = this.value();
    if (v === undefined) return undefined;
    if (v > 1n) {
      this.err = true;
      return undefined;
    }
    return v === 1n;
  }

  /** ReadValue: a length-prefixed sub-reader handed to unmarshal; true when it was read and decoded. */
  readValue(n: number, unmarshal: (sub: Rd) => boolean): boolean {
    if (!this.readField(n)) return false;
    const l = this.value();
    if (l === undefined) return false;
    if (l > 0n && BigInt(this.end - this.pos) < l) {
      this.err = true;
      return false;
    }
    const sub = new Rd(this.b, this.pos, this.pos + Number(l));
    const ok = unmarshal(sub);
    this.pos += Number(l);
    if (!ok) this.err = true;
    return ok;
  }
}

/**
 * Whether the binary form of a receipt decodes as merkle.Receipt.UnmarshalBinary decodes it (decodeReceipt): the fields in order, an entry for each
 * field 6, and whatever follows the last field it knows kept as extra data - unless it opens with a field number the reader cannot place after the
 * entries (1-6: out of order) or one above 32. An unknown trailing field 7..32 leaves the receipt decodable, as a record tolerates it.
 */
export function receiptDecodes(bin: Uint8Array): boolean {
  return decodeReceiptBin(bin) !== undefined;
}

/**
 * decodeReceipt (evidence.go): the receipt as merkle.Receipt.UnmarshalBinary reads it from its binary form - its start, its anchor and its entries,
 * whatever the JSON it was imported from said - or undefined when it does not decode. A trailing field the reader places as an entry (field 6) is an
 * entry, so the verifier judges the receipt it decoded and not the one the JSON appeared to describe.
 */
export function decodeReceiptBin(bin: Uint8Array): Rcpt | undefined {
  const r = new Rd(bin, 0, bin.length);
  const start = r.readBytes(1);
  r.readInt(2);
  r.readBytes(3);
  r.readInt(4);
  const anchor = r.readBytes(5);
  const entries: { right: boolean; hash: Uint8Array }[] = [];
  for (;;) {
    let e: { right: boolean; hash: Uint8Array } | undefined;
    const ok = r.readValue(6, (sub) => {
      const right = sub.readBool(1);
      const hash = sub.readBytes(2);
      e = { right: right ?? false, hash: hash ?? new Uint8Array(0) };
      return !sub.err;
    });
    if (!ok) break;
    entries.push(e!);
  }
  if (r.err) return undefined;
  return { start: start ?? new Uint8Array(0), anchor: anchor ?? new Uint8Array(0), entries, bin };
}

/**
 * Whether the binary form of a minor-root record decodes as api.MinorRootRecord.UnmarshalBinary decodes it (decodeMinorRoot): its four fields in
 * order (the nested values are judged by the import that wrote them), and whatever follows is extra data - a record tolerates an unknown trailing
 * field 5..32 - unless it opens with a field number the reader cannot place after the record's own (1..3), or one above 32, or is cut short.
 */
export function recordDecodes(bin: Uint8Array): boolean {
  const r = new Rd(bin, 0, bin.length);
  const skip = (): boolean => true;
  r.readValue(1, skip);
  while (r.readValue(2, skip));
  while (r.readValue(3, skip));
  r.readValue(4, skip);
  return !r.err;
}

// --------------------------------------------------------------------------------------------------------------------------------
// the genesis link

/**
 * checkGenesisLink judges the chain identity of an anchored document (V-E A1b): the genesis link must start at the pinned incarnation's genesis root
 * chain anchor, end at the certified root chain anchor and validate. Its refusals are the certify_link_* states at index "genesis".
 */
export function checkGenesisLink(link: Rcpt | undefined, genesisRoot: Uint8Array, certifiedRoot: Uint8Array): void {
  if (link === undefined) throw certifyState(CertifyCode.CertifyLinkMissing, GENESIS_LINK_INDEX);
  if (!equal(link.start, genesisRoot)) throw certifyState(CertifyCode.CertifyLinkStart, GENESIS_LINK_INDEX);
  if (!equal(link.anchor, certifiedRoot)) throw certifyState(CertifyCode.CertifyLinkEnd, GENESIS_LINK_INDEX);
  if (!receiptValid(link)) throw certifyState(CertifyCode.CertifyLinkInvalid, GENESIS_LINK_INDEX);
}

// --------------------------------------------------------------------------------------------------------------------------------
// the window of an update

/**
 * rootChainLeafIndex returns the root-chain position of the leaf the end of entries is the path of, in a root chain of size leaves (window.go).
 * The root chain's anchor combines its peaks from the smallest up, a larger peak on the left, so the root-chain part of a path is, from the leaf:
 * one step per level inside the leaf's perfect subtree (the offset's bits, Right when the bit is 0), then one Right step when smaller peaks exist,
 * then one non-Right step per larger peak. Main-chain steps may come before it; where the root-chain part begins is read from the END. undefined is
 * a path that is the root-chain path of no leaf of a tree of that size.
 */
export function rootChainLeafIndex(entries: readonly { right: boolean }[], size: bigint): bigint | undefined {
  if (size <= 0n || size >= 1n << 64n) return undefined;
  const heights: number[] = [];
  for (let h = 63; h >= 0; h--) if (((size >> BigInt(h)) & 1n) === 1n) heights.push(h);
  const peaks = heights.length;
  let run = 0;
  while (run < entries.length && !entries[entries.length - 1 - run]!.right) run++;
  let larger = peaks - 1;
  let last = true;
  if (run < peaks - 1) {
    larger = run;
    last = false;
  }
  const k = heights[larger]!;
  let width = k + larger;
  if (!last) width++; // the Right step that combines the smaller peaks
  if (entries.length < width) return undefined;
  const part = entries.slice(entries.length - width);
  if (!last && !part[k]!.right) return undefined;
  let index = 0n;
  for (let j = 0; j < larger; j++) index += 1n << BigInt(heights[j]!);
  for (let j = 0; j < k; j++) if (!part[j]!.right) index += 1n << BigInt(j);
  return index;
}

/**
 * The window an update must lie in: the root chain positions in (prev, this], judged at the anchor of Directory minor block block. prevKnown is
 * false when the previous anchor's RootChainIndex is not established, which leaves the window's lower bound unproven.
 */
export class UpdateWindow {
  constructor(
    private readonly prev: number,
    private readonly prevKnown: boolean,
    private readonly thisIndex: number,
    private readonly block: number,
  ) {}

  /** Judge one update whose receipt already validates and ends at the anchor's root chain anchor: certify_update_unproven{principal,txHash,anchorBlock}. */
  check(principal: string, txHash: Uint8Array, entries: readonly { right: boolean }[]): void {
    const state = (): CertifyState => certifyState(CertifyCode.CertifyUpdateUnproven, principal, toHex(txHash), String(this.block));
    if (!this.prevKnown) throw state();
    const idx = rootChainLeafIndex(entries, BigInt(this.thisIndex) + 1n);
    if (idx === undefined || idx <= BigInt(this.prev) || idx > BigInt(this.thisIndex)) throw state();
  }
}
