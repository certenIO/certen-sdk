/** The shared state registry (the Go rb11-int states.json, byte-identical copy) and the check every state the kind raises must pass. */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect } from 'vitest';
import { FinalityStateError, canonValue } from '../../../src/proof-v2/finality/state.js';

const here = dirname(fileURLToPath(import.meta.url));
interface Entry {
  group: string;
  optional: string[];
  required: string[];
  enums?: Record<string, string[]>;
  enums_defined_by?: Record<string, string>;
}
export const registry = JSON.parse(readFileSync(join(here, '..', '..', 'fixtures', 'finality', 'arb_posted1_registry', 'states.json'), 'utf8')) as {
  states: Record<string, Entry>;
};

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

