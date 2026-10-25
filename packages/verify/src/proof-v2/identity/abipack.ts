// The few ABI encodings the steps recompute (abi.encode of addresses and strings; the validator set root). Encoding only; decoding is abidec.ts.
import { concat, padWord, utf8, wordOf, zeros } from './bytes.js';

/** An address (20 bytes) or a string/bytes value as an abi.encode argument. */
export type PackPart = Uint8Array | { s: Uint8Array };
export const str = (s: string | Uint8Array): { s: Uint8Array } => ({ s: typeof s === 'string' ? utf8(s) : s });

export function abiPack(...parts: PackPart[]): Uint8Array {
  const head: Uint8Array[] = [];
  const tail: Uint8Array[] = [];
  let tailLen = 0;
  const headSize = 32 * parts.length;
  for (const p of parts) {
    if (p instanceof Uint8Array) { head.push(padWord(p)); continue; }
    head.push(wordOf(headSize + tailLen));
    const t = concat(wordOf(p.s.length), p.s, zeros(Math.ceil(p.s.length / 32) * 32 - p.s.length));
    tail.push(t);
    tailLen += t.length;
  }
  return concat(...head, ...tail);
}

/** abi.encode(address[], uint256[], uint256, uint256). */
export function abiPackRoot(addrs: Uint8Array[], powers: bigint[], num: bigint, den: bigint): Uint8Array {
  const a = concat(wordOf(addrs.length), ...addrs.map(padWord));
  const p = concat(wordOf(powers.length), ...powers.map(wordOf));
  return concat(wordOf(128), wordOf(128 + a.length), wordOf(num), wordOf(den), a, p);
}
