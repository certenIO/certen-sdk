/**
 * RB12-TS-OPSSYNC item 1: foldKey is the equivalence encoding/json (strings.EqualFold) matches names with, the orbit of a rune under Unicode
 * simple case folding, reduced to its smallest rune. JS has no SimpleFold, so the table is DATA generated from Go (foldkey-data.ts) and these
 * tests hold the TypeScript function to Go on EVERY code point: the digest of the whole mapping was computed by Go
 * (pkg/finality/pins.go foldKey, origin/pv2/rb12-ops-a1 @4c6b8d26, go1.25.1, Unicode 15.0.0) and is recomputed here from foldKey itself.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  FOLD_GO_VERSION,
  FOLD_MAPPING_SHA256,
  FOLD_NON_TRIVIAL_RUNES,
  FOLD_ORBIT_COUNT,
  FOLD_ORBITS_SHA256,
  FOLD_PAIRS,
  FOLD_PAIRS_SHA256,
  FOLD_UNICODE_VERSION,
} from '../../src/proof-v2/finality/foldkey-data.js';
import { foldKey, foldRune } from '../../src/proof-v2/finality/foldkey.js';

const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

describe('the generated table', () => {
  it('names the toolchain it came from and holds the integrity digest of its own pairs', () => {
    expect(FOLD_GO_VERSION).toBe('go1.25.1');
    expect(FOLD_UNICODE_VERSION).toBe('15.0.0');
    const b = Buffer.alloc(FOLD_PAIRS.length * 4);
    FOLD_PAIRS.forEach((v, i) => b.writeUInt32BE(v, i * 4));
    expect(sha(b)).toBe(FOLD_PAIRS_SHA256);
  });

  it('is ascending, every minimum is smaller than its rune, and every minimum folds to itself', () => {
    expect(FOLD_PAIRS.length % 2).toBe(0);
    const mins = new Set<number>();
    let prev = -1;
    for (let i = 0; i < FOLD_PAIRS.length; i += 2) {
      const r = FOLD_PAIRS[i]!;
      const m = FOLD_PAIRS[i + 1]!;
      expect(r).toBeGreaterThan(prev);
      expect(m).toBeLessThan(r);
      prev = r;
      mins.add(m);
    }
    for (const m of mins) expect(foldRune(m)).toBe(m);
    // every orbit has exactly one minimum that is not a pair key, so the recorded counts follow from the pairs
    expect(mins.size).toBe(FOLD_ORBIT_COUNT);
    expect(FOLD_PAIRS.length / 2 + mins.size).toBe(FOLD_NON_TRIVIAL_RUNES);
  });

  it('has the orbits digest Go computed (members of every orbit, ascending, by ascending minimum)', () => {
    const orbits = new Map<number, number[]>();
    for (let i = 0; i < FOLD_PAIRS.length; i += 2) {
      const m = FOLD_PAIRS[i + 1]!;
      const list = orbits.get(m) ?? [m];
      list.push(FOLD_PAIRS[i]!);
      orbits.set(m, list);
    }
    const mins = [...orbits.keys()].sort((a, b) => a - b);
    const words: number[] = [];
    for (const m of mins) {
      const members = orbits.get(m)!.sort((a, b) => a - b);
      words.push(m, members.length, ...members);
    }
    const b = Buffer.alloc(words.length * 4);
    words.forEach((v, i) => b.writeUInt32BE(v, i * 4));
    expect(sha(b)).toBe(FOLD_ORBITS_SHA256);
  });
});

describe('foldKey agrees with Go on every code point', () => {
  it('the mapping of all 1,114,112 code points, by foldRune and by foldKey of the one-character string, has the digest Go computed', () => {
    const byRune = Buffer.alloc(0x110000 * 4);
    const byKey = Buffer.alloc(0x110000 * 4);
    for (let cp = 0; cp < 0x110000; cp++) {
      byRune.writeUInt32BE(foldRune(cp), cp * 4);
      // a lone surrogate is not a rune a Go string can hold; foldKey keeps it as it is, the orbit of a surrogate being itself
      const s = String.fromCodePoint(cp);
      const k = foldKey(s);
      byKey.writeUInt32BE(k.codePointAt(0)!, cp * 4);
      if (k.length !== (k.codePointAt(0)! > 0xffff ? 2 : 1)) throw new Error(`foldKey(U+${cp.toString(16)}) is not one code point`);
    }
    expect(sha(byRune)).toBe(FOLD_MAPPING_SHA256);
    expect(sha(byKey)).toBe(FOLD_MAPPING_SHA256);
  });

  it('the special cases Go records: Kelvin sign, long s, dotted I, dotless i, final sigma, capital sharp s, ohm, micro, ...', () => {
    // [rune, orbit minimum] as printed by the Go generator (unicode.SimpleFold orbit minimum), plus the trivial orbits it names
    const goRecorded: [number, number][] = [
      [0x41, 0x41], [0x4b, 0x4b], [0x53, 0x53], [0x61, 0x41], [0x6b, 0x4b], [0x73, 0x53], [0xb5, 0xb5], [0xdf, 0xdf], [0x130, 0x130], [0x131, 0x131],
      [0x17f, 0x53], [0x1c4, 0x1c4], [0x1c5, 0x1c4], [0x1c6, 0x1c4], [0x39c, 0xb5], [0x3a3, 0x3a3], [0x3a9, 0x3a9], [0x3b8, 0x398], [0x3bc, 0xb5],
      [0x3c2, 0x3a3], [0x3c3, 0x3a3], [0x3c9, 0x3a9], [0x3d1, 0x398], [0x3f4, 0x398], [0x1e61, 0x1e60], [0x1e9b, 0x1e60], [0x1e9e, 0xdf],
      [0x2126, 0x3a9], [0x212a, 0x4b], [0xfffd, 0xfffd], [0x10400, 0x10400], [0x10428, 0x10400],
    ];
    for (const [r, m] of goRecorded) expect(foldRune(r), `U+${r.toString(16)}`).toBe(m);
    // the named ones, by key
    expect(foldKey('K')).toBe('K'); // Kelvin sign
    expect(foldKey('ſ')).toBe('S'); // long s
    expect(foldKey('İ')).toBe('İ'); // dotted capital I has no orbit under SIMPLE folding
    expect(foldKey('ı')).toBe('ı'); // dotless i neither
    expect(foldKey('i')).toBe('I');
    expect(foldKey('ς')).toBe('Σ'); // final sigma folds with Sigma and sigma
    expect(foldKey('σ')).toBe('Σ');
    expect(foldKey('ẞ')).toBe('ß'); // capital sharp s folds with sharp s
    expect(foldKey('ß')).toBe('ß');
  });
});

describe('foldKey on keys', () => {
  const same = (a: string, b: string): boolean => foldKey(a) === foldKey(b);

  it('is the strings.EqualFold equivalence on the pairs of the Go test and the folds of the brief', () => {
    for (const [a, b, want] of [
      ['0xAB', '0xab', true],
      ['logic_pins', 'Logic_Pins', true],
      ['k', 'K', true],
      ['s', 'ſ', true],
      ['a', 'b', false],
      ['0xab', '0xac', false],
      ['', '', true],
      ['k', 'K', true], // Kelvin
      ['K', 'K', true],
      ['s', 'S', true],
      ['ſ', 'S', true],
      ['ς', 'Σ', true],
      ['ς', 'σ', true],
      ['ẞ', 'ß', true],
      ['ẞ', 'ss', false], // simple folding: one rune to one rune
      ['İ', 'i', false],
      ['ı', 'I', false],
      ['ß', 'SS', false],
      ['ab', 'a', false],
      ['\u{10400}', '\u{10428}', true], // astral: Deseret
      ['0xK', '0xk', true],
    ] as [string, string, boolean][]) {
      expect(same(a, b), `${JSON.stringify(a)} vs ${JSON.stringify(b)}`).toBe(want);
    }
  });

  it('walks by code point: an astral rune folds as one rune and a surrogate pair is never split', () => {
    expect(foldKey('a\u{10428}b')).toBe('A\u{10400}B');
    expect(foldKey('𐐨')).toBe('𐐀');
    // a lone surrogate unit is its own code point, with the orbit of itself, and keeps its neighbours
    expect(foldKey('\ud801')).toBe('\ud801');
    expect(foldKey('a\udc28b')).toBe('A\udc28B');
    expect(foldKey('\udc28\ud801')).toBe('\udc28\ud801');
  });

  it('is idempotent, and maps ASCII letters to upper case (the minimum of an ASCII orbit)', () => {
    for (const s of ['abc', 'ABC', 'aBcKſ', '0x' + 'aB'.repeat(32), 'ςσΣ']) expect(foldKey(foldKey(s))).toBe(foldKey(s));
    expect(foldKey('abcXYZ019_-')).toBe('ABCXYZ019_-');
  });

  it('hostile: a 4 MiB key and a key of a million distinct code points are folded exactly, in one linear pass', () => {
    const big = 'aBKſ'.repeat(1 << 20); // 4 Mi units
    const out = foldKey(big);
    expect(out.length).toBe(big.length);
    expect(out.slice(0, 8)).toBe('ABKSABKS');
    expect(out.endsWith('ABKS')).toBe(true);
    expect(sha(Buffer.from(out))).toBe(sha(Buffer.from('ABKS'.repeat(1 << 20))));
    let all = '';
    for (let cp = 0x20; cp < 0x110000; cp++) if (cp < 0xd800 || cp > 0xdfff) all += String.fromCodePoint(cp);
    const folded = foldKey(all);
    expect([...folded].length).toBe([...all].length);
    expect(folded.codePointAt(0x41 - 0x20)).toBe(0x41);
    expect(folded.codePointAt(0x61 - 0x20)).toBe(0x41); // 'a' folds to 'A'
  });
});
