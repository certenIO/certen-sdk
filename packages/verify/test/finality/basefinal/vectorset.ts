/**
 * The harness of the finality_base_final1 conformance set: a byte-identical copy of the validator's
 * pkg/finality/basefinal/testdata/finality_base_final1 (pv2/rb11-d1-final, manifest 4f945f2d...b4d0; published sets are never edited).
 *
 * Two kinds of case, both compared with the Go-written CANONICAL verdict string byte for byte:
 *  - a LIVE case {pins, leg, evidence, splice?, expect} gives a full CFE1 container; the splice is applied to the named base evidence and
 *    the kind judges it under the pins file against the leg (light-client chain, spine, L1 state proofs, output root, L2 spine);
 *  - a JUDGE case {pins, a, leg, game_proxy, game_code, output_root_index, l2_spine, nodes, expect} gives the WORLD the judgement runs
 *    over: the L1 block A as the covered spine would have given it (a SYNTHETIC world's state root), and expects the judge's verdict
 *    (the part of 5.5 that follows the L1 head: O2-O6). Judge cases reach every rule no live Base game can reach.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256 } from '@noble/hashes/sha2';
import { parsePinsOverride, type Pins } from '../../../src/proof-v2/finality/pins.js';
import { BaseFinalKind, judgeBase, parseBasePins, type Body } from '../../../src/proof-v2/finality/basefinal/index.js';
import { FinalityStateError, canonValue, hexLower } from '../../../src/proof-v2/finality/state.js';
import type { BlockRef } from '../../../src/proof-v2/finality/evidence.js';

const here = dirname(fileURLToPath(import.meta.url));
export const SET_DIR = join(here, '..', '..', 'fixtures', 'finality', 'base_final1');

/** The sha256 of the Go-written manifest.json (= MANIFEST.sha256) of finality_base_final1 at pv2/rb11-d1-final. */
export const MANIFEST_SHA256 = '4f945f2d10b788b657d6d45ceeb8e13f79e84026d940e4616532ac5687d0b4d0';

export const read = (name: string): Buffer => readFileSync(join(SET_DIR, ...name.split('/')));
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
export interface Expect {
  result?: 'ok';
  code?: string;
  fields: unknown;
}
export interface LegFile {
  chain: string;
  number: string;
  hash: string;
  header: string;
}
export interface Case {
  format: string;
  id: string;
  description: string;
  pins: string;
  leg: string;
  evidence: string;
  splice?: Splice;
  expect: Expect;
}
export interface JudgeCase {
  format: string;
  id: string;
  description: string;
  pins: string;
  a: { number: string; hash: string; state_root: string; timestamp: string };
  leg: LegFile;
  game_proxy: string;
  game_code: string;
  output_root_index: string;
  l2_spine: string[] | null;
  nodes: string[] | null;
  expect: Expect;
}

export const manifest = (): { cases: string[]; judge_cases: string[]; files: Record<string, string> } =>
  JSON.parse(read('manifest.json').toString('utf8'));
export const caseNames = (): string[] => manifest().cases;
export const judgeNames = (): string[] => manifest().judge_cases;
export const loadCase = (id: string): Case => JSON.parse(read(`cases/${id}.json`).toString('utf8'));
export const loadJudge = (id: string): JudgeCase => JSON.parse(read(`judge/${id}.json`).toString('utf8'));

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
export function expectedOf(c: { expect: Expect }): string {
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

/** A world that cannot be loaded (the twin of the Go JudgeLoadError, same text): the field, the value, and what the value is not. */
export class JudgeLoadError extends Error {
  constructor(
    readonly field: string,
    readonly value: string,
    readonly want: string,
  ) {
    super(`judge case load error: field ${field}: value ${JSON.stringify(value)} is not ${want}`);
    this.name = 'JudgeLoadError';
  }
}
/** A decimal of at most `bits` bits: digits only (no sign, space, prefix or underscore), within range. */
export function loadDecimal(field: string, s: string, bits: 32 | 64): bigint {
  if (!/^[0-9]+$/.test(s) || BigInt(s) >= 1n << BigInt(bits)) throw new JudgeLoadError(field, s, `a decimal uint${bits}`);
  return BigInt(s);
}
/** Lower-case hex with an optional 0x prefix; size >= 0 fixes the byte length. */
export function loadHex(field: string, s: string, size = -1): Uint8Array {
  const want = size >= 0 ? `lower-case hex of ${size} bytes` : 'lower-case hex';
  const h = s.startsWith('0x') ? s.slice(2) : s;
  if (!/^([0-9a-f]{2})*$/.test(h) || (size >= 0 && h.length !== 2 * size)) throw new JudgeLoadError(field, s, want);
  return Uint8Array.from(h.match(/../g) ?? [], (x) => parseInt(x, 16));
}

export const legRef = (l: LegFile): BlockRef => {
  const chain = loadDecimal('leg.chain', l.chain, 64);
  const number = loadDecimal('leg.number', l.number, 64);
  return { chain, number, hash: loadHex('leg.hash', l.hash, 32), headerRlp: loadHex('leg.header', l.header) };
};

/** Runs one live case through the TypeScript kind and returns the canonical string. */
export function runCase(c: Case, kind = new BaseFinalKind()): string {
  return canonicalOutcome(() => {
    const pins = parsePinsOverride(read(c.pins));
    const leg = JSON.parse(read(c.leg).toString('utf8')) as LegFile;
    const ev = applySplice(read(c.evidence), c.splice);
    return kind.verify(pins, legRef(leg), ev);
  });
}

/** The judge-level world of a case as the body and L1 block the judge takes (the Go JudgeCase.Run). */
export function judgeWorld(c: JudgeCase): { a: { hash: Uint8Array; number: bigint; stateRoot: Uint8Array; timestamp: bigint }; body: Body; leg: BlockRef } {
  // the order of the Go JudgeCase.load: a.number, a.timestamp, a.hash, a.state_root, output_root_index, game_proxy, game_code, spine, nodes, leg
  const num = loadDecimal('a.number', c.a.number, 64);
  const timestamp = loadDecimal('a.timestamp', c.a.timestamp, 64);
  const hash = loadHex('a.hash', c.a.hash, 32);
  const stateRoot = loadHex('a.state_root', c.a.state_root, 32);
  const outputRootIndex = Number(loadDecimal('output_root_index', c.output_root_index, 32));
  const gameProxy = loadHex('game_proxy', c.game_proxy, 20);
  const gameCode = loadHex('game_code', c.game_code);
  const l2Spine = (c.l2_spine ?? []).map((h, i) => loadHex(`l2_spine[${i}]`, h));
  const nodes = (c.nodes ?? []).map((h, i) => loadHex(`nodes[${i}]`, h));
  const leg = legRef(c.leg);
  return {
    a: { number: num, hash, stateRoot, timestamp },
    body: { lc: undefined as never, l1Spine: [], stateBlock: num, gameProxy, gameCode, outputRootIndex, l2Spine, nodes },
    leg,
  };
}

/** Runs one judge-level case through the TypeScript judge (a head with slot 0 and no participants, as Go) and returns the canonical string. */
export function runJudge(c: JudgeCase, pinsOverride?: Pins): string {
  return canonicalOutcome(() => {
    const pins = pinsOverride ?? parsePinsOverride(read(c.pins));
    const bp = parseBasePins(pins);
    const w = judgeWorld(c);
    return { fields: judgeBase(bp, w.a, w.body, w.leg, { slot: 0n, participants: 0 }) };
  });
}

/** The cases of shard i of n, by position in the manifest's sorted list. */
export const shard = (names: string[], i: number, n: number): string[] => names.filter((_, k) => k % n === i);
