/**
 * A consensus receipt as go-ethereum v1.17.7 `types.Receipt.UnmarshalBinary` reads it (core/types/receipt.go): a first byte above 0x7f is a
 * legacy receipt (an RLP list), anything else an EIP-2718 envelope of at least two bytes whose type is 1, 2, 3 or 4; the payload is
 * rlp.DecodeBytes into receiptRLP{PostStateOrStatus []byte, CumulativeGasUsed uint64, Bloom [256]byte, Logs []*Log} followed by setStatus.
 * Every input geth refuses is refused here with a ReceiptError: the canonical-size and canonical-integer rules of src/s6/rlp.ts, exactly
 * four items, a 256-byte bloom, logs that are lists of exactly [address(20), topics(32 each), data], nothing after the value, and a status
 * field that is empty (failed), 0x01 (successful) or a 32-byte post-state root (status stays 0).
 */
import { RlpError, bytesOf, decodeList, fixedOf, listItems, uintOf, type Item } from '../../../s6/rlp.js';

/** A receipt go refuses to decode. */
export class ReceiptError extends Error {}

/** A log of a receipt: the three consensus fields. */
export interface ReceiptLog {
  /** 20 bytes */
  address: Uint8Array;
  /** 32 bytes each */
  topics: Uint8Array[];
  data: Uint8Array;
}

/** The consensus fields of a receipt (the implementation fields geth derives are not part of the encoding). */
export interface Receipt {
  type: number;
  /** 1 successful, 0 failed or a pre-Byzantium receipt with a post-state root */
  status: number;
  /** the 32-byte post-state root of a pre-Byzantium receipt, else undefined */
  postState?: Uint8Array;
  cumulativeGasUsed: bigint;
  logs: ReceiptLog[];
}

/** The typed receipts geth decodes: dynamic fee, access list, blob and set code. */
const TYPED = new Set([1, 2, 3, 4]);

function logOf(it: Item): ReceiptLog {
  if (it.kind !== 'list') throw new RlpError('expected input list');
  const f = decodeList(it.raw);
  if (f.length < 3) throw new RlpError('too few elements');
  if (f.length > 3) throw new RlpError('input list has too many elements');
  const address = Uint8Array.from(fixedOf(f[0]!, 20));
  if (f[1]!.kind !== 'list') throw new RlpError('expected input list');
  const topics = listItems(f[1]!.content).map((t) => Uint8Array.from(fixedOf(t, 32)));
  return { address, topics, data: Uint8Array.from(bytesOf(f[2]!)) };
}

function fromRlp(type: number, payload: Uint8Array): Receipt {
  const f = decodeList(payload);
  if (f.length < 4) throw new RlpError('too few elements');
  if (f.length > 4) throw new RlpError('input list has too many elements');
  const postOrStatus = bytesOf(f[0]!);
  const cumulativeGasUsed = uintOf(f[1]!, 8);
  fixedOf(f[2]!, 256);
  if (f[3]!.kind !== 'list') throw new RlpError('expected input list');
  const logs = listItems(f[3]!.content).map(logOf);
  // setStatus: empty is failed, 0x01 successful, a 32-byte word a post-state root; anything else is "invalid receipt status"
  if (postOrStatus.length === 0) return { type, status: 0, cumulativeGasUsed, logs };
  if (postOrStatus.length === 1 && postOrStatus[0] === 1) return { type, status: 1, cumulativeGasUsed, logs };
  if (postOrStatus.length === 32) return { type, status: 0, postState: Uint8Array.from(postOrStatus), cumulativeGasUsed, logs };
  throw new ReceiptError('invalid receipt status');
}

/** Receipt.UnmarshalBinary: the receipt, or a ReceiptError for every input go-ethereum refuses. */
export function decodeReceipt(b: Uint8Array): Receipt {
  try {
    if (b.length > 0 && b[0]! > 0x7f) return fromRlp(0, b);
    if (b.length <= 1) throw new ReceiptError('typed receipt too short');
    if (!TYPED.has(b[0]!)) throw new ReceiptError('transaction type not supported');
    return fromRlp(b[0]!, b.subarray(1));
  } catch (e) {
    if (e instanceof RlpError) throw new ReceiptError(e.message);
    throw e;
  }
}
