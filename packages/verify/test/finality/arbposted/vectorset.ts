/**
 * The harness of the finality_arb_posted1 conformance set: a byte-identical copy of the validator's
 * pkg/finality/arbposted/testdata/finality_arb_posted1 (pv2/rb11-int@ecfb4fe, manifest 79e70d62...57aa; unchanged at cbb6373, which adds
 * SUPERSEDED.md: nine of its expectations are judged by the supersession table below, exactly as the Go test does). A case is
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

/**
 * The nine cases of finality_arb_posted1 whose recorded expectation was superseded (SUPERSEDED.md, the Go test's supersededInSet2 and
 * supersededInSet4): two zero-heavy cases (the layer is now decoded, so the same bytes read as l1_batch_header_unknown{byte:77}) and seven
 * cases that pair a synthetic leg with the recorded container (Kind.Verify now binds the BlockRef: finality_block_mismatch{blockHash}, want =
 * the case leg's hash, got = the recorded live block's hash). The set's files are not edited; finality_arb_posted4 carries the seven again.
 */
const LIVE_HASH = '0x83d81943ea8f2f51d14bb50594d8d0ae12cd576e8891816e26a9c17fdca0c9f4';
const liveHashMismatch = (legHash: string): string => `{"code":"finality_block_mismatch","fields":{"field":"blockHash","got":"${LIVE_HASH}","want":"${legHash}"}}`;
export const SUPERSEDED: Readonly<Record<string, string>> = {
  adv_synth_calldata_flag_zeroheavy: '{"code":"l1_batch_header_unknown","fields":{"batch":"77","byte":"77"}}',
  adv_synth_blob_payload_zeroheavy: '{"code":"l1_batch_header_unknown","fields":{"batch":"77","byte":"77"}}',
  adv_tx_altered: liveHashMismatch('0x051307b3a477cf0b336b5dde6f044f3cd32be61872fe7fbb8a1f9027181eb2e3'),
  adv_tx_order_swapped: liveHashMismatch('0x19a0efee390b8519ae885b8a045fc363dea85b059b25080e73a1478c1af5badc'),
  adv_tx_missing: liveHashMismatch('0x324c892e5293309b4c7550fdd526c53057c04cf43319cfd513f6481ad1a07f5b'),
  adv_tx_extra: liveHashMismatch('0xaabed1854d210a115872480a10b953870d1430d72e874fd92a0b72e25ee3796e'),
  adv_no_standard_transactions: liveHashMismatch('0x55ce73fa225c341b51740cefdadfbd33856ddfd15da8a6336199e120b5670ab4'),
  adv_unsupported_tx_type: liveHashMismatch('0xb45075a1c3c86368270bc66b00dba3c75a8bb7e96272ea8705689de893daeb60'),
  adv_delayed_origin_without_proof: liveHashMismatch('0xe9be37ad6eb86d61c053a03e9661c179f0f40453777420851267bd65520f9127'),
};

/** The canonical verdict a case is judged against: the supersession table where the Go set records one, else the case's own expectation. */
export const expectedOf = (c: Case): string => SUPERSEDED[c.id] ?? c.expect_canonical;

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
