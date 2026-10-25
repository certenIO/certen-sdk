/**
 * go-ethereum types.Receipt.UnmarshalBinary semantics (core/types/receipt.go at v1.17.7): legacy and typed (1, 2, 3, 4) receipts decode; every input
 * geth refuses is refused here. The receipts are encoded by hand with a small RLP encoder, independently of src/.
 */
import { describe, expect, it } from 'vitest';
import { hexLower } from '../../../src/proof-v2/finality/state.js';
import { load, readIn } from './vectorset.js';

const cat = (...p: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(p.reduce((n, x) => n + x.length, 0));
  let o = 0;
  for (const x of p) {
    out.set(x, o);
    o += x.length;
  }
  return out;
};
const lenHead = (base: number, n: number): Uint8Array => {
  if (n < 56) return Uint8Array.of(base + n);
  const b: number[] = [];
  for (let v = n; v > 0; v = Math.floor(v / 256)) b.unshift(v % 256);
  return Uint8Array.of(base + 55 + b.length, ...b);
};
const rb = (b: Uint8Array): Uint8Array => (b.length === 1 && b[0]! < 0x80 ? Uint8Array.from(b) : cat(lenHead(0x80, b.length), b));
const rl = (...items: Uint8Array[]): Uint8Array => {
  const body = cat(...items);
  return cat(lenHead(0xc0, body.length), body);
};
const ru = (n: bigint): Uint8Array => {
  const b: number[] = [];
  for (let v = n; v > 0n; v >>= 8n) b.unshift(Number(v & 0xffn));
  return rb(Uint8Array.from(b));
};
const fill = (n: number, v: number): Uint8Array => new Uint8Array(n).fill(v);

const OK_STATUS = Uint8Array.of(0x01);
const log = (addr: Uint8Array, topics: Uint8Array[], d: Uint8Array): Uint8Array => rl(rb(addr), rl(...topics.map(rb)), rb(d));
const body = (status: Uint8Array, gas: Uint8Array, bloom: Uint8Array, logs: Uint8Array): Uint8Array => rl(status, gas, bloom, logs);
const goodLog = (): Uint8Array => log(fill(20, 0x11), [fill(32, 0x22), fill(32, 0x33)], fill(5, 0x44));
const good = (): Uint8Array => body(OK_STATUS, ru(21000n), rb(fill(256, 0)), rl(goodLog()));

const decode = async (b: Uint8Array): Promise<string> => {
  const A = await load();
  try {
    const r = A.decodeReceipt(b);
    return `ok|${r.type}|${r.status}|${r.postState === undefined ? '' : hexLower(r.postState)}|${r.cumulativeGasUsed}|${r.logs.length}`;
  } catch (e) {
    if (e instanceof A.ReceiptError) return 'err';
    throw e;
  }
};

describe('receipts geth decodes', () => {
  it('a legacy receipt (first byte above 0x7f) is type 0 with its status, gas and logs', async () => {
    const A = await load();
    const r = A.decodeReceipt(good());
    expect(r.type).toBe(0);
    expect(r.status).toBe(1);
    expect(r.cumulativeGasUsed).toBe(21000n);
    expect(r.logs).toHaveLength(1);
    expect(hexLower(r.logs[0]!.address)).toBe('11'.repeat(20));
    expect(r.logs[0]!.topics.map(hexLower)).toEqual(['22'.repeat(32), '33'.repeat(32)]);
    expect(hexLower(r.logs[0]!.data)).toBe('44'.repeat(5));
  });

  it.each([1, 2, 3, 4])('a typed receipt of type %i is its payload behind the type byte', async (t) => {
    expect(await decode(cat(Uint8Array.of(t), good()))).toBe(`ok|${t}|1||21000|1`);
  });

  it('status: empty is failed (0), 0x01 successful (1), 32 bytes a post-state root (status 0 with the root)', async () => {
    expect(await decode(body(rb(new Uint8Array(0)), ru(1n), rb(fill(256, 0)), rl()))).toBe('ok|0|0||1|0');
    expect(await decode(body(OK_STATUS, ru(1n), rb(fill(256, 0)), rl()))).toBe('ok|0|1||1|0');
    expect(await decode(body(rb(fill(32, 0xab)), ru(1n), rb(fill(256, 0)), rl()))).toBe(`ok|0|0|${'ab'.repeat(32)}|1|0`);
  });

  it('gas of zero (0x80), of 8 bytes and the logs of a receipt with no logs, many logs, no topics, four topics and big data', async () => {
    expect(await decode(body(OK_STATUS, rb(new Uint8Array(0)), rb(fill(256, 0)), rl()))).toBe('ok|0|1||0|0');
    expect(await decode(body(OK_STATUS, ru((1n << 64n) - 1n), rb(fill(256, 0)), rl()))).toBe(`ok|0|1||${(1n << 64n) - 1n}|0`);
    const many = body(OK_STATUS, ru(1n), rb(fill(256, 0)), rl(...Array.from({ length: 60 }, goodLog), log(fill(20, 1), [], new Uint8Array(0)), log(fill(20, 1), [fill(32, 1), fill(32, 2), fill(32, 3), fill(32, 4)], fill(300, 5))));
    expect(await decode(many)).toBe('ok|0|1||1|62');
  });
});

describe('receipts geth refuses', () => {
  const refused: [string, () => Uint8Array][] = [
    ['an empty input', () => new Uint8Array(0)],
    ['a typed receipt of one byte', () => Uint8Array.of(0x02)],
    ['type 0x00 behind an envelope', () => cat(Uint8Array.of(0), good())],
    ['type 0x05', () => cat(Uint8Array.of(5), good())],
    ['type 0x7f', () => cat(Uint8Array.of(0x7f), good())],
    ['a trailing byte after a legacy receipt', () => cat(good(), Uint8Array.of(0))],
    ['a trailing byte after a typed receipt', () => cat(Uint8Array.of(2), good(), Uint8Array.of(0))],
    ['a status of two bytes', () => body(rb(Uint8Array.of(1, 1)), ru(1n), rb(fill(256, 0)), rl())],
    ['a status byte 0x02', () => body(Uint8Array.of(2), ru(1n), rb(fill(256, 0)), rl())],
    ['a status byte 0x00', () => body(Uint8Array.of(0), ru(1n), rb(fill(256, 0)), rl())],
    ['a status of 31 bytes', () => body(rb(fill(31, 1)), ru(1n), rb(fill(256, 0)), rl())],
    ['a status of 33 bytes', () => body(rb(fill(33, 1)), ru(1n), rb(fill(256, 0)), rl())],
    ['the status 0x01 written as 0x81 0x01 (non-canonical single byte)', () => body(Uint8Array.of(0x81, 0x01), ru(1n), rb(fill(256, 0)), rl())],
    ['a status that is a list', () => body(rl(), ru(1n), rb(fill(256, 0)), rl())],
    ['gas with a leading zero byte', () => body(OK_STATUS, rb(Uint8Array.of(0, 1)), rb(fill(256, 0)), rl())],
    ['gas as the single byte 0x00', () => body(OK_STATUS, Uint8Array.of(0), rb(fill(256, 0)), rl())],
    ['gas of nine bytes', () => body(OK_STATUS, rb(fill(9, 1)), rb(fill(256, 0)), rl())],
    ['gas that is a list', () => body(OK_STATUS, rl(), rb(fill(256, 0)), rl())],
    ['a bloom of 255 bytes', () => body(OK_STATUS, ru(1n), rb(fill(255, 0)), rl())],
    ['a bloom of 257 bytes', () => body(OK_STATUS, ru(1n), rb(fill(257, 0)), rl())],
    ['a bloom that is a list', () => body(OK_STATUS, ru(1n), rl(), rl())],
    ['logs that are a string', () => body(OK_STATUS, ru(1n), rb(fill(256, 0)), rb(new Uint8Array(0)))],
    ['a log that is a string', () => body(OK_STATUS, ru(1n), rb(fill(256, 0)), rl(rb(fill(3, 1))))],
    ['a log of two items', () => body(OK_STATUS, ru(1n), rb(fill(256, 0)), rl(rl(rb(fill(20, 1)), rl())))],
    ['a log of four items', () => body(OK_STATUS, ru(1n), rb(fill(256, 0)), rl(rl(rb(fill(20, 1)), rl(), rb(new Uint8Array(0)), rb(new Uint8Array(0)))))],
    ['an empty log', () => body(OK_STATUS, ru(1n), rb(fill(256, 0)), rl(rl()))],
    ['a log address of 19 bytes', () => body(OK_STATUS, ru(1n), rb(fill(256, 0)), rl(log(fill(19, 1), [], new Uint8Array(0))))],
    ['a log address of 21 bytes', () => body(OK_STATUS, ru(1n), rb(fill(256, 0)), rl(log(fill(21, 1), [], new Uint8Array(0))))],
    ['a log address that is a list', () => body(OK_STATUS, ru(1n), rb(fill(256, 0)), rl(rl(rl(), rl(), rb(new Uint8Array(0)))))],
    ['a topic of 31 bytes', () => body(OK_STATUS, ru(1n), rb(fill(256, 0)), rl(log(fill(20, 1), [fill(31, 1)], new Uint8Array(0))))],
    ['a topic of 33 bytes', () => body(OK_STATUS, ru(1n), rb(fill(256, 0)), rl(log(fill(20, 1), [fill(33, 1)], new Uint8Array(0))))],
    ['a topic that is a list', () => body(OK_STATUS, ru(1n), rb(fill(256, 0)), rl(rl(rb(fill(20, 1)), rl(rl()), rb(new Uint8Array(0)))))],
    ['log topics that are a string', () => body(OK_STATUS, ru(1n), rb(fill(256, 0)), rl(rl(rb(fill(20, 1)), rb(new Uint8Array(0)), rb(new Uint8Array(0)))))],
    ['log data that is a list', () => body(OK_STATUS, ru(1n), rb(fill(256, 0)), rl(rl(rb(fill(20, 1)), rl(), rl())))],
    ['three items', () => rl(OK_STATUS, ru(1n), rb(fill(256, 0)))],
    ['five items', () => rl(OK_STATUS, ru(1n), rb(fill(256, 0)), rl(), rl())],
    ['a legacy receipt that is a string', () => rb(fill(300, 0x90))],
    ['a list whose declared length passes the input', () => Uint8Array.from(good().subarray(0, good().length - 1))],
    ['a list whose long length is non-canonical (0xf8 0x37)', () => cat(Uint8Array.of(0xf8, 55), good().subarray(1))],
    ['a log with a single-byte address string', () => body(OK_STATUS, ru(1n), rb(fill(256, 0)), rl(rl(Uint8Array.of(1), rl(), rb(new Uint8Array(0)))))],
  ];
  it.each(refused.map(([n, f]) => [n, f] as const))('%s', async (_n, f) => {
    expect(await decode(f())).toBe('err');
  });

  it('every truncation of a good legacy and a good typed receipt is refused (N passes, N-1 fails)', async () => {
    for (const full of [good(), cat(Uint8Array.of(2), good())]) {
      expect(await decode(full)).toMatch(/^ok/);
      for (let n = 0; n < full.length; n++) expect(await decode(full.subarray(0, n)), `${n}`).toBe('err');
    }
  });

  it('a bloom of exactly 256 and a topic of exactly 32 are the boundary values that pass', async () => {
    expect(await decode(body(OK_STATUS, ru(1n), rb(fill(256, 0)), rl(log(fill(20, 1), [fill(32, 1)], new Uint8Array(0)))))).toBe('ok|0|1||1|1');
  });
});

describe('the real receipt of finality_arb_force1', () => {
  it('decodes: type 2, status 1, the Rollup logs among its logs', async () => {
    const A = await load();
    const r = A.decodeReceipt(Uint8Array.from(readIn('arb_force1', 'receipt.bin')));
    expect(r.type).toBe(2);
    expect(r.status).toBe(1);
    expect(r.logs.length).toBeGreaterThan(1);
    expect(r.logs.some((l) => hexLower(l.address) === '042b2e6c5e99d4c521bd49beed5e99651d9b0cf4')).toBe(true);
  });
});
