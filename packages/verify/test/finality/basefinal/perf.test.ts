/**
 * Timing of the largest live vectors. The numbers are printed for the check-in; the assertion is a generous ceiling only, so a slow shared
 * machine does not make the suite flaky. The split shows where the time goes: the Sepolia light-client part (ethl1, shared with every
 * rollup kind and not cached across calls), the L1 state proofs and the game judgement (this kind's own work).
 */
import { describe, expect, it } from 'vitest';
import { decodeContainer, defaultLimits } from '../../../src/proof-v2/finality/codec.js';
import { blockAt, covers, ethl1PinsFrom, verifyFinalizedHead } from '../../../src/proof-v2/finality/ethl1/index.js';
import { parsePinsOverride, sepoliaPins } from '../../../src/proof-v2/finality/pins.js';
import { BaseFinalKind, decodeBody, judgeBase, parseBasePins } from '../../../src/proof-v2/finality/basefinal/index.js';
import { caseNames, legRef, loadCase, read, type LegFile } from './vectorset.js';

const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;

describe('verify time of the largest live vectors', () => {
  const pins = parsePinsOverride(read('pins/main.json'));
  const kind = new BaseFinalKind();

  it('the largest accepting vector judges well inside the ceiling; prints the split', () => {
    const c = loadCase('valid_leg_47604755');
    const leg = legRef(JSON.parse(read(c.leg).toString('utf8')) as LegFile);
    const ev = Uint8Array.from(read(c.evidence));
    const times: number[] = [];
    for (let i = 0; i < 5; i++) {
      const t0 = performance.now();
      const v = kind.verify(pins, leg, ev);
      times.push(performance.now() - t0);
      expect(v.fields.game_version).toBe('0.2.0');
    }
    const lim = defaultLimits();
    const ep = ethl1PinsFrom(sepoliaPins(pins));
    const body = decodeBody(decodeContainer(ev, lim).body, lim, ep, 1024);
    const t1 = performance.now();
    const head = verifyFinalizedHead(ep, body.lc);
    const lc = performance.now() - t1;
    const t2 = performance.now();
    const a = blockAt(covers(head, body.l1Spine, ep.maxSpineHeaders), body.stateBlock);
    const spine = performance.now() - t2;
    const bp = parseBasePins(pins);
    const j: number[] = [];
    for (let i = 0; i < 5; i++) {
      const t3 = performance.now();
      judgeBase(bp, a, body, leg, head);
      j.push(performance.now() - t3);
    }
    // eslint-disable-next-line no-console
    console.log(
      `basefinal valid_leg_47604755 (${ev.length} B, ${body.nodes.length} nodes) verify ms: first ${times[0]!.toFixed(0)} (cold), min ${Math.min(...times).toFixed(0)}, median ${median(times).toFixed(0)}, max ${Math.max(...times).toFixed(0)}; light-client part ${lc.toFixed(0)} ms, spine ${spine.toFixed(1)} ms, state proofs + game judgement median ${median(j).toFixed(1)} ms`,
    );
    expect(median(times)).toBeLessThan(15_000);
  });

  it('every live case (accepting and refusing) is judged within the ceiling; prints the slowest', () => {
    let worst = { id: '', ms: 0 };
    for (const id of caseNames()) {
      const c = loadCase(id);
      const leg = legRef(JSON.parse(read(c.leg).toString('utf8')) as LegFile);
      const ev = Uint8Array.from(read(c.evidence));
      const t0 = performance.now();
      try {
        kind.verify(pins, leg, ev);
      } catch {
        // refusals are named states; the timing is what is measured here
      }
      const ms = performance.now() - t0;
      if (ms > worst.ms) worst = { id, ms };
    }
    // eslint-disable-next-line no-console
    console.log(`basefinal slowest live case: ${worst.id} ${worst.ms.toFixed(0)} ms`);
    expect(worst.ms).toBeLessThan(15_000);
  }, 300_000);
});
