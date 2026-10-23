/**
 * The harness of the Go-published arb l1_posted sets finality_arb_posted2, 3 and 4 (byte-identical copies of the validator's
 * pkg/finality/arbposted/testdata at pv2/rb11-e1-raise@cbb6373): the same case format as finality_arb_posted1 (see vectorset.ts), one
 * VectorSet per directory. A case is {pins, leg, evidence_base, evidence_patch{at,del,ins}, expect_canonical}; the kind judges the evidence
 * under the pins file against the leg, and the CANONICAL verdict string is compared with the Go-written expectation byte for byte.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256 } from '@noble/hashes/sha2';
import { parsePinsOverride } from '../../../src/proof-v2/finality/pins.js';
import { ArbPostedKind } from '../../../src/proof-v2/finality/arbposted/index.js';
import { hexLower } from '../../../src/proof-v2/finality/state.js';
import { canonicalOutcome, refOf, type Case } from './vectorset.js';

const here = dirname(fileURLToPath(import.meta.url));

export const sha256Hex = (b: Uint8Array): string => hexLower(sha256(b));

export interface SetIdentity {
  /** the directory under test/fixtures/finality */
  dir: string;
  /** the set name in MANIFEST.json */
  set: string;
  /** sha256 of the Go-written MANIFEST.json (= MANIFEST.json.sha256) */
  manifestSha256: string;
  cases: number;
  files: number;
  accepting: readonly string[];
}

export class VectorSet {
  readonly id: SetIdentity;
  readonly root: string;
  constructor(id: SetIdentity) {
    this.id = id;
    this.root = join(here, '..', '..', 'fixtures', 'finality', id.dir);
  }

  read = (name: string): Buffer => readFileSync(join(this.root, ...name.split('/')));

  manifest = (): { format: string; set: string; cases: string[]; files: Record<string, string> } => JSON.parse(this.read('MANIFEST.json').toString('utf8'));

  caseNames = (): string[] => this.manifest().cases;

  loadCase = (name: string): Case => JSON.parse(this.read(`cases/${name}.json`).toString('utf8'));

  /** The evidence of a case: base[:at] || ins || base[at+del:] (the base is empty for the synthetic cases). */
  evidenceOf = (c: Case): Uint8Array => {
    const base = c.evidence_base === '' ? new Uint8Array(0) : Uint8Array.from(this.read(c.evidence_base));
    const { at, del } = c.evidence_patch;
    if (at + del > base.length) throw new Error('patch beyond the evidence');
    const insHex = c.evidence_patch.ins.startsWith('0x') ? c.evidence_patch.ins.slice(2) : c.evidence_patch.ins;
    if (!/^([0-9a-f]{2})*$/.test(insHex)) throw new Error('patch is not lower-case hex');
    const ins = Uint8Array.from(insHex.match(/../g) ?? [], (x) => parseInt(x, 16));
    const out = new Uint8Array(at + ins.length + (base.length - at - del));
    out.set(base.subarray(0, at), 0);
    out.set(ins, at);
    out.set(base.subarray(at + del), at + ins.length);
    return out;
  };

  /** Runs one case through the TypeScript kind and returns the canonical string. */
  runCase = (c: Case, kind = new ArbPostedKind()): string =>
    canonicalOutcome(() => kind.verify(parsePinsOverride(this.read(c.pins)), refOf(c.leg), this.evidenceOf(c)));

  /** The cases of shard i of n, by position in the manifest's list. */
  shard = (i: number, n: number): string[] => this.caseNames().filter((_, k) => k % n === i);
}

/** finality_arb_posted2 (RB11-E2B): the Brotli strictness cases, the zero-heavy layer and the derivation of every delayed message kind. */
export const SET2 = new VectorSet({
  dir: 'arb_posted2',
  set: 'finality_arb_posted2',
  manifestSha256: 'f54e8dd2c0927994ee265e3b371610187054188455ab9620a0869aca016cefb7',
  cases: 44,
  files: 46,
  accepting: [
    'valid_brotli_short_stream',
    'valid_brotli_batch_with_tail',
    'valid_brotli_message_segment',
    'valid_zeroheavy_calldata',
    'valid_zeroheavy_blob',
    'synth_valid_delayed_submit_retryable',
    'synth_valid_delayed_unsigned_tx',
    'synth_valid_delayed_contract_tx',
    'synth_valid_delayed_batch',
    'synth_valid_delayed_funded_by_l1',
    'synth_valid_delayed_eth_deposit',
  ],
});

/** finality_arb_posted3 (commit bbe841c): a sequencer-batch message is parsed as Nitro does, any failing nested message fails the whole message. */
export const SET3 = new VectorSet({
  dir: 'arb_posted3',
  set: 'finality_arb_posted3',
  manifestSha256: '31b0f33caff664500260b6b75c35884fe728708580b9bf06d7113e70149fce00',
  cases: 19,
  files: 21,
  accepting: [
    'valid_message_two_signed_txs',
    'valid_message_with_valid_unsigned_nested',
    'valid_message_with_cut_length_tail',
    'valid_message_with_oversize_length_tail',
    'valid_message_with_cut_nested_tail',
    'valid_message_nested_16_deep',
    'valid_second_message_after_a_failed_one',
  ],
});

/** finality_arb_posted4 (RB11-E2-FIX): the completeness fixes of review V-E2-A1, with the seven re-bound twins of set 1. */
export const SET4 = new VectorSet({
  dir: 'arb_posted4',
  set: 'finality_arb_posted4',
  manifestSha256: '86418900e817e8a16e4d01119bf3f5d4263af59069051ee522fa73da47866802',
  cases: 27,
  files: 37,
  accepting: ['valid_delayed_deposit_control', 'valid_toplevel_message_at_cap_262144', 'valid_second_message_after_an_oversize_one', 'valid_control_pins_present'],
});
