import { describe, expect, it } from 'vitest';
import { baseBytes, judgeBytes } from './helpers/s3-bytes.js';

/**
 * RB9-F6 step 3, found by the Go-judged byte corpus once the -g documents were its bases: the generated UnmarshalJSON of Accumulate holds every union member
 * as *encoding.JsonUnmarshalWith[T] (and a list of a union as *encoding.JsonUnmarshalListWith[T]); the pointer the decoder starts with carries the Func that
 * decodes the value. encoding/json sets that pointer to nil on a JSON null and allocates a fresh zero one for the next value, whose Func is nil: its
 * UnmarshalJSON panics, and Go's Import recovers and refuses the document as a value Accumulate's codec cannot decode. So a null written BEFORE the value
 * of such a member refuses the document - a message's sub-message, a transaction body, a data entry, a signature, a minor-root record's key signatures -
 * while the same null written after the value (value, null) only empties the member. (A list calls the Func for an element, so a null followed by an EMPTY
 * list decodes: that case, and every other member of every object class, is judged by Go in the nulldup corpus, test/s3-bytes-nulldup-N.test.ts.)
 *
 * The documents are the Go-written xpartition2 fixture with one member written twice; the verdicts of the corpus are Go's, these tests name the rule.
 */
const BASE = 'xpartition2/valid-mixed-partition-g.json';
const CODEC = /a value Accumulate's codec cannot decode \(a member it needs is null or absent\)/;

/** The base document with `text` written just before the first occurrence of `needle` (plus `shift` characters). */
function withBefore(needle: string, text: string, shift = 0): Buffer {
  const raw = baseBytes(BASE).toString('utf8');
  const at = raw.indexOf(needle);
  if (at < 0) throw new Error(`the fixture has no ${needle}`);
  return Buffer.from(raw.slice(0, at + shift) + text + raw.slice(at + shift), 'utf8');
}

describe('a value after a null in a union member refuses the document (Go: a nil Func panic, recovered by Import)', () => {
  it('the base document verifies', () => {
    expect(judgeBytes(baseBytes(BASE)).v).toBe('verified');
  });

  it('a sequenced message: "message":null written before the "message" of "type":"sequenced"', () => {
    const j = judgeBytes(withBefore('"type":"sequenced","message":', '"message":null,', '"type":"sequenced",'.length));
    expect(j.v).toBe('plain');
    expect((j as { message: string }).message).toMatch(CODEC);
  });

  it('a transaction body: "body":null written before the body', () => {
    const j = judgeBytes(withBefore('"body":{', '"body":null,'));
    expect(j.v).toBe('plain');
    expect((j as { message: string }).message).toMatch(CODEC);
  });

  it('the key signatures of a minor-root record (a list): null written before a non-empty list', () => {
    const j = judgeBytes(withBefore('"signatures":[', '"signatures":null,'));
    expect(j.v).toBe('plain');
    expect((j as { message: string }).message).toMatch(CODEC);
  });

  it('the key signatures: null, then an empty list, then the list (the empty list calls nothing, the list after it does)', () => {
    const j = judgeBytes(withBefore('"signatures":[', '"signatures":null,"signatures":[],'));
    expect(j.v).toBe('plain');
    expect((j as { message: string }).message).toMatch(CODEC);
  });

  it('the member name is matched without regard to case: "BODY":null before "body"', () => {
    const j = judgeBytes(withBefore('"body":{', '"BODY":null,'));
    expect(j.v).toBe('plain');
    expect((j as { message: string }).message).toMatch(CODEC);
  });
});
