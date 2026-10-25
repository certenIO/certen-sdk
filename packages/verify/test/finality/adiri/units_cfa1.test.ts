/** CFA1: the strict decoder and the canonical encoder (V2_SPEC_S7 3.3), on the live chain and on hand-built chains. */
import { describe, expect, it } from 'vitest';
import { defaultLimits } from '../../../src/proof-v2/finality/codec.js';
import { FinalityStateError } from '../../../src/proof-v2/finality/state.js';
import { decodeCFA1, encodeCFA1, committeeOf, nextOf, type CFA1 } from '../../../src/proof-v2/finality/adiri/index.js';
import { assertRegistered } from './regcheck.js';
import { concat, filled } from './synth.js';
import { live } from './live.js';

const lim = defaultLimits();
const key = (n: number): Uint8Array => filled(96, n);

/** A tiny CFA1 (the decoder does not look at the points): `tables` tables of `size` keys, `records` records signed by `signers`. */
function tiny(opts: { tables?: number; size?: number; records?: number; signers?: number[] } = {}): CFA1 {
  const nTables = opts.tables ?? 2;
  const size = opts.size ?? 3;
  const tables = Array.from({ length: nTables }, (_, t) => Array.from({ length: size }, (_, k) => key(t * 16 + k + 1)));
  const records = Array.from({ length: opts.records ?? 2 }, (_, i) => ({
    committeeIdx: 0,
    nextIdx: nTables - 1,
    finalState: { number: BigInt(100 + i), hash: filled(32, i + 1) },
    finalConsensus: { number: BigInt(200 + i), hash: filled(32, i + 9) },
    signature: filled(48, 0xa0),
    signers: Uint8Array.from(opts.signers ?? [0, 1, 2]),
  }));
  return { tables, records };
}

function refusal(f: () => unknown): FinalityStateError {
  try {
    f();
  } catch (e) {
    expect(e).toBeInstanceOf(FinalityStateError);
    assertRegistered(e as FinalityStateError);
    return e as FinalityStateError;
  }
  throw new Error('expected a refusal');
}
const j = (e: FinalityStateError): string => e.canonical();

describe('CFA1 round trip', () => {
  it('encode(decode(x)) == x for the live chain', () => {
    const l = live();
    expect(Buffer.from(encodeCFA1(l.cfa1)).equals(Buffer.from(l.cfa1Bytes))).toBe(true);
    expect(l.cfa1.records.length).toBe(601);
    expect(l.cfa1.tables.length).toBeGreaterThanOrEqual(2);
    expect(committeeOf(l.cfa1, 0)).toBe(l.cfa1.tables[l.cfa1.records[0]!.committeeIdx]);
    expect(nextOf(l.cfa1, 0)).toBe(l.cfa1.tables[l.cfa1.records[0]!.nextIdx]);
  });

  it('committeeOf and nextOf are undefined out of range', () => {
    const c = tiny();
    expect(committeeOf(c, -1)).toBeUndefined();
    expect(committeeOf(c, 2)).toBeUndefined();
    expect(nextOf(c, -1)).toBeUndefined();
    expect(nextOf(c, 2)).toBeUndefined();
    expect(committeeOf(c, 1)).toBe(c.tables[0]);
    expect(nextOf(c, 1)).toBe(c.tables[1]);
    const bad = tiny();
    bad.records[0]!.committeeIdx = 9;
    bad.records[0]!.nextIdx = 9;
    expect(committeeOf(bad, 0)).toBeUndefined();
    expect(nextOf(bad, 0)).toBeUndefined();
  });

  it('decodes a hand-built chain field by field', () => {
    const c = tiny({ signers: [0, 2] });
    const d = decodeCFA1(encodeCFA1(c), lim);
    expect(d.tables.length).toBe(2);
    expect(d.records[1]!.finalState.number).toBe(101n);
    expect(d.records[1]!.finalConsensus.number).toBe(201n);
    expect(Array.from(d.records[1]!.signers)).toEqual([0, 2]);
    expect(d.records[0]!.committeeIdx).toBe(0);
    expect(d.records[0]!.nextIdx).toBe(1);
    expect(d.records[0]!.signature).toEqual(filled(48, 0xa0));
  });
});

describe('CFA1 refusals', () => {
  const good = (): Uint8Array => encodeCFA1(tiny());
  // header: CFA1(4) u16 n_tables(2) table0: u8 n + 3*96 ; table1 same ; u32 n_records
  const recOff = 6 + 2 * (1 + 3 * 96);

  it('bad magic', () => {
    const b = good();
    b[0] = 0x58;
    expect(j(refusal(() => decodeCFA1(b, lim)))).toBe('{"code":"finality_evidence_malformed","fields":{"got_len":"4","part":"cfa1.magic","reason":"cfa1_bad_magic","want_len":"4"}}');
  });
  it('truncated inside the magic, the table count and a key', () => {
    expect(refusal(() => decodeCFA1(good().subarray(0, 2), lim)).fields.part).toBe('cfa1.magic');
    expect(refusal(() => decodeCFA1(good().subarray(0, 5), lim)).fields.part).toBe('cfa1.n_tables');
    expect(refusal(() => decodeCFA1(good().subarray(0, 8), lim)).fields.part).toBe('cfa1.table.key');
  });
  it('zero tables, and the table bound is 64 (65 is too large)', () => {
    const b = good();
    b[4] = 0;
    b[5] = 0;
    expect(j(refusal(() => decodeCFA1(b, lim)))).toBe('{"code":"finality_evidence_malformed","fields":{"got_len":"0","part":"cfa1.n_tables","reason":"cfa1_no_tables","want_len":"1"}}');
    b[5] = 65;
    expect(j(refusal(() => decodeCFA1(b, lim)))).toBe('{"code":"finality_evidence_too_large","fields":{"count":"65","limit":"64","part":"cfa1.tables"}}');
    // 64 tables is within the bound: it reads on (and then runs out of bytes)
    b[5] = 64;
    expect(refusal(() => decodeCFA1(b, lim)).code).toBe('finality_evidence_malformed');
    expect(refusal(() => decodeCFA1(b, lim)).fields.reason).not.toBe('cfa1_no_tables');
    const tight = { ...lim, maxCFA1Tables: 1 };
    expect(refusal(() => decodeCFA1(good(), tight)).fields.part).toBe('cfa1.tables');
    expect(decodeCFA1(encodeCFA1(tiny({ tables: 1 })), tight).tables.length).toBe(1);
  });
  it('an empty table', () => {
    const b = good();
    b[6] = 0;
    expect(j(refusal(() => decodeCFA1(b, lim)))).toBe('{"code":"finality_evidence_malformed","fields":{"got_len":"0","index":"0","part":"cfa1.table","reason":"cfa1_table_empty","want_len":"1"}}');
    const c = good();
    c[6 + 1 + 3 * 96] = 0;
    expect(refusal(() => decodeCFA1(c, lim)).fields.index).toBe(1n);
  });
  it('zero records, a count above the bound, and a count the remaining bytes cannot hold', () => {
    const b = good().slice(0, recOff + 4);
    const setCount = (n: number): Uint8Array => {
      const x = Uint8Array.from(b);
      new DataView(x.buffer).setUint32(recOff, n, false);
      return x;
    };
    expect(refusal(() => decodeCFA1(setCount(0), lim)).fields.reason).toBe('cfa1_no_records');
    expect(j(refusal(() => decodeCFA1(setCount(65537), lim)))).toBe('{"code":"finality_evidence_too_large","fields":{"count":"65537","limit":"65536","part":"cfa1.records"}}');
    expect(j(refusal(() => decodeCFA1(setCount(0xffffffff), lim)))).toBe('{"code":"finality_evidence_too_large","fields":{"count":"4294967295","limit":"65536","part":"cfa1.records"}}');
    expect(j(refusal(() => decodeCFA1(setCount(65536), lim)))).toBe(
      '{"code":"finality_evidence_malformed","fields":{"got_len":"0","part":"cfa1.records","reason":"count_exceeds_remaining","want_len":"8585216"}}',
    );
    // exactly one record's minimal size remaining: the count check passes (the record is then read in full)
    const oneRec = concat(setCount(1), filled(1 + 1 + 8 + 32 + 8 + 32 + 48 + 1, 0));
    expect(decodeCFA1(oneRec, lim).records.length).toBe(1);
    const short = concat(setCount(1), filled(1 + 1 + 8 + 32 + 8 + 32 + 48, 0));
    expect(refusal(() => decodeCFA1(short, lim)).fields.reason).toBe('count_exceeds_remaining');
    const tight = { ...lim, maxCFA1Records: 1 };
    expect(refusal(() => decodeCFA1(good(), tight)).fields.count).toBe(2n);
    expect(decodeCFA1(encodeCFA1(tiny({ records: 1 })), tight).records.length).toBe(1);
  });
  it('a table index equal to the table count is out of range (committee or next), the largest index in range is fine', () => {
    for (const at of [0, 1]) {
      const b = good();
      b[recOff + 4 + at] = 2;
      expect(j(refusal(() => decodeCFA1(b, lim)))).toBe(
        '{"code":"finality_evidence_malformed","fields":{"got_len":"2","index":"0","part":"cfa1.record","reason":"cfa1_table_index_out_of_range","want_len":"2"}}',
      );
    }
    const c = good();
    c[recOff + 4] = 1;
    expect(decodeCFA1(c, lim).records[0]!.committeeIdx).toBe(1);
    // the reported index is the larger of the two
    const d = good();
    d[recOff + 4] = 7;
    d[recOff + 5] = 9;
    expect(refusal(() => decodeCFA1(d, lim)).fields.got_len).toBe(9n);
    d[recOff + 4] = 9;
    d[recOff + 5] = 7;
    expect(refusal(() => decodeCFA1(d, lim)).fields.got_len).toBe(9n);
  });
  it('signer indices: strictly increasing and below the committee size', () => {
    const run = (signers: number[]): FinalityStateError => refusal(() => decodeCFA1(encodeCFA1(tiny({ signers })), lim));
    expect(j(run([0, 3]))).toBe('{"code":"committee_chain_broken","fields":{"check":"signer_index_invalid","committee_size":"3","epoch":"0","index":"1","signer":"3"}}');
    expect(j(run([1, 1]))).toBe('{"code":"committee_chain_broken","fields":{"check":"signer_index_invalid","committee_size":"3","epoch":"0","index":"1","signer":"1"}}');
    expect(j(run([2, 1]))).toBe('{"code":"committee_chain_broken","fields":{"check":"signer_index_invalid","committee_size":"3","epoch":"0","index":"1","signer":"1"}}');
    expect(j(run([3]))).toContain('"index":"0"');
    expect(Array.from(decodeCFA1(encodeCFA1(tiny({ signers: [0, 1, 2] })), lim).records[0]!.signers)).toEqual([0, 1, 2]);
    expect(Array.from(decodeCFA1(encodeCFA1(tiny({ signers: [2] })), lim).records[0]!.signers)).toEqual([2]);
    expect(Array.from(decodeCFA1(encodeCFA1(tiny({ signers: [] })), lim).records[0]!.signers)).toEqual([]);
    // the failing record is named by its position
    const c = tiny({ records: 3 });
    c.records[2]!.signers = Uint8Array.of(1, 1);
    expect(refusal(() => decodeCFA1(encodeCFA1(c), lim)).fields.epoch).toBe(2n);
  });
  it('255 signers of a 255-key committee decode; a trailing byte is refused', () => {
    const c = tiny({ size: 255, tables: 1, records: 1, signers: Array.from({ length: 255 }, (_, i) => i) });
    expect(decodeCFA1(encodeCFA1(c), lim).records[0]!.signers.length).toBe(255);
    expect(j(refusal(() => decodeCFA1(concat(encodeCFA1(c), Uint8Array.of(0)), lim)))).toBe(
      '{"code":"finality_evidence_malformed","fields":{"got_len":"1","part":"cfa1","reason":"trailing_bytes","want_len":"0"}}',
    );
  });
  it('the encoder refuses what it cannot encode', () => {
    const empty = tiny();
    empty.tables[0] = [];
    expect(refusal(() => encodeCFA1(empty)).fields.reason).toBe('cfa1_table_size');
    const big = tiny();
    big.tables[1] = Array.from({ length: 256 }, () => key(1));
    expect(refusal(() => encodeCFA1(big)).fields.reason).toBe('cfa1_table_size');
    const k = tiny();
    k.tables[0]![1] = filled(95, 1);
    expect(refusal(() => encodeCFA1(k)).fields.reason).toBe('cfa1_key_length');
    const s = tiny();
    s.records[0]!.signers = new Uint8Array(256);
    expect(refusal(() => encodeCFA1(s)).fields.reason).toBe('cfa1_signers_too_many');
    expect(encodeCFA1({ tables: [[key(1)]], records: [] }).length).toBe(4 + 2 + 1 + 96 + 4);
  });
});
