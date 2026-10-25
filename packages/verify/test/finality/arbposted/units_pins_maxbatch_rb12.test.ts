/**
 * max_uncompressed_batch is bounded by Nitro's limit and the zero-heavy cap never wraps (RB12-ARBFINAL-FIX, BETA audit G5; the twin of
 * pins_max_batch_rb12_test.go). A pins file may not name a bound above 16 MiB = 16,777,216: a larger bound makes the verifier accept batches Nitro
 * refuses. The cap of the zero-heavy layer, max + max/100 + 64, saturates at the largest int64.
 */
import { describe, expect, it } from 'vitest';
import { parsePinsOverride, type Pins } from '../../../src/proof-v2/finality/pins.js';
import { MAX_UNCOMPRESSED_BATCH_LIMIT, loadArbPins } from '../../../src/proof-v2/finality/arbposted/pins.js';
import { HEADER_ZEROHEAVY, PayloadTooLarge, PayloadUndecodable, decodePayload, zeroheavyLimit } from '../../../src/proof-v2/finality/arbposted/nitro.js';
import { embeddedPinsBytes } from '../../../src/proof-v2/finality/pins.js';
import { FinalityStateError } from '../../../src/proof-v2/finality/state.js';
import { read } from './vectorset.js';

/** JSON with sorted keys at every level, 2-space indent, LF: the form the pins loader requires (as units_pins.test.ts). */
function stable(v: unknown, ind = ''): string {
  if (Array.isArray(v)) return v.length === 0 ? '[]' : `[\n${v.map((x) => `${ind}  ${stable(x, ind + '  ')}`).join(',\n')}\n${ind}]`;
  if (v !== null && typeof v === 'object') {
    const ks = Object.keys(v as object).sort();
    return ks.length === 0 ? '{}' : `{\n${ks.map((k) => `${ind}  ${JSON.stringify(k)}: ${stable((v as Record<string, unknown>)[k], ind + '  ')}`).join(',\n')}\n${ind}}`;
  }
  return JSON.stringify(v);
}

/** The pins of the arb set with max_uncompressed_batch written as the given raw JSON literal (it may not fit a JavaScript number). */
const MARK = '@@MAX@@';
function withMax(literal: string, extra?: Record<string, unknown>): Pins {
  const doc = JSON.parse(read('pins/main.json').toString('utf8'));
  doc.arb_sepolia.max_uncompressed_batch = MARK;
  Object.assign(doc.arb_sepolia, extra ?? {});
  const text = `${stable(doc)}\n`.replace(`"${MARK}"`, () => literal);
  return parsePinsOverride(new TextEncoder().encode(text));
}
const canon = (f: () => unknown): string => {
  try {
    f();
  } catch (e) {
    if (e instanceof FinalityStateError) return e.canonical();
    throw e;
  }
  return 'accepted';
};

/** The canonical text of the refusal, written out here and not built by the constructor under test. */
const WANT_CORRUPT = '{"code":"finality_pins_corrupt","fields":{"key":"arb_sepolia.max_uncompressed_batch","reason":"bad_value"}}';
const WANT_SECTION = '{"code":"pin_mismatch","fields":{"field":"section"}}';
const WANT_MAX = '{"code":"pin_mismatch","fields":{"field":"max_uncompressed_batch"}}';

describe('max_uncompressed_batch is bounded by Nitro\'s limit', () => {
  it('the shipped pin is 16777216 and is the limit', () => {
    const shipped = JSON.parse(Buffer.from(embeddedPinsBytes()).toString('utf8')) as { arb_sepolia: { max_uncompressed_batch: number } };
    expect(shipped.arb_sepolia.max_uncompressed_batch).toBe(16777216);
    expect(MAX_UNCOMPRESSED_BATCH_LIMIT).toBe(16777216);
  });

  it.each(['1', '1000', '16777215', '16777216'])('%s is accepted (N passes)', (v) => {
    expect(loadArbPins(withMax(v)).maxUncompressedBatch).toBe(Number(v));
  });

  it.each([
    '16777217', // limit + 1: N+1 fails
    '16777218', '33554432', '2147483647', '2147483648', '4294967296', // 2^31 - 1, 2^31, 2^32
    '9007199254740991', '9007199254740992', '9007199254740993', // 2^53 - 1, 2^53, 2^53 + 1
    '9223372036854775806', '9223372036854775807', // MaxInt64 - 1, MaxInt64
    '9223372036854775808', // MaxInt64 + 1: does not fit an int64
    '18446744073709551615', // MaxUint64
    '18446744073709551616', // MaxUint64 + 1
    '100000000000000000000000000000000000000',
  ])('%s is finality_pins_corrupt{bad_value, key arb_sepolia.max_uncompressed_batch}', (v) => {
    expect(canon(() => loadArbPins(withMax(v)))).toBe(WANT_CORRUPT);
  });

  it('a section that does not decode for another reason is "the section does not parse", unless its bound is an integer beyond the limit', () => {
    const unknownKey = { a_key_the_section_does_not_know: 1 };
    expect(canon(() => loadArbPins(withMax('16777216', unknownKey)))).toBe(WANT_SECTION);
    expect(canon(() => loadArbPins(withMax('16777217', unknownKey)))).toBe(WANT_CORRUPT);
    expect(canon(() => loadArbPins(withMax('9223372036854775808', unknownKey)))).toBe(WANT_CORRUPT);
    expect(canon(() => loadArbPins(withMax('-9223372036854775809', unknownKey)))).toBe(WANT_SECTION);
    expect(canon(() => loadArbPins(withMax('1.5', unknownKey)))).toBe(WANT_SECTION);
  });

  it('the lower bound and the type judgements are as before', () => {
    const want: Record<string, string> = { '0': WANT_MAX, '-1': WANT_MAX, '-9223372036854775808': WANT_MAX, '1.5': WANT_SECTION, '"16777216"': WANT_SECTION, '1e3': WANT_SECTION, '1E3': WANT_SECTION };
    for (const [v, w] of Object.entries(want)) expect(canon(() => loadArbPins(withMax(v))), v).toBe(w);
    // a literal beyond int64 on the negative side does not decode, and is not beyond the limit
    expect(canon(() => loadArbPins(withMax('-9223372036854775809')))).toBe(WANT_SECTION);
  });
});

describe('the zero-heavy cap is 101% of the bound plus 64 and never wraps', () => {
  const INT_MAX = (1n << 63n) - 1n;
  const INT_MIN = -(1n << 63n);

  it('is exact where it fits (values written out)', () => {
    expect(zeroheavyLimit(0n)).toBe(64n);
    expect(zeroheavyLimit(1n)).toBe(65n);
    expect(zeroheavyLimit(100n)).toBe(165n);
    expect(zeroheavyLimit(101n)).toBe(166n);
    expect(zeroheavyLimit(999n)).toBe(1072n);
    expect(zeroheavyLimit(16777216n)).toBe(16945052n);
    expect(zeroheavyLimit(1n << 40n)).toBe((1n << 40n) + (1n << 40n) / 100n + 64n);
    // negative bounds truncate toward zero, as Go's division does
    expect(zeroheavyLimit(-1n)).toBe(63n);
    expect(zeroheavyLimit(-64n)).toBe(0n);
    expect(zeroheavyLimit(-6400n)).toBe(-6400n);
  });

  it('saturates at the largest int64 from the first bound whose cap does not fit, and at the smallest below', () => {
    let lo = 1n;
    let hi = INT_MAX;
    while (lo < hi) {
      const mid = lo + (hi - lo) / 2n;
      if (mid + mid / 100n + 64n <= INT_MAX) lo = mid + 1n;
      else hi = mid;
    }
    const edge = lo;
    for (const m of [edge - 3n, edge - 2n, edge - 1n]) expect(zeroheavyLimit(m), `${m}`).toBe(m + m / 100n + 64n);
    for (const m of [edge, edge + 1n, edge + 2n, INT_MAX - 64n, INT_MAX - 1n, INT_MAX]) expect(zeroheavyLimit(m), `${m}`).toBe(INT_MAX);
    for (const m of [INT_MIN, INT_MIN + 1n, (INT_MIN / 100n) * 99n]) expect(zeroheavyLimit(m) >= INT_MIN, `${m}`).toBe(true);
    expect(zeroheavyLimit(INT_MIN)).toBe(INT_MIN);
    for (const m of [1n, 36n, 100n, 1n << 40n, edge - 1n, edge, INT_MAX]) expect(zeroheavyLimit(m) >= m, `${m} wrapped`).toBe(true);
  });

  it('through decodePayload: a zero-heavy payload with nothing after the header is undecodable under the largest bounds, not too large', () => {
    const empty = Uint8Array.of(HEADER_ZEROHEAVY);
    for (const huge of [1 << 30, 2 ** 40, 2 ** 53 - 1, 2 ** 53, 2 ** 62, 2 ** 63]) {
      const r = decodePayload(empty, huge, 100);
      expect(r.status, `${huge}`).toBe(PayloadUndecodable);
      expect(r.exceededUncompressed, `${huge}`).toBe(false);
    }
    expect(PayloadTooLarge).not.toBe(PayloadUndecodable);
  });
});
