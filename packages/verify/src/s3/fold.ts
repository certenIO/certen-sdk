/**
 * Go's simple case folding, as encoding/json uses it to match an object key to a struct field (fold.go foldName: ASCII letters upper-cased, every
 * other rune replaced by the smallest rune of its unicode.SimpleFold set) and as strings.EqualFold uses it. The fold sets come from Go
 * (fold-table.ts, generated); JavaScript's toLowerCase is a different relation (it sends U+017F, the long s, nowhere, and U+0130 to two code points).
 */
import { FOLD_PAIRS } from './fold-table.js';

let table: Map<number, number> | undefined;
function folds(): Map<number, number> {
  if (!table) {
    table = new Map();
    for (let i = 0; i < FOLD_PAIRS.length; i += 2) table.set(FOLD_PAIRS[i]!, FOLD_PAIRS[i + 1]!);
  }
  return table;
}

/** foldRune: the smallest rune of r's fold set. */
export function foldRune(cp: number): number {
  return folds().get(cp) ?? cp;
}

/** foldName: the key as encoding/json compares it. */
export function foldName(s: string): string {
  let out = '';
  for (const ch of s) out += String.fromCodePoint(foldRune(ch.codePointAt(0)!));
  return out;
}

/** The relation encoding/json matches keys by, once exact equality has failed (and strings.EqualFold). */
export function foldEqual(a: string, b: string): boolean {
  return a === b || foldName(a) === foldName(b);
}
