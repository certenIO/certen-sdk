// Proven reads from the nodes a container carries (twin of reads.go): an account at a state root, a storage slot, a bytes/string value, an
// indexed leaf of a transaction or receipt trie. Every node a walk uses is marked visited (step 22b refuses an unreferenced node). A read that
// cannot be established THROWS a ReadError; the steps turn it into proof_invalid, never into a default value.
import { keccak_256 } from '@noble/hashes/sha3';
import { ProofDb, verifyProofIn, EMPTY_ROOT, MptError } from '../../s6/mpt.js';
import { RlpError, countValues, split, splitList, splitString, uintOf, type Item, listItems } from '../../s6/rlp.js';
import { bigOf, eq, hex, isZero, keccak, zeros } from './bytes.js';
import { assemble, dynDataSlot, dynWordCount, parseDynHead, SlotError } from './slots.js';

export const MaxTrieNodeBytes = 4096;
export type ReadKind = 'missing_node' | 'node_too_large' | 'node_malformed' | 'walk_failed' | 'account_malformed' | 'value_malformed' | 'dynamic_invalid' | 'node_set_invalid' | 'leaf_absent';
export class ReadError extends Error {
  address?: Uint8Array;
  slot?: Uint8Array;
  constructor(readonly kind: ReadKind, readonly root: Uint8Array = zeros(32), readonly detail = '') {
    super(`proof_invalid{${kind}} root=0x${hex(root)}${detail ? ': ' + detail : ''}`);
  }
}

const EMPTY_CODE = keccak_256(new Uint8Array(0));

function checkTrieRef(buf: Uint8Array): { rest: Uint8Array; empty: boolean } {
  const it = split(buf);
  if (it.kind === 'list') {
    const size = buf.length - it.rest.length;
    if (size >= 32) throw new Error(`embedded node of ${size} bytes (want < 32)`);
    checkTrieNode(buf.slice(0, size));
    return { rest: it.rest, empty: false };
  }
  if (it.kind === 'string' && it.content.length === 0) return { rest: it.rest, empty: true };
  if (it.kind === 'string' && it.content.length === 32) return { rest: it.rest, empty: false };
  throw new Error(`reference of ${it.content.length} bytes (want 0 or 32)`);
}

/** The structural check every trie node must pass before a walk may use it (checkTrieNode). */
export function checkTrieNode(buf: Uint8Array): void {
  const l = splitList(buf);
  if (l.rest.length !== 0) throw new Error(`${l.rest.length} trailing bytes after the node`);
  const elems = l.content;
  const n = countValues(elems);
  if (n === 2) {
    const k = splitString(elems);
    const key = k.content;
    if (key.length === 0) throw new Error('empty hex-prefix path');
    const flag = key[0]! >> 4;
    if (flag > 3) throw new Error(`invalid hex-prefix flag ${flag}`);
    if ((flag & 1) === 0 && (key[0]! & 0x0f) !== 0) throw new Error('even-length path with a non-zero padding nibble');
    if (flag >= 2) {
      const v = splitString(k.rest);
      if (v.rest.length !== 0) throw new Error('bytes after the leaf value');
      if (v.content.length === 0) throw new Error('leaf with an empty value');
      return;
    }
    if (2 * (key.length - 1) + (flag & 1) === 0) throw new Error('extension with an empty path');
    const c = checkTrieRef(k.rest);
    if (c.empty) throw new Error('extension without a child');
    if (c.rest.length !== 0) throw new Error('bytes after the extension child');
    return;
  }
  if (n === 17) {
    let children = 0;
    let rem = elems;
    for (let i = 0; i < 16; i++) {
      const c = checkTrieRef(rem);
      if (!c.empty) children++;
      rem = c.rest;
    }
    const v = splitString(rem);
    if (v.rest.length !== 0) throw new Error('bytes after the branch value');
    if (v.content.length !== 0) throw new Error('branch carrying a value');
    if (children < 2) throw new Error(`branch with ${children} children`);
    return;
  }
  throw new Error(`${n} elements (want 2 or 17)`);
}

export class NodeSet {
  private readonly nodes = new Map<string, Uint8Array>();
  private readonly index = new Map<string, number>();
  private readonly visited = new Set<string>();
  constructor(nodes: readonly Uint8Array[]) {
    nodes.forEach((n, i) => {
      if (n.length === 0) throw new ReadError('node_set_invalid', zeros(32), `node ${i} is empty`);
      const h = hex(keccak_256(n));
      if (this.index.has(h)) throw new ReadError('node_set_invalid', zeros(32), `nodes ${this.index.get(h)} and ${i} have the same hash 0x${h}`);
      this.nodes.set(h, n);
      this.index.set(h, i);
    });
  }
  get size(): number { return this.nodes.size; }
  /** The indexes of the nodes no walk has used, ascending. */
  unvisited(): number[] { return [...this.index].filter(([h]) => !this.visited.has(h)).map(([, i]) => i).sort((a, b) => a - b); }
  walk(root: Uint8Array, key: Uint8Array, maxNode: number): Uint8Array | undefined {
    let fail: ReadError | undefined;
    const reader = {
      get: (h: Uint8Array): Uint8Array | undefined => {
        const k = hex(h);
        const buf = this.nodes.get(k);
        if (buf === undefined) { fail = new ReadError('missing_node', root, `node 0x${k}`); return undefined; }
        if (buf.length > maxNode) { fail = new ReadError('node_too_large', root, `${buf.length} bytes, limit ${maxNode}`); return undefined; }
        try { checkTrieNode(buf); } catch (e) { fail = new ReadError('node_malformed', root, (e as Error).message); return undefined; }
        this.visited.add(k);
        return buf;
      },
    };
    try {
      return verifyProofIn(reader as unknown as ProofDb, root, key);
    } catch (e) {
      if (fail) throw fail;
      if (e instanceof MptError || e instanceof RlpError) throw new ReadError('walk_failed', root, e.message);
      throw e;
    }
  }
}

export interface AccountState { exists: boolean; nonce: bigint; balance: bigint; storageRoot: Uint8Array; codeHash: Uint8Array }
export const noAccount = (): AccountState => ({ exists: false, nonce: 0n, balance: 0n, storageRoot: EMPTY_ROOT, codeHash: zeros(32) });
export const zeroAccount = (): AccountState => ({ exists: false, nonce: 0n, balance: 0n, storageRoot: zeros(32), codeHash: zeros(32) });
export const hasCode = (a: AccountState): boolean => a.exists && !eq(a.codeHash, EMPTY_CODE) && !isZero(a.codeHash);

export function readAccount(stateRoot: Uint8Array, nodes: NodeSet, address: Uint8Array): AccountState {
  if (eq(stateRoot, EMPTY_ROOT)) return noAccount();
  let val: Uint8Array | undefined;
  try { val = nodes.walk(stateRoot, keccak(address), MaxTrieNodeBytes); } catch (e) { if (e instanceof ReadError) e.address = address; throw e; }
  if (val === undefined) return noAccount();
  let items: Item[];
  try {
    const it = split(val);
    if (it.rest.length !== 0 || it.kind !== 'list') throw new RlpError('account is not one list');
    items = listItems(it.content);
    if (items.length !== 4) throw new RlpError(`account has ${items.length} fields`);
    const nonce = uintOf(items[0]!, 8);
    const balance = uintOf(items[1]!);
    const root = items[2]!.content;
    const code = items[3]!.content;
    if (root.length !== 32 || code.length !== 32) throw new RlpError('account root or code hash is not 32 bytes');
    return { exists: true, nonce, balance, storageRoot: Uint8Array.from(root), codeHash: Uint8Array.from(code) };
  } catch (e) {
    if (e instanceof RlpError) { const r = new ReadError('account_malformed', stateRoot, e.message); r.address = address; throw r; }
    throw e;
  }
}

export function readSlot(storageRoot: Uint8Array, nodes: NodeSet, slot: Uint8Array): Uint8Array {
  if (eq(storageRoot, EMPTY_ROOT)) return zeros(32);
  let val: Uint8Array | undefined;
  try { val = nodes.walk(storageRoot, keccak(slot), MaxTrieNodeBytes); } catch (e) { if (e instanceof ReadError) e.slot = slot; throw e; }
  if (val === undefined) return zeros(32);
  const bad = (d: string): never => { const r = new ReadError('value_malformed', storageRoot, d); r.slot = slot; throw r; };
  let trimmed: Uint8Array;
  try {
    const it = split(val);
    if (it.rest.length !== 0 || it.kind === 'list') return bad('storage leaf is not one RLP string');
    trimmed = it.content;
  } catch (e) {
    if (e instanceof RlpError) return bad(e.message);
    throw e;
  }
  if (trimmed.length === 0 || trimmed.length > 32 || trimmed[0] === 0) return bad(`storage leaf of ${trimmed.length} bytes is not a trimmed non-zero value of at most 32 bytes`);
  const out = zeros(32);
  out.set(trimmed, 32 - trimmed.length);
  return out;
}

export function readBytes(storageRoot: Uint8Array, nodes: NodeSet, slot: Uint8Array, maxLen: bigint): Uint8Array {
  const head = readSlot(storageRoot, nodes, slot);
  const dyn = (e: unknown): never => {
    if (e instanceof SlotError) { const r = new ReadError('dynamic_invalid', storageRoot, e.message); r.slot = slot; throw r; }
    throw e;
  };
  let dh;
  try { dh = parseDynHead(head, maxLen); } catch (e) { return dyn(e); }
  const words: Uint8Array[] = [];
  for (let i = 0n; i < dynWordCount(dh); i++) words.push(readSlot(storageRoot, nodes, dynDataSlot(slot, i)));
  try { return assemble(dh, words); } catch (e) { return dyn(e); }
}

const rlpUint = (n: bigint): Uint8Array => {
  if (n === 0n) return Uint8Array.of(0x80);
  const b: number[] = [];
  for (let v = n; v > 0n; v >>= 8n) b.unshift(Number(v & 0xffn));
  return b.length === 1 && b[0]! < 0x80 ? Uint8Array.from(b) : Uint8Array.from([0x80 + b.length, ...b]);
};
/** The leaf at `index` of a transaction or receipts trie (the key is rlp(index)). */
export function readIndexedLeaf(root: Uint8Array, nodes: NodeSet, index: bigint, maxNode: number): Uint8Array {
  const val = nodes.walk(root, rlpUint(index), maxNode);
  if (val === undefined) throw new ReadError('leaf_absent', root, `no entry at index ${index}`);
  return Uint8Array.from(val);
}
export { bigOf };
