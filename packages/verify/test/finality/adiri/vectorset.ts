/**
 * The harness of the finality_adiri3 conformance set: a byte-identical copy of the validator's
 * pkg/finality/adiri/testdata/finality_adiri3 (pv2/rb11-int@ee6d106, MANIFEST.json sha256 41b94696...). A vector is {pins, leg, evidence |
 * base+edits, expect}: the kind judges the evidence under the pins against the leg and the CANONICAL verdict string (code "finalized" for
 * a verdict) is compared with the Go-written expectation byte for byte.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256 } from '@noble/hashes/sha2';
import { PINS_FORMAT, type Pins } from '../../../src/proof-v2/finality/pins.js';
import { JObj, parseGoJson } from '../../../src/s3/jsonx.js';
import { AdiriVerifier, type VerifierOptions } from '../../../src/proof-v2/finality/adiri/index.js';
import type { BlockRef } from '../../../src/proof-v2/finality/evidence.js';
import { FinalityStateError, asNamed, hexLower, newState } from '../../../src/proof-v2/finality/state.js';

const here = dirname(fileURLToPath(import.meta.url));
export const SET_DIR = join(here, '..', '..', 'fixtures', 'finality', 'adiri3');
export const REGISTRY_DIR = join(here, '..', '..', 'fixtures', 'finality', 'adiri3_registry');

/** The sha256 of the Go-written MANIFEST.json (= MANIFEST.json.sha256) of finality_adiri3 at pv2/rb11-int@ee6d106. */
export const MANIFEST_SHA256 = '41b94696a291c36b803f74c3375b7e111f057cb83dba99006f4b2796e7c27ef7';
/** The sha256 of the embedded pins file (pkg/finality/pins/finality-pins.json at pv2/rb11-int@ee6d106, with the adiri section). */
export const ADIRI_PINS_SHA256 = '12217758b3a8074a07873cd3d26cc46edab7782d31f393d7f540c3e3077062d5';
/** The sha256 of testdata/finality/states.json at pv2/rb11-int@ee6d106. */
export const STATES_SHA256 = '0521d55f101e6815872ccd11884d710594b79329f073226d7d5c05437fae2e60';

export const readSet = (name: string): Buffer => readFileSync(join(SET_DIR, ...name.split('/')));
export const sha256Hex = (b: Uint8Array): string => hexLower(sha256(b));
export const bytesOfHex = (s: string): Uint8Array => {
  const h = s.startsWith('0x') ? s.slice(2) : s;
  if (!/^([0-9a-f]{2})*$/.test(h)) throw new Error(`not lower-case hex: ${s.slice(0, 20)}`);
  return Uint8Array.from(h.match(/../g) ?? [], (x) => parseInt(x, 16));
};

export interface Edit {
  offset: number;
  delete: number;
  insert: string;
}
export interface Vec {
  name: string;
  group: string;
  note: string;
  leg: { chain: number; number: number; hash: string; header_hex: string };
  pins: unknown;
  evidence?: string;
  base?: string;
  edits?: Edit[];
  expect: string;
}
export interface VecFile {
  format: string;
  vectors: Vec[];
}

export const loadVectors = (): VecFile => JSON.parse(readSet('vectors.json').toString('utf8'));
let cached: VecFile | undefined;
export const vectors = (): Vec[] => (cached ??= loadVectors()).vectors;

/** A vector's evidence: its own file, or its base's with the edits applied (highest offset first). */
export function evidenceOf(v: Vec, all: readonly Vec[] = vectors()): Uint8Array {
  if (v.evidence !== undefined && v.evidence !== '') return Uint8Array.from(readSet(`evidence/${v.evidence}`));
  const base = all.find((x) => x.name === v.base);
  if (base === undefined) throw new Error(`${v.name}: base ${v.base} not found`);
  let out = evidenceOf(base, all);
  for (const e of [...(v.edits ?? [])].sort((a, b) => b.offset - a.offset)) {
    const ins = bytesOfHex(e.insert);
    const next = new Uint8Array(e.offset + ins.length + (out.length - e.offset - e.delete));
    next.set(out.subarray(0, e.offset), 0);
    next.set(ins, e.offset);
    next.set(out.subarray(e.offset + e.delete), e.offset + ins.length);
    out = next;
  }
  return out;
}

let embedded: Pins | undefined;
/**
 * The embedded pins file of the Go set (with the adiri section), loaded against its pinned hash. The framework loader of this branch
 * predates the file's top-level "shared" key (pkg/finality/pins.go, pv2/rb11-int) and refuses it, so the Adiri harness reads the one
 * section this kind consumes straight from the hash-checked bytes; the framework loader is replaced at integration (see the check-in).
 */
export function embeddedAdiriPins(): Pins {
  if (embedded === undefined) {
    const raw = Uint8Array.from(readFileSync(join(REGISTRY_DIR, 'finality-pins.json')));
    const sum = sha256(raw);
    if (hexLower(sum) !== ADIRI_PINS_SHA256) throw new Error('the embedded adiri pins file is not the pinned one');
    const doc = parseGoJson(raw);
    if (!(doc instanceof JObj)) throw new Error('pins file is not an object');
    const sections = new Map<string, any>();
    for (const [k, v] of doc.pairs) if (k === 'adiri') sections.set(k, v);
    embedded = { format: PINS_FORMAT, publishedUtc: '', onchainCommitment: null, ethSepolia: null, sections, sha256: sum, source: 'embedded' };
  }
  return embedded;
}

/** A Pins whose only section is the given adiri section (as the Go test builds it). */
export function pinsWithSection(section: unknown): Pins {
  const base = embeddedAdiriPins();
  const sections = new Map(base.sections);
  sections.clear();
  sections.set('adiri', parseGoJson(JSON.stringify(section)));
  return { ...base, ethSepolia: null, sections, source: 'test' };
}

export function pinsOf(v: Vec): Pins {
  return v.pins === 'embedded' ? embeddedAdiriPins() : pinsWithSection(v.pins);
}

export function legOf(v: Vec): BlockRef {
  const b: BlockRef = { chain: BigInt(v.leg.chain), number: BigInt(v.leg.number), hash: bytesOfHex(v.leg.hash) };
  if (v.leg.header_hex) b.headerRlp = bytesOfHex(v.leg.header_hex);
  return b;
}

/** The canonical text of a verification: a verdict is code "finalized"; a thrown value that is not a named state is reported as such. */
export function outcome(run: () => { fields: Record<string, any> }): string {
  try {
    return newState('finalized', run().fields).canonical();
  } catch (e) {
    const s = asNamed(e);
    if (s instanceof FinalityStateError) return s.canonical();
    return `ERROR: ${e instanceof Error ? e.message : String(e)}`;
  }
}

export function judge(v: Vec, opts: VerifierOptions = {}): string {
  const kind = new AdiriVerifier(opts);
  const pins = pinsOf(v);
  const leg = legOf(v);
  const ev = evidenceOf(v);
  return outcome(() => kind.verify(pins, leg, ev));
}

/** The vectors decided before any signature work on a long chain, or on a chain of a few records: cheap in either signature mode. */
export const isFast = (v: { name: string; group: string; expect: string; evidence?: string }): boolean => {
  if (v.group === 'live') return false;
  const j = JSON.parse(v.expect) as { code: string; fields: Record<string, unknown> };
  if (j.code === 'finalized') return v.name.startsWith('syn');
  if (j.code === 'committee_chain_broken') return j.fields.check !== 'signature_invalid';
  if (j.code === 'finality_block_mismatch') return j.fields.field === 'blockHash' || j.fields.field === 'blockNumber';
  if (j.code === 'finality_link_broken' || j.code === 'finality_header_chain_broken') return v.name.startsWith('syn');
  return true;
};
