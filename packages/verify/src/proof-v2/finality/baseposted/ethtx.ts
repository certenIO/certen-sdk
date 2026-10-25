/**
 * The Ethereum L1 batcher transaction as the Base `l1_posted` kind reads it (V2_SPEC_S7 5.4 O3): a strict port of what
 * go-ethereum v1.17.7 does for `tx.UnmarshalBinary(raw)` followed by `types.LatestSignerForChainID(chainID).Sender(&tx)` (the Prague signer:
 * legacy, EIP-2930, EIP-1559, EIP-4844 and EIP-7702 transactions) and the accessors `To()`, `Type()`, `BlobHashes()` and `Data()`.
 *
 * Decoding follows the rlp package rules exactly (the same canonical-size and canonical-integer rules as src/s6/rlp.ts): every input
 * go refuses is refused here, with an EthTxError. Signer recovery follows recoverPlain/ValidateSignatureValues with homestead = true
 * (r and s in [1, N-1], s <= N/2, recovery id 0 or 1). The signed payload is rebuilt from the RAW items of the decoded transaction: they
 * are canonical (decoding is strict), so they equal go's re-encoding.
 *
 * The small RLP encoder and the consensus-form tx encoders at the end serve the span-batch decoder (span.ts), which rebuilds each
 * transaction the way go's tx.MarshalBinary writes it.
 */
import { keccak_256 } from '@noble/hashes/sha3';
import { secp256k1 } from '@noble/curves/secp256k1';
import { RlpError, bytesOf, decodeList, fixedOf, listItems, split, splitList, uintOf, type Item } from '../../../s6/rlp.js';

/** A transaction go refuses to decode, or a signature its signer refuses. */
export class EthTxError extends Error {}

/** The transaction types go-ethereum's Prague signer supports. */
export const TX_LEGACY = 0;
export const TX_ACCESS_LIST = 1;
export const TX_DYNAMIC_FEE = 2;
export const TX_BLOB = 3;
export const TX_SET_CODE = 4;

/** A decoded L1 transaction: what Kind.Verify reads (type, to, data, blob hashes) and what sender recovery needs. */
export interface L1Tx {
  type: number;
  /** The declared chain id (typed transactions); null for a legacy transaction (it is derived from V). */
  chainId: bigint | null;
  nonce: bigint;
  gas: bigint;
  /** tx.To(): null for a contract creation (legacy, 2930, 1559 only); blob and set-code transactions always have 20 bytes. */
  to: Uint8Array | null;
  data: Uint8Array;
  /** tx.BlobHashes(): the 32-byte versioned hashes of a blob transaction; empty for every other type. */
  blobHashes: Uint8Array[];
  v: bigint;
  r: bigint;
  s: bigint;
  /** The raw RLP items the signature covers (everything but V, R, S), canonical because decoding is strict. */
  signed: Uint8Array[];
}

const fail = (m: string): never => {
  throw new EthTxError(m);
};

/** Runs f, turning an RlpError into the EthTxError the caller reports. */
function rlp<T>(f: () => T): T {
  try {
    return f();
  } catch (e) {
    if (e instanceof RlpError) throw new EthTxError(e.message);
    throw e;
  }
}

// ---- field decoders (rlp struct field rules) ----

const u64 = (it: Item): bigint => uintOf(it, 8);
const u256 = (it: Item): bigint => uintOf(it, 32);
const big = (it: Item): bigint => uintOf(it);

/** A `*common.Address` field tagged `rlp:"nil"`: the empty string is nil, otherwise exactly 20 bytes (an empty list is refused). */
function optAddress(it: Item): Uint8Array | null {
  if (it.kind === 'string' && it.content.length === 0) return null;
  if (it.kind === 'list' && it.content.length === 0) throw new RlpError('wrong kind of empty value (got list, want string)');
  return fixedOf(it, 20);
}

/** An EIP-2930 access list: a list of [address(20), [storageKey(32)...]]. */
export function checkAccessList(it: Item): void {
  if (it.kind !== 'list') throw new RlpError('expected input list');
  for (const tuple of listItems(it.content)) {
    const f = decodeList(tuple.raw);
    if (f.length < 2) throw new RlpError('too few elements');
    if (f.length > 2) throw new RlpError('input list has too many elements');
    fixedOf(f[0]!, 20);
    if (f[1]!.kind !== 'list') throw new RlpError('expected input list');
    for (const k of listItems(f[1]!.content)) fixedOf(k, 32);
  }
}

/** An EIP-7702 authorization list: a list of [chainId u256, address(20), nonce u64, yParity u8, r u256, s u256]. */
export function checkAuthList(it: Item): void {
  if (it.kind !== 'list') throw new RlpError('expected input list');
  for (const a of listItems(it.content)) {
    const f = decodeList(a.raw);
    if (f.length < 6) throw new RlpError('too few elements');
    if (f.length > 6) throw new RlpError('input list has too many elements');
    u256(f[0]!);
    fixedOf(f[1]!, 20);
    u64(f[2]!);
    uintOf(f[3]!, 1);
    u256(f[4]!);
    u256(f[5]!);
  }
}

function checkHashes(it: Item): Uint8Array[] {
  if (it.kind !== 'list') throw new RlpError('expected input list');
  return listItems(it.content).map((h) => Uint8Array.from(fixedOf(h, 32)));
}

function exact(items: Item[], n: number): void {
  if (items.length < n) throw new RlpError('too few elements');
  if (items.length > n) throw new RlpError('input list has too many elements');
}

const copyOf = (b: Uint8Array): Uint8Array => Uint8Array.from(b);

// ---- decoding ----

function decodeLegacy(raw: Uint8Array): L1Tx {
  const f = decodeList(raw);
  exact(f, 9);
  const nonce = u64(f[0]!);
  big(f[1]!); // GasPrice
  const gas = u64(f[2]!);
  const to = optAddress(f[3]!);
  big(f[4]!); // Value
  const data = copyOf(bytesOf(f[5]!));
  return {
    type: TX_LEGACY, chainId: null, nonce, gas, to: to === null ? null : copyOf(to), data, blobHashes: [],
    v: big(f[6]!), r: big(f[7]!), s: big(f[8]!), signed: f.slice(0, 6).map((i) => copyOf(i.raw)),
  };
}

function decodeAccessListTx(body: Uint8Array): L1Tx {
  const f = decodeList(body);
  exact(f, 11);
  const chainId = big(f[0]!);
  const nonce = u64(f[1]!);
  big(f[2]!);
  const gas = u64(f[3]!);
  const to = optAddress(f[4]!);
  big(f[5]!);
  const data = copyOf(bytesOf(f[6]!));
  checkAccessList(f[7]!);
  return {
    type: TX_ACCESS_LIST, chainId, nonce, gas, to: to === null ? null : copyOf(to), data, blobHashes: [],
    v: big(f[8]!), r: big(f[9]!), s: big(f[10]!), signed: f.slice(0, 8).map((i) => copyOf(i.raw)),
  };
}

function decodeDynamicFeeTx(body: Uint8Array): L1Tx {
  const f = decodeList(body);
  exact(f, 12);
  const chainId = big(f[0]!);
  const nonce = u64(f[1]!);
  big(f[2]!);
  big(f[3]!);
  const gas = u64(f[4]!);
  const to = optAddress(f[5]!);
  big(f[6]!);
  const data = copyOf(bytesOf(f[7]!));
  checkAccessList(f[8]!);
  return {
    type: TX_DYNAMIC_FEE, chainId, nonce, gas, to: to === null ? null : copyOf(to), data, blobHashes: [],
    v: big(f[9]!), r: big(f[10]!), s: big(f[11]!), signed: f.slice(0, 9).map((i) => copyOf(i.raw)),
  };
}

function decodeSetCodeTx(body: Uint8Array): L1Tx {
  const f = decodeList(body);
  exact(f, 13);
  const chainId = u256(f[0]!);
  const nonce = u64(f[1]!);
  u256(f[2]!);
  u256(f[3]!);
  const gas = u64(f[4]!);
  const to = copyOf(fixedOf(f[5]!, 20));
  u256(f[6]!);
  const data = copyOf(bytesOf(f[7]!));
  checkAccessList(f[8]!);
  checkAuthList(f[9]!);
  return {
    type: TX_SET_CODE, chainId, nonce, gas, to, data, blobHashes: [],
    v: u256(f[10]!), r: u256(f[11]!), s: u256(f[12]!), signed: f.slice(0, 10).map((i) => copyOf(i.raw)),
  };
}

const BLOB_BYTES = 131072;

/** The 14 fields of a blob transaction: chainId, nonce, tip, feeCap, gas, to, value, data, accessList, blobFeeCap, blobHashes, V, R, S. */
function blobFields(f: Item[]): L1Tx {
  exact(f, 14);
  const chainId = u256(f[0]!);
  const nonce = u64(f[1]!);
  u256(f[2]!);
  u256(f[3]!);
  const gas = u64(f[4]!);
  const to = copyOf(fixedOf(f[5]!, 20));
  u256(f[6]!);
  const data = copyOf(bytesOf(f[7]!));
  checkAccessList(f[8]!);
  u256(f[9]!);
  const blobHashes = checkHashes(f[10]!);
  return {
    type: TX_BLOB, chainId, nonce, gas, to, data, blobHashes,
    v: u256(f[11]!), r: u256(f[12]!), s: u256(f[13]!), signed: f.slice(0, 11).map((i) => copyOf(i.raw)),
  };
}

/** A list of fixed-size byte arrays ([]kzg4844.Blob, []Commitment, []Proof). */
function fixedList(it: Item, n: number): void {
  if (it.kind !== 'list') throw new RlpError('expected input list');
  for (const e of listItems(it.content)) fixedOf(e, n);
}

/**
 * BlobTx.decode: the canonical encoding is the list of fields; the network encoding wraps it with its sidecar, [tx, blobs, commitments,
 * proofs] (version 0) or [tx, version, blobs, commitments, proofs] (version 1, version must be 1). The two are told apart by whether
 * the first element is a list, and the second element a list.
 */
function decodeBlobTx(body: Uint8Array): L1Tx {
  const outer = splitList(body);
  const first = split(outer.content);
  if (first.kind !== 'list') return blobFields(decodeList(body));
  const second = split(first.rest);
  const items = decodeList(body);
  if (second.kind === 'list') {
    exact(items, 4);
    fixedList(items[1]!, BLOB_BYTES);
    fixedList(items[2]!, 48);
    fixedList(items[3]!, 48);
  } else {
    exact(items, 5);
    if (uintOf(items[1]!, 1) !== 1n) throw new RlpError('unsupported blob tx version');
    fixedList(items[2]!, BLOB_BYTES);
    fixedList(items[3]!, 48);
    fixedList(items[4]!, 48);
  }
  return blobFields(decodeList(items[0]!.raw));
}

/**
 * tx.UnmarshalBinary. A first byte above 0x7f is a legacy transaction (an RLP list); otherwise an EIP-2718 envelope of at least two
 * bytes whose type is 1, 2, 3 or 4. Anything else, and every field go's rlp decode refuses, is an EthTxError.
 */
export function decodeTx(raw: Uint8Array): L1Tx {
  return rlp(() => {
    if (raw.length > 0 && raw[0]! > 0x7f) return decodeLegacy(raw);
    if (raw.length <= 1) return fail('typed transaction too short');
    const body = raw.subarray(1);
    switch (raw[0]) {
      case TX_ACCESS_LIST:
        return decodeAccessListTx(body);
      case TX_DYNAMIC_FEE:
        return decodeDynamicFeeTx(body);
      case TX_BLOB:
        return decodeBlobTx(body);
      case TX_SET_CODE:
        return decodeSetCodeTx(body);
      default:
        return fail('transaction type not supported');
    }
  });
}

// ---- signer ----

const N = secp256k1.CURVE.n;
const HALF_N = N >> 1n;

const bitLen = (x: bigint): number => (x < 0n ? -x : x).toString(2).length - (x === 0n ? 1 : 0);

/** isProtectedV: a V that is not 0, 1, 27 or 28 (any V wider than a byte counts as protected). */
function isProtectedV(v: bigint): boolean {
  if (bitLen(v) <= 8) return v !== 27n && v !== 28n && v !== 1n && v !== 0n;
  return true;
}

/** deriveChainId, with go's uint64 arithmetic for a V that fits 64 bits. */
function deriveChainId(v: bigint): bigint {
  if (bitLen(v) <= 64) {
    if (v === 27n || v === 28n) return 0n;
    return BigInt.asUintN(64, v - 35n) / 2n;
  }
  return (v - 35n) >> 1n;
}

/** crypto.ValidateSignatureValues(v, r, s, homestead = true). */
function validSignatureValues(v: number, r: bigint, s: bigint): boolean {
  if (r < 1n || s < 1n) return false;
  if (s > HALF_N) return false;
  return r < N && s < N && (v === 0 || v === 1);
}

const concat = (parts: readonly Uint8Array[]): Uint8Array => {
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

const bigToBytes32 = (x: bigint): Uint8Array => {
  const out = new Uint8Array(32);
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  return out;
};

/** recoverPlain with homestead = true: Vb carries the legacy 27/28 convention, any value wider than a byte is invalid. */
function recoverPlain(sighash: Uint8Array, r: bigint, s: bigint, vb: bigint): Uint8Array {
  if (bitLen(vb) > 8) return fail('invalid transaction v, r, s values');
  // byte(Vb.Uint64() - 27): the low 8 bits of the wrapped difference
  const V = Number(BigInt.asUintN(8, (vb < 0n ? -vb : vb) - 27n));
  if (!validSignatureValues(V, r, s)) return fail('invalid transaction v, r, s values');
  let pub: Uint8Array;
  try {
    pub = new secp256k1.Signature(r, s, V).recoverPublicKey(sighash).toBytes(false);
  } catch {
    return fail('invalid signature: public key not recoverable');
  }
  if (pub.length === 0 || pub[0] !== 4) return fail('invalid public key');
  return keccak_256(pub.subarray(1)).slice(12);
}

/** rlp(uint) of a non-negative integer. */
export function rlpUint(v: bigint): Uint8Array {
  if (v < 0n) throw new EthTxError('rlp: negative integer');
  if (v === 0n) return Uint8Array.of(0x80);
  const bytes: number[] = [];
  for (let x = v; x > 0n; x >>= 8n) bytes.unshift(Number(x & 0xffn));
  return rlpBytes(Uint8Array.from(bytes));
}

function lengthHead(base: number, n: number): Uint8Array {
  if (n < 56) return Uint8Array.of(base + n);
  const len: number[] = [];
  for (let x = n; x > 0; x = Math.floor(x / 256)) len.unshift(x % 256);
  return Uint8Array.from([base + 55 + len.length, ...len]);
}

/** rlp(bytes): a single byte below 0x80 as itself. */
export function rlpBytes(b: Uint8Array): Uint8Array {
  if (b.length === 1 && b[0]! < 0x80) return Uint8Array.from(b);
  return concat([lengthHead(0x80, b.length), b]);
}

/** rlp(list) of already-encoded items. */
export function rlpList(items: readonly Uint8Array[]): Uint8Array {
  const body = concat(items);
  return concat([lengthHead(0xc0, body.length), body]);
}

export const concatBytes = concat;

/** The hash the signer asks the key to sign: the frontier hash for an unprotected legacy transaction, the EIP-155 hash for a protected one, the typed hash otherwise. */
export function sigHashOf(tx: L1Tx, signerChainId: bigint): Uint8Array {
  if (tx.type === TX_LEGACY) {
    if (!isProtectedV(tx.v)) return keccak_256(rlpList(tx.signed));
    return keccak_256(rlpList([...tx.signed, rlpUint(signerChainId), Uint8Array.of(0x80), Uint8Array.of(0x80)]));
  }
  return keccak_256(concat([Uint8Array.of(tx.type), rlpList(tx.signed)]));
}

/**
 * Sender of tx under the Prague signer for chain `signerChainId`: the 20-byte address recovered from the signature, or an EthTxError
 * for every case the signer refuses (legacy: protected with another chain id, V outside the 27/28 or EIP-155 forms; typed: another
 * chain id or a V other than 0 or 1; r or s outside [1, N-1]; s above N/2; an unrecoverable key).
 */
export function senderOf(tx: L1Tx, signerChainId: bigint): Uint8Array {
  if (tx.type === TX_LEGACY) {
    if (!isProtectedV(tx.v)) {
      // HomesteadSigner: the frontier hash (six fields), V must be 27 or 28
      return recoverPlain(sigHashOf(tx, signerChainId), tx.r, tx.s, tx.v);
    }
    const cid = deriveChainId(tx.v);
    if (cid !== signerChainId) return fail(`invalid chain id for signer: have ${cid} want ${signerChainId}`);
    return recoverPlain(sigHashOf(tx, signerChainId), tx.r, tx.s, tx.v - signerChainId - signerChainId - 8n);
  }
  if (tx.chainId !== signerChainId) return fail(`invalid chain id for signer: have ${tx.chainId} want ${signerChainId}`);
  return recoverPlain(sigHashOf(tx, signerChainId), tx.r, tx.s, tx.v + 27n);
}

// ---- consensus-form encoders (tx.MarshalBinary) for the span-batch decoder ----

const optTo = (to: Uint8Array | null): Uint8Array => (to === null ? Uint8Array.of(0x80) : rlpBytes(to));

/** Legacy: rlp([nonce, gasPrice, gas, to, value, data, V, R, S]). */
export function encodeLegacyTx(f: {
  nonce: bigint; gasPrice: bigint; gas: bigint; to: Uint8Array | null; value: bigint; data: Uint8Array; v: bigint; r: bigint; s: bigint;
}): Uint8Array {
  return rlpList([rlpUint(f.nonce), rlpUint(f.gasPrice), rlpUint(f.gas), optTo(f.to), rlpUint(f.value), rlpBytes(f.data), rlpUint(f.v), rlpUint(f.r), rlpUint(f.s)]);
}

/** EIP-2930: 0x01 || rlp([chainId, nonce, gasPrice, gas, to, value, data, accessList, V, R, S]); accessList is the already-encoded list. */
export function encodeAccessListTx(f: {
  chainId: bigint; nonce: bigint; gasPrice: bigint; gas: bigint; to: Uint8Array | null; value: bigint; data: Uint8Array; accessList: Uint8Array; v: bigint; r: bigint; s: bigint;
}): Uint8Array {
  return concat([Uint8Array.of(TX_ACCESS_LIST), rlpList([rlpUint(f.chainId), rlpUint(f.nonce), rlpUint(f.gasPrice), rlpUint(f.gas), optTo(f.to), rlpUint(f.value), rlpBytes(f.data), f.accessList, rlpUint(f.v), rlpUint(f.r), rlpUint(f.s)])]);
}

/** EIP-1559: 0x02 || rlp([chainId, nonce, tip, feeCap, gas, to, value, data, accessList, V, R, S]). */
export function encodeDynamicFeeTx(f: {
  chainId: bigint; nonce: bigint; gasTipCap: bigint; gasFeeCap: bigint; gas: bigint; to: Uint8Array | null; value: bigint; data: Uint8Array; accessList: Uint8Array; v: bigint; r: bigint; s: bigint;
}): Uint8Array {
  return concat([Uint8Array.of(TX_DYNAMIC_FEE), rlpList([rlpUint(f.chainId), rlpUint(f.nonce), rlpUint(f.gasTipCap), rlpUint(f.gasFeeCap), rlpUint(f.gas), optTo(f.to), rlpUint(f.value), rlpBytes(f.data), f.accessList, rlpUint(f.v), rlpUint(f.r), rlpUint(f.s)])]);
}

/** EIP-7702: 0x04 || rlp([chainId, nonce, tip, feeCap, gas, to, value, data, accessList, authList, V, R, S]); `to` is required. */
export function encodeSetCodeTx(f: {
  chainId: bigint; nonce: bigint; gasTipCap: bigint; gasFeeCap: bigint; gas: bigint; to: Uint8Array; value: bigint; data: Uint8Array; accessList: Uint8Array; authList: Uint8Array; v: bigint; r: bigint; s: bigint;
}): Uint8Array {
  return concat([Uint8Array.of(TX_SET_CODE), rlpList([rlpUint(f.chainId), rlpUint(f.nonce), rlpUint(f.gasTipCap), rlpUint(f.gasFeeCap), rlpUint(f.gas), rlpBytes(f.to), rlpUint(f.value), rlpBytes(f.data), f.accessList, f.authList, rlpUint(f.v), rlpUint(f.r), rlpUint(f.s)])]);
}

export { bigToBytes32 };
