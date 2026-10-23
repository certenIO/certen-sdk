/**
 * The derivation of Nitro's transactions from one delayed-inbox message, and the L2-message parser a sequencer batch and a delayed
 * message share (the twin of pkg/finality/arbposted/derive.go; nitro@ccc5c82 arbos/parse_l2.go). The transactions are consensus encodings
 * (type byte || rlp(fields), field order of OffchainLabs go-ethereum core/types/arb_types.go). The header Nitro gives such a message is
 * {Poster: the Bridge message's sender, RequestId: the delayed message index k as a hash, L1BaseFee: the message's baseFeeL1}.
 *
 * A short field, an unknown L2 kind or a nested failure fails the WHOLE message, as in Nitro; a batch whose length prefix is cut, oversize
 * or past the data ends quietly with what it has. Every read is checked against the bytes that remain before anything is taken.
 */
import { keccak_256 } from '@noble/hashes/sha3';
import { rlpUint, decodeTx, EthTxError, TX_BLOB } from '../baseposted/ethtx.js';
import { rlpBytes, rlpListOf } from '../baseposted/trie.js';
import { MSG_KIND_ETH_DEPOSIT, TX_DEPOSIT } from './delayed.js';
import { L2_BATCH, L2_SIGNED_TX, MAX_L2_MESSAGE_SIZE } from './nitro.js';
import type { Delayed } from './wire.js';

// L1 message kinds (nitro arbos/arbostypes/incomingmessage.go) that become transactions.
export const MSG_KIND_L2_MESSAGE = 3;
export const MSG_KIND_L2_FUNDED_BY_L1 = 7;
export const MSG_KIND_SUBMIT_RETRYABLE = 9;

// L2 message kinds (parse_l2.go).
export const L2_KIND_UNSIGNED = 0;
export const L2_KIND_CONTRACT = 1;

// Arbitrum transaction types a delayed message produces (the deposit, 0x64, is in delayed.ts with the ETH-deposit message kind).
export const TX_UNSIGNED = 0x65;
export const TX_CONTRACT = 0x66;
export const TX_SUBMIT_RETRYABLE = 0x69;

/** parse_l2.go's batch nesting limit. */
export const DERIVED_MAX_DEPTH = 16;

const ZERO_HASH = new Uint8Array(32);
const ZERO_ADDRESS = new Uint8Array(20);

const beBig = (b: Uint8Array): bigint => {
  let v = 0n;
  for (const x of b) v = (v << 8n) | BigInt(x);
  return v;
};

const w32 = (v: bigint): Uint8Array => {
  const out = new Uint8Array(32);
  for (let i = 31; i >= 0 && v > 0n; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
};

const MAX_UINT64 = (1n << 64n) - 1n;

/** A cursor over a message: a read past the end marks the reader bad and returns null from then on. */
class MsgReader {
  off = 0;
  bad = false;
  constructor(readonly b: Uint8Array) {}

  take(n: number): Uint8Array | null {
    if (this.bad || n < 0 || this.off + n > this.b.length) {
      this.bad = true;
      return null;
    }
    const out = this.b.subarray(this.off, this.off + n);
    this.off += n;
    return out;
  }

  /** common.BytesToHash(take(32)): the zero hash after a failed read (the caller checks bad before it uses the value) */
  hash(): Uint8Array {
    const w = this.take(32);
    return w === null ? ZERO_HASH : w;
  }

  /** util.AddressFrom256FromReader: the low 20 bytes of a 32-byte word */
  addr256(): Uint8Array {
    const w = this.take(32);
    return w === null ? ZERO_ADDRESS : w.subarray(12);
  }

  rest(): Uint8Array {
    if (this.bad) return new Uint8Array(0);
    const out = this.b.subarray(this.off);
    this.off = this.b.length;
    return out;
  }
}

/** optAddr: the empty string for the zero address, else the 20 bytes. */
const optAddr = (a: Uint8Array): Uint8Array => (a.every((x) => x === 0) ? new Uint8Array(0) : a);

type Field = bigint | number | Uint8Array;

/** The consensus encoding type || rlp(fields); integers are minimal big-endian, byte strings are RLP strings. */
function encTx(typ: number, ...fields: Field[]): Uint8Array {
  const items = fields.map((f) => (f instanceof Uint8Array ? rlpBytes(f) : rlpUint(BigInt(f))));
  const body = rlpListOf(items);
  const out = new Uint8Array(1 + body.length);
  out[0] = typ;
  out.set(body, 1);
  return out;
}

interface Unsigned {
  tx: Uint8Array;
  value: bigint;
}

/** parseUnsignedTx: gas limit, max fee, nonce (kind 0 only), to, value, calldata. */
function parseUnsigned(r: MsgReader, poster: Uint8Array, requestId: Uint8Array | null, chainId: bigint, kind: number): Unsigned | null {
  const gasW = beBig(r.hash());
  const maxFee = beBig(r.hash());
  let nonce: bigint | null = null;
  if (kind === L2_KIND_UNSIGNED) nonce = beBig(r.hash());
  const to = r.addr256();
  const value = beBig(r.hash());
  const data = r.rest();
  if (r.bad || gasW > MAX_UINT64 || (nonce !== null && nonce > MAX_UINT64)) return null;
  switch (kind) {
    case L2_KIND_UNSIGNED:
      return { tx: encTx(TX_UNSIGNED, chainId, poster, nonce!, maxFee, gasW, optAddr(to), value, data), value };
    case L2_KIND_CONTRACT:
      if (requestId === null) return null;
      return { tx: encTx(TX_CONTRACT, chainId, requestId, poster, maxFee, gasW, optAddr(to), value, data), value };
  }
  return null;
}

/**
 * parseL2Msg is parseL2Message for the kinds a delayed L2 message can hold: unsigned (0), contract (1), batch (3), signed (4). Any other
 * kind, a short field or a nested failure fails the whole message (null), as in Nitro. unmarshalSigned is true for a delayed message
 * (the signed transaction is decoded and re-encoded as go-ethereum does); false for a sequencer batch, whose bytes are compared with
 * the block's own transactions, which are valid by construction.
 */
export function parseL2Msg(
  msg: Uint8Array,
  poster: Uint8Array,
  requestId: Uint8Array | null,
  chainId: bigint,
  depth: number,
  unmarshalSigned: boolean,
): Uint8Array[] | null {
  const r = new MsgReader(msg);
  const k = r.take(1);
  if (k === null) return null;
  switch (k[0]) {
    case L2_KIND_UNSIGNED:
    case L2_KIND_CONTRACT: {
      const u = parseUnsigned(r, poster, requestId, chainId, k[0]);
      return u === null ? null : [u.tx];
    }
    case L2_BATCH: {
      if (depth >= DERIVED_MAX_DEPTH) return null;
      const out: Uint8Array[] = [];
      let index = 0n;
      for (;;) {
        const lenBytes = r.take(8);
        if (lenBytes === null) return out; // no further messages in the batch
        const n = beBig(lenBytes);
        if (n > BigInt(MAX_L2_MESSAGE_SIZE)) return out;
        const nested = r.take(Number(n));
        if (nested === null) return out;
        let sub: Uint8Array | null = null;
        if (requestId !== null) sub = keccak_256(concatTwo(requestId, w32(index)));
        const txs = parseL2Msg(nested, poster, sub, chainId, depth + 1, unmarshalSigned);
        if (txs === null) return null;
        for (const t of txs) out.push(t);
        index += 1n;
      }
    }
    case L2_SIGNED_TX: {
      const rest = r.rest();
      if (!unmarshalSigned) {
        // sequencer batches: the bytes are compared with the block's own transactions, which are valid by construction, so a message
        // transaction that is not valid can never equal one and needs no unmarshalling to be unmatched
        if (rest.length === 0 || (rest[0]! < 0xc0 && rest[0] !== 1 && rest[0] !== 2 && rest[0] !== 4)) return null; // empty, or a type Nitro refuses
        return [Uint8Array.from(rest)];
      }
      let type: number;
      try {
        type = decodeTx(rest).type;
      } catch (e) {
        if (e instanceof EthTxError) return null;
        throw e;
      }
      if (type >= 0x64 || type === TX_BLOB) return null;
      // go-ethereum decodes strictly (canonical sizes and integers, no trailing byte), so the re-encoding is the input
      return [Uint8Array.from(rest)];
    }
  }
  return null;
}

const concatTwo = (a: Uint8Array, b: Uint8Array): Uint8Array => {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
};

/**
 * deriveDelayed returns the transactions Nitro builds from the delayed message d on the chain chainId, in order. null is a message kind
 * this verifier does not derive (end-of-block, rollup event, batch posting report, ...) and a message Nitro itself would refuse.
 */
export function deriveDelayed(chainId: bigint, d: Delayed): Uint8Array[] | null {
  if (d.data.length > MAX_L2_MESSAGE_SIZE) return null;
  const req = w32(d.k);
  const poster = d.sender;
  const r = new MsgReader(d.data);
  switch (d.msgKind) {
    case MSG_KIND_ETH_DEPOSIT: {
      const to = r.take(20);
      const value = beBig(r.hash());
      if (r.bad || to === null) return null;
      return [encTx(TX_DEPOSIT, chainId, req, poster, to, value)];
    }
    case MSG_KIND_SUBMIT_RETRYABLE: {
      const retryTo = r.addr256();
      const callvalue = beBig(r.hash());
      const deposit = beBig(r.hash());
      const maxSubmission = beBig(r.hash());
      const feeRefund = r.addr256();
      const callvalueRefund = r.addr256();
      const gasW = beBig(r.hash());
      const maxFee = beBig(r.hash());
      const dataLenW = beBig(r.hash());
      if (r.bad || gasW > MAX_UINT64 || dataLenW > MAX_UINT64 || dataLenW > BigInt(MAX_L2_MESSAGE_SIZE)) return null;
      const data = r.take(Number(dataLenW));
      if (r.bad || data === null) return null;
      const l1BaseFee = beBig(d.baseFeeL1);
      return [
        encTx(TX_SUBMIT_RETRYABLE, chainId, req, poster, l1BaseFee, deposit, maxFee, gasW, optAddr(retryTo), callvalue, callvalueRefund, maxSubmission, feeRefund, data),
      ];
    }
    case MSG_KIND_L2_MESSAGE:
      return parseL2Msg(d.data, poster, req, chainId, 0, true);
    case MSG_KIND_L2_FUNDED_BY_L1: {
      const kind = r.take(1);
      if (kind === null) return null;
      const depositId = keccak_256(concatTwo(req, w32(0n)));
      const unsignedId = keccak_256(concatTwo(req, w32(1n)));
      const u = parseUnsigned(r, poster, unsignedId, chainId, kind[0]!);
      if (u === null) return null;
      // Nitro leaves the deposit's From unset (the zero address) and funds the poster
      return [encTx(TX_DEPOSIT, chainId, depositId, ZERO_ADDRESS, poster, u.value), u.tx];
    }
  }
  return null;
}
