/**
 * The base_sepolia pieces of finality-pins.json this kind reads (V2_SPEC_S7 section 4.2; the twin of pkg/finality/basefinal/pins.go). The
 * framework keeps the section raw (Pins.sections); it is parsed here with Go's json.Unmarshal rules (case-insensitive keys, unknown keys
 * ignored, null a no-op, a wrongly typed value an error). Keys other kinds add (batch inbox, channel and KZG values) are ignored here.
 *
 * Every 64-bit quantity is a bigint: Go's `int` and `uint64` row values are compared and summed with their wrap semantics in verify.ts.
 */
import { JsonError } from '../../../s3/gojson.js';
import { JNum, JObj, Raw, decodeVal, type FieldDef, type GoVal, type JVal, type Sch } from '../../../s3/jsonx.js';
import type { Pins } from '../pins.js';
import { Code, PinsReason, newState, pinsCorrupt, type FinalityStateError } from '../state.js';
import { ChainBaseSepolia } from '../table.js';
import { SepoliaChainID } from '../ethl1/index.js';
import { LayoutAggregateV1, RoleGameImpl } from './states.js';

/** The names this kind judges under. */
export const KIND_NAME = 'base-sepolia/finalized/v1';
export const CHAIN = ChainBaseSepolia;

/** One impl_pins row (append-only: codeHash -> role and the decoded immutables the predicates need). */
export interface ImplRow {
  role: string;
  /** game_impl */
  gameType: number;
  version: string;
  /** 20 bytes, all zero when the row's impl is not a 20-byte lower-case 0x hex */
  impl: Uint8Array;
  cwia: string;
  nIntermediate: bigint;
  argsLen: bigint;
  /** {total blocks of the game, intermediate interval} */
  intervalPairs: [bigint, bigint][];
  slowDelay: bigint;
  fastDelay: bigint;
  /** asr_impl: null when the row has none */
  finalityDelaySeconds: bigint | null;
}

/** The game_layout row: the clone template (V2_SPEC_S7 5.5 O3, B30 Q2) and the game slots. */
export interface GameLayout {
  /** 54 bytes */
  cloneHead: Uint8Array;
  /** 9 bytes */
  cloneMid: Uint8Array;
  /** 13 bytes */
  cloneTail: Uint8Array;
  /** 0x88 */
  argsBaseLen: bigint;
  /** 0x20 */
  argsPerRoot: bigint;
}

export interface BaseFinalPins {
  chainId: bigint;
  l1ChainId: bigint;
  /** 20 bytes */
  portal: Uint8Array;
  /** 20 bytes */
  systemConfig: Uint8Array;
  maxL2Headers: bigint;
  /** keyed by the row's own lower-case 0x hex of the 32-byte code hash */
  impl: Map<string, ImplRow>;
  proxy: Map<string, string>;
  layouts: Map<string, GameLayout>;
}

/** The game args the judge indexes: the fixed part up to the parent address at [116,136), and one 32-byte root per intermediate root. */
export const MIN_ARGS_BASE_LEN = 136n;
export const MIN_ARGS_PER_ROOT = 32n;

const f = (name: string, json: string, sch: Sch): FieldDef => ({ name, json, sch });

const layoutSch: Sch = {
  struct: [
    f('CloneHead', 'clone_head', 'string'),
    f('CloneMid', 'clone_mid', 'string'),
    f('CloneTail', 'clone_tail', 'string'),
    f('ArgsBaseLen', 'args_base_len', 'i64'),
    f('ArgsPerRoot', 'args_per_root', 'i64'),
  ],
};

const baseSch: Sch = {
  struct: [
    f('ChainID', 'chain_id', 'u64'),
    f('L1ChainID', 'l1_chain_id', 'u64'),
    f('Portal', 'portal', 'string'),
    f('SystemConfig', 'system_config', 'string'),
    f('MaxL2Headers', 'max_l2_headers', 'i64'),
    f('ImplPins', 'impl_pins', { map: 'raw' }),
    f('ProxyPins', 'proxy_pins', { map: 'raw' }),
    f('GameLayout', 'game_layout', { map: layoutSch }),
  ],
};

const rowSch: Sch = {
  struct: [
    f('Role', 'role', 'string'),
    f('GameType', 'game_type', 'raw'),
    f('Version', 'version', 'string'),
    f('ImplAddr', 'impl', 'string'),
    f('CWIA', 'cwia', 'string'),
    f('NIntermediate', 'n_intermediate', 'i64'),
    f('ArgsLen', 'args_len', 'i64'),
    f('IntervalPairs', 'interval_pairs', 'raw'),
    f('SlowDelay', 'slow_finalization_delay', 'u64'),
    f('FastDelay', 'fast_finalization_delay', 'u64'),
    f('FinalityDelay', 'finality_delay_seconds', 'raw'),
  ],
};

/** Lower-case 0x hex of exactly n bytes (pins.go unhex). */
export function unhex(s: string, n: number): Uint8Array | undefined {
  if (!s.startsWith('0x') || s !== s.toLowerCase()) return undefined;
  const h = s.slice(2);
  if (h.length !== 2 * n || !/^[0-9a-f]*$/.test(h)) return undefined;
  return Uint8Array.from(h.match(/../g) ?? [], (x) => parseInt(x, 16));
}

/** Lower-case 0x hex of any even length (pins.go hexBytes). */
export function hexBytes(s: string): Uint8Array | undefined {
  if (!s.startsWith('0x') || s !== s.toLowerCase()) return undefined;
  const h = s.slice(2);
  if (h.length % 2 !== 0 || !/^[0-9a-f]*$/.test(h)) return undefined;
  return Uint8Array.from(h.match(/../g) ?? [], (x) => parseInt(x, 16));
}

/** A json number literal into a Go uint of `bits` bits (the literal must be integer syntax and fit); anything else is a JsonError. */
function uintFrom(v: JVal, bits: number, label: string): bigint {
  const n = decodeVal('u64', v, label) as bigint;
  if (bits < 64 && n >= 1n << BigInt(bits)) throw new JsonError(`json: cannot unmarshal number ${n} into Go struct field ${label} of type uint${bits}`);
  return n;
}

/** A *uint32 / *uint64 field kept raw: absent or null is nil. */
function ptrUint(r: GoVal, bits: number, label: string): bigint | null {
  const v = (r as Raw).v;
  if (v === undefined || v === null) return null;
  return uintFrom(v, bits, label);
}

/** [][2]uint64: a Go array takes its first two elements (a missing one is 0, an extra one is skipped), null is a no-op. */
function intervalPairs(r: GoVal, label: string): [bigint, bigint][] {
  const v = (r as Raw).v;
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw new JsonError(`json: cannot unmarshal ${v instanceof JObj ? 'object' : typeof v === 'string' ? 'string' : v instanceof JNum ? 'number' : 'bool'} into Go struct field ${label} of type [][2]uint64`);
  return v.map((pair, i): [bigint, bigint] => {
    if (pair === null) return [0n, 0n];
    if (!Array.isArray(pair)) throw new JsonError(`json: cannot unmarshal into Go struct field ${label}[${i}] of type [2]uint64`);
    const a = pair[0] === undefined || pair[0] === null ? 0n : uintFrom(pair[0], 64, `${label}[${i}][0]`);
    const b = pair[1] === undefined || pair[1] === null ? 0n : uintFrom(pair[1], 64, `${label}[${i}][1]`);
    return [a, b];
  });
}

function decodeRow(v: JVal | undefined, label: string): { [k: string]: GoVal } {
  return decodeVal(rowSch, v === undefined ? null : v, label) as { [k: string]: GoVal };
}

/**
 * Reads the base_sepolia section of the framework pins. An absent section is finality_pin_unknown; a malformed one is
 * finality_pins_corrupt{bad_value, key}. A game_impl row that does not carry everything the predicates of 5.5 need is treated as ABSENT
 * (V2_SPEC_S7 4.2): it is not an error of the file, the implementation then stays contract_identity_unproven.
 */
export function parseBasePins(p: Pins | null | undefined): BaseFinalPins {
  const raw = p?.sections.get('base_sepolia');
  if (raw === undefined || raw === null) throw newState(Code.PinUnknown, { chain: CHAIN, kind: 'base_sepolia' });
  const bad = (key: string): FinalityStateError => pinsCorrupt(PinsReason.BadValue, { key: `base_sepolia.${key}` });
  let r: { [k: string]: GoVal };
  try {
    r = decodeVal(baseSch, raw, 'base_sepolia') as { [k: string]: GoVal };
  } catch (e) {
    if (e instanceof JsonError) throw pinsCorrupt(PinsReason.BadValue, { key: 'base_sepolia' });
    throw e;
  }
  const big = (k: string): bigint => r[k] as bigint;
  if (big('ChainID') !== CHAIN) throw bad('chain_id');
  if (big('L1ChainID') !== SepoliaChainID) throw bad('l1_chain_id');
  const portal = unhex(r.Portal as string, 20);
  if (portal === undefined) throw bad('portal');
  const systemConfig = unhex(r.SystemConfig as string, 20);
  if (systemConfig === undefined) throw bad('system_config');
  if (big('MaxL2Headers') <= 0n) throw bad('max_l2_headers');
  const out: BaseFinalPins = {
    chainId: big('ChainID'),
    l1ChainId: big('L1ChainID'),
    portal,
    systemConfig,
    maxL2Headers: big('MaxL2Headers'),
    impl: new Map(),
    proxy: new Map(),
    layouts: new Map(),
  };
  const implPins = r.ImplPins;
  if (implPins instanceof Map) {
    for (const [k, row] of implPins) {
      if (unhex(k, 32) === undefined) throw bad('impl_pins');
      let rr: { [k: string]: GoVal };
      let gameType: bigint | null;
      let finalityDelay: bigint | null;
      let pairs: [bigint, bigint][];
      try {
        rr = decodeRow((row as Raw).v, 'row');
        gameType = ptrUint(rr.GameType!, 32, 'game_type');
        pairs = intervalPairs(rr.IntervalPairs!, 'interval_pairs');
        finalityDelay = ptrUint(rr.FinalityDelay!, 64, 'finality_delay_seconds');
      } catch (e) {
        if (e instanceof JsonError) throw bad('impl_pins');
        throw e;
      }
      if (rr.Role === '') throw bad('impl_pins');
      const impl = unhex(rr.ImplAddr as string, 20);
      out.impl.set(k, {
        role: rr.Role as string,
        gameType: gameType === null ? 0 : Number(gameType),
        version: rr.Version as string,
        impl: impl === undefined ? new Uint8Array(20) : impl,
        cwia: rr.CWIA as string,
        nIntermediate: rr.NIntermediate as bigint,
        argsLen: rr.ArgsLen as bigint,
        intervalPairs: pairs,
        slowDelay: rr.SlowDelay as bigint,
        fastDelay: rr.FastDelay as bigint,
        finalityDelaySeconds: finalityDelay,
      });
    }
  }
  const proxyPins = r.ProxyPins;
  if (proxyPins instanceof Map) {
    for (const [k, row] of proxyPins) {
      if (unhex(k, 32) === undefined) throw bad('proxy_pins');
      let rr: { [k: string]: GoVal };
      try {
        rr = decodeRow((row as Raw).v, 'row');
        ptrUint(rr.GameType!, 32, 'game_type');
        intervalPairs(rr.IntervalPairs!, 'interval_pairs');
        ptrUint(rr.FinalityDelay!, 64, 'finality_delay_seconds');
      } catch (e) {
        if (e instanceof JsonError) throw bad('proxy_pins');
        throw e;
      }
      if (rr.Role === '') throw bad('proxy_pins');
      out.proxy.set(k, rr.Role as string);
    }
  }
  const layouts = r.GameLayout;
  if (layouts instanceof Map) {
    for (const [name, lv] of layouts) {
      const l = lv as { [k: string]: GoVal };
      const head = hexBytes(l.CloneHead as string);
      const mid = hexBytes(l.CloneMid as string);
      const tail = hexBytes(l.CloneTail as string);
      const abl = l.ArgsBaseLen as bigint;
      const apr = l.ArgsPerRoot as bigint;
      if (head === undefined || mid === undefined || tail === undefined || abl < MIN_ARGS_BASE_LEN || apr < MIN_ARGS_PER_ROOT) throw bad('game_layout');
      out.layouts.set(name, { cloneHead: head, cloneMid: mid, cloneTail: tail, argsBaseLen: abl, argsPerRoot: apr });
    }
  }
  return out;
}

const I64 = (v: bigint): bigint => BigInt.asIntN(64, v);

/**
 * Whether a game_impl row carries every decoded immutable, the CWIA layout and the interval semantics the predicates of 5.5 need
 * (V2_SPEC_S7 4.2: an incomplete row is treated as absent). The args-length identity is Go int64 arithmetic.
 */
export function rowComplete(r: ImplRow, layouts: Map<string, GameLayout>): boolean {
  if (
    r.role !== RoleGameImpl ||
    r.gameType === 0 ||
    r.version === '' ||
    r.impl.every((b) => b === 0) ||
    r.nIntermediate <= 0n ||
    r.intervalPairs.length === 0 ||
    r.slowDelay === 0n ||
    r.fastDelay === 0n
  ) {
    return false;
  }
  const l = layouts.get(r.cwia);
  if (l === undefined || r.argsLen !== I64(l.argsBaseLen + I64(l.argsPerRoot * r.nIntermediate))) return false;
  for (const [total, interval] of r.intervalPairs) if (total === 0n || interval === 0n || total % interval !== 0n) return false;
  return true;
}

export { LayoutAggregateV1 };
