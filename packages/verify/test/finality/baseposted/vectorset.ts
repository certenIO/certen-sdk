/**
 * The harness of the finality_base_posted1 conformance set: a byte-identical copy of the validator's
 * pkg/finality/baseposted/testdata/finality_base_posted1 (pv2/rb11-d2-posted@e0c50c9, manifest 990d75f0...). A case is {pins, leg, evidence,
 * splice?, expect}: the splice is applied to the named base evidence, the kind judges it under the pins file against the leg, and the
 * CANONICAL verdict string is compared with the Go-written expectation byte for byte.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256 } from '@noble/hashes/sha2';
import { parsePinsOverride } from '../../../src/proof-v2/finality/pins.js';
import { BasePostedKind } from '../../../src/proof-v2/finality/baseposted/index.js';
import { supplyPins } from './supply.js';
import { FinalityStateError, canonValue, hexLower } from '../../../src/proof-v2/finality/state.js';

const here = dirname(fileURLToPath(import.meta.url));
export const SET_DIR = join(here, '..', '..', 'fixtures', 'finality', 'base_posted1');

/** The sha256 of the Go-written manifest.json (= MANIFEST.sha256) of finality_base_posted1 at pv2/rb11-d2-posted@e0c50c9. */
export const MANIFEST_SHA256 = '990d75f0792ba7543beac5934a022a9dbc2cad9777c2e6770f20ef15bd964bf5';

export const read = (name: string): Buffer => readFileSync(join(SET_DIR, ...name.split('/')));

/**
 * What the harness adds to the pins files of the published set finality_base_posted1, which predates two base_sepolia pins (the Go
 * PublishedSetPinSupply): the Granite activation time and the post-Granite channel timeout. The verifier has no default for a missing pin
 * (finality_pins_corrupt{bad_value, base_sepolia.granite_time}), so the published values are supplied explicitly; every live frame of set 1
 * lies within 50 L1 blocks of its channel's first frame, so the set's expected bytes are unchanged.
 */
export const PUBLISHED_SET_PIN_SUPPLY: Readonly<Record<string, number>> = { granite_time: 1723478400, channel_timeout_granite: 50 };

/**
 * The Go SupplyBaseSepoliaPins: the pins file with the given base_sepolia keys added where the file lacks them (a key the file has is
 * never overwritten), in the loader's canonical form (keys sorted at every depth, two-space indent, one LF), number literals kept exactly as
 * written (an integer above 2^53 such as 2^64-1 is supplied losslessly). See supply.ts; the bytes are the Go bytes (test/fixtures/finality/base_supply).
 */
export function supplyBaseSepoliaPins(raw: Uint8Array, supply: Readonly<Record<string, number | bigint>> = PUBLISHED_SET_PIN_SUPPLY): Buffer {
  return supplyPins(raw, supply);
}

/** A pins file of the published set as the harness gives it to the verifier: with the supplied Granite pins. */
export const readPins = (name: string): Buffer => supplyBaseSepoliaPins(read(name));
export const sha256Hex = (b: Uint8Array): string => hexLower(sha256(b));
export const bytesOfHex = (s: string): Uint8Array => {
  const h = s.startsWith('0x') ? s.slice(2) : s;
  if (!/^([0-9a-f]{2})*$/.test(h)) throw new Error(`not lower-case hex: ${s.slice(0, 20)}`);
  return Uint8Array.from(h.match(/../g) ?? [], (x) => parseInt(x, 16));
};

export interface Splice {
  offset: number;
  delete: number;
  insert: string;
}
export interface Case {
  format: string;
  id: string;
  description: string;
  pins: string;
  leg: string;
  evidence: string;
  splice?: Splice;
  expect: { result: 'ok' | 'state'; code?: string; fields: unknown };
}

export const manifest = (): { cases: string[]; files: Record<string, string> } => JSON.parse(read('manifest.json').toString('utf8'));
export const caseNames = (): string[] => manifest().cases;
export const loadCase = (id: string): Case => JSON.parse(read(`cases/${id}.json`).toString('utf8'));

/** JSON with sorted keys and no whitespace. */
const norm = (v: unknown): string =>
  Array.isArray(v)
    ? `[${v.map(norm).join(',')}]`
    : v !== null && typeof v === 'object'
      ? `{${Object.keys(v)
          .sort()
          .map((k) => `${JSON.stringify(k)}:${norm((v as Record<string, unknown>)[k])}`)
          .join(',')}}`
      : JSON.stringify(v);

/** The expected canonical string of a case (the Go ExpectBytes). */
export function expectedOf(c: Case): string {
  return c.expect.result === 'ok'
    ? `{"fields":${norm(c.expect.fields)},"result":"ok"}`
    : `{"code":${JSON.stringify(c.expect.code)},"fields":${norm(c.expect.fields)}}`;
}

export function applySplice(base: Uint8Array, s: Splice | undefined): Uint8Array {
  if (s === undefined) return Uint8Array.from(base);
  const ins = bytesOfHex(s.insert);
  if (s.offset + s.delete > base.length) throw new Error('splice beyond the evidence');
  const out = new Uint8Array(s.offset + ins.length + (base.length - s.offset - s.delete));
  out.set(base.subarray(0, s.offset), 0);
  out.set(ins, s.offset);
  out.set(base.subarray(s.offset + s.delete), s.offset + ins.length);
  return out;
}

/** The canonical outcome of a thrown value or a verdict (the Go CanonicalVerdict). */
export function canonicalOutcome(run: () => { fields: Record<string, any> }): string {
  try {
    const v = run();
    return `{"fields":${canonValue(v.fields)},"result":"ok"}`;
  } catch (e) {
    if (e instanceof FinalityStateError) return e.canonical();
    return `NOT A NAMED STATE: ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`;
  }
}

/** Runs one case through the TypeScript kind and returns the canonical string. */
export function runCase(c: Case, kind = new BasePostedKind()): string {
  return canonicalOutcome(() => {
    const pins = parsePinsOverride(readPins(c.pins));
    const leg = JSON.parse(read(c.leg).toString('utf8')) as { chain: string; number: string; hash: string; header: string };
    const ev = applySplice(read(c.evidence), c.splice);
    return kind.verify(pins, { chain: BigInt(leg.chain), number: BigInt(leg.number), hash: bytesOfHex(leg.hash), headerRlp: bytesOfHex(leg.header) }, ev);
  });
}

/** The cases of shard i of n, by position in the manifest's sorted list. */
export const shard = (i: number, n: number): string[] => caseNames().filter((_, k) => k % n === i);
