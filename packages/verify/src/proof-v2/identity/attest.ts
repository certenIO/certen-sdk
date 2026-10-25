// Transaction envelopes, receipts and the block transaction census of the attestation (twin of txtrie.go and ethproof.DecodeReceiptLeaf).
import { RlpError, listItems, split, splitList, uintOf } from '../../s6/rlp.js';
import { trieRoot } from '../finality/baseposted/trie.js';
import { eq } from './bytes.js';
import type { Limits } from './codec.js';
import type { Log, ReceiptLeaf } from './context.js';

export const TxTypeLegacy = 0x00;
export const TxTypeAccessList = 0x01;
export const TxTypeDynamicFee = 0x02;
export const TxTypeBlob = 0x03;
export const TxTypeSetCode = 0x04;
export type TxKind = 'empty_transaction' | 'bad_envelope' | 'too_many_transactions' | 'transactions_too_large' | 'root_mismatch' | 'leaf_mismatch' | 'index_out_of_list';
export class TxError extends Error {
  constructor(readonly kind: TxKind, readonly index = 0, readonly got = 0n, readonly limit = 0n, readonly detail = '') {
    super(`block transactions: ${kind} (index ${index})${detail ? ': ' + detail : ''}`);
  }
}
export interface TxInfo { type: number; typed: boolean; standard: boolean }

const oneList = (b: Uint8Array, what: string): void => {
  let l;
  try { l = splitList(b); } catch (e) { if (e instanceof RlpError) throw new TxError('bad_envelope', 0, 0n, 0n, `${what}: ${e.message}`); throw e; }
  if (l.rest.length !== 0) throw new TxError('bad_envelope', 0, 0n, 0n, `${what}: ${l.rest.length} bytes after the list`);
};
const hex2 = (b: number): string => b.toString(16).padStart(2, '0');

/** ClassifyTx: the envelope kind of a transaction leaf; THROWS a TxError for anything that is not one. */
export function classifyTx(raw: Uint8Array): TxInfo {
  if (raw.length === 0) throw new TxError('empty_transaction');
  const b = raw[0]!;
  if (b >= 0xc0) { oneList(raw, 'legacy transaction'); return { type: TxTypeLegacy, typed: false, standard: true }; }
  if (b >= 0x80) throw new TxError('bad_envelope', 0, 0n, 0n, `first byte 0x${hex2(b)} is an RLP string, not a transaction`);
  const info: TxInfo = { type: b, typed: true, standard: false };
  if (b <= TxTypeSetCode) {
    if (b === TxTypeLegacy) throw new TxError('bad_envelope', 0, 0n, 0n, 'type byte 0x00 prefix');
    oneList(raw.slice(1), `type 0x${hex2(b)} payload`);
    info.standard = true;
  }
  return info;
}
export interface TxCensus { types: number[]; distinct: number[]; totalBytes: number }

/** VerifyBlockTxs: the carried list is the block's (count, bytes, envelopes, rebuilt root) and its txIndex entry is the leaf. */
export function verifyBlockTxs(headerTxRoot: Uint8Array, blockTxs: Uint8Array[], txIndex: number, txLeaf: Uint8Array, lim: Limits): TxCensus {
  if (blockTxs.length > lim.maxBlockTxs) throw new TxError('too_many_transactions', 0, BigInt(blockTxs.length), BigInt(lim.maxBlockTxs));
  const total = blockTxs.reduce((n, t) => n + t.length, 0);
  if (total > lim.maxBlockTxsBytes) throw new TxError('transactions_too_large', 0, BigInt(total), BigInt(lim.maxBlockTxsBytes));
  const types: number[] = [];
  blockTxs.forEach((t, i) => {
    try { types.push(classifyTx(t).type); } catch (e) { if (e instanceof TxError) throw new TxError(e.kind, i, e.got, e.limit, e.detail); throw e; }
  });
  const distinct = [...new Set(types)].sort((a, b) => a - b);
  if (!eq(trieRoot(blockTxs), headerTxRoot)) throw new TxError('root_mismatch');
  if (txIndex < 0 || txIndex >= blockTxs.length) throw new TxError('index_out_of_list', txIndex, BigInt(blockTxs.length));
  if (!eq(blockTxs[txIndex]!, txLeaf)) throw new TxError('leaf_mismatch', txIndex);
  return { types, distinct, totalBytes: total };
}

/** ethproof.DecodeReceiptLeaf: [status|postState, cumulativeGasUsed, bloom, logs] after an optional EIP-2718 type byte; trailing fields are allowed. */
export function decodeReceiptLeaf(enc: Uint8Array): ReceiptLeaf {
  if (enc.length === 0) throw new Error('empty receipt');
  let type = 0;
  let body = enc;
  if (enc[0]! < 0x80) { type = enc[0]!; body = enc.slice(1); }
  try {
    const it = split(body);
    if (it.kind !== 'list' || it.rest.length !== 0) throw new RlpError('receipt is not one list');
    const f = listItems(it.content);
    if (f.length < 4) throw new RlpError('receipt has fewer than 4 fields');
    if (f[0]!.kind === 'list') throw new RlpError('status is a list');
    if (f[2]!.kind === 'list' || f[2]!.content.length !== 256) throw new RlpError('bloom is not 256 bytes');
    if (f[3]!.kind !== 'list') throw new RlpError('logs is not a list');
    const logs: Log[] = listItems(f[3]!.content).map((l) => {
      if (l.kind !== 'list') throw new RlpError('log is not a list');
      const c = listItems(l.content);
      if (c.length !== 3 || c[0]!.kind === 'list' || c[0]!.content.length !== 20 || c[1]!.kind !== 'list' || c[2]!.kind === 'list') throw new RlpError('malformed log');
      const topics = listItems(c[1]!.content).map((t) => { if (t.kind === 'list' || t.content.length !== 32) throw new RlpError('topic is not 32 bytes'); return Uint8Array.from(t.content); });
      return { address: Uint8Array.from(c[0]!.content), topics, data: Uint8Array.from(c[2]!.content) };
    });
    return { type, postStateOrStatus: Uint8Array.from(f[0]!.content), cumulativeGasUsed: uintOf(f[1]!, 8), bloom: Uint8Array.from(f[2]!.content), logs };
  } catch (e) {
    if (e instanceof RlpError) throw new Error(e.message);
    throw e;
  }
}
