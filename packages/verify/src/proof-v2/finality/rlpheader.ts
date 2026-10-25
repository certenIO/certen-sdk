/**
 * Raw execution-block headers read POSITIONALLY (V2_SPEC_S7 section 0; the twin of pkg/finality/rlpheader.go). A header is raw RLP,
 * hashed as given and never decoded into a typed header: the item count is not fixed (Sepolia L1 headers have 23 items, Fulu-era 21),
 * and a typed decode fails on an unknown future trailing field while hashing succeeds.
 */
import { keccak_256 } from '@noble/hashes/sha3';
import { RlpError, split, splitList, type Item } from '../../s6/rlp.js';
import { EvidenceReason, malformed, malformedAt } from './state.js';

/** The items of a raw execution-block header that S7 reads. */
export interface HeaderFields {
  /** keccak256 of the raw header */
  hash: Uint8Array;
  /** item 0 */
  parentHash: Uint8Array;
  /** item 3 */
  stateRoot: Uint8Array;
  /** item 4 */
  transactionRoot: Uint8Array;
  /** item 5 */
  receiptsRoot: Uint8Array;
  /** item 8 */
  number: bigint;
  /** item 11 */
  timestamp: bigint;
  /** item 16, present iff the header has at least 17 items */
  withdrawalsRoot?: Uint8Array;
  items: number;
}

const hashAt = (items: Item[], i: number): Uint8Array => {
  const it = items[i]!;
  if (it.kind === 'list') throw malformedAt('header', i, EvidenceReason.HeaderItemIsList, it.content.length, 32);
  if (it.content.length !== 32) throw malformedAt('header', i, EvidenceReason.HeaderItemNot32Bytes, it.content.length, 32);
  return Uint8Array.from(it.content);
};

const uintAt = (items: Item[], i: number): bigint => {
  const it = items[i]!;
  if (it.kind === 'list') throw malformedAt('header', i, EvidenceReason.HeaderItemIsList, it.content.length, 8);
  const v = it.content;
  if (v.length > 8 || (v.length > 0 && v[0] === 0)) throw malformedAt('header', i, EvidenceReason.HeaderItemNotCanonUint, v.length, 8);
  let n = 0n;
  for (const c of v) n = (n << 8n) | BigInt(c);
  return n;
};

/**
 * Reads the fields positionally from a raw RLP header. It refuses (finality_evidence_malformed, part "header") anything that is not one
 * RLP list of at least 12 items whose positional fields (items 0, 3, 4, 5, 8, 11 and, when the header has 17 or more items, 16) are
 * RLP STRINGS of the right shape: an item that is an RLP list in one of those slots is refused as header_item_is_list with its index,
 * in ascending slot order. The first failing slot is the one reported.
 */
export function readHeader(raw: Uint8Array): HeaderFields {
  let list: Item;
  try {
    list = splitList(raw);
  } catch (e) {
    if (e instanceof RlpError) throw malformed('header', EvidenceReason.HeaderNotRLPList, raw.length, 0);
    throw e;
  }
  if (list.rest.length !== 0) throw malformed('header', EvidenceReason.HeaderTrailingBytes, list.rest.length, 0);
  const items: Item[] = [];
  let content = list.content;
  while (content.length > 0) {
    let it: Item;
    try {
      it = split(content);
    } catch (e) {
      if (e instanceof RlpError) throw malformedAt('header', items.length, EvidenceReason.HeaderBadItem, content.length, 0);
      throw e;
    }
    items.push(it);
    content = it.rest;
  }
  if (items.length < 12) throw malformed('header', EvidenceReason.HeaderTooFewItems, items.length, 12);
  // ascending slot order: 0, 3, 4, 5, 8, 11, 16
  const parentHash = hashAt(items, 0);
  const stateRoot = hashAt(items, 3);
  const transactionRoot = hashAt(items, 4);
  const receiptsRoot = hashAt(items, 5);
  const number = uintAt(items, 8);
  const timestamp = uintAt(items, 11);
  const out: HeaderFields = { hash: keccak_256(raw), parentHash, stateRoot, transactionRoot, receiptsRoot, number, timestamp, items: items.length };
  if (items.length >= 17) out.withdrawalsRoot = hashAt(items, 16);
  return out;
}
