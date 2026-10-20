/** Helpers over the judge-level worlds of finality_base_final1 for the unit tests: a seeded PRNG, world cloning and the outcome of a judge run. */
import { parsePinsOverride, type Pins } from '../../../src/proof-v2/finality/pins.js';
import { judgeBase, parseBasePins } from '../../../src/proof-v2/finality/basefinal/index.js';
import { FinalityStateError, canonValue } from '../../../src/proof-v2/finality/state.js';
import { judgeNames, judgeWorld, loadJudge, read, type JudgeCase } from './vectorset.js';

/** mulberry32 */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const okWorlds = (): string[] => judgeNames().filter((n) => loadJudge(n).expect.result === 'ok');

export interface World {
  a: { hash: Uint8Array; number: bigint; stateRoot: Uint8Array; timestamp: bigint };
  body: ReturnType<typeof judgeWorld>['body'];
  leg: ReturnType<typeof judgeWorld>['leg'];
}

export const worldOf = (id: string): World => judgeWorld(loadJudge(id));

export const mainPins = (): Pins => parsePinsOverride(read('pins/main.json'));
export const pinsWithDelay = (delay: string): Pins =>
  parsePinsOverride(Buffer.from(read('pins/main.json').toString('utf8').replace('"finality_delay_seconds": 0', `"finality_delay_seconds": ${delay}`)));

export type Outcome = { ok: true; canonical: string } | { ok: false; state: FinalityStateError };

/** Judges a world; anything that is not a named state is rethrown (the property under test: a hostile world never throws an unnamed error). */
export function judgeOutcome(w: World, pins: Pins = mainPins()): Outcome {
  try {
    const f = judgeBase(parseBasePins(pins), w.a, w.body, w.leg, { slot: 0n, participants: 0 });
    return { ok: true, canonical: canonValue(f) };
  } catch (e) {
    if (e instanceof FinalityStateError) return { ok: false, state: e };
    throw e;
  }
}

export const cloneWorld = (w: World): World => ({
  a: { ...w.a, hash: Uint8Array.from(w.a.hash), stateRoot: Uint8Array.from(w.a.stateRoot) },
  body: {
    ...w.body,
    gameProxy: Uint8Array.from(w.body.gameProxy),
    gameCode: Uint8Array.from(w.body.gameCode),
    l2Spine: w.body.l2Spine.map((h) => Uint8Array.from(h)),
    nodes: w.body.nodes.map((n) => Uint8Array.from(n)),
  },
  leg: { ...w.leg, hash: Uint8Array.from(w.leg.hash), headerRlp: w.leg.headerRlp === undefined ? undefined : Uint8Array.from(w.leg.headerRlp) },
});

export type { JudgeCase };
