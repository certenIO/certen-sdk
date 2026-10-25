/**
 * Seeded corruption of a whole live container past the light-client part (so the sync-committee check passes and the spine, the L1 state
 * proofs and the game judgement decide): every outcome is the identical accepting verdict or a named, registered state; the unchanged
 * container is accepted twice with the same verdict (the verifier holds no state between calls).
 */
import { describe, expect, it } from 'vitest';
import { defaultLimits } from '../../../src/proof-v2/finality/codec.js';
import { ethl1PinsFrom } from '../../../src/proof-v2/finality/ethl1/index.js';
import { parsePinsOverride, sepoliaPins } from '../../../src/proof-v2/finality/pins.js';
import { BaseFinalKind } from '../../../src/proof-v2/finality/basefinal/index.js';
import { FinalityStateError, canonValue } from '../../../src/proof-v2/finality/state.js';
import { offsets } from './evlayout.js';
import { assertRegistered, registryInt } from './regcheck.js';
import { legRef, read, type LegFile } from './vectorset.js';
import { prng } from './world.js';

const pins = parsePinsOverride(read('pins/main.json'));
const EV = Uint8Array.from(read('evidence/valid_leg_47604755.bin'));
const LEG = legRef(JSON.parse(read('legs/leg_47604755.json').toString('utf8')) as LegFile);
const kind = new BaseFinalKind();
const O = offsets(EV, ethl1PinsFrom(sepoliaPins(pins)), defaultLimits());

const run = (ev: Uint8Array): { ok: true; canonical: string } | { ok: false; state: FinalityStateError } => {
  try {
    return { ok: true, canonical: canonValue(kind.verify(pins, LEG, ev).fields) };
  } catch (e) {
    if (e instanceof FinalityStateError) return { ok: false, state: e };
    throw e;
  }
};

describe('a live container', () => {
  const base = run(EV);

  it('is accepted, twice, with the same verdict', () => {
    expect(base.ok).toBe(true);
    expect(run(EV)).toEqual(base);
  });

  it('with one flipped bit anywhere past the light-client part is the same verdict or a named registered state (never an unnamed error)', () => {
    const rnd = prng(0x11fe);
    const seen = new Set<string>();
    for (let i = 0; i < 8; i++) {
      const e = Uint8Array.from(EV);
      const at = O.lcEnd + Math.floor(rnd() * (EV.length - O.lcEnd));
      e[at]! ^= 1 << Math.floor(rnd() * 8);
      const o = run(e);
      if (o.ok) expect(o.canonical).toBe((base as { canonical: string }).canonical);
      else {
        assertRegistered(o.state);
        assertRegistered(o.state, registryInt);
        seen.add(o.state.code);
      }
    }
    expect(seen.size).toBeGreaterThanOrEqual(1);
  });

  it('with one flipped bit inside the light-client part is the same verdict or a named registered state', () => {
    const rnd = prng(0x1c1c);
    for (let i = 0; i < 4; i++) {
      const e = Uint8Array.from(EV);
      const at = O.hdr + 60 + Math.floor(rnd() * (O.lcEnd - O.hdr - 60));
      e[at]! ^= 1 << Math.floor(rnd() * 8);
      const o = run(e);
      if (o.ok) expect(o.canonical, `bit flipped at ${at}`).toBe((base as { canonical: string }).canonical);
      else {
        assertRegistered(o.state);
        assertRegistered(o.state, registryInt);
      }
    }
  });
});
