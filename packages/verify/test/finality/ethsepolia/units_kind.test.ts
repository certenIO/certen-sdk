/**
 * Unit tests of the eth-sepolia/finalized/v1 kind beside the Go vectors (the twins of ethsepolia/verify_unit_test.go, plus the hostile
 * inputs of the codec): the part a truncated body ends in, the exact spine and link bounds (N passes, N-1 fails), pins and leg-chain
 * states, the framework state of an unreadable spine header with its index, the translation of L1 faults, registration, and the
 * registry's judgement of the valid vectors.
 */
import { describe, expect, it, vi } from 'vitest';
import { Writer, decodeContainer, defaultLimits } from '../../../src/proof-v2/finality/codec.js';
import { FinalityStateError, newState } from '../../../src/proof-v2/finality/state.js';
import { CodeHeaderChainBroken, headerChainBroken, pinUnknown, encodeLC } from '../../../src/proof-v2/finality/ethl1/index.js';
import { KIND_NAME, EthSepoliaKind, buildContainer, decodeBody, encodeBody, registerEthSepolia } from '../../../src/proof-v2/finality/ethsepolia/kind.js';
import { stateOf as translate, SpineL1 } from '../../../src/proof-v2/finality/ethsepolia/states.js';
import { embeddedPins, parsePinsOverride } from '../../../src/proof-v2/finality/pins.js';
import { Registry } from '../../../src/proof-v2/finality/registry.js';
import { Level } from '../../../src/proof-v2/finality/level.js';
import { ChainSepolia } from '../../../src/proof-v2/finality/table.js';
import type { Addendum } from '../../../src/proof-v2/finality/addendum.js';
import { evidenceOf, loadVerifyCase, read } from './vectorset.js';
import { recorded, stateOf } from './recorded.js';

// real verifications of 3 MB objects: a loaded machine must not read a slow decode as a failure
vi.setConfig({ testTimeout: 300_000 });

const lim = defaultLimits();

describe('registration', () => {
  it('registers once on its row of the table and refuses a second registration', () => {
    const reg = new Registry();
    registerEthSepolia(reg);
    const k = reg.kind(KIND_NAME)!;
    expect(KIND_NAME).toBe('eth-sepolia/finalized/v1');
    expect([k.name(), k.chain(), k.level()]).toEqual([KIND_NAME, ChainSepolia, Level.Finalized]);
    expect(() => registerEthSepolia(reg)).toThrow(/already has a verifier/);
  });

  it('the valid vectors pass the registry judgement, and evidence about another block does not', () => {
    const reg = new Registry();
    registerEthSepolia(reg);
    for (const id of ['valid_gloas_latest', 'valid_gloas_period', 'valid_legacy']) {
      const c = loadVerifyCase('eth_sepolia1', id);
      const pins = parsePinsOverride(read('eth_sepolia1', c.pins));
      const ev = evidenceOf('eth_sepolia1', c);
      const ref = { chain: ChainSepolia, number: BigInt(c.leg.number), hash: Uint8Array.from(Buffer.from(c.leg.hash.slice(2), 'hex')) };
      const add = { level: Level.Finalized, chain: ChainSepolia, kind: KIND_NAME, evidence: ev } as unknown as Addendum;
      const v = reg.judgeAddendum(ref, add, pins);
      expect([v.level, v.kind]).toEqual([Level.Finalized, KIND_NAME]);
      const other = stateOf(() => reg.judgeAddendum({ ...ref, number: ref.number + 1n }, add, pins));
      expect(other.code, id).toBe('finality_block_mismatch');
    }
  });
});

describe('the body codec', () => {
  const l = recorded('eth_sepolia2', 'gloas_latest'); // 13 in-evidence links

  it('encode(decode(x)) == x for the recorded bodies', () => {
    for (const [set, name] of [['eth_sepolia1', 'gloas_latest'], ['eth_sepolia1', 'gloas_period'], ['eth_sepolia1', 'legacy'], ['eth_sepolia2', 'gloas_latest_kind2']] as const) {
      const r = recorded(set, name);
      expect(Buffer.from(encodeBody(r.body)).equals(Buffer.from(r.bodyBytes)), `${set}/${name}`).toBe(true);
    }
  });

  it('a body cut anywhere in the light-client part names the part it ended in', () => {
    const anchorBody = l.body.lc.anchorBody.ssz.length;
    const p1 = 58 + anchorBody; // the link count
    const linkAt = p1 + 4;
    const last = l.body.lc.links.length - 1;
    let lastAt = linkAt;
    for (const lk of l.body.lc.links.slice(0, last)) lastAt += 5 + lk.ssz.length;
    const lastLen = l.body.lc.links[last]!.ssz.length;
    let finalAt = linkAt;
    for (const lk of l.body.lc.links) finalAt += 5 + lk.ssz.length;
    const spineAt = finalAt + 5 + l.body.lc.finalUpdate.ssz.length;
    const cuts: [number, string][] = [
      [2, 'lc.profile.len'], [7, 'lc.profile'], [12, 'lc.anchorKind'], [15, 'lc.anchorPeriod'], [25, 'lc.anchorRoot'], [53, 'lc.anchorBody.layout'],
      [56, 'lc.anchorBody.len'], [100, 'lc.anchorBody'], [p1 + 2, 'lc.links.count'], [lastAt, 'lc.link.layout'], [lastAt + 3, 'lc.link.len'],
      [lastAt + 5 + Math.floor(lastLen / 2), 'lc.link'], [finalAt, 'lc.finalUpdate.layout'], [finalAt + 3, 'lc.finalUpdate.len'],
      [finalAt + 10, 'lc.finalUpdate'], [spineAt + 2, 'spine.count'],
    ];
    for (const [cut, want] of cuts) {
      const s = stateOf(() => decodeBody(l.bodyBytes.subarray(0, cut), lim, 64, 16384));
      expect([s.code, s.fields.part], `cut at ${cut}`).toEqual(['finality_evidence_malformed', want]);
    }
  });

  it('the spine bound is the smaller of the pins and the generic limit; zero means the generic limit alone (N passes, N-1 fails)', () => {
    const r = recorded('eth_sepolia1', 'legacy'); // 4,057 headers
    const n = r.body.spine.length;
    const small = { ...lim, maxSpineHeaders: 100 };
    const lowGeneric = { ...lim, maxSpineHeaders: n - 1 };
    const cases: [string, typeof lim, number, number][] = [
      ['the pins bound is lower', lim, 100, 100], ['the pins bound is zero', lim, 0, 0], ['the pins bound is one', lim, 1, 1],
      ['the pins bound is larger', small, 5000, 100], ['the generic bound is lower', small, 0, 100], ['the pins bound equals count', lim, n, 0],
      ['the pins bound is one short', lim, n - 1, n - 1], ['both are larger than count', lim, 20000, 0], ['the generic bound is one low', lowGeneric, 0, n - 1],
    ];
    for (const [name, l2, maxSpine, limit] of cases) {
      if (limit === 0) {
        expect(() => decodeBody(r.bodyBytes, l2, 64, maxSpine), name).not.toThrow();
        continue;
      }
      const s = stateOf(() => decodeBody(r.bodyBytes, l2, 64, maxSpine));
      expect([s.code, s.fields.limit, s.fields.count], name).toEqual(['finality_evidence_too_large', BigInt(limit), BigInt(n)]);
    }
  });

  it('the link bound is inclusive: max_links = count passes, count-1 is evidence_too_large{limit}', () => {
    const r = recorded('eth_sepolia2', 'gloas_latest'); // 13 in-evidence links
    const n = r.body.lc.links.length;
    expect(n).toBe(13);
    expect(() => decodeBody(r.bodyBytes, lim, n, 16384)).not.toThrow();
    const s = stateOf(() => decodeBody(r.bodyBytes, lim, n - 1, 16384));
    expect([s.code, s.fields.part, s.fields.count, s.fields.limit]).toEqual(['finality_evidence_too_large', 'lc.links', BigInt(n), BigInt(n - 1)]);
  });

  it('a hostile link count or spine count allocates nothing and is a named refusal', () => {
    const lcBytes = (count: number): Uint8Array => {
      const w = new Writer();
      w.str('eth-lc/1');
      w.u8(1);
      w.u64(7n);
      w.fixed(new Uint8Array(32));
      w.u8(0);
      w.u32(0);
      w.u32(count);
      return w.bytes();
    };
    // over the bound: too large, with the declared number
    for (const count of [65, 10_000_000, 0xffffffff]) {
      const s = stateOf(() => decodeBody(lcBytes(count), lim, 64, 16384));
      expect([s.code, s.fields.count, s.fields.limit], String(count)).toEqual(['finality_evidence_too_large', BigInt(count), 64n]);
    }
    // within the bound but more than the bytes left can hold (5 bytes per link at least): malformed, never sized by the count
    const s = stateOf(() => decodeBody(lcBytes(10_000_000), lim, 10_000_000, 16384));
    expect([s.code, s.fields.part, s.fields.reason]).toEqual(['finality_evidence_malformed', 'lc.links', 'count_exceeds_remaining']);
    const exact = stateOf(() => decodeBody(lcBytes(1), lim, 64, 16384)); // 1 link needs 5 bytes, none follow
    expect([exact.code, exact.fields.reason]).toEqual(['finality_evidence_malformed', 'count_exceeds_remaining']);
    // a huge spine count
    const w = new Writer();
    w.fixed(encodeLC({ ...l.body.lc, links: [] }));
    w.u32(0xffffffff);
    const sp = stateOf(() => decodeBody(w.bytes(), lim, 64, 16384));
    expect([sp.code, sp.fields.part, sp.fields.count, sp.fields.limit]).toEqual(['finality_evidence_too_large', 'spine', 0xffffffffn, 16384n]);
  });

  it('an empty spine, a trailing byte and a profile that is not ASCII are named refusals', () => {
    const w = new Writer();
    w.fixed(encodeLC({ ...l.body.lc, links: [] }));
    w.u32(0);
    const empty = stateOf(() => decodeBody(w.bytes(), lim, 64, 16384));
    expect([empty.code, empty.fields.part, empty.fields.reason]).toEqual(['finality_evidence_malformed', 'spine', 'spine_empty']);
    const trailing = new Uint8Array(l.bodyBytes.length + 1);
    trailing.set(l.bodyBytes);
    const t = stateOf(() => decodeBody(trailing, lim, 64, 16384));
    expect([t.code, t.fields.part, t.fields.reason]).toEqual(['finality_evidence_malformed', 'body', 'trailing_bytes']);
    const bad = Uint8Array.from(l.bodyBytes);
    bad[4] = 0x80; // the first profile byte
    const p = stateOf(() => decodeBody(bad, lim, 64, 16384));
    expect([p.code, p.fields.part]).toEqual(['finality_evidence_malformed', 'lc.profile']);
  });
});

describe('Verify', () => {
  const legacy = recorded('eth_sepolia1', 'legacy');
  const pins = embeddedPins();

  it('the verdict of the real legacy leg carries the proven values', () => {
    const v = new EthSepoliaKind().verify(parsePinsOverride(read('eth_sepolia1', 'pins/main.json')), legacy.ref, legacy.ev);
    expect([v.level, v.kind]).toEqual([Level.Finalized, KIND_NAME]);
    expect(Object.keys(v.fields).sort()).toEqual(['anchor_period', 'finalized_exec_number', 'finalized_slot', 'headers_walked', 'participants', 'periods_crossed']);
    expect(v.fields.headers_walked).toBe(BigInt(legacy.body.spine.length));
    expect(v.fields.anchor_period).toBe(legacy.body.lc.anchorPeriod);
  });

  it('a leg without its header bytes is judged by the spine alone; other header bytes are finality_block_mismatch{header}', () => {
    const { headerRlp: _h, ...noHeader } = legacy.ref;
    expect(() => new EthSepoliaKind().verify(pins, noHeader, legacy.ev)).not.toThrow();
    const other = Uint8Array.from(legacy.ref.headerRlp!);
    other[other.length - 1] ^= 1;
    const s = stateOf(() => new EthSepoliaKind().verify(pins, { ...legacy.ref, headerRlp: other }, legacy.ev));
    expect([s.code, s.fields.field]).toEqual(['finality_block_mismatch', 'header']);
    const empty = stateOf(() => new EthSepoliaKind().verify(pins, { ...legacy.ref, headerRlp: new Uint8Array(0) }, legacy.ev));
    expect([empty.code, empty.fields.field]).toEqual(['finality_block_mismatch', 'header']);
  });

  it('no pins, or another leg chain, is a named state', () => {
    expect(stateOf(() => new EthSepoliaKind().verify(null, legacy.ref, legacy.ev)).code).toBe('finality_pin_unknown');
    const s = stateOf(() => new EthSepoliaKind().verify(pins, { ...legacy.ref, chain: 1n }, legacy.ev));
    expect([s.code, s.fields.field, s.fields.want, s.fields.got]).toEqual(['finality_block_mismatch', 'chain', ChainSepolia, 1n]);
  });

  it('a pins file with a lower max_spine_headers refuses the same evidence by count', () => {
    const text = new TextDecoder().decode(new Uint8Array(Buffer.from(read('eth_sepolia1', 'pins/main.json')))).replace('"max_spine_headers": 16384', '"max_spine_headers": 4056');
    const s = stateOf(() => new EthSepoliaKind().verify(parsePinsOverride(new TextEncoder().encode(text)), legacy.ref, legacy.ev));
    expect([s.code, s.fields.limit, s.fields.part]).toEqual(['finality_evidence_too_large', 4056n, 'spine']);
  });

  it('the verifier limits override the generic bounds', () => {
    const s = stateOf(() => new EthSepoliaKind({ ...lim, maxEvidenceBytes: 1 << 20 }).verify(pins, legacy.ref, legacy.ev));
    expect([s.code, s.fields.part]).toEqual(['finality_evidence_too_large', 'evidence']);
    expect(() => new EthSepoliaKind().verify(pins, legacy.ref, legacy.ev)).not.toThrow();
  });

  it('a container of another kind, level 2 or another chain is judged at its header before any evidence is read', () => {
    const c = decodeContainer(legacy.ev, lim);
    const rebuilt = (kind: string, chain: bigint, level: number): Uint8Array => {
      const w = new Writer();
      w.fixed(new TextEncoder().encode('CFE1'));
      w.str(kind);
      w.u64(chain);
      w.u8(level);
      w.u64(c.header.blockNumber);
      w.b32(c.header.blockHash);
      w.fixed(c.body);
      return w.bytes();
    };
    const k = stateOf(() => new EthSepoliaKind().verify(pins, legacy.ref, rebuilt('eth-sepolia/finalized/v2', ChainSepolia, 3)));
    expect([k.code, k.fields.part, k.fields.reason]).toEqual(['finality_evidence_malformed', 'header.kind', 'differs_from_addendum']);
    const ch = stateOf(() => new EthSepoliaKind().verify(pins, legacy.ref, rebuilt(KIND_NAME, 1n, 3)));
    expect([ch.code, ch.fields.field, ch.fields.want, ch.fields.got]).toEqual(['finality_block_mismatch', 'chain', ChainSepolia, 1n]);
    const lv = stateOf(() => new EthSepoliaKind().verify(pins, legacy.ref, rebuilt(KIND_NAME, ChainSepolia, 2)));
    expect([lv.code, lv.fields.part, lv.fields.reason, lv.fields.got_len, lv.fields.want_len]).toEqual(['finality_evidence_malformed', 'header.level', 'level_not_finalized', 2n, 3n]);
  });

  it('an unreadable spine header is a malformed spine part with its index, before any chain rule', () => {
    const b = { lc: legacy.body.lc, spine: [...legacy.body.spine] };
    const bad = Uint8Array.from(b.spine[3]!);
    bad[0] = 0x00;
    b.spine[3] = bad;
    const s = stateOf(() => new EthSepoliaKind().verify(pins, legacy.ref, buildContainer(legacy.ref, b)));
    expect([s.code, s.fields.part, s.fields.index, s.fields.reason]).toEqual(['finality_evidence_malformed', 'spine', 3n, 'header_not_rlp_list']);
  });

});

describe('stateOf (the translation of L1 faults)', () => {
  it('translates only light-client header-chain faults; every other error passes through untouched', () => {
    const plain = new Error('not a fault');
    expect(translate(plain)).toBe(plain);
    expect(translate(undefined)).toBeUndefined();
    const f = headerChainBroken(SpineL1, 7n, new Uint8Array(32).fill(1), new Uint8Array(32).fill(2), 'rlp');
    const s = translate(f) as FinalityStateError;
    expect([s.code, s.fields.part, s.fields.reason]).toEqual(['finality_evidence_malformed', 'spine', 'header_bad_item']);
    for (const [input, want] of [['hash', 'parent_hash_mismatch'], ['number', 'number_gap']] as const) {
      const g = translate(headerChainBroken(SpineL1, 7n, new Uint8Array(32).fill(1), new Uint8Array(32).fill(2), input)) as FinalityStateError;
      expect([g.code, g.fields.reason, g.fields.at_number, g.fields.spine]).toEqual([CodeHeaderChainBroken, want, 7n, 'l1']);
    }
    const other = translate(pinUnknown(1, 5n, new Uint8Array(32).fill(3))) as FinalityStateError;
    expect([other.code, other.fields.period]).toEqual(['finality_pin_unknown', 5n]);
    const foreign = newState('finality_chain_broken', {});
    expect(translate(foreign)).toBe(foreign);
  });
});
