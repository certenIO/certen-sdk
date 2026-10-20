/**
 * Level 1 derived from the Settlement (V2_SPEC_S7 5.1): the header hashes to the block hash and decodes as a typed header, the
 * transaction and receipt proofs resolve from its roots at one index, the receipt decodes, and the number is read positionally.
 * The blocks here are synthetic single-entry tries (a one-leaf trie is hand-built); the real-block cases live in the validator suite.
 */
import { keccak_256 } from '@noble/hashes/sha3';
import { describe, expect, it } from 'vitest';
import { deriveIncluded, type InclusionProof, type Settlement } from '../../src/proof-v2/finality/evidence.js';
import { Level } from '../../src/proof-v2/finality/level.js';
import { Registry } from '../../src/proof-v2/finality/registry.js';
import { verifyWith } from '../../src/proof-v2/finality/report.js';
import { ChainBaseSepolia } from '../../src/proof-v2/finality/table.js';
import { fill, stateOf } from './helpers.js';

const cat = (...p: Uint8Array[]): Uint8Array => Uint8Array.from(p.flatMap((x) => [...x]));
function prefix(base: number, body: Uint8Array): Uint8Array {
  if (body.length <= 55) return cat(Uint8Array.of(base + body.length), body);
  const len: number[] = [];
  for (let n = body.length; n > 0; n >>= 8) len.unshift(n & 0xff);
  return cat(Uint8Array.of(base + 55 + len.length, ...len), body);
}
const str = (b: Uint8Array): Uint8Array => (b.length === 1 && b[0]! < 0x80 ? b : prefix(0x80, b));
const list = (...items: Uint8Array[]): Uint8Array => prefix(0xc0, cat(...items));
const uint = (n: number): Uint8Array => {
  const b: number[] = [];
  for (let v = n; v > 0; v = Math.floor(v / 256)) b.unshift(v % 256);
  return str(Uint8Array.from(b));
};

/** A one-entry trie at index 0 (key rlp(0) = 0x80): the root node is rlp([leaf path, value]). */
function oneLeafTrie(value: Uint8Array): { root: Uint8Array; node: Uint8Array } {
  const node = list(str(Uint8Array.of(0x20, 0x80)), str(value));
  return { root: keccak_256(node), node };
}

function proofOf(value: Uint8Array): InclusionProof {
  const { root, node } = oneLeafTrie(value);
  return { leafHash: keccak_256(value), leafIndex: 0n, proofHashes: [keccak_256(node)], expectedRoot: root, proofNodes: [node], leafValue: value };
}

function settlement(opts: { receipt?: Uint8Array; headerTweak?: (items: Uint8Array[]) => void } = {}): Settlement {
  const tx = cat(Uint8Array.of(2), new TextEncoder().encode('a transaction envelope'));
  const receipt = opts.receipt ?? cat(Uint8Array.of(2), list(uint(1), uint(21000), str(new Uint8Array(256)), list()));
  const txp = proofOf(tx);
  const rcp = proofOf(receipt);
  const items = [
    str(fill(0xa0)), str(fill(0xa1)), str(fill(0xa2, 20)), str(fill(0xa3)), str(txp.expectedRoot), str(rcp.expectedRoot), str(new Uint8Array(256)),
    uint(0), uint(4242), uint(30_000_000), uint(21000), uint(1_700_000_000), str(Uint8Array.of(1, 2)), str(fill(0xa4)), str(fill(0xa5, 8)),
  ];
  opts.headerTweak?.(items);
  const headerRlp = list(...items);
  return { blockHash: keccak_256(headerRlp), headerRlp, txHash: keccak_256(tx), tx: txp, receipt: rcp };
}

describe('level 1 is derived from the Settlement', () => {
  it('verifies and returns the block every other level binds to (number read positionally)', () => {
    const s = settlement();
    const b = deriveIncluded(ChainBaseSepolia, s);
    expect(b.chain).toBe(ChainBaseSepolia);
    expect(b.number).toBe(4242n);
    expect(Buffer.from(b.hash).equals(Buffer.from(s.blockHash))).toBe(true);
    expect(b.headerRlp?.length).toBe(s.headerRlp.length);
    const rep = verifyWith(new Registry(), ChainBaseSepolia, s, b, [], null);
    expect(rep.headline).toBe(Level.Included);
    expect(rep.levels.get(Level.Included)?.status).toBe('verified');
    expect(rep.block.number).toBe(4242n);
  });

  it('refuses another transaction hash, a header that does not hash to the block hash, and a missing settlement', () => {
    const s = settlement();
    const wrong = { ...s, txHash: Uint8Array.from(s.txHash) };
    wrong.txHash[0]! ^= 0xff;
    expect(stateOf(() => deriveIncluded(ChainBaseSepolia, wrong)).code).toBe('finality_included_invalid');
    const torn = { ...s, headerRlp: Uint8Array.from(s.headerRlp) };
    torn.headerRlp[torn.headerRlp.length - 1]! ^= 1;
    expect(stateOf(() => deriveIncluded(ChainBaseSepolia, torn)).code).toBe('finality_included_invalid');
    expect(stateOf(() => deriveIncluded(ChainBaseSepolia, null)).code).toBe('finality_included_unavailable');
    const rep = verifyWith(new Registry(), ChainBaseSepolia, wrong, { chain: ChainBaseSepolia, number: 0n, hash: new Uint8Array(32) }, [], null);
    expect(rep.levels.get(Level.Included)?.status).toBe('refused');
    expect(rep.headline).toBe(Level.None);
  });

  it('refuses a proof against another root, another index, a node that does not hash to its stated hash, and a leaf that is not the entry', () => {
    const s = settlement();
    const rootOff = { ...s, tx: { ...s.tx!, expectedRoot: fill(9) } };
    const indexOff = { ...s, tx: { ...s.tx!, leafIndex: 1n } };
    const hashOff = { ...s, tx: { ...s.tx!, proofHashes: [fill(7)] } };
    const leafOff = { ...s, tx: { ...s.tx!, leafValue: Uint8Array.of(1, 2, 3) } };
    const noReceipt = { ...s, receipt: null };
    for (const bad of [rootOff, indexOff, hashOff, leafOff, noReceipt]) {
      expect(stateOf(() => deriveIncluded(ChainBaseSepolia, bad)).code).toBe('finality_included_invalid');
    }
  });

  it('refuses a receipt that does not decode and a header that does not decode as a typed header', () => {
    expect(stateOf(() => deriveIncluded(ChainBaseSepolia, settlement({ receipt: list(uint(1), uint(21000)) }))).code).toBe('finality_included_invalid');
    // 14 items: a typed header needs at least 15, the positional reader would have accepted it (it needs 12)
    const short = settlement({ headerTweak: (items) => items.pop() });
    expect(stateOf(() => deriveIncluded(ChainBaseSepolia, short)).code).toBe('finality_included_invalid');
  });

  it('reads a typed-valid header whose positional slot is malformed as the positional refusal', () => {
    // a 9-byte block number is a valid *big.Int for the typed header but not a positional uint64
    const s = settlement({ headerTweak: (items) => (items[8] = str(cat(Uint8Array.of(1), new Uint8Array(8)))) });
    expect(stateOf(() => deriveIncluded(ChainBaseSepolia, s)).fields.reason).toBe('header_item_not_canonical_uint');
  });
});
