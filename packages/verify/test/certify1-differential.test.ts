import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { applyPatches, type Patch } from './helpers/s3-mutations.js';
import { judgeCertify, PINS, read, sha256hex, type CertJudged } from './helpers/certify1.js';
import type { ReportSummary } from './helpers/s3.js';

/**
 * The Go-judged differential of the anchored certify form (RB9-F5-5): mutations of the 46 certify1 vectors, each a list of patches applied to a
 * base document's JSON tree - a third of them the certify form's own structural changes (a link dropped, duplicated, swapped or nulled, a receipt
 * or a record given an unknown trailing field, a rootProof removed, the genesis link removed, the version set to 2.0, an item dropped) - and the
 * verdict the validator's proofv2.VerifyPortable gave the patched document. The corpus is written by test/fixtures/s3/gen/xtsgen-certify1.go.txt
 * over the validator at 31393e0 (built with GOWORK=off go build -trimpath from a detached worktree); the TypeScript verifier must reach every one.
 */
const CORPUS = 'test/fixtures/s3-f5-go/certify1-mutations.json.gz';
const CORPUS_SHA256 = '74931523c2ddc97223cd4e2dce053cb087db669be9a3037043455bb58696fabd';
const MINIMUM = 1000;

interface GoExpect {
  v: 'verified' | 'named' | 'certify' | 'plain';
  state?: { code: string; partition: string; block: number };
  code?: string;
  fields?: string[];
  msg?: string;
  summary?: ReportSummary;
}
interface Mutation {
  id: string;
  base: number;
  op: string;
  patches: Patch[];
  expect: GoExpect;
}
interface Corpus {
  format: string;
  validator: string;
  manifestSha256: string;
  bases: string[];
  baseSha256: string[];
  baseExpect: GoExpect[];
  mutations: Mutation[];
  skipped: { panics: number; flaky: number };
}

const raw = readFileSync(new URL('../' + CORPUS, import.meta.url));
const corpus = JSON.parse(gunzipSync(raw).toString('utf8')) as Corpus;
const bases = corpus.bases.map((b) => JSON.parse(read(b).toString('utf8')) as unknown);

/** The summary keys a 2.0 verdict states (Go's report of a 2.0 document is the part of the 2.1 report a 2.0 verifier fills). */
const KEYS_20: (keyof ReportSummary)[] = ['partition', 'anchorBlock', 'certifiedRoot', 'checkBlock', 'setVerdict'];

function differences(want: GoExpect, got: CertJudged): string[] {
  if (got.v === 'fault') return [`a fault, not a refusal: ${got.message}`];
  if (got.v !== want.v) {
    const goName = want.v === 'certify' ? `certify ${want.code}{${want.fields?.join(',')}}` : want.v === 'named' ? `named ${want.state?.code}{${want.state?.partition},${want.state?.block}}` : want.v === 'plain' ? `plain (${want.msg})` : 'verified';
    const hereName = got.v === 'certify' ? `certify ${got.code}{${got.fields.join(',')}}` : got.v === 'named' ? `named ${got.code}{${got.partition},${got.block}}` : got.v === 'plain' ? `plain (${got.message})` : 'verified';
    return [`Go ${goName}; here ${hereName}`];
  }
  if (want.v === 'certify' && got.v === 'certify') {
    if (want.code !== got.code || JSON.stringify(want.fields) !== JSON.stringify(got.fields)) return [`Go ${want.code}{${want.fields?.join(',')}}; here ${got.code}{${got.fields.join(',')}}`];
    if (want.msg !== undefined && got.message !== want.msg) return [`wording: Go ${want.msg}; here ${got.message}`];
  }
  if (want.v === 'named' && got.v === 'named') {
    const h = { code: got.code, partition: got.partition, block: got.block };
    if (JSON.stringify(h) !== JSON.stringify(want.state)) return [`Go ${JSON.stringify(want.state)}; here ${JSON.stringify(h)}`];
  }
  const out: string[] = [];
  if (want.v === 'verified' && got.v === 'verified') {
    const s = want.summary!;
    if (s.version === '') {
      // a 2.0 document: the 2.0 report states these
      for (const k of KEYS_20) if (JSON.stringify((got.summary as unknown as Record<string, unknown>)[k]) !== JSON.stringify(s[k])) out.push(`report.${k}: Go ${JSON.stringify(s[k])}; here ${JSON.stringify((got.summary as unknown as Record<string, unknown>)[k])}`);
    } else {
      for (const k of Object.keys(s) as (keyof ReportSummary)[]) {
        if (JSON.stringify(got.full?.[k]) !== JSON.stringify(s[k])) out.push(`report.${k}: Go ${JSON.stringify(s[k]).slice(0, 300)}; here ${JSON.stringify(got.full?.[k]).slice(0, 300)}`);
      }
    }
  }
  return out;
}

describe('certify1 differential: the corpus is the file the Go program wrote', () => {
  it(`hashes to the pinned file, built over the vectors it names, and holds at least ${MINIMUM} mutations`, () => {
    expect(sha256hex(raw)).toBe(CORPUS_SHA256);
    expect(corpus.format).toBe('certen:certify1-mutations:v1');
    // data-driven: the corpus is over exactly the vectors of the synced manifest (a re-sync that changes them makes the corpus stale: regenerate it)
    const suite = JSON.parse(read('certify1/manifest.json').toString('utf8')) as { cases: { file: string; sha256: string }[] };
    expect(sha256hex(read('certify1/manifest.json')), 'the corpus was written over another manifest: regenerate it').toBe(corpus.manifestSha256);
    expect(corpus.manifestSha256).toBe(PINS.suiteManifestSha256);
    expect(corpus.bases).toEqual(suite.cases.map((c) => `certify1/${c.file}`));
    corpus.bases.forEach((b, i) => {
      expect(sha256hex(read(b)), b).toBe(corpus.baseSha256[i]);
      expect(corpus.baseSha256[i], b).toBe(suite.cases[i]!.sha256);
    });
    expect(corpus.mutations.length).toBeGreaterThanOrEqual(MINIMUM);
    expect(corpus.skipped).toEqual({ panics: 0, flaky: 0 });
    expect(new Set(corpus.mutations.map((m) => m.id)).size).toBe(corpus.mutations.length);
  });

  it('judges every base document as Go does (the identity mutation)', () => {
    const wrong: string[] = [];
    corpus.bases.forEach((b, i) => {
      const d = differences(corpus.baseExpect[i]!, judgeCertify(bases[i]));
      if (d.length > 0) wrong.push(`${b}: ${d.join(' | ')}`);
    });
    expect(wrong).toEqual([]);
  });

  it('covers every verdict class and every certify code the verifier states', () => {
    const classes = new Set(corpus.mutations.map((m) => m.expect.v));
    expect([...classes].sort()).toEqual(['certify', 'named', 'plain', 'verified']);
    const codes = new Set(corpus.mutations.filter((m) => m.expect.v === 'certify').map((m) => m.expect.code));
    for (const c of ['certify_link_missing', 'certify_link_start', 'certify_link_end', 'certify_link_invalid', 'certify_update_replayed', 'certify_item_without_effect', 'certify_update_unproven', 'certify_window_unaccounted']) {
      expect(codes.has(c), c).toBe(true);
    }
  });
});

const CHUNK = 40;
describe('certify1 differential: every mutation reaches the verdict Go gave it', () => {
  for (let c = 0; c < corpus.mutations.length; c += CHUNK) {
    const part = corpus.mutations.slice(c, c + CHUNK);
    it(`mutations ${c + 1}-${c + part.length}`, () => {
      const wrong: string[] = [];
      for (const m of part) {
        const doc = applyPatches(bases[m.base], m.patches);
        const d = differences(m.expect, judgeCertify(doc));
        if (d.length > 0) wrong.push(`${m.id} [${m.op}]: ${d.join(' | ')}`);
      }
      expect(wrong).toEqual([]);
    });
  }
});
