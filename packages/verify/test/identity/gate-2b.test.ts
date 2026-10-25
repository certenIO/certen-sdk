// THE 7b-1 GATE: every vector of s8_2b1_1 (38) and s8_2b2_1 (75) judged identical to Go, the count executed equal to the count PINS.json lists, none
// skipped. s8_2b1_1 is judged as Go's steps_2b1_test.go fixture does (real steps 1c-17 and 20; the stand-ins of steps 18-24, step 18 only reads);
// s8_2b2_1 as steps_2b2_test.go does (real steps 1c-22; the stand-ins of package 2c: steps 21, 23, 24).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ownedBy } from '../../src/proof-v2/identity/index.js';
import { VECTORS, setFiles, vectorIds } from './fixtures.js';
import { runSet } from './runset.js';
import { composedVerifier, loadWorld } from './standins.js';

const pins = JSON.parse(readFileSync(join(VECTORS, 'PINS.json'), 'utf8')) as { sets: Record<string, Record<string, string>> };

describe('gate 7b-1: s8_2b1_1 and s8_2b2_1 judged identical to Go', () => {
  const cases = [
    ['s8_2b1_1', 38, { steps: ownedBy('2b-1'), b1Flavour: true }],
    ['s8_2b2_1', 75, { steps: [...ownedBy('2b-1'), ...ownedBy('2b-2')] }],
  ] as const;
  for (const [name, n, real] of cases) {
    it(`${name}: ${n} vectors executed, all pass`, () => {
      const listed = Object.keys(pins.sets[name]!).filter((f) => f.endsWith('.expected.json')).length;
      expect(listed).toBe(n);
      expect(vectorIds(setFiles(name)).length).toBe(n);
      const results = runSet(name, composedVerifier(loadWorld(name), { steps: [...real.steps], ...('b1Flavour' in real ? { b1Flavour: true } : {}) }));
      expect(results.length).toBe(n);
      const bad = results.filter((r) => r.outcome !== 'pass').map((r) => r.id + ': ' + r.detail.slice(0, 200));
      expect(bad.length, bad.length + ' failing:\n' + bad.slice(0, 12).join('\n')).toBe(0);
    }, 240_000);
  }
});
