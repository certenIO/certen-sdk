/**
 * The base_sepolia pieces of finality-pins.json this kind reads (V2_SPEC_S7 section 4.2; the twin of pkg/finality/baseposted/pins.go).
 * The framework keeps the section raw (Pins.sections); it is parsed here with Go's json.Unmarshal rules (case-insensitive keys, unknown
 * keys ignored, null a no-op, a wrongly typed value an error). Keys other chain kinds add (portal, game impl rows, max_l2_headers...) are
 * ignored. The batcher is never a pin: it is proven from SystemConfig.batcherHash at each frame block.
 */
import { JsonError } from '../../../s3/gojson.js';
import { Raw, decodeVal, type FieldDef, type GoVal, type Sch } from '../../../s3/jsonx.js';
import type { Pins } from '../pins.js';
import { Code, PinsReason, newState, pinsCorrupt, type FinalityStateError } from '../state.js';
import { ChainBaseSepolia } from '../table.js';
import { SepoliaChainID } from '../ethl1/index.js';

/** The names this kind judges under. */
export const KIND_NAME = 'base-sepolia/l1_posted/v1';
export const CHAIN = ChainBaseSepolia;
/** The impl_pins role of the SystemConfig implementation (V2_SPEC_S7 section 4.2). */
export const ROLE_SYSTEM_CONFIG_IMPL = 'syscfg_impl';

export interface BasePins {
  chainId: bigint;
  l1ChainId: bigint;
  /** 20 bytes */
  systemConfig: Uint8Array;
  /** 20 bytes */
  batchInbox: Uint8Array;
  seqWindowSize: bigint;
  channelTimeout: bigint;
  maxRlpBytesPerChannel: bigint;
  isthmusTime: bigint;
  denimTime: bigint;
  maxBlobs: number;
  l2GenesisTime: bigint;
  l2BlockTime: bigint;
  kzgSetupSha256: string;
  /** impl_pins rows with role syscfg_impl, as lower-case 0x hex of the 32-byte code hash */
  systemConfigImplHashes: Set<string>;
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
    f('MaxRLPBytesPerChannel', 'max_rlp_bytes_per_channel', 'u64'),
    f('IsthmusTime', 'isthmus_time', 'u64'),
    f('DenimTime', 'denim_time', 'u64'),
    f('MaxBlobs', 'max_blobs', 'i64'),
    f('L2GenesisTime', 'l2_genesis_time', 'u64'),
    f('L2BlockTime', 'l2_block_time', 'u64'),
    f('KZGSetupSHA256', 'kzg_setup_sha256', 'string'),
    f('ImplPins', 'impl_pins', { map: 'raw' }),
  ],
};

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
    ['denim_time', big('DenimTime')],
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
  const kzg = str('KZGSetupSHA256');
  if (unhex(`0x${kzg}`, 32) === undefined) throw bad('kzg_setup_sha256');
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
  return {
    chainId: big('ChainID'),
    l1ChainId: big('L1ChainID'),
    systemConfig,
    batchInbox,
    seqWindowSize: big('SeqWindowSize'),
    channelTimeout: big('ChannelTimeout'),
    maxRlpBytesPerChannel: big('MaxRLPBytesPerChannel'),
    isthmusTime: big('IsthmusTime'),
    denimTime: big('DenimTime'),
    maxBlobs: maxBlobs > 0x7fffffffn ? 0x7fffffff : Number(maxBlobs),
    l2GenesisTime: big('L2GenesisTime'),
    l2BlockTime: big('L2BlockTime'),
    kzgSetupSha256: kzg,
    systemConfigImplHashes: hashes,
  };
}
