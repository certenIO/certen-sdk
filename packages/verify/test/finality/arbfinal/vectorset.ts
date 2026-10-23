/**
 * The harness of the arb-sepolia/finalized/v1 conformance sets: byte-identical copies of the validator's
 * pkg/finality/arbfinal/testdata/{finality_arb_final1, finality_arb_final2, finality_arb_final3, finality_arb_force1} (pv2/rb11-e1-raise@cbb6373;
 * published sets are never edited). A vector is {name, group, note, leg{chain, number, hash, header_hex}, pins, evidence | base + edits, expect}:
 * the evidence is its own file, or the named base vector's evidence with the edits applied (highest offset first), the kind judges it under
 * the pins file against the leg, and the CANONICAL verdict text ({code, fields}; a verdict is code "finalized") is compared with the
 * Go-written literal byte for byte.
 *
 * Sets 1 and 2 predate the wallet pins (RB12-E1RAISE) and store their pins files without them: like the Go harness, withWalletPins adds the four
 * wallet pins to each stored pins file's arb_sepolia section (and re-serializes with the keys SORTED, as Go's json.Marshal of maps writes
 * them: the pins parser refuses unsorted keys), so the unedited sets are judged by the verifier that requires those pins. Set 3 carries them.
 *
 * The kind is loaded lazily (load()), so that a build without the package fails each test on its own instead of the whole file at collection.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256 } from '@noble/hashes/sha2';
import { parseGoJson, JNum, JObj, type JVal } from '../../../src/s3/jsonx.js';
import { embeddedPins, parsePinsOverride, type Pins } from '../../../src/proof-v2/finality/pins.js';
import { FinalityStateError, cmpUtf8, hexLower } from '../../../src/proof-v2/finality/state.js';
import type { BlockRef } from '../../../src/proof-v2/finality/evidence.js';

/** The package under test, loaded on first use. */
export const load = async (): Promise<typeof import('../../../src/proof-v2/finality/arbfinal/index.js')> =>
  import('../../../src/proof-v2/finality/arbfinal/index.js');

const here = dirname(fileURLToPath(import.meta.url));
export const FIXTURES = join(here, '..', '..', 'fixtures', 'finality');

export interface SetInfo {
  /** the validator's set name */
  name: string;
  /** the directory under test/fixtures/finality */
  dir: string;
  /** the sha256 of the Go-written MANIFEST.json (= MANIFEST.json.sha256) */
  manifestSha256: string;
  format: string;
  vectors: number;
  /** the set stores its pins files without the wallet pins */
  walletPins: boolean;
}

export const FINAL1: SetInfo = {
  name: 'finality_arb_final1',
  dir: 'arb_final1',
  manifestSha256: '444aeb1bb9028cdfc37c0db993539a7a86521ca550f4bb1585569a69583b944f',
  format: 'finality_arb_final1/1',
  vectors: 125,
  walletPins: true,
};
export const FINAL2: SetInfo = {
  name: 'finality_arb_final2',
  dir: 'arb_final2',
  manifestSha256: 'd66c84963b219122c615fb71e3156765a361e02cdb979ea9c10be8668b5d2ea2',
  format: 'finality_arb_final2/1',
  vectors: 15,
  walletPins: true,
};
export const FINAL3: SetInfo = {
  name: 'finality_arb_final3',
  dir: 'arb_final3',
  manifestSha256: '6546ea7a31986ec9f69a9b4efbe37357c67ea6db1012bb78eeb4a0a2c9e4a8d8',
  format: 'finality_arb_final3/1',
  vectors: 86,
  walletPins: false,
};
/** The TS-held supplement (not a Go-published set): worlds judged by the Go verifier at cbb6373, see arb_final_x/README.md. Its manifest is computed in this repository. */
export const FINALX: SetInfo = {
  name: 'arb_final_x',
  dir: 'arb_final_x',
  manifestSha256: 'd718211fb28c4f8ba82e9c2a04034568b80492e5d9318929d9a51b82130e900f',
  format: 'arb_final_x/1',
  vectors: 8,
  walletPins: false,
};
export const FORCE1_MANIFEST_SHA256 = '7761e96e5b3219890f63c89ba383858d1286781c1adb39123003b19ab13d6192';

export const sha256Hex = (b: Uint8Array): string => hexLower(sha256(b));
export const readIn = (dir: string, name: string): Buffer => readFileSync(join(FIXTURES, dir, ...name.split('/')));
export const bytesOfHex = (s: string): Uint8Array => {
  const h = s.startsWith('0x') ? s.slice(2) : s;
  if (!/^([0-9a-fA-F]{2})*$/.test(h)) throw new Error(`not hex: ${s.slice(0, 20)}`);
  return Uint8Array.from(h.match(/../g) ?? [], (x) => parseInt(x, 16));
};

export interface Edit {
  offset: number;
  delete: number;
  insert: string;
}
export interface Leg {
  chain: number;
  number: number;
  hash: string;
  header_hex?: string;
}
export interface Vector {
  name: string;
  group: string;
  note: string;
  leg: Leg;
  pins: string;
  evidence?: string;
  base?: string;
  edits?: Edit[];
  expect: string;
}
export interface VectorFile {
  format: string;
  vectors: Vector[];
}

export const manifestOf = (s: SetInfo): { files: Record<string, string> } => JSON.parse(readIn(s.dir, 'MANIFEST.json').toString('utf8'));

const cache = new Map<string, VectorFile>();
export function loadSet(s: SetInfo): VectorFile {
  let f = cache.get(s.dir);
  if (f === undefined) {
    f = JSON.parse(readIn(s.dir, 'vectors.json').toString('utf8')) as VectorFile;
    cache.set(s.dir, f);
  }
  return f;
}
export const vectorByName = (s: SetInfo, name: string): Vector => {
  const v = loadSet(s).vectors.find((x) => x.name === name);
  if (v === undefined) throw new Error(`${s.dir}: no vector ${name}`);
  return v;
};

/** A vector's evidence bytes: its own file, or its base's with the edits applied (highest offset first). */
export function evidenceOf(s: SetInfo, v: Vector): Uint8Array {
  if (v.evidence !== undefined && v.evidence !== '') return Uint8Array.from(readIn(s.dir, `evidence/${v.evidence}`));
  const base = loadSet(s).vectors.find((x) => x.name === v.base);
  if (base === undefined) throw new Error(`${v.name}: base ${v.base} not found`);
  let out = evidenceOf(s, base);
  for (const e of [...(v.edits ?? [])].sort((a, b) => b.offset - a.offset)) {
    const ins = bytesOfHex(e.insert);
    if (e.offset + e.delete > out.length) throw new Error(`${v.name}: edit beyond the evidence`);
    const next = new Uint8Array(e.offset + ins.length + (out.length - e.offset - e.delete));
    next.set(out.subarray(0, e.offset), 0);
    next.set(ins, e.offset);
    next.set(out.subarray(e.offset + e.delete), e.offset + ins.length);
    out = next;
  }
  return out;
}

export function legOf(v: Vector): BlockRef {
  for (const k of [v.leg.chain, v.leg.number]) if (!Number.isSafeInteger(k)) throw new Error(`${v.name}: leg number beyond 2^53`);
  const hash = bytesOfHex(v.leg.hash);
  if (hash.length !== 32) throw new Error(`${v.name}: leg hash`);
  const b: BlockRef = { chain: BigInt(v.leg.chain), number: BigInt(v.leg.number), hash };
  if (v.leg.header_hex !== undefined && v.leg.header_hex !== '') b.headerRlp = bytesOfHex(v.leg.header_hex);
  return b;
}

// ---- the wallet pins injection (Go synthworld.WithWalletPins) ----

/** The four pins the wallet route needs beyond the pins of a published set (Go synthworld.WalletPinKeys); a test asserts they are the embedded file's. */
export const WALLET_IMPL = '0x579831De7576B8580A2BEaa5F56b4b32e1292419';
export const WALLET_IMPL_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
export const WALLET_PROXY_CODE_HASH = '0x8736329b580cfc0c0c39ee6700515e0bc51652afb614640db9e34a5d784933e8';
export const WALLET_LOGIC_CODE_HASH = '0x41aae8a0f910daa7a04450a94f864df487c0226c75e1809298c297d7f9e2f33a';

type Plain = null | boolean | string | JNum | Plain[] | Map<string, Plain>;

/** json.Unmarshal into map[string]any with UseNumber: objects become maps (a repeated key keeps its last value), numbers keep their literal. */
function plain(v: JVal): Plain {
  if (v instanceof JObj) {
    const m = new Map<string, Plain>();
    for (const [k, x] of v.pairs) m.set(k, plain(x));
    return m;
  }
  if (Array.isArray(v)) return v.map(plain);
  return v;
}

/** Compact JSON. Objects that were maps are written with their keys sorted (json.Marshal of a map); a raw value keeps its own order (json.RawMessage). */
function ser(v: Plain | JVal): string {
  if (v === null) return 'null';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'string') return JSON.stringify(v);
  if (v instanceof JNum) return v.lit;
  if (Array.isArray(v)) return `[${(v as Plain[]).map(ser).join(',')}]`;
  if (v instanceof JObj) return `{${v.pairs.map(([k, x]) => `${JSON.stringify(k)}:${ser(x)}`).join(',')}}`;
  const keys = [...v.keys()].sort(cmpUtf8);
  return `{${keys.map((k) => `${JSON.stringify(k)}:${ser(v.get(k)!)}`).join(',')}}`;
}

/**
 * The pins file of a published set with the wallet pins added to its arb_sepolia section: the harness side of the pins amendment, so a
 * published set's vectors are judged by a verifier that requires those pins without editing the set's files. A file without the section, or
 * without its confirm_path / proxy_slots / logic_pins objects, or that already carries all four pins, is returned as it came; otherwise the file
 * is re-serialized with the keys sorted at the top level and inside the section (the pins parser refuses unsorted keys), the logic_pins keys
 * lower-case 0x-hex, every other section as the file wrote it.
 */
export function withWalletPins(raw: Uint8Array): Uint8Array {
  const doc = parseGoJson(raw);
  if (!(doc instanceof JObj)) throw new Error('pins file is not an object');
  const top = new Map<string, JVal>(doc.pairs);
  const secRaw = top.get('arb_sepolia');
  if (secRaw === undefined || secRaw === null) return raw;
  const sec = plain(secRaw);
  if (!(sec instanceof Map)) throw new Error('arb_sepolia is not an object');
  const cp = sec.get('confirm_path');
  const ps = sec.get('proxy_slots');
  const lp = sec.get('logic_pins');
  if (!(cp instanceof Map) || !(ps instanceof Map) || !(lp instanceof Map)) return raw;
  if (
    cp.get('validator_wallet_impl') === WALLET_IMPL &&
    ps.get('wallet_impl') === WALLET_IMPL_SLOT &&
    lp.get(WALLET_PROXY_CODE_HASH.toLowerCase()) === 'validator_wallet_proxy' &&
    lp.get(WALLET_LOGIC_CODE_HASH.toLowerCase()) === 'validator_wallet_logic'
  ) {
    return raw;
  }
  cp.set('validator_wallet_impl', WALLET_IMPL);
  ps.set('wallet_impl', WALLET_IMPL_SLOT);
  lp.set(WALLET_PROXY_CODE_HASH.toLowerCase(), 'validator_wallet_proxy');
  lp.set(WALLET_LOGIC_CODE_HASH.toLowerCase(), 'validator_wallet_logic');
  const keys = [...top.keys()].sort(cmpUtf8);
  const text = `{${keys.map((k) => `${JSON.stringify(k)}:${k === 'arb_sepolia' ? ser(sec) : ser(top.get(k)!)}`).join(',')}}`;
  return new TextEncoder().encode(text);
}

/** A vector's pins: "embedded" (the embedded file, which carries the wallet pins) or the named file of the set's pins/ directory. */
export function pinsOf(s: SetInfo, v: Vector): Pins {
  if (v.pins === 'embedded') return embeddedPins();
  let raw: Uint8Array = readIn(s.dir, `pins/${v.pins}`);
  if (s.walletPins) raw = withWalletPins(raw);
  return parsePinsOverride(raw);
}

/** The canonical text of a verification: the named state's {code, fields}, a verdict as code "finalized" (the Go outcome). */
export function canonicalOutcome(run: () => { fields: Record<string, any> }): string {
  try {
    return new FinalityStateError('finalized', run().fields).canonical();
  } catch (e) {
    if (e instanceof FinalityStateError) return e.canonical();
    return `ERROR: ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`;
  }
}

/** Runs one vector through the TypeScript kind. */
export async function runVector(s: SetInfo, v: Vector): Promise<string> {
  const { ArbFinalKind } = await load();
  const pins = pinsOf(s, v);
  const leg = legOf(v);
  const ev = evidenceOf(s, v);
  return canonicalOutcome(() => new ArbFinalKind().verify(pins, leg, ev));
}

/** The vectors of shard i of n, by position in the set's list. */
export const shard = (s: SetInfo, i: number, n: number): Vector[] => loadSet(s).vectors.filter((_, k) => k % n === i);

// ---- the superseded verdicts (Go vectors_test.go supersededInSet3, vectors2_test.go supersededInSet2To3) ----

/** The verdict now of a world whose callee is not proven to be a ValidatorWallet: confirmation_path_unproven{indirect}, judged at K (11,999,995 in the synthetic worlds). */
export const indirectNow = (tx: string): string =>
  `{"code":"confirmation_path_unproven","fields":{"l1_block":"11999995","reason":"indirect","tx":"${tx}"}}`;

export const SUPERSEDED_IN_SET1: Readonly<Record<string, string>> = {
  synth_valid_wallet_execute_transaction: indirectNow('0x5f9a2bef6769850abfa377006e84753eec4627d560fe7c557c8daf30ba564f2b'),
  synth_valid_wallet_execute_transactions: indirectNow('0x77173d1eb1ecb3d3c81b5c2fb565d3f389bad9bdec4719b128ae89f8b54d1a39'),
  synth_valid_wallet_execute_transaction_with_gas_refunder: indirectNow('0x338d892032735a065ac51b55158a9fb3c2f607293f33c56b73af41c1cec09337'),
  synth_valid_wallet_execute_transactions_with_gas_refunder: indirectNow('0x7bf80577fe61ea4ef37f5e6fa9cf68aace22fd6ca3fbd748cb71576d68bedf84'),
  adv_conf_wallet_call_targets_other_contract: indirectNow('0x6376b7f7118925c2a4e2ad89f6de24b67460500d0cbcbe6cbf3b5eccebb8247b'),
  adv_conf_wallet_call_other_selector: indirectNow('0x62001c4cfe884b267fe8e1c055b1c60d2da9c0408741c4744286f6eebe553f1d'),
  adv_conf_wallet_fast_call: indirectNow('0x7f173f2c88f247718c011b585ca10e334bb114c3446e3f7e71d552a745af9e95'),
  adv_conf_wallet_force_call: indirectNow('0x07d6bfa77b6309da6bb20ece74fd59f96b26ad473cfe19a23ccb1a8ed3fa6b85'),
  adv_conf_wallet_fast_confirmer_nonzero: indirectNow('0x9a1986f61c5a411165fd921c1a3cd49749e4af6588ab645342c5de9500bf753e'),
  synth_valid_wallet_call_is_the_bare_selector: indirectNow('0x935873569c9c16b1c4f3b6e8d8a69a60f35034c77a2cf5c1722b5db86454270d'),
  adv_conf_wallet_call_data_three_bytes: indirectNow('0x2116c8fb4d1ce9d2fbcec55912daedf84ed1f0aa4963493286f030042ca906c0'),
  adv_conf_wallet_fast_confirmer_slot_unproven: indirectNow('0x5df460c5b7e0980fe14237fa7ef2db6ab8891b1a544e8a7e75c72084a08ef2b6'),
};

export const SUPERSEDED_IN_SET2: Readonly<Record<string, string>> = {
  synth_valid_wallet_route_callee_code_is_not_examined: indirectNow('0xcb39a45c923e7e861451bc504ebe190d1dd7d9002c487ef9a564b714b7611729'),
};

/** The set-1 case -> the set-3 case that carries the same world again WITH a wallet proof (Go TestEverySupersededCaseIsCarriedAgainWithAWalletProof). */
export const CARRIED_AGAIN_IN_SET3: Readonly<Record<string, string>> = {
  synth_valid_wallet_execute_transaction: 'synth_valid_wallet_execute_transaction_proven',
  synth_valid_wallet_execute_transactions: 'synth_valid_wallet_execute_transactions_proven',
  synth_valid_wallet_execute_transaction_with_gas_refunder: 'synth_valid_wallet_execute_transaction_with_gas_refunder_proven',
  synth_valid_wallet_execute_transactions_with_gas_refunder: 'synth_valid_wallet_execute_transactions_with_gas_refunder_proven',
  synth_valid_wallet_call_is_the_bare_selector: 'synth_valid_wallet_call_is_the_bare_selector_proven',
  adv_conf_wallet_call_targets_other_contract: 'adv_wallet_no_confirm_call_other_target_proven',
  adv_conf_wallet_call_other_selector: 'adv_wallet_no_confirm_call_other_selector_proven',
  adv_conf_wallet_fast_call: 'adv_wallet_fast_call_proven',
  adv_conf_wallet_force_call: 'adv_wallet_force_call_proven',
  adv_conf_wallet_fast_confirmer_nonzero: 'adv_wallet_fast_confirmer_set_proven',
  adv_conf_wallet_call_data_three_bytes: 'adv_wallet_call_data_three_bytes_proven',
  adv_conf_wallet_fast_confirmer_slot_unproven: 'adv_wallet_fast_confirmer_slot_proof_missing_proven',
};

/** What a verdict literal says it is: the code and its reason, path or route (Go outcomeKind). */
export function outcomeKind(expect: string): string {
  const o = JSON.parse(expect) as { code: string; fields: Record<string, string> };
  for (const k of ['reason', 'path', 'confirmation_route', 'which']) {
    const v = o.fields[k];
    if (v !== undefined) return `${o.code}/${k}=${v}`;
  }
  return o.code;
}

/** The expected verdict of a vector as this port judges it: its recorded literal, or the superseded one for the set-1/set-2 worlds. */
export function expectedOf(s: SetInfo, v: Vector): string {
  if (s === FINAL1 && v.name in SUPERSEDED_IN_SET1) return SUPERSEDED_IN_SET1[v.name]!;
  if (s === FINAL2 && v.name in SUPERSEDED_IN_SET2) return SUPERSEDED_IN_SET2[v.name]!;
  return v.expect;
}
