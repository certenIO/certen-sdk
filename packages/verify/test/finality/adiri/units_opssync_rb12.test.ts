/**
 * RB12-TS-OPSSYNC item 3: the TS twins of Go's record_digests_index_rb12_test.go and spine_empty_rb12_internal_test.go (RB12-OPS-A1 item 8,
 * BETA finding B-ADIRI-1) with the same inputs and the same expected states.
 *
 * Go's RecordDigests, which is exported and digests any CFA1, indexed the committee tables with the record's table indices unchecked and
 * panicked; it now refuses with finality_evidence_malformed{part: cfa1.record, reason: cfa1_table_index_out_of_range, index: i, got_len: the
 * larger of the two indices, want_len: the number of tables} (no new code), and verifySpine, which indexes the last header of the spine it is
 * given, states finality_evidence_malformed{part: spine, reason: spine_empty, got_len: 0, want_len: 1} itself on an empty spine.
 */
import { describe, expect, it } from 'vitest';
import { defaultLimits } from '../../../src/proof-v2/finality/codec.js';
import { decodeCFA1, encodeCFA1, KeyBytes, type CFA1, type EpochRec } from '../../../src/proof-v2/finality/adiri/cfa1.js';
import { verifyCommitteeChain } from '../../../src/proof-v2/finality/adiri/chain.js';
import type { ChainResult } from '../../../src/proof-v2/finality/adiri/chain.js';
import { verifySpine } from '../../../src/proof-v2/finality/adiri/kind.js';
import { recordDigests, Codec, type Params } from '../../../src/proof-v2/finality/adiri/record.js';
import { FinalityStateError, hexLower, malformedAt } from '../../../src/proof-v2/finality/state.js';

function tableOf(n: number, salt: number): Uint8Array[] {
  const t: Uint8Array[] = [];
  for (let i = 0; i < n; i++) {
    const k = new Uint8Array(KeyBytes);
    k[0] = salt;
    k[1] = i;
    t.push(k);
  }
  return t;
}

function chainOf(nTables: number, nRecords: number): CFA1 {
  const cf: CFA1 = { tables: [], records: [] };
  for (let i = 0; i < nTables; i++) cf.tables.push(tableOf(4 + (i % 3), i));
  for (let i = 0; i < nRecords; i++) {
    const rec: EpochRec = {
      committeeIdx: i % nTables,
      nextIdx: (i + 1) % nTables,
      finalState: { number: BigInt(100 + i), hash: Uint8Array.from({ length: 32 }, (_, j) => (j === 0 ? i : j === 1 ? 1 : 0)) },
      finalConsensus: { number: BigInt(200 + i), hash: Uint8Array.from({ length: 32 }, (_, j) => (j === 0 ? i : j === 1 ? 2 : 0)) },
      signature: new Uint8Array(48),
      signers: Uint8Array.of(0, 1, 2),
    };
    cf.records.push(rec);
  }
  return cf;
}

interface Outcome {
  digests?: Uint8Array[];
  state?: FinalityStateError;
  /** anything that is not a named state: the TS counterpart of a Go panic or an unnamed error */
  unnamed?: unknown;
}
function digestsOf(cf: CFA1): Outcome {
  try {
    return { digests: recordDigests(cf) };
  } catch (e) {
    return e instanceof FinalityStateError ? { state: e } : { unnamed: e };
  }
}

/** wantIndexRefusal: finality_evidence_malformed{cfa1.record, cfa1_table_index_out_of_range, index = the record}. */
function wantIndexRefusal(what: string, record: number, got: number, want: number, o: Outcome): void {
  expect(o.unnamed, `${what}: an unnamed exception`).toBeUndefined();
  expect(o.digests, `${what}: digests returned beside a refusal`).toBeUndefined();
  expect(o.state, what).toBeDefined();
  // the exact state Go raises: MalformedAt("cfa1.record", i, ReasonCFA1TableIndexOutOfRange, max(committeeIdx, nextIdx), len(tables))
  expect(o.state!.canonical(), what).toBe(malformedAt('cfa1.record', record, 'cfa1_table_index_out_of_range', got, want).canonical());
  expect(o.state!.canonical(), what).toBe(
    `{"code":"finality_evidence_malformed","fields":{"got_len":"${got}","index":"${record}","part":"cfa1.record","reason":"cfa1_table_index_out_of_range","want_len":"${want}"}}`,
  );
}

describe('recordDigests refuses a table index outside the tables with the named state (record_digests_index_rb12_test.go)', () => {
  it('every shape of an out-of-range index, in either field or both, at the first, a middle and the last record of a chain', () => {
    let cases = 0;
    for (const nTables of [1, 2, 3, 200, 255]) {
      const bad: number[] = [];
      for (const v of [nTables, nTables + 1, 127, 128, 254, 255]) {
        // the uint8 wrap of a negative index is 255
        if (v >= nTables && v <= 255) bad.push(v);
      }
      const seen = new Set<number>();
      for (const idx of bad) {
        if (seen.has(idx)) continue;
        seen.add(idx);
        for (const at of [0, 1, 2]) {
          for (const field of ['committee', 'next', 'both']) {
            const cf = chainOf(nTables, 3);
            const r = cf.records[at]!;
            if (field !== 'next') r.committeeIdx = idx;
            if (field !== 'committee') r.nextIdx = idx;
            const name = `${nTables} tables, ${field} index ${idx} at record ${at}`;
            // got_len is the larger of the two indices of the failing record: for "committee" or "next" alone the other one is in range
            const got = Math.max(r.committeeIdx, r.nextIdx);
            wantIndexRefusal(name, at, got, nTables, digestsOf(cf));
            cases++;
          }
        }
      }
    }
    expect(cases, 'the Go differential reproduced 77 panics').toBeGreaterThanOrEqual(77);
  });

  it('the first failing record is the one named, and the index in range at its neighbours does not matter', () => {
    const cf = chainOf(3, 5);
    cf.records[3]!.nextIdx = 9;
    cf.records[4]!.committeeIdx = 200;
    wantIndexRefusal('two failing records', 3, 9, 3, digestsOf(cf));
    // both indices bad at one record: got_len is the larger
    cf.records[3]!.committeeIdx = 40;
    wantIndexRefusal('both bad', 3, 40, 3, digestsOf(cf));
  });

  it('an index that is not a table position at all (negative, fractional, NaN: a hand-built record only) is refused like one past the tables', () => {
    for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const cf = chainOf(2, 2);
      cf.records[1]!.nextIdx = bad;
      const o = digestsOf(cf);
      expect(o.unnamed, `${bad}`).toBeUndefined();
      expect(o.state?.fields.reason, `${bad}`).toBe('cfa1_table_index_out_of_range');
      expect(o.state?.fields.index, `${bad}`).toBe(1n);
    }
  });

  // mulberry32: the TS twin of the Go test's seeded math/rand (the stream differs, the distributions and the properties are the same)
  const rng = (seed: number) => (): number => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  it('random chains over the whole uint8 range: it never throws an unnamed exception, refuses exactly when some record names a missing table (naming the FIRST), and answers one digest per record otherwise; verifyCommitteeChain names its errors too', () => {
    const rand = rng(20261023);
    const intn = (n: number): number => Math.floor(rand() * n);
    let refused = 0;
    let answered = 0;
    for (let n = 0; n < 3000; n++) {
      let nTables = 1 + intn(5);
      if (intn(20) === 0) nTables = 1 + intn(255);
      const cf = chainOf(nTables, 1 + intn(6));
      let first = -1;
      cf.records.forEach((r, i) => {
        if (intn(4) === 0) r.committeeIdx = intn(256);
        if (intn(4) === 0) r.nextIdx = intn(256);
        if (first < 0 && (r.committeeIdx >= nTables || r.nextIdx >= nTables)) first = i;
      });
      const o = digestsOf(cf);
      expect(o.unnamed, `chain ${n} (${nTables} tables)`).toBeUndefined();
      if (first >= 0) {
        const r = cf.records[first]!;
        wantIndexRefusal(`chain ${n} (${nTables} tables)`, first, Math.max(r.committeeIdx, r.nextIdx), nTables, o);
        refused++;
      } else {
        expect(o.state, `chain ${n}`).toBeUndefined();
        expect(o.digests!.length, `chain ${n}`).toBe(cf.records.length);
        // each digest commits to its parent: no two records of this chain digest alike
        for (let i = 1; i < o.digests!.length; i++) expect(hexLower(o.digests![i]!)).not.toBe(hexLower(o.digests![i - 1]!));
        answered++;
      }
      const par: Params = {
        chainId: 2017n,
        codec: Codec,
        genesisHash: new Uint8Array(32),
        genesisCommittee: cf.tables[0]!,
        epoch0FinalState: { number: 0n, hash: new Uint8Array(32) },
        genesisLinkSha: '',
        minCommittee: 4n,
        maxHeaders: 16n,
        eip2935Address: new Uint8Array(20),
        finalConsensus: { number: 0n, hash: new Uint8Array(32) },
        signature: new Uint8Array(48),
        signers: new Uint8Array(0),
      };
      try {
        verifyCommitteeChain(par, cf, 'oneByOne');
      } catch (e) {
        if (!(e instanceof FinalityStateError)) throw new Error(`chain ${n}: an unnamed error: ${String(e)}`);
      }
    }
    expect(refused).toBeGreaterThanOrEqual(300);
    expect(answered).toBeGreaterThanOrEqual(300);
  });

  it('a valid chain digests without a refusal, and the digests are the same after encode and decode (no change for what already worked)', () => {
    const cf = chainOf(3, 5);
    const d = recordDigests(cf);
    expect(d.length).toBe(5);
    const back = decodeCFA1(encodeCFA1(cf), defaultLimits());
    const d2 = recordDigests(back);
    expect(d2.map(hexLower)).toEqual(d.map(hexLower));
  });
});

describe('verifySpine states spine_empty itself (spine_empty_rb12_internal_test.go TestVerifySpineRefusesAnEmptySpineWithTheNamedState)', () => {
  it('an empty spine, however it is spelled, is finality_evidence_malformed{spine, spine_empty, got 0, want 1}, never an unnamed exception', () => {
    for (const spine of [[], new Array<Uint8Array>(), [].slice()] as Uint8Array[][]) {
      let state: FinalityStateError | undefined;
      let unnamed: unknown;
      try {
        verifySpine({} as ChainResult, spine, { chain: 2017n, number: 7n, hash: new Uint8Array(32) });
      } catch (e) {
        if (e instanceof FinalityStateError) state = e;
        else unnamed = e;
      }
      expect(unnamed, 'an unnamed exception').toBeUndefined();
      expect(state?.canonical()).toBe('{"code":"finality_evidence_malformed","fields":{"got_len":"0","part":"spine","reason":"spine_empty","want_len":"1"}}');
    }
  });
});
