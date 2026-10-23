/** The shared state registry (the validator's pkg/finality/testdata/finality/states.json at cbb6373, byte-identical copy) and the check every state the kind raises must pass. */
import { expect } from 'vitest';
import { FinalityStateError, canonValue } from '../../../src/proof-v2/finality/state.js';
import { fixtureJSON } from '../helpers.js';

interface Entry {
  group: string;
  optional: string[];
  required: string[];
  enums?: Record<string, string[]>;
  enums_defined_by?: Record<string, string>;
}
export const registry = fixtureJSON<{ states: Record<string, Entry> }>('finality', 'states.json');

/** Asserts that a state carries every required field of its registry entry, no unregistered field, and values inside a closed enum. */
export function assertRegistered(e: FinalityStateError): void {
  const r = registry.states[e.code];
  expect(r, `${e.code} is not in the registry`).toBeDefined();
  const allowed = new Set([...r!.required, ...r!.optional]);
  for (const f of r!.required) expect(Object.keys(e.fields), `${e.code} lacks ${f}`).toContain(f);
  for (const [f, v] of Object.entries(e.fields)) {
    expect(allowed.has(f), `${e.code} carries unregistered field ${f}`).toBe(true);
    const set = r!.enums?.[f];
    if (set) expect(set, `${e.code}.${f}`).toContain(JSON.parse(canonValue(v)));
  }
}
