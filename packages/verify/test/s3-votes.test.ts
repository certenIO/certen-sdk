import { describe, expect, it } from 'vitest';
import { applyPatches, type Patch } from './helpers/s3-mutations.js';
import { defineChunks, readCorpus } from './helpers/s3-corpus.js';
import { voteOf } from './helpers/s3-intent.js';
import { encodeVoteV4, VOTE_RECORD_TAG_V4 } from '../src/s3/govroot-v4.js';

/**
 * The Go-written corpus of EncodeVoteV4 (cmd/xtsgen votes): the canonical length-prefixed encoding of one vote record that govRoot v4
 * commits, over the fixture's votes (a sequenced vote with hops and a production, an inline vote, the empty vote), the real Kermit document's,
 * and typed mutations. The encoding is compared byte for byte; a record that does not encode is refused with Go's wording.
 */
const HASH = '09e2a98fa69fd81ee913e23a147e06b3aa49c82d8f7e4542659b471bd789ec51';

interface Enc {
  hex?: string;
  err?: string;
}
interface File {
  format: string;
  bases: unknown[];
  baseNames: string[];
  baseExpect: Enc[];
  mutations: { id: string; base: number; op: string; patches: Patch[]; expect: Enc }[];
}
const file = readCorpus<File>('go-written/votes-cases.json.gz', HASH);

function encode(doc: unknown): Enc {
  try {
    return { hex: Buffer.from(encodeVoteV4(voteOf(doc))).toString('hex') };
  } catch (e) {
    return { err: (e as Error).message };
  }
}
const differences = (want: Enc, got: Enc): string[] => (want.hex === got.hex && want.err === got.err ? [] : [`Go ${JSON.stringify(want).slice(0, 300)}; here ${JSON.stringify(got).slice(0, 300)}`]);

describe('EncodeVoteV4, against Go', () => {
  it('commits under the v4 vote tag', () => {
    expect(VOTE_RECORD_TAG_V4).toBe('certen:g1:v4:vote:');
  });
  it('has the shape the Go program wrote', () => {
    expect(file.format).toBe('certen-sdk/s3-votes-corpus/v1');
    expect(file.baseExpect.every((e) => e.hex !== undefined)).toBe(true);
  });
  defineChunks(
    'bases',
    file.bases.map((b, i) => ({ id: `base:${file.baseNames[i]}`, doc: b, want: file.baseExpect[i]! })),
    (c) => differences(c.want, encode(c.doc)),
  );
  defineChunks(
    'mutations',
    file.mutations.map((m) => ({ id: m.id, op: m.op, doc: applyPatches(file.bases[m.base], m.patches), want: m.expect })),
    (c) => differences(c.want, encode(c.doc)).map((d) => `[${c.op}] ${d}`),
    200,
  );
});
