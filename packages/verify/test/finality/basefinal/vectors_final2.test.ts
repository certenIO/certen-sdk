/**
 * The parity oracle of finality_base_final2: the four judge vectors the independent review of the Go verifier added
 * (validator pv2/rb11-d1-final -> pv2/rb11-e1-raise@cbb6373, manifest b7c61b0d...927a). The directory is a byte-identical copy of the Go set;
 * a published set is never edited. Each case is judged by the TypeScript judge and must equal the Go-written verdict byte for byte.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parsePinsOverride } from '../../../src/proof-v2/finality/pins.js';
import { expectedOf, runJudge, sha256Hex, type JudgeCase } from './vectorset.js';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'fixtures', 'finality', 'base_final2');
const rd = (n: string): Buffer => readFileSync(join(DIR, ...n.split('/')));

/** The sha256 of the Go-written manifest.json (= MANIFEST.sha256) of finality_base_final2 at pv2/rb11-e1-raise@cbb6373. */
const MANIFEST_SHA256 = 'b7c61b0d84d8b85bf4ea68b0f06790f919a94f3ccf2b8646932a90c995f3927a';
const manifest = JSON.parse(rd('manifest.json').toString('utf8')) as { cases: string[]; files: Record<string, string>; set: string };

describe('finality_base_final2 identity', () => {
  it('manifest.json hashes to the Go-written MANIFEST.sha256 and the pinned value, and lists exactly the files on disk', () => {
    expect(sha256Hex(rd('manifest.json'))).toBe(MANIFEST_SHA256);
    expect(rd('MANIFEST.sha256').toString('utf8').trim()).toBe(MANIFEST_SHA256);
    expect(manifest.set).toBe('finality_base_final2');
    for (const [f, want] of Object.entries(manifest.files)) expect(sha256Hex(rd(f)), f).toBe(want);
    expect(Object.keys(manifest.files).sort()).toEqual([...manifest.cases.map((c) => `judge/${c}.json`), 'pins/main.json'].sort());
    expect(manifest.cases.length).toBe(4);
  });

  it('its pins are byte-identical to the pins of finality_base_final1 (the published main.json)', () => {
    expect(sha256Hex(rd('pins/main.json'))).toBe(sha256Hex(readFileSync(join(DIR, '..', 'base_final1', 'pins', 'main.json'))));
  });

  it('holds three refusals and one accepted verdict', () => {
    const res = manifest.cases.map((c) => (JSON.parse(rd(`judge/${c}.json`).toString('utf8')) as JudgeCase).expect.result);
    expect(res.filter((r) => r === 'ok').length).toBe(1);
    expect(res.filter((r) => r === 'state').length).toBe(3);
  });
});

describe('finality_base_final2 judge cases', () => {
  const pins = parsePinsOverride(rd('pins/main.json'));
  for (const id of manifest.cases) {
    it(id, () => {
      const c = JSON.parse(rd(`judge/${id}.json`).toString('utf8')) as JudgeCase;
      expect(runJudge(c, pins)).toBe(expectedOf(c));
    });
  }
});
