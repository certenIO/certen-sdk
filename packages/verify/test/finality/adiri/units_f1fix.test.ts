/**
 * RB12-TS-TWINS-2: the TypeScript twin of the Go RB11-F1-FIX unit tests that no vector can express (f1fix_core_test.go, f1fix_pins_test.go,
 * the linkKind 2 rules of 690ceb6) plus the boundaries around them. F1a table and signer indices judged inside verifyCommitteeChain, F1b the
 * default signature mode is batched, F1c the min_committee_size floor of four, F1d the linkKind 2 leg binding, F1e recordDigests names an
 * out-of-range table index, D4 the pinned genesis committee words are in the genesis ConsensusRegistry storage.
 * Test keys are the deterministic keys of synth.ts (public test fixtures; no real key material).
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { FinalityStateError } from '../../../src/proof-v2/finality/state.js';
import type { BlockRef } from '../../../src/proof-v2/finality/evidence.js';
import {
  AdiriVerifier,
  Codec,
  MinCommitteeFloor,
  MaxSlotDistance,
  buildContainer,
  checkRecordSigners,
  checkRecordTables,
  firstFailure,
  parsePins,
  recordDigests,
  signedMessage,
  verifyCommitteeChain,
  type Body,
  type CFA1,
  type Mode,
  type Params,
  type Rand,
} from '../../../src/proof-v2/finality/adiri/index.js';
import { assertRegistered } from './regcheck.js';
import { embeddedAdiriPins, evidenceOf, legOf, pinsOf, sha256Hex, vectors } from './vectorset.js';
import { EIP2935_ADDRESS, EIP2935_CODEHASH, aggregateSign, buildChain, eip2935State, filled, hashOf, hex, makeHeader, pinsOfSection, pinsSection, pubKey } from './synth.js';

const here = dirname(fileURLToPath(import.meta.url));

function refusal(f: () => unknown): FinalityStateError {
  try {
    f();
  } catch (e) {
    expect(e, `a thrown ${String(e)}`).toBeInstanceOf(FinalityStateError);
    assertRegistered(e as FinalityStateError);
    return e as FinalityStateError;
  }
  throw new Error('expected a refusal');
}
const canon = (f: () => unknown): string => refusal(f).canonical();

// ---- F1a: VerifyCommitteeChain is exported and judges any CFA1, not only one the decoder returned ----

const KEYS = [0, 1, 2, 3, 4].map(pubKey);

/**
 * The Go f1Fix.chain: a one-record chain over ONE table of the five keys, signed by the listed signer positions in the order given (a position
 * may repeat or exceed the table: the signature is then over the keys that exist, what an attacker who holds the keys can produce). The
 * indices are set after the digest is computed, because the digest indexes the tables.
 */
function handChain(committeeIdx: number, nextIdx: number, signers: number[]): { par: Params; cf: CFA1 } {
  const cf: CFA1 = {
    tables: [KEYS],
    records: [
      {
        committeeIdx: 0,
        nextIdx: 0,
        finalState: { number: 5n, hash: filled(32, 1) },
        finalConsensus: { number: 6n, hash: filled(32, 2) },
        signature: new Uint8Array(48),
        signers: Uint8Array.from(signers),
      },
    ],
  };
  const digest = recordDigests(cf)[0]!;
  cf.records[0]!.signature = aggregateSign(
    signers.map((s) => (s < 5 ? s : 0)),
    signedMessage(digest),
  );
  cf.records[0]!.committeeIdx = committeeIdx;
  cf.records[0]!.nextIdx = nextIdx;
  const par: Params = {
    chainId: 2017n,
    codec: Codec,
    genesisHash: filled(32, 1),
    genesisCommittee: KEYS,
    epoch0FinalState: cf.records[0]!.finalState,
    genesisLinkSha: '',
    minCommittee: 4n,
    maxHeaders: 16n,
    eip2935Address: EIP2935_ADDRESS,
    eip2935CodeHash: EIP2935_CODEHASH,
  };
  return { par, cf };
}

const MODES: Mode[] = ['oneByOne', 'batched'];

describe('F1a: verifyCommitteeChain re-applies the decoder rules to every record', () => {
  for (const mode of MODES) {
    it(`${mode}: a strictly increasing in-range signer list at quorum is judged (control)`, () => {
      const { par, cf } = handChain(0, 0, [0, 1, 2, 3]);
      const r = verifyCommitteeChain(par, cf, mode);
      expect(r.signers).toBe(4);
      expect(r.epoch).toBe(0);
    });

    for (const c of [
      { name: 'a repeated signer counted twice', signers: [0, 0, 1, 1], index: 1, signer: 0 },
      { name: 'descending signers', signers: [3, 2, 1, 0], index: 1, signer: 2 },
      { name: 'a signer index equal to the committee size', signers: [0, 1, 2, 5], index: 3, signer: 5 },
      { name: 'a signer index far outside the committee', signers: [0, 1, 2, 200], index: 3, signer: 200 },
    ]) {
      it(`${mode}: ${c.name} is committee_chain_broken{signer_index_invalid}, never a panic`, () => {
        const { par, cf } = handChain(0, 0, c.signers);
        expect(canon(() => verifyCommitteeChain(par, cf, mode))).toBe(
          `{"code":"committee_chain_broken","fields":{"check":"signer_index_invalid","committee_size":"5","epoch":"0","index":"${c.index}","signer":"${c.signer}"}}`,
        );
      });
    }

    for (const c of [
      { name: 'the committee index past the tables', committee: 1, next: 0, got: 1 },
      { name: 'the next index past the tables on the last record', committee: 0, next: 1, got: 1 },
      { name: 'both indices far past the tables', committee: 200, next: 7, got: 200 },
    ]) {
      it(`${mode}: ${c.name} is finality_evidence_malformed{table_index_out_of_range}, never a TypeError`, () => {
        const { par, cf } = handChain(c.committee, c.next, [0, 1, 2, 3]);
        expect(canon(() => verifyCommitteeChain(par, cf, mode))).toBe(
          `{"code":"finality_evidence_malformed","fields":{"got_len":"${c.got}","index":"0","part":"cfa1.record","reason":"cfa1_table_index_out_of_range","want_len":"1"}}`,
        );
      });
    }
  }

  it('the table rule runs before the signer rule, record by record (a bad table index on record 1 is judged before record 1 signers)', () => {
    const chain = buildChain([
      { committee: [0, 1, 2, 3, 4], next: [0, 1, 2, 3, 4], fsNumber: 10n },
      { committee: [0, 1, 2, 3, 4], next: [0, 1, 2, 3, 4], fsNumber: 20n },
    ]);
    const cf: CFA1 = { tables: chain.cfa1.tables, records: chain.cfa1.records.map((r) => ({ ...r })) };
    cf.records[1]!.committeeIdx = 9;
    cf.records[1]!.signers = Uint8Array.of(9, 0);
    const par = parsePins(pinsOfSection(pinsSection({ genesisCommittee: [0, 1, 2, 3, 4], epoch0Number: 10n, epoch0Hash: cf.records[0]!.finalState.hash })));
    expect(canon(() => verifyCommitteeChain(par, cf, 'batched'))).toBe(
      '{"code":"finality_evidence_malformed","fields":{"got_len":"9","index":"1","part":"cfa1.record","reason":"cfa1_table_index_out_of_range","want_len":"1"}}',
    );
  });

  it('a hand-built index that is not a table position at all (negative, fractional, NaN) is refused like an out-of-range one', () => {
    for (const bad of [-1, 1.5, Number.NaN]) {
      const { par, cf } = handChain(0, 0, [0, 1, 2, 3]);
      cf.records[0]!.committeeIdx = bad;
      const e = refusal(() => verifyCommitteeChain(par, cf, 'batched'));
      expect(e.code).toBe('finality_evidence_malformed');
      expect(e.fields.reason).toBe('cfa1_table_index_out_of_range');
    }
  });

  it('checkRecordTables / checkRecordSigners are the decoder rules: N-1 passes, N fails exactly', () => {
    const rec = (c: number, n: number) => ({ committeeIdx: c, nextIdx: n, finalState: { number: 0n, hash: filled(32, 0) }, finalConsensus: { number: 0n, hash: filled(32, 0) }, signature: new Uint8Array(48), signers: new Uint8Array(0) });
    expect(() => checkRecordTables(0, rec(2, 2), 3)).not.toThrow();
    expect(refusal(() => checkRecordTables(4, rec(3, 0), 3)).canonical()).toBe(
      '{"code":"finality_evidence_malformed","fields":{"got_len":"3","index":"4","part":"cfa1.record","reason":"cfa1_table_index_out_of_range","want_len":"3"}}',
    );
    expect(refusal(() => checkRecordTables(0, rec(0, 3), 3)).fields.got_len).toBe(3n);
    expect(() => checkRecordSigners(0, Uint8Array.of(0, 1, 254), 255)).not.toThrow();
    expect(refusal(() => checkRecordSigners(7, Uint8Array.of(0, 1, 255), 255)).canonical()).toBe(
      '{"code":"committee_chain_broken","fields":{"check":"signer_index_invalid","committee_size":"255","epoch":"7","index":"2","signer":"255"}}',
    );
    expect(() => checkRecordSigners(0, new Uint8Array(0), 1)).not.toThrow();
    expect(refusal(() => checkRecordSigners(0, Uint8Array.of(1, 1), 3)).fields.index).toBe(1n);
  });
});

// ---- F1e: recordDigests is exported and indexes the tables ----

describe('F1e: recordDigests names a table index outside the tables (Go record.go:83 indexes it unchecked)', () => {
  it('a hand-built CFA1 with a committee or next index past the tables is the named refusal, in both positions', () => {
    const { cf } = handChain(0, 0, [0, 1, 2, 3]);
    expect(recordDigests(cf).length).toBe(1);
    for (const [c, n, got] of [
      [1, 0, 1],
      [0, 1, 1],
      [255, 0, 255],
      [0, 255, 255],
    ] as const) {
      const bad: CFA1 = { tables: cf.tables, records: [{ ...cf.records[0]!, committeeIdx: c, nextIdx: n }] };
      expect(canon(() => recordDigests(bad))).toBe(
        `{"code":"finality_evidence_malformed","fields":{"got_len":"${got}","index":"0","part":"cfa1.record","reason":"cfa1_table_index_out_of_range","want_len":"1"}}`,
      );
    }
  });
  it('the record index named is the failing record, not the first', () => {
    const chain = buildChain([
      { committee: [0, 1, 2, 3], next: [0, 1, 2, 3], fsNumber: 10n },
      { committee: [0, 1, 2, 3], next: [0, 1, 2, 3], fsNumber: 20n },
      { committee: [0, 1, 2, 3], next: [0, 1, 2, 3], fsNumber: 30n },
    ]);
    const records = chain.cfa1.records.map((r, i) => (i === 2 ? { ...r, nextIdx: 2 } : r));
    expect(refusal(() => recordDigests({ tables: chain.cfa1.tables, records })).fields.index).toBe(2n);
  });
});

// ---- F1b: the default signature mode is batched ----

describe('F1b: an unset mode is the batched verifier (the production form)', () => {
  const syn = vectors().find((v) => v.name === 'syn-rotation')!;
  const evidence = evidenceOf(syn);
  const refuseRandom: Rand = () => {
    throw new Error('no randomness');
  };

  it('AdiriVerifier() has mode batched; an explicit oneByOne is kept', () => {
    expect(new AdiriVerifier().mode).toBe('batched');
    expect(new AdiriVerifier({}).mode).toBe('batched');
    expect(new AdiriVerifier({ mode: 'oneByOne' }).mode).toBe('oneByOne');
  });
  it('batched mode draws its scalars from rand and one-by-one never reads it', () => {
    const pins = pinsOf(syn);
    const leg = legOf(syn);
    expect(() => new AdiriVerifier({ mode: 'oneByOne', rand: refuseRandom }).verify(pins, leg, evidence)).not.toThrow();
    const e = refusal(() => new AdiriVerifier({ rand: refuseRandom }).verify(pins, leg, evidence));
    expect(e.code).toBe('finality_verifier_failed');
    expect(e.fields.kind).toBe('adiri/finalized/v1');
    expect(e.fields.cause).toBe('no randomness');
    expect(() => new AdiriVerifier().verify(pins, leg, evidence)).not.toThrow();
  });
  it('a caller that passes no mode at all (an untyped caller) gets the batched path at the signature layer and in the chain', () => {
    const { par, cf } = handChain(0, 0, [0, 1, 2, 3]);
    const noMode = undefined as unknown as Mode;
    const e1 = refusal(() => verifyCommitteeChain(par, cf, noMode, refuseRandom));
    expect(e1.code).toBe('finality_verifier_failed');
    let drawn = 0;
    const counting: Rand = (n) => {
      drawn++;
      return Uint8Array.from({ length: n }, (_, i) => (i * 37 + 11) & 0xff);
    };
    expect(verifyCommitteeChain(par, cf, noMode, counting).signers).toBe(4);
    expect(drawn).toBeGreaterThan(0);
    const itemless = firstFailure([], noMode, counting);
    expect(itemless).toBeUndefined();
  });
});

// ---- F1c: min_committee_size floor ----

describe('F1c: a min_committee_size pin below Telcoin shrink floor of four is refused', () => {
  const sectionOf = (): Record<string, any> => {
    const p = embeddedAdiriPins().sections.get('adiri') as { pairs: [string, unknown][] };
    const toJs = (v: any): any => (v && v.pairs ? Object.fromEntries(v.pairs.map(([k, x]: [string, unknown]) => [k, toJs(x)])) : v && v.lit !== undefined ? Number(v.lit) : Array.isArray(v) ? v.map(toJs) : v);
    return toJs(p);
  };
  const withMin = (n: number): Params => {
    const m = sectionOf();
    m.min_committee_size = n;
    return parsePins(pinsOfSection(m));
  };
  for (const n of [3, 2, 1, 0, -1]) {
    it(`min_committee_size ${n} is finality_pins_corrupt{bad_value, adiri.min_committee_size}`, () => {
      expect(canon(() => withMin(n))).toBe('{"code":"finality_pins_corrupt","fields":{"key":"adiri.min_committee_size","reason":"bad_value"}}');
    });
  }
  for (const n of [4, 5, 255]) {
    it(`min_committee_size ${n} is accepted and read back`, () => {
      expect(withMin(n).minCommittee).toBe(BigInt(n));
    });
  }
  it('MinCommitteeFloor is 4', () => {
    expect(MinCommitteeFloor).toBe(4);
  });
});

// ---- F1d: the linkKind 2 leg binding (the boundaries around the vectors) ----

const K5 = [0, 1, 2, 3, 4];
const CR = filled(32, 0x5c);
function slot(o: { F: bigint; N: bigint; legHash?: Uint8Array; slotValue?: Uint8Array; legHeader?: Uint8Array }) {
  const legHash = o.legHash ?? filled(32, 0x7a);
  const st = eip2935State(o.N, o.slotValue ?? legHash);
  const finalHeader = makeHeader({ number: o.F, stateRoot: st.stateRoot, consensusRoot: CR });
  const chain = buildChain([{ committee: K5, next: K5, fsNumber: o.F, fsHash: hashOf(finalHeader), fcHash: CR }]);
  const pins = pinsOfSection(pinsSection({ genesisCommittee: K5, epoch0Number: o.F, epoch0Hash: hashOf(finalHeader) }));
  const leg: BlockRef = { chain: 2017n, number: o.N, hash: legHash };
  if (o.legHeader !== undefined) leg.headerRlp = o.legHeader;
  const body: Body = { cfa1: chain.bytes, linkKind: 2, spine: [], finalHeader, nodes: st.nodes };
  return { pins, leg, evidence: buildContainer(leg, body) };
}
const slotCanon = (s: ReturnType<typeof slot>, mode: Mode = 'batched'): string => canon(() => new AdiriVerifier({ mode }).verify(s.pins, s.leg, s.evidence));

describe('F1d: linkKind 2 binds the leg to the EIP-2935 ring', () => {
  it('MaxSlotDistance is 8190, one block inside the ring of 8191', () => {
    expect(MaxSlotDistance).toBe(8190n);
  });
  for (const mode of MODES) {
    it(`${mode}: F-N = 8189 and 8190 are finalized, 8191 and 8192 are slotDistance{want 8190, got F-N}`, () => {
      for (const d of [8189n, 8190n]) {
        const s = slot({ F: 20000n, N: 20000n - d });
        expect(new AdiriVerifier({ mode }).verify(s.pins, s.leg, s.evidence).fields.distance).toBe(d);
      }
      for (const d of [8191n, 8192n]) {
        const s = slot({ F: 20000n, N: 20000n - d });
        expect(slotCanon(s, mode)).toBe(`{"code":"finality_block_mismatch","fields":{"field":"slotDistance","got":"${d}","want":"8190"}}`);
      }
    });
  }
  it('the alias of the ring is refused: block 9000 claimed as block 809 sits in the same slot but 11191 behind F=12000', () => {
    const s = slot({ F: 12000n, N: 809n, slotValue: filled(32, 0x7a) });
    expect(slotCanon(s)).toBe('{"code":"finality_block_mismatch","fields":{"field":"slotDistance","got":"11191","want":"8190"}}');
  });
  it('an all-zero leg hash is legHash{want nonzero} before the slot is read (a proven-absent slot reads as zero)', () => {
    const s = slot({ F: 20000n, N: 19990n, legHash: new Uint8Array(32), slotValue: new Uint8Array(32) });
    expect(slotCanon(s)).toBe(`{"code":"finality_block_mismatch","fields":{"field":"legHash","got":"0x${hex(new Uint8Array(32))}","want":"nonzero"}}`);
  });
  it('the distance is judged before the zero hash, and both before the leg header and the final header', () => {
    const s = slot({ F: 20000n, N: 20000n - 8191n, legHash: new Uint8Array(32), legHeader: Uint8Array.of(0xc0) });
    expect(slotCanon(s)).toBe('{"code":"finality_block_mismatch","fields":{"field":"slotDistance","got":"8191","want":"8190"}}');
    const z = slot({ F: 20000n, N: 19990n, legHash: new Uint8Array(32), legHeader: Uint8Array.of(0xc0) });
    expect(slotCanon(z)).toContain('"field":"legHash"');
  });
  it('a leg that carries its header: unreadable is header_decode at N; another hash is legHeaderHash; another number is legHeaderNumber', () => {
    const hdr = makeHeader({ number: 19990n, consensusRoot: CR });
    const ok = slot({ F: 20000n, N: 19990n, legHash: hashOf(hdr), legHeader: hdr });
    expect(new AdiriVerifier().verify(ok.pins, ok.leg, ok.evidence).fields.link_kind).toBe(2n);
    const undecodable = slot({ F: 20000n, N: 19990n, legHeader: Uint8Array.of(0xc0) });
    expect(slotCanon(undecodable)).toBe('{"code":"finality_link_broken","fields":{"at":"19990","check":"header_decode","from":"20000","to":"19990"}}');
    const wrongHash = slot({ F: 20000n, N: 19990n, legHash: filled(32, 0x7a), legHeader: hdr });
    expect(slotCanon(wrongHash)).toBe(`{"code":"finality_block_mismatch","fields":{"field":"legHeaderHash","got":"0x${hex(hashOf(hdr))}","want":"0x${hex(filled(32, 0x7a))}"}}`);
    const other = makeHeader({ number: 19991n, consensusRoot: CR });
    const wrongNumber = slot({ F: 20000n, N: 19990n, legHash: hashOf(other), legHeader: other });
    expect(slotCanon(wrongNumber)).toBe('{"code":"finality_block_mismatch","fields":{"field":"legHeaderNumber","got":"19991","want":"19990"}}');
  });
  it('a real leg hash over a proven-absent slot is slot_value_mismatch with a zero got (not legHash)', () => {
    const s = slot({ F: 20000n, N: 19990n, slotValue: new Uint8Array(32) });
    const e = refusal(() => new AdiriVerifier().verify(s.pins, s.leg, s.evidence));
    expect(e.code).toBe('finality_link_broken');
    expect(e.fields.check).toBe('slot_value_mismatch');
  });
});

// ---- D4: spec 4.4 / A7 step 2, the committee words are in the genesis ConsensusRegistry storage ----

const TN_GENESIS_SHA256 = '8b2b2c3b8a82178ca72b560c68bb5a512bc23f7afcf67dafa0dedfbddddf9bb6';
const CONSENSUS_REGISTRY = '07e17e17e17e17e17e17e17e17e17e17e17e17e1';

describe('D4: every pinned committee key word is in the genesis ConsensusRegistry storage', () => {
  it('tn_genesis.json (the node genesis, byte-identical to the validator copy) holds 115 registry slots and all 15 key words of the 5 pinned keys', () => {
    const raw = readFileSync(join(here, '..', '..', 'fixtures', 'finality', 'adiri_pins', 'tn_genesis.json'));
    expect(sha256Hex(raw)).toBe(TN_GENESIS_SHA256);
    const g = JSON.parse(raw.toString('utf8')) as { alloc: Record<string, { storage?: Record<string, string> }> };
    const words = new Set<string>();
    let slots = 0;
    for (const [addr, a] of Object.entries(g.alloc)) {
      if (addr.replace(/^0x/, '').toLowerCase() === CONSENSUS_REGISTRY) {
        for (const v of Object.values(a.storage ?? {})) words.add(v.replace(/^0x/, '').toLowerCase());
        slots += Object.keys(a.storage ?? {}).length;
      }
    }
    expect(slots).toBe(115);
    const par = parsePins(embeddedAdiriPins());
    expect(par.genesisCommittee.length).toBe(5);
    let found = 0;
    par.genesisCommittee.forEach((k, i) => {
      for (let w = 0; w < k.length / 32; w++) {
        const word = k.subarray(32 * w, 32 * w + 32);
        const flipped = Uint8Array.from(word);
        flipped[31]! ^= 1;
        expect(words.has(hex(flipped)), `key ${i} word ${w}: a word one bit away is also a storage value, the membership test proves nothing`).toBe(false);
        expect(words.has(hex(word)), `key ${i} word ${w} (${hex(word)}) is not a value in the genesis ConsensusRegistry storage`).toBe(true);
        found++;
      }
    });
    expect(found).toBe(15);
  });
});
