import { describe, expect, it } from 'vitest';
import { VerifyError } from '../src/proof-v2/bytes.js';
import { NamedState, verifyPortableAnyBytes } from '../src/s3/index.js';
import { baseBytes } from './helpers/s3-bytes.js';

/**
 * D7 (V-D): a document whose evidence.majors is 0 while check.majors is above 0 (or the reverse) made the port throw a TypeError
 * (at.get(0)!.clone()). The validator panics on the same input (RB9-D finding 2: there is no Go verdict to copy), so the port's contract is
 * its own and tested here alone: every such document is refused by name, as a plain VerifyError that says which major block is missing,
 * for evidence 2.1 and for evidence 2.0, never a TypeError and never a verdict.
 */
type Mut = (doc: any) => void;

function judge(base: string, mutate: Mut): unknown {
  const doc = JSON.parse(baseBytes(base).toString('utf8'));
  mutate(doc);
  try {
    return verifyPortableAnyBytes(Buffer.from(JSON.stringify(doc)));
  } catch (e) {
    return e;
  }
}

const BASES_21 = [
  'xpartition5/update-account-auth-remove-op-that-leaves-the-voter.json',
  'xpartition2/valid-mixed-partition.json',
  'xpartition4/delegation-chain-depth-2.json',
];
const BASES_20 = ['proofv2/valid.json.gz', 'proofv2/network-update.json.gz'];

const CASES: { name: string; mutate: Mut }[] = [
  { name: 'evidence.majors is 0', mutate: (d) => { d.evidence.majors = 0; } },
  { name: 'evidence.majors is absent', mutate: (d) => { delete d.evidence.majors; } },
  { name: 'evidence.majors is null', mutate: (d) => { d.evidence.majors = null; } },
  { name: 'check.majors is 0', mutate: (d) => { d.evidence.check.majors = 0; } },
  { name: 'check.majors is absent', mutate: (d) => { delete d.evidence.check.majors; } },
  { name: 'both are 0', mutate: (d) => { d.evidence.majors = 0; d.evidence.check.majors = 0; } },
  { name: 'evidence.majors is beyond the archive', mutate: (d) => { d.evidence.majors = d.majors.length + 1; } },
  { name: 'check.majors is beyond the archive', mutate: (d) => { d.evidence.check.majors = d.majors.length + 1; } },
];

describe('a document that names no usable major block is refused by name, never a TypeError', () => {
  for (const [version, bases] of [['2.1', BASES_21], ['2.0', BASES_20]] as const) {
    for (const base of bases) {
      for (const c of CASES) {
        it(`${version} ${base}: ${c.name}`, () => {
          const got = judge(base, c.mutate);
          expect(got, 'a verdict was returned').toBeInstanceOf(Error);
          expect(got).not.toBeInstanceOf(TypeError);
          expect(got).not.toBeInstanceOf(NamedState);
          expect(got).toBeInstanceOf(VerifyError);
          expect((got as Error).message).toMatch(/major/i);
        });
      }
    }
  }
});
