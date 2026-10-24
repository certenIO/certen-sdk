/**
 * Variants of the published pins/main.json (base_sepolia section) for the pins tests and for the Go cross-check: each variant is a name, a
 * mutation of the parsed section, and the verdict expected of parseBasePins. The file written for a variant keeps every other section and
 * the loader's own rules (keys sorted at every depth, LF, two-space indent).
 */
import { parsePinsOverride, type Pins } from '../../../src/proof-v2/finality/pins.js';
import { read } from './vectorset.js';

type J = Record<string, any>;
const sortKeys = (v: unknown): unknown =>
  Array.isArray(v)
    ? v.map(sortKeys)
    : v !== null && typeof v === 'object'
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, sortKeys((v as J)[k])]),
        )
      : v;

export const mainJson = (): J => JSON.parse(read('pins/main.json').toString('utf8'));

/** JSON text with the big integers of the variants written exactly (JSON.stringify would round 2^64-1). */
const BIG = /"__big__(-?\d+)"/g;
export const pinsText = (doc: J): string => `${JSON.stringify(sortKeys(doc), null, 2).replace(BIG, '$1')}\n`;
export const pinsOf = (doc: J): Pins => parsePinsOverride(Buffer.from(pinsText(doc)));
const big = (s: string): string => `__big__${s}`;

/** the code hash of the 0.2.0 game implementation row (the game of the live leg 47604755) and the asr_impl row */
export const GAME_020 = '0xf7f8a640ea3ffadf55e9f425a039e879471a1cda9988e92e2c96d423e08869c7';
export const ASR_IMPL = '0xd01ffe5bb9bdf9cb1e42b2dd12188f9bc2a163e8301b24451d7d8485280148b7';

export interface Variant {
  name: string;
  mutate: (b: J) => void;
  /** 'ok' or the canonical code and the key of finality_pins_corrupt */
  expect: 'ok' | { code: string; key?: string; reason?: string };
  /** mutate the whole document (a variant of the top level) as well */
  top?: (d: J) => void;
}

const corrupt = (key: string): { code: string; key: string } => ({ code: 'finality_pins_corrupt', key });
const impl = (b: J, hash = GAME_020): J => b.impl_pins[hash];

export const variants: Variant[] = [
  { name: 'unchanged', mutate: () => {}, expect: 'ok' },
  { name: 'section_absent', mutate: () => {}, top: (d) => delete d.base_sepolia, expect: { code: 'finality_pin_unknown' } },
  { name: 'section_null', mutate: () => {}, top: (d) => (d.base_sepolia = null), expect: { code: 'finality_pin_unknown' } },
  {
    name: 'section_empty_object',
    mutate: (b) => {
      for (const k of Object.keys(b)) delete b[k];
    },
    expect: corrupt('base_sepolia.chain_id'),
  },
  { name: 'chain_id_other', mutate: (b) => (b.chain_id = 8453), expect: corrupt('base_sepolia.chain_id') },
  { name: 'chain_id_string', mutate: (b) => (b.chain_id = '84532'), expect: corrupt('base_sepolia') },
  { name: 'chain_id_negative', mutate: (b) => (b.chain_id = -1), expect: corrupt('base_sepolia') },
  { name: 'l1_chain_id_other', mutate: (b) => (b.l1_chain_id = 1), expect: corrupt('base_sepolia.l1_chain_id') },
  { name: 'portal_uppercase', mutate: (b) => (b.portal = b.portal.toUpperCase().replace('0X', '0x')), expect: corrupt('base_sepolia.portal') },
  { name: 'portal_short', mutate: (b) => (b.portal = b.portal.slice(0, -2)), expect: corrupt('base_sepolia.portal') },
  { name: 'portal_no_prefix', mutate: (b) => (b.portal = b.portal.slice(2)), expect: corrupt('base_sepolia.portal') },
  { name: 'portal_null', mutate: (b) => (b.portal = null), expect: corrupt('base_sepolia.portal') },
  { name: 'system_config_uppercase', mutate: (b) => (b.system_config = b.system_config.toUpperCase().replace('0X', '0x')), expect: corrupt('base_sepolia.system_config') },
  { name: 'system_config_long', mutate: (b) => (b.system_config += '00'), expect: corrupt('base_sepolia.system_config') },
  { name: 'max_l2_headers_zero', mutate: (b) => (b.max_l2_headers = 0), expect: corrupt('base_sepolia.max_l2_headers') },
  { name: 'max_l2_headers_negative', mutate: (b) => (b.max_l2_headers = -5), expect: corrupt('base_sepolia.max_l2_headers') },
  { name: 'max_l2_headers_string', mutate: (b) => (b.max_l2_headers = '1024'), expect: corrupt('base_sepolia') },
  { name: 'max_l2_headers_huge', mutate: (b) => (b.max_l2_headers = big('9223372036854775807')), expect: 'ok' },
  { name: 'max_l2_headers_overflow', mutate: (b) => (b.max_l2_headers = big('9223372036854775808')), expect: corrupt('base_sepolia') },
  {
    name: 'upper_case_key_names',
    mutate: (b) => {
      b.CHAIN_ID = b.chain_id;
      delete b.chain_id;
      b.Portal = b.portal;
      delete b.portal;
    },
    expect: 'ok',
  },
  {
    name: 'unknown_keys_ignored',
    mutate: (b) => {
      b.batch_inbox = '0xff';
      b.zzz = { a: [1, 2] };
    },
    expect: 'ok',
  },
  {
    // an upper-case spelling INSTEAD of the lower-case key: not a hash key (the digits must be lower case), the section is bad
    name: 'impl_key_uppercase',
    mutate: (b) => {
      delete b.impl_pins[GAME_020];
      b.impl_pins[GAME_020.toUpperCase().replace('0X', '0x')] = { role: 'x' };
    },
    expect: corrupt('base_sepolia.impl_pins'),
  },
  {
    // BESIDE the lower-case key: two spellings of one name in an object that is not a struct, refused by the framework walk before the
    // section is read (RB12-OPS-A1: Go answers duplicate_key naming the second spelling in document order, which is the lower-case one here)
    name: 'impl_key_uppercase_beside_the_lowercase',
    mutate: (b) => {
      b.impl_pins[GAME_020.toUpperCase().replace('0X', '0x')] = { role: 'x' };
    },
    expect: { code: 'finality_pins_corrupt', reason: 'duplicate_key', key: GAME_020 },
  },
  {
    name: 'impl_key_short',
    mutate: (b) => {
      b.impl_pins['0x00'] = { role: 'x' };
    },
    expect: corrupt('base_sepolia.impl_pins'),
  },
  {
    name: 'impl_key_zero_hash',
    mutate: (b) => {
      b.impl_pins[`0x${'00'.repeat(32)}`] = { role: 'asr_impl', finality_delay_seconds: 0 };
    },
    expect: corrupt('base_sepolia.impl_pins'),
  },
  {
    name: 'proxy_key_zero_hash',
    mutate: (b) => {
      b.proxy_pins[`0x${'00'.repeat(32)}`] = { role: 'op_proxy' };
    },
    expect: corrupt('base_sepolia.proxy_pins'),
  },
  { name: 'impl_asr_number', mutate: (b) => (impl(b).asr = 5), expect: corrupt('base_sepolia.impl_pins') },
  { name: 'impl_dgf_number', mutate: (b) => (impl(b).dgf = 5), expect: corrupt('base_sepolia.impl_pins') },
  { name: 'impl_asr_null', mutate: (b) => (impl(b).asr = null), expect: 'ok' },
  { name: 'impl_asr_uppercase_is_unreadable_not_corrupt', mutate: (b) => (impl(b).asr = impl(b).asr.toUpperCase().replace('0X', '0x')), expect: 'ok' },
  { name: 'impl_asr_object', mutate: (b) => (impl(b).asr = { a: 1 }), expect: corrupt('base_sepolia.impl_pins') },
  { name: 'proxy_row_asr_bad_type', mutate: (b) => (b.proxy_pins[Object.keys(b.proxy_pins)[0]!].asr = 7), expect: corrupt('base_sepolia.proxy_pins') },
  { name: 'impl_role_empty', mutate: (b) => (impl(b).role = ''), expect: corrupt('base_sepolia.impl_pins') },
  { name: 'impl_row_null', mutate: (b) => (b.impl_pins[GAME_020] = null), expect: corrupt('base_sepolia.impl_pins') },
  { name: 'impl_row_array', mutate: (b) => (b.impl_pins[GAME_020] = [1]), expect: corrupt('base_sepolia.impl_pins') },
  { name: 'impl_n_intermediate_string', mutate: (b) => (impl(b).n_intermediate = '20'), expect: corrupt('base_sepolia.impl_pins') },
  { name: 'impl_n_intermediate_float', mutate: (b) => (impl(b).n_intermediate = 20.5), expect: corrupt('base_sepolia.impl_pins') },
  { name: 'impl_game_type_overflow32', mutate: (b) => (impl(b).game_type = 4294967296), expect: corrupt('base_sepolia.impl_pins') },
  { name: 'impl_game_type_null', mutate: (b) => (impl(b).game_type = null), expect: 'ok' },
  { name: 'impl_game_type_negative', mutate: (b) => (impl(b).game_type = -1), expect: corrupt('base_sepolia.impl_pins') },
  {
    name: 'impl_interval_extra_element_ignored',
    mutate: (b) =>
      (impl(b).interval_pairs = [
        [600, 30, 7],
        [6000, 300, 9, 9],
      ]),
    expect: 'ok',
  },
  { name: 'impl_interval_short_pair', mutate: (b) => (impl(b).interval_pairs = [[600]]), expect: 'ok' },
  { name: 'impl_interval_not_array', mutate: (b) => (impl(b).interval_pairs = [5]), expect: corrupt('base_sepolia.impl_pins') },
  { name: 'impl_interval_object', mutate: (b) => (impl(b).interval_pairs = { a: 1 }), expect: corrupt('base_sepolia.impl_pins') },
  { name: 'impl_interval_null_pair', mutate: (b) => (impl(b).interval_pairs = [null]), expect: 'ok' },
  { name: 'impl_interval_negative', mutate: (b) => (impl(b).interval_pairs = [[600, -30]]), expect: corrupt('base_sepolia.impl_pins') },
  { name: 'impl_delay_string', mutate: (b) => (b.impl_pins[ASR_IMPL].finality_delay_seconds = '0'), expect: corrupt('base_sepolia.impl_pins') },
  { name: 'impl_delay_u64_max', mutate: (b) => (b.impl_pins[ASR_IMPL].finality_delay_seconds = big('18446744073709551615')), expect: 'ok' },
  { name: 'impl_delay_u64_overflow', mutate: (b) => (b.impl_pins[ASR_IMPL].finality_delay_seconds = big('18446744073709551616')), expect: corrupt('base_sepolia.impl_pins') },
  { name: 'impl_n_wraps_int64', mutate: (b) => (impl(b).n_intermediate = big('576460752303423508')), expect: 'ok' },
  {
    name: 'proxy_key_bad',
    mutate: (b) => {
      b.proxy_pins['0xZZ'] = { role: 'op_proxy' };
    },
    expect: corrupt('base_sepolia.proxy_pins'),
  },
  {
    name: 'proxy_role_empty',
    mutate: (b) => {
      for (const k of Object.keys(b.proxy_pins)) b.proxy_pins[k].role = '';
    },
    expect: corrupt('base_sepolia.proxy_pins'),
  },
  {
    name: 'proxy_row_bad_type',
    mutate: (b) => {
      b.proxy_pins[Object.keys(b.proxy_pins)[0]!].game_type = 'y';
    },
    expect: corrupt('base_sepolia.proxy_pins'),
  },
  { name: 'layout_args_base_len_135', mutate: (b) => (b.game_layout.aggregate_v1.args_base_len = 135), expect: corrupt('base_sepolia.game_layout') },
  { name: 'layout_args_base_len_136', mutate: (b) => (b.game_layout.aggregate_v1.args_base_len = 136), expect: 'ok' },
  { name: 'layout_args_base_len_zero', mutate: (b) => (b.game_layout.aggregate_v1.args_base_len = 0), expect: corrupt('base_sepolia.game_layout') },
  { name: 'layout_args_per_root_31', mutate: (b) => (b.game_layout.aggregate_v1.args_per_root = 31), expect: corrupt('base_sepolia.game_layout') },
  { name: 'layout_args_per_root_64', mutate: (b) => (b.game_layout.aggregate_v1.args_per_root = 64), expect: 'ok' },
  { name: 'layout_clone_head_odd', mutate: (b) => (b.game_layout.aggregate_v1.clone_head = '0x123'), expect: corrupt('base_sepolia.game_layout') },
  { name: 'layout_clone_mid_uppercase', mutate: (b) => (b.game_layout.aggregate_v1.clone_mid = '0xAB60623639'), expect: corrupt('base_sepolia.game_layout') },
  { name: 'layout_clone_tail_empty', mutate: (b) => (b.game_layout.aggregate_v1.clone_tail = '0x'), expect: 'ok' },
  { name: 'layout_clone_tail_no_prefix', mutate: (b) => (b.game_layout.aggregate_v1.clone_tail = '5af4'), expect: corrupt('base_sepolia.game_layout') },
  { name: 'layout_absent', mutate: (b) => delete b.game_layout, expect: 'ok' },
  {
    name: 'layout_other_name_only',
    mutate: (b) => {
      b.game_layout.other = b.game_layout.aggregate_v1;
      delete b.game_layout.aggregate_v1;
    },
    expect: 'ok',
  },
  {
    name: 'layout_second_bad',
    mutate: (b) => {
      b.game_layout.zzz = { ...b.game_layout.aggregate_v1, args_base_len: 1 };
    },
    expect: corrupt('base_sepolia.game_layout'),
  },
];

/** Builds the document of a variant. */
export function variantDoc(v: Variant): J {
  const d = mainJson();
  v.mutate(d.base_sepolia);
  v.top?.(d);
  return d;
}
