/**
 * Targeted tests of verifyFinalizedHead's own checks, built by editing published vectors so that each refusal happens before any
 * signature work (cheap) and names exactly the code and fields Go names. They exist to kill mutants of verify.ts that the vector
 * set alone leaves alive (the mutation gate in tools/mutation-ethl1); each one states the rule it pins.
 */
import { describe, expect, it } from 'vitest';
import { verifyFinalizedHead, type LC, type Pins } from '../../../src/proof-v2/finality/ethl1/index.js';
import { FinalityStateError } from '../../../src/proof-v2/finality/state.js';
import { lcOf, loadCase, loadPins } from './helpers.js';

const named = (f: () => unknown): FinalityStateError => {
  try {
    f();
  } catch (e) {
    if (e instanceof FinalityStateError) return e;
    throw e;
  }
  throw new Error('did not throw');
};
const clone = (lc: LC): LC => ({
  ...lc,
  anchorRoot: Uint8Array.from(lc.anchorRoot),
  anchorBody: { layout: lc.anchorBody.layout, ssz: Uint8Array.from(lc.anchorBody.ssz) },
  links: lc.links.map((l) => ({ layout: l.layout, ssz: Uint8Array.from(l.ssz) })),
  finalUpdate: { layout: lc.finalUpdate.layout, ssz: Uint8Array.from(lc.finalUpdate.ssz) },
});
const caseLC = (id: string): { lc: LC; pins: Pins } => {
  const c = loadCase(id);
  return { lc: clone(lcOf(c)), pins: loadPins(c.pins!) };
};
const grow = (b: Uint8Array): Uint8Array => Uint8Array.of(...b, 0);
const shrink = (b: Uint8Array): Uint8Array => b.subarray(0, b.length - 1);

describe('step 1: bounds, lengths, layout bytes', () => {
  it('the link bound is inclusive: exactly maxLinks links pass the bound, one more is too large with both numbers', () => {
    const { lc, pins } = caseLC('valid_k1_short'); // two links
    expect(lc.links.length).toBe(2);
    const over = named(() => verifyFinalizedHead({ ...pins, maxLinks: 1 }, lc));
    expect(over.canonical()).toBe('{"code":"finality_evidence_too_large","fields":{"count":"2","limit":"1","part":"links"}}');
    // at the bound the walk proceeds (it verifies: the vector is valid)
    expect(verifyFinalizedHead({ ...pins, maxLinks: 2 }, lc).participants).toBeGreaterThanOrEqual(342);
  });

  it('a kind-1 committee body must be exactly 24,624 bytes, longer or shorter', () => {
    const { lc, pins } = caseLC('valid_k1_k0');
    const long = clone(lc);
    long.anchorBody.ssz = grow(long.anchorBody.ssz);
    expect(named(() => verifyFinalizedHead(pins, long)).canonical()).toBe(
      '{"code":"finality_evidence_malformed","fields":{"got_len":"24625","index":"0","part":"anchor_body","reason":"length","want_len":"24624"}}',
    );
    const short = clone(lc);
    short.anchorBody.ssz = shrink(short.anchorBody.ssz);
    expect(named(() => verifyFinalizedHead(pins, short)).fields.got_len).toBe(24623);
  });

  it('a Gloas update, final update and bootstrap must have exactly their fixed sizes, longer or shorter', () => {
    const k1 = caseLC('valid_k1_short');
    const upLong = clone(k1.lc);
    upLong.links[1]!.ssz = grow(upLong.links[1]!.ssz);
    expect(named(() => verifyFinalizedHead(k1.pins, upLong)).canonical()).toBe(
      '{"code":"finality_evidence_malformed","fields":{"got_len":"26425","index":"1","part":"link","reason":"length","want_len":"26424"}}',
    );
    const finLong = clone(k1.lc);
    finLong.finalUpdate.ssz = grow(finLong.finalUpdate.ssz);
    expect(named(() => verifyFinalizedHead(k1.pins, finLong)).canonical()).toBe(
      '{"code":"finality_evidence_malformed","fields":{"got_len":"1449","index":"0","part":"final_update","reason":"length","want_len":"1448"}}',
    );
    const k2 = caseLC('valid_k2_k0');
    const bootLong = clone(k2.lc);
    bootLong.anchorBody.ssz = grow(bootLong.anchorBody.ssz);
    expect(named(() => verifyFinalizedHead(k2.pins, bootLong)).canonical()).toBe(
      '{"code":"finality_evidence_malformed","fields":{"got_len":"25473","index":"0","part":"anchor_body","reason":"length","want_len":"25472"}}',
    );
    const bootShort = clone(k2.lc);
    bootShort.anchorBody.ssz = shrink(bootShort.anchorBody.ssz);
    expect(named(() => verifyFinalizedHead(k2.pins, bootShort)).fields.got_len).toBe(25471);
  });

  it('a layout byte above 2 is unknown, with the byte reported and 2 as the wanted bound', () => {
    const { lc, pins } = caseLC('valid_k1_short');
    lc.links[0]!.layout = 3;
    expect(named(() => verifyFinalizedHead(pins, lc)).canonical()).toBe(
      '{"code":"finality_evidence_malformed","fields":{"got_len":"3","index":"0","part":"link","reason":"layout_byte_unknown","want_len":"2"}}',
    );
    lc.links[0]!.layout = 0;
    expect(named(() => verifyFinalizedHead(pins, lc)).canonical()).toBe(
      '{"code":"finality_evidence_malformed","fields":{"got_len":"0","index":"0","part":"link","reason":"layout_byte_zero","want_len":"1"}}',
    );
  });
});
