/** The registry of the Go set (pkg/finality testdata/finality/states.json at pv2/rb11-int@ee6d106, byte-identical) and the check every state the kind raises must pass. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect } from 'vitest';
import { FinalityStateError, canonValue } from '../../../src/proof-v2/finality/state.js';
import { REGISTRY_DIR } from './vectorset.js';

interface Cond {
  required: string[];
  when: Record<string, string>;
}
interface Entry {
  group: string;
  optional: string[];
  required: string[];
  conditional_required?: Cond[];
  enums?: Record<string, string[]>;
}
export const registry = JSON.parse(readFileSync(join(REGISTRY_DIR, 'states.json'), 'utf8')) as { states: Record<string, Entry> };

/**
 * Asserts that a state carries every required field of its registry entry (and the conditionally required ones of its check), no
 * unregistered field, and values inside a closed enum. The Adiri states and every framework state the kind can raise are in the registry.
 */
export function assertRegistered(e: FinalityStateError): void {
  const r = registry.states[e.code];
  expect(r, `${e.code} is not in the registry`).toBeDefined();
  const have = Object.keys(e.fields);
  const allowed = new Set([...r!.required, ...r!.optional]);
  for (const f of r!.required) expect(have, `${e.code} lacks ${f}`).toContain(f);
  for (const c of r!.conditional_required ?? []) {
    const applies = Object.entries(c.when).every(([k, v]) => JSON.parse(canonValue(e.fields[k])) === v);
    if (applies) for (const f of c.required) expect(have, `${e.code}${JSON.stringify(c.when)} lacks ${f}`).toContain(f);
  }
  for (const [f, v] of Object.entries(e.fields)) {
    expect(allowed.has(f), `${e.code} carries unregistered field ${f}`).toBe(true);
    const set = r!.enums?.[f];
    if (set) expect(set, `${e.code}.${f}`).toContain(JSON.parse(canonValue(v)));
  }
}
