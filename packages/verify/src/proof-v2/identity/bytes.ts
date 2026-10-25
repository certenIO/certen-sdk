// Byte, word and number helpers of the S8 verifier. A hash, a storage word or a topic is a 32-byte Uint8Array; an address is 20 bytes.
import { keccak_256 } from '@noble/hashes/sha3';
import { toHex } from './canon.js';

export const hex = toHex;
export const concat = (...p: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(p.reduce((n, x) => n + x.length, 0));
  let o = 0;
  for (const x of p) (out.set(x, o), (o += x.length));
  return out;
};
export const eq = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((x, i) => x === b[i]);
export const isZero = (a: Uint8Array): boolean => a.every((x) => x === 0);
export const keccak = (...p: Uint8Array[]): Uint8Array => keccak_256(concat(...p));
export const zeros = (n: number): Uint8Array => new Uint8Array(n);
export const bigOf = (b: Uint8Array): bigint => b.reduce((n, x) => (n << 8n) | BigInt(x), 0n);
export const wordOf = (v: bigint | number): Uint8Array => {
  let n = BigInt(v);
  const out = new Uint8Array(32);
  for (let i = 31; i >= 0 && n > 0n; i--, n >>= 8n) out[i] = Number(n & 0xffn);
  return out;
};
/** An address (or any shorter value) left-padded into a 32-byte word. */
export const padWord = (b: Uint8Array): Uint8Array => concat(zeros(32 - b.length), b);
export const low20 = (w: Uint8Array): Uint8Array => w.slice(12);
export const addrWord = (a: Uint8Array): Uint8Array => padWord(a);
export const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

/** "0x" + lower-case hex only (the canonical spelling of the inputs files). */
export function unhex(s: string): Uint8Array {
  const m = /^0x([0-9a-f]*)$/.exec(s);
  if (!m || m[1]!.length % 2 !== 0) throw new Error(`${JSON.stringify(s)} is not 0x-prefixed lowercase hex`);
  return Uint8Array.from(m[1]!.match(/../g) ?? [], (h) => parseInt(h, 16));
}
export function unhexN(s: string, n: number): Uint8Array {
  const b = unhex(s);
  if (b.length !== n) throw new Error(`${JSON.stringify(s)} is not ${n} bytes of hex`);
  return b;
}
/** A canonical decimal string of a uint64. */
export function undec(s: string): bigint {
  if (s === '' || (s.length > 1 && s[0] === '0') || !/^[0-9]+$/.test(s)) throw new Error(`${JSON.stringify(s)} is not a canonical decimal string`);
  const v = BigInt(s);
  if (v >= 1n << 64n) throw new Error(`${JSON.stringify(s)} overflows uint64`);
  return v;
}
/** The "0x" + lower-case hex form of an address, as the manifest and the vocabulary spell it. */
export const lowerHex = (b: Uint8Array): string => '0x' + toHex(b);
/** The address of a manifest string (any case); throws when it is not 20 bytes. */
export function addrOf(s: string): Uint8Array {
  const m = /^0x([0-9a-fA-F]{40})$/.exec(s);
  if (!m) throw new Error(`${JSON.stringify(s)} is not an address`);
  return Uint8Array.from(m[1]!.match(/../g)!, (h) => parseInt(h, 16));
}
export const hashOf = (s: string): Uint8Array => {
  const m = /^0x([0-9a-fA-F]{64})$/.exec(s);
  if (!m) throw new Error(`${JSON.stringify(s)} is not a 32-byte hash`);
  return Uint8Array.from(m[1]!.match(/../g)!, (h) => parseInt(h, 16));
};
