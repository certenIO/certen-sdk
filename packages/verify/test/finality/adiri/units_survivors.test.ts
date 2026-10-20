/** Boundary tests added for the survivors of the first hand-run operator mutation pass over cfa1, record, chain, sigs and kind. */
import { describe, expect, it } from 'vitest';
import { FinalityStateError, newState } from '../../../src/proof-v2/finality/state.js';
import { KeyCache, encodeCFA1, firstFailure, parsePins, verifyCommitteeChain } from '../../../src/proof-v2/finality/adiri/index.js';
import { embeddedAdiriPins } from './vectorset.js';
import { aggregateSign, buildChain, concat, filled, pinsOfSection, pinsOfText, pinsSection, pubKey } from './synth.js';

function refusal(f: () => unknown): FinalityStateError {
  try {
    f();
  } catch (e) {
    expect(e).toBeInstanceOf(FinalityStateError);
    return e as FinalityStateError;
  }
  throw new Error('expected a refusal');
}

describe('the CFA1 encoder bounds are the width of the counts', () => {
  const key = filled(96, 1);
  it('65535 tables fit a u16 count, 65536 do not', () => {
    const ok = encodeCFA1({ tables: Array.from({ length: 65535 }, () => [key]), records: [] });
    expect(ok.length).toBe(4 + 2 + 65535 * 97 + 4);
    expect(ok[4]).toBe(0xff);
    expect(ok[5]).toBe(0xff);
    const e = refusal(() => encodeCFA1({ tables: Array.from({ length: 65536 }, () => [key]), records: [] }));
    expect(e.canonical()).toBe('{"code":"finality_evidence_malformed","fields":{"got_len":"65536","part":"cfa1","reason":"cfa1_too_large_to_encode","want_len":"65535"}}');
  });
  it('a record count of 2^32-1 still fits the u32 count', () => {
    // an array-like of the largest legal length (a real array of 2^32-1 holes would take billions of steps to walk)
    const records = { length: 0xffffffff, forEach: () => undefined } as never;
    const out = encodeCFA1({ tables: [[key]], records });
    expect(Array.from(out.subarray(out.length - 4))).toEqual([0xff, 0xff, 0xff, 0xff]);
  });
});

describe('the pins decoder keeps Go integer and null semantics', () => {
  const base = (): string => {
    const p = embeddedAdiriPins().sections.get('adiri') as { pairs: [string, unknown][] };
    const toJs = (v: any): any => (v && v.pairs ? Object.fromEntries(v.pairs.map(([k, x]: [string, unknown]) => [k, toJs(x)])) : v && v.lit !== undefined ? Number(v.lit) : Array.isArray(v) ? v.map(toJs) : v);
    return JSON.stringify(toJs(p));
  };

  it('the largest uint64 and int64 values are values, not errors', () => {
    const t = base().replace('"chain_id":2017', '"chain_id":18446744073709551615').replace(/"max_headers":\d+/, '"max_headers":9223372036854775807');
    const p = parsePins(pinsOfText(t));
    expect(p.chainId).toBe(18446744073709551615n);
    expect(p.maxHeaders).toBe(9223372036854775807n);
    const n = parsePins(pinsOfText(base().replace(/"epoch0_final_state":\{"hash":"([^"]+)","number":\d+\}/, '"epoch0_final_state":{"hash":"$1","number":18446744073709551615}')));
    expect(n.epoch0FinalState.number).toBe(18446744073709551615n);
    // one more is an error
    expect(refusal(() => parsePins(pinsOfText(base().replace('"chain_id":2017', '"chain_id":18446744073709551616')))).fields.key).toBe('adiri.chain_id');
    expect(refusal(() => parsePins(pinsOfText(base().replace(/"max_headers":\d+/, '"max_headers":9223372036854775808')))).fields.key).toBe('adiri.max_headers');
  });

  it('the smallest int64 is a decodable value, so a hex error elsewhere is reported first (a type error would be reported at once)', () => {
    const t = base().replace(/"genesis_hash":"[^"]+"/, '"genesis_hash":"0x1"').replace(/"max_headers":\d+/, '"max_headers":-9223372036854775808');
    expect(refusal(() => parsePins(pinsOfText(t))).fields.key).toBe('adiri.genesis_hash');
    const below = base().replace(/"genesis_hash":"[^"]+"/, '"genesis_hash":"0x1"').replace(/"max_headers":\d+/, '"max_headers":-9223372036854775809');
    expect(refusal(() => parsePins(pinsOfText(below))).fields.key).toBe('adiri.max_headers');
  });

  it('a null after a value leaves the value (scalars) or clears it (a slice), as encoding/json does', () => {
    const keep = base().replace(/\}$/, ',"chain_id":null,"min_committee_size":null,"epoch_record_codec":null}');
    const p = parsePins(pinsOfText(keep));
    expect(p.chainId).toBe(2017n);
    expect(p.minCommittee).toBe(4n);
    expect(p.codec).toBe('telcoin-epoch-record/bcs-blake3/1');
    const cleared = base().replace(/\}$/, ',"genesis_committee":null}');
    expect(refusal(() => parsePins(pinsOfText(cleared))).fields.key).toBe('adiri.genesis_committee');
    const sub = base().replace(/\}$/, ',"eip2935":null,"epoch0_final_state":null}');
    expect(parsePins(pinsOfText(sub)).eip2935CodeHash.length).toBe(32);
  });
});

describe('a failure of the verification machinery itself', () => {
  const chain = buildChain([{ committee: [0, 1, 2, 3], next: [0, 1, 2, 3], fsNumber: 100n }]);
  const par = parsePins(pinsOfSection(pinsSection({ genesisCommittee: [0, 1, 2, 3], epoch0Number: 100n, epoch0Hash: chain.cfa1.records[0]!.finalState.hash })));
  it('is finality_verifier_failed with the cause', () => {
    const e = refusal(() => verifyCommitteeChain(par, chain.cfa1, 'batched', () => { throw new Error('boom'); }));
    expect(e.canonical()).toBe('{"code":"finality_verifier_failed","fields":{"cause":"boom","chain":"2017","kind":"adiri/finalized/v1"}}');
    const t = refusal(() => verifyCommitteeChain(par, chain.cfa1, 'batched', () => { throw 'text'; }));
    expect(t.fields.cause).toBe('text');
  });
  it('a named state raised there passes through unchanged', () => {
    const named = newState('committee_chain_broken', { epoch: 0n, check: 'signature_invalid', reason: 'pairing' });
    const e = refusal(() => verifyCommitteeChain(par, chain.cfa1, 'batched', () => { throw named; }));
    expect(e).toBe(named);
  });
});

describe('a batch scalar is never zero', () => {
  it('a zero draw is discarded: a bad record weighted by zero would otherwise go unseen', () => {
    const cache = new KeyCache();
    const signer = [0, 1, 2].map((n) => cache.get(pubKey(n))!);
    const msg = (i: number): Uint8Array => concat(Uint8Array.of(1, 0, 1, 0x20), filled(32, i));
    const bad = { epoch: 0, sig: aggregateSign([0, 1, 2], msg(5)), signer, msg: msg(0) };
    const good = { epoch: 1, sig: aggregateSign([0, 1, 2], msg(1)), signer, msg: msg(1) };
    let calls = 0;
    const rnd = (n: number): Uint8Array => {
      const out = new Uint8Array(n);
      if (calls++ > 0) out[n - 1] = calls; // the first draw is all zero
      return out;
    };
    expect(firstFailure([bad, good], 'batched', rnd)).toEqual({ index: 0, reason: 'pairing' });
    expect(calls).toBeGreaterThanOrEqual(3);
  });
});

describe('the mode selects the strategy, not just the verdict', () => {
  it('one-by-one never draws a batch scalar; batched draws one per record', () => {
    const cache = new KeyCache();
    const signer = [0, 1, 2].map((n) => cache.get(pubKey(n))!);
    const msg = (i: number): Uint8Array => concat(Uint8Array.of(1, 0, 1, 0x20), filled(32, i));
    const items = [0, 1].map((i) => ({ epoch: i, sig: aggregateSign([0, 1, 2], msg(i)), signer, msg: msg(i) }));
    let draws = 0;
    const spy = (n: number): Uint8Array => {
      draws++;
      const out = new Uint8Array(n);
      out[n - 1] = draws;
      return out;
    };
    expect(firstFailure(items, 'oneByOne', spy)).toBeUndefined();
    expect(draws).toBe(0);
    expect(firstFailure(items, 'batched', spy)).toBeUndefined();
    expect(draws).toBe(2);
  });
});
