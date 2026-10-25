/** The pinned identity of the copied vector set and the registry/pins fixtures it needs. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MANIFEST_SHA256, REG_DIR, caseNames, loadCase, manifest, read, sha256Hex } from './vectorset.js';

/** pv2/rb11-int@ecfb4fe pkg/finality/testdata/finality/states.json and pkg/finality/pins/finality-pins.json (PinsSHA256 12217758...). */
const STATES_SHA256 = '0521d55f101e6815872ccd11884d710594b79329f073226d7d5c05437fae2e60';
const EMBEDDED_PINS_SHA256 = '12217758b3a8074a07873cd3d26cc46edab7782d31f393d7f540c3e3077062d5';

describe('finality_arb_posted1 identity', () => {
  it('MANIFEST.json hashes to the Go-written MANIFEST.json.sha256 and the pinned value', () => {
    expect(sha256Hex(read('MANIFEST.json'))).toBe(MANIFEST_SHA256);
    expect(read('MANIFEST.json.sha256').toString('utf8').trim()).toBe(MANIFEST_SHA256);
    const m = manifest();
    expect(m.format).toBe('certen-finality-manifest/1');
    expect(m.set).toBe('finality_arb_posted1');
  });

  it('every file the manifest lists is byte-identical', () => {
    const m = manifest();
    for (const [f, want] of Object.entries(m.files)) expect(sha256Hex(read(f)), f).toBe(want);
    expect(Object.keys(m.files).length).toBe(78);
  });

  it('holds 63 cases, each listed in the manifest files, 4 accepting (1 live, 3 synthetic) and 59 refusals', () => {
    const names = caseNames();
    expect(names.length).toBe(63);
    expect(new Set(names).size).toBe(63);
    const files = manifest().files;
    for (const n of names) expect(files[`cases/${n}.json`], n).toBeDefined();
    const accepted = names.filter((n) => loadCase(n).expect_canonical.startsWith('{"code":"verified"'));
    expect(accepted.sort()).toEqual(['synth_valid_blob', 'synth_valid_calldata', 'synth_valid_delayed_deposit', 'valid_live']);
  });

  it('the Go states registry and embedded pins fixtures are byte-identical to pv2/rb11-int@ecfb4fe', () => {
    expect(sha256Hex(readFileSync(join(REG_DIR, 'states.json')))).toBe(STATES_SHA256);
    expect(sha256Hex(readFileSync(join(REG_DIR, 'finality-pins.json')))).toBe(EMBEDDED_PINS_SHA256);
  });
});
