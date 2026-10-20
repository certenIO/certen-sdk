/**
 * The execution-header spine of the L1 head (V2_SPEC_S7 section 5.2 step 5; the twin of pkg/finality/ethl1/covers.go). The positions of
 * the RLP items the verifier reads (section 0): the item count is not fixed (Sepolia L1 headers have 23 items since 2026-10-06 and
 * Fulu-era ones 21), so headers are hashed as given and read positionally, never decoded into a typed header.
 *
 * The positional reader is this package's own, ported from the Go ethl1 reader (it reads items 0, 3, 8 and 11 of the first twelve,
 * which must all be RLP strings) and not the framework's `readHeader` (which also reads items 4, 5 and 16): the two accept different
 * sets, and the verdict of this verifier is the Go ethl1 verdict.
 */
import { keccak_256 } from '@noble/hashes/sha3';
import { evidenceMalformed, evidenceTooLarge, headerChainBroken, blockNotCovered } from './fault.js';
import { eq } from './ssz.js';
import type { FinalizedHead, L1Block } from './types.js';

const hdrParentHash = 0;
const hdrStateRoot = 3;
const hdrNumber = 8;
const hdrTimestamp = 11;
const hdrReadItems = 12;

const U64_MASK = (1n << 64n) - 1n;

/** The big-endian value of up to 4 length bytes. */
function lenBE(b: Uint8Array, from: number, ll: number): number {
  let n = 0;
  for (let i = 0; i < ll; i++) n = n * 256 + b[from + i]!;
  return n;
}

interface Items {
  items: Uint8Array[];
  count: number;
  /** '' on success */
  reason: string;
}

/**
 * Walks the whole RLP list in b (canonical lengths, no trailing byte) and returns the payloads of the first hdrReadItems items, which
 * must be strings, together with the item count. reason is '' on success.
 */
export function rlpHeaderItems(b: Uint8Array): Items {
  const items: Uint8Array[] = [];
  const bad = (reason: string): Items => ({ items, count: 0, reason });
  if (b.length === 0 || b[0]! < 0xc0) return bad('not_a_list');
  let payloadLen: number;
  let hdr: number;
  if (b[0]! <= 0xf7) {
    payloadLen = b[0]! - 0xc0;
    hdr = 1;
  } else {
    const ll = b[0]! - 0xf7;
    if (ll > 4 || 1 + ll > b.length || b[1] === 0) return bad('list_length');
    payloadLen = lenBE(b, 1, ll);
    if (payloadLen < 56) return bad('list_length_noncanonical');
    hdr = 1 + ll;
  }
  if (hdr + payloadLen !== b.length) return bad('list_length_mismatch');
  let p = b.subarray(hdr);
  let count = 0;
  while (p.length > 0) {
    let start: number;
    let n = 0;
    const b0 = p[0]!;
    let isList = false;
    if (b0 < 0x80) {
      start = 0;
      n = 1;
    } else if (b0 <= 0xb7) {
      start = 1;
      n = b0 - 0x80;
      if (n === 1 && p.length > 1 && p[1]! < 0x80) return bad('string_noncanonical');
    } else if (b0 <= 0xbf) {
      const ll = b0 - 0xb7;
      if (ll > 4 || 1 + ll > p.length || p[1] === 0) return bad('string_length');
      n = lenBE(p, 1, ll);
      if (n < 56) return bad('string_length_noncanonical');
      start = 1 + ll;
    } else if (b0 <= 0xf7) {
      isList = true;
      start = 1;
      n = b0 - 0xc0;
    } else {
      isList = true;
      const ll = b0 - 0xf7;
      if (ll > 4 || 1 + ll > p.length || p[1] === 0) return bad('list_length');
      n = lenBE(p, 1, ll);
      if (n < 56) return bad('list_length_noncanonical');
      start = 1 + ll;
    }
    if (start + n > p.length) return bad('item_overruns');
    if (count < hdrReadItems) {
      if (isList) return bad('item_not_string');
      items[count] = p.subarray(start, start + n);
    }
    count++;
    p = p.subarray(start + n);
  }
  if (count < hdrReadItems) return { items, count, reason: 'too_few_items' };
  return { items, count, reason: '' };
}

/** A canonical RLP unsigned integer of at most 8 bytes (no leading zero); ok is false otherwise. */
function rlpUint64(b: Uint8Array): bigint | undefined {
  if (b.length > 8 || (b.length > 0 && b[0] === 0)) return undefined;
  let v = 0n;
  for (const x of b) v = (v << 8n) | BigInt(x);
  return v;
}

interface SpineHeader {
  hash: Uint8Array;
  parent: Uint8Array;
  stateRoot: Uint8Array;
  number: bigint;
  timestamp: bigint;
}

/** The positional fields of one raw header, or the reason it cannot be read. */
function readSpineHeader(raw: Uint8Array): { h?: SpineHeader; reason: string } {
  const { items, reason } = rlpHeaderItems(raw);
  if (reason !== '') return { reason };
  if (items[hdrParentHash]!.length !== 32 || items[hdrStateRoot]!.length !== 32) return { reason: 'hash_item_length' };
  const number = rlpUint64(items[hdrNumber]!);
  if (number === undefined) return { reason: 'number_item' };
  const timestamp = rlpUint64(items[hdrTimestamp]!);
  if (timestamp === undefined) return { reason: 'timestamp_item' };
  return {
    h: {
      hash: keccak_256(raw),
      parent: Uint8Array.from(items[hdrParentHash]!),
      stateRoot: Uint8Array.from(items[hdrStateRoot]!),
      number,
      timestamp,
    },
    reason: '',
  };
}

/**
 * Spec section 5.2 step 5: keccak256(spine[0]) is the finalized execution head, every further header is the parent of the one before
 * it (hash and number), and at most max headers are accepted. It returns each header's hash, number, state root and timestamp, read
 * positionally from the raw RLP; callers take every L1 state root and timestamp from this list by number and never from a field the
 * evidence states.
 */
export function covers(head: FinalizedHead, spine: Uint8Array[], max: number): L1Block[] {
  if (spine.length === 0) throw evidenceMalformed('spine', 0, 'empty', 0, 1);
  if (spine.length > max) throw evidenceTooLarge('spine', spine.length, max);
  const out: L1Block[] = [];
  let prev: SpineHeader | undefined;
  for (let i = 0; i < spine.length; i++) {
    const raw = spine[i]!;
    const r = readSpineHeader(raw);
    if (r.reason !== '') {
      const want = i === 0 ? head.execHash : prev!.parent;
      const at = i === 0 ? 0n : (prev!.number - 1n) & U64_MASK;
      throw headerChainBroken('l1', at, want, keccak_256(raw), 'rlp');
    }
    const cur = r.h!;
    if (i === 0) {
      if (!eq(cur.hash, head.execHash)) throw headerChainBroken('l1', cur.number, head.execHash, cur.hash, 'hash');
    } else {
      if (!eq(cur.hash, prev!.parent)) throw headerChainBroken('l1', (prev!.number - 1n) & U64_MASK, prev!.parent, cur.hash, 'hash');
      if (prev!.number === 0n || cur.number !== prev!.number - 1n) {
        throw headerChainBroken('l1', (prev!.number - 1n) & U64_MASK, prev!.parent, cur.hash, 'number');
      }
    }
    out.push({ hash: cur.hash, number: cur.number, stateRoot: cur.stateRoot, timestamp: cur.timestamp });
    prev = cur;
  }
  return out;
}

/**
 * The covered header with this number, or finality_block_not_covered when the number lies above the spine's top (the builder maps
 * that to pending) or below its bottom.
 */
export function blockAt(covered: L1Block[], number: bigint): L1Block {
  if (covered.length === 0) throw blockNotCovered(number, 0n);
  const top = covered[0]!.number;
  if (number > top || number + BigInt(covered.length) <= top) throw blockNotCovered(number, top);
  return covered[Number(top - number)]!;
}
