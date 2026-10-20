/**
 * Merkle-Patricia proof verification exactly as go-ethereum v1.17.7 trie.VerifyProof does it, over a proof database keyed by
 * keccak256(node) (never by position): hex-prefix keys (trie/encoding.go compactToHex, including its reading of the flag
 * nibble), short (extension and leaf) and full nodes, embedded nodes of fewer than 32 bytes, empty references, and the
 * exclusion proof - a path that ends in a proven absence is the value undefined, not a failure. Then the account and
 * storage reading of pkg/ethproof storage.go.
 */
import { keccak_256 } from '@noble/hashes/sha3';
import { countValues, RlpError, split, splitList, splitString, structItems, bytesOf, fixedOf, uintOf } from './rlp.js';

export class MptError extends Error {}

const fail = (m: string): never => {
  throw new MptError(m);
};

type Node =
  | { t: 'short'; key: number[]; val: Node }
  | { t: 'full'; children: (Node | undefined)[] }
  | { t: 'hash'; h: Uint8Array }
  | { t: 'value'; v: Uint8Array }
  | undefined;

function hexKey(b: Uint8Array): number[] {
  const out: number[] = [];
  for (const x of b) out.push(x >> 4, x & 15);
  out.push(16);
  return out;
}

function compactToHex(compact: Uint8Array): number[] {
  if (compact.length === 0) return [];
  let base = hexKey(compact);
  if (base[0]! < 2) base = base.slice(0, base.length - 1);
  const chop = 2 - (base[0]! & 1);
  return base.slice(chop);
}

function decodeNode(buf: Uint8Array): Node {
  if (buf.length === 0) fail('unexpected EOF');
  const elems = splitList(buf).content;
  const c = countValues(elems);
  if (c === 2) return decodeShort(elems);
  if (c === 17) return decodeFull(elems);
  return fail(`invalid number of list elements: ${c}`);
}

function decodeShort(elems: Uint8Array): Node {
  const k = splitString(elems);
  const key = compactToHex(k.content);
  if (key.length > 0 && key[key.length - 1] === 16) {
    return { t: 'short', key, val: { t: 'value', v: splitString(k.rest).content } };
  }
  return { t: 'short', key, val: decodeRef(k.rest)[0] };
}

function decodeFull(elems: Uint8Array): Node {
  const children: (Node | undefined)[] = new Array(17).fill(undefined);
  let b = elems;
  for (let i = 0; i < 16; i++) {
    const [n, rest] = decodeRef(b);
    children[i] = n;
    b = rest;
  }
  const v = splitString(b).content;
  if (v.length > 0) children[16] = { t: 'value', v };
  return { t: 'full', children };
}

function decodeRef(buf: Uint8Array): [Node, Uint8Array] {
  const it = split(buf);
  if (it.kind === 'list') {
    if (it.raw.length >= 32) fail(`oversized embedded node (size is ${it.raw.length} bytes, want size < 32)`);
    return [decodeNode(buf), it.rest];
  }
  if (it.kind === 'string' && it.content.length === 0) return [undefined, it.rest];
  if (it.kind === 'string' && it.content.length === 32) return [{ t: 'hash', h: it.content }, it.rest];
  return fail(`invalid RLP string size ${it.content.length} (want 0 or 32)`);
}

const hexOf = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

/**
 * A proof database: every node keyed by its own keccak256. Built once for a node set that is read many times (a kind that makes dozens
 * of state reads from one evidence), so the nodes are hashed once and not once per read.
 */
export class ProofDb {
  private readonly db = new Map<string, Uint8Array>();
  constructor(nodes: readonly Uint8Array[]) {
    for (const n of nodes) {
      if (n.length === 0) fail('empty proof node');
      this.db.set(hexOf(keccak_256(n)), n);
    }
  }

  get(hash: Uint8Array): Uint8Array | undefined {
    return this.db.get(hexOf(hash));
  }
}

/** trie.VerifyProof: the value at key under root, undefined for a proven absence; MptError for anything else. */
export function verifyProof(root: Uint8Array, key: Uint8Array, nodes: readonly Uint8Array[]): Uint8Array | undefined {
  return verifyProofIn(new ProofDb(nodes), root, key);
}

/** verifyProof over a proof database built once. */
export function verifyProofIn(db: ProofDb, root: Uint8Array, key: Uint8Array): Uint8Array | undefined {
  let k = hexKey(key);
  let want = root;
  for (let i = 0; ; i++) {
    const buf = db.get(want);
    if (buf === undefined) fail(`proof node ${i} (hash ${hexOf(want)}) missing`);
    let n: Node;
    try {
      n = decodeNode(buf!);
    } catch (e) {
      if (e instanceof RlpError || e instanceof MptError) fail(`bad proof node ${i}: ${e.message}`);
      throw e;
    }
    // get(n, key, skipResolved=true)
    let tn: Node = n;
    for (;;) {
      if (tn === undefined) return undefined;
      if (tn.t === 'short') {
        if (k.length < tn.key.length || tn.key.some((x, j) => k[j] !== x)) return undefined;
        k = k.slice(tn.key.length);
        tn = tn.val;
      } else if (tn.t === 'full') {
        tn = tn.children[k[0]!];
        k = k.slice(1);
      } else if (tn.t === 'hash') {
        want = tn.h;
        break;
      } else {
        return tn.v;
      }
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// pkg/ethproof storage.go

export const EMPTY_ROOT = Uint8Array.from('56e81f171bcc55a6ff8345e692c0f86e5b48e01b996cadc001622fb5e363b421'.match(/../g)!, (h) => parseInt(h, 16));
export const EMPTY_CODE_HASH = keccak_256(new Uint8Array(0));

export interface AccountState {
  exists: boolean;
  storageRoot: Uint8Array;
  codeHash: Uint8Array;
}

export const eq = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((x, i) => x === b[i]);
const ZERO32 = new Uint8Array(32);

/** VerifyAccount. */
export function verifyAccount(stateRoot: Uint8Array, account: Uint8Array, proof: readonly Uint8Array[]): AccountState {
  if (proof.length === 0) fail('no account proof');
  const enc = verifyProof(stateRoot, keccak_256(account), proof);
  if (enc === undefined) return { exists: false, storageRoot: EMPTY_ROOT, codeHash: ZERO32 };
  let root: Uint8Array;
  let codeHash: Uint8Array;
  try {
    const it = structItems(enc, 4);
    uintOf(it[0]!, 8);
    uintOf(it[1]!);
    root = fixedOf(it[2]!, 32);
    codeHash = bytesOf(it[3]!);
  } catch (e) {
    if (e instanceof RlpError) return fail(`account does not decode: ${e.message}`);
    throw e;
  }
  if (codeHash.length !== 32) fail(`account has a ${codeHash.length}-byte code hash`);
  return { exists: true, storageRoot: root, codeHash };
}

/** VerifySlot: the slot's 32-byte value. */
export function verifySlot(storageRoot: Uint8Array, slot: Uint8Array, proof: readonly Uint8Array[]): Uint8Array {
  if (eq(storageRoot, EMPTY_ROOT)) {
    if (proof.length === 0) return ZERO32;
    if (proof.length === 1 && proof[0]!.length === 1 && proof[0]![0] === 0x80) return ZERO32;
    return fail(`the storage root is the empty root, and the proof holds ${proof.length} nodes`);
  }
  if (proof.length === 0) fail('no storage proof for a non-empty storage root');
  const enc = verifyProof(storageRoot, keccak_256(slot), proof);
  if (enc === undefined) return ZERO32;
  let trimmed: Uint8Array;
  try {
    const it = split(enc);
    if (it.rest.length > 0) fail('input contains more than one value');
    trimmed = bytesOf(it);
  } catch (e) {
    if (e instanceof RlpError) return fail(`the proven leaf does not decode: ${e.message}`);
    throw e;
  }
  if (trimmed.length > 32 || (trimmed.length > 0 && trimmed[0] === 0)) fail('the proven leaf is not a trimmed value of at most 32 bytes');
  const out = new Uint8Array(32);
  out.set(trimmed, 32 - trimmed.length);
  return out;
}

export interface StorageResult {
  account: AccountState;
  value: Uint8Array;
}

/** VerifyStorage. */
export function verifyStorage(
  stateRoot: Uint8Array,
  account: Uint8Array,
  accountProof: readonly Uint8Array[],
  slot: Uint8Array,
  storageProof: readonly Uint8Array[],
): StorageResult {
  const acc = verifyAccount(stateRoot, account, accountProof);
  if (!acc.exists) {
    if (storageProof.length !== 0) fail('the account is proven absent and a storage proof is offered');
    return { account: acc, value: ZERO32 };
  }
  return { account: acc, value: verifySlot(acc.storageRoot, slot, storageProof) };
}


