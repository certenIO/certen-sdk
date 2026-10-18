import { describe, expect, it } from 'vitest';
import { foldEqual, foldName, foldRune } from '../src/s3/fold.js';
import { FOLD_PAIRS, FOLD_SOURCE } from '../src/s3/fold-table.js';
import { readS3Json } from './helpers/s3.js';

/**
 * Go's simple case folding, which encoding/json uses to match a key to a field name. The table is generated from the file Go wrote
 * (fold-orbits.json: unicode.SimpleFold of every rune, reduced to the smallest rune of each fold set), so what is checked here is that the
 * committed TypeScript table is that file, and that the relation built on it has the properties the byte-level corpus exercises.
 */
interface FoldFile {
  format: string;
  go: string;
  unicode: string;
  folded: [number, number][];
}
const file = readS3Json<FoldFile>('go-written/fold-orbits.json');

const longS = String.fromCharCode(0x17f);
const kelvin = String.fromCharCode(0x212a);
const arrow = String.fromCharCode(0x2192);

describe('the fold table is the one Go wrote', () => {
  it('holds exactly the rune pairs of the file', () => {
    expect(file.format).toBe('certen-sdk/s3-fold-orbits/v1');
    expect([...FOLD_PAIRS]).toEqual(file.folded.flat());
    expect(FOLD_SOURCE).toEqual({ go: file.go, unicode: file.unicode, runes: file.folded.length });
  });

  it('folds every rune of the file to the smallest rune of its set, and that rune to itself', () => {
    for (const [r, m] of file.folded) {
      expect(foldRune(r), `U+${r.toString(16)}`).toBe(m);
      expect(foldRune(m), `U+${m.toString(16)}`).toBe(m);
      expect(m).toBeLessThan(r);
    }
  });
});

describe('the relation encoding/json matches keys by', () => {
  it('sends the long s and the Kelvin sign where Go does, which toLowerCase does not', () => {
    expect(foldEqual(`role${longS}`, 'roles')).toBe(true);
    expect(foldEqual(`ROLE${longS}`, 'roles')).toBe(true);
    expect(foldEqual(`bloc${kelvin}`, 'block')).toBe(true);
    expect(`role${longS}`.toLowerCase() === 'roles').toBe(false);
    expect(`bloc${kelvin}`.toLowerCase() === 'block').toBe(true);
    expect(foldName(longS)).toBe('S');
    expect(foldName(kelvin)).toBe('K');
  });

  it('is an equivalence on ASCII letters and leaves other characters alone', () => {
    expect(foldEqual('Hash', 'hASH')).toBe(true);
    expect(foldEqual('hash', 'hasn')).toBe(false);
    expect(foldName(`a1_-/${arrow}`)).toBe(`A1_-/${arrow}`);
    expect(foldEqual('ß', 'SS')).toBe(false);
  });
});
