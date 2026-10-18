import { describe, expect, it } from 'vitest';
import { applyPatches, type Patch } from './helpers/s3-mutations.js';
import { defineChunks, readCorpus } from './helpers/s3-corpus.js';
import { factsDifferences, judgeFacts, type FactsOut } from './helpers/s3-intent.js';

/**
 * The Go-written facts corpus (cmd/xtsgen facts): a vote-evidence document is decoded as a govvote.Evidence (encoding/json) and read by
 * GoverningFactsFromVoteEvidence. The documents are the evidence of the validator's own test, the fixture intent's and the real Kermit
 * document's, and generic mutations of them (any member, any JSON type); the verdict and every fact are the validator's.
 */
const HASH = '00c369f31205d5f5f8e7e246c8f20acacf5e4f36124c877882243c7b6c977c5f';

interface File {
  format: string;
  bases: unknown[];
  baseNames: string[];
  baseExpect: FactsOut[];
  mutations: { id: string; base: number; op: string; patches: Patch[]; expect: FactsOut }[];
  skipped: { panics: number; flaky: number };
}
const file = readCorpus<File>('go-written/facts-cases.json.gz', HASH);

describe('governing facts from vote evidence, against Go', () => {
  it('has the shape the Go program wrote', () => {
    expect(file.format).toBe('certen-sdk/s3-facts-corpus/v1');
    expect(file.skipped.panics).toBe(0);
    expect(file.skipped.flaky).toBe(0);
    expect(file.baseExpect.slice(0, 3).map((e) => e.v)).toEqual(['ok', 'ok', 'ok']);
    // the refusals of the validator's test: no initiating signature (named), evidence for another principal (plain)
    expect(file.baseExpect[3]!.v).toBe('named');
    expect(file.baseExpect[3]!.state!.code).toBe('g1_initiator_page_unproven');
    expect(file.baseExpect[4]!.v).toBe('plain');
  });
  defineChunks(
    'bases',
    file.bases.map((b, i) => ({ id: `base:${file.baseNames[i]}`, doc: b, want: file.baseExpect[i]! })),
    (c) => factsDifferences(c.want, judgeFacts(JSON.stringify(c.doc))),
  );
  defineChunks(
    'mutations',
    file.mutations.map((m) => ({ id: m.id, op: m.op, doc: applyPatches(file.bases[m.base], m.patches), want: m.expect })),
    (c) => factsDifferences(c.want, judgeFacts(JSON.stringify(c.doc))).map((d) => `[${c.op}] ${d}`),
    100,
  );
});
