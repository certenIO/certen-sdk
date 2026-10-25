// THE 7a GATE: every vector of s8_2a_1 (106) and s8_2a_2 (3) judged identical to Go by the composed verifier, the count executed equal to the
// count PINS.json lists, none skipped. The composed verifier registers the steps 1c-14 (package 2a) and the stand-ins of Go's
// steps_2a_test.go `fake` for steps 15-24 (which 7b-1 and 7b-2 replace one by one). It is red until the steps are registered: a registry
// with a missing step is refused at construction, so this test names the steps still to port.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { StepRegistry, checkRegistry, type Verifier } from '../../src/proof-v2/identity/index.js';
import { VECTORS, setFiles, vectorIds } from './fixtures.js';
import { runSet } from './runset.js';

const pins = JSON.parse(readFileSync(join(VECTORS, 'PINS.json'), 'utf8')) as { sets: Record<string, Record<string, string>> };

/** The composed verifier: the registry must be complete before it can run anything. */
function composedVerifier(): Verifier {
  const reg = new StepRegistry<unknown>();
  checkRegistry(reg);
  return () => {
    throw new Error('contractidentity: the step loop runs the registered steps');
  };
}

describe('gate 7a: s8_2a_1 and s8_2a_2 judged identical to Go', () => {
  for (const [name, n] of [['s8_2a_1', 106], ['s8_2a_2', 3]] as const) {
    it(`${name}: ${n} vectors executed, all pass`, () => {
      const listed = Object.keys(pins.sets[name]!).filter((f) => f.endsWith('.expected.json')).length;
      expect(listed).toBe(n);
      expect(vectorIds(setFiles(name)).length).toBe(n);
      const results = runSet(name, composedVerifier());
      expect(results.length).toBe(n);
      expect(results.filter((r) => r.outcome !== 'pass').map((r) => `${r.id}: ${r.detail}`)).toEqual([]);
    });
  }
});
