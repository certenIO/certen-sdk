/**
 * The arb_sepolia pieces of finality-pins.json this kind reads (V2_SPEC_S7 section 4.2; the twin of pkg/finality/arbfinal/pins.go). The
 * framework keeps the section raw (Pins.sections); it is decoded here exactly as Go decodes it: json.Decoder with DisallowUnknownFields
 * into the struct (an unknown key anywhere in the struct, its layout, its confirm_path or its proxy_slots is pin_mismatch{section}; keys
 * match case-insensitively once exact equality fails; null is a no-op; a wrongly typed value is an error), then the checks of loadArbFinalPins
 * in Go's order. Nothing is defaulted: a pin the file does not carry is a named pin_mismatch{field}.
 *
 * The order in which several defects are judged is a function of the file, in Go since RB12-OPS-A1 (pkg/finality at 4c6b8d26) and here:
 *  - a pins FILE with two keys of one non-struct object that differ only in letter case (two spellings of one logic_pins hash, whatever roles
 *    they carry) is refused by the framework walk as finality_pins_corrupt{duplicate_key} before this loader sees it (pins.ts walkKeys);
 *  - this loader judges a Pins that did not come through the walk (one built in memory), and for it two spellings of one hash that name
 *    different roles are pin_mismatch{logic_pins} and the same role under both is one entry (Go LoadPins: the keys are read in sorted order);
 *  - the confirm_path selectors and topics are checked in sorted-name order, the first bad one by name is the one named.
 * The two guards overlap on purpose: the second is unreachable from a file and is tested as such (units_pins_opssync_rb12.test.ts).
 */
import { JsonError } from '../../../s3/gojson.js';
import { foldEqual } from '../../../s3/fold.js';
import { JObj, decodeVal, type FieldDef, type GoVal, type JVal, type Sch, type StructDef } from '../../../s3/jsonx.js';
import { EMPTY_CODE_HASH } from '../../../s6/mpt.js';
import { Code, hexLower, newState } from '../state.js';
import type { Pins } from '../pins.js';
import { ChainArbitrumSepolia, ChainSepolia } from '../table.js';
import { RoleWalletLogic, RoleWalletProxy, pinMismatch } from './states.js';

/** The kind name and the chain it judges (the V2_SPEC_S7 section 1 table row). */
export const KIND_NAME = 'arb-sepolia/finalized/v1';
export const CHAIN = ChainArbitrumSepolia;

/** The pins file section of this kind (V2_SPEC_S7 4.2). */
export const PIN_SECTION = 'arb_sepolia';
/** The layout name this kind reads. */
export const LAYOUT_NAME = 'nitro-contracts-v3.1.0';

/** The storage layout of nitro-contracts v3.1.0 (annex A4). The acc/delayed array slots belong to the l1_posted kind; they are accepted so the one shared section parses for both. */
export interface ArbFinalLayout {
  name: string;
  assertionsSlot: bigint;
  statusShiftBits: bigint;
  configSlotOffset: bigint;
  fastConfirmerSlot: bigint;
  fastConfirmerShiftBits: bigint;
  accArraySlot: bigint;
  delayedAccArraySlot: bigint;
}

/** The pinned 4-byte selectors (Go selectors). */
export interface Selectors {
  confirm: Uint8Array;
  force: Uint8Array;
  fast: Uint8Array;
  fastNew: Uint8Array;
  walletTx: Uint8Array;
  walletTxs: Uint8Array;
  walletTxRefund: Uint8Array;
  walletTxsRef: Uint8Array;
}

/** The pinned event topics (Go topics). */
export interface Topics {
  confirmed: Uint8Array;
  forceConfirmed: Uint8Array;
}

/** The parsed arb_sepolia pins this kind reads (Go Pins). */
export interface ArbFinalPins {
  /** 20 bytes */
  rollup: Uint8Array;
  boldGenesisL2Block: bigint;
  /** Go int: 1 .. 2^63-1 */
  maxHeaderChain: bigint;
  layout: ArbFinalLayout;
  /** 32 bytes: the Rollup proxy's admin-logic slot */
  adminSlot: Uint8Array;
  /** 32 bytes: the Rollup proxy's secondary user-logic slot */
  userSlot: Uint8Array;
  /** 0x-prefixed lower-case code hash -> role */
  logicPins: Map<string, string>;
  sel: Selectors;
  topic: Topics;
  /** 20 bytes: the pinned ValidatorWallet implementation (the creator's template) */
  walletImpl: Uint8Array;
  /** 32 bytes: the EIP-1967 implementation slot of a wallet proxy, which must hold walletImpl */
  walletImplSlot: Uint8Array;
}

const f = (name: string, json: string, sch: Sch): FieldDef => ({ name, json, sch });

const layoutDef: StructDef = [
  f('Name', 'name', 'string'),
  f('AssertionsSlot', 'assertions_slot', 'u64'),
  f('StatusShiftBits', 'status_shift_bits', 'u64'),
  f('ConfigSlotOffset', 'config_slot_offset', 'u64'),
  f('FastConfirmerSlot', 'fast_confirmer_slot', 'u64'),
  f('FastConfirmerShiftBits', 'fast_confirmer_shift_bits', 'u64'),
  f('AccArraySlot', 'acc_array_slot', 'u64'),
  f('DelayedAccArraySlot', 'delayed_acc_array_slot', 'u64'),
];

const proxySlotsDef: StructDef = [
  f('AdminLogic', 'admin_logic', 'string'),
  f('UserLogic', 'user_logic', 'string'),
  f('WalletImpl', 'wallet_impl', 'string'),
];

const confirmPathDef: StructDef = [
  f('Selectors', 'selectors', { map: 'string' }),
  f('Topics', 'topics', { map: 'string' }),
  f('ValidatorWalletImpl', 'validator_wallet_impl', 'string'),
];

const arbDef: StructDef = [
  f('BoldGenesisAssertion', 'bold_genesis_assertion', 'string'),
  f('BoldGenesisL2Block', 'bold_genesis_l2_block', 'u64'),
  f('Bridge', 'bridge', 'string'),
  f('ChainID', 'chain_id', 'u64'),
  f('ConfirmPath', 'confirm_path', { struct: confirmPathDef }),
  f('Layout', 'layout', { struct: layoutDef }),
  f('LogicPins', 'logic_pins', { map: 'string' }),
  f('MaxBlobs', 'max_blobs', 'i64'),
  f('MaxHeaderChain', 'max_header_chain', 'i64'),
  f('MaxSegments', 'max_segments', 'i64'),
  f('MaxUncompressedBatch', 'max_uncompressed_batch', 'i64'),
  f('ParentChainID', 'parent_chain_id', 'u64'),
  f('ProxySlots', 'proxy_slots', { struct: proxySlotsDef }),
  f('Rollup', 'rollup', 'string'),
];

/**
 * DisallowUnknownFields: throws JsonError at the first object key that names no field of its struct (exact match first, then the
 * case-insensitive fold encoding/json uses), descending into struct-typed fields; map and scalar fields are not descended into.
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

/** hexN: "0x" and exactly n bytes of hex digits (either case), as the Go helper; the decoded bytes, or undefined. */
function hexN(s: string, n: number): Uint8Array | undefined {
  if (!s.startsWith('0x') || s.length !== 2 + 2 * n) return undefined;
  const h = s.slice(2);
  if (!/^[0-9a-fA-F]*$/.test(h)) return undefined;
  return Uint8Array.from(h.match(/../g) ?? [], (x) => parseInt(x, 16));
}

const isZero = (b: Uint8Array): boolean => b.every((x) => x === 0);

/** The confirm_path selector names in the order this port checks them (sorted; Go's order is random). */
export const SELECTOR_NAMES = [
  'confirm_assertion',
  'fast_confirm_assertion',
  'fast_confirm_new_assertion',
  'force_confirm_assertion',
  'wallet_execute_transaction',
  'wallet_execute_transaction_with_gas_refunder',
  'wallet_execute_transactions',
  'wallet_execute_transactions_with_gas_refunder',
] as const;
/** The confirm_path topic names in the order this port checks them (sorted; Go's order is random). */
export const TOPIC_NAMES = ['assertion_confirmed', 'assertion_force_confirmed'] as const;

const E_EMPTY_CODE_HASH = `0x${hexLower(EMPTY_CODE_HASH)}`;
const ZERO_HASH_KEY = `0x${'00'.repeat(32)}`;

/**
 * Reads the arb_sepolia section. An absent section is finality_pin_unknown; a section that does not decode or whose values are outside
 * their domain is pin_mismatch{field}. The checks run in the order of Go's LoadPins (pins.go:105-203).
 */
export function loadArbFinalPins(p: Pins | null | undefined): ArbFinalPins {
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
  const rollup = hexN(a.Rollup as string, 20);
  if (rollup === undefined) throw pinMismatch('rollup');
  const lay = a.Layout as { [k: string]: GoVal };
  const L = (k: string): bigint => lay[k] as bigint;
  if (lay.Name !== LAYOUT_NAME) throw pinMismatch('layout');
  if (L('AssertionsSlot') === 0n || L('StatusShiftBits') === 0n || L('StatusShiftBits') > 248n || L('ConfigSlotOffset') === 0n) throw pinMismatch('layout');
  if (L('FastConfirmerSlot') === 0n || L('FastConfirmerShiftBits') > 96n) throw pinMismatch('layout');
  const maxHeaderChain = big('MaxHeaderChain');
  if (maxHeaderChain <= 0n) throw pinMismatch('max_header_chain');
  if (big('BoldGenesisL2Block') === 0n) throw pinMismatch('bold_genesis_l2_block');
  const ps = a.ProxySlots as { [k: string]: GoVal };
  const adminSlot = hexN(ps.AdminLogic as string, 32);
  if (adminSlot === undefined) throw pinMismatch('proxy_slots.admin_logic');
  const userSlot = hexN(ps.UserLogic as string, 32);
  if (userSlot === undefined) throw pinMismatch('proxy_slots.user_logic');
  const walletImplSlot = hexN(ps.WalletImpl as string, 32);
  if (walletImplSlot === undefined) throw pinMismatch('proxy_slots.wallet_impl');
  const cp = a.ConfirmPath as { [k: string]: GoVal };
  const walletImpl = hexN(cp.ValidatorWalletImpl as string, 20);
  if (walletImpl === undefined || isZero(walletImpl)) throw pinMismatch('confirm_path.validator_wallet_impl');
  const logicPins = new Map<string, string>();
  const lp = a.LogicPins;
  if (lp instanceof Map) {
    for (const [k, v] of lp) {
      const kb = hexN(k, 32);
      if (kb === undefined) throw pinMismatch('logic_pins');
      const key = `0x${hexLower(kb)}`;
      const prev = logicPins.get(key);
      // Go keeps whichever of two case-variant keys the map visits last: conflicting roles cannot be answered the way a lucky Go run does
      if (prev !== undefined && prev !== (v as string)) throw pinMismatch('logic_pins');
      logicPins.set(key, v as string);
    }
  }
  // The wallet route needs both identities pinned: a pins file without either could never prove a wallet, and a role pinned on a code hash
  // that an account without code, or an absent account, also has would prove one. Absent or unusable is pin_mismatch.
  for (const role of [RoleWalletProxy, RoleWalletLogic]) {
    let found = false;
    for (const [h, r] of logicPins) {
      if (r !== role) continue;
      if (h === ZERO_HASH_KEY || h === E_EMPTY_CODE_HASH) throw pinMismatch(`logic_pins.${role}`);
      found = true;
    }
    if (!found) throw pinMismatch(`logic_pins.${role}`);
  }
  const selectors = cp.Selectors instanceof Map ? cp.Selectors : new Map<string, GoVal>();
  const sel = new Map<string, Uint8Array>();
  for (const name of SELECTOR_NAMES) {
    const sb = hexN((selectors.get(name) as string | undefined) ?? '', 4);
    // a zero selector is also refused: it is what a call without a selector reads as
    if (sb === undefined || isZero(sb)) throw pinMismatch(`confirm_path.selectors.${name}`);
    sel.set(name, sb);
  }
  const topics = cp.Topics instanceof Map ? cp.Topics : new Map<string, GoVal>();
  const top = new Map<string, Uint8Array>();
  for (const name of TOPIC_NAMES) {
    const tb = hexN((topics.get(name) as string | undefined) ?? '', 32);
    if (tb === undefined) throw pinMismatch(`confirm_path.topics.${name}`);
    top.set(name, tb);
  }
  return {
    rollup,
    boldGenesisL2Block: big('BoldGenesisL2Block'),
    maxHeaderChain,
    layout: {
      name: lay.Name as string,
      assertionsSlot: L('AssertionsSlot'),
      statusShiftBits: L('StatusShiftBits'),
      configSlotOffset: L('ConfigSlotOffset'),
      fastConfirmerSlot: L('FastConfirmerSlot'),
      fastConfirmerShiftBits: L('FastConfirmerShiftBits'),
      accArraySlot: L('AccArraySlot'),
      delayedAccArraySlot: L('DelayedAccArraySlot'),
    },
    adminSlot,
    userSlot,
    logicPins,
    sel: {
      confirm: sel.get('confirm_assertion')!,
      force: sel.get('force_confirm_assertion')!,
      fast: sel.get('fast_confirm_assertion')!,
      fastNew: sel.get('fast_confirm_new_assertion')!,
      walletTx: sel.get('wallet_execute_transaction')!,
      walletTxs: sel.get('wallet_execute_transactions')!,
      walletTxRefund: sel.get('wallet_execute_transaction_with_gas_refunder')!,
      walletTxsRef: sel.get('wallet_execute_transactions_with_gas_refunder')!,
    },
    topic: { confirmed: top.get('assertion_confirmed')!, forceConfirmed: top.get('assertion_force_confirmed')! },
    walletImpl,
    walletImplSlot,
  };
}

/** The logic_pins role of a 32-byte code hash ("" when not pinned) (Go Pins.roleOf). */
export function roleOf(a: ArbFinalPins, codeHash: Uint8Array): string {
  return a.logicPins.get(`0x${hexLower(codeHash)}`) ?? '';
}
