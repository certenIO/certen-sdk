/**
 * The supplement worlds finality_base_final1_x: 199 synthetic judge-level worlds that the published finality_base_final1 does not turn (words
 * with bytes outside the 64 bits the verifier reads, every status/respected/proof-count/expected-resolution/retirement/timestamp boundary,
 * malformed storage leaves and account leaves, absent accounts, template and args variations, output-root indices, spine depths and number
 * skips). They were built by the validator's own synthetic world builder (pkg/finality/basefinal BuildSynth, pv2/rb11-d1-final@6814d26) in a
 * throwaway Go test; each expectation is the canonical verdict the GO judge returned, so the TypeScript judge must equal it byte for byte.
 * This is a TypeScript-repo supplement, not a published Go set: the Go owner is asked (check-in finding) to publish it as a new set.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parsePinsOverride } from '../../../src/proof-v2/finality/pins.js';
import { sha256Hex, expectedOf, runJudge, type JudgeCase } from './vectorset.js';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'fixtures', 'finality', 'base_final1_x');
const rd = (n: string): Buffer => readFileSync(join(DIR, ...n.split('/')));
const manifest = JSON.parse(rd('manifest.json').toString('utf8')) as { judge_cases: string[]; files: Record<string, string> };
const pins = parsePinsOverride(rd('pins/main.json'));

describe('finality_base_final1_x identity', () => {
  it('every file the manifest lists is byte-identical to what the generator wrote, and the pins are the published main.json', () => {
    for (const [f, want] of Object.entries(manifest.files)) expect(sha256Hex(rd(f)), f).toBe(want);
    expect(manifest.judge_cases.length).toBe(199);
    expect(sha256Hex(rd('pins/main.json'))).toBe(sha256Hex(readFileSync(join(DIR, '..', 'base_final1', 'pins', 'main.json'))));
  });
});

describe('finality_base_final1_x judge cases', () => {
  for (const id of manifest.judge_cases) {
    it(id, () => {
      const c = JSON.parse(rd(`judge/${id}.json`).toString('utf8')) as JudgeCase;
      expect(runJudge(c, pins)).toBe(expectedOf(c));
    });
  }
});
