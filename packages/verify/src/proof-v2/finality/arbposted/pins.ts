/**
 * The arb_sepolia pieces of finality-pins.json this kind reads (V2_SPEC_S7 section 4.2; the twin of pkg/finality/arbposted/pins.go).
 * The framework keeps the section raw (Pins.sections); it is decoded here exactly as Go decodes it: json.Decoder with
 * DisallowUnknownFields into the struct (an unknown key anywhere in the struct or its layout is pin_mismatch{section}; keys match
 * case-insensitively once exact equality fails; null is a no-op; a wrongly typed value is an error). Keys the sibling kind
 * arb-sepolia/finalized/v1 adds (confirm_path, proxy_slots, and the layout keys config_slot_offset, fast_confirmer_shift_bits,
 * fast_confirmer_slot, status_shift_bits) are declared and ignored, so the embedded pins load for this kind too.
 */
import { JsonError } from '../../../s3/gojson.js';
import { foldEqual } from '../../../s3/fold.js';
import { JObj, decodeVal, type FieldDef, type GoVal, type JVal, type Sch, type StructDef } from '../../../s3/jsonx.js';
import { kzgSetupPin, sepoliaPins, type Pins } from '../pins.js';
import { Code, newState } from '../state.js';
import { ChainArbitrumSepolia, ChainSepolia } from '../table.js';
import { pinMismatch } from './states.js';

/** The names this kind judges under. */
export const KIND_NAME = 'arb-sepolia/l1_posted/v1';
export const CHAIN = ChainArbitrumSepolia;

/**
 * The SHA-256 of the trusted-setup file the TypeScript KZG backend loads (baseposted/kzg-trusted-setup.json, the Ethereum ceremony
 * output at consensus-specs v1.7.0-beta.4); equal to the Go constant arbposted.UsedKZGSetupSHA256. The pinned value must equal it, else
 * pin_mismatch{field:"kzg_setup_sha256"}.
 */
export const USED_KZG_SETUP_SHA256 = 'f8e44a31ebf0a6d0734dcb301b0716e2c77f3ae18ed0cab0870fbcc2ca55616f';

/** Pin field names used in pin_mismatch / finality_pin_unknown. */
export const PIN_SECTION = 'arb_sepolia';
export const PIN_KZG = 'kzg_setup_sha256';
/** The logic_pins role of the Bridge implementation. */
export const BRIDGE_IMPL_ROLE = 'bridge_impl';
/** The layout name this kind reads. */
export const LAYOUT_NAME = 'nitro-contracts-v3.1.0';

export interface ArbLayout {
  assertionsSlot: bigint;
  accArraySlot: bigint;
  delayedAccArraySlot: bigint;
}

export interface ArbPins {
  chainId: bigint;
  parentChainId: bigint;
  boldGenesisL2Block: bigint;
  /** 20 bytes */
  bridge: Uint8Array;
  layout: ArbLayout;
  /** 0x-prefixed lower-case code hash -> role */
  logicPins: Map<string, string>;
  maxBlobs: number;
  maxSegments: number;
  maxUncompressedBatch: number;
}

const f = (name: string, json: string, sch: Sch): FieldDef => ({ name, json, sch });

const layoutDef: StructDef = [
  f('Name', 'name', 'string'),
  f('AssertionsSlot', 'assertions_slot', 'u64'),
  f('AccArraySlot', 'acc_array_slot', 'u64'),
  f('DelayedAccArraySlot', 'delayed_acc_array_slot', 'u64'),
  f('ConfigSlotOffset', 'config_slot_offset', 'u64'),
  f('FastConfirmerShiftBits', 'fast_confirmer_shift_bits', 'u64'),
  f('FastConfirmerSlot', 'fast_confirmer_slot', 'u64'),
  f('StatusShiftBits', 'status_shift_bits', 'u64'),
];

const arbDef: StructDef = [
  f('BoldGenesisAssertion', 'bold_genesis_assertion', 'string'),
  f('BoldGenesisL2Block', 'bold_genesis_l2_block', 'u64'),
  f('Bridge', 'bridge', 'string'),
  f('ChainID', 'chain_id', 'u64'),
  f('Layout', 'layout', { struct: layoutDef }),
  f('LogicPins', 'logic_pins', { map: 'string' }),
  f('MaxBlobs', 'max_blobs', 'i64'),
  f('MaxHeaderChain', 'max_header_chain', 'i64'),
  f('MaxSegments', 'max_segments', 'i64'),
  f('MaxUncompressedBatch', 'max_uncompressed_batch', 'i64'),
  f('ParentChainID', 'parent_chain_id', 'u64'),
  f('Rollup', 'rollup', 'string'),
  f('ConfirmPath', 'confirm_path', 'raw'),
  f('ProxySlots', 'proxy_slots', 'raw'),
];

/**
 * DisallowUnknownFields: throws JsonError at the first object key that names no field of its struct (exact match first, then the
 * case-insensitive fold encoding/json uses), descending into struct-typed fields; raw, map and scalar fields are not descended into.
 */
function refuseUnknown(v: JVal, def: StructDef): void {
  if (!(v instanceof JObj)) return;
  for (const [k, val] of v.pairs) {
    const fd = def.find((x) => x.json === k) ?? def.find((x) => foldEqual(x.json, k));
    if (fd === undefined) throw new JsonError(`json: unknown field ${JSON.stringify(k)}`);
    const s = fd.sch;
    if (typeof s === 'object' && 'struct' in s) refuseUnknown(val, s.struct);
  }
}

/** hexAddr: 0x + 40 hex digits (either case). */
function hexAddr(s: string): Uint8Array | undefined {
  if (!s.startsWith('0x') || s.length !== 42) return undefined;
  const h = s.slice(2);
  if (!/^[0-9a-fA-F]{40}$/.test(h)) return undefined;
  return Uint8Array.from(h.match(/../g)!, (x) => parseInt(x, 16));
}

const clampInt = (v: bigint): number => (v > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(v));

/**
 * Reads the arb_sepolia section. An absent section is finality_pin_unknown; a section that does not decode or whose values are outside
 * their domain is pin_mismatch{field}.
 */
export function loadArbPins(p: Pins | null | undefined): ArbPins {
  if (p === null || p === undefined) throw newState(Code.PinUnknown, { chain: CHAIN, kind: PIN_SECTION });
  const raw = p.sections.get(PIN_SECTION);
  if (raw === undefined) throw newState(Code.PinUnknown, { chain: CHAIN, kind: PIN_SECTION });
  let a: { [k: string]: GoVal };
  try {
    refuseUnknown(raw, arbDef);
    a = decodeVal({ struct: arbDef }, raw, PIN_SECTION) as { [k: string]: GoVal };
  } catch (e) {
    if (e instanceof JsonError) throw pinMismatch('section');
    throw e;
  }
  const big = (k: string): bigint => a[k] as bigint;
  if (big('ChainID') !== CHAIN) throw pinMismatch('chain_id');
  if (big('ParentChainID') !== ChainSepolia) throw pinMismatch('parent_chain_id');
  const bridge = hexAddr(a.Bridge as string);
  if (bridge === undefined) throw pinMismatch('bridge');
  const lay = a.Layout as { [k: string]: GoVal };
  if (lay.Name !== LAYOUT_NAME) throw pinMismatch('layout');
  if (big('MaxBlobs') <= 0n) throw pinMismatch('max_blobs');
  if (big('MaxSegments') <= 0n) throw pinMismatch('max_segments');
  if (big('MaxUncompressedBatch') <= 0n) throw pinMismatch('max_uncompressed_batch');
  const logic = new Map<string, string>();
  const lp = a.LogicPins;
  if (lp instanceof Map) for (const [k, v] of lp) logic.set(k, v as string);
  return {
    chainId: big('ChainID'),
    parentChainId: big('ParentChainID'),
    boldGenesisL2Block: big('BoldGenesisL2Block'),
    bridge,
    layout: {
      assertionsSlot: lay.AssertionsSlot as bigint,
      accArraySlot: lay.AccArraySlot as bigint,
      delayedAccArraySlot: lay.DelayedAccArraySlot as bigint,
    },
    logicPins: logic,
    maxBlobs: clampInt(big('MaxBlobs')),
    maxSegments: clampInt(big('MaxSegments')),
    maxUncompressedBatch: clampInt(big('MaxUncompressedBatch')),
  };
}

/** Whether codeHash is pinned with the bridge_impl role. */
export function pinnedBridgeImpl(a: ArbPins, codeHash: Uint8Array): boolean {
  let h = '0x';
  for (const x of codeHash) h += x.toString(16).padStart(2, '0');
  return a.logicPins.get(h) === BRIDGE_IMPL_ROLE;
}

/**
 * The KZG setup pin the blob kinds share (Pins.KZGSetupPin over the eth_sepolia legacy copy): `shared` first, the legacy copy only when
 * the file has no `shared` section, both present and different is finality_pins_corrupt. A file without the eth_sepolia section is
 * finality_pin_unknown (from sepoliaPins), judged before the KZG pin.
 */
export function kzgPinOf(p: Pins | null | undefined): string {
  const e = sepoliaPins(p);
  return kzgSetupPin(p, `eth_sepolia.${PIN_KZG}`, e.kzgSetupSha256).value;
}
