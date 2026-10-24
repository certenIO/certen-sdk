/**
 * RB12-TS-OPSSYNC item 2, baseposted: the port of baseposted/pins_det_rb12_test.go (RB12-OPS-A1, ledger F4/N1 sweep) with the same inputs and
 * the same expected state. Go's ParsePins ranged over a Go map of the nine numeric pins, so a file with two zero pins named a random one of
 * them; the pins are now judged in sorted-name order and every case names the same key every time. The TS loader already read them in that
 * order (its own comment said so): this file turns the comment into a test, so TS and Go cannot drift apart again.
 */
import { describe, expect, it } from 'vitest';
import { parseGoJson, type JVal } from '../../../src/s3/jsonx.js';
import { parseBasePins } from '../../../src/proof-v2/finality/baseposted/pins.js';
import { embeddedPins, type Pins } from '../../../src/proof-v2/finality/pins.js';
import { FinalityStateError, PinsReason } from '../../../src/proof-v2/finality/state.js';

const embedded = embeddedPins();
const baseSection = (): Record<string, any> => {
  const text = new TextDecoder().decode(embedded.raw!);
  return JSON.parse(text).base_sepolia;
};
/** The embedded file's shared section (the KZG setup pin) with the given base_sepolia section, as Go's pinsWith builds it (no framework walk). */
const pinsWith = (m: Record<string, any>): Pins => ({
  ...embedded,
  sections: new Map<string, JVal>([['base_sepolia', parseGoJson(JSON.stringify(m))]]),
});
const stateOf = (f: () => unknown): FinalityStateError => {
  try {
    f();
  } catch (e) {
    if (e instanceof FinalityStateError) return e;
    throw e;
  }
  throw new Error('no state raised');
};

describe('baseposted pins: several zero pins are named in sorted-name order (pins_det_rb12_test.go TestSeveralZeroPinsAreNamedInSortedOrder)', () => {
  const order = [
    'channel_timeout',
    'channel_timeout_granite',
    'denim_time',
    'granite_time',
    'isthmus_time',
    'l2_block_time',
    'l2_genesis_time',
    'max_rlp_bytes_per_channel',
    'seq_window_size',
  ];
  it('the nine pins, each case zeroing the named one and every one after it, loaded 1,000 times', () => {
    order.forEach((named, i) => {
      const m = baseSection();
      for (const key of order.slice(i)) m[key] = 0;
      const p = pinsWith(m);
      for (let run = 0; run < 1000; run++) {
        const s = stateOf(() => parseBasePins(p));
        if (s.code !== 'finality_pins_corrupt' || s.fields.key !== `base_sepolia.${named}` || s.fields.reason !== PinsReason.BadValue) {
          throw new Error(`${named}, load ${run}: ${s.canonical()}`);
        }
      }
    });
  });

  it('a zero pin is named before the max_blobs, KZG and impl_pins checks that follow it in the order of Go', () => {
    const m = baseSection();
    m.seq_window_size = 0;
    m.max_blobs = 0;
    m.impl_pins = {};
    expect(stateOf(() => parseBasePins(pinsWith(m))).fields.key).toBe('base_sepolia.seq_window_size');
    const n = baseSection();
    n.max_blobs = 0;
    n.impl_pins = {};
    expect(stateOf(() => parseBasePins(pinsWith(n))).fields.key).toBe('base_sepolia.max_blobs');
  });

  it('the embedded section is untouched: it loads, and the same every time', () => {
    const p = pinsWith(baseSection());
    const first = parseBasePins(p);
    for (let run = 0; run < 200; run++) {
      const again = parseBasePins(p);
      expect(again.chainId).toBe(first.chainId);
      expect(again.systemConfigImplHashes.size).toBe(first.systemConfigImplHashes.size);
      expect(again.systemConfig).toEqual(first.systemConfig);
    }
  });
});
