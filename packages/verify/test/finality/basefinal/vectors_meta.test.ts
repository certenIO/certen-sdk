/** The pinned identity of the copied vector set and the registry/pins fixtures it needs. */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MANIFEST_SHA256, caseNames, judgeNames, loadCase, loadJudge, manifest, read, sha256Hex } from './vectorset.js';

const here = dirname(fileURLToPath(import.meta.url));
const REG = join(here, '..', '..', 'fixtures', 'finality', 'base_final1_registry');

/** pv2/rb11-d1-final pkg/finality/testdata/finality/states.json and pkg/finality/pins/finality-pins.json (the Go D1 branch's edits). */
const D1_STATES_SHA256 = 'f0da9a0d18c566dfb4d36e03f8ed6ea86f679655c199505bdfe14198e9b8e757';
const D1_PINS_SHA256 = '59996f1ed3fde8a4cc85ad81453228c6839212757d6c9502538bd8ee57d739e3';

describe('finality_base_final1 identity', () => {
  it('manifest.json hashes to the Go-written MANIFEST.sha256 and the pinned value', () => {
    expect(sha256Hex(read('manifest.json'))).toBe(MANIFEST_SHA256);
    expect(read('MANIFEST.sha256').toString('utf8').trim()).toBe(MANIFEST_SHA256);
  });

  it('every file the manifest lists is byte-identical', () => {
    const m = manifest();
    for (const [f, want] of Object.entries(m.files)) expect(sha256Hex(read(f)), f).toBe(want);
    expect(Object.keys(m.files).length).toBe(122);
  });

  it('holds 23 live cases and 73 judge-level cases', () => {
    expect(caseNames().length).toBe(23);
    expect(judgeNames().length).toBe(73);
    // a refusal carries {code, fields} and no `result`; an accepting case carries result "ok"
    const live = caseNames().map((n) => loadCase(n).expect.result);
    expect(live.filter((r) => r === 'ok').length).toBe(2);
    expect(live.filter((r) => r === undefined).length).toBe(21);
    const judge = judgeNames().map((n) => loadJudge(n).expect.result);
    expect(judge.filter((r) => r === 'ok').length).toBe(9);
    expect(judge.filter((r) => r === undefined).length).toBe(64);
  });

  it('the Go D1 registry and embedded pins fixtures are byte-identical to pv2/rb11-d1-final', () => {
    expect(sha256Hex(readFileSync(join(REG, 'states.json')))).toBe(D1_STATES_SHA256);
    expect(sha256Hex(readFileSync(join(REG, 'finality-pins.json')))).toBe(D1_PINS_SHA256);
  });
});
