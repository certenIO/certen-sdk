/**
 * RB12-TS-OPSSYNC items 1, 7 and 8: the structural walk of the pins file in the shape of Go's pkg/finality/pins.go walkKeys at
 * origin/pv2/rb12-ops-a1 @4c6b8d26. The first defect a pins file shows is a function of the bytes of the file:
 *  - item 1 (RB12-OPS-A1, F4/N1): in every object that is not a struct, a key that differs from an earlier key of the same object only in
 *    letter case (simple folding) is finality_pins_corrupt{duplicate_key, key}, judged BEFORE the order rule, the first such key in
 *    document order is the one named. The cases below are the ports of pins_det_rb12_test.go (finality) with the same inputs and the same
 *    expected states.
 *  - item 7 (audit N-1): a number token whose float64 conversion is not finite makes the whole file not_json, at the point of the walk
 *    where Go's json.Decoder.Token reads it (so a violation earlier in document order is named first).
 *  - item 8 (audit N-2): the walk and every consumer of a parsed file are iterative, so a file nested to Go's limit (10,000 containers
 *    open at once, json.Valid) loads or is refused exactly as Go does and no input ends in an unnamed exception.
 * Expected states of the supplement vectors (test/finality/pins_opssync_vectors.test.ts) were recorded from Go; the cases here are the ones
 * whose answer is stated by the rule itself.
 */
import { sha256 } from '@noble/hashes/sha2';
import { describe, expect, it } from 'vitest';
import { JObj, type JVal } from '../../src/s3/jsonx.js';
import { loadArbFinalPins } from '../../src/proof-v2/finality/arbfinal/pins.js';
import { loadArbPins } from '../../src/proof-v2/finality/arbposted/pins.js';
import { parsePins as parseAdiriPins } from '../../src/proof-v2/finality/adiri/record.js';
import { parseBasePins as parseBaseFinalPins } from '../../src/proof-v2/finality/basefinal/pins.js';
import { parseBasePins as parseBasePostedPins } from '../../src/proof-v2/finality/baseposted/pins.js';
import { embeddedLedgerLinks, extendPins, nonLedgerEqual } from '../../src/proof-v2/finality/ledger.js';
import {
  PINS_SHA256,
  PINS_SOURCE_EMBEDDED,
  embeddedPins,
  embeddedPinsBytes,
  loadPins,
  parsePinsExtension,
  parsePinsOverride,
  pinsIdentity,
  type Pins,
} from '../../src/proof-v2/finality/pins.js';
import { FinalityStateError, LedgerReason, PinsReason, hexLower, pinsCorrupt } from '../../src/proof-v2/finality/state.js';

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const embeddedText = (): string => new TextDecoder().decode(embeddedPinsBytes());

/** The answer of loading raw against its own digest: the canonical named state, or "ok <sha256>"; any other exception is reported as UNNAMED. */
function loadAnswer(raw: Uint8Array): string {
  try {
    const p = loadPins(raw, sha256(raw));
    return `ok ${hexLower(p.sha256)}`;
  } catch (e) {
    return e instanceof FinalityStateError ? e.canonical() : `UNNAMED ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`;
  }
}
/** The same through the override loader (no expected digest), the entry the verifier's --pins takes. */
function overrideAnswer(raw: Uint8Array): string {
  try {
    const p = parsePinsOverride(raw);
    return `ok ${hexLower(p.sha256)}`;
  } catch (e) {
    return e instanceof FinalityStateError ? e.canonical() : `UNNAMED ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`;
  }
}
const corrupt = (reason: string, key?: string): string => pinsCorrupt(reason, key === undefined ? {} : { key }).canonical();

/** A document with one section and the two members every file carries; the keys are in sorted order for any section name before "format". */
const mini = (section: string, name = 'arb_sepolia'): string =>
  `{\n  "${name}": ${section},\n  "format": "certen-finality-pins/1",\n  "published_utc": "2026-10-23T00:00:00Z"\n}\n`;

/** pinsWithLogicPins of the Go test: the smallest file that reaches the key walk with the given logic_pins keys in the given order. */
function pinsWithLogicPins(keys: string[]): Uint8Array {
  let b = '{\n  "arb_sepolia": {\n    "logic_pins": {\n';
  keys.forEach((k, i) => {
    b += `      ${JSON.stringify(k)}: "validator_wallet_proxy"${i === keys.length - 1 ? '' : ','}\n`;
  });
  b += '    }\n  },\n  "format": "certen-finality-pins/1",\n  "published_utc": "2026-10-23T00:00:00Z"\n}\n';
  return enc(b);
}

function permutations<T>(items: T[]): T[][] {
  if (items.length <= 1) return [items.slice()];
  const out: T[][] = [];
  items.forEach((x, i) => {
    for (const p of permutations([...items.slice(0, i), ...items.slice(i + 1)])) out.push([x, ...p]);
  });
  return out;
}

describe('the digest of the shipped file (pins_det_rb12_test.go TestThePinsDigestOfTheShippedFileIsTheOneTheChannelPublishes)', () => {
  it('is the one the channel publishes, and the load of it answers the same every time with the same identity', () => {
    const published = 'fdba733e7fc4206d96d73c87352834c51801ee8fe0af76d60654cb461fbd5440';
    expect(hexLower(sha256(embeddedPinsBytes()))).toBe(published);
    expect(PINS_SHA256).toBe(published);
    for (let i = 0; i < 3; i++) {
      const p = embeddedPins();
      expect(pinsIdentity(p)).toEqual([published, PINS_SOURCE_EMBEDDED]);
    }
  });
});

describe('item 1: two spellings of one name in an object that is not a struct are duplicate_key (pins_det_rb12_test.go)', () => {
  const hash = 'ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12';
  const lower = `0x${hash}`;
  const upper = `0x${hash.toUpperCase()}`;

  it('four spellings of one code hash in every order of the document: 24 documents, 1,000 loads each, every load names the SECOND key', () => {
    const spellings = [lower, upper, `0x${hash.slice(0, 32).toUpperCase()}${hash.slice(32)}`, `0x${hash.slice(0, 32)}${hash.slice(32).toUpperCase()}`];
    const perms = permutations(spellings);
    expect(perms.length).toBe(24);
    for (const perm of perms) {
      const raw = pinsWithLogicPins(perm);
      const want = corrupt(PinsReason.DuplicateKey, perm[1]);
      for (let i = 0; i < 1000; i++) {
        const got = loadAnswer(raw);
        if (got !== want) throw new Error(`order ${JSON.stringify(perm)}, load ${i}: got ${got}, want ${want}`);
      }
      expect(overrideAnswer(raw)).toBe(want);
    }
  });

  it('touches only the case variants of one object: distinct names, exact repeats, unsorted names and the typed objects answer as before', () => {
    const other = `0x${'11'.repeat(32)}`;
    expect(loadAnswer(pinsWithLogicPins([other, upper]))).toMatch(/^ok /);
    expect(loadAnswer(pinsWithLogicPins([lower, lower]))).toBe(corrupt(PinsReason.DuplicateKey, lower));
    expect(loadAnswer(pinsWithLogicPins([lower, other]))).toBe(corrupt(PinsReason.KeysUnsorted, other));
    expect(loadAnswer(pinsWithLogicPins([other, lower, upper]))).toBe(corrupt(PinsReason.DuplicateKey, upper));
    // the spellings in two different objects are two different names
    const two = enc(
      `{\n  "arb_sepolia": {\n    "logic_pins": {\n      "${upper}": "a"\n    },\n    "other_pins": {\n      "${lower}": "b"\n    }\n  },\n  "format": "certen-finality-pins/1",\n  "published_utc": "2026-10-23T00:00:00Z"\n}\n`,
    );
    expect(loadAnswer(two)).toMatch(/^ok /);
    // a wrong-case name in an object with a schema is unknown_key, as before (not duplicate_key)
    const typed = enc('{\n  "Format": "certen-finality-pins/1",\n  "format": "certen-finality-pins/1",\n  "published_utc": "2026-10-23T00:00:00Z"\n}\n');
    expect(loadAnswer(typed)).toBe(corrupt(PinsReason.UnknownKey, 'Format'));
  });

  it('an exact repeat that is not adjacent is the ORDER rule, not the case rule (a name matches only an earlier key of another spelling)', () => {
    expect(loadAnswer(enc(mini('{"b": 1, "c": 2, "b": 3}')))).toBe(corrupt(PinsReason.KeysUnsorted, 'b'));
    expect(loadAnswer(enc(mini('{"b": 1, "b": 2}')))).toBe(corrupt(PinsReason.DuplicateKey, 'b'));
    // the first spelling is the pivot: [lower, upper, lower] names the second key, the third is never reached
    expect(loadAnswer(enc(mini('{"ab": 1, "AB": 2, "ab": 3}')))).toBe(corrupt(PinsReason.DuplicateKey, 'AB'));
  });

  it('the rule applies at every depth of a raw section and wherever the schema has no struct: the section, nested objects, array elements, wrongly typed fields', () => {
    // the raw section object itself (the order is the byte order: "Aa" < "aa", so [Aa, aa] is sorted)
    expect(loadAnswer(enc(mini('{"Aa": 1, "aa": 2}')))).toBe(corrupt(PinsReason.DuplicateKey, 'aa'));
    // nested three deep
    expect(loadAnswer(enc(mini('{"x": {"y": {"z": {"Kk": 1, "kK": 2}}}}')))).toBe(corrupt(PinsReason.DuplicateKey, 'kK'));
    // an object in an array of a raw section; document order [x, X] would also be unsorted: the case rule comes first
    expect(loadAnswer(enc(mini('{"list": [{"a": 1}, {"x": 1, "X": 2}]}')))).toBe(corrupt(PinsReason.DuplicateKey, 'X'));
    expect(loadAnswer(enc(mini('{"list": [[{"X": 1, "x": 2}]]}')))).toBe(corrupt(PinsReason.DuplicateKey, 'x'));
    // an object where the schema has a scalar (eth_sepolia.chain_id is a uint64 in Go): not a struct, the rule applies
    expect(loadAnswer(enc(mini('{"chain_id": {"a": 1, "A": 2}}', 'eth_sepolia')))).toBe(corrupt(PinsReason.DuplicateKey, 'A'));
    // an object where a struct has a list (forks): an element that is an array of objects is walked without a struct type
    expect(loadAnswer(enc(mini('{"forks": [[{"a": 1, "A": 2}]]}', 'eth_sepolia')))).toBe(corrupt(PinsReason.DuplicateKey, 'A'));
    // but the struct objects themselves keep exact names: a fork row with "Name" is unknown_key
    expect(loadAnswer(enc(mini('{"forks": [{"Name": "x"}]}', 'eth_sepolia')))).toBe(corrupt(PinsReason.UnknownKey, 'Name'));
  });

  it('folds that JavaScript case conversion gets wrong: Kelvin sign, long s, sharp s, final sigma, astral letters, escapes', () => {
    const cases: [string, string][] = [
      ['{"k": 1, "K": 2}', 'K'],
      ['{"s": 1, "ſ": 2}', 'ſ'],
      ['{"ß": 1, "ẞ": 2}', 'ẞ'],
      ['{"Σ": 1, "ς": 2}', 'ς'],
      ['{"σ": 1, "ς": 2}', 'ς'],
      ['{"\u{10400}": 1, "\u{10428}": 2}', '\u{10428}'],
      // escapes decode before the comparison: K is the Kelvin sign, a pair of escapes is an astral letter
      ['{"k": 1, "\\u212A": 2}', 'K'],
      ['{"A": 1, "\\u0061": 2}', 'a'],
      ['{"\\ud801\\udc00": 1, "\\ud801\\udc28": 2}', '\u{10428}'],
      // a lone surrogate escape is U+FFFD, equal to the escape of U+FFFD: an exact repeat, adjacent
      ['{"\\ud800": 1, "\\ufffd": 2}', '�'],
    ];
    for (const [section, named] of cases) expect(loadAnswer(enc(mini(section))), section).toBe(corrupt(PinsReason.DuplicateKey, named));
    // and what simple folding does NOT join stays distinct: dotted I and dotless i, one rune to one rune (sharp s against "ss")
    for (const section of ['{"i": 1, "İ": 2}', '{"I": 1, "ı": 2}', '{"SS": 1, "ß": 2}', '{"ss": 1, "ẞ": 2}']) {
      expect(loadAnswer(enc(mini(section))), section).toMatch(/^ok /);
    }
  });

  it('judges in document order: an earlier violation of another kind is named first, and a later case variant is never reached', () => {
    expect(loadAnswer(enc(mini('{"b": 1, "a": 2, "A": 3}')))).toBe(corrupt(PinsReason.KeysUnsorted, 'a'));
    expect(loadAnswer(enc(mini('{"a": 1, "A": 2, "0": 3}')))).toBe(corrupt(PinsReason.DuplicateKey, 'A'));
    // a case variant inside an earlier member beats a later unknown key of the file
    expect(loadAnswer(enc(`{\n  "arb_sepolia": {"a": 1, "A": 2},\n  "format": "certen-finality-pins/1",\n  "published_utc": "x",\n  "zz": 1\n}\n`))).toBe(
      corrupt(PinsReason.DuplicateKey, 'A'),
    );
  });
});

describe('item 7 (audit N-1): a number the walk reads and cannot convert to float64 is not_json, at the point it is read', () => {
  const huge = ['1e309', '1e1000', '-1e309', '1E+309', '2e308', '1e99999999999999999999', '1.797693134862315808e308', '0.1e310', '9'.repeat(400)];
  const fine = ['1e308', '1.7976931348623157e308', '1.7976931348623158e308', '-1e308', '1e-400', '1e-99999999999999999999', '0e999999', '-0', '0.000e5', '5e-324', '1e-324'];

  it('every literal outside the float64 range makes the file not_json, in a raw section, an array and a struct field', () => {
    for (const lit of huge) {
      expect(loadAnswer(enc(mini(`{"chain_id": ${lit}}`, 'adiri'))), lit).toBe(corrupt(PinsReason.NotJSON));
      expect(loadAnswer(enc(mini(`{"v": [1, ${lit}, 3]}`, 'adiri'))), lit).toBe(corrupt(PinsReason.NotJSON));
      expect(loadAnswer(enc(mini(`{"max_links": ${lit}}`, 'eth_sepolia'))), lit).toBe(corrupt(PinsReason.NotJSON));
      expect(overrideAnswer(enc(mini(`{"a": {"b": {"c": ${lit}}}}`, 'base_sepolia'))), lit).toBe(corrupt(PinsReason.NotJSON));
    }
  });

  it('the literals inside the range load (Go: json.Decoder.Token converts to float64, underflow to zero is not an error)', () => {
    for (const lit of fine) expect(loadAnswer(enc(mini(`{"chain_id": ${lit}}`, 'adiri'))), lit).toMatch(/^ok /);
  });

  it('is judged in document order: a violation before the number is named, a number before the violation is not_json', () => {
    // the key repeats before its value is read: the case rule wins
    expect(loadAnswer(enc(mini('{"A": 1, "a": 1e1000}')))).toBe(corrupt(PinsReason.DuplicateKey, 'a'));
    // the number is the value of the first key: it is read before the second key
    expect(loadAnswer(enc(mini('{"a": 1e1000, "A": 1}')))).toBe(corrupt(PinsReason.NotJSON));
    // an unknown key of a struct is named before its value is read
    expect(loadAnswer(enc('{\n  "format": "certen-finality-pins/1",\n  "published_utc": "x",\n  "zzz": 1e999\n}\n'))).toBe(corrupt(PinsReason.UnknownKey, 'zzz'));
    expect(loadAnswer(enc('{\n  "format": 1e999,\n  "published_utc": "x"\n}\n'))).toBe(corrupt(PinsReason.NotJSON));
    // the same number, once the keys before it are in order, in the order rule's reach
    expect(loadAnswer(enc(mini('{"b": 1, "a": 1e999}')))).toBe(corrupt(PinsReason.KeysUnsorted, 'a'));
  });

  it('an extension file with such a number is finality_pins_corrupt{not_json}, as in Go (Extend parses the candidate first), not non_ledger_content_differs', () => {
    const base = embeddedPins();
    for (const lit of ['1e1000', '1e309']) {
      const raw = enc(embeddedText().replace('"adiri": {', `"adiri": {\n    "aaa": ${lit},`));
      let got: unknown;
      try {
        extendPins(base, raw, embeddedLedgerLinks());
      } catch (e) {
        got = e;
      }
      expect(got).toBeInstanceOf(FinalityStateError);
      expect((got as FinalityStateError).canonical(), lit).toBe(corrupt(PinsReason.NotJSON));
      expect(() => parsePinsExtension(raw)).toThrow(FinalityStateError);
    }
    // the same file with a number in range is a file that parses and differs outside the ledger
    const ok = enc(embeddedText().replace('"adiri": {', '"adiri": {\n    "aaa": 1e308,'));
    expect(() => extendPins(base, ok, embeddedLedgerLinks())).toThrowError(
      expect.objectContaining({ code: 'finality_ledger_extension_invalid', fields: expect.objectContaining({ reason: LedgerReason.NonLedgerContentDiffers }) }),
    );
  });
});

/** A document nested `d` containers deep as the value of the first member of the adiri section: d + 2 containers are open at the deepest point. */
const nestedArrays = (d: number): string => '['.repeat(d) + ']'.repeat(d);
const nestedObjects = (d: number): string => '{"a":'.repeat(d) + '1' + '}'.repeat(d);
const insideAdiri = (nested: string): Uint8Array => enc(embeddedText().replace('"adiri": {', `"adiri": {\n    "aaa": ${nested},`));

describe('item 8 (audit N-2): the depth of a file is Go\'s json.Valid limit, 10,000 containers open at once, and nothing recurses', () => {
  it('arrays and objects in a raw section: d = 9,998 (10,000 containers open) loads, d = 9,999 and beyond is not_json, like Go', () => {
    for (const make of [nestedArrays, nestedObjects]) {
      for (const d of [1, 4000, 6000, 9000, 9997, 9998]) expect(overrideAnswer(insideAdiri(make(d))), `${make.name} ${d}`).toMatch(/^ok /);
      for (const d of [9999, 10000, 10001, 20000]) expect(overrideAnswer(insideAdiri(make(d))), `${make.name} ${d}`).toBe(corrupt(PinsReason.NotJSON));
    }
  });

  it('a value of the wrong type nested at the limit, in a struct field, a list element and the root, is bad_value at the limit and not_json past it', () => {
    const at = (field: string, nested: string): Uint8Array => enc(mini(`{"${field}": ${nested}}`, 'eth_sepolia'));
    for (const make of [nestedArrays, nestedObjects]) {
      // 3 containers are open outside the nested value (root, section, none for the field): d + 2 in total
      for (const d of [4000, 9000, 9998]) {
        expect(overrideAnswer(at('chain_id', make(d))), `${make.name} ${d}`).toBe(corrupt(PinsReason.BadValue));
        // an array in the place of a fork row; an object there would be walked as a fork and refused as an unknown key first
        if (make === nestedArrays) expect(overrideAnswer(at('forks', `[${make(d - 1)}]`)), `${make.name} ${d}`).toBe(corrupt(PinsReason.BadValue));
      }
      for (const d of [9999, 10001]) expect(overrideAnswer(at('chain_id', make(d))), `${make.name} ${d}`).toBe(corrupt(PinsReason.NotJSON));
    }
    // a document that is itself an array: no struct to read it into
    for (const d of [4000, 9000, 10000]) expect(overrideAnswer(enc(nestedArrays(d))), `root ${d}`).toBe(corrupt(PinsReason.BadValue));
    expect(overrideAnswer(enc(nestedArrays(10001)))).toBe(corrupt(PinsReason.NotJSON));
  });

  it('every consumer of a parsed raw section answers a deep value with a named state: no input ends in an unnamed exception', () => {
    const deep = (d: number, kind: 'a' | 'o'): JVal => {
      let v: JVal = kind === 'a' ? [] : new JObj([]);
      for (let i = 1; i < d; i++) v = kind === 'a' ? [v] : new JObj([['a', v]]);
      return v;
    };
    const loaders: [string, string, (p: Pins) => unknown][] = [
      ['arb_sepolia', 'arbfinal', loadArbFinalPins],
      ['arb_sepolia', 'arbposted', loadArbPins],
      ['base_sepolia', 'basefinal', parseBaseFinalPins],
      ['base_sepolia', 'baseposted', parseBasePostedPins],
      ['adiri', 'adiri', parseAdiriPins],
    ];
    const emb = embeddedPins();
    // every location of the embedded section (object member, array element, scalar) replaced by a value nested 9,990 deep
    const paths = (v: JVal, here: (string | number)[] = []): (string | number)[][] => {
      const out: (string | number)[][] = [here];
      if (v instanceof JObj) v.pairs.forEach(([k, x]) => out.push(...paths(x, [...here, k])));
      else if (Array.isArray(v)) v.slice(0, 3).forEach((x, i) => out.push(...paths(x, [...here, i])));
      return out;
    };
    const replaced = (v: JVal, path: (string | number)[], by: JVal): JVal => {
      if (path.length === 0) return by;
      const [h, ...rest] = path as [string | number, ...(string | number)[]];
      if (v instanceof JObj) return new JObj(v.pairs.map(([k, x]) => [k, k === h ? replaced(x, rest, by) : x] as [string, JVal]));
      if (Array.isArray(v)) return v.map((x, i) => (i === h ? replaced(x, rest, by) : x));
      return v;
    };
    let runs = 0;
    for (const [section, name, load] of loaders) {
      const sec = emb.sections.get(section)!;
      for (const p of paths(sec)) {
        for (const kind of ['a', 'o'] as const) {
          const q: Pins = { ...emb, sections: new Map(emb.sections).set(section, replaced(sec, p, deep(9990, kind))) };
          try {
            load(q);
          } catch (e) {
            if (!(e instanceof FinalityStateError)) throw new Error(`${name} at ${JSON.stringify(p)} (${kind}): ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`);
          }
          runs++;
        }
      }
    }
    expect(runs).toBeGreaterThan(300);
  });

  it('an extension file nested to the limit is compared without recursion: equal files extend, differing files are non_ledger_content_differs', () => {
    const raw = insideAdiri(nestedArrays(9990));
    const p = parsePinsOverride(raw);
    expect(p.ethSepolia).not.toBeNull();
    // the same bytes: equal outside the ledger, same anchors: the file extends itself
    const same = extendPins(p, raw, embeddedLedgerLinks());
    expect(same.source.startsWith('extension:')).toBe(true);
    // objects nested alike are equal, a leaf that differs at the bottom is not
    const deepObj = (leaf: string): Uint8Array => insideAdiri(nestedObjects(9990).replace('1', leaf));
    expect(nonLedgerEqual(deepObj('1'), deepObj('1'))).toBe(true);
    expect(nonLedgerEqual(deepObj('1'), deepObj('2'))).toBe(false);
    expect(nonLedgerEqual(raw, enc(embeddedText()))).toBe(false);
    expect(() => extendPins(embeddedPins(), raw, embeddedLedgerLinks())).toThrowError(
      expect.objectContaining({ code: 'finality_ledger_extension_invalid', fields: expect.objectContaining({ reason: LedgerReason.NonLedgerContentDiffers }) }),
    );
  });
});

describe('hostile inputs to the walk', () => {
  it('300,000 members, a million array elements and a 4 MiB key are walked once and answered', () => {
    const keys: string[] = [];
    for (let i = 0; i < 300000; i++) keys.push(`"k${String(i).padStart(7, '0')}": 0`);
    expect(loadAnswer(enc(mini(`{${keys.join(', ')}}`, 'adiri')))).toMatch(/^ok /);
    // a case variant of the FIRST key at the very end of 300,000 distinct keys is named (the case rule is judged before the order rule it also breaks)
    expect(loadAnswer(enc(mini(`{${[...keys, '"K0000000": 0'].join(', ')}}`, 'adiri')))).toBe(corrupt(PinsReason.DuplicateKey, 'K0000000'));
    // and in front of them, the later spelling is the one named
    expect(loadAnswer(enc(mini(`{${['"K0000000": 0', ...keys].join(', ')}}`, 'adiri')))).toBe(corrupt(PinsReason.DuplicateKey, 'k0000000'));
    expect(loadAnswer(enc(mini(`{"v": [${'0,'.repeat(1_000_000)}0]}`, 'adiri')))).toMatch(/^ok /);
    const huge = 'ab'.repeat(2 << 20);
    expect(loadAnswer(enc(mini(`{"${huge.toUpperCase()}": 1, "${huge}": 2}`, 'adiri')))).toBe(corrupt(PinsReason.DuplicateKey, huge));
  });

  it('a file with many case variants of one name names only the first repeat, and does not keep a list of them', () => {
    const spellings: string[] = [];
    for (let i = 0; i < 64; i++) spellings.push(`0x${[...'abcdef'].map((c, j) => (i & (1 << j) ? c.toUpperCase() : c)).join('')}`);
    const unique = [...new Set(spellings)];
    expect(unique.length).toBe(64);
    const raw = enc(mini(`{${unique.sort().map((k) => `"${k}": 1`).join(', ')}}`));
    const first = unique.slice().sort()[1]!;
    expect(loadAnswer(raw)).toBe(corrupt(PinsReason.DuplicateKey, first));
  });

  it('JSON that is not a document the walk can read is not_json before any key is judged; invalid UTF-8 and the BOM keep their own states', () => {
    for (const text of ['', ' ', '{', '[1,', '{"a": }', '{"a": 1,}', '[01]', '{"a": 1.}', '{"a": "\u0001"}', '{"a": 1} {}', 'nul']) {
      expect(loadAnswer(enc(text)), JSON.stringify(text)).toBe(corrupt(PinsReason.NotJSON));
    }
    expect(loadAnswer(Uint8Array.of(0x7b, 0xff, 0x7d))).toBe(corrupt(PinsReason.NotUTF8));
    expect(loadAnswer(enc('﻿{}'))).toBe(corrupt(PinsReason.ByteOrderMark));
    expect(loadAnswer(enc('{}\r\n'))).toBe(corrupt(PinsReason.ContainsCR));
  });
});

describe('the real valid file', () => {
  it('loads in a small fraction of a second: the walk is one pass (a generous bound, a regression of the order of magnitude is what it catches)', () => {
    embeddedPins(); // warm
    const t0 = performance.now();
    for (let i = 0; i < 100; i++) embeddedPins();
    const perLoad = (performance.now() - t0) / 100;
    expect(perLoad).toBeLessThan(250);
    // and the same file with one member of the adiri section repeated in another letter case is refused (duplicate_key) in the same single pass
    const text = embeddedText().replace('"adiri": {', '"adiri": {\n    "Chain_ID": 1,');
    const t1 = performance.now();
    for (let i = 0; i < 100; i++) overrideAnswer(enc(text));
    expect((performance.now() - t1) / 100).toBeLessThan(250);
  });
});

describe('what the number rule does not touch', () => {
  it('the typed decode still reads integers from their literals (a u64 above 2^63 loads in a raw section, an overflowing one in a struct field is bad_value)', () => {
    expect(loadAnswer(enc(mini('{"chain_id": 18446744073709551615}', 'adiri')))).toMatch(/^ok /);
    expect(loadAnswer(enc(mini('{"chain_id": 18446744073709551616}', 'eth_sepolia')))).toBe(corrupt(PinsReason.BadValue));
    expect(loadAnswer(enc(mini('{"chain_id": 1.5}', 'eth_sepolia')))).toBe(corrupt(PinsReason.BadValue));
  });
});
