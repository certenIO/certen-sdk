/**
 * The channel's batches (V2_SPEC_S7 5.4 O4/O5; the twin of pkg/finality/baseposted span.go and the batch part of channel.go): the
 * decompressed channel is a stream of RLP strings, each `type byte || payload`; type 0 is a singular batch, type 1 a span batch (OP Delta,
 * span-batches.md), any other type is a BatchFormatError (the kind reports batch_format_unsupported{type}); a stream that does not parse
 * is a BatchStreamError (channel_malformed).
 *
 * A span batch commits the parent hash only as a 20-byte prefix for its FIRST block and the L1 origin hash only as a 20-byte prefix for
 * its LAST block (parentLen / epochLen 20); every other block carries none (length 0). The caller binds exactly what is committed.
 *
 * Every 64-bit quantity is a bigint (Go's uint64). All malformed-stream failures stop at the first one: in Go they are sticky and only
 * the rejection class matters (plain error versus unsupported transaction type), and the unsupported-type refusal can only arise in
 * the final rebuild loop, after every plain check has passed, in the same transaction order as Go.
 */
import { RlpError, bytesOf, decodeList, fixedOf, split, uintOf, type Item } from '../../../s6/rlp.js';
import {
  EthTxError, TX_ACCESS_LIST, TX_DYNAMIC_FEE, TX_LEGACY, TX_SET_CODE, checkAccessList, checkAuthList,
  encodeAccessListTx, encodeDynamicFeeTx, encodeLegacyTx, encodeSetCodeTx,
} from './ethtx.js';

/** The chain constants a span batch is read against: the L2 genesis time, the L2 block time and the L2 chain id. */
export interface SpanParams {
  genesisTime: bigint;
  blockTime: bigint;
  chainId: bigint;
}

/**
 * One decoded L2 block batch. `parentLen` / `epochLen` say how many leading bytes of parentHash / epochHash are committed (32 singular;
 * 20 or 0 span).
 */
export interface Batch {
  type: number;
  parentHash: Uint8Array;
  parentLen: number;
  epochNum: bigint;
  epochHash: Uint8Array;
  epochLen: number;
  timestamp: bigint;
  txs: Uint8Array[];
  /** block index inside its span batch (0 for singular) */
  spanIndex: number;
  /** blocks in the span batch (1 for singular) */
  spanBlocks: number;
}

/** A batch (or span transaction) type this verifier does not decode. */
export class BatchFormatError extends Error {
  constructor(readonly typ: number) {
    super('unsupported batch type');
  }
}

/** Every other failure to parse the batch stream; the kind reports channel_malformed. */
export class BatchStreamError extends Error {}

const bad = (m: string): never => {
  throw new BatchStreamError(m);
};

/** Bounds on what one span batch may declare, so a hostile count never allocates. */
export const MAX_SPAN_BLOCKS = 1 << 16;
export const MAX_SPAN_TXS = 1 << 20;

const MASK64 = (1n << 64n) - 1n;

/** Go's binary.Uvarint: [value, n]; n <= 0 is a failure (0: buffer too small, < 0: overflow). Non-minimal encodings are accepted, as Go does. */
function uvarint(b: Uint8Array): [bigint, number] {
  let x = 0n;
  let s = 0n;
  for (let i = 0; i < b.length; i++) {
    if (i === 10) return [0n, -(i + 1)];
    const c = b[i]!;
    if (c < 0x80) {
      if (i === 9 && c > 1) return [0n, -(i + 1)];
      return [x | (BigInt(c) << s), i + 1];
    }
    x |= BigInt(c & 0x7f) << s;
    s += 7n;
  }
  return [0n, 0];
}

/** A bit list of n bits: ceil(n/8) bytes read as a big-endian integer; bit i (least significant first) is item i. */
class Bits {
  constructor(private readonly raw: Uint8Array) {}
  bit(i: number): number {
    const idx = this.raw.length - 1 - (i >> 3);
    if (idx < 0) return 0;
    return (this.raw[idx]! >> (i & 7)) & 1;
  }
  /** big.Int.BitLen of the integer. */
  bitLen(): number {
    let j = 0;
    while (j < this.raw.length && this.raw[j] === 0) j++;
    if (j === this.raw.length) return 0;
    return (this.raw.length - j - 1) * 8 + (32 - Math.clz32(this.raw[j]!));
  }
}

class SpanReader {
  constructor(public b: Uint8Array) {}

  uvarint(): bigint {
    const [v, n] = uvarint(this.b);
    if (n <= 0) return bad('span: uvarint');
    this.b = this.b.subarray(n);
    return v;
  }

  fixed(n: number): Uint8Array {
    if (n < 0 || this.b.length < n) return bad('span: short');
    const out = this.b.subarray(0, n);
    this.b = this.b.subarray(n);
    return out;
  }

  bits(n: number): Bits {
    const l = Math.ceil(n / 8);
    const raw = this.fixed(l);
    const v = new Bits(raw);
    if (v.bitLen() > n) bad('span: bit list longer than its length');
    return v;
  }
}

interface SpanTx {
  typ: number;
  /** the RLP item (a list for every supported type) */
  data: Uint8Array;
}

const u256 = (it: Item): bigint => uintOf(it, 32);

function structOf(data: Uint8Array, n: number): Item[] {
  const f = decodeList(data);
  if (f.length < n) throw new RlpError('too few elements');
  if (f.length > n) throw new RlpError('input list has too many elements');
  return f;
}

const beUint = (b: Uint8Array): bigint => {
  let v = 0n;
  for (const x of b) v = (v << 8n) | BigInt(x);
  return v;
};

/** rebuildTx: the consensus encoding of one span-batch transaction (tx.MarshalBinary of the rebuilt go transaction). */
function rebuildTx(
  typ: number, data: Uint8Array, nonce: bigint, gas: bigint, to: Uint8Array | null, sig: Uint8Array, yPar: number, chainId: bigint,
  prot: () => number,
): Uint8Array {
  const r = beUint(sig.subarray(0, 32));
  const s = beUint(sig.subarray(32, 64));
  const y = BigInt(yPar);
  try {
    switch (typ) {
      case TX_LEGACY: {
        // Value, GasPrice, Data
        const f = structOf(data, 3);
        const value = u256(f[0]!);
        const gasPrice = u256(f[1]!);
        const input = bytesOf(f[2]!);
        let v = 27n + y;
        if (prot() === 1) v = chainId * 2n + 35n + y;
        return encodeLegacyTx({ nonce, gasPrice, gas, to, value, data: input, v, r, s });
      }
      case TX_ACCESS_LIST: {
        // Value, GasPrice, Data, AccessList
        const f = structOf(data, 4);
        const value = u256(f[0]!);
        const gasPrice = u256(f[1]!);
        const input = bytesOf(f[2]!);
        checkAccessList(f[3]!);
        return encodeAccessListTx({ chainId, nonce, gasPrice, gas, to, value, data: input, accessList: f[3]!.raw, v: y, r, s });
      }
      case TX_DYNAMIC_FEE: {
        // Value, GasTipCap, GasFeeCap, Data, AccessList
        const f = structOf(data, 5);
        const value = u256(f[0]!);
        const gasTipCap = u256(f[1]!);
        const gasFeeCap = u256(f[2]!);
        const input = bytesOf(f[3]!);
        checkAccessList(f[4]!);
        return encodeDynamicFeeTx({ chainId, nonce, gasTipCap, gasFeeCap, gas, to, value, data: input, accessList: f[4]!.raw, v: y, r, s });
      }
      case TX_SET_CODE: {
        // Value, GasTipCap, GasFeeCap, Data, AccessList, AuthorizationList
        const f = structOf(data, 6);
        const value = u256(f[0]!);
        const gasTipCap = u256(f[1]!);
        const gasFeeCap = u256(f[2]!);
        const input = bytesOf(f[3]!);
        checkAccessList(f[4]!);
        checkAuthList(f[5]!);
        if (to === null) return bad('span: 7702 tx without to');
        return encodeSetCodeTx({ chainId, nonce, gasTipCap, gasFeeCap, gas, to, value, data: input, accessList: f[4]!.raw, authList: f[5]!.raw, v: y, r, s });
      }
      default:
        throw new BatchFormatError(typ);
    }
  } catch (e) {
    if (e instanceof RlpError || e instanceof EthTxError) throw new BatchStreamError(`span: transaction: ${e.message}`);
    throw e;
  }
}

/**
 * decodeSpanBatch decodes a span batch payload (batch type byte already removed) into one Batch per L2 block, per the Delta
 * specification: prefix = rel_timestamp ++ l1_origin_num ++ parent_check(20) ++ l1_origin_check(20); payload = block_count ++
 * origin_bits ++ block_tx_counts ++ txs (tx_sigs, tx_tos, tx_datas, tx_nonces, tx_gases, protected_bits).
 */
export function decodeSpanBatch(payload: Uint8Array, sp: SpanParams): Batch[] {
  const r = new SpanReader(payload);
  const rel = r.uvarint();
  const originNum = r.uvarint();
  const parentCheck = r.fixed(20);
  const originCheck = r.fixed(20);
  const blockCountBig = r.uvarint();
  if (blockCountBig === 0n || blockCountBig > BigInt(MAX_SPAN_BLOCKS)) bad('span: block count');
  const blockCount = Number(blockCountBig);
  const originBits = r.bits(blockCount);
  const counts: bigint[] = [];
  let total = 0;
  for (let i = 0; i < blockCount; i++) {
    const c = r.uvarint();
    // an exact sum: Go adds in uint64 and a wrapped sum slips under the bound (see the finding on span.go)
    if (c > BigInt(MAX_SPAN_TXS - total)) bad('span: tx count');
    total += Number(c);
    counts.push(c);
  }
  const creation = r.bits(total);
  const yParity = r.bits(total);
  if (r.b.length < total * 64) bad('span: short');
  const sigs: Uint8Array[] = [];
  for (let i = 0; i < total; i++) sigs.push(r.fixed(64));
  const tos: (Uint8Array | null)[] = [];
  for (let i = 0; i < total; i++) tos.push(creation.bit(i) === 0 ? r.fixed(20) : null);
  // tx_datas: per tx the type-specific RLP payload (legacy has no type byte); each item ends where its own RLP ends.
  const txs: SpanTx[] = [];
  for (let i = 0; i < total; i++) {
    if (r.b.length === 0) bad('span: short');
    let t = 0;
    if (r.b[0]! < 0x80) {
      t = r.b[0]!;
      r.b = r.b.subarray(1);
    }
    let it: Item;
    try {
      it = split(r.b);
    } catch (e) {
      if (e instanceof RlpError) return bad('span: tx data');
      throw e;
    }
    txs.push({ typ: t, data: r.b.subarray(0, r.b.length - it.rest.length) });
    r.b = it.rest;
  }
  const nonces: bigint[] = [];
  for (let i = 0; i < total; i++) nonces.push(r.uvarint());
  const gases: bigint[] = [];
  for (let i = 0; i < total; i++) gases.push(r.uvarint());
  let legacy = 0;
  for (const t of txs) if (t.typ === 0) legacy++;
  const protectedBits = r.bits(legacy);
  if (r.b.length !== 0) bad('span: trailing bytes');
  // L1 origin numbers: counted back from the last block through the origin bits (a set bit i > 0 means block i advanced the origin).
  const origins: bigint[] = new Array<bigint>(blockCount);
  let cur = originNum;
  for (let i = blockCount - 1; i >= 0; i--) {
    origins[i] = cur;
    if (originBits.bit(i) === 1 && i > 0) {
      if (cur === 0n) bad('span: origin underflow');
      cur--;
    }
  }
  const out: Batch[] = [];
  let ti = 0;
  let li = 0;
  for (let i = 0; i < blockCount; i++) {
    const b: Batch = {
      type: 1,
      parentHash: new Uint8Array(32),
      parentLen: 0,
      epochNum: origins[i]!,
      epochHash: new Uint8Array(32),
      epochLen: 0,
      timestamp: BigInt.asUintN(64, sp.genesisTime + rel + sp.blockTime * BigInt(i)),
      txs: [],
      spanIndex: i,
      spanBlocks: blockCount,
    };
    if (i === 0) {
      b.parentHash.set(parentCheck);
      b.parentLen = 20;
    }
    if (i === blockCount - 1) {
      b.epochHash.set(originCheck);
      b.epochLen = 20;
    }
    for (let k = 0n; k < counts[i]!; k++) {
      const tx = txs[ti]!;
      const isLegacy = tx.typ === 0;
      // prot() is read only for a legacy transaction, at its position among the legacy ones
      const raw = rebuildTx(tx.typ, tx.data, nonces[ti]!, gases[ti]!, tos[ti]!, sigs[ti]!, yParity.bit(ti), sp.chainId, () => protectedBits.bit(li));
      if (isLegacy) li++;
      b.txs.push(raw);
      ti++;
    }
    out.push(b);
  }
  return out;
}

/**
 * decodeBatches splits the decompressed channel into RLP strings (type byte || payload) and decodes each: type 0 singular, type 1 span.
 * Any other type is a BatchFormatError; a stream that does not parse is a BatchStreamError.
 */
export function decodeBatches(stream: Uint8Array, sp: SpanParams): Batch[] {
  const out: Batch[] = [];
  let rest = stream;
  while (rest.length > 0) {
    let it: Item;
    try {
      it = split(rest);
    } catch (e) {
      if (e instanceof RlpError) return bad('batch stream');
      throw e;
    }
    // rlp.Split's kind Byte (a lone byte below 0x80) is not a String: refused with the empty string
    if (it.kind !== 'string' || it.content.length === 0) return bad('batch stream');
    rest = it.rest;
    const content = it.content;
    switch (content[0]) {
      case 0: {
        let f: Item[];
        try {
          f = decodeList(content.subarray(1));
          if (f.length !== 5) throw new RlpError('wrong number of elements');
          const parentHash = Uint8Array.from(fixedOf(f[0]!, 32));
          const epochNum = uintOf(f[1]!, 8);
          const epochHash = Uint8Array.from(fixedOf(f[2]!, 32));
          const timestamp = uintOf(f[3]!, 8);
          if (f[4]!.kind !== 'list') throw new RlpError('expected input list');
          const txs = decodeList(f[4]!.raw).map((t) => Uint8Array.from(bytesOf(t)));
          out.push({ type: 0, parentHash, parentLen: 32, epochNum, epochHash, epochLen: 32, timestamp, txs, spanIndex: 0, spanBlocks: 1 });
        } catch (e) {
          if (e instanceof RlpError) return bad('singular batch');
          throw e;
        }
        break;
      }
      case 1:
        out.push(...decodeSpanBatch(content.subarray(1), sp));
        break;
      default:
        throw new BatchFormatError(content[0]!);
    }
  }
  return out;
}
