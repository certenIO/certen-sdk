import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { decodeReplayGuardEvidence, judgeS6Replay, MAX_REPLAY_EVIDENCE_BYTES, S6_REASONS, S6_REPLAY_DOMAIN, S6_REPLAY_UNPROVEN, S6ReplayError } from '../src/index.js';
import type { S6Settlement, S6Verdict } from '../src/index.js';

/**
 * The fifth S6 replay-guard conformance set (certen:s6-replay:v1), s6replay5 (RB10-B12, certen-validator c60c684): the 4 MiB size
 * bound on the evidence document. A document longer than 4194304 bytes is refused s6_replay_unproven{evidence_too_large} by its
 * length alone, before anything is read (so never malformed_json, whatever the document is); a document of at most 4194304 bytes is
 * judged exactly as s6replay1-4 state, read with no depth limit and without recursion (vector 005 is about 2.1 million nested arrays
 * deep and is refused unknown_field). The files are byte-identical copies: MANIFEST pins manifest.json, which pins every vector
 * file, its gzipped evidence, the evidence's own sha256 and length, and the recipe that rebuilds the evidence. The TypeScript
 * verdict must equal Go's on every vector: result, state, reason, beforeVerified and every established line.
 */
const MANIFEST_SHA256 = 'aa2a8ce77f875509e0ab857d7f30158507421111f6ab54da07aa8741c707f07e';
const VECTORS = 10;
const CAP = 4194304;

const sha256 = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');
const dir = new URL('./fixtures/s6replay5/', import.meta.url);
const read = (name: string): Buffer => readFileSync(new URL(name, dir));

type Recipe = { prefix: string; open: string; core: string; close: string; count: number; suffix: string };
type Entry = {
  file: string;
  sha256: string;
  evidenceFile: string;
  evidenceGzSha256: string;
  evidenceSha256: string;
  evidenceLength: number;
  maxDepth: number;
  recipe: Recipe;
};
type Vector = { name: string; description: string; settlement: S6Settlement; evidenceFile: string; expect: S6Verdict };

/** s6replay5_test.go s6Want5: what the set states, by vector (result and reason). The size bound decides by length alone. */
const WANT: Record<string, string> = {
  '001_valid_vector_001_itself': 'proven ',
  '002_padded_cap_minus_1': 'refused unknown_field',
  '003_padded_cap': 'refused unknown_field',
  '004_padded_cap_plus_1': 'refused evidence_too_large',
  '005_arrays_closed_cap': 'refused unknown_field',
  '006_arrays_closed_cap_plus_1': 'refused evidence_too_large',
  '007_arrays_open_cap_plus_1': 'refused evidence_too_large',
  '008_arrays_six_million': 'refused evidence_too_large',
  '009_whitespace_cap': 'refused malformed_json',
  '010_whitespace_cap_plus_1': 'refused evidence_too_large',
};

/** The deepest nesting of `{` / `[` outside strings, as the generator's MaxDepth counts it. */
function maxDepth(raw: Uint8Array): number {
  let depth = 0;
  let max = 0;
  let inString = false;
  let escaped = false;
  for (const c of raw) {
    if (inString) {
      if (escaped) escaped = false;
      else if (c === 0x5c) escaped = true;
      else if (c === 0x22) inString = false;
      continue;
    }
    if (c === 0x22) inString = true;
    else if (c === 0x7b || c === 0x5b) {
      depth++;
      if (depth > max) max = depth;
    } else if (c === 0x7d || c === 0x5d) depth--;
  }
  return max;
}

/** What decodeReplayGuardEvidence refuses a document with: the named state, the reason and the detail. */
function refusal(raw: Uint8Array): { state: string; reason: string; detail: string } {
  try {
    decodeReplayGuardEvidence(raw);
  } catch (e) {
    if (e instanceof S6ReplayError) return { state: e.state, reason: e.reason, detail: e.detail };
    throw e;
  }
  throw new Error('the document was not refused');
}

const manifestRaw = read('manifest.json');
const manifest = JSON.parse(manifestRaw.toString('utf8')) as { domain: string; maxEvidenceBytes: number; vectors: Entry[] };
const vector001 = JSON.parse(readFileSync(new URL('./fixtures/s6replay1/001_valid_at_settlement_block.json', import.meta.url), 'utf8')) as { settlement: S6Settlement };

describe('S6 replay-guard conformance s6replay5 (certen:s6-replay:v1): the 4 MiB evidence size bound', () => {
  it('the bound and its reason are the format\'s', () => {
    expect(MAX_REPLAY_EVIDENCE_BYTES).toBe(CAP);
    expect(MAX_REPLAY_EVIDENCE_BYTES).toBe(4 << 20);
    expect(S6_REASONS.evidenceTooLarge).toBe('evidence_too_large');
    expect(manifest.maxEvidenceBytes).toBe(MAX_REPLAY_EVIDENCE_BYTES);
  });

  it('the files are the pinned copies', () => {
    expect(sha256(manifestRaw)).toBe(MANIFEST_SHA256);
    expect(read('MANIFEST').toString('utf8')).toBe(`${MANIFEST_SHA256}  manifest.json\n`);
    expect(manifest.domain).toBe(S6_REPLAY_DOMAIN);
    expect(manifest.vectors.length).toBe(VECTORS);
    expect(Object.keys(WANT).length).toBe(VECTORS);
    for (const e of manifest.vectors) {
      expect(sha256(read(e.file)), e.file).toBe(e.sha256);
      expect(sha256(read(e.evidenceFile)), e.evidenceFile).toBe(e.evidenceGzSha256);
    }
  });

  it('every evidence file is the recipe of its manifest line, byte for byte', () => {
    for (const e of manifest.vectors) {
      const ev = gunzipSync(read(e.evidenceFile));
      expect(sha256(ev), `${e.file} evidenceSha256`).toBe(e.evidenceSha256);
      expect(ev.length, `${e.file} evidenceLength`).toBe(e.evidenceLength);
      expect(maxDepth(ev), `${e.file} maxDepth`).toBe(e.maxDepth);
      const r = e.recipe;
      const rebuilt = Buffer.from(r.prefix + r.open.repeat(r.count) + r.core + r.close.repeat(r.count) + r.suffix, 'utf8');
      expect(Buffer.compare(rebuilt, ev), `${e.file} recipe`).toBe(0);
    }
  });

  it('every vector uses s6replay1 vector 001\'s settlement', () => {
    for (const e of manifest.vectors) {
      const v = JSON.parse(read(e.file).toString('utf8')) as Vector;
      expect(v.settlement, e.file).toEqual(vector001.settlement);
    }
  });

  it('the vectors pin the bound exactly: refused evidence_too_large if and only if longer than the bound', () => {
    let tooLarge = 0;
    for (const e of manifest.vectors) {
      const v = JSON.parse(read(e.file).toString('utf8')) as Vector;
      const big = e.evidenceLength > MAX_REPLAY_EVIDENCE_BYTES;
      expect(v.expect.reason === 'evidence_too_large', `${v.name}: ${e.evidenceLength} bytes, the bound is ${MAX_REPLAY_EVIDENCE_BYTES}`).toBe(big);
      if (big) tooLarge++;
    }
    expect(tooLarge).toBe(5);
  });

  for (const e of manifest.vectors) {
    const v = JSON.parse(read(e.file).toString('utf8')) as Vector;
    it(`${v.name} (${e.evidenceLength} bytes, depth ${e.maxDepth}): ${WANT[v.name]}`, () => {
      expect(`${v.expect.result} ${v.expect.reason}`, 'the file records what the set states').toBe(WANT[v.name]);
      expect(v.evidenceFile).toBe(e.evidenceFile);
      const got = judgeS6Replay(v.settlement, gunzipSync(read(v.evidenceFile)));
      expect(JSON.stringify(got)).toBe(JSON.stringify(v.expect));
    });
  }
});

describe('S6 evidence size bound (testdata/s6replay5/SPEC.md step 0): exact at the boundary, for any filler', () => {
  // TestReplayEvidenceCapIsExact: the length is judged first, so a document over the bound is never malformed_json however it
  // is made, and a document of exactly the bound is read (here: not JSON, so malformed_json). Bytes: space, 'x', '[', NUL.
  const fillers: [string, number][] = [
    ['space', 0x20],
    ['x', 0x78],
    ['[', 0x5b],
    ['NUL', 0x00],
  ];
  const cases: [string, number, string][] = [
    ['bound - 1', CAP - 1, S6_REASONS.malformedJson],
    ['bound', CAP, S6_REASONS.malformedJson],
    ['bound + 1', CAP + 1, S6_REASONS.evidenceTooLarge],
    ['2 x bound', CAP * 2, S6_REASONS.evidenceTooLarge],
  ];
  for (const [fname, byte] of fillers) {
    for (const [cname, n, reason] of cases) {
      it(`${fname} x ${n} (${cname}) is refused s6_replay_unproven{${reason}}`, () => {
        const r = refusal(Buffer.alloc(n, byte));
        expect(r.state).toBe(S6_REPLAY_UNPROVEN);
        expect(r.reason).toBe(reason);
      });
    }
  }

  it('the refusal names the length and the bound', () => {
    const r = refusal(Buffer.alloc(CAP + 1));
    expect(r.detail).toBe('the evidence is 4194305 bytes, more than the 4194304 bytes the format allows');
    expect(refusal(Buffer.alloc(CAP * 2)).detail).toBe('the evidence is 8388608 bytes, more than the 4194304 bytes the format allows');
  });

  it('judgeS6Replay carries the same refusal as a verdict', () => {
    const got = judgeS6Replay(vector001.settlement, Buffer.alloc(CAP + 1, 0x20));
    expect(got).toEqual({ result: 'refused', state: S6_REPLAY_UNPROVEN, reason: 'evidence_too_large', beforeVerified: false, established: [] });
  });

  it('a valid document is read at exactly the bound and refused one byte over, whatever pads it', () => {
    // vector 001's evidence behind an unknown first key holding a string of 'a' (s6replay5 003 / 004 are these two documents).
    const ev001 = gunzipSync(read('001_valid_vector_001_itself.evidence.gz')).toString('utf8');
    const body = ev001.slice(1);
    const pad = (n: number): Buffer => {
      const head = '{"zzz":"';
      const tail = '",' + body;
      return Buffer.from(head + 'a'.repeat(n - head.length - tail.length) + tail, 'utf8');
    };
    expect(pad(CAP).length).toBe(CAP);
    expect(pad(CAP + 1).length).toBe(CAP + 1);
    expect(refusal(pad(CAP - 1)).reason).toBe(S6_REASONS.unknownField);
    expect(refusal(pad(CAP)).reason).toBe(S6_REASONS.unknownField);
    expect(refusal(pad(CAP + 1)).reason).toBe(S6_REASONS.evidenceTooLarge);
  });
});
