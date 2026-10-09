import { describe, expect, it } from 'vitest';
import { encodeCall, AbiUnsupported } from '../src/index.js';

/** The Solidity ABI specification's own worked examples, and ERC-20 transfer. */
describe('encodeCall', () => {
  it('baz(uint32,bool) from the Solidity ABI spec', () => {
    expect(encodeCall('baz(uint32,bool)', [69, true])).toBe('0xcdcd77c0' + '45'.padStart(64, '0') + '1'.padStart(64, '0'));
  });
  it('bar(bytes3[2]) from the spec', () => {
    expect(encodeCall('bar(bytes3[2])', [['0x616263', '0x646566']])).toBe('0xfce353f6' + '616263'.padEnd(64, '0') + '646566'.padEnd(64, '0'));
  });
  it('sam(bytes,bool,uint256[]) with dynamic types, from the spec', () => {
    const want = '0xa5643bf2'
      + '60'.padStart(64, '0') + '1'.padStart(64, '0') + 'a0'.padStart(64, '0')
      + '4'.padStart(64, '0') + '64617665'.padEnd(64, '0')
      + '3'.padStart(64, '0') + '1'.padStart(64, '0') + '2'.padStart(64, '0') + '3'.padStart(64, '0');
    expect(encodeCall('sam(bytes,bool,uint256[])', ['dave', true, [1, 2, 3]])).toBe(want);
  });
  it('ERC-20 transfer', () => {
    expect(encodeCall('transfer(address,uint256)', ['0x32422604b797f0a135d8F28B84Ce72EefA185FC8', '1000000'])).toBe(
      '0xa9059cbb' + '32422604b797f0a135d8f28b84ce72eefa185fc8'.padStart(64, '0') + 'f4240'.padStart(64, '0'));
  });
  it('no arguments, and a string', () => {
    expect(encodeCall('ping()')).toBe('0x5c36b186');
    expect(encodeCall('f(string)', ['hi'])).toMatch(/^0x[0-9a-f]{8}0{62}200{62}02/);
  });
  it('refuses what it cannot encode, by name', () => {
    for (const [sig, args] of [['f((uint256,uint256))', []], ['f(uint7)', [1]], ['f(uint8)', [256]], ['f(uint8)', []], ['f(address)', ['0x12']], ['nope', []], ['f(uint256[2])', [[1]]]] as const) {
      expect(() => encodeCall(sig, args as unknown[]), sig).toThrow(AbiUnsupported);
    }
  });
});
