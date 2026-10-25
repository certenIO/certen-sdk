/** The shared state registry (the Go D1 and rb11-int states.json, byte-identical copies) and the check every state the kind raises must pass. */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect } from 'vitest';
import { FinalityStateError, canonValue } from '../../../src/proof-v2/finality/state.js';

const here = dirname(fileURLToPath(import.meta.url));
export interface RegEntry {
  group: string;
  optional: string[];
  required: string[];
  enums?: Record<string, string[]>;
  enums_defined_by?: Record<string, string>;
  conditional_required?: { when: Record<string, string>; required: string[] }[];
}
const load = (dir: string): { states: Record<string, RegEntry> } =>
  JSON.parse(readFileSync(join(here, '..', '..', 'fixtures', 'finality', dir, 'states.json'), 'utf8'));
/** the registry of pv2/rb11-d1-final (the contract of the Go author) */
export const registry = load('base_final1_registry');
/** the registry of the integration branch (the contract the kind is merged into) */
export const registryInt = load('arb_posted1_registry');

/**
 * FINDING (registry gap, Go): the framework's LPList adds `index` to a failing element's state (pkg/finality/codec.go:198 withIndex,
 * which copies the fields of ANY StateError), so finality_evidence_too_large{part,count,limit,index} is emitted for an oversize element of
 * l1Spine, l2Spine or NODES, but states.json lists no optional `index` for it. The TS twin emits it identically (cross-checked against a
 * Go run); the extra field is allowed here by name until the Go registry lists it.
 */
const REGISTRY_GAPS: Record<string, string[]> = { finality_evidence_too_large: ['index'] };

/** Asserts that a state carries every required field of its registry entry, no unregistered field, values inside a closed enum, and the conditional fields. */
export function assertRegistered(e: FinalityStateError, reg = registry): void {
  const r = reg.states[e.code];
  expect(r, `${e.code} is not in the registry`).toBeDefined();
  const allowed = new Set([...r!.required, ...r!.optional, ...(REGISTRY_GAPS[e.code] ?? [])]);
  for (const f of r!.required) expect(Object.keys(e.fields), `${e.code} lacks ${f}`).toContain(f);
  for (const [f, v] of Object.entries(e.fields)) {
    expect(allowed.has(f), `${e.code} carries unregistered field ${f}`).toBe(true);
    const set = r!.enums?.[f];
    if (set) expect(set, `${e.code}.${f}`).toContain(JSON.parse(canonValue(v)));
  }
  for (const c of r!.conditional_required ?? []) {
    if (Object.entries(c.when).every(([k, v]) => JSON.parse(canonValue(e.fields[k])) === v)) {
      for (const f of c.required) expect(Object.keys(e.fields), `${e.code} lacks conditional ${f}`).toContain(f);
    }
  }
}
