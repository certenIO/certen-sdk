import { describe, it, expect } from 'vitest';
import { createHash, randomBytes as nodeRandomBytes } from 'node:crypto';
import { sha256 } from '../src/sha256.js';
import { bytesToHex, hexToBytes, concatBytes, base64ToBytes, utf8 } from '../src/bytes.js';
import { randomBytes, randomHex, uuid } from '../src/random.js';

/**
 * The primitives that let the client run without node:crypto or Buffer. They are checked against Node's own implementations, so a
 * mistake here cannot hide behind "it only matters in a browser".
 */
describe('sha256', () => {
  it('matches the FIPS 180-4 vectors', () => {
    expect(bytesToHex(sha256(new Uint8Array()))).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(bytesToHex(sha256(utf8('abc')))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(bytesToHex(sha256(utf8('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'))))
      .toBe('248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1');
    expect(bytesToHex(sha256(utf8('a'.repeat(1_000_000))))).toBe('cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0');
  });

  it('agrees with node:crypto at every length around the block and padding boundaries, and on random data', () => {
    for (let n = 0; n <= 200; n++) {
      const data = new Uint8Array(nodeRandomBytes(n));
      expect(bytesToHex(sha256(data)), `length ${n}`).toBe(createHash('sha256').update(data).digest('hex'));
    }
    for (const n of [1_000, 4_095, 4_096, 4_097, 65_537]) {
      const data = new Uint8Array(nodeRandomBytes(n));
      expect(bytesToHex(sha256(data)), `length ${n}`).toBe(createHash('sha256').update(data).digest('hex'));
    }
  });

  it('does not modify its input', () => {
    const data = utf8('keep me');
    const copy = data.slice();
    sha256(data);
    expect(data).toEqual(copy);
  });
});

describe('bytes', () => {
  it('round-trips hex and accepts a 0x prefix', () => {
    const b = new Uint8Array([0, 1, 15, 16, 255]);
    expect(bytesToHex(b)).toBe('00010f10ff');
    expect(hexToBytes('00010f10ff')).toEqual(b);
    expect(hexToBytes('0x00010F10FF')).toEqual(b);
    expect(hexToBytes('')).toEqual(new Uint8Array());
  });

  it('refuses odd-length or non-hex input instead of silently truncating it, as Buffer.from(x, "hex") does', () => {
    expect(() => hexToBytes('abc')).toThrow(/not valid hex/);
    expect(() => hexToBytes('zz')).toThrow(/not valid hex/);
    expect(Buffer.from('abz1', 'hex').length).toBe(1); // the lenient behaviour this replaces
  });

  it('concatenates', () => {
    expect(concatBytes(new Uint8Array([1]), new Uint8Array(), new Uint8Array([2, 3]))).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('decodes standard and URL-safe base64, with or without padding, like Buffer does', () => {
    for (const n of [0, 1, 2, 3, 4, 31, 32, 33, 100]) {
      const data = new Uint8Array(nodeRandomBytes(n));
      const b64 = Buffer.from(data).toString('base64');
      expect(base64ToBytes(b64), `n=${n}`).toEqual(data);
      expect(base64ToBytes(b64.replace(/=+$/, '')), `n=${n} unpadded`).toEqual(data);
      expect(base64ToBytes(Buffer.from(data).toString('base64url')), `n=${n} url-safe`).toEqual(data);
    }
    expect(() => base64ToBytes('not base64!')).toThrow(/not valid base64/);
  });
});

describe('random', () => {
  it('gives the requested length and different values each call', () => {
    expect(randomBytes(16)).toHaveLength(16);
    expect(randomHex(8)).toMatch(/^[0-9a-f]{16}$/);
    expect(randomHex(8)).not.toBe(randomHex(8));
  });

  it('makes RFC 4122 v4 UUIDs, also when the runtime has no crypto.randomUUID (an insecure browser context)', () => {
    const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    expect(uuid()).toMatch(V4);
    const real = globalThis.crypto;
    const without = { getRandomValues: real.getRandomValues.bind(real) };
    Object.defineProperty(globalThis, 'crypto', { value: without, configurable: true });
    try {
      const ids = new Set(Array.from({ length: 200 }, () => uuid()));
      expect(ids.size).toBe(200);
      for (const id of ids) expect(id).toMatch(V4);
    } finally {
      Object.defineProperty(globalThis, 'crypto', { value: real, configurable: true });
    }
  });

  it('refuses to make a value from Math.random when the runtime has no Web Crypto', () => {
    const real = globalThis.crypto;
    Object.defineProperty(globalThis, 'crypto', { value: undefined, configurable: true });
    try {
      expect(() => randomHex(8)).toThrow(/no Web Crypto/);
      expect(() => uuid()).toThrow(/no Web Crypto/);
    } finally {
      Object.defineProperty(globalThis, 'crypto', { value: real, configurable: true });
    }
  });
});
