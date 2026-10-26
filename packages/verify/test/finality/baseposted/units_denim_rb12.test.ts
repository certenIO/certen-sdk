/**
 * The post-Denim lookup and the post_denim pins row (the twin of validator baseposted/denim_rb12_test.go, pv2/rb12-eps-denim@c05fe30d): from denim_time
 * five blocks share a timestamp second, so a batch is selected by timestamp AND its full 32-byte parent hash; a span batch at the second is never taken.
 */
import { describe, expect, it } from 'vitest';
import { denimGate, selectBatch } from '../../../src/proof-v2/finality/baseposted/verify.js';
import { parseBasePins, type BasePins } from '../../../src/proof-v2/finality/baseposted/pins.js';
import type { Batch } from '../../../src/proof-v2/finality/baseposted/span.js';
import { embeddedPinsBytes, parsePinsOverride } from '../../../src/proof-v2/finality/pins.js';
import { FinalityStateError } from '../../../src/proof-v2/finality/state.js';

type Section = Record<string, unknown>;
const embedded = (): { base_sepolia: Section } => JSON.parse(Buffer.from(embeddedPinsBytes()).toString('utf8')) as { base_sepolia: Section };
const parsed = (edit: (s: Section) => void): BasePins => {
  const doc = embedded();
  edit(doc.base_sepolia);
  return parseBasePins(parsePinsOverride(new TextEncoder().encode(JSON.stringify(doc, null, 2))));
};
const stateOf = (f: () => unknown): string => {
  try {
    f();
  } catch (e) {
    if (e instanceof FinalityStateError) return e.canonical();
    throw e;
  }
  return 'ok';
};
const row = (): Record<string, unknown> => ({ ...(embedded().base_sepolia.post_denim as Record<string, unknown>) });
const CORRUPT = '{"code":"finality_pins_corrupt","fields":{"key":"base_sepolia.post_denim","reason":"bad_value"}}';

describe('the post_denim capability row', () => {
  it('the embedded pins carry it: singular batches only, 200 ms blocks, five per second', () => {
    const p = parsed(() => {});
    expect(p.postDenim).not.toBeNull();
    expect(p.postDenim!.batchTypes).toEqual([0]);
    expect([p.postDenim!.blockIntervalMs, p.postDenim!.blocksPerSecond]).toEqual([200n, 5n]);
    expect(p.postDenim!.baseTimePredeploy.length).toBe(20);
    expect(p.postDenim!.baseTimeSelector.length).toBe(4);
  });
  it('an absent row is no capability (fail closed), not an error', () => {
    expect(parsed((s) => delete s.post_denim).postDenim).toBeNull();
  });
  const bad: [string, (r: Record<string, unknown>) => unknown][] = [
    ['null', () => null],
    ['not an object', () => 'x'],
    ['an unknown key', (r) => ({ ...r, extra: 1 })],
    ['a span batch type', (r) => ({ ...r, batch_types: [0, 1] })],
    ['only the span type', (r) => ({ ...r, batch_types: [1] })],
    ['no batch type', (r) => ({ ...r, batch_types: [] })],
    ['an interval that does not make one second', (r) => ({ ...r, block_interval_ms: 200, blocks_per_second: 4 })],
    ['a zero interval', (r) => ({ ...r, block_interval_ms: 0 })],
    ['an interval above one second', (r) => ({ ...r, block_interval_ms: 2000, blocks_per_second: 1 })],
    ['an upper-case selector', (r) => ({ ...r, base_time_selector: '0x' + String(r.base_time_selector).slice(2).toUpperCase() })],
    ['a short predeploy', (r) => ({ ...r, base_time_predeploy: '0x1234' })],
    ['a selector of the wrong size', (r) => ({ ...r, base_time_selector: '0x12345678aa' })],
  ];
  for (const [name, mut] of bad) {
    it(`${name} is finality_pins_corrupt{bad_value, base_sepolia.post_denim}`, () => {
      expect(stateOf(() => parsed((s) => (s.post_denim = mut(row()))))).toBe(CORRUPT);
    });
  }
});

describe('denimGate', () => {
  it('a block at or after denim_time is post_denim without the row, and judged with it', () => {
    const without = parsed((s) => delete s.post_denim);
    const withRow = parsed(() => {});
    expect(stateOf(() => denimGate(without, without.denimTime))).toBe('{"code":"batch_format_unsupported","fields":{"type":"post_denim"}}');
    expect(stateOf(() => denimGate(without, without.denimTime - 1n))).toBe('ok');
    expect(stateOf(() => denimGate(withRow, withRow.denimTime + 1n))).toBe('ok');
  });
});

const hashOf = (n: number): Uint8Array => new Uint8Array(32).fill(n);
const batch = (ts: bigint, parent: number, over: Partial<Batch> = {}): Batch => ({
  type: 0, parentHash: hashOf(parent), parentLen: 32, epochNum: 1n, epochHash: hashOf(9), epochLen: 32, timestamp: ts, txs: [], spanIndex: 0, spanBlocks: 1, ...over,
});

describe('selectBatch', () => {
  const bp = parsed(() => {});
  const t = bp.denimTime + 1000n;
  const second = (): Batch[] => [1, 2, 3, 4, 5].map((n) => batch(t, n));
  it('before denim_time the first batch with the timestamp is taken, as published', () => {
    const early = bp.denimTime - 10n;
    const bs = [batch(early, 7), batch(early, 8)];
    expect(selectBatch(bp, bs, { timestamp: early, parentHash: hashOf(8) })).toBe(bs[0]);
    expect(stateOf(() => selectBatch(bp, bs, { timestamp: early + 2n, parentHash: hashOf(8) }))).toBe(
      '{"code":"batch_not_found","fields":{"n_batches":"2","timestamp":"' + (early + 2n).toString() + '"}}',
    );
  });
  it('from denim_time the block is the batch of its second whose parent hash is the full parent of the block', () => {
    const bs = second();
    for (let i = 0; i < 5; i++) expect(selectBatch(bp, bs, { timestamp: t, parentHash: hashOf(i + 1) })).toBe(bs[i]);
  });
  it('a block of the second whose parent no batch commits is batch_binding_mismatch{parent_hash}', () => {
    expect(stateOf(() => selectBatch(bp, second(), { timestamp: t, parentHash: hashOf(99) }))).toBe(
      '{"code":"batch_binding_mismatch","fields":{"field":"parent_hash"}}',
    );
  });
  it('a parent prefix is not a parent: a batch that commits fewer than 32 bytes of it is not taken', () => {
    const bs = [batch(t, 1, { parentLen: 16 })];
    expect(stateOf(() => selectBatch(bp, bs, { timestamp: t, parentHash: hashOf(1) }))).toBe(
      '{"code":"batch_binding_mismatch","fields":{"field":"parent_hash"}}',
    );
  });
  it('a span batch at the second is never taken: span_post_denim, unless a singular batch has the parent', () => {
    const span = batch(t, 1, { type: 1, spanBlocks: 5 });
    expect(stateOf(() => selectBatch(bp, [span, batch(t, 2)], { timestamp: t, parentHash: hashOf(1) }))).toBe(
      '{"code":"batch_format_unsupported","fields":{"type":"span_post_denim"}}',
    );
    const single = batch(t, 1);
    expect(selectBatch(bp, [span, single], { timestamp: t, parentHash: hashOf(1) })).toBe(single);
  });
  it('no batch of the second is batch_not_found with the number of batches', () => {
    expect(stateOf(() => selectBatch(bp, second(), { timestamp: t + 1n, parentHash: hashOf(1) }))).toBe(
      '{"code":"batch_not_found","fields":{"n_batches":"5","timestamp":"' + (t + 1n).toString() + '"}}',
    );
  });
  it('without the row a Denim second is post_denim, not a lookup', () => {
    const without = parsed((s) => delete s.post_denim);
    expect(stateOf(() => selectBatch(without, second(), { timestamp: t, parentHash: hashOf(1) }))).toBe('{"code":"batch_format_unsupported","fields":{"type":"post_denim"}}');
  });
});
