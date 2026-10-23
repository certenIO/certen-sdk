/** The committee chain (V2_SPEC_S7 5.8 O1-O3) on synthetic chains: every structural rule at its boundary, in the order of judgement. */
import { describe, expect, it } from 'vitest';
import { FinalityStateError } from '../../../src/proof-v2/finality/state.js';
import { firstDuplicate, parsePins, quorum, sameSet, verifyCommitteeChain, type CFA1, type Mode } from '../../../src/proof-v2/finality/adiri/index.js';
import { assertRegistered } from './regcheck.js';
import { buildChain, filled, hex, pinsOfSection, pinsSection, pubKey, type RecSpec } from './synth.js';

const K = (n: number): number[] => Array.from({ length: n }, (_, i) => i);
const rec = (committee: number[], next: number[], fs: bigint, extra: Partial<RecSpec> = {}): RecSpec => ({ committee, next, fsNumber: fs, ...extra });

function setup(specs: RecSpec[], opts: { min?: number; codec?: string; genesis?: number[]; e0Number?: bigint; e0Hash?: Uint8Array } = {}) {
  const chain = buildChain(specs);
  const section = pinsSection({
    genesisCommittee: opts.genesis ?? specs[0]!.committee,
    epoch0Number: opts.e0Number ?? specs[0]!.fsNumber,
    epoch0Hash: opts.e0Hash ?? chain.cfa1.records[0]!.finalState.hash,
    // parsePins refuses a min_committee_size below Telcoin's floor of four (units_f1fix.test.ts pins that); the chain judges against ANY Params,
    // and these tests pin its arithmetic (quorum, the two-thirds shrink) at committee sizes below the floor, so the requested value is set after the parse
    minCommittee: Math.max(opts.min ?? 4, 4),
    codec: opts.codec,
  });
  return { chain, par: { ...parsePins(pinsOfSection(section)), minCommittee: BigInt(opts.min ?? 4) } };
}

function broken(f: () => unknown): string {
  try {
    f();
  } catch (e) {
    expect(e).toBeInstanceOf(FinalityStateError);
    assertRegistered(e as FinalityStateError);
    return (e as FinalityStateError).canonical();
  }
  throw new Error('expected a refusal');
}
const run = (par: ReturnType<typeof setup>['par'], c: CFA1, mode: Mode = 'batched') => verifyCommitteeChain(par, c, mode);
const refuse = (par: ReturnType<typeof setup>['par'], c: CFA1, mode: Mode = 'batched'): string => broken(() => run(par, c, mode));
const cb = (epoch: number, check: string, tail: string): string => `{"code":"committee_chain_broken","fields":{"check":"${check}","epoch":"${epoch}"${tail}}}`;

describe('helpers', () => {
  it('quorum is 2n/3 + 1', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 9, 10].map(quorum)).toEqual([1, 2, 3, 3, 4, 5, 5, 7, 7]);
  });
  it('sameSet ignores order and duplicates; firstDuplicate names the later copy', () => {
    const a = pubKey(0);
    const b = pubKey(1);
    expect(sameSet([a, b], [b, a])).toBe(true);
    expect(sameSet([a, a, b], [b, a])).toBe(true);
    expect(sameSet([a], [a, b])).toBe(false);
    expect(sameSet([a, b], [a, pubKey(2)])).toBe(false);
    expect(firstDuplicate([a, b, a])).toBe(2);
    expect(firstDuplicate([a, b])).toBe(-1);
    expect(firstDuplicate([])).toBe(-1);
  });
});

describe('a valid chain', () => {
  it('establishes the last record and reports it', () => {
    const { chain, par } = setup([rec(K(5), K(5), 100n), rec(K(5), K(5), 150n), rec(K(5), K(5), 220n, { signers: [0, 1, 2, 3] })]);
    for (const mode of ['batched', 'oneByOne'] as Mode[]) {
      const r = run(par, chain.cfa1, mode);
      expect(r.epoch).toBe(2);
      expect(r.committeeSize).toBe(5);
      expect(r.signers).toBe(4);
      expect(r.final.number).toBe(220n);
      expect(hex(r.final.hash)).toBe(hex(chain.cfa1.records[2]!.finalState.hash));
      expect(r.finalConsensus.number).toBe(220n);
      expect(hex(r.finalConsensus.hash)).toBe(hex(chain.cfa1.records[2]!.finalConsensus.hash));
      expect(r.shrunk).toEqual([]);
      expect(r.digests.length).toBe(3);
    }
  });

  it('a committee may be re-ordered between records: it is judged as a set', () => {
    const { chain, par } = setup([rec([0, 1, 2, 3, 4], [4, 3, 2, 1, 0], 100n), rec([4, 3, 2, 1, 0], [2, 0, 1, 3, 4], 150n), rec([2, 0, 1, 3, 4], [0, 1, 2, 3, 4], 200n)], { genesis: [4, 2, 0, 3, 1] });
    expect(run(par, chain.cfa1).epoch).toBe(2);
  });

  it('a one-record chain has no compatibility to judge', () => {
    const { chain, par } = setup([rec(K(4), K(4), 100n)]);
    const r = run(par, chain.cfa1);
    expect(r.epoch).toBe(0);
    expect(r.committeeSize).toBe(4);
  });
});

describe('the quorum', () => {
  it('needs strictly more than two thirds: 2n/3 + 1 signers, no fewer', () => {
    for (const [n, need] of [[1, 1], [3, 3], [4, 3], [5, 4], [6, 5], [7, 5]] as const) {
      const min = Math.min(n, 1);
      const enough = Array.from({ length: need }, (_, i) => i);
      const short = enough.slice(0, need - 1);
      const ok = setup([rec(K(n), K(n), 100n, { signers: enough })], { min });
      expect(run(ok.par, ok.chain.cfa1).signers, `n=${n}`).toBe(need);
      const bad = setup([rec(K(n), K(n), 100n, { signers: short })], { min });
      expect(refuse(bad.par, bad.chain.cfa1), `n=${n}`).toBe(`{"code":"committee_chain_broken","fields":{"check":"signers_below_quorum","epoch":"0","got":"${need - 1}","need":"${need}"}}`);
    }
  });
});

describe('record 0 against the pins (O1)', () => {
  it('the codec pin is judged first', () => {
    const { chain, par } = setup([rec(K(5), K(5), 100n)], { codec: 'telcoin-epoch-record/bcs-keccak/9', genesis: K(3) });
    expect(refuse(par, chain.cfa1)).toBe('{"code":"epoch_record_codec_unsupported","fields":{"epoch":"0","pinned":"telcoin-epoch-record/bcs-keccak/9","supported":"telcoin-epoch-record/bcs-blake3/1"}}');
  });
  it('a chain without records is refused', () => {
    const { chain, par } = setup([rec(K(5), K(5), 100n)]);
    expect(broken(() => verifyCommitteeChain(par, { tables: chain.cfa1.tables, records: [] }, 'batched'))).toContain('cfa1_no_records');
  });
  it('a duplicate key in committee(0) is named before the genesis set is compared', () => {
    const { chain, par } = setup([rec([0, 1, 1, 2, 3], K(5), 100n)], { genesis: K(5) });
    expect(refuse(par, chain.cfa1)).toBe(cb(0, 'committee_duplicate_key', ',"index":"2"'));
  });
  it('committee(0) must be the pinned genesis committee as a set (sizes in the refusal)', () => {
    const a = setup([rec(K(5), K(5), 100n)], { genesis: [0, 1, 2, 3, 9] });
    expect(refuse(a.par, a.chain.cfa1)).toBe('{"code":"evidence_pin_mismatch","fields":{"got":"5","pin":"genesis_committee","want":"5"}}');
    const b = setup([rec(K(5), K(5), 100n)], { genesis: K(4) });
    expect(refuse(b.par, b.chain.cfa1)).toBe('{"code":"evidence_pin_mismatch","fields":{"got":"5","pin":"genesis_committee","want":"4"}}');
    const c = setup([rec(K(4), K(4), 100n)], { genesis: K(6) });
    expect(refuse(c.par, c.chain.cfa1)).toContain('"got":"4"');
    expect(refuse(c.par, c.chain.cfa1)).toContain('"want":"6"');
  });
  it('record(0).final_state must be the pinned epoch0_final_state: number and hash', () => {
    const num = setup([rec(K(5), K(5), 100n)], { e0Number: 101n });
    const h0 = hex(num.chain.cfa1.records[0]!.finalState.hash);
    expect(refuse(num.par, num.chain.cfa1)).toBe(
      `{"code":"adiri_incarnation_mismatch","fields":{"expected_genesis":"0x${h0}","expected_number":"101","pin":"epoch0_final_state","served_genesis":"0x${h0}","served_number":"100"}}`,
    );
    const hash = setup([rec(K(5), K(5), 100n)], { e0Hash: filled(32, 0x42) });
    expect(refuse(hash.par, hash.chain.cfa1)).toContain('"expected_genesis":"0x4242');
  });
});

describe('every record, in order (O2)', () => {
  it('an invalid public key names its epoch and position, before duplicates are looked at', () => {
    const { chain, par } = setup([rec(K(5), K(5), 100n), rec(K(5), K(5), 150n), rec(K(5), K(5), 200n)]);
    const t = chain.cfa1.tables[chain.cfa1.records[2]!.committeeIdx]!;
    // the table is shared by all records: break key 3 in a private copy used by record 2 only
    const priv = t.map((k) => Uint8Array.from(k));
    priv[3]![95]! ^= 1;
    priv[4] = Uint8Array.from(priv[1]!); // and a duplicate at 4, which must not be reached
    const c: CFA1 = { tables: [...chain.cfa1.tables, priv], records: chain.cfa1.records.map((r, i) => (i === 2 ? { ...r, committeeIdx: chain.cfa1.tables.length } : r)) };
    expect(refuse(par, c)).toBe(cb(2, 'public_key_invalid', ',"index":"3"'));
  });
  it('a duplicate key after epoch 0 names the later copy', () => {
    const { chain, par } = setup([rec(K(5), K(5), 100n), rec(K(5), K(5), 150n)]);
    const dup = chain.cfa1.tables[0]!.map((k) => Uint8Array.from(k));
    dup[2] = Uint8Array.from(dup[0]!);
    const c: CFA1 = { tables: [...chain.cfa1.tables, dup], records: chain.cfa1.records.map((r, i) => (i === 1 ? { ...r, committeeIdx: chain.cfa1.tables.length } : r)) };
    expect(refuse(par, c)).toBe(cb(1, 'committee_duplicate_key', ',"index":"2"'));
  });

  const incompat = (epoch: number, reason: string, size: number, expected: number, min: number): string =>
    `{"code":"committee_chain_broken","fields":{"check":"committee_incompatible","epoch":"${epoch}","expected":"${expected}","min_committee_size":"${min}","reason":"${reason}","size":"${size}"}}`;

  it('a committee larger than the previous next_committee is refused', () => {
    const { chain, par } = setup([rec(K(4), K(4), 100n), rec(K(5), K(5), 150n)]);
    expect(refuse(par, chain.cfa1)).toBe(incompat(1, 'larger_than_expected', 5, 4, 4));
  });
  it('an equal-size committee must be the same set', () => {
    const { chain, par } = setup([rec(K(5), K(5), 100n), rec([0, 1, 2, 3, 9], K(5), 150n)]);
    expect(refuse(par, chain.cfa1)).toBe(incompat(1, 'set_mismatch', 5, 5, 4));
  });
  it('a smaller committee must be a subset', () => {
    const { chain, par } = setup([rec(K(5), K(5), 100n), rec([0, 1, 2, 9], K(4), 150n)]);
    expect(refuse(par, chain.cfa1)).toBe(incompat(1, 'not_subset', 4, 5, 4));
  });
  it('a shrink keeps at least two thirds of the expected committee (the boundary is inclusive)', () => {
    // expected 6, size 4: 3*4 = 12 = 2*6 -> allowed; expected 6, size 3: 9 < 12 -> refused (min lowered so only the ratio matters)
    const ok = setup([rec(K(6), K(6), 100n), rec(K(4), K(4), 150n)], { min: 3 });
    const r = run(ok.par, ok.chain.cfa1);
    expect(r.shrunk.map((s) => s.canonical())).toEqual(['{"code":"committee_shrunk","fields":{"epoch":"1","expected":"6","size":"4"}}']);
    const bad = setup([rec(K(6), K(6), 100n), rec(K(3), K(3), 150n)], { min: 3 });
    expect(refuse(bad.par, bad.chain.cfa1)).toBe(incompat(1, 'below_two_thirds', 3, 6, 3));
    const seven = setup([rec(K(7), K(7), 100n), rec(K(4), K(4), 150n)], { min: 3 });
    expect(refuse(seven.par, seven.chain.cfa1)).toBe(incompat(1, 'below_two_thirds', 4, 7, 3));
    const five = setup([rec(K(5), K(5), 100n), rec(K(4), K(4), 150n)], { min: 3 });
    expect(run(five.par, five.chain.cfa1).shrunk.length).toBe(1);
  });
  it('a shrink may not go below min_committee_size, and the minimum itself is allowed', () => {
    const bad = setup([rec(K(5), K(5), 100n), rec(K(4), K(4), 150n)], { min: 5 });
    // genesis size 5 meets min 5; the shrink to 4 does not
    expect(refuse(bad.par, bad.chain.cfa1)).toBe(incompat(1, 'below_min_committee_size', 4, 5, 5));
    const ok = setup([rec(K(5), K(5), 100n), rec(K(4), K(4), 150n)], { min: 4 });
    expect(run(ok.par, ok.chain.cfa1).committeeSize).toBe(4);
  });
  it('the genesis committee itself must reach min_committee_size', () => {
    const { chain, par } = setup([rec(K(5), K(5), 100n)], { min: 6 });
    expect(refuse(par, chain.cfa1)).toBe(incompat(0, 'below_min_committee_size', 5, 5, 6));
  });
  it('cumulative shrinks are each reported, in ascending epoch order', () => {
    const { chain, par } = setup([rec(K(7), K(7), 100n), rec(K(6), K(6), 150n), rec(K(5), K(5), 200n)], { min: 4 });
    const r = run(par, chain.cfa1);
    expect(r.shrunk.map((s) => s.canonical())).toEqual([
      '{"code":"committee_shrunk","fields":{"epoch":"1","expected":"7","size":"6"}}',
      '{"code":"committee_shrunk","fields":{"epoch":"2","expected":"6","size":"5"}}',
    ]);
    expect(r.committeeSize).toBe(5);
  });
  it('the checks run in order: key, duplicate, compatibility, minimum size, quorum', () => {
    // epoch 1 is both a set mismatch and under-signed: the compatibility refusal comes first
    const a = setup([rec(K(5), K(5), 100n), rec([0, 1, 2, 3, 9], K(5), 150n, { signers: [0] })]);
    expect(refuse(a.par, a.chain.cfa1)).toContain('set_mismatch');
    // epoch 0 is under-signed but epoch 1 is incompatible: the first record's quorum is reached first
    const b = setup([rec(K(5), K(5), 100n, { signers: [0] }), rec([0, 1, 2, 3, 9], K(5), 150n)]);
    expect(refuse(b.par, b.chain.cfa1)).toContain('signers_below_quorum');
    // below_min precedes the quorum for the same record
    const c = setup([rec(K(5), K(5), 100n), rec(K(4), K(4), 150n, { signers: [0] })], { min: 5 });
    expect(refuse(c.par, c.chain.cfa1)).toContain('below_min_committee_size');
  });
});

describe('every signature (O3)', () => {
  it('names the lowest bad epoch and the reason, in both modes, after ALL structural checks', () => {
    const { chain, par } = setup([rec(K(5), K(5), 100n), rec(K(5), K(5), 150n, { signWrong: true }), rec(K(5), K(5), 200n), rec(K(5), K(5), 250n, { signWrong: true })]);
    for (const mode of ['batched', 'oneByOne'] as Mode[]) {
      expect(refuse(par, chain.cfa1, mode)).toBe('{"code":"committee_chain_broken","fields":{"check":"signature_invalid","epoch":"1","reason":"pairing"}}');
    }
    // a later structural flaw is reported although an earlier signature is bad
    const flawed = setup([rec(K(5), K(5), 100n, { signWrong: true }), rec(K(5), K(5), 150n), rec(K(5), K(5), 200n, { signers: [0] })]);
    for (const mode of ['batched', 'oneByOne'] as Mode[]) expect(refuse(flawed.par, flawed.chain.cfa1, mode)).toContain('signers_below_quorum');
  });
  it('a signature by fewer keys than claimed, or by others, is refused at its epoch', () => {
    const { chain, par } = setup([rec(K(5), K(5), 100n), rec(K(5), K(5), 150n)]);
    const c: CFA1 = { ...chain.cfa1, records: chain.cfa1.records.map((r, i) => (i === 1 ? { ...r, signers: Uint8Array.of(0, 1, 2, 3) } : r)) };
    expect(refuse(par, c)).toContain('"epoch":"1"');
    const d: CFA1 = { ...chain.cfa1, records: chain.cfa1.records.map((r, i) => (i === 0 ? { ...r, signature: chain.cfa1.records[1]!.signature } : r)) };
    expect(refuse(par, d)).toContain('"epoch":"0"');
  });
});
