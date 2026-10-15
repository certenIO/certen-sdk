import { describe, it, expect } from 'vitest';
import { parseSpanMs } from '../src/duration.js';
import { parseWaitBudget, TX_WAIT, IDENTITY_WAIT } from '../src/wait.js';

/**
 * `--timeout 6` meant six minutes and nothing on the command line said so. `--timeout 90s`, `6m` and `1h` now say what they mean,
 * and a bare number keeps the meaning it has always had, so no script that works today changes.
 *
 * The parser is the SDK's `parseDuration` (one positive whole number and one unit: the same rule `--expires-in` follows), plus the
 * bare number. Nothing in a wait budget is shortened by any of this; it is only a way to write one down.
 */
describe('parseSpanMs', () => {
  it('reads a bare number as minutes for a timeout, exactly as before (decimals included)', () => {
    expect(parseSpanMs('6', 'minutes', '--timeout', 'INVALID_TIMEOUT')).toBe(360_000);
    expect(parseSpanMs('0.5', 'minutes', '--timeout', 'INVALID_TIMEOUT')).toBe(30_000);
    expect(parseSpanMs(' 7 ', 'minutes', '--timeout', 'INVALID_TIMEOUT')).toBe(420_000);
  });

  it('reads a bare number as seconds for a poll interval, exactly as before', () => {
    expect(parseSpanMs('5', 'seconds', '--poll-interval', 'INVALID_POLL_INTERVAL')).toBe(5_000);
    expect(parseSpanMs('0.5', 'seconds', '--poll-interval', 'INVALID_POLL_INTERVAL')).toBe(500);
  });

  it.each([
    ['90s', 90_000],
    ['6m', 360_000],
    ['1h', 3_600_000],
    ['2d', 172_800_000],
    ['6M', 360_000],
    [' 30 s ', 30_000],
  ])('reads %s as %d ms', (text, ms) => {
    expect(parseSpanMs(text, 'minutes', '--timeout', 'INVALID_TIMEOUT')).toBe(ms);
    // A unit is a unit whichever way the bare number would have been read.
    expect(parseSpanMs(text, 'seconds', '--poll-interval', 'INVALID_POLL_INTERVAL')).toBe(ms);
  });

  it.each(['', 'soon', '0', '-1', '0s', '0m', '-5m', '1.5h', '6 minutes', '1e3', '0x10', '6mm', 'm', '6m30s', 'Infinity', 'NaN'])(
    'refuses %j as a usage error that names the flag and the accepted forms',
    (bad) => {
      expect(() => parseSpanMs(bad, 'minutes', '--timeout', 'INVALID_TIMEOUT')).toThrowError(/^--timeout must be a positive number of minutes/);
      try {
        parseSpanMs(bad, 'minutes', '--timeout', 'INVALID_TIMEOUT');
      } catch (e) {
        expect(e).toMatchObject({ code: 'INVALID_TIMEOUT', exitCode: 2 });
        expect((e as Error).message).toMatch(/90s.*6m.*1h/);
      }
    },
  );

  it('says seconds for a poll interval', () => {
    expect(() => parseSpanMs('soon', 'seconds', '--poll-interval', 'INVALID_POLL_INTERVAL'))
      .toThrowError(/^--poll-interval must be a positive number of seconds/);
  });
});

describe('wait budgets take units, and every default is untouched', () => {
  it('keeps the per-operation defaults when nothing is given', () => {
    expect(parseWaitBudget(undefined, undefined, IDENTITY_WAIT)).toEqual({ timeoutMs: 5 * 60_000, intervalMs: 3_000 });
    expect(parseWaitBudget(undefined, undefined, TX_WAIT)).toEqual({ timeoutMs: 7 * 60_000, intervalMs: 8_000 });
  });

  it('takes 90s, 6m and 1h for the timeout, and a bare number as minutes', () => {
    expect(parseWaitBudget('90s', undefined, TX_WAIT).timeoutMs).toBe(90_000);
    expect(parseWaitBudget('6m', undefined, TX_WAIT).timeoutMs).toBe(360_000);
    expect(parseWaitBudget('1h', undefined, TX_WAIT).timeoutMs).toBe(3_600_000);
    expect(parseWaitBudget('6', undefined, TX_WAIT).timeoutMs).toBe(360_000);
  });

  it('takes units for the poll interval, and a bare number as seconds', () => {
    expect(parseWaitBudget(undefined, '2s', TX_WAIT).intervalMs).toBe(2_000);
    expect(parseWaitBudget(undefined, '1m', TX_WAIT).intervalMs).toBe(60_000);
    expect(parseWaitBudget(undefined, '5', TX_WAIT).intervalMs).toBe(5_000);
  });

  it('still rejects what it always rejected, with the same codes', () => {
    for (const bad of ['abc', '0', '-1']) {
      expect(() => parseWaitBudget(bad, undefined, TX_WAIT)).toThrowError(/--timeout must be a positive number/);
    }
    expect(() => parseWaitBudget(undefined, '0', TX_WAIT)).toThrowError(/--poll-interval must be a positive number/);
    try { parseWaitBudget('0', undefined, TX_WAIT); } catch (e) { expect(e).toMatchObject({ code: 'INVALID_TIMEOUT', exitCode: 2 }); }
    try { parseWaitBudget(undefined, '0', TX_WAIT); } catch (e) { expect(e).toMatchObject({ code: 'INVALID_POLL_INTERVAL', exitCode: 2 }); }
  });
});
