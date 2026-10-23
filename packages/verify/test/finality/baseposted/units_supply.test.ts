/**
 * RB12-TS-TWINS-2 (TSB-3): the harness supplies the Granite pins LOSSLESSLY and byte-identically to Go. test/fixtures/finality/base_supply
 * holds, for 39 hand-made hostile pins files and the 7 published base_posted1 pins files, the input and what the Go
 * SupplyBaseSepoliaPins(in, PublishedSetPinSupply) wrote (or that it refused), generated at validator pv2/rb11-e1-raise@cbb6373. The previous
 * harness re-serialised through JSON.parse and refused an integer above 2^53.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PUBLISHED_SET_PIN_SUPPLY, sha256Hex, supplyBaseSepoliaPins } from './vectorset.js';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'fixtures', 'finality', 'base_supply');
const MANIFEST_SHA256 = '5af7cd62fd64966db536f4608dd80c2ed0e6f480cf604a24b8746cba5f34df3d';
const rd = (f: string): Buffer => readFileSync(join(DIR, f));
const names = readdirSync(DIR)
  .filter((f) => f.endsWith('.in'))
  .map((f) => f.slice(0, -3))
  .sort();
/** The inputs on which Go succeeds because Decoder.Decode ignores what follows the first value; the harness refuses them (stricter). */
const GO_IGNORES_TRAILING = ['trailing_garbage', 'trailing_second_value'];

describe('the Go supply fixtures are the ones that were generated', () => {
  it('MANIFEST.json hashes to the pinned value and every file is byte-identical', () => {
    expect(sha256Hex(rd('MANIFEST.json'))).toBe(MANIFEST_SHA256);
    const m = JSON.parse(rd('MANIFEST.json').toString('utf8')) as { files: Record<string, string> };
    const present = readdirSync(DIR).filter((f) => f !== '.gitattributes' && f !== 'MANIFEST.json');
    expect(Object.keys(m.files).sort()).toEqual(present.sort());
    for (const [f, want] of Object.entries(m.files)) expect(sha256Hex(rd(f)), f).toBe(want);
  });
  it('holds 46 inputs: 29 that Go supplies and 17 that Go refuses', () => {
    expect(names.length).toBe(46);
    expect(names.filter((n) => readdirSync(DIR).includes(`${n}.err`)).length).toBe(17);
    expect(names.filter((n) => readdirSync(DIR).includes(`${n}.out`)).length).toBe(29);
  });
});

describe('the supplied pins are the Go bytes', () => {
  for (const n of names) {
    const refused = readdirSync(DIR).includes(`${n}.err`);
    if (refused) {
      it(`${n}: Go refuses it, so does the harness`, () => {
        expect(() => supplyBaseSepoliaPins(rd(`${n}.in`))).toThrow();
      });
    } else if (GO_IGNORES_TRAILING.includes(n)) {
      it(`${n}: Go cuts the trailing bytes silently, the harness refuses them by name and gives the Go bytes for the value alone`, () => {
        expect(() => supplyBaseSepoliaPins(rd(`${n}.in`))).toThrow(/pins supply: invalid character .* after top-level value/);
        const text = rd(`${n}.in`).toString('utf8');
        const first = n === 'trailing_garbage' ? text.slice(0, text.indexOf(' xyz')) : text.slice(0, text.indexOf('}{') + 1);
        expect(Buffer.compare(supplyBaseSepoliaPins(Buffer.from(first)), rd(`${n}.out`))).toBe(0);
      });
    } else {
      it(`${n}: the harness writes the Go bytes`, () => {
        const got = supplyBaseSepoliaPins(rd(`${n}.in`));
        expect(Buffer.compare(got, rd(`${n}.out`)), `${n}: ${got.toString('utf8').slice(0, 200)}`).toBe(0);
      });
    }
  }
});

describe('the supply is lossless: an integer above 2^53 is written back as written', () => {
  it('a pins file holding 2^64-1 and 2^53+1 keeps both literals, in the section and outside it', () => {
    const out = supplyBaseSepoliaPins(rd('lossless_u64_max_and_2p53p1.in')).toString('utf8');
    expect(out).toContain('"u64_max": 18446744073709551615\n');
    expect(out).toContain('"above_2p53": 9007199254740993,');
    expect(out).toContain('"neg_above_2p53": -9007199254740993,');
    expect(out).toContain('"two_p53": 9007199254740992,');
    expect(out).toContain('"huge_exp": 1e400,');
    expect(out).toContain('"trailing_zero": 0.10,');
    expect(out).toContain('"neg_zero": -0,');
    expect(out).toContain('"exp": 1E+2,');
    expect(out).toMatch(/\n {2}"other": \[\n {4}18446744073709551615,\n {4}\{\n {6}"x": 9007199254740993\n {4}\}\n {2}\]\n\}\n$/);
    expect(out).toContain('"granite_time": 1723478400,');
    expect(out).toContain('"channel_timeout_granite": 50');
    expect(out.endsWith('\n')).toBe(true);
  });
  it('a supplied key the file already has is never overwritten, even with a value above 2^53', () => {
    const out = supplyBaseSepoliaPins(rd('granite_present_huge.in')).toString('utf8');
    expect(out).toContain('"granite_time": 18446744073709551615,');
    expect(out).toContain('"channel_timeout_granite": 9007199254740993,');
    expect(out).not.toContain('1723478400');
  });
  it('the supplied values themselves may be up to 2^64-1 and are written as decimal digits', () => {
    const raw = Buffer.from('{"base_sepolia":{}}');
    expect(supplyBaseSepoliaPins(raw, { a: 18446744073709551615n, b: 9007199254740993n, c: 0 }).toString('utf8')).toBe(
      '{\n  "base_sepolia": {\n    "a": 18446744073709551615,\n    "b": 9007199254740993,\n    "c": 0\n  }\n}\n',
    );
  });
  it('a supplied value that is not an unsigned 64-bit integer is refused by name: N passes, N+1 fails', () => {
    const raw = Buffer.from('{"base_sepolia":{}}');
    expect(() => supplyBaseSepoliaPins(raw, { a: (1n << 64n) - 1n })).not.toThrow();
    for (const v of [1n << 64n, -1n, -1, 1.5, Number.NaN, 2 ** 53]) {
      expect(() => supplyBaseSepoliaPins(raw, { a: v }), String(v)).toThrow(/pins supply: supply a is not an unsigned 64-bit integer/);
    }
    // validated even when the file already holds the key (Go's value is a uint64 either way)
    expect(() => supplyBaseSepoliaPins(Buffer.from('{"base_sepolia":{"a":1}}'), { a: -1 })).toThrow(/supply a/);
  });
  it('the published constants supply Granite 1723478400 and the post-Granite channel timeout 50', () => {
    expect(PUBLISHED_SET_PIN_SUPPLY).toEqual({ granite_time: 1723478400, channel_timeout_granite: 50 });
  });
});

describe('hostile pins files', () => {
  it('a document nested beyond Go 10000-container limit is refused, one at the limit is read (no stack overflow)', () => {
    const nest = (n: number): Buffer => Buffer.from(`{"base_sepolia":{"deep":${'['.repeat(n)}${']'.repeat(n)}}}`);
    expect(() => supplyBaseSepoliaPins(nest(9999))).toThrow(/exceeded max depth/);
    const ok = supplyBaseSepoliaPins(nest(2000));
    expect(ok.length).toBeGreaterThan(2000 * 2000);
    expect(ok.toString('utf8').endsWith('\n  }\n}\n')).toBe(true);
  });
  it('a truncated file, an empty file and a lone byte are refused, never half-read', () => {
    for (const t of ['', ' ', '{', '{"base_sepolia":', '{"base_sepolia":{"a":1', '{"base_sepolia":{"a":1}']) {
      expect(() => supplyBaseSepoliaPins(Buffer.from(t)), JSON.stringify(t)).toThrow(/pins supply:/);
    }
  });
  it('a document that is not an object is refused (null is returned as it is, like Go)', () => {
    for (const t of ['[]', '5', '"x"', 'true']) expect(() => supplyBaseSepoliaPins(Buffer.from(t)), t).toThrow(/pins supply: the pins file is not a JSON object/);
    expect(supplyBaseSepoliaPins(Buffer.from('null')).toString('utf8')).toBe('null');
  });
  it('a file without a base_sepolia object is returned byte for byte, formatting and all', () => {
    const raw = Buffer.from('  {  "a" :  1e5 ,\n"b":[ 1 , 2 ]  }  ');
    expect(Buffer.compare(supplyBaseSepoliaPins(raw), raw)).toBe(0);
  });
  it('a very wide object and a very long array are written, not allocated per element ahead of time', () => {
    const keys = Array.from({ length: 20000 }, (_, i) => `"k${i}":${i}`).join(',');
    const out = supplyBaseSepoliaPins(Buffer.from(`{"base_sepolia":{${keys}}}`)).toString('utf8');
    expect(out.split('\n').length).toBe(20000 + 2 + 4 + 1);
  });
});
