import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { judgeS6Replay, S6_REPLAY_DOMAIN } from '../src/index.js';
import type { S6Settlement, S6Verdict } from '../src/index.js';

/**
 * The fourth S6 replay-guard conformance set (certen:s6-replay:v1), s6replay4 (RB10-B9, certen-validator 692d709): what Go's strict
 * decoder does with a deeply nested JSON document (review V-R10C2 D1). Go reads the document with json.Decoder.Token(), which has
 * no depth limit, and refuses it at the first unknown field / wrong type (or a duplicate key or a truncation, at any depth); the
 * 10000-container limit is json.Unmarshal's and is never reached by a schema-valid (so shallow) document. The files are
 * byte-identical copies: MANIFEST pins manifest.json, which pins every vector file, its gzipped evidence, the evidence's own sha256 and
 * length, and the recipe that rebuilds the evidence. The TypeScript verdict must equal Go's on every vector: result, state, reason,
 * beforeVerified and every established line. Evidence bytes are used exactly as the gunzipped file holds them.
 */
const MANIFEST_SHA256 = '01ba8794877f7acd69b2620cf457ec1f26ceac3073d759971e0a942d5f26bd83';
const VECTORS = 30;

const sha256 = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');
const dir = new URL('./fixtures/s6replay4/', import.meta.url);
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

/** s6replay4_test.go s6Want4: what the set states, by vector (result and reason). Depth never decides it. */
const WANT: Record<string, string> = {
  '001_valid_vector_001_itself': 'proven ',
  '002_unknown_field_arrays_5000': 'refused unknown_field',
  '003_unknown_field_arrays_9999': 'refused unknown_field',
  '004_unknown_field_arrays_10000': 'refused unknown_field',
  '005_unknown_field_arrays_10001': 'refused unknown_field',
  '006_unknown_field_arrays_20000': 'refused unknown_field',
  '007_headers_arrays_5000': 'refused wrong_type',
  '008_headers_arrays_9999': 'refused wrong_type',
  '009_headers_arrays_10000': 'refused wrong_type',
  '010_headers_arrays_10001': 'refused wrong_type',
  '011_headers_arrays_20000': 'refused wrong_type',
  '012_unknown_field_objects_5000': 'refused unknown_field',
  '013_unknown_field_objects_9999': 'refused unknown_field',
  '014_unknown_field_objects_10000': 'refused unknown_field',
  '015_unknown_field_objects_10001': 'refused unknown_field',
  '016_unknown_field_objects_20000': 'refused unknown_field',
  '017_object_duplicate_key_at_depth_10001': 'refused malformed_json',
  '018_deep_then_duplicate_version_5000': 'refused malformed_json',
  '019_deep_then_duplicate_version_10001': 'refused malformed_json',
  '020_deep_then_duplicate_version_20000': 'refused malformed_json',
  '021_generation_arrays_10001': 'refused wrong_type',
  '022_generation_arrays_20000': 'refused wrong_type',
  '023_chainid_arrays_10001': 'refused wrong_type',
  '024_version_arrays_10001': 'refused wrong_type',
  '025_state_valid': 'stated state_unavailable',
  '026_state_unknown_field_arrays_10001': 'refused unknown_field',
  '027_state_unknown_field_arrays_20000': 'refused unknown_field',
  '028_state_reason_arrays_10001': 'refused wrong_type',
  '029_top_level_arrays_10001': 'refused wrong_type',
  '030_truncated_arrays_10001': 'refused malformed_json',
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

const manifestRaw = read('manifest.json');
const manifest = JSON.parse(manifestRaw.toString('utf8')) as { domain: string; jsonMaxNestingDepth: number; vectors: Entry[] };
const vector001 = JSON.parse(readFileSync(new URL('./fixtures/s6replay1/001_valid_at_settlement_block.json', import.meta.url), 'utf8')) as { settlement: S6Settlement };

describe('S6 replay-guard conformance s6replay4 (certen:s6-replay:v1): deeply nested evidence', () => {
  it('the files are the pinned copies', () => {
    expect(sha256(manifestRaw)).toBe(MANIFEST_SHA256);
    expect(read('MANIFEST').toString('utf8')).toBe(`${MANIFEST_SHA256}  manifest.json\n`);
    expect(manifest.domain).toBe(S6_REPLAY_DOMAIN);
    expect(manifest.jsonMaxNestingDepth).toBe(10000);
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

  for (const e of manifest.vectors) {
    const v = JSON.parse(read(e.file).toString('utf8')) as Vector;
    it(`${v.name} (depth ${e.maxDepth}): ${WANT[v.name]}`, () => {
      expect(`${v.expect.result} ${v.expect.reason}`, 'the file records what the set states').toBe(WANT[v.name]);
      expect(v.evidenceFile).toBe(e.evidenceFile);
      const got = judgeS6Replay(v.settlement, gunzipSync(read(v.evidenceFile)));
      expect(JSON.stringify(got)).toBe(JSON.stringify(v.expect));
    });
  }
});
