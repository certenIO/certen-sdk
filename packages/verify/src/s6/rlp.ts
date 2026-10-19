/**
 * RLP exactly as go-ethereum v1.17.7 reads it (rlp/raw.go readKind/Split, rlp/decode.go Stream): the canonical-size rules
 * (a single byte below 0x80 is never wrapped, a long size is never below 56 nor has a leading zero byte), a value never
 * reaches past its enclosing list or input, an integer has no leading zero byte, and a decode of a whole value
 * (rlp.DecodeBytes) admits nothing after it. Any violation is an RlpError; the caller maps it to its named state.
 */

export class RlpError extends Error {}

const fail = (m: string): never => {
  throw new RlpError(m);
};

export type Kind = 'byte' | 'string' | 'list';

/** One item of an RLP buffer: its kind, its content (the byte itself for a single byte) and what follows it. */
export interface Item {
  kind: Kind;
  content: Uint8Array;
  rest: Uint8Array;
  /** The whole encoding of the item. */
  raw: Uint8Array;
}

function readSize(b: Uint8Array, slen: number): number {
  if (slen > b.length) fail('unexpected EOF');
  let s = 0;
  for (let i = 0; i < slen; i++) s = s * 256 + b[i]!;
  if (s < 56 || b[0] === 0) fail('non-canonical size information');
  return s;
}

/** go-ethereum rlp.Split: the first item of buf, everything after it is rest. */
export function split(buf: Uint8Array): Item {
  if (buf.length === 0) fail('unexpected EOF');
  const b = buf[0]!;
  let kind: Kind;
  let tag: number;
  let size: number;
  if (b < 0x80) {
    kind = 'byte';
    tag = 0;
    size = 1;
  } else if (b < 0xb8) {
    kind = 'string';
    tag = 1;
    size = b - 0x80;
    if (size === 1 && buf.length > 1 && buf[1]! < 128) fail('non-canonical size information');
  } else if (b < 0xc0) {
    kind = 'string';
    tag = b - 0xb7 + 1;
    size = readSize(buf.subarray(1), b - 0xb7);
  } else if (b < 0xf8) {
    kind = 'list';
    tag = 1;
    size = b - 0xc0;
  } else {
    kind = 'list';
    tag = b - 0xf7 + 1;
    size = readSize(buf.subarray(1), b - 0xf7);
  }
  if (size > buf.length - tag) fail('value size exceeds available input length');
  return { kind, content: buf.subarray(tag, tag + size), rest: buf.subarray(tag + size), raw: buf.subarray(0, tag + size) };
}

export function splitString(buf: Uint8Array): Item {
  const it = split(buf);
  if (it.kind === 'list') fail('expected String or Byte');
  return it;
}

export function splitList(buf: Uint8Array): Item {
  const it = split(buf);
  if (it.kind !== 'list') fail('expected List');
  return it;
}

/** go-ethereum rlp.CountValues. */
export function countValues(b: Uint8Array): number {
  let n = 0;
  while (b.length > 0) {
    b = split(b).rest;
    n++;
  }
  return n;
}

// ---------------------------------------------------------------------------------------------------------------------
// Whole-value decoding (rlp.DecodeBytes into a struct)

/** The items of a list's content, each wholly inside it. */
export function listItems(content: Uint8Array): Item[] {
  const out: Item[] = [];
  let b = content;
  while (b.length > 0) {
    const it = split(b);
    out.push(it);
    b = it.rest;
  }
  return out;
}

/** rlp.DecodeBytes into a list type: one list and nothing after it; its items. */
export function decodeList(buf: Uint8Array): Item[] {
  const it = split(buf);
  if (it.rest.length > 0) fail('input contains more than one value');
  if (it.kind !== 'list') fail('expected input list');
  return listItems(it.content);
}

/** A []byte value. */
export function bytesOf(it: Item): Uint8Array {
  if (it.kind === 'list') fail('expected input string or byte');
  return it.content;
}

/** A [n]byte value. */
export function fixedOf(it: Item, n: number): Uint8Array {
  if (it.kind === 'list') fail('expected input string or byte');
  if (it.kind === 'byte') {
    if (n !== 1) fail(n === 0 ? 'input string too long' : 'input string too short');
    return it.content;
  }
  if (it.content.length > n) fail('input string too long');
  if (it.content.length < n) fail('input string too short');
  return it.content;
}

/** An unsigned integer of at most maxBytes bytes (uint64: 8, uint256: 32, *big.Int: unbounded). */
export function uintOf(it: Item, maxBytes = Infinity): bigint {
  if (it.kind === 'list') fail('expected input string or byte');
  const c = it.content;
  if (it.kind === 'byte') {
    if (c[0] === 0) fail('non-canonical integer (leading zero bytes)');
    return BigInt(c[0]!);
  }
  if (c.length > maxBytes) fail('integer overflow');
  if (c.length > 0 && c[0] === 0) fail('non-canonical integer (leading zero bytes)');
  let v = 0n;
  for (const x of c) v = (v << 8n) | BigInt(x);
  return v;
}

/** A struct of `required` fields and up to `optional` trailing optional fields: the item count must be in range. */
export function structItems(buf: Uint8Array, required: number, optional = 0): Item[] {
  const items = decodeList(buf);
  if (items.length < required) fail('too few elements');
  if (items.length > required + optional) fail('input list has too many elements');
  return items;
}
