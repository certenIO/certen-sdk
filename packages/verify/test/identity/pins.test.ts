// The identity (S8) conformance fixtures are byte-identical copies of the validator's pkg/contractidentity/testdata/contractidentity
// (origin/main f0906035). They are hashed as BYTES, never as text, so a CRLF checkout cannot pass for the published bytes.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

export const FIXTURES = join(__dirname, '..', 'fixtures', 'identity');
export const VECTORS = join(FIXTURES, 'vectors');

// The sha256 of the copied PINS.json and of the index vectors/MANIFEST.json.
export const PINS_SHA256 = '01aa9e889c8b3a137570a7891132bc5b4f93f956b2065c099da653e104e1cfeb';
export const INDEX_MANIFEST_SHA256 = '54716b1ceb2baac38b6bddd320a7e37bc921c167af39b1740843d4881b351842';
export const STATES_SHA256 = '4bd8f8db09c7a55cdcf1c47162dbd46357265f296aea60a0e97aa48c0958f909';
export const VOCAB_SHA256 = '754e486a2c7b41be9743f3e7b70ccfa618a1b7de39654af217ddfa9ee182766c';
export const SET_NAMES = ['s8_2a_1', 's8_2a_2', 's8_2b1_1', 's8_2b2_1', 's8_2c_1', 's8_2c_2', 's8_2c_3', 's8_int_1', 's8_int_2', 's8_int_3'];

const sha = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');

describe('identity fixtures are the published bytes', () => {
  it('pins the sha256 of PINS.json, the index MANIFEST.json, states.json and vocab.json', () => {
    expect(sha(readFileSync(join(VECTORS, 'PINS.json')))).toBe(PINS_SHA256);
    expect(sha(readFileSync(join(VECTORS, 'MANIFEST.json')))).toBe(INDEX_MANIFEST_SHA256);
    expect(sha(readFileSync(join(FIXTURES, 'states.json')))).toBe(STATES_SHA256);
    expect(sha(readFileSync(join(FIXTURES, 'vocab.json')))).toBe(VOCAB_SHA256);
  });

  it('re-hashes every copied file of the ten sets against PINS.json, with no extra and no missing file', () => {
    const pins = JSON.parse(readFileSync(join(VECTORS, 'PINS.json'), 'utf8')) as { domain: string; sets: Record<string, Record<string, string>> };
    expect(pins.domain).toBe('certen:contract-identity:v1');
    expect(Object.keys(pins.sets).sort()).toEqual([...SET_NAMES].sort());
    let total = 0;
    for (const name of SET_NAMES) {
      const dir = join(VECTORS, name);
      const onDisk = readdirSync(dir).sort();
      for (const f of onDisk) expect(statSync(join(dir, f)).isFile(), `${name}/${f} is a file`).toBe(true);
      const pinned = Object.keys(pins.sets[name]!).sort();
      expect(onDisk, `${name} file list`).toEqual(pinned);
      for (const f of pinned) {
        expect(sha(readFileSync(join(dir, f))), `${name}/${f}`).toBe(pins.sets[name]![f]);
        total++;
      }
    }
    expect(total).toBe(1207);
  });

  it("every set's MANIFEST lists exactly the other files with their sha256", () => {
    for (const name of SET_NAMES) {
      const dir = join(VECTORS, name);
      const lines = readFileSync(join(dir, 'MANIFEST'), 'utf8').split('\n').filter((l) => l !== '');
      const listed = new Map(lines.map((l) => [l.slice(66), l.slice(0, 64)] as const));
      const files = readdirSync(dir).filter((f) => f !== 'MANIFEST').sort();
      expect([...listed.keys()].sort(), name).toEqual(files);
      for (const f of files) expect(sha(readFileSync(join(dir, f))), `${name}/${f}`).toBe(listed.get(f));
    }
  });
});
