/**
 * Behaviours of the framework core that are not a vector (the twin of pkg/finality finality_test.go, codec_test.go and behaviour tests):
 * the section 8.2 bounds, positional header reads, D0 recomputed from the leg, level order, level one never stored, strict JSON.
 */
import { keccak_256 } from '@noble/hashes/sha3';
import { describe, expect, it } from 'vitest';
import {
  addendumToJSON,
  carriedLegOf,
  checkLegChain,
  legBindingOf,
  newAddendum,
  ownHash,
  newSection,
  parseAddendum,
  parseProofId,
  parseSection,
  proofIdString,
  sectionToJSON,
  verifyChain,
} from '../../src/proof-v2/finality/addendum.js';
import { Reader, Writer, decodeContainer, defaultLimits, encodeContainer } from '../../src/proof-v2/finality/codec.js';
import { Level } from '../../src/proof-v2/finality/level.js';
import { readHeader } from '../../src/proof-v2/finality/rlpheader.js';
import { kindFor } from '../../src/proof-v2/finality/table.js';
import { buildChain, containerFor, fill, kBaseFin, kBaseL1, rlpList, stateOf, testBase, testProofId } from './helpers.js';

describe('section 8.2 bounds', () => {
  it('are exactly the spec values', () => {
    const l = defaultLimits();
    expect({ ...l }).toEqual({
      maxEvidenceBytes: 64 << 20, maxLinks: 64, maxSpineHeaders: 16384, maxHeaderChain: 32768, maxL2Headers: 1024, maxBlobsBase: 32,
      maxBlobsArbitrum: 16, maxFrameTxs: 256, maxDepositTxs: 4096, maxBlockTxs: 65536, maxNodes: 8192, maxNodeBytes: 4096,
      maxTxLeafBytes: 2097152, maxCodeBytes: 262144, maxCFA1Tables: 64, maxCFA1Records: 65536, maxSigners: 255, maxSegments: 102400,
      maxUncompressedBatch: 16777216, maxStringBytes: 255,
    });
  });
  it('refuse with the number and the limit, never truncate', () => {
    const l = defaultLimits();
    const w = new Writer();
    w.u32(l.maxNodes + 1);
    const st = stateOf(() => new Reader(w.bytes(), l).nodes('nodes', l.maxNodeBytes));
    expect(st.canonical()).toBe(`{"code":"finality_evidence_too_large","fields":{"count":"${l.maxNodes + 1}","limit":"${l.maxNodes}","part":"nodes"}}`);
  });
  it('allow a transaction-trie node up to max_tx_leaf_bytes but a state node only max_node_bytes', () => {
    const l = defaultLimits();
    const big = new Writer();
    big.count(1);
    big.lp(new Uint8Array(l.maxNodeBytes + 1));
    expect(stateOf(() => new Reader(big.bytes(), l).nodes('state', l.maxNodeBytes)).code).toBe('finality_evidence_too_large');
    expect(new Reader(big.bytes(), l).nodes('tx', l.maxTxLeafBytes).length).toBe(1);
  });
  it('refuse a container over 64 MiB before reading it, and a hostile count without allocating', () => {
    const l = defaultLimits();
    expect(stateOf(() => decodeContainer(new Uint8Array(l.maxEvidenceBytes + 1), l)).code).toBe('finality_evidence_too_large');
    const w = new Writer();
    w.u32(4); // a count of 4 with nothing after it
    expect(stateOf(() => new Reader(w.bytes(), l).lpList('list', 100, 16)).fields.reason).toBe('count_exceeds_remaining');
  });
  it('refuse an unordered, repeated or trailing NODES / container', () => {
    const l = defaultLimits();
    const a = Uint8Array.of(1);
    const b = Uint8Array.of(2);
    const [lo, hi] = Buffer.compare(keccak_256(a), keccak_256(b)) < 0 ? [a, b] : [b, a];
    const ok = new Writer();
    ok.nodes([lo, hi]);
    expect(new Reader(ok.bytes(), l).nodes('n', 8).length).toBe(2);
    for (const bad of [[hi, lo], [lo, lo]]) {
      const w = new Writer();
      w.nodes(bad);
      expect(stateOf(() => new Reader(w.bytes(), l).nodes('n', 8)).fields.reason).toBe('nodes_not_ascending_unique');
    }
    expect(stateOf(() => new Reader(Uint8Array.of(0), l).end('x')).fields.reason).toBe('trailing_bytes');
  });
});

describe('headers are read positionally, never decoded into a typed header', () => {
  const build = (items: number): Uint8Array => {
    const parts: Uint8Array[] = [];
    for (let i = 0; i < items; i++) {
      if (i === 8) parts.push(Uint8Array.of(1, 2));
      else if (i === 11) parts.push(Uint8Array.of(0x65, 0, 0, 1));
      else if ([0, 3, 4, 5, 16].includes(i)) parts.push(fill(0x10 + i));
      else parts.push(Uint8Array.of(i));
    }
    return rlpList(parts);
  };
  it.each([15, 17, 21, 23])('%i items', (n) => {
    const raw = build(n);
    const h = readHeader(raw);
    expect(h.items).toBe(n);
    expect(h.number).toBe(0x0102n);
    expect(h.timestamp).toBe(0x65000001n);
    expect(Buffer.from(h.stateRoot).equals(Buffer.from(fill(0x13)))).toBe(true);
    expect(Buffer.from(h.parentHash).equals(Buffer.from(fill(0x10)))).toBe(true);
    expect(n >= 17).toBe(h.withdrawalsRoot !== undefined);
    expect(Buffer.from(h.hash).equals(Buffer.from(keccak_256(raw)))).toBe(true);
  });
  it('refuses a non-list, too few items and trailing bytes', () => {
    expect(stateOf(() => readHeader(Uint8Array.of(1))).fields.reason).toBe('header_not_rlp_list');
    expect(stateOf(() => readHeader(rlpList([Uint8Array.of(1), Uint8Array.of(2)]))).fields.reason).toBe('header_too_few_items');
    expect(stateOf(() => readHeader(Uint8Array.of(...build(15), 0))).fields.reason).toBe('header_trailing_bytes');
  });
});

describe('the leg binding D0 is recomputed from the leg, never read from the file (RB11-B-GAP)', () => {
  it('a chain forged for another block fails own_hash at seq 1 under the real block', () => {
    const forged = testBase();
    forged.number += 1n;
    const adds = buildChain(forged, Level.L1Posted, Level.Finalized);
    const real = testBase();
    const st = stateOf(() => checkLegChain(real, real, adds));
    expect(st.fields.check).toBe('own_hash');
    expect(st.fields.seq).toBe(1n);
    expect(() => checkLegChain(real, real, buildChain(real, Level.L1Posted, Level.Finalized))).not.toThrow();
  });
  it('the carried leg is compared first: a mismatch is leg_binding at seq 0 with want and got', () => {
    const b = testBase();
    const carried = { ...b, hash: Uint8Array.from(b.hash) };
    carried.hash[0]! ^= 1;
    const st = stateOf(() => checkLegChain(b, carried, buildChain(b, Level.L1Posted)));
    expect(st.fields.check).toBe('leg_binding');
    expect(st.fields.seq).toBe(0n);
    expect(Object.keys(st.fields).sort()).toEqual(['check', 'got', 'seq', 'want']);
  });
  it('a chain id that is not a table row is finality_chain_unsupported before anything else', () => {
    const b = { chain: 1n, number: 1n, hash: fill(1) };
    expect(stateOf(() => checkLegChain(b, { chain: 2n, number: 9n, hash: fill(9) }, [])).code).toBe('finality_chain_unsupported');
  });
});

describe('levels', () => {
  it('order is free and each level appears once', () => {
    const b = testBase();
    for (const order of [[Level.L1Posted, Level.Finalized], [Level.Finalized, Level.L1Posted], [Level.Finalized], [Level.L1Posted]]) {
      expect(() => checkLegChain(b, b, buildChain(b, ...order))).not.toThrow();
    }
    const chain = buildChain(b, Level.Finalized);
    const st = stateOf(() => newAddendum(legBindingOf(b), testProofId, chain, b.chain, Level.Finalized, kBaseFin, containerFor(kBaseFin, b, Level.Finalized, 'again')));
    expect(st.code).toBe('level_already_present');
  });
  it('level 1 is never built, stored or parsed', () => {
    const b = testBase();
    expect(stateOf(() => newAddendum(legBindingOf(b), testProofId, [], b.chain, Level.Included, 'included.eth-mpt/v1', Uint8Array.of(120))).fields.check).toBe('kind');
    expect(() => encodeContainer({ header: { kind: kBaseFin, chain: b.chain, level: Level.Included, blockNumber: 0n, blockHash: fill(0) }, body: new Uint8Array() })).toThrow();
    expect(stateOf(() => kindFor(b.chain, Level.Included)).fields.reason).toBe('level_not_stored');
    const a = { ...buildChain(b, Level.Finalized)[0]!, level: Level.Included as Level };
    a.ownHash = ownHash(legBindingOf(b), a); // a rehashed level 1 addendum is still refused, by its kind
    expect(stateOf(() => verifyChain(legBindingOf(b), [a])).fields.check).toBe('kind');
    const raw = addendumToJSON(buildChain(b, Level.Finalized)[0]!).replace('"finalized"', '"included"');
    expect(stateOf(() => parseAddendum(raw)).fields.reason).toBe('level_not_stored');
  });
  it('newAddendum refuses a container that disagrees with the addendum and a kind that is not a row', () => {
    const b = testBase();
    const st = stateOf(() => newAddendum(legBindingOf(b), testProofId, [], b.chain, Level.Finalized, kBaseFin, containerFor(kBaseL1, b, Level.L1Posted, 'x')));
    expect(st.code).toBe('finality_block_mismatch');
    expect(stateOf(() => newAddendum(legBindingOf(b), testProofId, [], b.chain, Level.Finalized, 'nope/v1', containerFor(kBaseFin, b, Level.Finalized, 'x'))).fields.check).toBe('kind');
  });
});

describe('JSON round trips and strictness', () => {
  it('an addendum round-trips and a section keeps its leg', () => {
    const b = testBase();
    const chain = buildChain(b, Level.L1Posted);
    const back = parseAddendum(addendumToJSON(chain[0]!));
    expect(Buffer.from(back.ownHash).equals(Buffer.from(chain[0]!.ownHash))).toBe(true);
    expect(back.level).toBe(Level.L1Posted);
    expect(proofIdString(back.proofId)).toBe(proofIdString(testProofId));
    const sec = parseSection(sectionToJSON(newSection(b, buildChain(b, Level.Finalized))));
    expect(sec.leg).toEqual(carriedLegOf(b));
    expect(sec.addenda.length).toBe(1);
  });
  it.each([
    ['unknown field', (s: string) => s.replace('"seq"', '"extra":1,"seq"')],
    ['level', (s: string) => s.replace('"l1_posted"', '"almost"')],
    ['short hash', (s: string) => s.replace('"ownHash":"', '"ownHash":"00')],
    ['evidence hex', (s: string) => s.replace('"evidence":"', '"evidence":"zz')],
    ['proof id', (s: string) => s.replace('"proofId":"', '"proofId":"zz')],
  ])('refuses %s', (_n, edit) => {
    const raw = addendumToJSON(buildChain(testBase(), Level.L1Posted)[0]!);
    expect(stateOf(() => parseAddendum(edit(raw))).code).toBe('finality_addendum_malformed');
  });
  it.each([
    ['format', (s: string) => s.replace('certen-finality-addenda/1', 'certen-finality-addenda/2')],
    ['unknown member', (s: string) => s.replace('"leg"', '"originalProofDigest":"00","leg"')],
  ])('refuses a section with a wrong %s', (_n, edit) => {
    const b = testBase();
    expect(stateOf(() => parseSection(edit(sectionToJSON(newSection(b, buildChain(b, Level.Finalized)))))).code).toBe('finality_addendum_malformed');
  });
  it('proof ids are canonical lower-case uuids', () => {
    const id = parseProofId('01020304-0506-4708-8909-0a0b0c0d0e0f');
    expect([...id]).toEqual([1, 2, 3, 4, 5, 6, 0x47, 8, 0x89, 9, 10, 11, 12, 13, 14, 15]);
    expect(proofIdString(id)).toBe('01020304-0506-4708-8909-0a0b0c0d0e0f');
    for (const bad of ['', 'not-a-uuid', '0102030405064708890909a0b0c0d0e0f0', '0102030g-0506-4708-8909-0a0b0c0d0e0f']) {
      expect(stateOf(() => parseProofId(bad)).fields.reason).toBe('not_canonical_uuid');
    }
  });
});
