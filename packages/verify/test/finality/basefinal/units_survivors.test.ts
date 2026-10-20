/**
 * Tests written for the survivors of the first pass of the mutation gate (tools/mutation-basefinal): the clamps of the body bounds, the
 * zero-interval row, the prefix check of pins hex and the empty interval pair.
 */
import { describe, expect, it } from 'vitest';
import { decodeContainer, defaultLimits } from '../../../src/proof-v2/finality/codec.js';
import { ethl1PinsFrom } from '../../../src/proof-v2/finality/ethl1/index.js';
import { parsePinsOverride, sepoliaPins } from '../../../src/proof-v2/finality/pins.js';
import { decodeBody, parseBasePins, rowComplete } from '../../../src/proof-v2/finality/basefinal/index.js';
import { FinalityStateError } from '../../../src/proof-v2/finality/state.js';
import { offsets } from './evlayout.js';
import { GAME_020, mainJson, pinsOf } from './pinsvariants.js';
import { read } from './vectorset.js';

const pins = parsePinsOverride(read('pins/main.json'));
const ep = ethl1PinsFrom(sepoliaPins(pins));
const lim = defaultLimits();
const EV = Uint8Array.from(read('evidence/valid_leg_47604755.bin'));
const body = decodeContainer(EV, lim).body;
const O = offsets(EV, ep, lim);

const refusal = (f: () => unknown): FinalityStateError => {
  try {
    f();
  } catch (e) {
    if (e instanceof FinalityStateError) return e;
    throw e;
  }
  throw new Error('accepted');
};

describe('the L1 spine bound is the pins bound, clamped to the framework limit when the pins give none or more', () => {
  it('a bound of 0, a negative bound and the framework limit itself all decode the live body', () => {
    for (const m of [0, -1, lim.maxSpineHeaders]) expect(decodeBody(body, lim, { ...ep, maxSpineHeaders: m }, 1024).l1Spine.length, String(m)).toBe(O.cnt1);
  });

  it('a pins bound above the framework limit is clamped to it: one more header than the limit is too large with the framework limit', () => {
    const e = refusal(() => decodeBody(setCount(body, O.l1Count - O.hdr, lim.maxSpineHeaders + 1), lim, { ...ep, maxSpineHeaders: 20000 }, 1024));
    expect(e.code).toBe('finality_evidence_too_large');
    expect(String(e.fields.limit)).toBe(String(lim.maxSpineHeaders));
  });

  it('a pins bound below the live count refuses it with that bound', () => {
    const e = refusal(() => decodeBody(body, lim, { ...ep, maxSpineHeaders: O.cnt1 - 1 }, 1024));
    expect(e.code).toBe('finality_evidence_too_large');
    expect(String(e.fields.limit)).toBe(String(O.cnt1 - 1));
    expect(decodeBody(body, lim, { ...ep, maxSpineHeaders: O.cnt1 }, 1024).l1Spine.length).toBe(O.cnt1);
  });
});

describe('the L2 spine bound is max_l2_headers, clamped to the framework limit when the pins give none or more', () => {
  it('a bound of 0 or a negative one decodes the live body (the framework limit applies)', () => {
    for (const m of [0, -1, 1024]) expect(decodeBody(body, lim, ep, m).l2Spine.length, String(m)).toBe(O.cnt2);
  });

  it('a bound above the framework limit is clamped to it', () => {
    const e = refusal(() => decodeBody(setCount(body, O.l2Count - O.hdr, lim.maxL2Headers + 1), lim, ep, 2000));
    expect(e.code).toBe('finality_evidence_too_large');
    expect(String(e.fields.limit)).toBe(String(lim.maxL2Headers));
  });

  it('a bound below the live count refuses it with that bound; at the count it decodes', () => {
    const e = refusal(() => decodeBody(body, lim, ep, O.cnt2 - 1));
    expect(e.code).toBe('finality_evidence_too_large');
    expect(String(e.fields.limit)).toBe(String(O.cnt2 - 1));
    expect(decodeBody(body, lim, ep, O.cnt2).l2Spine.length).toBe(O.cnt2);
  });
});

function setCount(b: Uint8Array, off: number, v: number): Uint8Array {
  const out = Uint8Array.from(b);
  new DataView(out.buffer).setUint32(off, v, false);
  return out;
}

describe('pins details', () => {
  const bp = parseBasePins(pinsOf(mainJson()));
  const row = bp.impl.get(GAME_020)!;

  it('a row with no intermediate roots is incomplete even when its args length equals the base length', () => {
    expect(rowComplete({ ...row, nIntermediate: 0n, argsLen: 136n }, bp.layouts)).toBe(false);
    expect(rowComplete({ ...row, nIntermediate: 1n, argsLen: 168n, intervalPairs: [[600n, 30n]] }, bp.layouts)).toBe(true);
  });

  it('an address without the 0x prefix is refused even when dropping two characters would leave 20 bytes of hex', () => {
    const d = mainJson();
    d.base_sepolia.portal = `00${d.base_sepolia.portal.slice(2)}`;
    let err: unknown;
    try {
      parseBasePins(pinsOf(d));
    } catch (e) {
      err = e;
    }
    expect((err as FinalityStateError).fields.key).toBe('base_sepolia.portal');
    const d2 = mainJson();
    d2.base_sepolia.impl_pins['00'.padEnd(66, '0')] = { role: 'x' };
    let err2: unknown;
    try {
      parseBasePins(pinsOf(d2));
    } catch (e) {
      err2 = e;
    }
    expect((err2 as FinalityStateError).fields.key).toBe('base_sepolia.impl_pins');
  });

  it('an empty interval pair is [0, 0] (an incomplete row), not a refusal of the file', () => {
    const d = mainJson();
    d.base_sepolia.impl_pins[GAME_020].interval_pairs = [[]];
    const p = parseBasePins(pinsOf(d));
    expect(p.impl.get(GAME_020)!.intervalPairs).toEqual([[0n, 0n]]);
    expect(rowComplete(p.impl.get(GAME_020)!, p.layouts)).toBe(false);
  });
});
