/**
 * foldKey: the smallest rune of the Unicode simple-case-folding orbit of every rune of a string, the twin of pkg/finality/pins.go foldKey
 * (RB12-OPS-A1). foldKey(a) === foldKey(b) exactly when strings.EqualFold(a, b): the equivalence encoding/json uses to match an object key
 * to a field name, and the one the decoders of the chain sections of the pins file match names and hex digits with.
 *
 * JavaScript has no SimpleFold, and toLowerCase/toUpperCase are NOT it (they apply full case mapping: "ß".toUpperCase() is "SS", and the
 * Kelvin sign, the long s and the final sigma fold with letters that no single conversion reaches), so the orbit table is DATA generated from
 * Go (foldkey-data.ts, with its provenance and digests), and this function only looks runes up in it. The string is walked by CODE POINT
 * (a surrogate pair is one rune); a lone surrogate unit, which a Go string cannot hold, is its own code point and its own orbit.
 */
import { FOLD_PAIRS } from './foldkey-data.js';

const MIN_OF = new Map<number, number>();
for (let i = 0; i < FOLD_PAIRS.length; i += 2) MIN_OF.set(FOLD_PAIRS[i]!, FOLD_PAIRS[i + 1]!);

/** The smallest rune of the simple-folding orbit of r (r itself when its orbit is trivial or r is the smallest). */
export function foldRune(r: number): number {
  return MIN_OF.get(r) ?? r;
}

/** Maps every rune of s to the smallest rune of its simple-folding orbit. */
export function foldKey(s: string): string {
  let out = '';
  for (const ch of s) {
    const m = MIN_OF.get(ch.codePointAt(0)!);
    out += m === undefined ? ch : String.fromCodePoint(m);
  }
  return out;
}
