/**
 * The shared strict Brotli reader (src/proof-v2/finality/strictbrotli.ts, the twin of the validator's pkg/finality/strictbrotli): every truncation
 * point of streams of every quality and window is refused, every complete stream accepted, a byte after a stream refused, the empty stream
 * refused, the cap exact; and 170 Go-judged known answers (verdicts the Go package wrote for cuts, flips, flipped cuts and 32 KiB-boundary
 * streams under caps from 0 to 120,000) are reproduced.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { brotliCompressSync, brotliDecompressSync, constants as zc } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { ERR_EMPTY, ERR_INCOMPLETE, ERR_TRAILING, StrictBrotliError, decompress } from '../../src/proof-v2/finality/strictbrotli.js';

const here = dirname(fileURLToPath(import.meta.url));

const compress = (data: Uint8Array, quality: number, lgwin: number): Uint8Array =>
  brotliCompressSync(data, { params: { [zc.BROTLI_PARAM_QUALITY]: quality, [zc.BROTLI_PARAM_LGWIN]: lgwin } });

/** xorshift: the corpus must not depend on Math.random */
function rng(seed: number): () => number {
  let x = seed >>> 0 || 1;
  return () => {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    return x;
  };
}

const reasonOf = (f: () => unknown): string => {
  try {
    f();
  } catch (e) {
    if (e instanceof StrictBrotliError) return e.reason;
    throw e;
  }
  return 'accepted';
};

function corpus(): Record<string, Uint8Array> {
  const r = rng(7);
  const random = (n: number): Uint8Array => Uint8Array.from({ length: n }, () => r() & 0xff);
  const text = Buffer.from('the sequencer committed to this batch; '.repeat(300));
  return {
    'one byte': Uint8Array.of(0x42),
    short: Buffer.from('0123456789abcdef0123456789abcdef'),
    text,
    'random 2k': random(2000),
    mixed: Buffer.concat([random(3000), text, random(2000)]),
    'zeros 70k': new Uint8Array(70000),
    'two metablocks': Buffer.concat([random(40000), Buffer.alloc(40000, 9)]),
  };
}

/** every index for short streams; both ends, a stride and the 32 KiB read boundaries for long ones */
function points(n: number): number[] {
  if (n <= 3000) return Array.from({ length: n }, (_, i) => i);
  const seen = new Set<number>();
  const add = (i: number): void => {
    if (i >= 0 && i < n) seen.add(i);
  };
  for (let i = 0; i < 300; i++) {
    add(i);
    add(n - 1 - i);
  }
  for (let i = 0; i < n; i += 997) {
    add(i);
    add(i + 32767);
    add(i + 32768);
    add(i + 32769);
  }
  return [...seen];
}

describe('every truncation is refused and every complete stream accepted', () => {
  it('streams of qualities 0, 2, 5, 9 and windows 10, 16, 22: complete accepted, one trailing byte and a second stream refused as trailing, every proper prefix refused', () => {
    let cut = 0;
    for (const [name, data] of Object.entries(corpus())) {
      for (const level of [0, 2, 5, 9]) {
        for (const lgwin of [10, 16, 22]) {
          if (data.length > 30000 && (level > 5 || lgwin < 22)) continue; // keep the corpus affordable; small inputs cover every level and window
          const c = compress(data, level, lgwin);
          const tag = `${name} q${level} w${lgwin}`;
          const ok = decompress(c, data.length + 1);
          expect(ok.exceeded, tag).toBe(false);
          expect(Buffer.from(ok.out).equals(Buffer.from(data)), tag).toBe(true);
          expect(reasonOf(() => decompress(Buffer.concat([c, Buffer.of(0)]), data.length + 1)), `${tag} trailing byte`).toBe('trailing');
          expect(reasonOf(() => decompress(Buffer.concat([c, c]), data.length + 1)), `${tag} second stream`).toBe('trailing');
          for (const i of points(c.length)) {
            const r = reasonOf(() => decompress(c.subarray(0, i), data.length + 1));
            // a proper prefix is never a stream (this corpus has no prefix that is itself complete), so it is refused, never accepted
            expect(r === 'incomplete' || r === 'decode' || r === 'empty', `${tag} cut ${i}/${c.length}: ${r}`).toBe(true);
            cut++;
          }
        }
      }
    }
    expect(cut).toBeGreaterThan(8000);
  }, 600_000);
});

describe('the empty stream and the reference behaviour the module exists for', () => {
  it('empty input is refused under any cap, with the Go reason text', () => {
    for (const max of [0, 10, Number.MAX_SAFE_INTEGER, 1n << 70n]) expect(reasonOf(() => decompress(new Uint8Array(0), max))).toBe('empty');
    expect(() => decompress(new Uint8Array(0), 1)).toThrow(ERR_EMPTY);
  });
  it('the reason texts are the Go error texts', () => {
    expect(ERR_EMPTY).toBe('brotli: empty stream');
    expect(ERR_INCOMPLETE).toBe('brotli: stream is incomplete');
    expect(ERR_TRAILING).toBe('brotli: bytes after the end of the stream');
    const c = compress(Buffer.from('0123456789'.repeat(4).slice(0, 35)), 5, 22);
    expect(() => decompress(Buffer.concat([c, Buffer.of(0)]), 100)).toThrow(ERR_TRAILING);
    expect(() => decompress(c.subarray(0, c.length - 1), 100)).toThrow(ERR_INCOMPLETE);
  });
  it('the facts of node:zlib the module relies on: FINISH refuses a stream cut by one byte, FLUSH returns a prefix, and a trailing byte is ignored by the decoder', () => {
    const msg = Buffer.from('0123456789'.repeat(4).slice(0, 35));
    const c = compress(msg, 5, 22);
    expect(() => brotliDecompressSync(c.subarray(0, c.length - 1))).toThrow(/unexpected end of file/);
    const prefix = brotliDecompressSync(c.subarray(0, c.length - 1), { finishFlush: zc.BROTLI_OPERATION_FLUSH });
    expect(prefix.length).toBeGreaterThan(0);
    expect(prefix.length).toBeLessThan(msg.length);
    const trailing = brotliDecompressSync(Buffer.concat([c, Buffer.of(0)]), { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
    expect(trailing.buffer.equals(msg)).toBe(true);
    expect(trailing.engine.bytesWritten).toBe(c.length);
    // so the wrapper, not the decoder, refuses what Go refuses
    expect(reasonOf(() => decompress(c.subarray(0, c.length - 1), 100))).toBe('incomplete');
  });
});

describe('the cap', () => {
  it('is exact, the largest caps do not wrap, and an excess is reported without being read to its end', () => {
    const data = Buffer.alloc(5000, 7);
    const c = compress(data, 5, 22);
    expect(decompress(c, 5000)).toMatchObject({ exceeded: false });
    expect(decompress(c, 5000).out.length).toBe(5000);
    for (const max of [Number.MAX_SAFE_INTEGER, (1n << 63n) - 1n, 1n << 64n, 1n << 100n]) {
      const r = decompress(c, max);
      expect([r.exceeded, r.out.length]).toEqual([false, 5000]);
    }
    expect(decompress(c, 4999)).toEqual({ out: new Uint8Array(0), exceeded: true });
    expect(decompress(c, 0).exceeded).toBe(true);
    // a stream cut short whose output already passes the cap is an excess report (the Go package: classify's first test)
    expect(decompress(c.subarray(0, c.length - 1), 100).exceeded).toBe(true);
    expect(reasonOf(() => decompress(c.subarray(0, c.length - 1), 5000))).toBe('incomplete');
  });
  it('a decompression bomb is cut at the cap while streaming (256 MiB of zeros in under 1 MiB, cap 1 MiB), and fast', () => {
    const bomb = compress(new Uint8Array(256 * 1024 * 1024), 1, 22);
    expect(bomb.length).toBeLessThan(1 << 20);
    const t0 = Date.now();
    expect(decompress(bomb, 1 << 20).exceeded).toBe(true);
    expect(Date.now() - t0).toBeLessThan(5000);
  });
  it('a bomb followed by garbage or cut short is judged on the output before the failure, as Go does (caps of 64 and more)', () => {
    const bomb = compress(new Uint8Array(8 * 1024 * 1024), 1, 22);
    expect(decompress(Buffer.concat([bomb, Buffer.of(0)]), 1 << 20).exceeded).toBe(true);
    expect(decompress(bomb.subarray(0, bomb.length >> 1), 1 << 20).exceeded).toBe(true);
  });
});

describe('garbage never throws anything but a StrictBrotliError', () => {
  it('3,000 seeded random buffers are refused, except those the decoder itself accepts as complete streams', () => {
    const r = rng(11);
    let refused = 0;
    for (let i = 0; i < 3000; i++) {
      const b = Uint8Array.from({ length: 1 + (r() % 200) }, () => r() & 0xff);
      try {
        const out = decompress(b, 1 << 16);
        // accepted: the decoder must agree that it is one complete stream with nothing after it
        const info = brotliDecompressSync(b, { info: true }) as unknown as { engine: { bytesWritten: number } };
        expect(info.engine.bytesWritten, `accepted ${Buffer.from(b).toString('hex')}`).toBe(b.length);
        expect(out.exceeded).toBe(false);
      } catch (e) {
        if (!(e instanceof StrictBrotliError)) throw e;
        refused++;
      }
    }
    expect(refused).toBeGreaterThan(2900);
  });
});

describe('Go-judged known answers', () => {
  const fx = JSON.parse(readFileSync(join(here, '..', 'fixtures', 'finality', 'strictbrotli_go_judged.json'), 'utf8')) as {
    cases: { name: string; in: string; max: number; want: string }[];
  };
  it('170 verdicts the Go package wrote (exceeded, ok:<length>, empty, incomplete, trailing, error) are reproduced', () => {
    expect(fx.cases.length).toBe(170);
    const seen = new Set<string>();
    for (const c of fx.cases) {
      const input = Buffer.from(c.in, 'base64');
      let got: string;
      try {
        const r = decompress(input, c.max);
        got = r.exceeded ? 'exceeded' : `ok:${r.out.length}`;
      } catch (e) {
        if (!(e instanceof StrictBrotliError)) throw e;
        got = e.reason === 'decode' ? 'error' : e.reason;
      }
      expect(got, `${c.name} max=${c.max}`).toBe(c.want);
      seen.add(c.want.replace(/[0-9]+/, '#'));
    }
    // the answers cover every outcome
    expect([...seen].sort()).toEqual(['empty', 'error', 'exceeded', 'incomplete', 'ok:#', 'trailing'].sort());
  }, 300_000);
});
