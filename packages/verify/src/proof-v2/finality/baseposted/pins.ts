/**
 * The base_sepolia pieces of finality-pins.json this kind reads (V2_SPEC_S7 section 4.2; the twin of pkg/finality/baseposted/pins.go).
 * The framework keeps the section raw (Pins.sections); it is parsed here with Go's json.Unmarshal rules (case-insensitive keys, unknown
 * keys ignored, null a no-op, a wrongly typed value an error). Keys other chain kinds add (portal, game impl rows, max_l2_headers...) are
 * ignored. The batcher is never a pin: it is proven from SystemConfig.batcherHash at each frame block.
 */
import { JsonError } from '../../../s3/gojson.js';
import { foldEqual } from '../../../s3/fold.js';
import { JNum, JObj, Raw, decodeVal, type FieldDef, type GoVal, type JVal, type Sch } from '../../../s3/jsonx.js';
import { kzgSetupPin, type Pins } from '../pins.js';
import { Code, PinsReason, newState, pinsCorrupt, type FinalityStateError } from '../state.js';
import { ChainBaseSepolia } from '../table.js';
import { SepoliaChainID } from '../ethl1/index.js';

/** The names this kind judges under. */
export const KIND_NAME = 'base-sepolia/l1_posted/v1';
export const CHAIN = ChainBaseSepolia;
/** The impl_pins role of the SystemConfig implementation (V2_SPEC_S7 section 4.2). */
export const ROLE_SYSTEM_CONFIG_IMPL = 'syscfg_impl';

/**
 * The post_denim capability row (V2_SPEC_S7 5.4 O6; the twin of baseposted/pins.go PostDenim): what the verifier assumes of Base after the Denim fork -
 * 200 ms blocks, five per timestamp second, singular batches only. batchTypes is judged (the selected batch's type must be in it) and
 * blockIntervalMs * blocksPerSecond must be one second. The BaseTime pair is shape-validated and carried; l1_posted does not judge it (TECH_DEBT O6).
 */
export interface PostDenim {
  batchTypes: number[];
  blockIntervalMs: bigint;
  blocksPerSecond: bigint;
  /** 20 bytes */
  baseTimePredeploy: Uint8Array;
  /** 4 bytes */
  baseTimeSelector: Uint8Array;
}

export interface BasePins {
  chainId: bigint;
  l1ChainId: bigint;
  /** 20 bytes */
  systemConfig: Uint8Array;
  /** 20 bytes */
  batchInbox: Uint8Array;
  seqWindowSize: bigint;
  /** the Bedrock channel timeout, in L1 blocks: in force for a frame whose L1 block time is before graniteTime */
  channelTimeout: bigint;
  /** activation time of Granite (L1 block time, seconds): from it the channel timeout is channelTimeoutGranite */
  graniteTime: bigint;
  /** the post-Granite channel timeout, in L1 blocks (op-node params.ChannelTimeoutGranite = 50) */
  channelTimeoutGranite: bigint;
  maxRlpBytesPerChannel: bigint;
  /**
   * INFORMATIONAL for l1_posted: nothing in this kind's judgement depends on it. It is required and non-zero because the base_sepolia
   * section is shared with the finalized kind, which refuses a pre-Isthmus header (spec 5.5 O5).
   */
  isthmusTime: bigint;
  denimTime: bigint;
  maxBlobs: number;
  l2GenesisTime: bigint;
  l2BlockTime: bigint;
  /** from the shared section, or the legacy base_sepolia copy of a published pins file (kzgSetupPin) */
  kzgSetupSha256: string;
  /** the pins key kzgSetupSha256 was read from, for pins_corrupt reports */
  kzgSetupKey: string;
  /** impl_pins rows with role syscfg_impl, as lower-case 0x hex of the 32-byte code hash */
  systemConfigImplHashes: Set<string>;
  /** the post_denim row, or null when the pins file has none: every block with timestamp >= denimTime is then batch_format_unsupported{post_denim} */
  postDenim: PostDenim | null;
}

const f = (name: string, json: string, sch: Sch): FieldDef => ({ name, json, sch });

const baseSch: Sch = {
  struct: [
    f('ChainID', 'chain_id', 'u64'),
    f('L1ChainID', 'l1_chain_id', 'u64'),
    f('SystemConfig', 'system_config', 'string'),
    f('BatchInbox', 'batch_inbox', 'string'),
    f('SeqWindowSize', 'seq_window_size', 'u64'),
    f('ChannelTimeout', 'channel_timeout', 'u64'),
    f('GraniteTime', 'granite_time', 'u64'),
    f('ChannelTimeoutGranite', 'channel_timeout_granite', 'u64'),
    f('MaxRLPBytesPerChannel', 'max_rlp_bytes_per_channel', 'u64'),
    f('IsthmusTime', 'isthmus_time', 'u64'),
    f('DenimTime', 'denim_time', 'u64'),
    f('MaxBlobs', 'max_blobs', 'i64'),
    f('L2GenesisTime', 'l2_genesis_time', 'u64'),
    f('L2BlockTime', 'l2_block_time', 'u64'),
    f('KZGSetupSHA256', 'kzg_setup_sha256', 'string'),
    f('ImplPins', 'impl_pins', { map: 'raw' }),
    f('PostDenim', 'post_denim', 'raw'),
  ],
};

const postDenimSch: Sch = {
  struct: [
    f('BatchTypes', 'batch_types', 'raw'),
    f('BlockIntervalMS', 'block_interval_ms', 'u64'),
    f('BlocksPerSecond', 'blocks_per_second', 'u64'),
    f('BaseTimePredeploy', 'base_time_predeploy', 'string'),
    f('BaseTimeSelector', 'base_time_selector', 'string'),
  ],
};

/**
 * Go's json decode of a []uint8 (rawPostDenim.BatchTypes): null is the nil slice, a string is standard base64 (padding required, CR and LF
 * ignored), an array decodes element by element into uint8 (a null element is the zero value, a number must be a plain integer 0..255).
 * undefined: Go reports an error.
 */
function uint8Slice(v: JVal | undefined): number[] | undefined {
  if (v === undefined || v === null) return [];
  if (typeof v === 'string') {
    const t = v.replace(/[\r\n]/g, '');
    if (t.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(t)) return undefined;
    return Array.from(atob(t), (c) => c.charCodeAt(0));
  }
  if (!Array.isArray(v)) return undefined;
  const out: number[] = [];
  for (const e of v) {
    if (e === null) out.push(0);
    else if (e instanceof JNum && /^(0|[1-9][0-9]*)$/.test(e.lit) && Number(e.lit) <= 255) out.push(Number(e.lit));
    else return undefined;
  }
  return out;
}

/** The capability row, or undefined for any malformed row (the caller names the key). Unknown keys are refused (Go DisallowUnknownFields). */
function parsePostDenim(raw: Raw): PostDenim | undefined {
  const v = raw.v;
  if (!(v instanceof JObj)) return undefined;
  const def = (postDenimSch as { struct: FieldDef[] }).struct;
  for (const [k] of v.pairs) if (!def.some((x) => x.json === k || foldEqual(x.json, k))) return undefined;
  let r: { [k: string]: GoVal };
  try {
    r = decodeVal(postDenimSch, v, 'post_denim') as { [k: string]: GoVal };
  } catch (e) {
    if (e instanceof JsonError) return undefined;
    throw e;
  }
  const batchTypes = uint8Slice((r.BatchTypes as Raw).v);
  if (batchTypes === undefined || batchTypes.length !== 1 || batchTypes[0] !== 0) return undefined;
  const interval = r.BlockIntervalMS as bigint;
  const perSecond = r.BlocksPerSecond as bigint;
  // Go multiplies two uint64 values: the product wraps modulo 2^64, and this twin reproduces that so the two verifiers judge one pins file alike (RB12-F23)
  if (interval === 0n || perSecond === 0n || interval > 1000n || BigInt.asUintN(64, interval * perSecond) !== 1000n) return undefined;
  const pre = unhex(r.BaseTimePredeploy as string, 20);
  const sel = unhex(r.BaseTimeSelector as string, 4);
  if (pre === undefined || sel === undefined) return undefined;
  return { batchTypes, blockIntervalMs: interval, blocksPerSecond: perSecond, baseTimePredeploy: pre, baseTimeSelector: sel };
}

const roleSch: Sch = { struct: [f('Role', 'role', 'string')] };

/** Lower-case 0x hex of exactly n bytes (pins.go unhex). */
function unhex(s: string, n: number): Uint8Array | undefined {
  if (!s.startsWith('0x') || s !== s.toLowerCase()) return undefined;
  const h = s.slice(2);
  if (h.length !== 2 * n || !/^[0-9a-f]*$/.test(h)) return undefined;
  return Uint8Array.from(h.match(/../g) ?? [], (x) => parseInt(x, 16));
}

/**
 * Reads the base_sepolia section of the framework pins. An absent section is finality_pin_unknown; a malformed one is
 * finality_pins_corrupt{bad_value, key}.
 */
export function parseBasePins(p: Pins | null | undefined): BasePins {
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
  const str = (k: string): string => r[k] as string;
  if (big('ChainID') !== CHAIN) throw bad('chain_id');
  if (big('L1ChainID') !== SepoliaChainID) throw bad('l1_chain_id');
  const systemConfig = unhex(str('SystemConfig').toLowerCase(), 20);
  if (systemConfig === undefined) throw bad('system_config');
  const batchInbox = unhex(str('BatchInbox').toLowerCase(), 20);
  if (batchInbox === undefined) throw bad('batch_inbox');
  // pins.go ranges over a Go map here, so with two zero pins at once the one it names is not deterministic; the order below is the sorted
  // key order, and no published vector alters two of these at once.
  for (const [k, v] of [
    ['channel_timeout', big('ChannelTimeout')],
    ['channel_timeout_granite', big('ChannelTimeoutGranite')],
    ['denim_time', big('DenimTime')],
    ['granite_time', big('GraniteTime')],
    ['isthmus_time', big('IsthmusTime')],
    ['l2_block_time', big('L2BlockTime')],
    ['l2_genesis_time', big('L2GenesisTime')],
    ['max_rlp_bytes_per_channel', big('MaxRLPBytesPerChannel')],
    ['seq_window_size', big('SeqWindowSize')],
  ] as const) {
    if (v === 0n) throw bad(k);
  }
  const maxBlobs = big('MaxBlobs');
  if (maxBlobs <= 0n) throw bad('max_blobs');
  const kzg = kzgSetupPin(p, 'base_sepolia.kzg_setup_sha256', str('KZGSetupSHA256'));
  if (unhex(`0x${kzg.value}`, 32) === undefined) throw pinsCorrupt(PinsReason.BadValue, { key: kzg.key });
  const hashes = new Set<string>();
  const impl = r.ImplPins;
  if (impl instanceof Map) {
    for (const [ch, row] of impl) {
      if (unhex(ch, 32) === undefined) throw bad('impl_pins');
      let role: { [k: string]: GoVal };
      try {
        const v = (row as Raw).v;
        role = decodeVal(roleSch, v === undefined ? null : v, 'role') as { [k: string]: GoVal };
      } catch (e) {
        if (e instanceof JsonError) throw bad('impl_pins');
        throw e;
      }
      if (role.Role === ROLE_SYSTEM_CONFIG_IMPL) hashes.add(ch);
    }
  }
  if (hashes.size === 0) throw bad('impl_pins');
  let postDenim: PostDenim | null = null;
  const pdRaw = r.PostDenim as Raw;
  if (pdRaw.v !== undefined) {
    const pd = parsePostDenim(pdRaw);
    if (pd === undefined) throw bad('post_denim');
    postDenim = pd;
  }
  return {
    chainId: big('ChainID'),
    l1ChainId: big('L1ChainID'),
    systemConfig,
    batchInbox,
    seqWindowSize: big('SeqWindowSize'),
    channelTimeout: big('ChannelTimeout'),
    graniteTime: big('GraniteTime'),
    channelTimeoutGranite: big('ChannelTimeoutGranite'),
    maxRlpBytesPerChannel: big('MaxRLPBytesPerChannel'),
    isthmusTime: big('IsthmusTime'),
    denimTime: big('DenimTime'),
    maxBlobs: maxBlobs > 0x7fffffffn ? 0x7fffffff : Number(maxBlobs),
    l2GenesisTime: big('L2GenesisTime'),
    l2BlockTime: big('L2BlockTime'),
    kzgSetupSha256: kzg.value,
    kzgSetupKey: kzg.key,
    systemConfigImplHashes: hashes,
    postDenim,
  };
}

/**
 * op-node's ChainSpec.ChannelTimeout(t) (op-node/rollup/chain_spec.go): the Granite value when t >= granite_time, the Bedrock value before.
 * t is the timestamp of the L1 block the frame is included in (op-node's origin.Time at IngestFrame).
 */
export function channelTimeoutAt(bp: Pick<BasePins, 'graniteTime' | 'channelTimeout' | 'channelTimeoutGranite'>, l1Time: bigint): bigint {
  return l1Time >= bp.graniteTime ? bp.channelTimeoutGranite : bp.channelTimeout;
}
