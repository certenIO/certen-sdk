/**
 * RB12-TS-OPSSYNC item 2, basefinal: the port of basefinal/pins_det_rb12_test.go (RB12-OPS-A1, ledger F4/N1 sweep) with the same inputs and the
 * same expected state. ParsePins ranges over the maps impl_pins, proxy_pins and game_layout; every failure inside a loop returns the same value
 * for its section whichever row is the bad one, and good rows land under distinct keys, so the answer does not depend on the order a map is
 * visited in. Several bad rows at once, and bad rows in several sections, answer the same on every load; the sections are judged in the order
 * impl_pins, proxy_pins, game_layout.
 */
import { describe, it } from 'vitest';
import { parseGoJson, type JVal } from '../../../src/s3/jsonx.js';
import { parseBasePins } from '../../../src/proof-v2/finality/basefinal/pins.js';
import { embeddedPins, type Pins } from '../../../src/proof-v2/finality/pins.js';
import { FinalityStateError, PinsReason, pinsCorrupt } from '../../../src/proof-v2/finality/state.js';

const embedded = embeddedPins();
const baseSection = (): Record<string, any> => JSON.parse(new TextDecoder().decode(embedded.raw!)).base_sepolia;
const pinsWith = (m: Record<string, any>): Pins => ({ ...embedded, sections: new Map<string, JVal>([['base_sepolia', parseGoJson(JSON.stringify(m))]]) });
const string32 = (c: string): string => c.repeat(64);

/** wantPinsCorrupt of the Go test: finality_pins_corrupt{bad_value, key = base_sepolia.<key>}. */
function wantPinsCorrupt(name: string, p: Pins, key: string): void {
  const want = pinsCorrupt(PinsReason.BadValue, { key: `base_sepolia.${key}` }).canonical();
  let got = 'no state raised';
  try {
    parseBasePins(p);
  } catch (e) {
    got = e instanceof FinalityStateError ? e.canonical() : `UNNAMED ${String(e)}`;
  }
  if (got !== want) throw new Error(`${name}:\n got ${got}\nwant ${want}`);
}

const shapes: [string, (rows: Record<string, any>) => void][] = [
  ['not a hash', (r) => (r['0xZZ'] = { role: 'x' })],
  ['zero hash', (r) => (r[`0x${string32('0')}`] = { role: 'x' })],
  ['no role', (r) => (r[`0x${string32('a')}`] = {})],
  ['upper-case prefix', (r) => (r[`0X${string32('b')}`] = { role: 'x' })],
  ['upper-case digits', (r) => (r[`0x${string32('C')}`] = { role: 'x' })],
  ['33 bytes', (r) => (r[`0x${string32('d')}00`] = { role: 'x' })],
  ['31 bytes', (r) => (r[`0x${string32('e').slice(0, 62)}`] = { role: 'x' })],
  ['not an object', (r) => (r[`0x${string32('f')}`] = 'not an object')],
];

describe('basefinal pins: several bad rows answer the same on every load (pins_det_rb12_test.go TestSeveralBadRowsAnswerTheSameEveryLoad)', () => {
  const bad = (m: Record<string, any>, section: string): void => {
    for (const [, f] of shapes) f(m[section] as Record<string, any>);
  };

  it('bad rows in one section and in two, 1,000 loads each; the sections are judged impl_pins, proxy_pins, game_layout', () => {
    for (const [name, sections, key] of [
      ['impl_pins alone', ['impl_pins'], 'impl_pins'],
      ['proxy_pins alone', ['proxy_pins'], 'proxy_pins'],
      ['impl_pins and proxy_pins', ['impl_pins', 'proxy_pins'], 'impl_pins'],
    ] as [string, string[], string][]) {
      const m = baseSection();
      for (const s of sections) bad(m, s);
      const p = pinsWith(m);
      for (let run = 0; run < 1000; run++) wantPinsCorrupt(`${name}, load ${run}`, p, key);
    }
    // several bad layouts, and a bad layout beside a bad proxy row: proxy_pins is judged first
    const m = baseSection();
    const layouts = m.game_layout as Record<string, any>;
    layouts.zz_not_hex = { clone_head: 'nothex', clone_mid: '0x', clone_tail: '0x', args_base_len: 136, args_per_root: 32 };
    layouts.aa_short_base = { clone_head: '0x', clone_mid: '0x', clone_tail: '0x', args_base_len: 1, args_per_root: 32 };
    layouts.mm_short_root = { clone_head: '0x', clone_mid: '0x', clone_tail: '0x', args_base_len: 136, args_per_root: 1 };
    let p = pinsWith(m);
    for (let run = 0; run < 1000; run++) wantPinsCorrupt(`several bad layouts, load ${run}`, p, 'game_layout');
    bad(m, 'proxy_pins');
    p = pinsWith(m);
    for (let run = 0; run < 1000; run++) wantPinsCorrupt(`bad proxy row and bad layouts, load ${run}`, p, 'proxy_pins');
  });

  it('every one of the eight bad row shapes is refused by itself, in either section', () => {
    for (const section of ['impl_pins', 'proxy_pins']) {
      for (const [name, f] of shapes) {
        const m = baseSection();
        f(m[section] as Record<string, any>);
        wantPinsCorrupt(`${section}: ${name}`, pinsWith(m), section);
      }
    }
  });
});
