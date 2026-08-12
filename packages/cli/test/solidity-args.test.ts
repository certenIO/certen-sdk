import { describe, it, expect } from 'vitest';
import { parseSignature, checkArgs } from '../src/solidity-args.js';

/**
 * Argument checking for `certen call`.
 *
 * The purpose is to fail where the user can see the cause. A wrong argument previously travelled
 * to the proof service and returned as a decoding failure with no connection to the `--arg` that
 * produced it — and on a proof-gated call, a valid proof of the WRONG call is still a valid proof,
 * so a silently mis-encoded argument is worse than an error.
 *
 * The checker is deliberately shallow: it catches what people mistype at a command line, and does
 * not attempt to be an ABI encoder. Encoding is the gateway's job, and a second implementation
 * here would be one more thing to keep in sync.
 */

describe('parsing a function signature', () => {
  it('splits name and types', () => {
    expect(parseSignature('confirm(bytes32)')).toEqual({ name: 'confirm', types: ['bytes32'] });
    expect(parseSignature('transfer(address,uint256)'))
      .toEqual({ name: 'transfer', types: ['address', 'uint256'] });
  });

  it('accepts a no-argument function and tolerates spacing', () => {
    expect(parseSignature('poke()')).toEqual({ name: 'poke', types: [] });
    expect(parseSignature(' transfer( address , uint256 ) '))
      .toEqual({ name: 'transfer', types: ['address', 'uint256'] });
  });

  it('rejects something that is not a signature', () => {
    for (const bad of ['confirm', 'confirm(', '(bytes32)', '']) {
      expect(() => parseSignature(bad)).toThrowError(/not a Solidity function signature/);
    }
  });

  it('rejects a stray comma rather than silently dropping a parameter', () => {
    // Dropping it would shift every later argument by one position, which encodes a different
    // call than the one written — exactly the failure this module exists to prevent.
    expect(() => parseSignature('transfer(address,)')).toThrowError(/empty parameter/);
  });

  it('refuses tuples instead of half-supporting them', () => {
    // `--arg` is a flat list of strings; a tuple has no unambiguous spelling there. Saying so
    // beats accepting a value that will be encoded wrongly.
    expect(() => parseSignature('submit((uint256,address))')).toThrowError(/Tuple arguments/);
  });
});

describe('argument count', () => {
  it('must match the signature exactly', () => {
    const sig = parseSignature('transfer(address,uint256)');
    expect(() => checkArgs(sig, ['0x' + '11'.repeat(20)]))
      .toThrowError(/takes 2 argument\(s\), but 1/);
    expect(() => checkArgs(sig, ['0x' + '11'.repeat(20), '1', '2']))
      .toThrowError(/takes 2 argument\(s\), but 3/);
  });

  it('accepts a no-argument call with no --arg values', () => {
    expect(checkArgs(parseSignature('poke()'), [])).toEqual([]);
  });
});

describe('per-type checks', () => {
  const ADDR = `0x${'11'.repeat(20)}`;
  const B32 = `0x${'ab'.repeat(32)}`;

  it('accepts well-formed values', () => {
    expect(checkArgs(parseSignature('f(address,uint256,bytes32,bool)'), [ADDR, '1000', B32, 'true']))
      .toEqual([ADDR, '1000', B32, 'true']);
  });

  it('rejects an address of the wrong length', () => {
    expect(() => checkArgs(parseSignature('f(address)'), ['0xdEaD']))
      .toThrowError(/not an address/);
  });

  it('rejects a bytes32 that is not 32 bytes, and says how many it got', () => {
    expect(() => checkArgs(parseSignature('f(bytes32)'), ['0xdeadbeef']))
      .toThrowError(/expected 0x followed by 64 hex characters \(32 bytes\), got 8/);
  });

  it('rejects a negative uint', () => {
    expect(() => checkArgs(parseSignature('f(uint256)'), ['-5']))
      .toThrowError(/cannot be negative/);
  });

  it('accepts a negative int', () => {
    expect(checkArgs(parseSignature('f(int256)'), ['-5'])).toEqual(['-5']);
  });

  it('rejects a value that overflows its width', () => {
    expect(() => checkArgs(parseSignature('f(uint8)'), ['256'])).toThrowError(/does not fit in uint8/);
    expect(checkArgs(parseSignature('f(uint8)'), ['255'])).toEqual(['255']);
  });

  it('keeps large integers as strings, losing no precision', () => {
    // A uint256 past 2^53 becomes a different number if it ever touches a JS number. The rest of
    // this codebase keeps amounts as strings for the same reason.
    const huge = '115792089237316195423570985008687907853269984665640564039457584007913129639935';
    expect(checkArgs(parseSignature('f(uint256)'), [huge])).toEqual([huge]);
  });

  it('rejects a hex integer, which is far more often a mistyped bytes32', () => {
    expect(() => checkArgs(parseSignature('f(uint256)'), ['0x10'])).toThrowError(/not a whole number/);
  });

  it('rejects a non-boolean bool', () => {
    expect(() => checkArgs(parseSignature('f(bool)'), ['1'])).toThrowError(/not a bool/);
  });

  it('checks each element of an array', () => {
    expect(() => checkArgs(parseSignature('f(address[])'), [`${ADDR},0xdEaD`]))
      .toThrowError(/not an address/);
    expect(checkArgs(parseSignature('f(address[])'), [`${ADDR},${ADDR}`])).toHaveLength(1);
  });

  it('passes through types it does not model rather than blocking the call', () => {
    // Rejecting an unknown type would make the CLI, not the contract, decide what can be called.
    expect(checkArgs(parseSignature('f(string)'), ['hello'])).toEqual(['hello']);
  });

  it('names the position and type in the message', () => {
    expect(() => checkArgs(parseSignature('f(uint256,address)'), ['1', '0xnope']))
      .toThrowError(/argument 2 \(address\)/);
  });
});
