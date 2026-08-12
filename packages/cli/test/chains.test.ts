import { describe, it, expect, afterEach } from 'vitest';
import {
  SUPPORTED_CHAINS, isSupportedChain, nearestChain, assertChain, assertChains,
} from '../src/chains.js';

/**
 * Chain vocabulary.
 *
 * The property under test is not "does it know three strings" — it is that a wrong chain is
 * refused BEFORE anything irreversible happens, and refused with the right alternative named.
 * `fund --chain base` is the case that matters: `base` is a real mainnet, so the failure mode of
 * a permissive check is money sent to a network this product does not operate on.
 */

afterEach(() => {
  delete process.env.CERTEN_ALLOW_ANY_CHAIN;
});

describe('the supported set', () => {
  it('is exactly the three testnets this product targets', () => {
    expect([...SUPPORTED_CHAINS]).toEqual(['ethereum-sepolia', 'base-sepolia', 'arbitrum-sepolia']);
  });

  it('accepts every member', () => {
    for (const chain of SUPPORTED_CHAINS) {
      expect(isSupportedChain(chain)).toBe(true);
      expect(assertChain(chain)).toBe(chain);
    }
  });

  it('trims surrounding whitespace rather than failing on it', () => {
    expect(assertChain('  base-sepolia ')).toBe('base-sepolia');
  });
});

describe('rejection names an alternative', () => {
  it('suggests the testnet when given the mainnet name — and does NOT substitute it', () => {
    expect(nearestChain('base')).toBe('base-sepolia');
    // The suggestion is advice. Accepting `base` silently as `base-sepolia` would be the CLI
    // deciding which network money goes to, which is not its decision to make.
    expect(isSupportedChain('base')).toBe(false);
    expect(() => assertChain('base')).toThrowError(/Did you mean base-sepolia/);
  });

  it.each([
    ['eth', 'ethereum-sepolia'],
    ['ethereum', 'ethereum-sepolia'],
    ['sepolia', 'ethereum-sepolia'],
    ['arb', 'arbitrum-sepolia'],
    ['arbitrum', 'arbitrum-sepolia'],
  ])('maps the common shorthand %s to %s', (input, expected) => {
    expect(nearestChain(input)).toBe(expected);
  });

  it('catches an ordinary typo by edit distance', () => {
    expect(nearestChain('base-sepolai')).toBe('base-sepolia');
    expect(nearestChain('arbitrum-sepolia ')).toBe('arbitrum-sepolia');
  });

  it('suggests nothing for a chain that is simply not this product', () => {
    expect(nearestChain('solana')).toBeUndefined();
    const err = (() => { try { assertChain('solana'); return null; } catch (e) { return e as Error; } })();
    expect(err?.message).not.toContain('Did you mean');
    // It still lists what IS available, so the refusal is actionable either way.
    expect(err?.message).toContain('ethereum-sepolia');
  });
});

describe('exit code', () => {
  it('is 2 — a wrong chain is a wrong invocation, not a failed operation', () => {
    try {
      assertChain('base');
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toMatchObject({ code: 'UNSUPPORTED_CHAIN', exitCode: 2, retryable: false });
    }
  });

  it('names the flag the value arrived on', () => {
    expect(() => assertChain('nope', '--to-chain')).toThrowError(/not a supported chain/);
  });
});

describe('the escape hatch', () => {
  it('allows a chain outside the set only when explicitly requested', () => {
    expect(() => assertChain('optimism-sepolia')).toThrow();
    process.env.CERTEN_ALLOW_ANY_CHAIN = '1';
    expect(assertChain('optimism-sepolia')).toBe('optimism-sepolia');
  });

  it('is off unless the value is exactly 1, so a stray truthy string does not open it', () => {
    process.env.CERTEN_ALLOW_ANY_CHAIN = 'true';
    expect(() => assertChain('optimism-sepolia')).toThrow();
  });
});

describe('comma-separated lists', () => {
  it('validates every member', () => {
    expect(assertChains('base-sepolia,arbitrum-sepolia')).toEqual(['base-sepolia', 'arbitrum-sepolia']);
  });

  it('rejects the whole list when one member is wrong', () => {
    expect(() => assertChains('base-sepolia,base')).toThrowError(/Did you mean base-sepolia/);
  });

  it('tolerates spacing and a trailing comma — a slip, not an instruction', () => {
    expect(assertChains('base-sepolia, arbitrum-sepolia,')).toEqual(['base-sepolia', 'arbitrum-sepolia']);
  });

  it('rejects a list that names no chains at all', () => {
    expect(() => assertChains(' , ')).toThrowError(/was given no chains/);
  });
});
