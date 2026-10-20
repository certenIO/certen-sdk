/**
 * The root of an Ethereum ordered trie (the transactionsRoot formula): keys rlp(index), values the consensus encodings (the twin of
 * pkg/ethproof TrieRoot, which feeds go-ethereum's trie.Update: an EMPTY value deletes its key, so an empty entry leaves no leaf).
 */
import { keccak_256 } from '@noble/hashes/sha3';

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

function lenPrefix(len: number, short: number): Uint8Array {
  if (len < 56) return Uint8Array.of(short + len);
  const bytes: number[] = [];
  for (let v = len; v > 0; v = Math.floor(v / 256)) bytes.unshift(v % 256);
  return Uint8Array.of(short + 55 + bytes.length, ...bytes);
}

/** The RLP string of b. */
export function rlpBytes(b: Uint8Array): Uint8Array {
  if (b.length === 1 && b[0]! < 0x80) return Uint8Array.from(b);
  return concat([lenPrefix(b.length, 0x80), b]);
}

/** The RLP list whose items are the given (already encoded) items. */
export function rlpListOf(items: readonly Uint8Array[]): Uint8Array {
  const body = concat(items);
  return concat([lenPrefix(body.length, 0xc0), body]);
}

/** rlp(uint64 i) as a trie key. */
export function rlpIndexKey(i: number): Uint8Array {
  if (i === 0) return Uint8Array.of(0x80);
  const bytes: number[] = [];
  for (let v = i; v > 0; v = Math.floor(v / 256)) bytes.unshift(v % 256);
  return rlpBytes(Uint8Array.from(bytes));
}

const nibbles = (b: Uint8Array): number[] => {
  const out: number[] = [];
  for (const x of b) out.push(x >> 4, x & 15);
  return out;
};

/** Hex-prefix encoding of a nibble path. */
function compact(path: readonly number[], leaf: boolean): Uint8Array {
  const odd = path.length % 2 === 1;
  const flag = (leaf ? 2 : 0) + (odd ? 1 : 0);
  const out: number[] = [];
  let i = 0;
  if (odd) {
    out.push((flag << 4) | path[0]!);
    i = 1;
  } else {
    out.push(flag << 4);
  }
  for (; i < path.length; i += 2) out.push((path[i]! << 4) | path[i + 1]!);
  return Uint8Array.from(out);
}

interface Entry {
  key: number[];
  value: Uint8Array;
}

const EMPTY_STRING = Uint8Array.of(0x80);

/** The reference a parent holds for an encoded child: the encoding itself when shorter than 32 bytes, else the RLP string of its hash. */
const ref = (enc: Uint8Array): Uint8Array => (enc.length < 32 ? enc : rlpBytes(keccak_256(enc)));

function build(entries: Entry[], depth: number): Uint8Array {
  if (entries.length === 1) {
    const e = entries[0]!;
    return rlpListOf([rlpBytes(compact(e.key.slice(depth), true)), rlpBytes(e.value)]);
  }
  let common = 0;
  const first = entries[0]!.key;
  for (;;) {
    const at = depth + common;
    if (at >= first.length) break;
    const n = first[at]!;
    if (!entries.every((e) => e.key.length > at && e.key[at] === n)) break;
    common++;
  }
  if (common > 0) {
    const child = build(entries, depth + common);
    return rlpListOf([rlpBytes(compact(first.slice(depth, depth + common), false)), ref(child)]);
  }
  const items: Uint8Array[] = [];
  let valueHere: Uint8Array = EMPTY_STRING;
  for (const e of entries) if (e.key.length === depth) valueHere = rlpBytes(e.value);
  for (let n = 0; n < 16; n++) {
    const group = entries.filter((e) => e.key.length > depth && e.key[depth] === n);
    items.push(group.length === 0 ? EMPTY_STRING : ref(build(group, depth + 1)));
  }
  items.push(valueHere);
  return rlpListOf(items);
}

/** The root of the trie over the given consensus encodings, keyed by rlp(index). */
export function trieRoot(values: readonly Uint8Array[]): Uint8Array {
  const entries: Entry[] = [];
  values.forEach((v, i) => {
    if (v.length > 0) entries.push({ key: nibbles(rlpIndexKey(i)), value: v });
  });
  if (entries.length === 0) return keccak_256(EMPTY_STRING);
  entries.sort((a, b) => {
    const n = Math.min(a.key.length, b.key.length);
    for (let i = 0; i < n; i++) if (a.key[i] !== b.key[i]) return a.key[i]! - b.key[i]!;
    return a.key.length - b.key.length;
  });
  return keccak_256(build(entries, 0));
}
