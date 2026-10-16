import { describe, it, expect } from 'vitest';
import { toChecksumAddress, evmAddressProblem } from '../src/index.js';

/**
 * EIP-55: the checksum in an address's capitalisation.
 *
 * The recipient of `certen send` is the one value nothing downstream can correct: the signature authorises exactly what was asked for, and
 * what was asked for was a typo. So a mixed-case address that does not match its own hash is refused before anything is signed. The vectors
 * are the ones EIP-55 itself publishes, so a wrong keccak or a wrong nibble rule fails here and not on someone's money.
 */

const SPEC = [
  '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed',
  '0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359',
  '0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB',
  '0xD1220A0cf47c7B9Be7A2E6BA89F429762e7b9aDb',
];

describe('toChecksumAddress', () => {
  for (const address of SPEC) {
    it(`reproduces the EIP-55 vector ${address.slice(0, 10)}…`, () => {
      expect(toChecksumAddress(address.toLowerCase())).toBe(address);
      expect(toChecksumAddress(address.toUpperCase().replace('0X', '0x'))).toBe(address);
      // Without the 0x prefix is accepted too (it is how some tools print an address) and gains it.
      expect(toChecksumAddress(address.slice(2).toLowerCase())).toBe(address);
      // Idempotent: the checksum form of a checksum form is itself.
      expect(toChecksumAddress(address)).toBe(address);
    });
  }

  it('throws on anything that is not 40 hex digits, rather than inventing a checksum for it', () => {
    expect(() => toChecksumAddress('0x1234')).toThrow(/40 hex digits/);
    expect(() => toChecksumAddress(`0x${'g'.repeat(40)}`)).toThrow(/40 hex digits/);
    expect(() => toChecksumAddress('')).toThrow(/40 hex digits/);
  });
});

describe('evmAddressProblem', () => {
  for (const address of SPEC) {
    it(`accepts the correctly capitalised ${address.slice(0, 10)}…`, () => {
      expect(evmAddressProblem(address)).toBeUndefined();
    });
  }

  it('accepts all lower case and all upper case, which carry no checksum and so make no claim to be wrong', () => {
    // Refusing these would refuse every address copied from a tool that does not capitalise, and that is most of them.
    for (const address of SPEC) {
      expect(evmAddressProblem(address.toLowerCase())).toBeUndefined();
      expect(evmAddressProblem(`0x${address.slice(2).toUpperCase()}`)).toBeUndefined();
    }
  });

  it('refuses a mixed-case address whose capitalisation was disturbed, and names the correct spelling', () => {
    // One letter's case flipped: the shape of a mistyped or badly copied address.
    const flipped = SPEC[0]!.replace('aAeb', 'AAeb');
    expect(flipped).not.toBe(SPEC[0]);
    const problem = evmAddressProblem(flipped);
    expect(problem).toMatch(/checksum/i);
    expect(problem).toContain(SPEC[0]);
    // It never silently corrects: the problem is reported, the corrected spelling is only suggested.
    expect(problem).toMatch(/all lower case/);
  });

  it('catches every single-letter case flip of a vector, not only some', () => {
    const base = SPEC[1]!;
    let caught = 0;
    let letters = 0;
    for (let i = 2; i < base.length; i += 1) {
      const c = base[i]!;
      if (!/[a-fA-F]/.test(c)) continue;
      letters += 1;
      const flipped = base.slice(0, i) + (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase()) + base.slice(i + 1);
      // A flip that leaves the address all one case would be indistinguishable from an unchecksummed address; the vector has both cases throughout.
      if (evmAddressProblem(flipped)) caught += 1;
    }
    expect(letters).toBeGreaterThan(10);
    expect(caught).toBe(letters);
  });

  it('refuses what is not an address at all', () => {
    expect(evmAddressProblem('0x1234')).toMatch(/not an EVM address/);
    expect(evmAddressProblem(`0x${'a'.repeat(41)}`)).toMatch(/not an EVM address/);
    expect(evmAddressProblem(`0x${'a'.repeat(39)}`)).toMatch(/not an EVM address/);
    expect(evmAddressProblem(`0x${'z'.repeat(40)}`)).toMatch(/not an EVM address/);
    expect(evmAddressProblem('a'.repeat(40))).toMatch(/not an EVM address/);
    expect(evmAddressProblem(` ${SPEC[0]}`)).toMatch(/not an EVM address/);
    expect(evmAddressProblem('')).toMatch(/not an EVM address/);
  });

  it('refuses a value that is not a string, instead of coercing it', () => {
    for (const v of [undefined, null, 5, {}, [], 12345678901234567890n as unknown]) {
      expect(evmAddressProblem(v)).toMatch(/not an EVM address/);
    }
  });
});
