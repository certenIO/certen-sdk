import { describe, it, expect } from 'vitest';
import { usd } from '../src/output.js';

/**
 * How money is rendered, pinned — because there were two of these and they disagreed.
 *
 * `billing.ts` handled a leading minus; `whoami.ts` did not. The same drawn-down account therefore
 * rendered `-$72.35` in one command and the malformed `$-72.35` in the other, and neither was
 * wrong enough for anyone to notice. A four-line money helper is exactly what gets copied instead
 * of imported, and exactly where the copy is wrong in the case nobody had yet.
 *
 * Two properties are deliberate and worth stating:
 *
 *   - It works on the STRING. The gateway sends fixed-point decimal strings; parsing them into a
 *     float to format them reintroduces the representation error those strings exist to avoid.
 *   - Cents round HALF-UP from the digits below them. The old helper truncated, so a balance of
 *     `-72.355716` displayed as `-$72.35` — a cent kinder to the account than the truth.
 */
describe('rendering money', () => {
  it('formats an ordinary amount', () => {
    expect(usd('12.340000')).toBe('$12.34');
    expect(usd('0.000000')).toBe('$0.00');
    expect(usd('250.000000')).toBe('$250.00');
  });

  it('puts the sign before the currency symbol, not after it', () => {
    // `$-72.35` is what the whoami copy produced. It is not a format anyone writes.
    expect(usd('-72.355716')).toBe('-$72.36');
    expect(usd('-5.000000')).toBe('-$5.00');
  });

  it('rounds the cents rather than truncating them', () => {
    expect(usd('1.005000')).toBe('$1.01');
    expect(usd('0.999000')).toBe('$1.00');
    // Carrying past the decimal point is where a naive implementation produces `$9.100`.
    expect(usd('9.999000')).toBe('$10.00');
  });

  it('does not sign a zero', () => {
    // A residue too small to display is not a debt, and `-$0.00` would be the only place in the
    // CLI where zero has a direction.
    expect(usd('-0.004000')).toBe('$0.00');
    expect(usd('-0.000000')).toBe('$0.00');
  });

  it('handles inputs that are not six-decimal strings', () => {
    // Every caller currently passes the gateway's fixed-point form, but a helper used across
    // twenty call sites should not depend on that.
    expect(usd('5')).toBe('$5.00');
    expect(usd('0.1')).toBe('$0.10');
    expect(usd(42)).toBe('$42.00');
  });

  it('does not lose precision on a large amount', () => {
    // Parsed as a float this is where cents start disappearing. BigInt on the whole part means the
    // dollars survive regardless of magnitude.
    expect(usd('9007199254740993.120000')).toBe('$9007199254740993.12');
  });
});
