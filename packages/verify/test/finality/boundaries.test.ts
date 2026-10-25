/**
 * Boundary cases the vectors do not reach: a value exactly at its bound is accepted, one past it refused (these kill the off-by-one
 * mutants of the hand mutation gate recorded in the check-in), and the two judgements that only differ at a boundary.
 */
import { keccak_256 } from '@noble/hashes/sha3';
import { describe, expect, it } from 'vitest';
import { Reader, Writer, decodeContainer, defaultLimits, encodeContainer } from '../../src/proof-v2/finality/codec.js';
import { Level } from '../../src/proof-v2/finality/level.js';
import { parsePinsOverride } from '../../src/proof-v2/finality/pins.js';
import { Registry, type Kind } from '../../src/proof-v2/finality/registry.js';
import { verifyLeg } from '../../src/proof-v2/finality/report.js';
import { canonValue } from '../../src/proof-v2/finality/state.js';
import { ChainBaseSepolia } from '../../src/proof-v2/finality/table.js';
import { buildChain, containerFor, kBaseFin, limitsFrom, stateOf, testBase, testProofId } from './helpers.js';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

describe('lp, count and str bounds are inclusive at the limit', () => {
  const l = defaultLimits();
  it('an lp of exactly max bytes is read, one more is finality_evidence_too_large', () => {
    const w = new Writer();
    w.lp(new Uint8Array(16));
    expect(new Reader(w.bytes(), l).lp('x', 16).length).toBe(16);
    const w2 = new Writer();
    w2.lp(new Uint8Array(17));
    expect(stateOf(() => new Reader(w2.bytes(), l).lp('x', 16)).code).toBe('finality_evidence_too_large');
  });
  it('an lp that is exactly the remaining length is read, one more is length_exceeds_remaining', () => {
    const exact = Uint8Array.of(0, 0, 0, 2, 7, 7);
    expect([...new Reader(exact, l).lp('x', -1)]).toEqual([7, 7]);
    const over = Uint8Array.of(0, 0, 0, 3, 7, 7);
    expect(stateOf(() => new Reader(over, l).lp('x', -1)).fields.reason).toBe('length_exceeds_remaining');
  });
  it('a list whose elements exactly fit the remaining bytes is read (n * minElem == remaining)', () => {
    const w = new Writer();
    w.count(1);
    w.lp(new Uint8Array(0)); // one empty element: 4 bytes remain after the count, minElem is 4
    expect(new Reader(w.bytes(), l).lpList('x', 4, 16).length).toBe(1);
  });
  it('a count equal to its limit is read, one more is too large', () => {
    const w = new Writer();
    w.count(2);
    w.lp(new Uint8Array(0));
    w.lp(new Uint8Array(0));
    expect(new Reader(w.bytes(), l).lpList('x', 2, 16).length).toBe(2);
    const w2 = new Writer();
    w2.count(3);
    expect(stateOf(() => new Reader(w2.bytes(), l).lpList('x', 2, 16)).code).toBe('finality_evidence_too_large');
  });
  it('a STR may hold DEL (0x7f) but not 0x80 or NUL, and is bounded by max_string_bytes inclusively', () => {
    const w = new Writer();
    w.lp(Uint8Array.of(0x61, 0x7f));
    expect(new Reader(w.bytes(), l).str('s')).toBe('a\u007f');
    for (const bad of [0x80, 0x00]) {
      const b = new Writer();
      b.lp(Uint8Array.of(0x61, bad));
      const st = stateOf(() => new Reader(b.bytes(), l).str('s'));
      expect(st.fields.reason).toBe('str_not_ascii_or_nul');
      expect(st.fields.index).toBe(1n);
    }
    const lim = { ...l, maxStringBytes: 4 };
    const four = new Writer();
    four.lp(new TextEncoder().encode('abcd'));
    expect(new Reader(four.bytes(), lim).str('s')).toBe('abcd');
    const five = new Writer();
    five.lp(new TextEncoder().encode('abcde'));
    expect(stateOf(() => new Reader(five.bytes(), lim).str('s')).code).toBe('finality_evidence_too_large');
  });
  it('u64 needs eight bytes: seven are truncated, eight are read', () => {
    expect(stateOf(() => new Reader(new Uint8Array(7), l).u64('n')).fields.reason).toBe('truncated');
    expect(new Reader(Uint8Array.of(0, 0, 0, 0, 0, 0, 1, 0), l).u64('n')).toBe(256n);
    expect(stateOf(() => new Reader(new Uint8Array(3), l).u32('n')).fields.reason).toBe('truncated');
  });
  it('a container exactly at max_evidence_bytes is decoded, one byte more is too large', () => {
    const b = testBase();
    const ev = containerFor(kBaseFin, b, Level.Finalized, 'body');
    expect(decodeContainer(ev, limitsFrom({ max_evidence_bytes: ev.length })).header.blockNumber).toBe(b.number);
    const st = stateOf(() => decodeContainer(ev, limitsFrom({ max_evidence_bytes: ev.length - 1 })));
    expect(st.canonical()).toBe(`{"code":"finality_evidence_too_large","fields":{"count":"${ev.length}","limit":"${ev.length - 1}","part":"evidence"}}`);
  });
});

describe('a hex pin of the wrong width is refused', () => {
  it('a genesis root with one byte too many is genesis_validators_root_malformed', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const text = readFileSync(join(here, '..', '..', 'src', 'proof-v2', 'finality', 'finality-pins.json'), 'utf8');
    const long = text.replace('0xd8ea17', '0xd8d8ea17');
    const st = stateOf(() => parsePinsOverride(new TextEncoder().encode(long)));
    expect(st.fields.reason).toBe('genesis_validators_root_malformed');
  });
});

describe('judgeAddendum insists that the kind proved the addendum\'s own level', () => {
  it('an addendum whose level is not its kind\'s row level is verifier_failed even when its header agrees', () => {
    const b = testBase();
    const r = new Registry();
    const fin: Kind = { name: () => kBaseFin, chain: () => ChainBaseSepolia, level: () => Level.Finalized, verify: () => ({ level: Level.Finalized, kind: kBaseFin, fields: {} }) };
    r.registerKind(fin);
    // level 2 under the finalized kind's name: the container header says the same, so only the level comparison can refuse it
    const ev = encodeContainer({ header: { kind: kBaseFin, chain: b.chain, level: Level.L1Posted, blockNumber: b.number, blockHash: b.hash }, body: new Uint8Array() });
    const a = { proofId: testProofId, seq: 1n, level: Level.L1Posted as Level, chain: b.chain, kind: kBaseFin, evidence: ev, prevHash: new Uint8Array(32), ownHash: new Uint8Array(32) };
    const st = stateOf(() => r.judgeAddendum(b, a, null));
    expect(st.code).toBe('finality_verifier_failed');
    expect(st.fields.cause).toBe('the kind returned level finalized for a finalized row');
  });
});

describe('finalized_block with an empty header', () => {
  it('a zero-length header is no_header, not an unreadable one', () => {
    const base = testBase();
    const b = { ...base, headerRlp: new Uint8Array(0) };
    const r = new Registry();
    r.registerKind({ name: () => kBaseFin, chain: () => ChainBaseSepolia, level: () => Level.Finalized, verify: () => ({ level: Level.Finalized, kind: kBaseFin, fields: {} }) });
    const rep = verifyLeg(r, b, b, buildChain(b, Level.Finalized), null);
    expect(rep.finalizedBlockState?.fields.reason).toBe('no_header');
  });
});

describe('quoting of the two line separators', () => {
  it('writes U+2028 and U+2029 as escapes, as Go does even with HTML escaping off', () => {
    expect(canonValue(' ')).toBe('"\\u2028"');
    expect(canonValue(' ')).toBe('"\\u2029"');
  });
});

describe('a keccak ordering sanity for NODES (the hash order, not the byte order of the nodes)', () => {
  it('orders by keccak256 of the node', () => {
    const nodes = [Uint8Array.of(1), Uint8Array.of(2), Uint8Array.of(3)];
    const sorted = [...nodes].sort((x, y) => Buffer.compare(keccak_256(x), keccak_256(y)));
    const w = new Writer();
    w.nodes(sorted);
    expect(new Reader(w.bytes(), defaultLimits()).nodes('n', 8).length).toBe(3);
    // the same nodes sorted by their own bytes are accepted only if that order happens to equal the hash order
    const byBytes = [...nodes].sort((x, y) => Buffer.compare(x, y));
    const same = byBytes.every((n, i) => n === sorted[i]);
    const w2 = new Writer();
    w2.nodes(byBytes);
    if (!same) expect(stateOf(() => new Reader(w2.bytes(), defaultLimits()).nodes('n', 8)).fields.reason).toBe('nodes_not_ascending_unique');
  });
});

