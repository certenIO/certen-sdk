import { describe, expect, it } from 'vitest';
import { applyPatches, type Patch } from './helpers/s3-mutations.js';
import { defineChunks, readCorpus } from './helpers/s3-corpus.js';
import { intentDifferences, judgeCase, type RootOut } from './helpers/s3-intent.js';
import { readS3Json } from './helpers/s3.js';
import { computeGovRootV4, GOVROOT_V4_DOMAIN, GOVROOT_V4_TAGS, govRootV4G1, govRootV4G2 } from '../src/s3/govroot-v4.js';

/**
 * The Go-written intent corpus (cmd/xtsgen intent; test/fixtures/s3/gen/): BindProofV21, the 2.1 branch of ProofV2Root (the facts read from
 * the intent's vote evidence, the binding, govRoot v4) and GovRootV4FromPortable over scenarios - the fixture intent and the real Kermit
 * document - their named cases from pkg/intentcert/bind_v21_test.go, and typed mutations of the bases. Every field of every verdict is the
 * validator's: the named state with its partition and block, the refusal's wording, the roots and all ten slots.
 */
const HASH = '0a195731e5eb0a1f6796c65d7d439415be970e8414c532683e15dec3d53f7d67';

interface File {
  format: string;
  bases: unknown[];
  baseNames: string[];
  baseExpect: RootOut[];
  named: { name: string; case: unknown; expect: RootOut }[];
  mutations: { id: string; base: number; op: string; patches: Patch[]; expect: RootOut }[];
  skipped: { panics: number; noVerdict: number; flaky: number };
}
const file = readCorpus<File>('go-written/intent-cases.json.gz', HASH);

describe('the intent corpus: bases and the named cases of bind_v21_test.go', () => {
  it('has the shape the Go program wrote', () => {
    expect(file.format).toBe('certen-sdk/s3-intent-corpus/v1');
    expect(file.baseNames).toEqual(['synthetic-root', 'synthetic-govroot', 'golden-govroot', 'synthetic-root-20', 'synthetic-bind', 'real-root', 'real-govroot']);
    expect(file.skipped.panics).toBe(0);
    expect(file.skipped.flaky).toBe(0);
  });
  defineChunks(
    'bases',
    file.bases.map((b, i) => ({ id: `base:${file.baseNames[i]}`, doc: b, want: file.baseExpect[i]! })),
    (c) => intentDifferences(c.want, judgeCase(c.doc)),
  );
  defineChunks(
    'named cases',
    file.named.map((n) => ({ id: `named:${n.name}`, doc: n.case, want: n.expect })),
    (c) => intentDifferences(c.want, judgeCase(c.doc)),
  );
  it('refuses by the named states of the Go tests', () => {
    const codes = file.named.filter((n) => n.expect.v === 'named').map((n) => n.expect.state!.code);
    for (const code of [
      'g1_completeness_unproven',
      'g1_foreign_partition_mismatch',
      'g1_authority_missing',
      'g1_book_pagecount_unproven',
      'g1_header_authority_missing',
      'g1_delegate_entry_absent',
      'g1_initiator_page_unproven',
      'g1_certified_page_unproven',
      'g1_page_block_mismatch',
      'g1_block_before_signature',
      'g1_transaction_mismatch',
      'g1_vote_production_unbound',
    ]) {
      expect(codes, code).toContain(code);
    }
  });
});

describe('govRoot v4 reproduces the committed golden', () => {
  const golden = readS3Json('govroot_v4/cross_partition_golden.json') as {
    inputs: Record<string, string>;
    pagesRoot: string;
    votesRoot: string;
    slots: Record<string, string>;
    govRootV4: string;
  };
  it('computes the golden root, both sub-roots and all ten slots from the fixture', () => {
    const got = judgeCase(file.bases[file.baseNames.indexOf('golden-govroot')]);
    expect(got.v).toBe('ok');
    expect(got.root).toBe(golden.govRootV4);
    expect(got.pagesRoot).toBe(golden.pagesRoot);
    expect(got.votesRoot).toBe(golden.votesRoot);
    expect(got.slots).toEqual(golden.slots);
  });
  it('commits G1 under certen:g1:v4 and G2 under certen:g2:v4, and folds the ten slots under certen:govroot:v4', () => {
    const hex = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, 'hex'));
    const toHex = (b: Uint8Array): string => Buffer.from(b).toString('hex');
    expect(GOVROOT_V4_TAGS).toEqual({ g1: 'certen:g1:v4', g2: 'certen:g2:v4' });
    expect(GOVROOT_V4_DOMAIN).toBe('certen:govroot:v4');
    const g1 = govRootV4G1(hex(golden.inputs.g1Hash!), hex(golden.pagesRoot), hex(golden.votesRoot));
    expect(toHex(g1)).toBe(golden.slots.G1);
    expect(toHex(govRootV4G2(hex(golden.inputs.g2Hash!), g1))).toBe(golden.slots.G2);
    const s = golden.slots;
    expect(computeGovRootV4({ l1: s.L1!, l2: s.L2!, l3: s.L3!, l4: s.L4!, g0: s.G0!, g1: s.G1!, g2: s.G2!, keyPage: s.keyPage!, keyBook: s.keyBook!, operationId: s.operationId! })).toBe(golden.govRootV4);
  });
});

defineChunks(
  'typed mutations of the intent bases, against Go',
  file.mutations.map((m) => ({ id: m.id, op: m.op, doc: applyPatches(file.bases[m.base], m.patches), want: m.expect })),
  (c) => intentDifferences(c.want, judgeCase(c.doc)).map((d) => `[${c.op}] ${d}`),
  100,
);
