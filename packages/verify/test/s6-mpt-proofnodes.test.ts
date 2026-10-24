/**
 * The proof-database entry points of s6/mpt.ts (RB12-TS-FIX-ARBSEP, audit N-5): ProofNodes holds one node set whose proof database is built at
 * most once, and verifyAccountIn / verifySlotIn / verifyProofIn read from it. Every answer equals the answer of the per-call functions, which are
 * kept: the reference below is the per-call algorithm exactly as it stood before the entry points existed (verifyProof builds a database from
 * the nodes on every call; verifyAccount and verifySlot are its two readings), and a corpus of hostile node sets (every node dropped, truncated,
 * flipped, an empty node anywhere, duplicates, shuffles, foreign nodes, the empty storage root with each proof shape) must answer identically
 * through the reference, through the per-call functions and through one shared ProofNodes used for every query in a different order.
 */
import { keccak_256 } from '@noble/hashes/sha3';
import { describe, expect, it, vi } from 'vitest';

const counter = vi.hoisted(() => ({ calls: 0 }));
vi.mock('@noble/hashes/sha3', async (importOriginal) => {
  const m = await importOriginal<typeof import('@noble/hashes/sha3')>();
  const wrapped = Object.assign((d: Uint8Array): Uint8Array => {
    counter.calls++;
    return m.keccak_256(d);
  }, m.keccak_256);
  return { ...m, keccak_256: wrapped };
});

import { buildTrie } from '../src/proof-v2/finality/baseposted/trie.js';
import { EMPTY_ROOT, MptError, ProofDb, ProofNodes, verifyAccount, verifyAccountIn, verifyProof, verifyProofIn, verifySlot, verifySlotIn, type AccountState } from '../src/s6/mpt.js';
import { RlpError, bytesOf, fixedOf, split, structItems, uintOf } from '../src/s6/rlp.js';

const cat = (...p: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(p.reduce((n, x) => n + x.length, 0));
  let o = 0;
  for (const x of p) {
    out.set(x, o);
    o += x.length;
  }
  return out;
};
const lenHead = (base: number, n: number): Uint8Array => {
  if (n < 56) return Uint8Array.of(base + n);
  const b: number[] = [];
  for (let v = n; v > 0; v = Math.floor(v / 256)) b.unshift(v % 256);
  return Uint8Array.of(base + 55 + b.length, ...b);
};
const rb = (b: Uint8Array): Uint8Array => (b.length === 1 && b[0]! < 0x80 ? Uint8Array.from(b) : cat(lenHead(0x80, b.length), b));
const rl = (...items: Uint8Array[]): Uint8Array => {
  const body = cat(...items);
  return cat(lenHead(0xc0, body.length), body);
};
const trim = (b: Uint8Array): Uint8Array => {
  let i = 0;
  while (i < b.length && b[i] === 0) i++;
  return b.subarray(i);
};
const word = (n: number): Uint8Array => {
  const w = new Uint8Array(32);
  w[31] = n & 0xff;
  w[30] = n >> 8;
  return w;
};
const account = (storageRoot: Uint8Array, codeHash: Uint8Array): Uint8Array => rl(rb(new Uint8Array(0)), rb(new Uint8Array(0)), rb(storageRoot), rb(codeHash));
const addr = (n: number): Uint8Array => new Uint8Array(20).fill(n);

// ---- the reference: the per-call algorithm as it stood before ProofNodes (kept in the test as the oracle) ----
const ZERO32 = new Uint8Array(32);
const eq = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((x, i) => x === b[i]);
const fail = (m: string): never => {
  throw new MptError(m);
};
function refAccount(stateRoot: Uint8Array, acct: Uint8Array, proof: readonly Uint8Array[]): AccountState {
  if (proof.length === 0) fail('no account proof');
  const enc = verifyProofIn(new ProofDb(proof), stateRoot, keccak_256(acct));
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
function refSlot(storageRoot: Uint8Array, slot: Uint8Array, proof: readonly Uint8Array[]): Uint8Array {
  if (eq(storageRoot, EMPTY_ROOT)) {
    if (proof.length === 0) return ZERO32;
    if (proof.length === 1 && proof[0]!.length === 1 && proof[0]![0] === 0x80) return ZERO32;
    return fail(`the storage root is the empty root, and the proof holds ${proof.length} nodes`);
  }
  if (proof.length === 0) fail('no storage proof for a non-empty storage root');
  const enc = verifyProofIn(new ProofDb(proof), storageRoot, keccak_256(slot));
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

const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex');
const show = (run: () => unknown): string => {
  try {
    const r = run() as AccountState | Uint8Array | Uint8Array | undefined;
    if (r === undefined) return 'undefined';
    if (r instanceof Uint8Array) return `v:${hex(r)}`;
    return `a:${r.exists}:${hex(r.storageRoot)}:${hex(r.codeHash)}`;
  } catch (e) {
    return `${(e as Error).constructor.name}:${(e as Error).message}`;
  }
};

// ---- the world: a state trie of five accounts, two with storage; plus a foreign state ----
const slotKeys = [word(1), word(2), word(3), word(0x1234)];
const storage = buildTrie(slotKeys.map((k, i) => ({ key: keccak_256(k), value: rb(trim(i === 3 ? new Uint8Array(32).fill(0xab) : word(i + 7))) })));
const storage2 = buildTrie([{ key: keccak_256(word(1)), value: rb(trim(word(99))) }]);
const accts = [
  { a: addr(1), v: account(storage.root, keccak_256(Uint8Array.of(1))) },
  { a: addr(2), v: account(storage2.root, keccak_256(Uint8Array.of(2))) },
  { a: addr(3), v: account(EMPTY_ROOT, keccak_256(Uint8Array.of(3))) },
  { a: addr(4), v: account(EMPTY_ROOT, keccak_256(Uint8Array.of(4))) },
  { a: addr(5), v: rl(rb(new Uint8Array(0)), rb(new Uint8Array(0)), rb(EMPTY_ROOT), rb(new Uint8Array(31))) }, // a 31-byte code hash
];
const state = buildTrie(accts.map((x) => ({ key: keccak_256(x.a), value: x.v })));
const foreign = buildTrie([{ key: keccak_256(addr(77)), value: account(EMPTY_ROOT, keccak_256(Uint8Array.of(9))) }, { key: keccak_256(addr(78)), value: account(EMPTY_ROOT, keccak_256(Uint8Array.of(8))) }]);
const ALL = [...state.nodes, ...storage.nodes, ...storage2.nodes];

let seed = 0x1234abcd;
const rnd = (n: number): number => {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed % n;
};
const flip = (n: Uint8Array, at: number): Uint8Array => Uint8Array.from(n, (x, i) => (i === at ? x ^ (1 << rnd(8)) : x));

/** Node sets: the valid union, then single-node and structural mutations of it, then the shapes that matter for the empty-root and empty-node rules. */
const nodeSets = (): { name: string; nodes: Uint8Array[] }[] => {
  const out: { name: string; nodes: Uint8Array[] }[] = [{ name: 'valid union', nodes: ALL }];
  out.push({ name: 'reversed', nodes: [...ALL].reverse() });
  out.push({ name: 'duplicated', nodes: [...ALL, ...ALL] });
  out.push({ name: 'empty set', nodes: [] });
  out.push({ name: 'one empty node', nodes: [new Uint8Array(0)] });
  out.push({ name: 'the node 0x80 alone', nodes: [Uint8Array.of(0x80)] });
  out.push({ name: '0x80 and another node', nodes: [Uint8Array.of(0x80), ALL[0]!] });
  out.push({ name: 'two 0x80', nodes: [Uint8Array.of(0x80), Uint8Array.of(0x80)] });
  out.push({ name: 'foreign only', nodes: foreign.nodes });
  out.push({ name: 'valid and foreign', nodes: [...ALL, ...foreign.nodes] });
  for (const at of [0, 1, ALL.length >> 1, ALL.length - 1]) out.push({ name: `empty node at ${at}`, nodes: [...ALL.slice(0, at), new Uint8Array(0), ...ALL.slice(at)] });
  for (let i = 0; i < ALL.length; i++) {
    out.push({ name: `drop ${i}`, nodes: ALL.filter((_, j) => j !== i) });
    out.push({ name: `truncate ${i}`, nodes: ALL.map((n, j) => (j === i ? n.subarray(0, Math.max(0, n.length - 1)) : n)) });
    out.push({ name: `flip ${i}`, nodes: ALL.map((n, j) => (j === i ? flip(n, rnd(n.length)) : n)) });
    out.push({ name: `extend ${i}`, nodes: ALL.map((n, j) => (j === i ? cat(n, Uint8Array.of(0)) : n)) });
    out.push({ name: `replace ${i} by junk`, nodes: ALL.map((n, j) => (j === i ? Uint8Array.from({ length: 40 }, () => rnd(256)) : n)) });
  }
  for (let k = 0; k < 120; k++) {
    out.push({ name: `random ${k}`, nodes: ALL.filter(() => rnd(5) !== 0).map((n) => (rnd(7) === 0 ? flip(n, rnd(n.length)) : n)) });
  }
  return out;
};

const roots = (): { name: string; root: Uint8Array }[] => [
  { name: 'empty root', root: EMPTY_ROOT },
  { name: 'storage 1', root: storage.root },
  { name: 'storage 2', root: storage2.root },
  { name: 'foreign root', root: foreign.root },
  { name: 'unknown root', root: keccak_256(Uint8Array.of(42)) },
];

describe('ProofNodes', () => {
  it('holds the node list as given, and builds its proof database once: the reader is the same object on every call and skips empty nodes', () => {
    const nodes = [...ALL, new Uint8Array(0)];
    const set = new ProofNodes(nodes);
    expect(set.nodes).toBe(nodes);
    const r = set.reader();
    expect(set.reader()).toBe(r);
    expect(r.get(keccak_256(ALL[0]!))).toEqual(ALL[0]);
    expect(r.get(keccak_256(new Uint8Array(0)))).toBeUndefined();
  });

  it('strict() is the reader of a set with no empty node, and refuses a set with one as the per-call functions do: MptError "empty proof node"', () => {
    const clean = new ProofNodes(ALL);
    expect(clean.strict()).toBe(clean.reader());
    for (const at of [0, 3, ALL.length]) {
      const set = new ProofNodes([...ALL.slice(0, at), new Uint8Array(0), ...ALL.slice(at)]);
      expect(() => set.strict()).toThrow(MptError);
      expect(() => set.strict()).toThrow('empty proof node');
      expect(() => set.strict()).toThrow('empty proof node'); // every call, not only the first
      expect(set.reader().get(keccak_256(ALL[0]!))).toBeDefined(); // the lenient reader is unaffected
    }
  });

  it('every node is keccak-hashed once however many reads follow, and none at construction', () => {
    const set = new ProofNodes(ALL);
    const slot = word(1);
    counter.calls = 0;
    expect(counter.calls).toBe(0); // construction hashes nothing
    for (let i = 0; i < 6; i++) verifySlotIn(set, storage.root, slot);
    // 6 slot reads: one database build (ALL.length hashes) plus the key hash of each read
    expect(counter.calls).toBe(ALL.length + 6);
    for (let i = 0; i < 4; i++) verifyAccountIn(set, state.root, addr(1));
    expect(counter.calls).toBe(ALL.length + 6 + 4);
  });
});

describe('ProofDb and the per-call verifyProof keep refusing an empty node', () => {
  it('new ProofDb refuses an empty node (default) and holds every other node when told to skip it', () => {
    expect(() => new ProofDb([...ALL, new Uint8Array(0)])).toThrow(MptError);
    expect(() => new ProofDb([...ALL, new Uint8Array(0)])).toThrow('empty proof node');
    expect(() => new ProofDb([...ALL, new Uint8Array(0)], false)).toThrow('empty proof node');
    const lenient = new ProofDb([new Uint8Array(0), ...ALL], true);
    for (const n of ALL) expect(lenient.get(keccak_256(n))).toEqual(n);
    expect(lenient.get(keccak_256(new Uint8Array(0)))).toBeUndefined();
  });

  it('verifyProof over a node list holding an empty node is MptError empty proof node, wherever the empty node sits', () => {
    const key = keccak_256(addr(1));
    for (const at of [0, 4, ALL.length]) {
      const nodes = [...ALL.slice(0, at), new Uint8Array(0), ...ALL.slice(at)];
      expect(() => verifyProof(state.root, key, nodes)).toThrow('empty proof node');
    }
    expect(verifyProof(state.root, key, ALL)).toBeDefined();
  });
});

describe('verifyProofIn takes any reader of nodes by hash', () => {
  it('a plain { get } object gives the answer of a ProofDb, and records exactly the nodes a walk reads', () => {
    const db = new ProofDb(ALL);
    const seen: string[] = [];
    const reader = {
      get: (h: Uint8Array): Uint8Array | undefined => {
        seen.push(hex(h));
        return db.get(h);
      },
    };
    const key = keccak_256(addr(1));
    expect(verifyProofIn(reader, state.root, key)).toEqual(verifyProofIn(db, state.root, key));
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[0]).toBe(hex(state.root));
    expect(verifyProofIn(reader, state.root, key)).toEqual(verifyProof(state.root, key, ALL));
  });
});

describe('the answers are those of the per-call algorithm on every hostile node set', () => {
  const sets = nodeSets();
  it(`the corpus has ${sets.length} node sets and reaches every outcome class (a result, an absence, MptError of several kinds)`, () => {
    expect(sets.length).toBeGreaterThan(150);
    const classes = new Set<string>();
    for (const s of sets) for (const a of accts) classes.add(show(() => refAccount(state.root, a.a, s.nodes)).replace(/[0-9a-f]{64}/g, 'H').slice(0, 60));
    expect([...classes].some((c) => c.startsWith('a:true'))).toBe(true);
    expect([...classes].some((c) => c.startsWith('MptError:empty proof node'))).toBe(true);
    expect([...classes].some((c) => c.startsWith('MptError:no account proof'))).toBe(true);
    expect([...classes].some((c) => c.includes('missing'))).toBe(true);
    expect(classes.size).toBeGreaterThanOrEqual(5);
  });

  it('accounts: verifyAccountIn over a fresh set, over one shared set, and the per-call verifyAccount all equal the reference', () => {
    let n = 0;
    for (const s of sets) {
      const shared = new ProofNodes(s.nodes);
      const queries = [...accts.map((a) => a.a), addr(60), addr(61)];
      for (const q of [...queries, ...[...queries].reverse()]) {
        const want = show(() => refAccount(state.root, q, s.nodes));
        expect(show(() => verifyAccount(state.root, q, s.nodes)), `${s.name} verifyAccount`).toBe(want);
        expect(show(() => verifyAccountIn(new ProofNodes(s.nodes), state.root, q)), `${s.name} fresh`).toBe(want);
        expect(show(() => verifyAccountIn(shared, state.root, q)), `${s.name} shared`).toBe(want);
        n++;
      }
      for (const r of [foreign.root, keccak_256(Uint8Array.of(1))]) {
        const want = show(() => refAccount(r, addr(1), s.nodes));
        expect(show(() => verifyAccountIn(shared, r, addr(1))), `${s.name} root`).toBe(want);
      }
    }
    expect(n).toBeGreaterThan(2000);
  });

  it('slots: verifySlotIn over a fresh set, over one shared set, and the per-call verifySlot all equal the reference, for every storage root and slot', () => {
    let n = 0;
    const slots = [...slotKeys, word(4), word(0x9999), new Uint8Array(32)];
    for (const s of sets) {
      const shared = new ProofNodes(s.nodes);
      for (const r of [...roots(), ...[...roots()].reverse()]) {
        for (const sl of slots) {
          const want = show(() => refSlot(r.root, sl, s.nodes));
          expect(show(() => verifySlot(r.root, sl, s.nodes)), `${s.name} ${r.name} verifySlot`).toBe(want);
          expect(show(() => verifySlotIn(new ProofNodes(s.nodes), r.root, sl)), `${s.name} ${r.name} fresh`).toBe(want);
          expect(show(() => verifySlotIn(shared, r.root, sl)), `${s.name} ${r.name} shared`).toBe(want);
          n++;
        }
      }
    }
    expect(n).toBeGreaterThan(8000);
  });

  it('the empty storage root needs no node: [] and [0x80] read zero, any other node set is refused; a non-empty root with no node is refused (N and N-1 nodes)', () => {
    const slot = keccak_256(Uint8Array.of(1));
    expect(show(() => verifySlotIn(new ProofNodes([]), EMPTY_ROOT, slot))).toBe(`v:${hex(ZERO32)}`);
    expect(show(() => verifySlotIn(new ProofNodes([Uint8Array.of(0x80)]), EMPTY_ROOT, slot))).toBe(`v:${hex(ZERO32)}`);
    expect(show(() => verifySlotIn(new ProofNodes([Uint8Array.of(0x80), Uint8Array.of(0x80)]), EMPTY_ROOT, slot))).toContain('the empty root, and the proof holds 2 nodes');
    expect(show(() => verifySlotIn(new ProofNodes([ALL[0]!]), EMPTY_ROOT, slot))).toContain('the empty root, and the proof holds 1 nodes');
    expect(show(() => verifySlotIn(new ProofNodes([]), storage.root, slot))).toContain('no storage proof for a non-empty storage root');
    expect(show(() => verifyAccountIn(new ProofNodes([]), state.root, addr(1)))).toContain('no account proof');
  });

  it('an empty node anywhere refuses the account and the slot read (the per-call functions build the database first), however the proof is otherwise complete', () => {
    for (const at of [0, 5, ALL.length]) {
      const nodes = [...ALL.slice(0, at), new Uint8Array(0), ...ALL.slice(at)];
      expect(show(() => verifyAccountIn(new ProofNodes(nodes), state.root, addr(1)))).toBe('MptError:empty proof node');
      expect(show(() => verifySlotIn(new ProofNodes(nodes), storage.root, keccak_256(Uint8Array.of(1))))).toBe('MptError:empty proof node');
      expect(show(() => verifyAccount(state.root, addr(1), nodes))).toBe('MptError:empty proof node');
    }
  });
});
