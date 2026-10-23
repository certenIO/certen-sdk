/**
 * The base_sepolia pins section (V2_SPEC_S7 4.2): every malformed value is finality_pins_corrupt{bad_value, key}, an absent section is
 * finality_pin_unknown, unknown keys are ignored, key matching is case-insensitive and null a no-op (Go json.Unmarshal), and the
 * game_impl row completeness uses Go's int64 arithmetic. The same variants are cross-checked against the Go ParsePins (see the check-in).
 */
import { describe, expect, it } from 'vitest';
import { FinalityStateError } from '../../../src/proof-v2/finality/state.js';
import { parseBasePins, rowComplete, MIN_ARGS_BASE_LEN, MIN_ARGS_PER_ROOT } from '../../../src/proof-v2/finality/basefinal/index.js';
import { assertRegistered, registryInt } from './regcheck.js';
import { GAME_020, mainJson, pinsOf, variantDoc, variants } from './pinsvariants.js';

describe('parseBasePins', () => {
  for (const v of variants) {
    it(v.name, () => {
      let err: unknown;
      try {
        parseBasePins(pinsOf(variantDoc(v)));
      } catch (e) {
        err = e;
      }
      if (v.expect === 'ok') {
        expect(err, String(err)).toBeUndefined();
        return;
      }
      expect(err instanceof FinalityStateError, String(err)).toBe(true);
      const e = err as FinalityStateError;
      expect(e.code).toBe(v.expect.code);
      if (v.expect.key !== undefined) {
        expect(e.fields.reason).toBe('bad_value');
        expect(e.fields.key).toBe(v.expect.key);
      }
      assertRegistered(e);
      assertRegistered(e, registryInt);
    });
  }

  it('the pins of the published set parse to the seven rows, two proxy rows and the aggregate_v1 layout', () => {
    const bp = parseBasePins(pinsOf(mainJson()));
    expect(bp.impl.size).toBe(7);
    expect(bp.proxy.size).toBe(2);
    expect(bp.layouts.get('aggregate_v1')!.argsBaseLen).toBe(136n);
    expect(bp.maxL2Headers).toBe(1024n);
    expect(MIN_ARGS_BASE_LEN).toBe(136n);
    expect(MIN_ARGS_PER_ROOT).toBe(32n);
  });

  it('a null pins argument is finality_pin_unknown', () => {
    let err: unknown;
    try {
      parseBasePins(null);
    } catch (e) {
      err = e;
    }
    expect((err as FinalityStateError).code).toBe('finality_pin_unknown');
  });
});

describe('rowComplete (the game_impl row the predicates may rely on)', () => {
  const bp = parseBasePins(pinsOf(mainJson()));
  const row = bp.impl.get(GAME_020)!;

  it('the published 0.2.0 and 0.3.0 rows are complete', () => {
    expect(rowComplete(row, bp.layouts)).toBe(true);
    const games = [...bp.impl.values()].filter((r) => r.role === 'game_impl');
    expect(games.length).toBe(2);
    expect(games.every((r) => rowComplete(r, bp.layouts))).toBe(true);
  });

  const lose: [string, (r: typeof row) => typeof row][] = [
    ['role', (r) => ({ ...r, role: 'x' })],
    ['game_type', (r) => ({ ...r, gameType: 0 })],
    ['version', (r) => ({ ...r, version: '' })],
    ['impl', (r) => ({ ...r, impl: new Uint8Array(20) })],
    ['asr', (r) => ({ ...r, asr: new Uint8Array(20) })],
    ['n_intermediate', (r) => ({ ...r, nIntermediate: 0n })],
    ['n_intermediate (negative)', (r) => ({ ...r, nIntermediate: -1n })],
    ['interval_pairs', (r) => ({ ...r, intervalPairs: [] })],
    ['slow delay', (r) => ({ ...r, slowDelay: 0n })],
    ['fast delay', (r) => ({ ...r, fastDelay: 0n })],
    ['cwia', (r) => ({ ...r, cwia: 'other' })],
    ['args_len', (r) => ({ ...r, argsLen: r.argsLen + 1n })],
    ['pair total (0)', (r) => ({ ...r, intervalPairs: [[0n, 30n]] as [bigint, bigint][] })],
    ['pair interval (0)', (r) => ({ ...r, intervalPairs: [[600n, 0n]] as [bigint, bigint][] })],
    ['pair (not a multiple)', (r) => ({ ...r, intervalPairs: [[600n, 7n]] as [bigint, bigint][] })],
  ];
  for (const [name, f] of lose) {
    it(`a row without a valid ${name} is incomplete`, () => {
      expect(rowComplete(f(row), bp.layouts)).toBe(false);
    });
  }

  it('the args length identity is compared without wrapping (Go 25b37af): n_intermediate = 2^59 + 20 wraps 32*n to 640 in int64 and is NOT a complete row', () => {
    expect(rowComplete({ ...row, nIntermediate: (1n << 59n) + 20n }, bp.layouts)).toBe(false);
    expect(rowComplete({ ...row, nIntermediate: 1n << 59n }, bp.layouts)).toBe(false);
    // the same count with an args_len equal to the wrapped value (640) must not read complete either
    expect(rowComplete({ ...row, nIntermediate: (1n << 59n) + 20n, argsLen: 640n }, bp.layouts)).toBe(false);
  });

  it('a count whose base + per_root * n is exactly 2^63-1 is complete, one more root is not (no wrap at the boundary)', () => {
    const lay = bp.layouts.get('aggregate_v1')!;
    const n = ((1n << 63n) - 1n - lay.argsBaseLen) / lay.argsPerRoot;
    const fit = lay.argsBaseLen + lay.argsPerRoot * n;
    expect(fit <= (1n << 63n) - 1n).toBe(true);
    expect(rowComplete({ ...row, nIntermediate: n, argsLen: fit }, bp.layouts)).toBe(true);
    expect(rowComplete({ ...row, nIntermediate: n + 1n, argsLen: BigInt.asIntN(64, fit + lay.argsPerRoot) }, bp.layouts)).toBe(false);
  });

  it('a layout with a negative base or per-root length holds no complete row', () => {
    const lay = bp.layouts.get('aggregate_v1')!;
    expect(rowComplete(row, new Map([['aggregate_v1', { ...lay, argsBaseLen: -1n }]]))).toBe(false);
    expect(rowComplete(row, new Map([['aggregate_v1', { ...lay, argsPerRoot: -1n }]]))).toBe(false);
  });
});
