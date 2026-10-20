/**
 * The harness of the finality_arb_posted1 conformance set: a byte-identical copy of the validator's
 * pkg/finality/arbposted/testdata/finality_arb_posted1 (pv2/rb11-int@ecfb4fe, manifest 79e70d62...57aa). A case is
 * {pins, leg, evidence_base, evidence_patch{at,del,ins}, expect_canonical}: the evidence is base[:at] || ins || base[at+del:], the kind
 * judges it under the pins file against the leg, and the CANONICAL verdict string is compared with the Go-written expectation byte for byte.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256 } from '@noble/hashes/sha2';
import { parsePinsOverride } from '../../../src/proof-v2/finality/pins.js';
import { ArbPostedKind } from '../../../src/proof-v2/finality/arbposted/index.js';
import { FinalityStateError, hexLower, lvl } from '../../../src/proof-v2/finality/state.js';

const here = dirname(fileURLToPath(import.meta.url));
export const SET_DIR = join(here, '..', '..', 'fixtures', 'finality', 'arb_posted1');
export const REG_DIR = join(here, '..', '..', 'fixtures', 'finality', 'arb_posted1_registry');

/** The sha256 of the Go-written MANIFEST.json (= MANIFEST.json.sha256) of finality_arb_posted1 at pv2/rb11-int@ecfb4fe. */
export const MANIFEST_SHA256 = '79e70d62b0b2417f67798c47b37964f0648adc161e17baea39df94ff07da57aa';

export const read = (name: string): Buffer => readFileSync(join(SET_DIR, ...name.split('/')));
export const sha256Hex = (b: Uint8Array): string => hexLower(sha256(b));
export const bytesOfHex = (s: string): Uint8Array => {
  const h = s.startsWith('0x') ? s.slice(2) : s;
  if (!/^([0-9a-f]{2})*$/.test(h)) throw new Error(`not lower-case hex: ${s.slice(0, 20)}`);
  return Uint8Array.from(h.match(/../g) ?? [], (x) => parseInt(x, 16));
};

export interface Leg {
  chain: string;
  number: string;
  hash: string;
  header_rlp: string;
}
export interface Case {
  format: string;
  id: string;
  description: string;
  pins: string;
  leg: Leg;
  evidence_base: string;
  evidence_patch: { at: number; del: number; ins: string };
  expect_canonical: string;
}

export const manifest = (): { format: string; set: string; cases: string[]; files: Record<string, string> } =>
  JSON.parse(read('MANIFEST.json').toString('utf8'));
export const caseNames = (): string[] => manifest().cases;
export const loadCase = (id: string): Case => JSON.parse(read(`cases/${id}.json`).toString('utf8'));

/** The evidence of a case: base[:at] || ins || base[at+del:] (the base is empty for the synthetic cases). */
export function evidenceOf(c: Case): Uint8Array {
  const base = c.evidence_base === '' ? new Uint8Array(0) : Uint8Array.from(read(c.evidence_base));
  const { at, del } = c.evidence_patch;
  if (at + del > base.length) throw new Error('patch beyond the evidence');
  const ins = bytesOfHex(c.evidence_patch.ins);
  const out = new Uint8Array(at + ins.length + (base.length - at - del));
  out.set(base.subarray(0, at), 0);
  out.set(ins, at);
  out.set(base.subarray(at + del), at + ins.length);
  return out;
}

export const refOf = (l: Leg): { chain: bigint; number: bigint; hash: Uint8Array; headerRlp: Uint8Array } => ({
  chain: BigInt(l.chain),
  number: BigInt(l.number),
  hash: bytesOfHex(l.hash),
  headerRlp: bytesOfHex(l.header_rlp),
});

/** The canonical text of a verdict or a thrown value (the Go verdictCanon). */
export function canonicalOutcome(run: () => { kind: string; level: number; fields: Record<string, any> }): string {
  try {
    const v = run();
    return new FinalityStateError('verified', { ...v.fields, kind: v.kind, level: lvl(v.level) }).canonical();
  } catch (e) {
    if (e instanceof FinalityStateError) return e.canonical();
    return `unnamed: ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`;
  }
}

/** Runs one case through the TypeScript kind and returns the canonical string. */
export function runCase(c: Case, kind = new ArbPostedKind()): string {
  return canonicalOutcome(() => kind.verify(parsePinsOverride(read(c.pins)), refOf(c.leg), evidenceOf(c)));
}

/** The cases of shard i of n, by position in the manifest's list. */
export const shard = (i: number, n: number): string[] => caseNames().filter((_, k) => k % n === i);
