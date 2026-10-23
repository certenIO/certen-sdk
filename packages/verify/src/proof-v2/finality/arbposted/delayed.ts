/**
 * Delayed-inbox origin of Arbitrum block transactions (annex A6.5; the twin of pkg/finality/arbposted/delayed.go and the helpers of
 * verify.go): the Bridge slot arithmetic, the accumulators, the delayed message hash and the proof that the block's transactions are the
 * ones the delayed message derives (derive.ts: ETH deposit, submit retryable, L2 message with unsigned / contract / signed / batch
 * contents, L2 funded by L1). A message kind with no derivation (end of block, rollup event, batch posting report) stays the named state
 * l1_posted_delayed_origin_unproven, never a weaker level.
 */
import { keccak_256 } from '@noble/hashes/sha3';
import { MptError, verifySlot } from '../../../s6/mpt.js';
import { RlpError, split, splitList } from '../../../s6/rlp.js';
import { FinalityStateError, newState } from '../state.js';
import { deriveDelayed } from './derive.js';
import { CodeDelayedOriginUnproven, ContentReason, contentNotFound, stateProofInvalid } from './states.js';
import type { ArbPins } from './pins.js';
import type { Delayed, Evidence } from './wire.js';
import { DataBlobs } from './wire.js';
import type { PayloadResult } from './nitro.js';

/** L1 message type of an ETH deposit (nitro L1MessageType_EthDeposit); it becomes an ArbitrumDepositTx (type 0x64) whose request id is the delayed message index. */
export const MSG_KIND_ETH_DEPOSIT = 12;
export const TX_DEPOSIT = 0x64;
export const TX_RETRY = 0x68;
export const TX_INTERNAL = 0x6a;

/** 0x64/0x65/0x66/0x69 originate from the delayed inbox. */
export const isDelayedOriginType = (t: number): boolean => t === 0x64 || t === 0x65 || t === 0x66 || t === 0x69;

/** The EIP-2718 type of a transaction's consensus encoding: its first byte, or 0 for a legacy RLP list (and for the empty string). */
export function txType(enc: Uint8Array): number {
  if (enc.length === 0 || enc[0]! >= 0xc0) return 0;
  return enc[0]!;
}

const MASK256 = (1n << 256n) - 1n;

/** The 32-byte big-endian word of v (v < 2^64 here). */
export function w32(v: bigint): Uint8Array {
  const out = new Uint8Array(32);
  new DataView(out.buffer).setBigUint64(24, BigInt.asUintN(64, v), false);
  return out;
}

const beBig = (b: Uint8Array): bigint => {
  let v = 0n;
  for (const x of b) v = (v << 8n) | BigInt(x);
  return v;
};

/** The storage slot of element n of the dynamic array declared at slot base: keccak256(w(base)) + n (mod 2^256, as common.BigToHash keeps the low 32 bytes). */
export function arrayElementSlot(base: bigint, n: bigint): Uint8Array {
  const v = (beBig(keccak_256(w32(base))) + n) & MASK256;
  const out = new Uint8Array(32);
  const dv = new DataView(out.buffer);
  for (let i = 0; i < 4; i++) dv.setBigUint64(24 - 8 * i, (v >> BigInt(64 * i)) & 0xffff_ffff_ffff_ffffn, false);
  return out;
}

export function header40Bytes(h: readonly bigint[]): Uint8Array {
  const out = new Uint8Array(40);
  const dv = new DataView(out.buffer);
  for (let i = 0; i < 5; i++) dv.setBigUint64(i * 8, BigInt.asUintN(64, h[i]!), false);
  return out;
}

const concat = (...parts: Uint8Array[]): Uint8Array => {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};

/** The SequencerInbox dataHash of a batch: keccak256(header40 || 0x50 || versionedHashes...) for blobs, keccak256(header40 || data) for calldata (annex A6.2). */
export function dataHash(e: Pick<Evidence, 'header40' | 'dataKind' | 'versionedHashes' | 'calldata'>): Uint8Array {
  const parts: Uint8Array[] = [header40Bytes(e.header40)];
  if (e.dataKind === DataBlobs) {
    parts.push(Uint8Array.of(0x50));
    for (const h of e.versionedHashes) parts.push(h);
  } else {
    parts.push(e.calldata);
  }
  return keccak_256(concat(...parts));
}

/** Bridge.sequencerInboxAccs[N] for a batch: keccak256(beforeAcc || dataHash || delayedAcc). */
export function accumulator(beforeAcc: Uint8Array, dataHashBytes: Uint8Array, delayedAcc: Uint8Array): Uint8Array {
  return keccak_256(concat(beforeAcc, dataHashBytes, delayedAcc));
}

/** Messages.messageHash (annex A6.5): keccak256(kind u8, sender, blockNumber u64, timestamp u64, inboxSeqNum u256 = k, baseFeeL1 u256, keccak256(data)). */
export function delayedMessageHash(d: Delayed): Uint8Array {
  const u64 = (v: bigint): Uint8Array => {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setBigUint64(0, BigInt.asUintN(64, v), false);
    return b;
  };
  return keccak_256(concat(Uint8Array.of(d.msgKind), d.sender, u64(d.msgBlockNumber), u64(d.msgTimestamp), w32(d.k), d.baseFeeL1, keccak_256(d.data)));
}

/**
 * The L2 header's nonce (RLP item 14, the delayed-message count the block has read, annex A6.5), read positionally; undefined if the header
 * has no such item as an 8-byte RLP string. (rlp.SplitList ignores what follows the list, as the reference does.)
 */
export function headerNonce(raw: Uint8Array): bigint | undefined {
  let content: Uint8Array;
  try {
    content = splitList(raw).content;
  } catch (e) {
    if (e instanceof RlpError) return undefined;
    throw e;
  }
  for (let i = 0; i <= 14; i++) {
    let it;
    try {
      it = split(content);
    } catch (e) {
      if (e instanceof RlpError) return undefined;
      throw e;
    }
    if (i === 14) {
      if (it.kind !== 'string' || it.content.length !== 8) return undefined;
      return beBig(it.content);
    }
    content = it.rest;
  }
  return undefined;
}

const delayedUnproven = (types: bigint[], nonce: bigint, extra: Record<string, bigint | number> = {}): FinalityStateError =>
  newState(CodeDelayedOriginUnproven, { block_tx_types: types, header_nonce: nonce, ...extra });

const sameBytes = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

const sameTxs = (a: readonly Uint8Array[], b: readonly Uint8Array[]): boolean => a.length === b.length && a.every((x, i) => sameBytes(x, b[i]!));

/**
 * Proves the delayed-origin transactions of a block (annex A6.5): the delayed message hashes into delayedInboxAccs[k] from
 * delayedInboxAccs[k-1] (both proven under stateRoot_S, slot 6); this batch consumed it (k lies in [afterDelayedMessagesRead - delayedSegments,
 * afterDelayedMessagesRead)); and the block's transactions other than the internal 0x6a and the execution-derived retry 0x68 are, byte for
 * byte and in order, what Nitro derives from the message (derive.ts). A message kind with no derivation stays the named state
 * l1_posted_delayed_origin_unproven. A block and a message that agree on NO transaction prove nothing: that is l1_posted_content_not_found
 * {no_standard_transactions}, the state the sequencer branch raises for a block without content. Returns k.
 */
export function verifyDelayed(
  arb: ArbPins,
  bridgeStorageRoot: Uint8Array,
  e: Evidence,
  res: PayloadResult,
  types: bigint[],
  nonce: bigint,
): bigint {
  const d = e.delayed;
  if (d === null) throw delayedUnproven(types, nonce);
  const after = e.header40[4];
  const n = BigInt(res.delayedSegments);
  const unproven = (): FinalityStateError => delayedUnproven(types, nonce, { k: d.k, message_kind: d.msgKind });
  if (n > after || d.k >= after || d.k < after - n) throw unproven();
  const slot = (k: bigint): Uint8Array => {
    try {
      return verifySlot(bridgeStorageRoot, arrayElementSlot(arb.layout.delayedAccArraySlot, k), e.nodes);
    } catch (err) {
      if (err instanceof MptError || err instanceof RlpError) throw stateProofInvalid('slot');
      throw err;
    }
  };
  const accK = slot(d.k);
  const prev = d.k > 0n ? slot(d.k - 1n) : new Uint8Array(32);
  if (!sameBytes(keccak_256(concat(prev, delayedMessageHash(d))), accK)) throw unproven();
  const want = deriveDelayed(arb.chainId, d);
  if (want === null) throw unproven();
  const got: Uint8Array[] = [];
  for (const tx of e.blockTxs) {
    const t = txType(tx);
    if (t !== TX_INTERNAL && t !== TX_RETRY) got.push(tx);
  }
  if (!sameTxs(got, want)) throw unproven();
  // The block and the message agree, but if both are empty the agreement is vacuous: the block holds nothing but the internal start-block
  // transaction (or nothing) and the message derives nothing (an empty batch), so no transaction of the block is shown to have been posted.
  if (got.length === 0) throw contentNotFound(ContentReason.NoStandardTransactions, { batch: e.batchSeq });
  return d.k;
}
