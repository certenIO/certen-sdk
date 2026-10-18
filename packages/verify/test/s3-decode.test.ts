import { describe, expect, it } from 'vitest';
import { applyPatches, type Patch } from './helpers/s3-mutations.js';
import { defineChunks, readCorpus } from './helpers/s3-corpus.js';
import { decodeDifferences, judgeDecode, type DecodeOut } from './helpers/s3-intent.js';
import { EVIDENCE_FIELDS, PAGE_STATE_FIELDS, SET_CHECK_FIELDS, VIEW_KEPT } from '../src/s3/consensus.js';

/**
 * The Go-written decode corpus (cmd/xtsgen decode): a certificate's proof v2 text decoded by UnmarshalCertifiedEvidence (a document that claims
 * 2.1 in full, every other into the member set the rules v14 binary kept) and viewed by Evidence20View, both as json.Marshal writes them. The
 * documents are the evidence of the shared vectors under each version claim (2.1, 2.0, 3.0, none), raw texts that a tree cannot say (null, a
 * scalar, trailing data, duplicate or differently cased keys, nesting to the decoder's limit), and generic mutations. The decoded document
 * and its 2.0 view are compared byte for byte; a refusal is a refusal (the decoder's wording is the decoder's).
 */
const HASH = 'b90e172b6498ef3af139e5a12adb1b32eb98863953e2c73a0e580aa6fe6ac1da';

interface File {
  format: string;
  bases: unknown[];
  baseNames: string[];
  baseExpect: DecodeOut[];
  raw: { name: string; text: string; expect: DecodeOut }[];
  mutations: { id: string; base: number; op: string; patches: Patch[]; expect: DecodeOut }[];
  skipped: { panics: number; flaky: number };
}
const file = readCorpus<File>('go-written/decode-cases.json.gz', HASH);

describe('the decode of a certificate\'s proof v2, against Go', () => {
  it('has the shape the Go program wrote', () => {
    expect(file.format).toBe('certen-sdk/s3-decode-corpus/v1');
    expect(file.skipped.panics).toBe(0);
    expect(file.skipped.flaky).toBe(0);
  });
  it('keeps exactly the members the rules v14 decode kept (the audited lists of Evidence20View)', () => {
    expect([...VIEW_KEPT.evidence].every((k) => EVIDENCE_FIELDS.includes(k))).toBe(true);
    expect([...VIEW_KEPT.setCheck].every((k) => SET_CHECK_FIELDS.includes(k))).toBe(true);
    expect([...VIEW_KEPT.pageState].every((k) => PAGE_STATE_FIELDS.includes(k))).toBe(true);
    expect(EVIDENCE_FIELDS.length).toBeGreaterThan(VIEW_KEPT.evidence.length);
  });
  defineChunks(
    'bases (the shared vectors under each version claim)',
    file.bases.map((b, i) => ({ id: `base:${file.baseNames[i]}`, doc: b, want: file.baseExpect[i]! })),
    (c) => decodeDifferences(c.want, judgeDecode(JSON.stringify(c.doc))),
    25,
  );
  defineChunks(
    'raw texts',
    file.raw.map((r) => ({ id: `raw:${r.name}`, text: r.text, want: r.expect })),
    (c) => decodeDifferences(c.want, judgeDecode(c.text)),
    50,
  );
  defineChunks(
    'mutations',
    file.mutations.map((m) => ({ id: m.id, op: m.op, base: m.base, patches: m.patches, want: m.expect })),
    (c) => decodeDifferences(c.want, judgeDecode(JSON.stringify(applyPatches(file.bases[c.base], c.patches)))).map((d) => `[${c.op}] ${d}`),
    200,
  );
});
