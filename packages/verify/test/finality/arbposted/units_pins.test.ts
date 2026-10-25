/**
 * The arb_sepolia pins section (pins.ts) and the KZG setup pin the kind shares (framework `shared` section + the legacy eth_sepolia copy),
 * judged under BOTH pins files: the published vector set's (KZG pin in eth_sepolia.kzg_setup_sha256, no `shared`) and the validator's
 * embedded file (KZG pin in `shared`, arb_sepolia carrying the sibling kind's keys).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PINS_FORMAT, kzgSetupPin, parsePinsOverride, type Pins } from '../../../src/proof-v2/finality/pins.js';
import { ArbPostedKind } from '../../../src/proof-v2/finality/arbposted/verify.js';
import { USED_KZG_SETUP_SHA256, kzgPinOf, loadArbPins, pinnedBridgeImpl } from '../../../src/proof-v2/finality/arbposted/pins.js';
import { FinalityStateError } from '../../../src/proof-v2/finality/state.js';
import { evidenceOf, loadCase, read, refOf, REG_DIR } from './vectorset.js';

const KZG = 'f8e44a31ebf0a6d0734dcb301b0716e2c77f3ae18ed0cab0870fbcc2ca55616f';
const OTHER = 'aa'.repeat(32);

/** JSON with sorted keys at every level, 2-space indent, LF: the form the pins loader requires. */
function stable(v: unknown, ind = ''): string {
  if (Array.isArray(v)) return v.length === 0 ? '[]' : `[\n${v.map((x) => `${ind}  ${stable(x, ind + '  ')}`).join(',\n')}\n${ind}]`;
  if (v !== null && typeof v === 'object') {
    const ks = Object.keys(v as object).sort();
    return ks.length === 0 ? '{}' : `{\n${ks.map((k) => `${ind}  ${JSON.stringify(k)}: ${stable((v as Record<string, unknown>)[k], ind + '  ')}`).join(',\n')}\n${ind}}`;
  }
  return JSON.stringify(v);
}
type Doc = Record<string, any>;
const mainDoc = (): Doc => JSON.parse(read('pins/main.json').toString('utf8'));
const pinsOf = (mut: (d: Doc) => void, base: Doc = mainDoc()): Pins => {
  mut(base);
  return parsePinsOverride(new TextEncoder().encode(`${stable(base)}\n`));
};
const named = (f: () => unknown): FinalityStateError => {
  try {
    f();
  } catch (e) {
    if (e instanceof FinalityStateError) return e;
    throw e;
  }
  throw new Error('accepted');
};
const canon = (f: () => unknown): string => named(f).canonical();
const section = (field: string): string => `{"code":"pin_mismatch","fields":{"field":"${field}"}}`;

describe('arb_sepolia section', () => {
  it('the published vector pins load: the bridge, the slots, the bounds and the single bridge_impl pin', () => {
    const a = loadArbPins(parsePinsOverride(read('pins/main.json')));
    expect(a.chainId).toBe(421614n);
    expect(a.parentChainId).toBe(11155111n);
    expect(a.boldGenesisL2Block).toBe(105880604n);
    expect(Array.from(a.bridge, (x) => x.toString(16).padStart(2, '0')).join('')).toBe('38f918d0e9f1b721edaa41302e399fa1b79333a9');
    expect(a.layout).toEqual({ assertionsSlot: 117n, accArraySlot: 7n, delayedAccArraySlot: 6n });
    expect([a.maxBlobs, a.maxSegments, a.maxUncompressedBatch]).toEqual([16, 102400, 16777216]);
    expect(a.logicPins.size).toBe(3);
    const h = Uint8Array.from('3bd9637547d75e5b4539449e14c759b86b9d37a7c1f2b47a1524f857e4ff1a0c'.match(/../g)!, (x) => parseInt(x, 16));
    expect(pinnedBridgeImpl(a, h)).toBe(true);
    const r = Uint8Array.from('dd93a7606e6067aaae8ad5afa28b943a8272809eb72face4e2bb3bf4d0609445'.match(/../g)!, (x) => parseInt(x, 16));
    expect(pinnedBridgeImpl(a, r)).toBe(false); // another role is not bridge_impl
    expect(pinnedBridgeImpl(a, new Uint8Array(32))).toBe(false);
  });
  it('a missing pins object or section is finality_pin_unknown{chain, kind}', () => {
    const want = '{"code":"finality_pin_unknown","fields":{"chain":"421614","kind":"arb_sepolia"}}';
    expect(canon(() => loadArbPins(null))).toBe(want);
    expect(canon(() => loadArbPins(undefined))).toBe(want);
    expect(canon(() => loadArbPins(pinsOf((d) => delete d.arb_sepolia)))).toBe(want);
    expect(canon(() => loadArbPins(pinsOf((d) => (d.arb_sepolia = null))))).toBe(want);
  });
  it('every domain violation names its field, in the reference order', () => {
    const t = (field: string, mut: (a: Doc) => void): void => expect(canon(() => loadArbPins(pinsOf((d) => mut(d.arb_sepolia)))), field).toBe(section(field));
    t('chain_id', (a) => (a.chain_id = 1));
    t('chain_id', (a) => delete a.chain_id);
    t('parent_chain_id', (a) => (a.parent_chain_id = 1));
    t('bridge', (a) => (a.bridge = '0x38f918D0E9F1b721EDaA41302E399fa1B79333'));
    t('bridge', (a) => (a.bridge = '38f918D0E9F1b721EDaA41302E399fa1B79333a9aa'));
    t('bridge', (a) => (a.bridge = '0x38f918D0E9F1b721EDaA41302E399fa1B79333zz'));
    t('bridge', (a) => (a.bridge = null));
    t('layout', (a) => (a.layout.name = 'nitro-contracts-v3.2.0'));
    t('layout', (a) => delete a.layout);
    t('max_blobs', (a) => (a.max_blobs = 0));
    t('max_blobs', (a) => (a.max_blobs = -1));
    t('max_segments', (a) => (a.max_segments = 0));
    t('max_uncompressed_batch', (a) => (a.max_uncompressed_batch = 0));
    // the first failing check wins
    expect(canon(() => loadArbPins(pinsOf((d) => Object.assign(d.arb_sepolia, { chain_id: 1, parent_chain_id: 1, max_blobs: 0 }))))).toBe(section('chain_id'));
    expect(canon(() => loadArbPins(pinsOf((d) => Object.assign(d.arb_sepolia, { parent_chain_id: 1, bridge: 'x', max_blobs: 0 }))))).toBe(section('parent_chain_id'));
    expect(canon(() => loadArbPins(pinsOf((d) => Object.assign(d.arb_sepolia, { bridge: 'x', max_blobs: 0, max_segments: 0 }))))).toBe(section('bridge'));
    expect(canon(() => loadArbPins(pinsOf((d) => Object.assign(d.arb_sepolia, { max_blobs: 0, max_segments: 0 }))))).toBe(section('max_blobs'));
    expect(canon(() => loadArbPins(pinsOf((d) => Object.assign(d.arb_sepolia, { max_segments: 0, max_uncompressed_batch: 0 }))))).toBe(section('max_segments'));
  });
  it('Go json rules: an unknown key anywhere in the struct or its layout is pin_mismatch{section}; keys fold case; a wrong type is an error; null is a no-op', () => {
    const t = (mut: (a: Doc) => void): string => canon(() => loadArbPins(pinsOf((d) => mut(d.arb_sepolia))));
    expect(t((a) => (a.mystery = 1))).toBe(section('section'));
    expect(t((a) => (a.layout.mystery = 1))).toBe(section('section'));
    expect(t((a) => (a.chain_id = '421614'))).toBe(section('section'));
    expect(t((a) => (a.max_blobs = 1.5))).toBe(section('section'));
    expect(t((a) => (a.max_blobs = 2 ** 63))).toBe(section('section'));
    expect(t((a) => (a.bridge = 5))).toBe(section('section'));
    expect(t((a) => (a.logic_pins = [1]))).toBe(section('section'));
    expect(t((a) => (a.layout = [1]))).toBe(section('section'));
    expect(t((a) => (a.rollup = 7))).toBe(section('section'));
    expect(t((a) => (a.bold_genesis_assertion = 7))).toBe(section('section'));
    expect(t((a) => (a.max_header_chain = 'x'))).toBe(section('section'));
    expect(t((a) => (a.bold_genesis_l2_block = -1))).toBe(section('section'));
    // case-insensitive names are accepted once exact equality fails
    expect(() => loadArbPins(pinsOf((d) => { d.arb_sepolia.Bridge = d.arb_sepolia.bridge; delete d.arb_sepolia.bridge; }))).not.toThrow();
    expect(() => loadArbPins(pinsOf((d) => { d.arb_sepolia.LAYOUT = d.arb_sepolia.layout; delete d.arb_sepolia.layout; }))).not.toThrow();
    // null is a no-op: a null optional field keeps its zero value; a null required-positive field is refused as its own pin; the three numeric
    // pins whose value 0 is possible are refused by name when null or absent (the presence rule, below)
    expect(() => loadArbPins(pinsOf((d) => (d.arb_sepolia.rollup = null)))).not.toThrow();
    expect(t((a) => (a.bold_genesis_l2_block = null))).toBe(section('bold_genesis_l2_block'));
    expect(t((a) => (a.max_segments = null))).toBe(section('max_segments'));
    expect(t((a) => (a.layout = null))).toBe(section('layout'));
  });
  it('the sibling kind keys (confirm_path, proxy_slots, layout offsets) are accepted whatever they hold, and never read', () => {
    const a = loadArbPins(
      pinsOf((d) => {
        d.arb_sepolia.confirm_path = { anything: [1, 2, { x: null }] };
        d.arb_sepolia.proxy_slots = 'a string is fine too';
        Object.assign(d.arb_sepolia.layout, { config_slot_offset: 1, fast_confirmer_shift_bits: 8, fast_confirmer_slot: 123, status_shift_bits: 200 });
      }),
    );
    expect(a.layout.accArraySlot).toBe(7n);
  });
  it('the logic_pins map: a null role is the empty role; the same hash twice keeps the last; only bridge_impl pins', () => {
    const a = loadArbPins(pinsOf((d) => (d.arb_sepolia.logic_pins['0x' + '11'.repeat(32)] = null)));
    expect(a.logicPins.get('0x' + '11'.repeat(32))).toBe('');
    expect(pinnedBridgeImpl(a, new Uint8Array(32).fill(0x11))).toBe(false);
    const none = loadArbPins(pinsOf((d) => delete d.arb_sepolia.logic_pins));
    expect(none.logicPins.size).toBe(0);
  });
  it('a count above 2^53-1 is clamped to a safe integer (never NaN or Infinity); one beyond int64 is a section error; max_uncompressed_batch is bounded at 16 MiB instead (units_pins_maxbatch_rb12)', () => {
    const a = loadArbPins(pinsOf((d) => Object.assign(d.arb_sepolia, { max_blobs: 2 ** 53, max_segments: 2 ** 60, max_uncompressed_batch: 16777216 })));
    expect([a.maxBlobs, a.maxSegments, a.maxUncompressedBatch]).toEqual([Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, 16777216]);
    expect(canon(() => loadArbPins(pinsOf((d) => (d.arb_sepolia.max_uncompressed_batch = 2 ** 62))))).toMatch(/^{"code":"finality_pins_corrupt"/);
    expect(canon(() => loadArbPins(pinsOf((d) => (d.arb_sepolia.max_blobs = 1e19))))).toBe(section('section'));
    expect(loadArbPins(pinsOf((d) => (d.arb_sepolia.max_blobs = 2 ** 53 - 1))).maxBlobs).toBe(Number.MAX_SAFE_INTEGER);
    expect(loadArbPins(pinsOf((d) => (d.arb_sepolia.max_blobs = 2 ** 52))).maxBlobs).toBe(2 ** 52);
  });
  it('the three numeric pins whose value 0 is possible are judged by presence: an absent or null key is refused by name, a present 0 is accepted (Go TestAbsentOrNullNumericPinsAreRefusedByName)', () => {
    const cases: { field: string; layout: boolean; key: string }[] = [
      { field: 'bold_genesis_l2_block', layout: false, key: 'bold_genesis_l2_block' },
      { field: 'layout.acc_array_slot', layout: true, key: 'acc_array_slot' },
      { field: 'layout.delayed_acc_array_slot', layout: true, key: 'delayed_acc_array_slot' },
    ];
    for (const c of cases) {
      for (const how of ['absent', 'null'] as const) {
        const got = canon(() =>
          loadArbPins(
            pinsOf((d) => {
              const target = c.layout ? d.arb_sepolia.layout : d.arb_sepolia;
              if (how === 'absent') delete target[c.key];
              else target[c.key] = null;
            }),
          ),
        );
        expect(got, `${c.field} ${how}`).toBe(section(c.field));
      }
      const zero = loadArbPins(
        pinsOf((d) => {
          (c.layout ? d.arb_sepolia.layout : d.arb_sepolia)[c.key] = 0;
        }),
      );
      expect(c.layout ? (c.key === 'acc_array_slot' ? zero.layout.accArraySlot : zero.layout.delayedAccArraySlot) : zero.boldGenesisL2Block, `${c.field} 0`).toBe(0n);
    }
  });
  it('the presence rule follows the key matching of the decoder (case folding) and runs AFTER the other pins, in the order bold, acc, delayed acc', () => {
    // keys fold case: a differently cased key is the same key, so it is present
    const folded = loadArbPins(
      pinsOf((d) => {
        d.arb_sepolia.Bold_Genesis_L2_Block = d.arb_sepolia.bold_genesis_l2_block;
        delete d.arb_sepolia.bold_genesis_l2_block;
        d.arb_sepolia.layout.ACC_ARRAY_SLOT = d.arb_sepolia.layout.acc_array_slot;
        delete d.arb_sepolia.layout.acc_array_slot;
        d.arb_sepolia.layout.Delayed_Acc_Array_Slot = d.arb_sepolia.layout.delayed_acc_array_slot;
        delete d.arb_sepolia.layout.delayed_acc_array_slot;
      }),
    );
    expect([folded.boldGenesisL2Block, folded.layout.accArraySlot, folded.layout.delayedAccArraySlot]).toEqual([105880604n, 7n, 6n]);
    // a failing earlier pin is named before an absent numeric pin
    expect(
      canon(() =>
        loadArbPins(
          pinsOf((d) => {
            delete d.arb_sepolia.bold_genesis_l2_block;
            d.arb_sepolia.max_uncompressed_batch = 0;
          }),
        ),
      ),
    ).toBe(section('max_uncompressed_batch'));
    // all three absent: the first of the three is named
    expect(
      canon(() =>
        loadArbPins(
          pinsOf((d) => {
            delete d.arb_sepolia.bold_genesis_l2_block;
            delete d.arb_sepolia.layout.acc_array_slot;
            delete d.arb_sepolia.layout.delayed_acc_array_slot;
          }),
        ),
      ),
    ).toBe(section('bold_genesis_l2_block'));
    expect(
      canon(() =>
        loadArbPins(
          pinsOf((d) => {
            delete d.arb_sepolia.layout.acc_array_slot;
            delete d.arb_sepolia.layout.delayed_acc_array_slot;
          }),
        ),
      ),
    ).toBe(section('layout.acc_array_slot'));
  });
});

describe('the KZG setup pin: shared first, the legacy eth_sepolia copy only when there is no shared section', () => {
  const withShared = (v: string | null) => (d: Doc): void => {
    if (v === null) delete d.shared;
    else d.shared = { kzg_setup_sha256: v };
  };
  const withLegacy = (v: string | null) => (d: Doc): void => {
    if (v === null) delete d.eth_sepolia.kzg_setup_sha256;
    else d.eth_sepolia.kzg_setup_sha256 = v;
  };
  const both = (shared: string | null, legacy: string | null) => (d: Doc): void => {
    withShared(shared)(d);
    withLegacy(legacy)(d);
  };

  it('legacy only (the vector set) reads the legacy copy, keyed eth_sepolia.kzg_setup_sha256', () => {
    const p = pinsOf(both(null, KZG));
    expect(kzgSetupPin(p, 'eth_sepolia.kzg_setup_sha256', 'f8e44a31ebf0a6d0734dcb301b0716e2c77f3ae18ed0cab0870fbcc2ca55616f')).toEqual({ value: KZG, key: 'eth_sepolia.kzg_setup_sha256' });
    expect(kzgPinOf(p)).toBe(KZG);
    expect(p.shared).toBeNull();
    expect(p.ethSepolia!.kzgSetupSha256).toBe(KZG);
  });
  it('shared only (the embedded file) reads shared.kzg_setup_sha256', () => {
    const p = pinsOf(both(KZG, null));
    expect(p.ethSepolia!.kzgSetupSha256).toBe('');
    expect(kzgSetupPin(p, 'eth_sepolia.kzg_setup_sha256', '')).toEqual({ value: KZG, key: 'shared.kzg_setup_sha256' });
    expect(kzgPinOf(p)).toBe(KZG);
  });
  it('both equal: the shared value, under the shared key', () => {
    const p = pinsOf(both(KZG, KZG));
    expect(kzgSetupPin(p, 'eth_sepolia.kzg_setup_sha256', KZG).key).toBe('shared.kzg_setup_sha256');
  });
  it('both present and different is finality_pins_corrupt{bad_value, key: the legacy key}: the shared one never wins silently', () => {
    const p = pinsOf(both(KZG, OTHER));
    expect(canon(() => kzgPinOf(p))).toBe('{"code":"finality_pins_corrupt","fields":{"key":"eth_sepolia.kzg_setup_sha256","reason":"bad_value"}}');
    const q = pinsOf(both(OTHER, KZG));
    expect(canon(() => kzgPinOf(q))).toBe('{"code":"finality_pins_corrupt","fields":{"key":"eth_sepolia.kzg_setup_sha256","reason":"bad_value"}}');
  });
  it('neither is finality_pins_corrupt{bad_value, key: shared.kzg_setup_sha256}', () => {
    expect(canon(() => kzgPinOf(pinsOf(both(null, null))))).toBe('{"code":"finality_pins_corrupt","fields":{"key":"shared.kzg_setup_sha256","reason":"bad_value"}}');
  });
  it('no pins object is finality_pin_unknown{kind:kzg_setup_sha256}; no eth_sepolia section is finality_pin_unknown for eth_sepolia, judged first', () => {
    expect(canon(() => kzgSetupPin(null, 'k', ''))).toBe('{"code":"finality_pin_unknown","fields":{"kind":"kzg_setup_sha256"}}');
    expect(canon(() => kzgSetupPin(undefined, 'k', ''))).toBe('{"code":"finality_pin_unknown","fields":{"kind":"kzg_setup_sha256"}}');
    expect(canon(() => kzgPinOf(pinsOf((d) => delete d.eth_sepolia)))).toBe('{"code":"finality_pin_unknown","fields":{"chain":"11155111","kind":"eth_sepolia"}}');
  });
  it('the loader refuses a malformed shared value or legacy value, an unknown key inside shared, and an unsorted file', () => {
    expect(canon(() => pinsOf(withShared('AA'.repeat(32))))).toBe('{"code":"finality_pins_corrupt","fields":{"key":"shared.kzg_setup_sha256","reason":"bad_value"}}');
    expect(canon(() => pinsOf(withShared('ab')))).toBe('{"code":"finality_pins_corrupt","fields":{"key":"shared.kzg_setup_sha256","reason":"bad_value"}}');
    expect(canon(() => pinsOf((d) => (d.shared = {})))).toBe('{"code":"finality_pins_corrupt","fields":{"key":"shared.kzg_setup_sha256","reason":"bad_value"}}');
    expect(canon(() => pinsOf((d) => (d.shared = { kzg_setup_sha256: KZG, other: 1 })))).toBe('{"code":"finality_pins_corrupt","fields":{"key":"other","reason":"unknown_key"}}');
    expect(canon(() => pinsOf(withLegacy('AA'.repeat(32))))).toBe('{"code":"finality_pins_corrupt","fields":{"key":"kzg_setup_sha256","reason":"bad_value"}}');
    expect(canon(() => pinsOf(withLegacy('abcd')))).toBe('{"code":"finality_pins_corrupt","fields":{"key":"kzg_setup_sha256","reason":"bad_value"}}');
    expect(canon(() => pinsOf((d) => (d.shared = 7)))).toBe('{"code":"finality_pins_corrupt","fields":{"reason":"bad_value"}}');
    expect(() => pinsOf((d) => (d.shared = null))).not.toThrow();
    expect(pinsOf((d) => (d.shared = null)).shared).toBeNull();
  });
});

describe('the kind under both pins files', () => {
  const kind = new ArbPostedKind();
  const live = loadCase('valid_live');
  const run = (pins: Pins): string => {
    try {
      const v = kind.verify(pins, refOf(live.leg), evidenceOf(live));
      return `verified ${String(v.fields.batch_sequence_number)}`;
    } catch (e) {
      return e instanceof FinalityStateError ? e.canonical() : `UNNAMED ${String(e)}`;
    }
  };
  it('the vector pins (legacy KZG copy) verify the live batch; adding an equal shared section changes nothing', () => {
    expect(run(parsePinsOverride(read('pins/main.json')))).toBe('verified 883753');
    expect(run(pinsOf((d) => (d.shared = { kzg_setup_sha256: KZG })))).toBe('verified 883753');
  });
  it('the shared section alone (no legacy copy) verifies; a differing pair is finality_pins_corrupt before any evidence is read', () => {
    expect(run(pinsOf((d) => { d.shared = { kzg_setup_sha256: KZG }; delete d.eth_sepolia.kzg_setup_sha256; }))).toBe('verified 883753');
    expect(run(pinsOf((d) => { d.shared = { kzg_setup_sha256: OTHER }; }))).toBe(
      '{"code":"finality_pins_corrupt","fields":{"key":"eth_sepolia.kzg_setup_sha256","reason":"bad_value"}}',
    );
    expect(run(pinsOf((d) => { d.shared = { kzg_setup_sha256: KZG }; d.eth_sepolia.kzg_setup_sha256 = OTHER; }))).toBe(
      '{"code":"finality_pins_corrupt","fields":{"key":"eth_sepolia.kzg_setup_sha256","reason":"bad_value"}}',
    );
  });
  it('a pinned setup hash other than the one the backend loads is pin_mismatch{kzg_setup_sha256}, whether it came from shared or from the legacy copy', () => {
    expect(run(pinsOf((d) => { d.shared = { kzg_setup_sha256: OTHER }; delete d.eth_sepolia.kzg_setup_sha256; }))).toBe(section('kzg_setup_sha256'));
    expect(run(pinsOf((d) => (d.eth_sepolia.kzg_setup_sha256 = OTHER)))).toBe(section('kzg_setup_sha256'));
    expect(USED_KZG_SETUP_SHA256).toBe(KZG);
  });
  it('neither copy is finality_pins_corrupt{bad_value, shared.kzg_setup_sha256}', () => {
    expect(run(pinsOf((d) => delete d.eth_sepolia.kzg_setup_sha256))).toBe(
      '{"code":"finality_pins_corrupt","fields":{"key":"shared.kzg_setup_sha256","reason":"bad_value"}}',
    );
  });
  it('the validator embedded pins file (shared KZG pin; arb_sepolia with confirm_path and proxy_slots) parses, loads for this kind, and is judged -- not refused as pin_mismatch{section}', () => {
    const raw = readFileSync(join(REG_DIR, 'finality-pins.json'));
    const p = parsePinsOverride(raw);
    expect(p.shared).toEqual({ kzgSetupSha256: KZG });
    expect(p.ethSepolia!.kzgSetupSha256).toBe('');
    expect(loadArbPins(p).maxBlobs).toBe(16);
    expect(kzgPinOf(p)).toBe(KZG);
    // the embedded file carries an empty ledger, so the live batch is refused by the L1 head (the ledger is behind the proof), with a named inner reason
    expect(run(p)).toBe('{"code":"l1_finality_unproven","fields":{"inner":"finality_ledger_behind","reason":"lc_refused"}}');
  });
  it('the embedded file with the vector set ledger entry added verifies the live batch: the pins file shape does not change the verdict', () => {
    const emb = JSON.parse(readFileSync(join(REG_DIR, 'finality-pins.json'), 'utf8')) as Doc;
    emb.eth_sepolia.anchors = mainDoc().eth_sepolia.anchors;
    expect(run(pinsOf(() => undefined, emb))).toBe('verified 883753');
  });
  it('the format string of the pins file is unchanged', () => {
    expect(PINS_FORMAT).toBe('certen-finality-pins/1');
  });
});
