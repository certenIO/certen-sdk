import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolveWait, parseWaitBudget, IDENTITY_WAIT, TX_WAIT } from '../src/wait.js';
import { movesValue, faucetFor } from '../src/funding-guard.js';
import { setJsonMode, resetOutput } from '../src/output.js';

/**
 * Waiting policy, in isolation from the network.
 *
 * The rule under test is the one most likely to be got wrong by a later change: human mode waits,
 * `--json` does not, and an explicit flag beats both. That asymmetry is deliberate — a script
 * written against the old fire-and-forget behaviour must not silently start blocking for minutes
 * because the human default changed.
 */

beforeEach(() => { resetOutput(); });
afterEach(() => { resetOutput(); });

describe('who waits by default', () => {
  it('waits in human mode, because "not ready yet" is not the user\'s problem to manage', () => {
    setJsonMode(false);
    expect(resolveWait([])).toBe(true);
  });

  it('does NOT wait in --json mode, so existing scripts keep their timing', () => {
    setJsonMode(true);
    expect(resolveWait([])).toBe(false);
  });

  it('honours an explicit --wait even in --json mode', () => {
    setJsonMode(true);
    expect(resolveWait(['node', 'certen', '--json', 'identity', 'create', '--wait'])).toBe(true);
  });

  it('honours an explicit --no-wait even in human mode', () => {
    setJsonMode(false);
    expect(resolveWait(['node', 'certen', 'identity', 'create', '--no-wait'])).toBe(false);
  });

  it('lets --no-wait win when both appear, since refusing to block is the safer reading', () => {
    setJsonMode(false);
    expect(resolveWait(['--wait', '--no-wait'])).toBe(false);
  });
});

describe('wait budgets are validated before any network call', () => {
  it('applies the per-operation defaults when nothing is given', () => {
    expect(parseWaitBudget(undefined, undefined, IDENTITY_WAIT)).toEqual({
      timeoutMs: 5 * 60_000, intervalMs: 3_000,
    });
    expect(parseWaitBudget(undefined, undefined, TX_WAIT)).toEqual({
      timeoutMs: 7 * 60_000, intervalMs: 8_000,
    });
  });

  it('gives a transaction longer than an identity — a proof cycle is real validator work', () => {
    expect(TX_WAIT.timeoutMin).toBeGreaterThan(IDENTITY_WAIT.timeoutMin);
    // 60-110s of proof work plus queueing. Anything under a couple of minutes would always fire.
    expect(TX_WAIT.timeoutMin * 60).toBeGreaterThan(110);
  });

  it('rejects a non-numeric or non-positive timeout as a usage error', () => {
    for (const bad of ['abc', '0', '-1']) {
      expect(() => parseWaitBudget(bad, undefined, TX_WAIT))
        .toThrowError(/--timeout must be a positive number/);
    }
    try {
      parseWaitBudget('0', undefined, TX_WAIT);
    } catch (e) {
      expect(e).toMatchObject({ code: 'INVALID_TIMEOUT', exitCode: 2 });
    }
  });

  it('rejects a bad poll interval the same way', () => {
    try {
      parseWaitBudget(undefined, '0', TX_WAIT);
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toMatchObject({ code: 'INVALID_POLL_INTERVAL', exitCode: 2 });
    }
  });
});

describe('which intents need a funded account', () => {
  it('treats a positive amount as value-moving', () => {
    expect(movesValue({ amount: '1000' })).toBe(true);
    expect(movesValue({ amount: '0.5' })).toBe(true);
  });

  it('treats zero or absent as not value-moving — a contract call need not forward value', () => {
    expect(movesValue({})).toBe(false);
    expect(movesValue({ amount: '0' })).toBe(false);
    expect(movesValue({ amount: null })).toBe(false);
  });

  it('does not claim to understand a non-numeric amount', () => {
    // Unparseable is not evidence of zero. Assume it moves value and let the gateway judge the
    // shape; the opposite default would skip the guard on exactly the malformed input that most
    // needs a second look.
    expect(movesValue({ amount: 'lots' })).toBe(true);
  });
});

describe('faucets', () => {
  it('knows one for every supported chain, since the refusal is only useful with the fix', () => {
    for (const chain of ['ethereum-sepolia', 'base-sepolia', 'arbitrum-sepolia']) {
      expect(faucetFor(chain)).toMatch(/^https:\/\//);
    }
  });

  it('returns nothing for a chain it has no faucet for, rather than inventing a URL', () => {
    expect(faucetFor('optimism-sepolia')).toBeUndefined();
  });
});
