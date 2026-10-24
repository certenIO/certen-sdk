/**
 * RB12-TS-TWINS-2 (TSB-2): the judge-world loader refuses a world it cannot read by name, with the SAME error text as the Go loader
 * (pkg/finality/basefinal judgevec.go JudgeLoadError at pv2/rb12-judgevec-parse@795702f7). BigInt(x) read "" as 0, "0x10" as 16 and
 * " 5 " as 5, and Number(BigInt(2^32+1)) kept 4294967297 as an output-root index; none of them is a decimal of its width.
 */
import { describe, expect, it } from 'vitest';
import { JudgeLoadError, expectedOf, judgeNames, judgeWorld, loadDecimal, loadHex, loadJudge, runJudge, type JudgeCase } from './vectorset.js';

const U64_MAX = '18446744073709551615';
const base = (): JudgeCase => structuredClone(loadJudge('synth_19_intermediate_roots'));

function load(c: JudgeCase): JudgeLoadError {
  try {
    judgeWorld(c);
  } catch (e) {
    expect(e).toBeInstanceOf(JudgeLoadError);
    return e as JudgeLoadError;
  }
  throw new Error('the world loaded');
}

const dec: { field: string; set: (c: JudgeCase, v: string) => void; bad: string[]; ok: string[]; bits: number }[] = [
  { field: 'a.number', set: (c, v) => (c.a.number = v), bad: ['abc', '', '-1', '+5', '0x10', ' 5', '5 ', '1_0', '18446744073709551616'], ok: ['0', '007', U64_MAX], bits: 64 },
  { field: 'a.timestamp', set: (c, v) => (c.a.timestamp = v), bad: ['abc', '', '-1', '18446744073709551616'], ok: ['0', U64_MAX], bits: 64 },
  { field: 'leg.number', set: (c, v) => (c.leg.number = v), bad: ['abc', '', '18446744073709551616'], ok: [U64_MAX], bits: 64 },
  { field: 'leg.chain', set: (c, v) => (c.leg.chain = v), bad: ['abc', '', '18446744073709551616'], ok: [U64_MAX], bits: 64 },
  { field: 'output_root_index', set: (c, v) => (c.output_root_index = v), bad: ['4294967296', '4294967297', U64_MAX, 'abc', '', '-1', '0x1'], ok: ['0', '4294967295'], bits: 32 },
];

describe('the judge-world loader reads a number as a decimal of its width or refuses it by name', () => {
  for (const d of dec) {
    for (const v of d.bad) {
      it(`${d.field}=${JSON.stringify(v)} is a JudgeLoadError naming the field and the value`, () => {
        const c = base();
        d.set(c, v);
        const e = load(c);
        expect(e.field).toBe(d.field);
        expect(e.value).toBe(v);
        expect(e.message).toBe(`judge case load error: field ${d.field}: value ${JSON.stringify(v)} is not a decimal uint${d.bits}`);
      });
    }
    for (const v of d.ok) {
      it(`${d.field}=${v} loads (the boundary itself)`, () => {
        const c = base();
        d.set(c, v);
        expect(() => judgeWorld(c)).not.toThrow();
      });
    }
  }
  it('output_root_index 2^32-1 reaches the body as 4294967295, not 0 and not wrapped', () => {
    const c = base();
    c.output_root_index = '4294967295';
    expect(judgeWorld(c).body.outputRootIndex).toBe(4294967295);
  });
});

describe('the judge-world loader reads bytes as lower-case hex of the right length or refuses them by name', () => {
  const h32 = base().a.hash;
  const cases: { field: string; set: (c: JudgeCase, v: string) => void; bad: string[]; want: string }[] = [
    { field: 'a.hash', set: (c, v) => (c.a.hash = v), bad: ['0xzz', h32.slice(0, -1), h32.slice(0, -2), h32.slice(0, 2) + h32.slice(2).toUpperCase(), `0x${'ab'.repeat(33)}`, ''], want: 'lower-case hex of 32 bytes' },
    { field: 'a.state_root', set: (c, v) => (c.a.state_root = v), bad: ['0xzz', '0x', `0x${'ab'.repeat(31)}`], want: 'lower-case hex of 32 bytes' },
    { field: 'leg.hash', set: (c, v) => (c.leg.hash = v), bad: ['0xzz', `0x${'ab'.repeat(31)}`], want: 'lower-case hex of 32 bytes' },
    { field: 'leg.header', set: (c, v) => (c.leg.header = v), bad: ['0xz', '0xabc'], want: 'lower-case hex' },
    { field: 'game_proxy', set: (c, v) => (c.game_proxy = v), bad: ['0xzz', `0x${'ab'.repeat(19)}`, `0x${'ab'.repeat(21)}`], want: 'lower-case hex of 20 bytes' },
    { field: 'game_code', set: (c, v) => (c.game_code = v), bad: ['0xzz', '0xabc'], want: 'lower-case hex' },
    { field: 'l2_spine[0]', set: (c, v) => (c.l2_spine = [v]), bad: ['0xzz'], want: 'lower-case hex' },
    { field: 'nodes[1]', set: (c, v) => (c.nodes = ['0x', v]), bad: ['0xzz'], want: 'lower-case hex' },
  ];
  for (const k of cases) {
    for (const v of k.bad) {
      it(`${k.field}=${JSON.stringify(v.length > 40 ? `${v.slice(0, 12)}...(${v.length})` : v)} is a JudgeLoadError`, () => {
        const c = base();
        k.set(c, v);
        const e = load(c);
        expect(e.field).toBe(k.field);
        expect(e.value).toBe(v);
        expect(e.message).toBe(`judge case load error: field ${k.field}: value ${JSON.stringify(v)} is not ${k.want}`);
      });
    }
  }
  it('a bare (un-prefixed) 32-byte hash is still read', () => {
    const c = base();
    c.a.hash = c.a.hash.replace(/^0x/, '');
    expect(() => judgeWorld(c)).not.toThrow();
  });
});

describe('loadHex and loadDecimal at their own boundaries', () => {
  it('a fixed size of 0 bytes is a size: only the empty string loads', () => {
    expect(loadHex('x', '0x', 0).length).toBe(0);
    expect(loadHex('x', '', 0).length).toBe(0);
    const e = (() => {
      try {
        loadHex('x', '0x01', 0);
      } catch (err) {
        return err as JudgeLoadError;
      }
      throw new Error('loaded');
    })();
    expect(e.message).toBe('judge case load error: field x: value "0x01" is not lower-case hex of 0 bytes');
  });
  it('loadDecimal: 2^32-1 loads as 32 bits and 2^32 does not; 2^64-1 loads as 64 bits and 2^64 does not', () => {
    expect(loadDecimal('x', '4294967295', 32)).toBe(4294967295n);
    expect(() => loadDecimal('x', '4294967296', 32)).toThrow(JudgeLoadError);
    expect(loadDecimal('x', U64_MAX, 64)).toBe(18446744073709551615n);
    expect(() => loadDecimal('x', '18446744073709551616', 64)).toThrow(JudgeLoadError);
  });
});

describe('every published judge case loads and keeps its Go verdict under the strict loader', () => {
  it('all judge cases of base_final1', () => {
    for (const id of judgeNames()) {
      const c = loadJudge(id);
      expect(runJudge(c), id).toBe(expectedOf(c));
    }
  });
});
