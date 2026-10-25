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

/** Receives every trie node that a parent references by hash (an encoding of 32 bytes or more), so a proof database can be assembled. */
type Sink = Uint8Array[] | undefined;

const EMPTY_STRING = Uint8Array.of(0x80);

/** The reference a parent holds for an encoded child: the encoding itself when shorter than 32 bytes, else the RLP string of its hash. */
function ref(enc: Uint8Array, sink: Sink): Uint8Array {
  if (enc.length < 32) return enc;
  sink?.push(enc);
  return rlpBytes(keccak_256(enc));
}

function build(entries: Entry[], depth: number, sink: Sink): Uint8Array {
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
    const child = build(entries, depth + common, sink);
    return rlpListOf([rlpBytes(compact(first.slice(depth, depth + common), false)), ref(child, sink)]);
  }
  const items: Uint8Array[] = [];
  let valueHere: Uint8Array = EMPTY_STRING;
  for (const e of entries) if (e.key.length === depth) valueHere = rlpBytes(e.value);
  for (let n = 0; n < 16; n++) {
    const group = entries.filter((e) => e.key.length > depth && e.key[depth] === n);
    items.push(group.length === 0 ? EMPTY_STRING : ref(build(group, depth + 1, sink), sink));
  }
  items.push(valueHere);
  return rlpListOf(items);
}

const byPath = (a: Entry, b: Entry): number => {
  const n = Math.min(a.key.length, b.key.length);
  for (let i = 0; i < n; i++) if (a.key[i] !== b.key[i]) return a.key[i]! - b.key[i]!;
  return a.key.length - b.key.length;
};

/**
 * The root and the hash-referenced nodes of the trie over keyed values (keys are arbitrary byte strings, e.g. keccak256 of an address for a
 * state trie). An empty value leaves no entry. The nodes are what a proof database for any key of the trie is made of; the root node is
 * always included, whatever its length.
 */
export function buildTrie(entries: readonly { key: Uint8Array; value: Uint8Array }[]): { root: Uint8Array; nodes: Uint8Array[] } {
  const list: Entry[] = entries.filter((e) => e.value.length > 0).map((e) => ({ key: nibbles(e.key), value: e.value }));
  if (list.length === 0) return { root: keccak_256(EMPTY_STRING), nodes: [] };
  list.sort(byPath);
  const nodes: Uint8Array[] = [];
  const rootEnc = build(list, 0, nodes);
  nodes.push(rootEnc);
  return { root: keccak_256(rootEnc), nodes };
}

/** The root of the trie over the given consensus encodings, keyed by rlp(index). */
export function trieRoot(values: readonly Uint8Array[]): Uint8Array {
  return buildTrie(values.map((value, i) => ({ key: rlpIndexKey(i), value }))).root;
}
