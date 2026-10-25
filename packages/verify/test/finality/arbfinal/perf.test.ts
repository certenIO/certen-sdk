/**
 * Timing of the real valid vector (finality_arb_final1 real_valid: a live Arbitrum Sepolia assertion confirmed through the Rollup directly; a
 * 538 KB evidence with the light-client chain, a 16-header L1 spine, the Rollup proofs and the L2 spine) and of the largest synthetic wallet world
 * of set 3. The numbers are printed for the check-in; the assertion is a generous ceiling only, so a slow shared machine does not make the
 * suite flaky.
 */
import { describe, expect, it } from 'vitest';
import { FINAL1, FINAL3, evidenceOf, legOf, load, pinsOf, vectorByName } from './vectorset.js';

const time = async (set: typeof FINAL1, name: string, route: string): Promise<number[]> => {
  const { ArbFinalKind } = await load();
  const v = vectorByName(set, name);
  const pins = pinsOf(set, v);
  const leg = legOf(v);
  const ev = evidenceOf(set, v);
  const k = new ArbFinalKind();
  const times: number[] = [];
  for (let i = 0; i < 5; i++) {
    const t0 = performance.now();
    const r = k.verify(pins, leg, ev);
    times.push(performance.now() - t0);
    expect(r.fields.confirmation_route).toBe(route);
  }
  return times;
};
const sum = (t: number[]): string => {
  const s = [...t].sort((a, b) => a - b);
  return `first ${t[0]!.toFixed(0)} (cold), min ${s[0]!.toFixed(0)}, median ${s[2]!.toFixed(0)}, max ${s[4]!.toFixed(0)}`;
};

describe('verify time of the valid vectors', () => {
  it('judges the real direct-route vector (538 KB) well inside the ceiling; prints the split', async () => {
    const t = await time(FINAL1, 'real_valid', 'direct');
    // eslint-disable-next-line no-console
    console.log(`arbfinal real_valid verify ms: ${sum(t)}`);
    expect([...t].sort((a, b) => a - b)[2]!).toBeLessThan(15_000);
  }, 300_000);

  it('judges the largest synthetic wallet world of set 3 well inside the ceiling; prints the split', async () => {
    const t = await time(FINAL3, 'synth_valid_wallet_execute_transactions_proven', 'wallet');
    // eslint-disable-next-line no-console
    console.log(`arbfinal synth_valid_wallet_execute_transactions_proven verify ms: ${sum(t)}`);
    expect([...t].sort((a, b) => a - b)[2]!).toBeLessThan(15_000);
  }, 300_000);
});
