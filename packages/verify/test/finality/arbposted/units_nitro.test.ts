/**
 * The Nitro payload layer in isolation (nitro.ts): the blob codec, the capped brotli reader, the segment splitter, the L2 message parser
 * and the payload statuses. These are the places hostile bytes enter, so every bound has a test at the bound and one past it.
 */
import { brotliCompressSync, constants as zc } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  BlobPayloadError,
  HEADER_BROTLI,
  MAX_L2_DEPTH,
  MAX_L2_MESSAGE_SIZE,
  PayloadOK,
  PayloadOffL1,
  PayloadTooLarge,
  PayloadUndecodable,
  PayloadUnknownHeader,
  decodeBlobs,
  decodePayload,
  parseL2,
  splitSegments,
  uncompress,
} from '../../../src/proof-v2/finality/arbposted/nitro.js';
import { BLOB_BYTES } from '../../../src/proof-v2/finality/arbposted/wire.js';
import { rlpBytes } from '../../../src/proof-v2/finality/baseposted/trie.js';
import { concat, msgBatch, msgTx, payloadOf, seg, u64be, utf8, userTx } from './synth.js';

/** nitro's EncodeBlobs for tests: the RLP string of data, zero padded, spread over 31-byte chunks and a packed 6-bit stream per blob. */
export function encodeBlobs(data: Uint8Array): Uint8Array[] {
  const per = 4096 * 31 + 3072;
  const rlp = rlpBytes(data);
  const n = Math.max(1, Math.ceil(rlp.length / per));
  const padded = new Uint8Array(n * per);
  padded.set(rlp);
  const out: Uint8Array[] = [];
  for (let b = 0; b < n; b++) {
    const chunk = padded.subarray(b * per, (b + 1) * per);
    const blob = new Uint8Array(BLOB_BYTES);
    for (let fe = 0; fe < 4096; fe++) blob.set(chunk.subarray(fe * 31, fe * 31 + 31), fe * 32 + 1);
    const bits = chunk.subarray(4096 * 31);
    let acc = 0;
    let accBits = 0;
    let p = 0;
    for (let fe = 0; fe < 4096; fe++) {
      if (accBits < 6) {
        acc |= bits[p++]! << accBits;
        accBits += 8;
      }
      blob[fe * 32] = acc & 0x3f;
      acc >>= 6;
      accBits -= 6;
    }
    out.push(blob);
  }
  return out;
}

describe('decodeBlobs (nitro DecodeBlobs)', () => {
  it('round-trips payloads of 0, 1, 55, 56, one blob and several blobs', () => {
    for (const n of [0, 1, 55, 56, 300, 126_000, 130_100, 270_000]) {
      const data = Uint8Array.from({ length: n }, (_, i) => (i * 31 + 7) & 0xff);
      const blobs = encodeBlobs(data);
      expect(decodeBlobs(blobs), `${n} bytes in ${blobs.length} blobs`).toEqual(data);
    }
  });
  it('bytes after the RLP string must be zero: one non-zero byte in the padding refuses', () => {
    const blobs = encodeBlobs(utf8('hello'));
    blobs[0]![1 + 31 * 32 + 5] = 1; // a data byte of field element 32, far past the 7-byte string
    expect(() => decodeBlobs(blobs)).toThrow(BlobPayloadError);
  });
  it('a blob of the wrong length, a list instead of a string and a string longer than the blobs refuse', () => {
    expect(() => decodeBlobs([new Uint8Array(BLOB_BYTES - 1)])).toThrow(BlobPayloadError);
    const list = encodeBlobs(utf8('x'));
    list[0]![1] = 0xc0; // the first RLP byte becomes an empty list
    expect(() => decodeBlobs(list)).toThrow(BlobPayloadError);
    const long = encodeBlobs(utf8('x'));
    long[0]!.set([0xba, 0xff, 0xff, 0xff, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00], 1); // a 10-byte-length string far beyond the data
    expect(() => decodeBlobs(long)).toThrow(BlobPayloadError);
  });
  it('an empty list of blobs holds no RLP string', () => {
    expect(() => decodeBlobs([])).toThrow(BlobPayloadError);
  });
  it('the 6 spare bits of byte 0 of each field element carry data: flipping one changes the payload tail', () => {
    const data = Uint8Array.from({ length: 129_000 }, (_, i) => i & 0xff);
    const blobs = encodeBlobs(data);
    const b = blobs.map((x) => Uint8Array.from(x));
    b[0]![0] ^= 1;
    expect(decodeBlobs(b)).not.toEqual(data);
  });
});

describe('uncompress (capped brotli, the reference reader semantics)', () => {
  const raw = utf8('hello hello hello hello hello world');
  const c = brotliCompressSync(raw);
  it('decodes a complete stream and reports exceeded exactly above the cap', () => {
    expect(uncompress(c, raw.length).out).toEqual(Uint8Array.from(raw));
    expect(uncompress(c, raw.length - 1)).toMatchObject({ exceeded: true, failed: false });
    expect(uncompress(c, raw.length + 1)).toMatchObject({ exceeded: false, failed: false });
    expect(uncompress(c, 0)).toMatchObject({ exceeded: true });
  });
  it('an EMPTY input is an empty stream (the reference reads nothing and no error)', () => {
    expect(uncompress(new Uint8Array(0), 10)).toEqual({ out: new Uint8Array(0), exceeded: false, failed: false });
  });
  it('a truncated stream, trailing bytes after the end, garbage and a lone byte all fail', () => {
    expect(uncompress(c.subarray(0, c.length - 1), 1000).failed).toBe(true);
    expect(uncompress(c.subarray(0, 1), 1000).failed).toBe(true);
    expect(uncompress(concat(c, Uint8Array.of(0)), 1000).failed).toBe(true);
    expect(uncompress(concat(c, c), 1000).failed).toBe(true);
    expect(uncompress(Uint8Array.of(0xff, 0xff, 0xff, 0xff, 0xff), 1000).failed).toBe(true);
  });
  it('a decompression bomb is cut at the cap while streaming (256 MiB of zeros in a few hundred KiB, cap 1 MiB) and fast', () => {
    const bomb = brotliCompressSync(new Uint8Array(256 * 1024 * 1024), { params: { [zc.BROTLI_PARAM_QUALITY]: 1 } });
    expect(bomb.length).toBeLessThan(1 << 20);
    const t0 = Date.now();
    expect(uncompress(bomb, 1 << 20)).toMatchObject({ exceeded: true, failed: false });
    expect(Date.now() - t0).toBeLessThan(5000);
  });
  it('a cap larger than the largest Buffer is clamped rather than refused by node', () => {
    expect(uncompress(c, Number.MAX_SAFE_INTEGER).out.length).toBe(raw.length);
  });
});

describe('splitSegments (nitro parseSequencerMessage)', () => {
  it('reads RLP byte strings: kind byte then body; a single byte below 0x80 is its own item (kind = the byte, empty body)', () => {
    const { segs, exceeded } = splitSegments(concat(rlpBytes(Uint8Array.of(0, 1, 2)), Uint8Array.of(0x05), rlpBytes(Uint8Array.of(9))), 10);
    expect(exceeded).toBe(false);
    expect(segs.map((s) => [s.kind, Array.from(s.body)])).toEqual([
      [0, [1, 2]],
      [5, []],
      [9, []],
    ]);
  });
  it('empty strings are skipped and do not count; the first unparseable item ends the batch and what was read stays', () => {
    const stream = concat(Uint8Array.of(0x80), rlpBytes(Uint8Array.of(0, 1)), Uint8Array.of(0x80), Uint8Array.of(0xc0), rlpBytes(Uint8Array.of(0, 2)));
    expect(splitSegments(stream, 10).segs.length).toBe(1); // 0xc0 is a list: it ends the batch
    expect(splitSegments(concat(rlpBytes(Uint8Array.of(0, 1)), Uint8Array.of(0xb8, 0x05, 1)), 10).segs.length).toBe(1); // a short-changed string
    expect(splitSegments(concat(rlpBytes(Uint8Array.of(0, 1)), Uint8Array.of(0x81, 0x05)), 10).segs.length).toBe(1); // 0x81 0x05: non-canonical
    expect(splitSegments(concat(rlpBytes(Uint8Array.of(0, 1)), Uint8Array.of(0xb8, 0x10)), 10).segs.length).toBe(1);
  });
  it('the limit is checked on the next decoded item: exactly max segments is fine, the next item is exceeded - even an empty one', () => {
    const items = (n: number): Uint8Array => concat(...Array.from({ length: n }, () => rlpBytes(Uint8Array.of(0, 1))));
    expect(splitSegments(items(3), 3)).toMatchObject({ exceeded: false });
    expect(splitSegments(items(4), 3)).toMatchObject({ exceeded: true });
    expect(splitSegments(concat(items(3), Uint8Array.of(0x80)), 3)).toMatchObject({ exceeded: true });
    expect(splitSegments(concat(items(3), Uint8Array.of(0xc0)), 3)).toMatchObject({ exceeded: false });
    expect(splitSegments(items(1), 0)).toMatchObject({ exceeded: true });
    expect(splitSegments(new Uint8Array(0), 0)).toMatchObject({ exceeded: false });
  });
  it('a hostile huge length prefix never allocates or reads past the stream', () => {
    const r = splitSegments(Uint8Array.of(0xbf, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 1, 2, 3), 10);
    expect(r).toEqual({ segs: [], exceeded: false });
  });
});

describe('parseL2 (nitro ParseL2Transactions for the user-signed kinds)', () => {
  const t = userTx(1);
  it('kind 4 is one transaction (a copy); a lone kind byte is none; kind 0, 1, 2, 5+ contribute none', () => {
    expect(parseL2(msgTx(t), 0)).toEqual([t]);
    expect(parseL2(Uint8Array.of(4), 0)).toEqual([]);
    expect(parseL2(new Uint8Array(0), 0)).toEqual([]);
    for (const k of [0, 1, 2, 5, 6, 7, 9, 255]) expect(parseL2(concat(Uint8Array.of(k), t), 0), `kind ${k}`).toEqual([]);
  });
  it('kind 3 nests messages in order; a length above the remaining bytes or above 256 KiB ends the batch (earlier ones stay)', () => {
    const a = userTx(1);
    const b = userTx(2);
    expect(parseL2(msgBatch([msgTx(a), msgTx(b)]), 0)).toEqual([a, b]);
    const over = concat(Uint8Array.of(3), u64be(msgTx(a).length), msgTx(a), u64be(100), Uint8Array.of(4, 1, 2));
    expect(parseL2(over, 0)).toEqual([a]);
    const huge = concat(Uint8Array.of(3), u64be(msgTx(a).length), msgTx(a), u64be(MAX_L2_MESSAGE_SIZE + 1), new Uint8Array(MAX_L2_MESSAGE_SIZE + 1));
    expect(parseL2(huge, 0)).toEqual([a]);
    const exact = concat(Uint8Array.of(3), u64be(MAX_L2_MESSAGE_SIZE), concat(Uint8Array.of(4), new Uint8Array(MAX_L2_MESSAGE_SIZE - 1).fill(9)));
    expect(parseL2(exact, 0).length).toBe(1);
    const u64max = concat(Uint8Array.of(3), u64be((1n << 64n) - 1n), msgTx(a));
    expect(parseL2(u64max, 0)).toEqual([]);
  });
  it('fewer than 8 bytes after the kind end the batch; a trailing partial length is ignored', () => {
    expect(parseL2(concat(Uint8Array.of(3), Uint8Array.of(0, 0, 0)), 0)).toEqual([]);
    const a = userTx(1);
    expect(parseL2(concat(msgBatch([msgTx(a)]), Uint8Array.of(1, 2, 3)), 0)).toEqual([a]);
  });
  it('nesting stops at depth 16: a transaction inside 16 batches is read, inside 17 is not', () => {
    const deep = (levels: number): Uint8Array => {
      let m = msgTx(t);
      for (let i = 0; i < levels; i++) m = msgBatch([m]);
      return m;
    };
    expect(MAX_L2_DEPTH).toBe(16);
    expect(parseL2(deep(16), 0)).toEqual([t]);
    expect(parseL2(deep(17), 0)).toEqual([]);
    expect(parseL2(deep(500), 0)).toEqual([]); // 500 nested batches never recurse past 16 frames
  });
});

describe('decodePayload statuses', () => {
  it('an empty payload is undecodable; header bytes 0x80, 0x88, 0x01 are off-L1; every other non-zero byte is unknown (0x20 included)', () => {
    expect(decodePayload(new Uint8Array(0), 100, 100).status).toBe(PayloadUndecodable);
    for (const b of [0x80, 0x88, 0x01]) expect(decodePayload(Uint8Array.of(b), 100, 100)).toMatchObject({ status: PayloadOffL1, headerByte: b });
    for (const b of [0x20, 0x02, 0x7f, 0x81, 0xff]) expect(decodePayload(Uint8Array.of(b), 100, 100)).toMatchObject({ status: PayloadUnknownHeader, headerByte: b });
    expect(HEADER_BROTLI).toBe(0);
  });
  it('counts segments, delayed segments and messages; kind-1 segments that cannot be decompressed are dropped without consuming an ordinal', () => {
    const payload = payloadOf(
      concat(
        seg(2, new Uint8Array(0)),
        seg(0, msgTx(userTx(1))),
        seg(1, Uint8Array.of(0xff, 0xff)),
        seg(2, new Uint8Array(0)),
        seg(1, brotliCompressSync(msgTx(userTx(2)))),
        seg(4, new Uint8Array(0)),
      ),
    );
    const r = decodePayload(payload, 1 << 20, 100);
    expect(r.status).toBe(PayloadOK);
    expect(r.segments).toBe(6);
    expect(r.delayedSegments).toBe(2);
    expect(r.messages.map((m) => m.ordinal)).toEqual([0, 1]);
    expect(r.messages[1]!.txs).toEqual([userTx(2)]);
  });
  it('the mixed stream of the reference cross-check: delayed, plain, undecodable brotli, valid brotli, brotli with a trailing byte and an EMPTY brotli segment', () => {
    const m = msgTx(Uint8Array.of(0x02, 0x09));
    const stream = concat(
      seg(2, new Uint8Array(0)),
      seg(0, msgTx(Uint8Array.of(0x02, 0x01))),
      seg(1, Uint8Array.of(0xff, 0xff)),
      seg(1, brotliCompressSync(m)),
      seg(1, concat(brotliCompressSync(m), Uint8Array.of(0))),
      seg(1, new Uint8Array(0)),
    );
    const r = decodePayload(payloadOf(stream), 1 << 20, 100);
    // the same stream through the validator's Go decodePayload: segments=6 delayed=1 messages=3 ordinals [0 1 2]
    expect([r.status, r.segments, r.delayedSegments, r.messages.length, r.messages.map((x) => x.ordinal)]).toEqual([PayloadOK, 6, 1, 3, [0, 1, 2]]);
    expect(r.messages[2]!.txs).toEqual([]);
  });
  it('a payload of only the header byte decodes to zero segments and zero messages; a missing payload and an unknown header are named', () => {
    expect(decodePayload(Uint8Array.of(0), 1000, 1000)).toMatchObject({ status: PayloadOK, segments: 0, delayedSegments: 0 });
    expect(decodePayload(Uint8Array.of(0), 1000, 1000).messages).toEqual([]);
  });
  it('the uncompressed cap is judged before the segments, with its own flag', () => {
    const payload = payloadOf(concat(...Array.from({ length: 50 }, () => seg(0, msgTx(userTx(1))))));
    expect(decodePayload(payload, 10, 100)).toMatchObject({ status: PayloadTooLarge, exceededUncompressed: true, exceededSegments: false });
    expect(decodePayload(payload, 1 << 20, 10)).toMatchObject({ status: PayloadTooLarge, exceededUncompressed: false, exceededSegments: true });
  });
});
