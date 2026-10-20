/** The Kind adiri/finalized/v1 end to end on synthetic evidence: container header, body, link by spine (1) and by EIP-2935 slot (2). */
import { describe, expect, it } from 'vitest';
import { keccak_256 } from '@noble/hashes/sha3';
import { Registry } from '../../../src/proof-v2/finality/registry.js';
import { defaultLimits } from '../../../src/proof-v2/finality/codec.js';
import { FinalityStateError, newState } from '../../../src/proof-v2/finality/state.js';
import type { BlockRef } from '../../../src/proof-v2/finality/evidence.js';
import {
  AdiriVerifier,
  buildContainer,
  consensusRootOf,
  decodeBody,
  encodeBody,
  parsePins,
  registerAdiri,
  verifySpine,
  type ChainResult,
  type Body,
} from '../../../src/proof-v2/finality/adiri/index.js';
import { assertRegistered } from './regcheck.js';
import { embeddedAdiriPins } from './vectorset.js';
import { buildChain, eip2935State, filled, hashOf, hex, makeHeader, makeSpine, numberOf, pinsOfSection, pinsSection, type RecSpec } from './synth.js';

const CR = filled(32, 0x5c);
const K5 = [0, 1, 2, 3, 4];

interface Scenario {
  evidence: Uint8Array;
  leg: BlockRef;
  pins: ReturnType<typeof pinsOfSection>;
  body: Body;
  cfa1: Uint8Array;
}

function spineScenario(o: { F?: bigint; L?: bigint; extra?: Partial<RecSpec>; maxHeaders?: number; fcHash?: Uint8Array } = {}): Scenario {
  const F = o.F ?? 1003n;
  const L = o.L ?? 1000n;
  const spine = makeSpine(F, Number(F - L) + 1, CR);
  const chain = buildChain([{ committee: K5, next: K5, fsNumber: F, fsHash: hashOf(spine[0]!), fcHash: o.fcHash ?? CR, ...o.extra }]);
  const pins = pinsOfSection(pinsSection({ genesisCommittee: K5, epoch0Number: F, epoch0Hash: hashOf(spine[0]!), maxHeaders: o.maxHeaders }));
  const leg = { chain: 2017n, number: L, hash: hashOf(spine[spine.length - 1]!), headerRlp: spine[spine.length - 1]! };
  const body: Body = { cfa1: chain.bytes, linkKind: 1, spine, finalHeader: new Uint8Array(0), nodes: [] };
  return { evidence: buildContainer(leg, body), leg, pins, body, cfa1: chain.bytes };
}

function slotScenario(o: { F?: bigint; L?: bigint; value?: Uint8Array; codeHash?: Uint8Array; omitAccount?: boolean; fcHash?: Uint8Array } = {}): Scenario & { finalHeader: Uint8Array } {
  const F = o.F ?? 10003n;
  const L = o.L ?? 10000n;
  const legHash = filled(32, 0x7a);
  const st = eip2935State(L, o.value ?? legHash, o.codeHash);
  const finalHeader = makeHeader({ number: F, stateRoot: st.stateRoot, consensusRoot: CR });
  const chain = buildChain([{ committee: K5, next: K5, fsNumber: F, fsHash: hashOf(finalHeader), fcHash: o.fcHash ?? CR }]);
  const pins = pinsOfSection(pinsSection({ genesisCommittee: K5, epoch0Number: F, epoch0Hash: hashOf(finalHeader) }));
  const leg: BlockRef = { chain: 2017n, number: L, hash: legHash };
  const body: Body = { cfa1: chain.bytes, linkKind: 2, spine: [], finalHeader, nodes: o.omitAccount ? [] : st.nodes };
  return { evidence: buildContainer(leg, body), leg, pins, body, cfa1: chain.bytes, finalHeader };
}

const verify = (s: Scenario, ev: Uint8Array = s.evidence, leg: BlockRef = s.leg, v = new AdiriVerifier()) => v.verify(s.pins, leg, ev);
function refuse(f: () => unknown): FinalityStateError {
  try {
    f();
  } catch (e) {
    expect(e).toBeInstanceOf(FinalityStateError);
    assertRegistered(e as FinalityStateError);
    return e as FinalityStateError;
  }
  throw new Error('expected a refusal');
}
const canon = (f: () => unknown): string => refuse(f).canonical();

describe('a spine link (linkKind 1)', () => {
  it('finalizes the leg and reports the verdict', () => {
    const s = spineScenario();
    const v = verify(s);
    expect(v.level).toBe(3);
    expect(v.kind).toBe('adiri/finalized/v1');
    expect(newState('finalized', v.fields).canonical()).toBe(
      `{"code":"finalized","fields":{"chain_len":"1","committee_shrunk":[],"committee_size":"5","consensus_root_matches":true,"distance":"3","epoch":"0","final_hash":"0x${hex(hashOf(s.body.spine[0]!))}","final_number":"1003","link_kind":"1","signers":"5"}}`,
    );
  });
  it('is the same in both signature modes and registers as a Kind of the table', async () => {
    const s = spineScenario();
    expect(verify(s, s.evidence, s.leg, new AdiriVerifier({ mode: 'oneByOne' })).fields).toEqual(verify(s).fields);
    const reg = new Registry();
    await registerAdiri(reg, embeddedAdiriPins());
    expect(reg.kind('adiri/finalized/v1')).toBeDefined();
    await expect(registerAdiri(reg, embeddedAdiriPins())).rejects.toThrow();
    const v = reg.judgeAddendum(s.leg, { level: 3, chain: 2017n, kind: 'adiri/finalized/v1', evidence: s.evidence } as never, s.pins);
    expect(v.level).toBe(3);
  });
  it('reports, and never requires, that the seal header carries the certified consensus root', () => {
    const s = spineScenario({ fcHash: filled(32, 0x01) });
    expect(verify(s).fields.consensus_root_matches).toBe(false);
  });
  it('a leg that is the seal itself needs a one-header spine; distance 0', () => {
    const s = spineScenario({ F: 1003n, L: 1003n });
    const v = verify(s);
    expect(v.fields.distance).toBe(0n);
    expect(v.fields.chain_len).toBe(1n);
  });
  it('a leg above the seal is refused as block_after_seal', () => {
    const s = spineScenario({ F: 1003n, L: 1003n });
    const leg = { ...s.leg, number: 1004n };
    const ev = buildContainer(leg, s.body);
    expect(canon(() => verify(s, ev, leg))).toBe('{"code":"finality_link_broken","fields":{"at":"1004","check":"block_after_seal","from":"1003","to":"1004"}}');
  });
  it('the spine must start at the sealed block: hash or number', () => {
    const s = spineScenario();
    const other = makeSpine(1003n, 4, CR, filled(32, 9));
    const body = { ...s.body, spine: other };
    const e = refuse(() => verify(s, buildContainer(s.leg, body)));
    expect(e.canonical()).toBe(
      `{"code":"finality_link_broken","fields":{"at":"1003","check":"tip_not_final_state","from":"1003","got_hash":"0x${hex(hashOf(other[0]!))}","to":"1000","want_hash":"0x${hex(hashOf(s.body.spine[0]!))}"}}`,
    );
    // a different number with the same chain commitment
    const shifted = makeSpine(1004n, 5, CR);
    const e2 = refuse(() => verify(s, buildContainer(s.leg, { ...s.body, spine: shifted })));
    expect(e2.fields.check).toBe('tip_not_final_state');
    expect(e2.fields.at).toBe(1004n);
  });
  it('a header that does not decode is named by its index and the block number it stands at', () => {
    const s = spineScenario();
    const bad = s.body.spine.map((h, i) => (i === 2 ? Uint8Array.of(0x01, 0x02) : h));
    expect(canon(() => verify(s, buildContainer(s.leg, { ...s.body, spine: bad })))).toBe('{"code":"finality_link_broken","fields":{"at":"1001","check":"header_decode","from":"1003","index":"2","to":"1000"}}');
    const first = s.body.spine.map((h, i) => (i === 0 ? Uint8Array.of(0x01) : h));
    expect(canon(() => verify(s, buildContainer(s.leg, { ...s.body, spine: first })))).toBe('{"code":"finality_link_broken","fields":{"at":"1003","check":"header_decode","from":"1003","index":"0","to":"1000"}}');
  });
  it('a header that cannot be read labels the refusal with a saturating number, never a wrapped one', () => {
    // F = 1 and a decode failure at index 2: 1 - 2 saturates at 0
    const s = spineScenario({ F: 1n, L: 0n });
    const spine = [s.body.spine[0]!, s.body.spine[1]!, Uint8Array.of(1)];
    const e = refuse(() => verify(s, buildContainer(s.leg, { ...s.body, spine })));
    expect(e.fields.check).toBe('header_decode');
    expect(e.fields.at).toBe(0n);
    expect(e.fields.index).toBe(2n);
  });
  it('a broken parent link and a number gap are finality_header_chain_broken', () => {
    const s = spineScenario();
    const spine = [...s.body.spine];
    spine[2] = makeHeader({ number: 1001n, parentHash: hashOf(spine[3]!), salt: 9 });
    const e = refuse(() => verify(s, buildContainer(s.leg, { ...s.body, spine })));
    expect(e.fields.reason).toBe('parent_hash_mismatch');
    expect(e.fields.spine).toBe('adiri');
    expect(e.fields.at_number).toBe(1001n);
    expect(hex(e.fields.want_hash as Uint8Array)).toBe(hex(consensusParent(s.body.spine[1]!)));
    expect(hex(e.fields.got_hash as Uint8Array)).toBe(hex(hashOf(spine[2]!)));
    // hashes link but the numbers jump by two
    const g = makeHeader({ number: 1000n, parentHash: filled(32, 3) });
    const linked = [makeHeader({ number: 1003n, parentHash: hashOf(g), consensusRoot: CR }), g];
    const chain2 = buildChain([{ committee: K5, next: K5, fsNumber: 1003n, fsHash: hashOf(linked[0]!), fcHash: CR }]);
    const pins2 = pinsOfSection(pinsSection({ genesisCommittee: K5, epoch0Number: 1003n, epoch0Hash: hashOf(linked[0]!) }));
    const leg2 = { chain: 2017n, number: 1000n, hash: hashOf(g), headerRlp: g };
    const e2 = refuse(() => new AdiriVerifier().verify(pins2, leg2, buildContainer(leg2, { cfa1: chain2.bytes, linkKind: 1, spine: linked, finalHeader: new Uint8Array(0), nodes: [] })));
    expect(e2.fields.reason).toBe('number_gap');
    expect(e2.fields.at_number).toBe(1002n);
  });
  it('the last header must be the leg: number, hash, and (when the caller holds it) the header bytes', () => {
    const s = spineScenario();
    const shortLeg = { ...s.leg, number: 1001n, hash: hashOf(s.body.spine[2]!), headerRlp: s.body.spine[2]! };
    expect(canon(() => verify(s, buildContainer(shortLeg, s.body), shortLeg))).toBe('{"code":"finality_block_mismatch","fields":{"field":"spineLastNumber","got":"1000","want":"1001"}}');
    const wrongHash = { ...s.leg, hash: filled(32, 0x31), headerRlp: undefined };
    const e = refuse(() => verify(s, buildContainer(wrongHash, s.body), wrongHash));
    expect(e.fields.field).toBe('spineLastHash');
    expect(hex(e.fields.want as Uint8Array)).toBe(hex(filled(32, 0x31)));
    expect(hex(e.fields.got as Uint8Array)).toBe(hex(s.leg.hash));
    const otherBytes = makeHeader({ number: 1000n, salt: 77 });
    const sameHashLeg = { ...s.leg, headerRlp: otherBytes };
    const h = refuse(() => verify(s, s.evidence, sameHashLeg));
    expect(h.fields.field).toBe('spineLastHeader');
    expect(h.fields.want).toBe(hex(keccak_256(otherBytes)));
    expect(h.fields.got).toBe(hex(keccak_256(s.leg.headerRlp!)));
    // no header held: equality by hash and number is enough
    expect(verify(s, s.evidence, { ...s.leg, headerRlp: undefined }).level).toBe(3);
  });
  it('the spine is bounded by min(max_headers, 16384)', () => {
    const s = spineScenario({ F: 1010n, L: 1000n, maxHeaders: 11 });
    expect(verify(s).fields.distance).toBe(10n);
    const t = spineScenario({ F: 1010n, L: 1000n, maxHeaders: 10 });
    expect(canon(() => verify(t))).toBe('{"code":"finality_evidence_too_large","fields":{"count":"11","limit":"10","part":"spine"}}');
    const lim = defaultLimits();
    const raw = encodeBody({ ...s.body, spine: s.body.spine });
    expect(decodeBody(raw, lim, 1 << 30).spine.length).toBe(11);
    expect(decodeBody(raw, lim, 11).spine.length).toBe(11);
    expect(refuse(() => decodeBody(raw, lim, 10)).fields.limit).toBe(10n);
    expect(refuse(() => decodeBody(raw, { ...lim, maxSpineHeaders: 5 }, 1 << 30)).fields.limit).toBe(5n);
    expect(decodeBody(raw, lim, 0).spine.length).toBe(11);
  });
});

/** the parentHash item of a raw header (item 0) */
function consensusParent(raw: Uint8Array): Uint8Array {
  return raw.subarray(4, 36);
}

describe('the container header and the body', () => {
  const s = spineScenario();
  // header layout: "CFE1"(0..4) STR kind (4..26) chain u64 (26..34) level (34) number u64 (35..43) hash (43..75)
  it('judges kind, chain, level, block number and block hash, in that order', () => {
    const at = (i: number, v: number): Uint8Array => {
      const m = Uint8Array.from(s.evidence);
      m[i] = v;
      return m;
    };
    expect(canon(() => verify(s, at(25, 0x32)))).toBe('{"code":"finality_evidence_unrecognised","fields":{"kind":"adiri/finalized/v2","version":""}}');
    expect(canon(() => verify(s, at(33, 0xe2)))).toBe('{"code":"evidence_pin_mismatch","fields":{"got":"2018","pin":"chain_id","want":"2017"}}');
    expect(canon(() => verify(s, at(34, 2)))).toBe('{"code":"finality_evidence_malformed","fields":{"got_len":"2","part":"header.level","reason":"level_not_finalized","want_len":"3"}}');
    expect(refuse(() => verify(s, at(34, 1))).fields.part).toBe('header.level');
    expect(canon(() => verify(s, at(42, 0xff)))).toContain('"field":"blockNumber"');
    expect(canon(() => verify(s, at(74, 0xff)))).toContain('"field":"blockHash"');
    // the order: a wrong kind is reported before a wrong chain
    const both = at(25, 0x32);
    both[33] = 0xe2;
    expect(refuse(() => verify(s, both)).code).toBe('finality_evidence_unrecognised');
  });
  it('judges the pins first: a missing section, a wrong chain_id pin', () => {
    expect(refuse(() => new AdiriVerifier().verify(null, s.leg, s.evidence)).code).toBe('finality_pin_unknown');
    const wrong = pinsOfSection(pinsSection({ genesisCommittee: K5, epoch0Number: 1003n, epoch0Hash: hashOf(s.body.spine[0]!), chainId: 2018 }));
    expect(canon(() => new AdiriVerifier().verify(wrong, s.leg, s.evidence))).toBe('{"code":"evidence_pin_mismatch","fields":{"got":"2018","pin":"chain_id","want":"2017"}}');
    expect(parsePins(s.pins).chainId).toBe(2017n);
  });
  it('the body is strict: empty spine, unknown link kinds, nodes out of order, a trailing byte', () => {
    expect(canon(() => verify(s, buildContainer(s.leg, { ...s.body, spine: [] })))).toBe('{"code":"finality_evidence_malformed","fields":{"got_len":"0","part":"spine","reason":"spine_empty","want_len":"1"}}');
    const raw = encodeBody(s.body);
    const kind = (k: number): Uint8Array => {
      const m = Uint8Array.from(raw);
      m[4 + s.body.cfa1.length] = k;
      return m;
    };
    const lim = defaultLimits();
    expect(canon(() => decodeBody(kind(0), lim, 64))).toBe('{"code":"finality_evidence_malformed","fields":{"got_len":"0","part":"linkKind","reason":"link_kind_unknown","want_len":"1"}}');
    expect(refuse(() => decodeBody(kind(3), lim, 64)).fields.got_len).toBe(3n);
    expect(canon(() => decodeBody(new Uint8Array([...raw, 0]), lim, 64))).toBe('{"code":"finality_evidence_malformed","fields":{"got_len":"1","part":"body","reason":"trailing_bytes","want_len":"0"}}');
    expect(refuse(() => decodeBody(raw.subarray(0, 3), lim, 64)).fields.part).toBe('cfa1.len');
    const sl = slotScenario();
    const slot = encodeBody(sl.body);
    expect(decodeBody(slot, lim, 64).nodes.length).toBe(sl.body.nodes.length);
    const swapped = encodeBody({ ...sl.body, nodes: sl.body.nodes });
    expect(decodeBody(swapped, lim, 64).finalHeader.length).toBe(sl.finalHeader.length);
  });
  it('consensusRootOf reads item 19 or the zero hash', () => {
    expect(hex(consensusRootOf(s.body.spine[0]!))).toBe(hex(CR));
    expect(hex(consensusRootOf(makeHeader({ number: 5n })))).toBe(hex(new Uint8Array(32)));
    expect(hex(consensusRootOf(Uint8Array.of(1)))).toBe(hex(new Uint8Array(32)));
    expect(numberOf(s.body.spine[0]!)).toBe(1003n);
  });
});

describe('an EIP-2935 slot link (linkKind 2)', () => {
  it('finalizes a leg 3 blocks below the seal from the history contract slot N mod 8191', () => {
    const s = slotScenario();
    const v = verify(s);
    expect(v.fields.link_kind).toBe(2n);
    expect(v.fields.distance).toBe(3n);
    expect(v.fields.consensus_root_matches).toBe(true);
    expect(hex(v.fields.final_hash as Uint8Array)).toBe(hex(hashOf(s.finalHeader)));
    // the slot wraps: block 8191 + 5 lives in slot 5
    const w = slotScenario({ F: 8200n, L: 8196n });
    expect(verify(w).fields.distance).toBe(4n);
    const consensus = slotScenario({ fcHash: filled(32, 2) });
    expect(verify(consensus).fields.consensus_root_matches).toBe(false);
  });
  it('a leg that is the seal cannot use linkKind 2; a leg above it is block_after_seal first', () => {
    const s = slotScenario();
    const atSeal = { ...s.leg, number: 10003n };
    expect(canon(() => verify(s, buildContainer(atSeal, s.body), atSeal))).toBe('{"code":"finality_evidence_malformed","fields":{"got_len":"2","part":"linkKind","reason":"link_kind_2_at_seal","want_len":"1"}}');
    const above = { ...s.leg, number: 10004n };
    expect(refuse(() => verify(s, buildContainer(above, s.body), above)).fields.check).toBe('block_after_seal');
  });
  it('the final header must decode and be the seal', () => {
    const s = slotScenario();
    const bad = { ...s.body, finalHeader: Uint8Array.of(1, 2, 3) };
    expect(canon(() => verify(s, buildContainer(s.leg, bad)))).toBe('{"code":"finality_link_broken","fields":{"at":"10003","check":"header_decode","from":"10003","to":"10000"}}');
    const other = { ...s.body, finalHeader: makeHeader({ number: 10003n, stateRoot: filled(32, 1), consensusRoot: CR }) };
    const e = refuse(() => verify(s, buildContainer(s.leg, other)));
    expect(e.fields.check).toBe('tip_not_final_state');
    expect(e.fields.at).toBe(10003n);
    const num = { ...s.body, finalHeader: makeHeader({ number: 10002n, consensusRoot: CR }) };
    expect(refuse(() => verify(s, buildContainer(s.leg, num))).fields.at).toBe(10002n);
  });
  it('the account and storage proofs must verify under the seal state root', () => {
    const s = slotScenario();
    expect(canon(() => verify(s, buildContainer(s.leg, { ...s.body, nodes: [] })))).toBe('{"code":"finality_link_broken","fields":{"at":"10000","check":"proof_invalid","from":"10003","to":"10000"}}');
    const broken = s.body.nodes.map((n, i) => (i === 0 ? Uint8Array.from(n, (b, j) => (j === 3 ? b ^ 1 : b)) : n));
    expect(refuse(() => verify(s, buildContainer(s.leg, { ...s.body, nodes: broken }))).fields.check).toBe('proof_invalid');
  });
  it('the contract must be the pinned one, and the slot must hold the leg hash', () => {
    const wrongCode = slotScenario({ codeHash: filled(32, 0x11) });
    const e = refuse(() => verify(wrongCode));
    expect(e.fields.check).toBe('account_codehash_mismatch');
    expect(hex(e.fields.got as Uint8Array)).toBe(hex(filled(32, 0x11)));
    expect(hex(e.fields.want as Uint8Array)).toBe('6e49e66782037c0555897870e29fa5e552daf4719552131a0abce779daec0a5d');
    const wrongValue = slotScenario({ value: filled(32, 0xab) });
    const v = refuse(() => verify(wrongValue));
    expect(v.fields.check).toBe('slot_value_mismatch');
    expect(hex(v.fields.got as Uint8Array)).toBe(hex(filled(32, 0xab)));
    expect(hex(v.fields.want as Uint8Array)).toBe(hex(filled(32, 0x7a)));
    // the value is compared as 32 bytes: a value with leading zero bytes still matches itself
    const lead = new Uint8Array(32);
    lead[31] = 9;
    const s = slotScenario({ value: lead });
    const leg = { ...s.leg, hash: lead };
    expect(new AdiriVerifier().verify(s.pins, leg, buildContainer(leg, s.body)).level).toBe(3);
  });
});

const MAX = (1n << 64n) - 1n;
const sealed = (number: bigint, hash: Uint8Array): ChainResult => ({
  epoch: 0,
  digests: [],
  shrunk: [],
  signers: 5,
  committeeSize: 5,
  final: { number, hash },
  finalConsensus: { number, hash: new Uint8Array(32) },
});
const refuseSpine = (res: ChainResult, spine: Uint8Array[], leg: BlockRef): FinalityStateError => refuse(() => verifySpine(res, spine, leg));

describe('the spine step never wraps at 64 bits', () => {
  it('a header numbered 2^64-1 after one numbered 0 is a gap, not a consecutive pair', () => {
    const h1 = makeHeader({ number: MAX });
    const h0 = makeHeader({ number: 0n, parentHash: hashOf(h1) });
    const e = refuseSpine(sealed(0n, hashOf(h0)), [h0, h1], { chain: 2017n, number: MAX, hash: hashOf(h1) });
    expect(e.canonical()).toBe(
      `{"code":"finality_header_chain_broken","fields":{"at_number":"0","got_hash":"0x${hex(hashOf(h1))}","reason":"number_gap","spine":"adiri","want_hash":"0x${hex(hashOf(h1))}"}}`,
    );
  });
  it('the same through the kind: the leg is below the seal, the spine runs through number 0 to 2^64-1', () => {
    const h2 = makeHeader({ number: MAX });
    const h1 = makeHeader({ number: 0n, parentHash: hashOf(h2) });
    const h0 = makeHeader({ number: 1n, parentHash: hashOf(h1), consensusRoot: CR });
    const chain = buildChain([{ committee: K5, next: K5, fsNumber: 1n, fsHash: hashOf(h0), fcHash: CR }]);
    const pins = pinsOfSection(pinsSection({ genesisCommittee: K5, epoch0Number: 1n, epoch0Hash: hashOf(h0) }));
    const leg = { chain: 2017n, number: 0n, hash: hashOf(h1), headerRlp: h1 };
    const body: Body = { cfa1: chain.bytes, linkKind: 1, spine: [h0, h1, h2], finalHeader: new Uint8Array(0), nodes: [] };
    const e = refuse(() => new AdiriVerifier().verify(pins, leg, buildContainer(leg, body)));
    expect(e.code).toBe('finality_header_chain_broken');
    expect(e.fields.reason).toBe('number_gap');
    expect(e.fields.at_number).toBe(0n);
    expect(hex(e.fields.got_hash as Uint8Array)).toBe(hex(hashOf(h2)));
  });
  it('a header numbered above the tip is not a descending chain, and the parent link is judged first', () => {
    const g1 = makeHeader({ number: 1n });
    const g0 = makeHeader({ number: 0n, parentHash: hashOf(g1) });
    const leg = { chain: 2017n, number: 1n, hash: hashOf(g1) };
    expect(refuseSpine(sealed(0n, hashOf(g0)), [g0, g1], leg).fields.reason).toBe('number_gap');
    // a wrong parent hash at number 0 labels at_number 0
    const wrong = makeHeader({ number: 0n, parentHash: filled(32, 0x44) });
    const e = refuseSpine(sealed(0n, hashOf(wrong)), [wrong, g1], leg);
    expect(e.fields.reason).toBe('parent_hash_mismatch');
    expect(e.fields.at_number).toBe(0n);
    // a consecutive descending pair is accepted
    const c1 = makeHeader({ number: 4n });
    const c0 = makeHeader({ number: 5n, parentHash: hashOf(c1) });
    const ok = verifySpine(sealed(5n, hashOf(c0)), [c0, c1], { chain: 2017n, number: 4n, hash: hashOf(c1) });
    // a header without item 19 reads as the zero root, which is what `sealed` certifies
    expect(ok.consensusRootMatches).toBe(true);
  });
  it('an unreadable header names a saturating block number at every depth', () => {
    const spine = makeSpine(10n, 4); // 10, 9, 8, 7
    const leg = { chain: 2017n, number: 7n, hash: hashOf(spine[3]!) };
    const at = (top: bigint, garbage: number, chain: Uint8Array[]): bigint => {
      const s = [...chain.slice(0, garbage), Uint8Array.of(1)];
      return refuseSpine(sealed(top, hashOf(chain[0]!)), s, leg).fields.at as bigint;
    };
    expect(at(10n, 3, spine)).toBe(7n);
    expect(at(10n, 1, spine)).toBe(9n);
    const top5 = makeSpine(5n, 6); // 5 .. 0
    expect(at(5n, 5, top5)).toBe(0n);
    const top3 = makeSpine(3n, 4);
    expect(at(3n, 3, top3)).toBe(0n);
    const big = [makeHeader({ number: MAX, parentHash: filled(32, 1) })];
    big.push(makeHeader({ number: MAX - 1n }));
    expect(refuseSpine(sealed(MAX, hashOf(big[0]!)), [big[0]!, Uint8Array.of(1)], leg).fields.at).toBe(MAX - 1n);
  });
  it('the sealed number must match the tip header, and the caller header bytes are compared', () => {
    const h0 = makeHeader({ number: 5n });
    const hash = hashOf(h0);
    const leg = { chain: 2017n, number: 5n, hash };
    expect(refuseSpine(sealed(6n, hash), [h0], leg).fields.check).toBe('tip_not_final_state');
    expect(verifySpine(sealed(5n, hash), [h0], leg).consensusRootMatches).toBe(true);
    expect(verifySpine(sealed(5n, hash), [h0], { ...leg, headerRlp: Uint8Array.from(h0) }).consensusRootMatches).toBe(true);
    const flipped = Uint8Array.from(h0);
    flipped[flipped.length - 1]! ^= 1;
    expect(refuseSpine(sealed(5n, hash), [h0], { ...leg, headerRlp: flipped }).fields.field).toBe('spineLastHeader');
  });
});
