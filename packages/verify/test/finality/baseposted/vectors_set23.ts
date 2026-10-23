/**
 * Shared harness of the published sets finality_base_posted2 (streams) and finality_base_posted3 (binding and channel timeout): byte-identical
 * copies of the validator's pkg/finality/baseposted/testdata sets at pv2/rb11-e1-raise@cbb6373. Both are SYNTHETIC-world sets: the world is
 * built from fixed labels by the TypeScript twin of the Go synth_test.go builder (synth.ts), the verdict is compared with the Go-written
 * expectation byte for byte.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect } from 'vitest';
import { sha256 } from '@noble/hashes/sha2';
import { FinalityStateError, canonValue, hexLower } from '../../../src/proof-v2/finality/state.js';

const here = dirname(fileURLToPath(import.meta.url));
export const FIX = join(here, '..', '..', 'fixtures', 'finality');
export const setReader = (dir: string) => (name: string): Buffer => readFileSync(join(FIX, dir, ...name.split('/')));
export const sha256Hex = (b: Uint8Array): string => hexLower(sha256(b));
export const unhexStrict = (s: string): Uint8Array => {
  const h = s.startsWith('0x') ? s.slice(2) : s;
  if (!/^([0-9a-f]{2})*$/.test(h)) throw new Error(`not lower-case hex: ${s.slice(0, 20)}`);
  return Uint8Array.from(h.match(/../g) ?? [], (x) => parseInt(x, 16));
};

export interface SetManifest {
  format: string;
  set: string;
  cases: string[];
  files: Record<string, string>;
}

/** manifest.json hashes to MANIFEST.sha256 (and to the pinned value) and lists exactly the files on disk. */
export function checkSetIdentity(dir: string, pinned: string, expectedFormat: string, expectedSet: string, onDisk: string[]): SetManifest {
  const rd = setReader(dir);
  expect(sha256Hex(rd('manifest.json'))).toBe(pinned);
  expect(rd('MANIFEST.sha256').toString('utf8').trim()).toBe(pinned);
  const m = JSON.parse(rd('manifest.json').toString('utf8')) as SetManifest;
  expect(m.format).toBe(expectedFormat);
  expect(m.set).toBe(expectedSet);
  for (const [f, want] of Object.entries(m.files)) expect(sha256Hex(rd(f)), f).toBe(want);
  expect(Object.keys(m.files).sort()).toEqual([...onDisk].sort());
  return m;
}

/** The expected canonical string of a set-1-form expectation {result, code?, fields}. */
export const norm = (v: unknown): string =>
  Array.isArray(v)
    ? `[${v.map(norm).join(',')}]`
    : v !== null && typeof v === 'object'
      ? `{${Object.keys(v)
          .sort()
          .map((k) => `${JSON.stringify(k)}:${norm((v as Record<string, unknown>)[k])}`)
          .join(',')}}`
      : JSON.stringify(v);
export interface Expect {
  result: 'ok' | 'state';
  code?: string;
  fields: unknown;
}
export const expectedOf = (e: Expect): string =>
  e.result === 'ok' ? `{"fields":${norm(e.fields)},"result":"ok"}` : `{"code":${JSON.stringify(e.code)},"fields":${norm(e.fields)}}`;

export function canonicalOutcome(run: () => { fields: Record<string, any> }): string {
  try {
    const v = run();
    return `{"fields":${canonValue(v.fields)},"result":"ok"}`;
  } catch (e) {
    if (e instanceof FinalityStateError) return e.canonical();
    return `NOT A NAMED STATE: ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`;
  }
}

interface RegEntry {
  required: string[];
  optional: string[];
}
const registry = JSON.parse(readFileSync(join(FIX, 'finality', 'states.json'), 'utf8')) as { states: Record<string, RegEntry> };

/** A refusal named in a set is registered in the current registry with exactly its fields (required present, none unregistered). */
export function expectRegistered(id: string, e: Expect): void {
  if (e.result === 'ok') return;
  const r = registry.states[e.code!];
  expect(r, `${id}: ${e.code} is not in the registry`).toBeDefined();
  const fields = Object.keys(e.fields as Record<string, unknown>);
  for (const f of r!.required) expect(fields, `${id}: ${e.code} lacks ${f}`).toContain(f);
  const allowed = new Set([...r!.required, ...r!.optional]);
  for (const f of fields) expect(allowed.has(f), `${id}: ${e.code} carries unregistered field ${f}`).toBe(true);
}
