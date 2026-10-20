/** The report rules R1-R7 (the twin of pkg/finality report_test.go), judged with fake kinds registered into a fresh Registry. */
import { keccak_256 } from '@noble/hashes/sha3';
import { describe, expect, it } from 'vitest';
import { legBindingOf, newAddendum, ownHash, type Addendum } from '../../src/proof-v2/finality/addendum.js';
import type { BlockRef } from '../../src/proof-v2/finality/evidence.js';
import { Level } from '../../src/proof-v2/finality/level.js';
import { embeddedPins, PINS_SHA256 } from '../../src/proof-v2/finality/pins.js';
import { Registry, type Kind, type Verdict } from '../../src/proof-v2/finality/registry.js';
import { verifyLeg } from '../../src/proof-v2/finality/report.js';
import { FinalityStateError, lvl } from '../../src/proof-v2/finality/state.js';
import { ChainBaseSepolia, ChainSepolia } from '../../src/proof-v2/finality/table.js';
import { buildChain, containerFor, fill, kBaseFin, kBaseL1, rlpList, testBase, testProofId } from './helpers.js';

class FakeKind implements Kind {
  calls = 0;
  constructor(
    private readonly c: bigint,
    private readonly n: string,
    private readonly l: Level,
    private readonly err?: Error,
    private readonly got?: Level,
  ) {}
  name = (): string => this.n;
  chain = (): bigint => this.c;
  level = (): Level => this.l;
  verify(): Verdict {
    this.calls++;
    if (this.err) throw this.err;
    return { level: this.got ?? this.l, kind: this.n, fields: { ok: true } };
  }
}

function baseRegistry(l1Err?: Error, finErr?: Error): { r: Registry; l1: FakeKind; fin: FakeKind } {
  const r = new Registry();
  const l1 = new FakeKind(ChainBaseSepolia, kBaseL1, Level.L1Posted, l1Err);
  const fin = new FakeKind(ChainBaseSepolia, kBaseFin, Level.Finalized, finErr);
  r.registerKind(l1);
  r.registerKind(fin);
  return { r, l1, fin };
}

describe('registerKind', () => {
  it('refuses what is not a row of the table and a second kind for one name', () => {
    const r = new Registry();
    expect(() => r.registerKind(new FakeKind(ChainSepolia, kBaseL1, Level.L1Posted))).toThrow();
    expect(() => r.registerKind(new FakeKind(ChainBaseSepolia, 'base-sepolia/finalized/v2', Level.Finalized))).toThrow();
    const k = new FakeKind(ChainBaseSepolia, kBaseFin, Level.Finalized);
    r.registerKind(k);
    expect(() => r.registerKind(k)).toThrow();
  });
  it('holds the four chain profiles, ascending', () => {
    expect(new Registry().chains()).toEqual([2017n, 84532n, 421614n, 11155111n]);
    expect(() => new Registry().profile(1n)).toThrow(FinalityStateError);
  });
});

describe('R1 R2: levels are independent and the headline is the highest verified', () => {
  it('a refused l1_posted leaves finalized verified', () => {
    const b = testBase();
    const { r } = baseRegistry(new Error('blobs expired'));
    const rep = verifyLeg(r, b, b, buildChain(b, Level.Finalized, Level.L1Posted), null);
    expect(rep.headline).toBe(Level.Finalized);
    expect(rep.broken).toBeUndefined();
    expect(rep.levels.get(Level.Included)?.status).toBe('verified');
    expect(rep.levels.get(Level.Finalized)?.status).toBe('verified');
    const l1 = rep.levels.get(Level.L1Posted)!;
    expect(l1.status).toBe('refused');
    expect(l1.state?.code).toBe('finality_verifier_failed');
    expect(l1.state?.fields.cause).toBe('blobs expired');
  });
});

describe('R3: a broken chain voids all addenda', () => {
  it('headline included, every addendum level refused with the chain state, no kind ran', () => {
    const b = testBase();
    const { r, l1, fin } = baseRegistry();
    const adds = buildChain(b, Level.L1Posted, Level.Finalized);
    adds[0]!.ownHash[0]! ^= 1;
    const rep = verifyLeg(r, b, b, adds, null);
    expect(rep.headline).toBe(Level.Included);
    expect(rep.broken?.fields.check).toBe('own_hash');
    for (const l of [Level.L1Posted, Level.Finalized]) {
      expect(rep.levels.get(l)?.status).toBe('refused');
      expect(rep.levels.get(l)?.state?.code).toBe('finality_chain_broken');
    }
    expect(fin.calls + l1.calls).toBe(0);
  });
});

describe('R4 R5: an absent level is pending, not-applicable comes from the table', () => {
  it('Sepolia: l1_posted is not applicable, finalized is pending no_evidence_in_file', () => {
    const b: BlockRef = { chain: ChainSepolia, number: 10n, hash: fill(1) };
    const rep = verifyLeg(new Registry(), b, b, [], null);
    expect(rep.headline).toBe(Level.Included);
    const na = rep.levels.get(Level.L1Posted)!;
    expect(na.status).toBe('level_not_applicable');
    expect(na.state?.fields.reason).toBe('this chain is the L1');
    const p = rep.levels.get(Level.Finalized)!;
    expect(p.status).toBe('pending');
    expect(p.state?.code).toBe('finality_pending');
    expect(p.state?.fields.reason).toBe('no_evidence_in_file');
    expect(p.state?.canonical()).toBe('{"code":"finality_pending","fields":{"chain":"11155111","level_reached":"included","next_level":"finalized","reason":"no_evidence_in_file"}}');
  });
  it('Base: both levels are pending', () => {
    const b = testBase();
    const rep = verifyLeg(new Registry(), b, b, [], null);
    for (const l of [Level.L1Posted, Level.Finalized]) expect(rep.levels.get(l)?.status).toBe('pending');
  });
  it('a chain that is not a table row has no S7 statement at all', () => {
    const b: BlockRef = { chain: 1n, number: 10n, hash: fill(1) };
    const rep = verifyLeg(new Registry(), b, b, [], null);
    expect(rep.unsupported?.code).toBe('finality_chain_unsupported');
    expect(rep.levels.size).toBe(0);
    expect(rep.headline).toBe(Level.None);
  });
});

describe('the carried leg and unrecognised kinds', () => {
  it('compares the carried leg first and judges nothing else on a mismatch', () => {
    const b = testBase();
    const { r, l1, fin } = baseRegistry();
    const carried = { ...b, hash: Uint8Array.from(b.hash) };
    carried.hash[0]! ^= 1;
    const rep = verifyLeg(r, b, carried, buildChain(b, Level.L1Posted, Level.Finalized), null);
    expect(rep.broken?.fields.check).toBe('leg_binding');
    expect(rep.broken?.fields.seq).toBe(0n);
    expect(rep.headline).toBe(Level.Included);
    expect(l1.calls + fin.calls).toBe(0);
  });
  it('a kind nobody registered is unrecognised, not a weaker level', () => {
    const b = testBase();
    const rep = verifyLeg(new Registry(), b, b, buildChain(b, Level.Finalized), null);
    const st = rep.levels.get(Level.Finalized)!;
    expect(st.status).toBe('refused');
    expect(st.state?.canonical()).toBe('{"code":"finality_evidence_unrecognised","fields":{"kind":"base-sepolia/finalized/v1","version":"v1"}}');
    expect(rep.headline).toBe(Level.Included);
  });
  it('a kind cannot prove another level than its row', () => {
    const b = testBase();
    const r = new Registry();
    r.registerKind(new FakeKind(ChainBaseSepolia, kBaseL1, Level.L1Posted, undefined, Level.Finalized));
    const rep = verifyLeg(r, b, b, buildChain(b, Level.L1Posted), null);
    const st = rep.levels.get(Level.L1Posted)!;
    expect(st.status).toBe('refused');
    expect(st.state?.code).toBe('finality_verifier_failed');
    expect(st.state?.fields.cause).toBe('the kind returned level finalized for a l1_posted row');
    expect(rep.headline).toBe(Level.Included);
  });
  it('a named state thrown by a kind is reported as it is', () => {
    const b = testBase();
    const named = new FinalityStateError('finality_signature_invalid', { index: 1n });
    const { r } = baseRegistry(undefined, named);
    const rep = verifyLeg(r, b, b, buildChain(b, Level.Finalized), null);
    expect(rep.levels.get(Level.Finalized)?.state).toBe(named);
  });
});

describe('evidence about another block is refused for that level only', () => {
  it('block_mismatch on finalized leaves l1_posted verified; a header whose kind differs is malformed', () => {
    const b = testBase();
    const { r } = baseRegistry();
    const other = { ...b, number: b.number + 1n };
    const good = buildChain(b, Level.L1Posted);
    const a = newAddendum(legBindingOf(b), testProofId, good, b.chain, Level.Finalized, kBaseFin, containerFor(kBaseFin, other, Level.Finalized, 'x'));
    const rep = verifyLeg(r, b, b, [...good, a], null);
    const st = rep.levels.get(Level.Finalized)!;
    expect(st.status).toBe('refused');
    expect(st.state?.code).toBe('finality_block_mismatch');
    expect(st.state?.fields.field).toBe('blockNumber');
    expect(rep.levels.get(Level.L1Posted)?.status).toBe('verified');
    expect(rep.headline).toBe(Level.L1Posted);
    const bad: Addendum = { ...good[0]!, evidence: containerFor(kBaseFin, b, Level.L1Posted, 'x') };
    bad.ownHash = ownHash(legBindingOf(b), bad);
    const st2 = verifyLeg(r, b, b, [bad], null).levels.get(Level.L1Posted)!;
    expect(st2.status).toBe('refused');
    expect(st2.state?.code).toBe('finality_evidence_malformed');
    expect(st2.state?.fields.part).toBe('header.kind');
  });
});

describe('R6: finalized exposes the leg\'s own block for S8', () => {
  const items: Uint8Array[] = [];
  for (let i = 0; i < 17; i++) {
    if ([0, 3, 4, 5, 16].includes(i)) items.push(fill(0x40 + i));
    else if (i === 8) items.push(Uint8Array.of(0x2a));
    else if (i === 11) items.push(Uint8Array.of(1, 2));
    else items.push(Uint8Array.of(i));
  }
  const raw = rlpList(items);
  const b: BlockRef = { chain: ChainBaseSepolia, number: 0x2an, hash: keccak_256(raw), headerRlp: raw };
  it('carries number, hash and the state root of the header', () => {
    const { r } = baseRegistry();
    const rep = verifyLeg(r, b, b, buildChain(b, Level.Finalized), null);
    expect(rep.finalizedBlock?.number).toBe(0x2an);
    expect(Buffer.from(rep.finalizedBlock!.hash).equals(Buffer.from(b.hash))).toBe(true);
    expect(Buffer.from(rep.finalizedBlock!.stateRoot).equals(Buffer.from(fill(0x43)))).toBe(true);
    expect(verifyLeg(r, b, b, buildChain(b, Level.L1Posted), null).finalizedBlock).toBeUndefined();
  });
  it('is a named state, never silently omitted, when the header is absent or unreadable', () => {
    const { r } = baseRegistry();
    const noHeader: BlockRef = { chain: b.chain, number: b.number, hash: b.hash };
    const rep = verifyLeg(r, noHeader, noHeader, buildChain(noHeader, Level.Finalized), null);
    expect(rep.finalizedBlock).toBeUndefined();
    expect(rep.finalizedBlockState?.canonical()).toBe(
      '{"code":"finality_finalized_block_unavailable","fields":{"chain":"84532","number":"42","reason":"no_header"}}',
    );
    const items2 = items.slice();
    items2[3] = rlpList([Uint8Array.of(1)]); // a list in the stateRoot slot
    const broken = rlpList(items2);
    const bb: BlockRef = { chain: b.chain, number: b.number, hash: keccak_256(broken), headerRlp: broken };
    const rep2 = verifyLeg(r, bb, bb, buildChain(bb, Level.Finalized), null);
    expect(rep2.finalizedBlockState?.canonical()).toBe(
      '{"code":"finality_finalized_block_unavailable","fields":{"chain":"84532","index":"3","number":"42","reason":"header_unreadable"}}',
    );
  });
});

describe('the report names the pins it judged against', () => {
  it('null pins are ("", "none") and the embedded pins report their hash', () => {
    const b = testBase();
    const r = new Registry();
    const none = verifyLeg(r, b, b, [], null);
    expect([none.pinsSha256, none.pinsSource]).toEqual(['', 'none']);
    const rep = verifyLeg(r, b, b, [], embeddedPins());
    expect([rep.pinsSha256, rep.pinsSource]).toEqual([PINS_SHA256, 'embedded']);
  });
  it('lvl() renders by name', () => expect(lvl(Level.L1Posted).level).toBe(2));
});
