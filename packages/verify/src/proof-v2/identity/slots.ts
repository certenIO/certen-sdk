// Solidity storage-slot arithmetic (twin of slots.go): mapping slots, struct members, array elements, short and long bytes/strings.
import { bigOf, concat, isZero, keccak, padWord, wordOf, zeros } from './bytes.js';

export class SlotError extends Error {
  constructor(readonly reason: string, readonly detail = '') {
    super(`storage slot: ${reason}${detail ? ': ' + detail : ''}`);
  }
}
export const slotIndex = (n: number | bigint): Uint8Array => wordOf(n);
export const keyAddress = (a: Uint8Array): Uint8Array => padWord(a);
export const keyUint64 = (v: bigint): Uint8Array => wordOf(v);
export const keyBytes32 = (b: Uint8Array): Uint8Array => Uint8Array.from(b);
export const keyBytes4 = (b: Uint8Array): Uint8Array => concat(b.slice(0, 4), zeros(28));
export const mappingSlot = (key: Uint8Array, base: Uint8Array): Uint8Array => keccak(key, base);
export const mappingSlotAt = (key: Uint8Array, base: number): Uint8Array => mappingSlot(key, slotIndex(base));
export const pageSlot = (base: number, book: Uint8Array, page: bigint): Uint8Array => mappingSlot(keyUint64(page), mappingSlotAt(keyBytes32(book), base));
const MOD = 1n << 256n;
const addToSlot = (base: Uint8Array, n: bigint): Uint8Array => wordOf((bigOf(base) + n) % MOD);
export const memberSlot = (base: Uint8Array, word: number): Uint8Array => addToSlot(base, BigInt(word));
export const arrayDataStart = (base: number): Uint8Array => keccak(slotIndex(base));
export function arrayElementSlot(base: number, index: bigint, elementBytes: number): { slot: Uint8Array; byteOffset: number } {
  if (elementBytes < 1 || elementBytes > 32) throw new SlotError('element_bytes', `${elementBytes} bytes`);
  const per = BigInt(Math.floor(32 / elementBytes));
  return { slot: addToSlot(arrayDataStart(base), index / per), byteOffset: Number(index % per) * elementBytes };
}

export interface DynHead { long: boolean; length: bigint; short: Uint8Array }
/** The head word of a bytes/string slot: a short value (at most 31 bytes, in the word) or the length of a long one. */
export function parseDynHead(word: Uint8Array, maxLen: bigint): DynHead {
  const low = word[31]!;
  if ((low & 1) === 0) {
    if (low > 62) throw new SlotError('dyn_head_invalid', `short head low byte 0x${low.toString(16).padStart(2, '0')} is an even length above 31`);
    const n = low / 2;
    if (!isZero(word.slice(n, 31))) throw new SlotError('dyn_padding', `short value of ${n} bytes has non-zero padding`);
    if (BigInt(n) > maxLen) throw new SlotError('dyn_too_long', `${n} bytes, limit ${maxLen}`);
    return { long: false, length: BigInt(n), short: word.slice(0, n) };
  }
  if (!isZero(word.slice(0, 24))) throw new SlotError('dyn_too_long', 'length does not fit 64 bits');
  const n = bigOf(word.slice(24)) >> 1n;
  if (n < 32n) throw new SlotError('dyn_head_invalid', `long head for the short length ${n}`);
  if (n > maxLen) throw new SlotError('dyn_too_long', `${n} bytes, limit ${maxLen}`);
  return { long: true, length: n, short: new Uint8Array(0) };
}
export const dynWordCount = (h: DynHead): bigint => (h.long ? (h.length + 31n) / 32n : 0n);
export const dynDataSlot = (slot: Uint8Array, i: bigint): Uint8Array => addToSlot(keccak(slot), i);
export function assemble(h: DynHead, words: Uint8Array[]): Uint8Array {
  if (!h.long) {
    if (words.length !== 0) throw new SlotError('dyn_word_count', `a short value takes no data words, got ${words.length}`);
    return Uint8Array.from(h.short);
  }
  if (BigInt(words.length) !== dynWordCount(h)) throw new SlotError('dyn_word_count', `want ${dynWordCount(h)} data words, got ${words.length}`);
  const all = concat(...words);
  if (!isZero(all.slice(Number(h.length)))) throw new SlotError('dyn_padding', `non-zero byte after the ${h.length} value bytes`);
  return all.slice(0, Number(h.length));
}
