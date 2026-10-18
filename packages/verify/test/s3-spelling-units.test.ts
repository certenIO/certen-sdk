import { describe, expect, it } from 'vitest';
import { goHexStrict, goLower, goTrimSpace, VerifyError } from '../src/proof-v2/bytes.js';
import { normalizeExecutorPartition } from '../src/s3/executor.js';
import { bit, deriveChain } from '../src/s3/chains.js';
import type { ChainRoot } from '../src/s3/evidence.js';
import { normalizePartition } from '../src/sigtypes/gate.js';

/**
 * The sites of the "spelling" class that no Go-judged document can reach (a partition string compared in an executor table, a chain height
 * of 2^53 or more), pinned to what Go's strings.TrimSpace / strings.ToLower / `count |= 1 << uint(i)` do. The Go-judged corpus of every other
 * hex or name member is bytes-cases-pathspell.json.gz (test/s3-bytes-pathspell-*.test.ts).
 */
describe('strings.TrimSpace and strings.ToLower, not String.prototype.trim', () => {
  it('trims U+0085, U+00A0, tab, newline and U+3000 and keeps U+FEFF, U+180E and U+200B', () => {
    for (const c of ['\u0085', ' ', '\t', '\n', '　', ' ', ' ']) expect(goTrimSpace(`${c}bvn1${c}`)).toBe('bvn1');
    for (const c of ['﻿', '᠎', '​']) expect(goTrimSpace(`${c}bvn1`)).toBe(`${c}bvn1`);
  });
  it('lower-cases U+0130 to "i" as Go does', () => {
    expect(goLower('İX')).toBe('ix');
  });
  it('normalizePartition (govsig.NormalizePartition) trims as Go does', () => {
    expect(normalizePartition('\u0085DN\t')).toBe('directory');
    expect(normalizePartition('  BVN1\n')).toBe('bvn1');
    expect(normalizePartition('﻿dn')).toBe('﻿dn'); // JavaScript's trim() would give "directory"
    expect(normalizePartition('﻿BVN1')).toBe('﻿bvn1');
  });
  it('normalizeExecutorPartition (proofv2.NormalizeExecutorPartition) trims as Go does', () => {
    expect(normalizeExecutorPartition('\u0085acc://bvn-BVN2.acme/ ')).toBe('bvn2');
    expect(normalizeExecutorPartition('\tDirectory ')).toBe('directory');
    expect(normalizeExecutorPartition('﻿acc://bvn-BVN2.acme')).toBe('﻿acc://bvn-bvn2'); // the prefix is not at the start, so it stays; JavaScript's trim() would give "bvn2"
    expect(normalizeExecutorPartition('﻿dn')).not.toBe('directory');
  });
});

describe('hex.DecodeString for the members Go reads strictly', () => {
  const h = 'ab'.repeat(32);
  it('accepts either case and refuses a 0x or 0X prefix, space and a wrong length', () => {
    expect(Buffer.from(goHexStrict(h, 'x', 32)).toString('hex')).toBe(h);
    expect(Buffer.from(goHexStrict(h.toUpperCase(), 'x', 32)).toString('hex')).toBe(h);
    for (const bad of [`0x${h}`, `0X${h}`, ` ${h} `, `${h}\n`, `${h}0`, h.slice(2), '']) expect(() => goHexStrict(bad, 'x', 32)).toThrow(VerifyError);
  });
});

describe('a chain height is a uint64 (count |= 1 << uint(i))', () => {
  const entry = 'cd'.repeat(32);
  const chain = (index: number, countBig: bigint): ChainRoot => {
    const pending: (string | null)[] = new Array<string | null>(index).fill(null);
    pending.push(entry);
    return { name: 'main', pending, count: Number(countBig), countBig, anchor: '' };
  };
  it('bit() shifts as Go does: a shift of 64 or more is 0', () => {
    expect(bit(0)).toBe(1n);
    expect(bit(53)).toBe(1n << 53n);
    expect(bit(63)).toBe(1n << 63n);
    expect(bit(64)).toBe(0n);
    expect(bit(1000)).toBe(0n);
  });
  it('derives and compares the exact count above 2^53', () => {
    expect(deriveChain(chain(60, 1n << 60n)).count).toBe(2 ** 60);
    // 2^60 + 1 has the same nearest double as 2^60; Go compares the uint64 and refuses it
    expect(() => deriveChain(chain(60, (1n << 60n) + 1n))).toThrow(VerifyError);
    expect(() => deriveChain(chain(63, (1n << 63n) + 1n))).toThrow(VerifyError);
  });
  it('an entry at bit 64 or more adds nothing to the count and is still folded into the anchor', () => {
    const c = chain(70, 0n);
    expect(deriveChain(c).count).toBe(0);
    expect(() => deriveChain(chain(70, 1n))).toThrow(VerifyError);
  });
});
