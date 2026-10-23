/**
 * The harness of the Go-published conformance sets of eth-sepolia/finalized/v1: finality_eth_sepolia1 (37 verification cases and 9
 * Pins.Extend cases), finality_eth_sepolia2 (9 cases anchored at the embedded root pin 1378) and finality_eth_sepolia3 (16 ledger cases and
 * 5 lcssz cases), byte-identical copies of pkg/finality/ethsepolia/testdata at pv2/rb11-e1-raise@cbb6373. The drivers are the twins of the
 * Go test drivers (ethsepolia/vectors_test.go, ledger_set3_test.go, lcssz/set3_test.go): the same patch order, the same link-file
 * handling, the same canonical verdict text compared byte for byte with the Go-written expectation.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256 } from '@noble/hashes/sha2';
import { extendPins, verifyLedger } from '../../../src/proof-v2/finality/ledger.js';
import { EthSepoliaKind } from '../../../src/proof-v2/finality/ethsepolia/kind.js';
import { parsePinsOverride, type Pins } from '../../../src/proof-v2/finality/pins.js';
import { FinalityStateError, cmpUtf8, hexLower, lvl } from '../../../src/proof-v2/finality/state.js';
import { ChainSepolia } from '../../../src/proof-v2/finality/table.js';
import type { BlockRef } from '../../../src/proof-v2/finality/evidence.js';
import * as lcssz from '../../../src/proof-v2/finality/ethsepolia/lcssz.js';

const here = dirname(fileURLToPath(import.meta.url));
export const FIXTURES = join(here, '..', '..', 'fixtures', 'finality');

/** The Go-written MANIFEST.json.sha256 of each set at pv2/rb11-e1-raise@cbb6373. */
export const MANIFEST_SHA256 = {
  eth_sepolia1: '1c2b0b9a69c4ae01ba2c96cf615278147352a9cc8ae28eaac743f8c1d1788d2a',
  eth_sepolia2: '9a9879c81a4a4b1ce01ab79aac3dd25b9afd4116a3e1cbb096fca45bd7375b1b',
  eth_sepolia3: 'e50b9a413971a0faf9ca4f62e82b87d423fee037557d72429411f51b8f3b5e14',
} as const;
export type SetName = keyof typeof MANIFEST_SHA256;

export const read = (set: SetName, rel: string): Buffer => readFileSync(join(FIXTURES, set, ...rel.split('/')));
export const sha256Hex = (b: Uint8Array): string => hexLower(sha256(b));
export const bytesOfHex = (s: string): Uint8Array => {
  const h = s.startsWith('0x') ? s.slice(2) : s;
  if (!/^([0-9a-f]{2})*$/.test(h)) throw new Error(`not lower-case hex: ${s.slice(0, 20)}`);
  return Uint8Array.from(h.match(/../g) ?? [], (x) => parseInt(x, 16));
};
const json = <T = any>(set: SetName, rel: string): T => JSON.parse(read(set, rel).toString('utf8')) as T;

export interface Manifest {
  format: string;
  set: string;
  cases: string[];
  files: Record<string, string>;
}
export const manifest = (set: SetName): Manifest => json<Manifest>(set, 'MANIFEST.json');

// ---- verification cases (sets 1 and 2) ----

export interface Leg {
  chain: string;
  number: string;
  hash: string;
  header_rlp: string;
}
export interface Patch {
  at: number;
  del: number;
  ins: string;
}
export interface VerifyCase {
  id: string;
  pins: string;
  leg: Leg;
  evidence_base: string;
  evidence_patches?: Patch[] | null;
  expect_canonical: string;
}
export interface ExtendCase {
  id: string;
  base: string;
  extension: string;
  links_dir: string;
  links_replace?: Record<string, string>;
  links_drop?: number[];
  expect_canonical: string;
}

/** The ids of the verification cases of a set, in manifest order (an id is a verification case iff cases/<id>.json is a manifest file). */
export function verifyIds(set: SetName): string[] {
  const m = manifest(set);
  return m.cases.filter((id) => `cases/${id}.json` in m.files);
}
export function extendIds(set: SetName): string[] {
  const m = manifest(set);
  return m.cases.filter((id) => `extend/${id}.json` in m.files);
}
export const loadVerifyCase = (set: SetName, id: string): VerifyCase => json<VerifyCase>(set, `cases/${id}.json`);

/** The evidence of a case: the base with every patch applied, highest offset first (offsets refer to the BASE; patches never overlap). */
export function evidenceOf(set: SetName, c: VerifyCase): Uint8Array {
  let out: Uint8Array = Uint8Array.from(read(set, c.evidence_base));
  const ps = [...(c.evidence_patches ?? [])].sort((a, b) => b.at - a.at);
  for (const p of ps) {
    const ins = bytesOfHex(p.ins);
    const n = new Uint8Array(p.at + ins.length + (out.length - p.at - p.del));
    n.set(out.subarray(0, p.at), 0);
    n.set(ins, p.at);
    n.set(out.subarray(p.at + p.del), p.at + ins.length);
    out = n;
  }
  return out;
}

export const refOf = (l: Leg): BlockRef => ({ chain: ChainSepolia, number: BigInt(l.number), hash: bytesOfHex(l.hash), headerRlp: bytesOfHex(l.header_rlp) });

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

/** Runs one verification case through the TypeScript kind and returns the canonical string. */
export function runVerifyCase(set: SetName, c: VerifyCase, kind = new EthSepoliaKind()): string {
  const pins = parsePinsOverride(read(set, c.pins));
  return canonicalOutcome(() => kind.verify(pins, refOf(c.leg), evidenceOf(set, c)));
}

/** The verification cases of shard i of n, by position in the set's verification list. */
export const shard = (set: SetName, i: number, n: number): string[] => verifyIds(set).filter((_, k) => k % n === i);

// ---- Pins.Extend cases (set 1) ----

export const loadExtendCase = (id: string): ExtendCase => json<ExtendCase>('eth_sepolia1', `extend/${id}.json`);

function linksOfDir(set: SetName, dir: string): Map<bigint, Uint8Array> {
  const links = new Map<bigint, Uint8Array>();
  const m = manifest(set);
  for (const f of Object.keys(m.files)) {
    if (f.startsWith(`${dir}/`) && f.endsWith('.ssz')) links.set(BigInt(f.slice(dir.length + 1, -4)), Uint8Array.from(read(set, f)));
  }
  return links;
}

export function extendLinks(c: ExtendCase): Map<bigint, Uint8Array> {
  const links = linksOfDir('eth_sepolia1', c.links_dir);
  for (const [p, rel] of Object.entries(c.links_replace ?? {})) links.set(BigInt(p), Uint8Array.from(read('eth_sepolia1', rel)));
  for (const p of c.links_drop ?? []) links.delete(BigInt(p));
  return links;
}

const verifiedExtend = (p: Pins): string =>
  new FinalityStateError('verified', { anchors: BigInt(p.ethSepolia!.anchors.length), pins_source: p.source }).canonical();

export function canonicalExtend(base: Pins, ext: Uint8Array, links: Map<bigint, Uint8Array>): string {
  try {
    return verifiedExtend(extendPins(base, ext, links));
  } catch (e) {
    if (e instanceof FinalityStateError) return e.canonical();
    return `unnamed: ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`;
  }
}

export function runExtendCase(c: ExtendCase): string {
  const base = parsePinsOverride(read('eth_sepolia1', c.base));
  return canonicalExtend(base, read('eth_sepolia1', c.extension), extendLinks(c));
}

// ---- set 3: ledger and lcssz cases ----

export interface LedgerCase {
  id: string;
  op: 'verify_ledger' | 'extend';
  pins: string;
  extension?: string;
  links_dir: string;
  links_only?: number[];
  anchor_patch?: { period: number; field: string; value: string }[];
  link_patch?: { period: number; offset: number; xor: number; relink?: boolean }[];
  link_move?: { from: number; to: number }[];
  expect_canonical: string;
}

/** The characters Go's encoding/json escapes in a string beyond the JSON minimum: < > & and U+2028 U+2029. */
const htmlSafe = new RegExp('[<>&' + String.fromCharCode(0x2028) + String.fromCharCode(0x2029) + ']', 'g');

/** Go's json.MarshalIndent(v, "", "  ") of a document decoded into map[string]any: sorted keys, HTML-safe strings. */
export function marshalIndent(v: unknown, indent = ''): string {
  const inner = `${indent}  `;
  if (v === null) return 'null';
  if (typeof v === 'string') {
    return JSON.stringify(v).replace(htmlSafe, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
  }
  if (typeof v === 'number' || typeof v === 'boolean') return JSON.stringify(v);
  if (Array.isArray(v)) {
    if (v.length === 0) return '[]';
    return `[\n${v.map((x) => `${inner}${marshalIndent(x, inner)}`).join(',\n')}\n${indent}]`;
  }
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o).sort(cmpUtf8);
  if (keys.length === 0) return '{}';
  return `{\n${keys.map((k) => `${inner}${marshalIndent(k)}: ${marshalIndent(o[k], inner)}`).join(',\n')}\n${indent}}`;
}

export const loadLedgerCase = (name: string): LedgerCase => json<LedgerCase>('eth_sepolia3', `ledger/${name}`);
export const ledgerCaseFiles = (): string[] =>
  Object.keys(manifest('eth_sepolia3').files)
    .filter((f) => f.startsWith('ledger/'))
    .map((f) => f.slice('ledger/'.length))
    .sort();

/** The patched pins bytes and link files of a ledger case, by code independent of the Go generator (the twin of ledger_set3_test.go). */
export function ledgerInputs(c: LedgerCase): { patched: Uint8Array; links: Map<bigint, Uint8Array> } {
  const links = new Map<bigint, Uint8Array>();
  for (let p = 1378; p <= 1391; p++) {
    const only = (c.links_only ?? []).length === 0 || (c.links_only ?? []).includes(p);
    if (only) links.set(BigInt(p), Uint8Array.from(read('eth_sepolia3', `${c.links_dir}/${p}.ssz`)));
  }
  const target = c.op === 'extend' ? c.extension! : c.pins;
  const doc = json<any>('eth_sepolia3', target);
  const anchor = (period: number): any => {
    const a = doc.eth_sepolia.anchors.find((x: any) => x.period === period);
    if (a === undefined) throw new Error(`${c.id}: no anchor ${period}`);
    return a;
  };
  for (const lp of c.link_patch ?? []) {
    links.get(BigInt(lp.period))![lp.offset]! ^= lp.xor;
    if (lp.relink) anchor(lp.period).link_sha256 = sha256Hex(links.get(BigInt(lp.period))!);
  }
  for (const ap of c.anchor_patch ?? []) {
    if (ap.field === 'block_root') anchor(ap.period).block_root = ap.value;
    else if (ap.field === 'period') anchor(ap.period).period = Number(ap.value);
    else throw new Error(`${c.id}: patch field ${ap.field}`);
  }
  for (const mv of c.link_move ?? []) {
    links.set(BigInt(mv.to), links.get(BigInt(mv.from))!);
    links.delete(BigInt(mv.from));
  }
  let patched: Uint8Array = Uint8Array.from(read('eth_sepolia3', target));
  if ((c.anchor_patch ?? []).length + (c.link_patch ?? []).length > 0) patched = new TextEncoder().encode(`${marshalIndent(doc)}\n`);
  return { patched, links };
}

export function runLedgerCase(c: LedgerCase): string {
  const { patched, links } = ledgerInputs(c);
  try {
    if (c.op === 'verify_ledger') {
      const p = parsePinsOverride(patched);
      verifyLedger(p, links);
      return new FinalityStateError('verified', { anchors: BigInt(p.ethSepolia!.anchors.length) }).canonical();
    }
    const base = parsePinsOverride(read('eth_sepolia3', c.pins));
    return verifiedExtend(extendPins(base, patched, links));
  } catch (e) {
    if (e instanceof FinalityStateError) return e.canonical();
    return `unnamed: ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`;
  }
}

export interface LcsszCase {
  id: string;
  len: number;
  att_off: number;
  fin_off: number;
  exec_hash?: string;
  exec_number?: number;
  expect: 'ok' | 'finalized_header_too_short' | 'invalid';
}
export const lcsszCaseFiles = (): string[] =>
  Object.keys(manifest('eth_sepolia3').files)
    .filter((f) => f.startsWith('lcssz/'))
    .map((f) => f.slice('lcssz/'.length))
    .sort();
export const loadLcsszCase = (name: string): LcsszCase => json<LcsszCase>('eth_sepolia3', `lcssz/${name}`);

/** The shape of a case: a length and two offsets, the rest zero, the execution hash and number planted where an electra finalized header carries them. */
export function lcsszShape(c: LcsszCase): Uint8Array {
  const fu = new Uint8Array(c.len);
  const dv = new DataView(fu.buffer);
  dv.setUint32(0, c.att_off, true);
  dv.setUint32(4, c.fin_off, true);
  if (c.exec_hash !== undefined && c.exec_hash !== '') {
    const ex = fu.subarray(c.fin_off + lcssz.SIZES.electraHeaderFixed);
    ex.set(bytesOfHex(c.exec_hash), lcssz.SIZES.electraExecHashAt);
    new DataView(ex.buffer, ex.byteOffset).setBigUint64(lcssz.SIZES.electraExecNumberAt, BigInt(c.exec_number ?? 0), true);
  }
  return fu;
}
