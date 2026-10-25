/** The pinned identity of the copied vector set and the registry/pins fixtures it needs. */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MANIFEST_SHA256, caseNames, loadCase, manifest, read, sha256Hex } from './vectorset.js';

const here = dirname(fileURLToPath(import.meta.url));
const REG = join(here, '..', '..', 'fixtures', 'finality', 'base_posted1_registry');

/** pv2/rb11-d2-posted@e0c50c9 pkg/finality/testdata/finality/states.json and pkg/finality/pins/finality-pins.json (the Go D2 branch's edits). */
const D2_STATES_SHA256 = 'b502c76d425937fa426ccea73b1dbca82cf302aaea25ab184e13a62eaa140945';
const D2_PINS_SHA256 = 'ba507694e3f2d346050d7dfce11ea70f850bbb29598795134519eef6a6f963eb';

describe('finality_base_posted1 identity', () => {
  it('manifest.json hashes to the Go-written MANIFEST.sha256 and the pinned value', () => {
    expect(sha256Hex(read('manifest.json'))).toBe(MANIFEST_SHA256);
    expect(read('MANIFEST.sha256').toString('utf8').trim()).toBe(MANIFEST_SHA256);
  });

  it('every file the manifest lists is byte-identical', () => {
    const m = manifest();
    for (const [f, want] of Object.entries(m.files)) expect(sha256Hex(read(f)), f).toBe(want);
    expect(Object.keys(m.files).length).toBe(44);
  });

  it('holds 28 cases: 3 accepting from real evidence, 25 refusals', () => {
    const names = caseNames();
    expect(names.length).toBe(28);
    const results = names.map((n) => loadCase(n).expect.result);
    expect(results.filter((r) => r === 'ok').length).toBe(3);
    expect(results.filter((r) => r === 'state').length).toBe(25);
  });

  it('the Go D2 registry and embedded pins fixtures are byte-identical to pv2/rb11-d2-posted@e0c50c9', () => {
    expect(sha256Hex(readFileSync(join(REG, 'states.json')))).toBe(D2_STATES_SHA256);
    expect(sha256Hex(readFileSync(join(REG, 'finality-pins.json')))).toBe(D2_PINS_SHA256);
  });
});
