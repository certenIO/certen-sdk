import { describe, expect, it } from 'vitest';
import { bytesEvidenceLength, judgeBytes } from './helpers/s3-bytes.js';
import { dupMembers } from './helpers/dup-members.js';

/**
 * RB9-F6 step 3, review V-Q D1: a member that occurs twice with different values of the RIGHT type. encoding/json does not replace: it decodes the second occurrence
 * INTO what the first made. A slice is decoded slot by slot into the slice already there (a struct element keeps the members the new element does not name; the
 * length becomes the new array's; the slots past it are not cleared, so a later longer array decodes into what an earlier longer one left there; an empty array
 * and a null start a new slice), a map takes the entries and drops none, and the discriminator of a union is decoded on every occurrence, so a name that is not the
 * enum's is refused wherever it stands. The verifier replaced the slice and the map and took the last discriminator.
 *
 * The documents are test/helpers/dup-members.ts (the Go-written xpartition2 fixture valid-mixed-partition-g.json, which verifies, with one member written again);
 * every verdict and evidence length is Go's (cmd/xtsgen judgefile at validator pv2/rb9-f6-genesis-link-required c93f5ac). The corpus that judges the class
 * everywhere is Go-written: test/s3-bytes-dupdiff-N.test.ts (17738 cases).
 */
const VERIFIED = '';
const want: [string, number][] = [
  [VERIFIED, 16180], // the base document
  ['g1_completeness_unproven', 11414], // pages: [{}] after the list: one page left, the first
  ['receipt does not validate', 15880], // receipt entries: [{}] after the list: one entry left, the first
  [VERIFIED, 16180], // [{}] then n empty objects: slots 1..n-1 keep the entries the list left there
  ['receipt does not validate', 15834], // [] then n empty objects: a new slice, the entries are empty
  ['receipt does not validate', 15834], // null then n empty objects: a new slice, the entries are empty
  [VERIFIED, 16180], // anchors: the first anchor again: the map keeps the others
  [VERIFIED, 16180], // keys: [{}] after the list
  ['Type ""', -1], // "" before the name: Go says 'major 1: invalid Transaction Type ""', the wording is not part of the verdict
  ['Type "x"', -1], // "x" after the name
];

describe('a member given twice with different right-typed values is decoded into what the first occurrence made', () => {
  it('has one expectation for each document', () => {
    expect(want.length).toBe(dupMembers.length);
  });
  dupMembers.forEach(([name, doc], i) => {
    it(name, () => {
      const d = doc();
      const [prefix, evLen] = want[i]!;
      const j = judgeBytes(d);
      if (prefix === VERIFIED) expect(j.v).toBe('verified');
      else {
        const msg = j.v === 'plain' || j.v === 'named' ? j.message : '';
        expect(j.v === 'verified', `verified, want ${prefix}`).toBe(false);
        expect(msg.includes(prefix), msg).toBe(true);
      }
      // Go's length is -1 where its Import refuses the document (the corpus compares a length only when Go has one)
      if (evLen >= 0) expect(bytesEvidenceLength(d)).toBe(evLen);
    });
  });
});
