// THE 7a GATE: every vector of s8_2a_1 (106) and s8_2a_2 (3) judged identical to Go by the composed verifier (the real steps 1c-14 and the
// stand-ins of Go's steps_2a_test.go `fake` for steps 15-24), the count executed equal to the count PINS.json lists, none skipped.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { VECTORS, setFiles, vectorIds } from './fixtures.js';
import { runSet } from './runset.js';
import { composedVerifier, loadWorld } from './standins.js';

const pins = JSON.parse(readFileSync(join(VECTORS, 'PINS.json'), 'utf8')) as { sets: Record<string, Record<string, string>> };

describe('gate 7a: s8_2a_1 and s8_2a_2 judged identical to Go', () => {
  for (const [name, n] of [['s8_2a_1', 106], ['s8_2a_2', 3]] as const) {
    it(`${name}: ${n} vectors executed, all pass`, () => {
      const listed = Object.keys(pins.sets[name]!).filter((f) => f.endsWith('.expected.json')).length;
      expect(listed).toBe(n);
      expect(vectorIds(setFiles(name)).length).toBe(n);
      const results = runSet(name, composedVerifier(loadWorld(name)));
      expect(results.length).toBe(n);
      const bad = results.filter((r) => r.outcome !== 'pass').map((r) => `${r.id}: ${r.detail.slice(0, 160)}`);
      expect(bad.length, `${bad.length} failing:\n` + bad.slice(0, 12).join('\n')).toBe(0);
    }, 180_000);
  }
});
