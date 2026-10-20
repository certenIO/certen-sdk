/**
 * The judge (V2_SPEC_S7 5.5 O2-O6) over the synthetic worlds of finality_base_final1: the wrap-free finality-delay comparison, the
 * boundary of every 64-bit comparison, hostile outputRootIndex values, and seeded corruption of every part of an accepting world. The
 * property of the corruption tests: the outcome is the identical accepting verdict or a NAMED state registered with exactly its fields,
 * never an unnamed error and never a different accepting verdict.
 */
import { describe, expect, it } from 'vitest';
import { canonValue } from '../../../src/proof-v2/finality/state.js';
import { Code } from '../../../src/proof-v2/finality/state.js';
import { parsePinsOverride } from '../../../src/proof-v2/finality/pins.js';
import { judgeNames, loadJudge, read } from './vectorset.js';
import { assertRegistered, registryInt } from './regcheck.js';
import { cloneWorld, judgeOutcome, mainPins, okWorlds, pinsWithDelay, prng, worldOf } from './world.js';

const ROOT = 'synth_ok_root_claim_anchor';
const U64_MAX = '18446744073709551615';

describe('the finality delay is compared without a wrap', () => {
  const w = worldOf(ROOT);
  const expectOk = loadJudge(ROOT).expect.fields as Record<string, string>;
  const resolved = BigInt(expectOk.resolved_at!);
  const T = BigInt(expectOk.a_timestamp!);

  it('a delay of 2^64-1 is within the delay, where resolvedAt+delay wraps to resolvedAt-1 and a wrapping sum would accept', () => {
    const o = judgeOutcome(w, pinsWithDelay(U64_MAX));
    expect(o.ok).toBe(false);
    if (o.ok) return;
    expect(o.state.code).toBe('game_within_finality_delay');
    expect(canonValue(o.state.fields)).toBe(`{"T":"${T}","delay":"${U64_MAX}","resolvedAt":"${resolved}"}`);
  });

  it('a delay of 2^63 and of 2^64-2 are within the delay as well', () => {
    for (const d of ['9223372036854775808', '18446744073709551614']) {
      const o = judgeOutcome(w, pinsWithDelay(d));
      expect(o.ok ? 'ok' : o.state.code, d).toBe('game_within_finality_delay');
    }
  });

  it('T == resolvedAt + delay is within the delay and T == resolvedAt + delay + 1 is final', () => {
    const edge = T - resolved;
    const at = judgeOutcome(w, pinsWithDelay(String(edge)));
    expect(at.ok ? 'ok' : at.state.code).toBe('game_within_finality_delay');
    const past = judgeOutcome(w, pinsWithDelay(String(edge - 1n)));
    expect(past.ok).toBe(true);
  });

  it('T == resolvedAt and T < resolvedAt are within the delay even with a zero delay (no unsigned subtraction wrap)', () => {
    for (const t of [resolved, resolved - 1n, 0n]) {
      const c = cloneWorld(w);
      c.a.timestamp = t;
      const o = judgeOutcome(c, pinsWithDelay('0'));
      expect(o.ok ? 'ok' : o.state.code, String(t)).toBe('game_within_finality_delay');
    }
    const c = cloneWorld(w);
    c.a.timestamp = resolved + 1n;
    expect(judgeOutcome(c, pinsWithDelay('0')).ok).toBe(true);
  });
});

describe('outputRootIndex', () => {
  const w = worldOf(ROOT);
  const nInter = Number((loadJudge('synth_output_root_index_above_n').expect.fields as Record<string, string>).limit);

  it('2^32-1 and N+1 are finality_evidence_too_large{outputRootIndex} carrying the index and N', () => {
    for (const k of [0xffffffff, nInter + 1]) {
      const c = cloneWorld(w);
      c.body.outputRootIndex = k;
      const o = judgeOutcome(c);
      expect(o.ok).toBe(false);
      if (o.ok) return;
      expect(o.state.code).toBe(Code.EvidenceTooLarge);
      expect(canonValue(o.state.fields)).toBe(`{"count":"${k}","limit":"${nInter}","part":"outputRootIndex"}`);
    }
  });

  it('N itself is the last intermediate root: inside the bound, anchored on roots[N-1]', () => {
    const c = cloneWorld(w);
    c.body.outputRootIndex = nInter;
    const o = judgeOutcome(c);
    if (o.ok) {
      expect(o.canonical).toContain('"root_kind":"intermediate"');
      expect(o.canonical).toContain(`"output_root_index":"${nInter}"`);
    } else {
      expect(o.state.code).not.toBe(Code.EvidenceTooLarge);
    }
  });
});

describe('seeded corruption of every accepting world', () => {
  const ids = okWorlds();

  it('there are nine accepting worlds', () => {
    expect(ids.length).toBe(9);
  });

  it('dropping any one proof node, or truncating it by a byte, is the same verdict or a named registered state', () => {
    for (const id of ids) {
      const w = worldOf(id);
      const base = judgeOutcome(w);
      expect(base.ok, id).toBe(true);
      let refused = 0;
      for (let i = 0; i < w.body.nodes.length; i++) {
        for (const how of ['drop', 'cut', 'empty'] as const) {
          const c = cloneWorld(w);
          if (how === 'drop') c.body.nodes.splice(i, 1);
          else if (how === 'cut') c.body.nodes[i] = c.body.nodes[i]!.subarray(0, c.body.nodes[i]!.length - 1);
          else c.body.nodes[i] = new Uint8Array(0);
          const o = judgeOutcome(c);
          if (o.ok) expect(o.canonical, `${id} ${how} ${i}`).toBe((base as { canonical: string }).canonical);
          else {
            refused++;
            assertRegistered(o.state);
            assertRegistered(o.state, registryInt);
          }
        }
      }
      expect(refused, id).toBeGreaterThan(20);
    }
  });

  it('a flipped byte in a proof node, the game code, an L2 header, the game proxy or the state root never throws an unnamed error', () => {
    const rnd = prng(0x5eed);
    const seen = new Map<string, number>();
    let okAgain = 0;
    for (const id of ids) {
      const w = worldOf(id);
      const base = judgeOutcome(w) as { canonical: string };
      for (let it = 0; it < 120; it++) {
        const c = cloneWorld(w);
        const part = Math.floor(rnd() * 5);
        const flip = (b: Uint8Array): void => {
          if (b.length === 0) return;
          b[Math.floor(rnd() * b.length)]! ^= 1 << Math.floor(rnd() * 8);
        };
        if (part === 0) flip(c.body.nodes[Math.floor(rnd() * c.body.nodes.length)]!);
        else if (part === 1) flip(c.body.gameCode);
        else if (part === 2) flip(c.body.l2Spine[Math.floor(rnd() * c.body.l2Spine.length)]!);
        else if (part === 3) flip(c.body.gameProxy);
        else flip(c.a.stateRoot);
        const o = judgeOutcome(c);
        if (o.ok) {
          okAgain++;
          expect(o.canonical, `${id} part ${part}`).toBe(base.canonical);
        } else {
          assertRegistered(o.state);
          seen.set(o.state.code, (seen.get(o.state.code) ?? 0) + 1);
        }
      }
    }
    // the corruption reaches many distinct refusals, and almost every flip changes the verdict
    expect(seen.size).toBeGreaterThanOrEqual(4);
    expect(okAgain).toBeLessThan(ids.length * 120 * 0.2);
  });

  it('a hostile leg (wrong number, wrong hash, header of another block, absent header) is l2_block_not_canonical or a named state', () => {
    for (const id of ids) {
      const w = worldOf(id);
      const c1 = cloneWorld(w);
      c1.leg.number += 1n;
      const c2 = cloneWorld(w);
      c2.leg.hash[0]! ^= 1;
      const c3 = cloneWorld(w);
      c3.leg.headerRlp = new Uint8Array(0);
      const c4 = cloneWorld(w);
      c4.leg.headerRlp = undefined;
      for (const c of [c1, c2, c3]) {
        const o = judgeOutcome(c);
        expect(o.ok ? 'ok' : o.state.code, id).toBe('l2_block_not_canonical');
      }
      // no header bytes pinned (a leg known only by its triple): the spine's own hash and number decide
      expect(judgeOutcome(c4).ok, id).toBe(true);
    }
  });

  it('an L2 spine with its last header removed, doubled, emptied or reordered is a named state', () => {
    for (const id of ids) {
      const w = worldOf(id);
      if (w.body.l2Spine.length < 2) continue;
      const variants: ((s: Uint8Array[]) => Uint8Array[])[] = [
        (s) => s.slice(0, -1),
        (s) => [...s, s[s.length - 1]!],
        (s) => [...s].reverse(),
        (s) => [s[0]!, new Uint8Array(0), ...s.slice(1)],
        (s) => [s[0]!, Uint8Array.of(0xc0), ...s.slice(2)],
      ];
      for (const v of variants) {
        const c = cloneWorld(w);
        c.body.l2Spine = v(c.body.l2Spine);
        const o = judgeOutcome(c);
        if (!o.ok) assertRegistered(o.state);
        expect(o.ok, id).toBe(false);
      }
    }
  });
});

describe('the states the judge raises are exactly the registered ones', () => {
  it('every state of the 64 refusing judge worlds is registered with exactly its fields in both registries', () => {
    let n = 0;
    for (const id of judgeNames()) {
      const c = loadJudge(id);
      if (c.expect.result === 'ok') continue;
      const o = judgeOutcome(worldOf(id), c.pins === 'pins/main.json' ? mainPins() : parsePinsOverride(read(c.pins)));
      expect(o.ok, id).toBe(false);
      if (o.ok) continue;
      assertRegistered(o.state);
      assertRegistered(o.state, registryInt);
      n++;
    }
    expect(n).toBe(64);
  });
});

