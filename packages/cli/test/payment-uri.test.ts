import { describe, it, expect } from 'vitest';
import {
  buildPaymentUri, toSmallestUnit, estimateWait, humanDuration, preciseDuration,
} from '../src/payment-uri.js';

/**
 * The arithmetic behind a payment link, pinned.
 *
 * Funding asked someone to carry a token contract, a chain, a treasury address and an exact amount
 * from a terminal into a wallet by hand. **A mistyped recipient is the one error in this product
 * that loses real money and cannot be reversed.**
 *
 * Every failure this file guards against is invisible on screen. An off-by-one-decimal amount looks
 * like a plausible number. A reversed token/recipient pair produces a URI a wallet will happily
 * open. A wait estimate that silently returns zero looks like a fast chain. None of them announce
 * themselves, which is the whole reason for testing the conversion rather than the rendering.
 */

const TARGET = {
  chain_id: 84532,
  token_address: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
  token_decimals: 6,
  deposit_address: '0x1111111111111111111111111111111111111111',
};

describe('converting an amount to the token smallest unit', () => {
  it('converts whole and fractional dollars exactly', () => {
    expect(toSmallestUnit('25', 6)).toBe('25000000');
    expect(toSmallestUnit('25.50', 6)).toBe('25500000');
    expect(toSmallestUnit('0.01', 6)).toBe('10000');
    expect(toSmallestUnit('0.000001', 6)).toBe('1');
  });

  it('does not lose a unit to floating point', () => {
    // `25.10 * 1e6` is 25099999.999999996 in IEEE-754, which truncates to 25099999 — a payment one
    // unit short of the amount attribution matches on. The deposit arrives and is never credited,
    // and nothing on either side says why.
    expect(toSmallestUnit('25.10', 6)).toBe('25100000');
    expect(toSmallestUnit('1.005', 6)).toBe('1005000');
    expect(toSmallestUnit('8.87', 6)).toBe('8870000');
  });

  it('survives an amount larger than a float can hold precisely', () => {
    // BigInt, so the low digits cannot quietly disappear at scale.
    expect(toSmallestUnit('9007199254740993.123456', 6)).toBe('9007199254740993123456');
  });

  it('handles an 18-decimal token', () => {
    expect(toSmallestUnit('1', 18)).toBe('1000000000000000000');
    expect(toSmallestUnit('0.5', 18)).toBe('500000000000000000');
  });

  it('drops trailing zeros beyond the token precision, and only those', () => {
    // `25.5000000` in a 6-decimal token is exactly 25.5 — safe. Anything else is not.
    expect(toSmallestUnit('25.5000000', 6)).toBe('25500000');
  });

  it('refuses to round away real precision', () => {
    // Silently truncating here would change what the user pays, which is worse than refusing.
    expect(() => toSmallestUnit('0.0000001', 6)).toThrow(/more precision/);
    expect(() => toSmallestUnit('1.1234567', 6)).toThrow(/more precision/);
  });

  it('refuses anything that is not a positive decimal', () => {
    for (const bad of ['-5', 'abc', '', '1e6', '1.2.3', ' ']) {
      expect(() => toSmallestUnit(bad, 6), bad).toThrow();
    }
  });
});

describe('building the EIP-681 payment request', () => {
  it('puts the TOKEN before the @ and the recipient in address=', () => {
    // The shape is counter-intuitive and reversing it produces a URI a wallet opens happily and
    // that transfers nothing — or calls an unknown method on the treasury address.
    const uri = buildPaymentUri(TARGET, '25.50');
    expect(uri).toBe(
      'ethereum:0x036CbD53842c5426634e7929541eC2318f3dCF7e@84532'
      + '/transfer?address=0x1111111111111111111111111111111111111111&uint256=25500000',
    );
  });

  it('carries every field from the gateway verbatim', () => {
    // The transcription this exists to eliminate: nothing may be re-derived or reformatted.
    const uri = buildPaymentUri(TARGET, '10');
    expect(uri).toContain(TARGET.token_address);
    expect(uri).toContain(TARGET.deposit_address);
    expect(uri).toContain(`@${TARGET.chain_id}`);
  });

  it('encodes the amount in the token smallest unit, not dollars', () => {
    // `uint256=25.5` is not a uint256. A wallet given one either rejects it or, worse, reads it as
    // 25 base units — a transfer of 0.000025 USDC against a 25.50 invoice.
    const uri = buildPaymentUri(TARGET, '25.50');
    const units = new URL(uri.replace('ethereum:', 'https://')).searchParams.get('uint256');
    expect(units).toBe('25500000');
    expect(units).not.toContain('.');
  });

  it('refuses a malformed address rather than emitting a link to nowhere', () => {
    expect(() => buildPaymentUri({ ...TARGET, deposit_address: '0x123' }, '1'))
      .toThrow(/deposit_address is not an address/);
    expect(() => buildPaymentUri({ ...TARGET, token_address: 'not-an-address' }, '1'))
      .toThrow(/token_address is not an address/);
  });

  it('refuses a chain id that is not numeric', () => {
    // A slug where a numeric id belongs produces `ethereum:0x…@base-sepolia`, which no wallet
    // resolves — and the failure appears in the wallet, long after the CLI reported success.
    expect(() => buildPaymentUri({ ...TARGET, chain_id: 'base-sepolia' as never }, '1'))
      .toThrow(/numeric EVM chain id/);
  });
});

describe('estimating how long the money takes to land', () => {
  it('turns confirmations into a duration per chain', () => {
    // 3 confirmations is ~36s on Ethereum Sepolia at 12s blocks and ~6s on Base at 2s.
    expect(estimateWait('ethereum-sepolia', 3)?.seconds).toBe(36);
    expect(estimateWait('base-sepolia', 3)?.seconds).toBe(6);
  });

  it('names the chain the estimate came from', () => {
    // So the number is checkable rather than magic.
    expect(estimateWait('base-sepolia', 3)?.basis).toBe('base-sepolia');
  });

  it('returns null for a chain with no known cadence', () => {
    // A wrong estimate on the command someone is already waiting on is worse than none: it is the
    // number they decide to interrupt against, and interrupting a funding flow is how people send
    // twice.
    expect(estimateWait('some-new-chain', 3)).toBeNull();
  });

  it('returns null rather than zero for a nonsensical confirmation count', () => {
    expect(estimateWait('base-sepolia', 0)).toBeNull();
    expect(estimateWait('base-sepolia', NaN)).toBeNull();
  });

  it('never estimates less than a second on a fast chain', () => {
    // Arbitrum's sub-second blocks would otherwise round to "about 0 seconds", which reads as a bug.
    const fast = estimateWait('arbitrum-sepolia', 1);
    expect(fast?.seconds).toBeGreaterThanOrEqual(1);
    expect(fast?.text).not.toContain('0 second');
  });
});

describe('rendering durations', () => {
  it('is coarse for an estimate', () => {
    // False precision on an estimate reads as a promise.
    expect(humanDuration(36)).toBe('about 36 seconds');
    expect(humanDuration(1)).toBe('about 1 second');
    expect(humanDuration(95)).toBe('about 2 minutes');
    expect(humanDuration(3600)).toBe('about 1 hour');
  });

  it('is exact for a deadline', () => {
    // A quote with 20 seconds left must not render as "about 4 minutes".
    expect(preciseDuration(252)).toBe('4m 12s');
    expect(preciseDuration(20)).toBe('20s');
    expect(preciseDuration(120)).toBe('2m');
    expect(preciseDuration(3660)).toBe('1h 1m');
    expect(preciseDuration(-5)).toBe('0s');
  });
});
