import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { applyPatches, numberText, type Patch } from './s3-mutations.js';
import { judgeCertify, judgeCertifyText, PINS, read, sha256hex, type CertJudged } from './certify1.js';
import type { ReportSummary } from './s3.js';

/**
 * The Go-judged differential of the anchored certify form (RB9-F5-5): mutations of the 46 certify1 vectors, each a list of patches applied to a
 * base document's JSON tree - a third of them the certify form's own structural changes (a link dropped, duplicated, swapped or nulled, a receipt
 * or a record given an unknown trailing field, a rootProof removed, the genesis link removed, the version set to 2.0, an item dropped) - and the
 * verdict the validator's proofv2.VerifyPortable gave the patched document. The corpus is written by test/fixtures/s3/gen/xtsgen-certify1.go.txt
 * over the validator at d1bbe40 (built with GOWORK=off go build -trimpath from a detached worktree); the TypeScript verifier must reach every one.
 */
const CORPUS = 'test/fixtures/s3-f5-go/certify1-mutations.json.gz';
const CORPUS_SHA256 = '59ad1cbb1aec4e9f85ed86ea63c302e9d054a7b7ef01026facee5548c406d34b';
const MINIMUM = 10000;
/** The evidence 2.0 documents the sweeps also reach (the same program reads them from the fixtures of the earlier corpora: XTS_EXTRA_BASES). */
const EXTRA_BASES = ['../proofv2/valid.json.gz', '../proofv2/network-update.json.gz'];

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

const raw = readFileSync(new URL('../../' + CORPUS, import.meta.url));
const corpus = JSON.parse(gunzipSync(raw).toString('utf8')) as Corpus;
const bases = corpus.bases.map((b) => JSON.parse((b.endsWith('.gz') ? gunzipSync(read(b)) : read(b)).toString('utf8')) as unknown);

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

const CHUNK = 40;
/**
 * What judging a mutation costs grows with the size of its base: the 2.0 fixture proofv2/valid.json.gz (1.5 MB) takes over a second a mutation on a quiet host and
 * several under load, the certify1 vectors a few tens of milliseconds. A chunk is one test: it closes at CHUNK mutations or when their bases add up to CHUNK_CHARS
 * characters of JSON (about five seconds of work alone), and has a time limit of its own that grows with them (RB9-F6 review V-Q D2: forty mutations of valid.json.gz
 * were a minute of work against the package's 20 s default, and passed only with a longer limit).
 */
const CHUNK_CHARS = 6_000_000;
const CHUNK_BASE_MS = 60_000;
const CHUNK_MS_PER_MEGACHAR = 30_000;
const baseChars = new Map<number, number>();
const charsOf = (base: number): number => {
  let n = baseChars.get(base);
  if (n === undefined) {
    n = JSON.stringify(bases[base]).length;
    baseChars.set(base, n);
  }
  return n;
};

/**
 * One shard of the differential (of `total`): the shards are separate test files so the suite runs them in parallel (at most four vitest processes at
 * once); every mutation is in exactly one shard, and the shard of index 0 also states what the corpus is and what it covers.
 */
export function defineDifferential(index: number, total: number): void {
  if (index === 0) {
  describe('certify1 differential: the corpus is the file the Go program wrote', () => {
    it(`hashes to the pinned file, built over the vectors it names, and holds at least ${MINIMUM} mutations`, () => {
      expect(sha256hex(raw)).toBe(CORPUS_SHA256);
      expect(corpus.format).toBe('certen:certify1-mutations:v1');
      // data-driven: the corpus is over exactly the vectors of the synced manifest (a re-sync that changes them makes the corpus stale: regenerate it)
      const suite = JSON.parse(read('certify1/manifest.json').toString('utf8')) as { cases: { file: string; sha256: string }[] };
      expect(sha256hex(read('certify1/manifest.json')), 'the corpus was written over another manifest: regenerate it').toBe(corpus.manifestSha256);
      expect(corpus.manifestSha256).toBe(PINS.suiteManifestSha256);
      expect(corpus.bases).toEqual([...suite.cases.map((c) => `certify1/${c.file}`), ...EXTRA_BASES]);
      corpus.bases.forEach((b, i) => {
        expect(sha256hex(read(b)), b).toBe(corpus.baseSha256[i]);
        if (i < suite.cases.length) expect(corpus.baseSha256[i], b).toBe(suite.cases[i]!.sha256);
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

  describe('certify1 differential: the sweeps are exhaustive per path class', () => {
    const sweeps = corpus.mutations.filter((m) => m.id.includes('#sweep'));
    const klass = (m: Mutation): string => (m.patches[0]!.path as (string | number)[]).map((x) => (typeof x === 'number' ? '*' : x)).join('/');
    const epilogues = sweeps.filter((m) => m.op.startsWith('sweep-epilogue-'));

    it('aims a trailing field at every receipt member the verifier imports, in both document forms', () => {
      const classes = new Set(epilogues.map(klass));
      for (const c of [
        'evidence/receipt/$epilogue',
        'evidence/anchor/receipt/$epilogue',
        'evidence/pages/*/receipt/$epilogue',
        'evidence/anchors/acc://bvn-BVN2.acme/receipt/$epilogue',
        'evidence/votes/*/receipt/$epilogue',
        'evidence/votes/*/hops/*/receipt/$epilogue',
        'evidence/links/*/$epilogue',
        'evidence/genesisLink/$epilogue',
        'evidence/certify/*/rootProof/receipt/$epilogue',
        'evidence/certify/*/updates/*/receipt/$epilogue',
        'evidence/check/hops/*/updates/*/receipt/$epilogue',
        'evidence/certify/*/$epilogue',
      ]) {
        expect(classes.has(c), c).toBe(true);
      }
      // every field number a trailing field can open with (0-8, 31-33, 64, with a value), the bare bytes that open one, field 4 as a root proof, and both
      // forms (the 2.0 documents are the extra bases)
      const spelled = new Set(epilogues.map((m) => m.op.split('@')[0]!.replace('sweep-epilogue-', '')));
      for (const e of [0, 1, 2, 3, 4, 5, 6, 7, 8, 31, 32, 33, 64].map((n) => n.toString(16).padStart(2, '0') + '01aa').concat(['01', '03', '04', '21', 'ff', '80', '8001', '0400', '04020100', '0601', '06020a0b', '05010a', '07010a'])) {
        expect(spelled.has(e), e).toBe(true);
      }
      // on every receipt member (the receipt, the anchor's, a page's, an anchor's, a vote's, a hop's, an update's, a root proof's), an entry and a record
      for (const c of ['evidence/receipt/$epilogue', 'evidence/certify/*/$epilogue', 'evidence/check/hops/*/$epilogue']) expect(new Set(epilogues.map(klass)).has(c), c).toBe(true);
      expect(epilogues.some((m) => bases[m.base] === bases[corpus.bases.indexOf(EXTRA_BASES[0]!)])).toBe(true);
    });

    it('sets the anchor block and root chain index, and every other number, to the edge values of a uint64; a value that is not one fails to decode in Go', () => {
      const u64 = sweeps.filter((m) => m.op.startsWith('sweep-u64-'));
      for (const last of ['minorBlockIndex', 'rootChainIndex']) {
        const hits = u64.filter((m) => klass(m).endsWith('/' + last));
        expect(new Set(hits.map((m) => m.patches[0]!.to)), last).toEqual(new Set(['9007199254740991', '9007199254740992', '9223372036854775808', '18446744073709551615', '18446744073709551616']));
        // 2^64 does not decode as a uint64 in Go: the document is refused as a plain refusal, whatever else it holds
        for (const m of hits.filter((x) => x.patches[0]!.to === '18446744073709551616')) expect(m.expect.v, m.id).toBe('plain');
      }
      expect(new Set(u64.map(klass)).size).toBeGreaterThanOrEqual(90);
    });

    it('removes and nulls the message and the receipt members', () => {
      const classes = new Set(sweeps.filter((m) => m.op.startsWith('sweep-delete@') || m.op.startsWith('sweep-null@')).map((m) => klass(m)));
      for (const c of ['evidence/anchor/message', 'evidence/anchor/receipt', 'evidence/receipt', 'evidence/anchors/acc://bvn-BVN2.acme/message']) expect(classes.has(c), c).toBe(true);
    });
  });

  }
  describe('certify1 differential: every mutation reaches the verdict Go gave it', () => {
    const mine = corpus.mutations.filter((_, i) => i % total === index);
    for (let c = 0; c < mine.length; ) {
      let chars = 0;
      let end = c;
      while (end < mine.length && end - c < CHUNK && (end === c || chars + charsOf(mine[end]!.base) <= CHUNK_CHARS)) {
        chars += charsOf(mine[end]!.base);
        end++;
      }
      const part = mine.slice(c, end);
      it(
        `mutations ${index + 1}/${total}: ${c + 1}-${c + part.length}`,
        () => {
          const wrong: string[] = [];
          for (const m of part) {
            const doc = applyPatches(bases[m.base], m.patches);
            const d = differences(m.expect, judgeCertifyText(numberText(JSON.stringify(doc))));
            if (d.length > 0) wrong.push(`${m.id} [${m.op}]: ${d.join(' | ')}`);
          }
          expect(wrong).toEqual([]);
        },
        CHUNK_BASE_MS + Math.ceil(chars / 1_000_000) * CHUNK_MS_PER_MEGACHAR,
      );
      c = end;
    }
  });

}
