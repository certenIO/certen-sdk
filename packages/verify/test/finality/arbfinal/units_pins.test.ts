/**
 * T1, T2, T5 and N2 of the Go twin list: the arb_sepolia pins section of arb-sepolia/finalized/v1 loaded in Go's order (pins.go:105-203) with
 * nothing defaulted, the embedded wallet identity checked against the real runtime codes, the closed set of pin_mismatch.field, the wallet pins of
 * an override file, and the harness injection that re-serializes with sorted keys.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { keccak_256 } from '@noble/hashes/sha3';
import { describe, expect, it } from 'vitest';
import { embeddedPins, embeddedPinsBytes, parsePinsOverride, type Pins } from '../../../src/proof-v2/finality/pins.js';
import { PinMismatchField, FinalityStateError, cmpUtf8, hexLower } from '../../../src/proof-v2/finality/state.js';
import { fixtureJSON, readFixture } from '../helpers.js';
import {
  FINAL1,
  FINAL3,
  WALLET_IMPL,
  WALLET_IMPL_SLOT,
  WALLET_LOGIC_CODE_HASH,
  WALLET_PROXY_CODE_HASH,
  bytesOfHex,
  evidenceOf,
  legOf,
  load,
  readIn,
  sha256Hex,
  vectorByName,
  withWalletPins,
} from './vectorset.js';

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = join(here, '..', '..', '..', 'src', 'proof-v2', 'finality', 'arbfinal');

const sortKeys = (v: unknown): unknown =>
  Array.isArray(v)
    ? v.map(sortKeys)
    : v !== null && typeof v === 'object'
      ? Object.fromEntries(
          Object.keys(v as object)
            .sort(cmpUtf8)
            .map((k) => [k, sortKeys((v as Record<string, unknown>)[k])]),
        )
      : v;

/** The embedded pins with the arb_sepolia section changed by f, re-serialized with sorted keys. */
const mutated = (f: (arb: any) => void): Pins => {
  const doc = JSON.parse(new TextDecoder().decode(embeddedPinsBytes()));
  f(doc.arb_sepolia);
  return parsePinsOverride(new TextEncoder().encode(JSON.stringify(sortKeys(doc))));
};

/** The canonical outcome of loading the pins: "ok" or the named state. */
const outcome = async (p: Pins | null): Promise<string> => {
  const { loadArbFinalPins } = await load();
  try {
    loadArbFinalPins(p);
    return 'ok';
  } catch (e) {
    return e instanceof FinalityStateError ? e.canonical() : `ERROR ${String(e)}`;
  }
};
const mismatch = (field: string): string => `{"code":"pin_mismatch","fields":{"field":"${field}"}}`;

describe('T2: the embedded values', () => {
  it('load as the Go values: rollup, bold genesis, max_header_chain, layout, slots, wallet pins, the eight selectors and two topics', async () => {
    const { loadArbFinalPins } = await load();
    const a = loadArbFinalPins(embeddedPins());
    expect(hexLower(a.rollup)).toBe('042b2e6c5e99d4c521bd49beed5e99651d9b0cf4');
    expect(a.boldGenesisL2Block).toBe(105880604n);
    expect(a.maxHeaderChain).toBe(32768n);
    expect(a.layout).toEqual({
      name: 'nitro-contracts-v3.1.0',
      assertionsSlot: 117n,
      statusShiftBits: 200n,
      configSlotOffset: 1n,
      fastConfirmerSlot: 123n,
      fastConfirmerShiftBits: 8n,
      accArraySlot: 7n,
      delayedAccArraySlot: 6n,
    });
    expect(hexLower(a.adminSlot)).toBe('360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc');
    expect(hexLower(a.userSlot)).toBe('2b1dbce74324248c222f0ec2d5ed7bd323cfc425b336f0253c5ccfda7265546d');
    expect(hexLower(a.walletImpl)).toBe('579831de7576b8580a2beaa5f56b4b32e1292419');
    expect(hexLower(a.walletImplSlot)).toBe('360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc');
    expect(a.logicPins.get(WALLET_PROXY_CODE_HASH)).toBe('validator_wallet_proxy');
    expect(a.logicPins.get(WALLET_LOGIC_CODE_HASH)).toBe('validator_wallet_logic');
    expect(a.logicPins.size).toBe(5);
    expect(Object.values(a.sel).map(hexLower)).toEqual(['10b98a35', '5bf03833', '6096686d', '6420fb9f', 'ce1d571f', '72f45866', '097da1f8', 'c179f1d9']);
    expect(hexLower(a.topic.confirmed)).toBe('fc42829b29c259a7370ab56c8f69fce23b5f351a9ce151da453281993ec0090c');
    expect(hexLower(a.topic.forceConfirmed)).toBe('0ef6ac64bd6b0fa95ed37aa19a1b16613fb89e2269c92639a9d516a64fea4938');
  });

  it('the harness constants are the embedded file\'s four wallet pins, and the impl slot is the EIP-1967 slot and the admin_logic slot', () => {
    const arb = (JSON.parse(new TextDecoder().decode(embeddedPinsBytes())) as any).arb_sepolia;
    expect(arb.confirm_path.validator_wallet_impl).toBe(WALLET_IMPL);
    expect(arb.proxy_slots.wallet_impl).toBe(WALLET_IMPL_SLOT);
    expect(arb.proxy_slots.wallet_impl).toBe(arb.proxy_slots.admin_logic);
    expect(arb.logic_pins[WALLET_PROXY_CODE_HASH]).toBe('validator_wallet_proxy');
    expect(arb.logic_pins[WALLET_LOGIC_CODE_HASH]).toBe('validator_wallet_logic');
    // keccak256("eip1967.proxy.implementation") - 1
    const slot = (BigInt(`0x${hexLower(keccak_256(new TextEncoder().encode('eip1967.proxy.implementation')))}`) - 1n).toString(16).padStart(64, '0');
    expect(`0x${slot}`).toBe(WALLET_IMPL_SLOT);
  });

  it('the two real runtime codes hash to the pinned code hashes; the template embeds its own address once, the proxy not at all (Go TestThePinnedWalletIdentityIsTheRealRuntimeCode)', () => {
    const proxyHex = readFixture('arb_final_walletcode', 'proxy_runtime.hex').toString('utf8');
    const logicHex = readFixture('arb_final_walletcode', 'logic_runtime.hex').toString('utf8');
    expect(sha256Hex(Buffer.from(proxyHex))).toBe('fc08c6cf35d0f362ff6911168813efc8cad68b3c1512f573e51a855ccbdf6ffc');
    expect(sha256Hex(Buffer.from(logicHex))).toBe('8020056a07fd6d97b3a07ab13fc97059965fcfa67540d1bee20753c733d261a7');
    const proxy = bytesOfHex(proxyHex.trim());
    const logic = bytesOfHex(logicHex.trim());
    expect(proxy.length).toBe(2147);
    expect(logic.length).toBe(6864);
    expect(`0x${hexLower(keccak_256(proxy))}`).toBe(WALLET_PROXY_CODE_HASH);
    expect(`0x${hexLower(keccak_256(logic))}`).toBe(WALLET_LOGIC_CODE_HASH);
    const addr = bytesOfHex(WALLET_IMPL);
    const count = (code: Uint8Array): number => {
      let n = 0;
      for (let i = 0; i + 20 <= code.length; i++) if (addr.every((x, j) => code[i + j] === x)) n++;
      return n;
    };
    expect(count(logic)).toBe(1);
    expect(count(proxy)).toBe(0);
  });
});

describe('T1: LoadPins in the order of pins.go:105-203, nothing defaulted', () => {
  it('an absent pins value or an absent arb_sepolia section is finality_pin_unknown{chain, kind}', async () => {
    const want = '{"code":"finality_pin_unknown","fields":{"chain":"421614","kind":"arb_sepolia"}}';
    expect(await outcome(null)).toBe(want);
    const doc = JSON.parse(new TextDecoder().decode(embeddedPinsBytes()));
    delete doc.arb_sepolia;
    expect(await outcome(parsePinsOverride(new TextEncoder().encode(JSON.stringify(sortKeys(doc)))))).toBe(want);
  });

  const cases: [string, (a: any) => void, string][] = [
    ['an unknown key in the section', (a) => (a.zz_unknown = 1), 'section'],
    ['an unknown key in layout', (a) => (a.layout.zz_unknown = 1), 'section'],
    ['an unknown key in confirm_path', (a) => (a.confirm_path.zz_unknown = 1), 'section'],
    ['an unknown key in proxy_slots', (a) => (a.proxy_slots.zz_unknown = 1), 'section'],
    ['chain_id of a string', (a) => (a.chain_id = '421614'), 'section'],
    ['max_blobs of a string', (a) => (a.max_blobs = '16'), 'section'],
    ['layout of a number', (a) => (a.layout = 1), 'section'],
    ['logic_pins of a list', (a) => (a.logic_pins = []), 'section'],
    ['bold_genesis_l2_block above 2^64-1', (a) => (a.bold_genesis_l2_block = 1.8446744073709552e19), 'section'],
    ['chain_id 421615', (a) => (a.chain_id = 421615), 'chain_id'],
    ['chain_id 0', (a) => (a.chain_id = 0), 'chain_id'],
    ['parent_chain_id 1', (a) => (a.parent_chain_id = 1), 'parent_chain_id'],
    ['rollup short', (a) => (a.rollup = a.rollup.slice(0, -2)), 'rollup'],
    ['rollup long', (a) => (a.rollup = `${a.rollup}00`), 'rollup'],
    ['rollup without 0x', (a) => (a.rollup = a.rollup.slice(2)), 'rollup'],
    ['rollup with 0X', (a) => (a.rollup = `0X${a.rollup.slice(2)}`), 'rollup'],
    ['rollup not hex', (a) => (a.rollup = `0x${'g'.repeat(40)}`), 'rollup'],
    ['layout name', (a) => (a.layout.name = 'nitro-contracts-v3.1.1'), 'layout'],
    ['assertions_slot 0', (a) => (a.layout.assertions_slot = 0), 'layout'],
    ['status_shift_bits 0', (a) => (a.layout.status_shift_bits = 0), 'layout'],
    ['status_shift_bits 249', (a) => (a.layout.status_shift_bits = 249), 'layout'],
    ['config_slot_offset 0', (a) => (a.layout.config_slot_offset = 0), 'layout'],
    ['fast_confirmer_slot 0', (a) => (a.layout.fast_confirmer_slot = 0), 'layout'],
    ['fast_confirmer_shift_bits 97', (a) => (a.layout.fast_confirmer_shift_bits = 97), 'layout'],
    ['max_header_chain 0', (a) => (a.max_header_chain = 0), 'max_header_chain'],
    ['max_header_chain -1', (a) => (a.max_header_chain = -1), 'max_header_chain'],
    ['bold_genesis_l2_block 0', (a) => (a.bold_genesis_l2_block = 0), 'bold_genesis_l2_block'],
    ['proxy_slots.admin_logic short', (a) => (a.proxy_slots.admin_logic = a.proxy_slots.admin_logic.slice(0, -2)), 'proxy_slots.admin_logic'],
    ['proxy_slots.admin_logic empty', (a) => (a.proxy_slots.admin_logic = ''), 'proxy_slots.admin_logic'],
    ['proxy_slots.user_logic absent', (a) => delete a.proxy_slots.user_logic, 'proxy_slots.user_logic'],
    ['proxy_slots.user_logic not hex', (a) => (a.proxy_slots.user_logic = `0x${'z'.repeat(64)}`), 'proxy_slots.user_logic'],
    ['proxy_slots.wallet_impl absent', (a) => delete a.proxy_slots.wallet_impl, 'proxy_slots.wallet_impl'],
    ['proxy_slots.wallet_impl 31 bytes', (a) => (a.proxy_slots.wallet_impl = a.proxy_slots.wallet_impl.slice(0, -2)), 'proxy_slots.wallet_impl'],
    ['proxy_slots.wallet_impl 33 bytes', (a) => (a.proxy_slots.wallet_impl = `${a.proxy_slots.wallet_impl}00`), 'proxy_slots.wallet_impl'],
    ['confirm_path.validator_wallet_impl absent', (a) => delete a.confirm_path.validator_wallet_impl, 'confirm_path.validator_wallet_impl'],
    ['confirm_path.validator_wallet_impl the zero address', (a) => (a.confirm_path.validator_wallet_impl = `0x${'0'.repeat(40)}`), 'confirm_path.validator_wallet_impl'],
    ['confirm_path.validator_wallet_impl 19 bytes', (a) => (a.confirm_path.validator_wallet_impl = a.confirm_path.validator_wallet_impl.slice(0, -2)), 'confirm_path.validator_wallet_impl'],
    ['confirm_path.validator_wallet_impl 21 bytes', (a) => (a.confirm_path.validator_wallet_impl = `${a.confirm_path.validator_wallet_impl}00`), 'confirm_path.validator_wallet_impl'],
    ['a logic_pins key that is not 32 bytes', (a) => (a.logic_pins['0x1234'] = 'x'), 'logic_pins'],
    ['a logic_pins key without 0x', (a) => (a.logic_pins['ab'.repeat(32)] = 'x'), 'logic_pins'],
    ['no validator_wallet_proxy role', (a) => delete a.logic_pins[WALLET_PROXY_CODE_HASH], 'logic_pins.validator_wallet_proxy'],
    ['no validator_wallet_logic role', (a) => delete a.logic_pins[WALLET_LOGIC_CODE_HASH], 'logic_pins.validator_wallet_logic'],
    ['validator_wallet_proxy on the zero hash', (a) => (a.logic_pins[`0x${'0'.repeat(64)}`] = 'validator_wallet_proxy'), 'logic_pins.validator_wallet_proxy'],
    ['validator_wallet_proxy on keccak256("")', (a) => (a.logic_pins['0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470'] = 'validator_wallet_proxy'), 'logic_pins.validator_wallet_proxy'],
    ['validator_wallet_logic on the zero hash', (a) => (a.logic_pins[`0x${'0'.repeat(64)}`] = 'validator_wallet_logic'), 'logic_pins.validator_wallet_logic'],
    ['validator_wallet_logic on keccak256("")', (a) => (a.logic_pins['0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470'] = 'validator_wallet_logic'), 'logic_pins.validator_wallet_logic'],
    ['a role pinned only under another name', (a) => (a.logic_pins[WALLET_PROXY_CODE_HASH] = 'validator_wallet_proxy '), 'logic_pins.validator_wallet_proxy'],
  ];
  it.each(cases)('%s is pin_mismatch{field}', async (_n, f, field) => {
    expect(await outcome(mutated(f))).toBe(mismatch(field));
  });

  const sels = ['confirm_assertion', 'fast_confirm_assertion', 'fast_confirm_new_assertion', 'force_confirm_assertion', 'wallet_execute_transaction', 'wallet_execute_transaction_with_gas_refunder', 'wallet_execute_transactions', 'wallet_execute_transactions_with_gas_refunder'];
  it.each(sels.flatMap((n) => [[n, ''], [n, '0x00000000'], [n, '0x1234'], [n, '0x123456789'], [n, 'ab12cd34'], [n, '0xzzzzzzzz'], [n, 'absent']] as const))(
    'selector %s as %j is pin_mismatch{confirm_path.selectors.<name>}',
    async (name, bad) => {
      const p = mutated((a) => (bad === 'absent' ? delete a.confirm_path.selectors[name] : (a.confirm_path.selectors[name] = bad)));
      expect(await outcome(p)).toBe(mismatch(`confirm_path.selectors.${name}`));
    },
  );
  it.each(['assertion_confirmed', 'assertion_force_confirmed'].flatMap((n) => [[n, ''], [n, `0x${'0'.repeat(62)}`], [n, `0x${'0'.repeat(66)}`], [n, 'absent']] as const))(
    'topic %s as %j is pin_mismatch{confirm_path.topics.<name>}',
    async (name, bad) => {
      const p = mutated((a) => (bad === 'absent' ? delete a.confirm_path.topics[name] : (a.confirm_path.topics[name] = bad)));
      expect(await outcome(p)).toBe(mismatch(`confirm_path.topics.${name}`));
    },
  );

  it('a zero topic hash and a zero admin/user slot are values like any other (Go checks only their length)', async () => {
    expect(await outcome(mutated((a) => (a.confirm_path.topics.assertion_confirmed = `0x${'0'.repeat(64)}`)))).toBe('ok');
    expect(await outcome(mutated((a) => (a.proxy_slots.admin_logic = `0x${'0'.repeat(64)}`)))).toBe('ok');
  });

  it('the values the kind ignores still must decode: max_blobs, max_segments, max_uncompressed_batch, bridge, bold_genesis_assertion and the l1_posted layout slots take any value of their type', async () => {
    expect(await outcome(mutated((a) => (a.max_blobs = 0)))).toBe('ok');
    expect(await outcome(mutated((a) => (a.max_segments = -1)))).toBe('ok');
    expect(await outcome(mutated((a) => (a.max_uncompressed_batch = 0)))).toBe('ok');
    expect(await outcome(mutated((a) => (a.bridge = 'not an address')))).toBe('ok');
    expect(await outcome(mutated((a) => (a.bold_genesis_assertion = '')))).toBe('ok');
    expect(await outcome(mutated((a) => ((a.layout.acc_array_slot = 0), (a.layout.delayed_acc_array_slot = 0))))).toBe('ok');
    expect(await outcome(mutated((a) => (a.max_blobs = 'x')))).toBe(mismatch('section'));
    expect(await outcome(mutated((a) => (a.max_segments = 1.5)))).toBe(mismatch('section'));
  });

  it('boundaries are exact: N passes, N-1 fails', async () => {
    const ok = async (f: (a: any) => void): Promise<boolean> => (await outcome(mutated(f))) === 'ok';
    expect(await ok((a) => (a.layout.status_shift_bits = 248))).toBe(true);
    expect(await ok((a) => (a.layout.status_shift_bits = 249))).toBe(false);
    expect(await ok((a) => (a.layout.status_shift_bits = 1))).toBe(true);
    expect(await ok((a) => (a.layout.status_shift_bits = 0))).toBe(false);
    expect(await ok((a) => (a.layout.fast_confirmer_shift_bits = 96))).toBe(true);
    expect(await ok((a) => (a.layout.fast_confirmer_shift_bits = 97))).toBe(false);
    expect(await ok((a) => (a.layout.fast_confirmer_shift_bits = 0))).toBe(true);
    expect(await ok((a) => (a.layout.fast_confirmer_slot = 1))).toBe(true);
    expect(await ok((a) => (a.layout.fast_confirmer_slot = 0))).toBe(false);
    expect(await ok((a) => (a.layout.assertions_slot = 1))).toBe(true);
    expect(await ok((a) => (a.layout.config_slot_offset = 1))).toBe(true);
    expect(await ok((a) => (a.max_header_chain = 1))).toBe(true);
    expect(await ok((a) => (a.max_header_chain = 0))).toBe(false);
    expect(await ok((a) => (a.bold_genesis_l2_block = 1))).toBe(true);
    expect(await ok((a) => (a.confirm_path.validator_wallet_impl = `0x${'0'.repeat(39)}1`))).toBe(true);
  });

  it('hex is read as Go reads it: either letter case, the prefix exactly 0x', async () => {
    expect(await outcome(mutated((a) => (a.rollup = `0x${a.rollup.slice(2).toUpperCase()}`)))).toBe('ok');
    expect(await outcome(mutated((a) => (a.proxy_slots.user_logic = `0x${a.proxy_slots.user_logic.slice(2).toUpperCase()}`)))).toBe('ok');
    expect(await outcome(mutated((a) => (a.confirm_path.selectors.confirm_assertion = '0x10B98A35')))).toBe('ok');
    const p = mutated((a) => {
      delete a.logic_pins[WALLET_PROXY_CODE_HASH];
      a.logic_pins[`0x${WALLET_PROXY_CODE_HASH.slice(2).toUpperCase()}`] = 'validator_wallet_proxy';
    });
    const { loadArbFinalPins } = await load();
    expect(loadArbFinalPins(p).logicPins.get(WALLET_PROXY_CODE_HASH)).toBe('validator_wallet_proxy');
  });

  it('keys match case-insensitively once exact equality fails, and null is a no-op (Go encoding/json)', async () => {
    expect(await outcome(mutated((a) => ((a.Chain_ID = a.chain_id), delete a.chain_id)))).toBe('ok');
    expect(await outcome(mutated((a) => ((a.layout.Name = a.layout.name), delete a.layout.name)))).toBe('ok');
    expect(await outcome(mutated((a) => (a.chain_id = null)))).toBe(mismatch('chain_id'));
    expect(await outcome(mutated((a) => (a.layout = null)))).toBe(mismatch('layout'));
    expect(await outcome(mutated((a) => (a.confirm_path = null)))).toBe(mismatch('confirm_path.validator_wallet_impl'));
    expect(await outcome(mutated((a) => (a.proxy_slots = null)))).toBe(mismatch('proxy_slots.admin_logic'));
    expect(await outcome(mutated((a) => (a.logic_pins = null)))).toBe(mismatch('logic_pins.validator_wallet_proxy'));
    expect(await outcome(mutated((a) => (a.confirm_path.selectors = null)))).toBe(mismatch('confirm_path.selectors.confirm_assertion'));
    expect(await outcome(mutated((a) => (a.confirm_path.topics = null)))).toBe(mismatch('confirm_path.topics.assertion_confirmed'));
  });

  it('the checks run in the order of Go: the first of two defects is the one named', async () => {
    const order: [string, (a: any) => void][] = [
      ['chain_id', (a) => (a.chain_id = 1)],
      ['parent_chain_id', (a) => (a.parent_chain_id = 1)],
      ['rollup', (a) => (a.rollup = '0x')],
      ['layout', (a) => (a.layout.name = 'x')],
      ['max_header_chain', (a) => (a.max_header_chain = 0)],
      ['bold_genesis_l2_block', (a) => (a.bold_genesis_l2_block = 0)],
      ['proxy_slots.admin_logic', (a) => (a.proxy_slots.admin_logic = '0x')],
      ['proxy_slots.user_logic', (a) => (a.proxy_slots.user_logic = '0x')],
      ['proxy_slots.wallet_impl', (a) => (a.proxy_slots.wallet_impl = '0x')],
      ['confirm_path.validator_wallet_impl', (a) => (a.confirm_path.validator_wallet_impl = '0x')],
      ['logic_pins', (a) => (a.logic_pins['0x1'] = 'x')],
      ['logic_pins.validator_wallet_proxy', (a) => delete a.logic_pins[WALLET_PROXY_CODE_HASH]],
      ['logic_pins.validator_wallet_logic', (a) => delete a.logic_pins[WALLET_LOGIC_CODE_HASH]],
      ['confirm_path.selectors.confirm_assertion', (a) => (a.confirm_path.selectors.confirm_assertion = '0x')],
      ['confirm_path.topics.assertion_confirmed', (a) => (a.confirm_path.topics.assertion_confirmed = '0x')],
    ];
    for (let i = 0; i < order.length; i++) {
      for (let j = i + 1; j < order.length; j++) {
        const p = mutated((a) => {
          order[i]![1](a);
          order[j]![1](a);
        });
        expect(await outcome(p), `${order[i]![0]} before ${order[j]![0]}`).toBe(mismatch(order[i]![0]));
      }
    }
  });

  it('a section that does not decode is named before any value is judged (section precedes chain_id)', async () => {
    expect(await outcome(mutated((a) => ((a.chain_id = 1), (a.zz = 1))))).toBe(mismatch('section'));
  });

  it('N1 (RB12-OPS-A1, F4/N1): a hash given twice in different letter cases never reaches the loader from a file: the framework walk refuses the file as duplicate_key, whatever the roles (the guard behind it is tested in units_pins_opssync_rb12.test.ts)', () => {
    for (const role of ['validator_wallet_proxy', 'validator_wallet_logic', 'other']) {
      let got: unknown;
      try {
        mutated((a) => (a.logic_pins[`0x${WALLET_PROXY_CODE_HASH.slice(2).toUpperCase()}`] = role));
      } catch (e) {
        got = e;
      }
      expect(got, role).toBeInstanceOf(FinalityStateError);
      expect((got as FinalityStateError).canonical(), role).toBe(
        `{"code":"finality_pins_corrupt","fields":{"key":"${WALLET_PROXY_CODE_HASH}","reason":"duplicate_key"}}`,
      );
    }
  });

  it('with several bad selectors the one first in sorted name order is named (Go names a random one)', async () => {
    const p = mutated((a) => {
      a.confirm_path.selectors.wallet_execute_transactions = '0x';
      a.confirm_path.selectors.fast_confirm_assertion = '0x';
      a.confirm_path.selectors.wallet_execute_transaction = '0x';
    });
    expect(await outcome(p)).toBe(mismatch('confirm_path.selectors.fast_confirm_assertion'));
    expect(
      await outcome(
        mutated((a) => {
          a.confirm_path.topics.assertion_force_confirmed = '0x';
          a.confirm_path.topics.assertion_confirmed = '0x';
        }),
      ),
    ).toBe(mismatch('confirm_path.topics.assertion_confirmed'));
  });
});

describe('N2(3): an override file (CERTEN_FINALITY_PINS_FILE) needs the four wallet pins', () => {
  const v = vectorByName(FINAL3, 'synth_valid_wallet_execute_transaction_proven');
  const synth = JSON.parse(readIn(FINAL3.dir, 'pins/synth.json').toString('utf8'));
  const without = (f: (a: any) => void): Pins => {
    const d = JSON.parse(JSON.stringify(synth));
    f(d.arb_sepolia);
    return parsePinsOverride(new TextEncoder().encode(JSON.stringify(sortKeys(d))));
  };
  const judge = async (p: Pins): Promise<string> => {
    const { ArbFinalKind } = await load();
    try {
      new ArbFinalKind().verify(p, legOf(v), evidenceOf(FINAL3, v));
      return 'accepted';
    } catch (e) {
      return e instanceof FinalityStateError ? e.canonical() : `ERROR ${String(e)}`;
    }
  };

  it('the same evidence is accepted under the override with the pins and refused with pin_mismatch{field} under each override without one', async () => {
    expect(await judge(without(() => undefined))).toBe('accepted');
    expect(await judge(without((a) => delete a.proxy_slots.wallet_impl))).toBe(mismatch('proxy_slots.wallet_impl'));
    expect(await judge(without((a) => delete a.confirm_path.validator_wallet_impl))).toBe(mismatch('confirm_path.validator_wallet_impl'));
    expect(await judge(without((a) => delete a.logic_pins[WALLET_PROXY_CODE_HASH]))).toBe(mismatch('logic_pins.validator_wallet_proxy'));
    expect(await judge(without((a) => delete a.logic_pins[WALLET_LOGIC_CODE_HASH]))).toBe(mismatch('logic_pins.validator_wallet_logic'));
    expect(
      await judge(
        without((a) => {
          delete a.proxy_slots.wallet_impl;
          delete a.confirm_path.validator_wallet_impl;
          delete a.logic_pins[WALLET_PROXY_CODE_HASH];
          delete a.logic_pins[WALLET_LOGIC_CODE_HASH];
        }),
      ),
    ).toBe(mismatch('proxy_slots.wallet_impl'));
  });

  it('a pins file of the first published sets (no wallet pins) is refused the same way until the harness injects them', async () => {
    const f1 = vectorByName(FINAL1, 'synth_valid_direct');
    const raw = readIn(FINAL1.dir, `pins/${f1.pins}`);
    const { ArbFinalKind } = await load();
    const run = (b: Uint8Array): string => {
      try {
        new ArbFinalKind().verify(parsePinsOverride(b), legOf(f1), evidenceOf(FINAL1, f1));
        return 'accepted';
      } catch (e) {
        return (e as FinalityStateError).canonical();
      }
    };
    expect(run(raw)).toBe(mismatch('proxy_slots.wallet_impl'));
    expect(run(withWalletPins(raw))).toBe('accepted');
  });
});

describe('N2(1): the harness injection re-serializes with sorted keys and lower-case logic_pins keys', () => {
  const stored = readIn(FINAL1.dir, 'pins/synth.json');

  it('adds exactly the four pins, keeps every other value, and the result is a file the parser accepts (keys sorted at every level of the section)', async () => {
    const out = withWalletPins(stored);
    const before = JSON.parse(stored.toString('utf8'));
    const after = JSON.parse(new TextDecoder().decode(out));
    expect(after.arb_sepolia.confirm_path.validator_wallet_impl).toBe(WALLET_IMPL);
    expect(after.arb_sepolia.proxy_slots.wallet_impl).toBe(WALLET_IMPL_SLOT);
    expect(after.arb_sepolia.logic_pins[WALLET_PROXY_CODE_HASH]).toBe('validator_wallet_proxy');
    expect(after.arb_sepolia.logic_pins[WALLET_LOGIC_CODE_HASH]).toBe('validator_wallet_logic');
    expect(Object.keys(after.arb_sepolia.logic_pins).every((k) => k === k.toLowerCase())).toBe(true);
    delete after.arb_sepolia.confirm_path.validator_wallet_impl;
    delete after.arb_sepolia.proxy_slots.wallet_impl;
    delete after.arb_sepolia.logic_pins[WALLET_PROXY_CODE_HASH];
    delete after.arb_sepolia.logic_pins[WALLET_LOGIC_CODE_HASH];
    expect(sortKeys(after)).toEqual(sortKeys(before));
    const text = new TextDecoder().decode(out);
    const sorted = (o: any): boolean => (o !== null && typeof o === 'object' ? (Array.isArray(o) ? o.every(sorted) : Object.keys(o).every((k, i, ks) => i === 0 || cmpUtf8(ks[i - 1]!, k) < 0) && Object.values(o).every(sorted)) : true);
    expect(sorted(JSON.parse(text))).toBe(true);
    const { loadArbFinalPins } = await load();
    expect(hexLower(loadArbFinalPins(parsePinsOverride(out)).walletImpl)).toBe(WALLET_IMPL.slice(2).toLowerCase());
  });

  it('an unsorted re-serialization is refused by the parser (finality_pins_corrupt{keys_unsorted}), which is why the harness sorts', () => {
    const doc = JSON.parse(stored.toString('utf8'));
    doc.arb_sepolia.logic_pins[WALLET_PROXY_CODE_HASH] = 'validator_wallet_proxy';
    doc.arb_sepolia.logic_pins['0x00'.padEnd(66, '0')] = 'z';
    let err: FinalityStateError | undefined;
    try {
      parsePinsOverride(new TextEncoder().encode(JSON.stringify(doc)));
    } catch (e) {
      err = e as FinalityStateError;
    }
    expect(err?.code).toBe('finality_pins_corrupt');
    expect(err?.fields.reason).toBe('keys_unsorted');
  });

  it('a file that already carries the four pins, a file without the section and a file whose section lacks confirm_path, proxy_slots or logic_pins come back byte for byte', () => {
    const once = withWalletPins(stored);
    expect(withWalletPins(once)).toBe(once);
    const noSection = readIn(FINAL1.dir, 'pins/synth_no_arb_sepolia.json');
    expect(withWalletPins(noSection)).toBe(noSection);
    for (const drop of ['confirm_path', 'proxy_slots', 'logic_pins']) {
      const d = JSON.parse(stored.toString('utf8'));
      delete d.arb_sepolia[drop];
      const raw = new TextEncoder().encode(JSON.stringify(sortKeys(d)));
      expect(withWalletPins(raw), drop).toBe(raw);
    }
    const nul = JSON.parse(stored.toString('utf8'));
    nul.arb_sepolia = null;
    const rawNull = new TextEncoder().encode(JSON.stringify(sortKeys(nul)));
    expect(withWalletPins(rawNull)).toBe(rawNull);
  });

  it('a file with only some of the four pins gets all four (and keeps the one it had)', () => {
    const d = JSON.parse(stored.toString('utf8'));
    d.arb_sepolia.proxy_slots.wallet_impl = WALLET_IMPL_SLOT;
    const out = JSON.parse(new TextDecoder().decode(withWalletPins(new TextEncoder().encode(JSON.stringify(sortKeys(d))))));
    expect(out.arb_sepolia.confirm_path.validator_wallet_impl).toBe(WALLET_IMPL);
    expect(out.arb_sepolia.logic_pins[WALLET_LOGIC_CODE_HASH]).toBe('validator_wallet_logic');
  });
});

describe('T5: pin_mismatch.field is a closed set of 31 members', () => {
  const reg = fixtureJSON<{ states: Record<string, { enums: Record<string, string[]> }> }>('finality', 'states.json');
  const set = new Set(reg.states.pin_mismatch!.enums.field);
  const ownFields = [
    'bold_genesis_l2_block', 'chain_id', 'confirm_path.selectors.confirm_assertion', 'confirm_path.selectors.fast_confirm_assertion',
    'confirm_path.selectors.fast_confirm_new_assertion', 'confirm_path.selectors.force_confirm_assertion', 'confirm_path.selectors.wallet_execute_transaction',
    'confirm_path.selectors.wallet_execute_transaction_with_gas_refunder', 'confirm_path.selectors.wallet_execute_transactions',
    'confirm_path.selectors.wallet_execute_transactions_with_gas_refunder', 'confirm_path.topics.assertion_confirmed', 'confirm_path.topics.assertion_force_confirmed',
    'confirm_path.validator_wallet_impl', 'layout', 'logic_pins', 'logic_pins.validator_wallet_logic', 'logic_pins.validator_wallet_proxy', 'max_header_chain',
    'parent_chain_id', 'proxy_slots.admin_logic', 'proxy_slots.user_logic', 'proxy_slots.wallet_impl', 'rollup', 'section',
  ];

  it('the registry copy has 31 members and every member is a TS constant', () => {
    expect(reg.states.pin_mismatch!.enums.field.length).toBe(31);
    expect(set.size).toBe(31);
    expect(Object.values(PinMismatchField).sort()).toEqual([...set].sort());
  });

  it('every field this kind emits (all 24 of them, each by its own variant) is a member of the set, and the 7 others belong to the l1_posted kind', async () => {
    const seen = new Set<string>();
    const cases2: [string, (a: any) => void][] = [
      ...(
        [
          ['section', (a: any) => (a.zz = 1)],
          ['chain_id', (a: any) => (a.chain_id = 1)],
          ['parent_chain_id', (a: any) => (a.parent_chain_id = 1)],
          ['rollup', (a: any) => (a.rollup = '0x')],
          ['layout', (a: any) => (a.layout.name = 'x')],
          ['max_header_chain', (a: any) => (a.max_header_chain = 0)],
          ['bold_genesis_l2_block', (a: any) => (a.bold_genesis_l2_block = 0)],
          ['proxy_slots.admin_logic', (a: any) => (a.proxy_slots.admin_logic = '0x')],
          ['proxy_slots.user_logic', (a: any) => (a.proxy_slots.user_logic = '0x')],
          ['proxy_slots.wallet_impl', (a: any) => (a.proxy_slots.wallet_impl = '0x')],
          ['confirm_path.validator_wallet_impl', (a: any) => (a.confirm_path.validator_wallet_impl = '0x')],
          ['logic_pins', (a: any) => (a.logic_pins['0x1'] = 'x')],
          ['logic_pins.validator_wallet_proxy', (a: any) => delete a.logic_pins[WALLET_PROXY_CODE_HASH]],
          ['logic_pins.validator_wallet_logic', (a: any) => delete a.logic_pins[WALLET_LOGIC_CODE_HASH]],
        ] as [string, (a: any) => void][]
      ),
      ...ownFields.filter((f) => f.startsWith('confirm_path.selectors.')).map((f): [string, (a: any) => void] => [f, (a: any) => (a.confirm_path.selectors[f.split('.')[2]!] = '0x')]),
      ...ownFields.filter((f) => f.startsWith('confirm_path.topics.')).map((f): [string, (a: any) => void] => [f, (a: any) => (a.confirm_path.topics[f.split('.')[2]!] = '0x')]),
    ];
    const { loadArbFinalPins } = await load();
    for (const [field, f] of cases2) {
      try {
        loadArbFinalPins(mutated(f));
        throw new Error(`${field}: accepted`);
      } catch (e) {
        expect(e).toBeInstanceOf(FinalityStateError);
        const s = e as FinalityStateError;
        expect(s.code).toBe('pin_mismatch');
        seen.add(s.fields.field as string);
        expect(s.fields.field).toBe(field);
      }
    }
    expect([...seen].sort()).toEqual([...ownFields].sort());
    for (const f of seen) expect(set.has(f), f).toBe(true);
    expect(ownFields.length).toBe(24);
    expect([...set].filter((f) => !seen.has(f)).sort()).toEqual([
      'bridge', 'kzg_setup_sha256', 'layout.acc_array_slot', 'layout.delayed_acc_array_slot', 'max_blobs', 'max_segments', 'max_uncompressed_batch',
    ]);
  });

  it('every pin_mismatch field literal and template in the kind\'s sources is a member of the set', () => {
    let n = 0;
    for (const f of ['pins.ts', 'verify.ts', 'confirm.ts', 'wire.ts', 'nodebounds.ts']) {
      const text = readFileSync(join(srcDir, f), 'utf8');
      for (const m of text.matchAll(/pinMismatch\('([a-z0-9_.]+)'\)/g)) {
        n++;
        expect(set.has(m[1]!), `${f}: ${m[1]}`).toBe(true);
      }
      for (const m of text.matchAll(/pinMismatch\(`([^`]+)`\)/g)) {
        n++;
        const t = m[1]!;
        if (t === 'logic_pins.${role}') for (const r of ['validator_wallet_proxy', 'validator_wallet_logic']) expect(set.has(`logic_pins.${r}`)).toBe(true);
        else if (t === 'confirm_path.selectors.${name}') for (const s of ownFields.filter((x) => x.startsWith('confirm_path.selectors.'))) expect(set.has(s)).toBe(true);
        else if (t === 'confirm_path.topics.${name}') for (const s of ownFields.filter((x) => x.startsWith('confirm_path.topics.'))) expect(set.has(s)).toBe(true);
        else throw new Error(`${f}: unexpected template ${t}`);
      }
    }
    expect(n).toBeGreaterThanOrEqual(14);
  });
});
