// Steps 0 and 1 against every published vector: each vector the manifest pin, the chain row or the strict decode decides must come out
// identical to Go's expected report; a vector those steps do not decide needs the steps (it fails with the registry error, nothing else).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SET_NAMES, VECTORS, setFiles, vectorIds } from './fixtures.js';
import { preludeVerifier, runSet } from './runset.js';

const pins = JSON.parse(readFileSync(join(VECTORS, 'PINS.json'), 'utf8')) as { sets: Record<string, Record<string, string>> };

describe('steps 0 and 1 on the published vector sets', () => {
  for (const name of SET_NAMES) {
    it(`${name}: every vector listed in PINS.json is executed and the prelude-decided ones are identical to Go`, () => {
      const listed = Object.keys(pins.sets[name]!).filter((f) => f.endsWith('.expected.json')).length;
      expect(vectorIds(setFiles(name)).length, 'executed = listed').toBe(listed);
      const results = runSet(name, preludeVerifier);
      expect(results.length).toBe(listed);
      const needsSteps = (r: { detail: string }): boolean => r.detail.startsWith('verifier error: contractidentity: new verifier: the steps');
      const wrong = results.filter((r) => r.outcome !== 'pass' && !needsSteps(r));
      expect(wrong, JSON.stringify(wrong.slice(0, 3))).toEqual([]);
      const decided = results.filter((r) => r.outcome === 'pass').length;
      console.log(`${name}: ${listed} vectors executed, ${decided} decided by steps 0-1 and identical to Go, ${listed - decided} need steps 1c-24`);
    });
  }
});
