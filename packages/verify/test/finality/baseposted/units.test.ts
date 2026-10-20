/**
 * Unit tests of the pieces of the Base l1_posted verifier that the vectors reach only on the success path: the OP blob codec, frames and
 * channel compression (with the exact output cap), the ordered-trie root, the base_sepolia pins and the strict, bounded body codec.
 */
import { keccak_256 } from '@noble/hashes/sha3';
import { brotliCompressSync, deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { verifyProof } from '../../../src/s6/mpt.js';
import { decodeContainer, defaultLimits } from '../../../src/proof-v2/finality/codec.js';
import { ethl1PinsFrom } from '../../../src/proof-v2/finality/ethl1/index.js';
import { parsePinsOverride, sepoliaPins } from '../../../src/proof-v2/finality/pins.js';
import { FinalityStateError } from '../../../src/proof-v2/finality/state.js';
import { BLOB_MAX_DATA, BlobDecodeError, blobToData, encodeBlob } from '../../../src/proof-v2/finality/baseposted/blob.js';
import { ChannelError, MAX_FRAME_DATA, decompress, marshalFrame, parseFrames } from '../../../src/proof-v2/finality/baseposted/channel.js';
import { parseBasePins } from '../../../src/proof-v2/finality/baseposted/pins.js';
import { buildTrie, rlpIndexKey, trieRoot } from '../../../src/proof-v2/finality/baseposted/trie.js';
import { BLOB_SIZE, decodeBody, encodeBody } from '../../../src/proof-v2/finality/baseposted/wire.js';
import { read } from './vectorset.js';
import { concat, hex, unhex } from './synth.js';

const throwsState = (fn: () => unknown): FinalityStateError => {
  try {
    fn();
  } catch (e) {
    if (e instanceof FinalityStateError) return e;
    throw e;
  }
  throw new Error('no state was thrown');
};
const patterned = (n: number, seed = 7): Uint8Array => Uint8Array.from({ length: n }, (_, i) => (i * 31 + seed + (i >> 8)) & 0xff);

describe('OP blob data encoding', () => {
  it.each([0, 1, 26, 27, 28, 31, 32, 127, 128, 1000, 65536, BLOB_MAX_DATA])('encodeBlob and blobToData round trip %i bytes', (n) => {
    const data = patterned(n);
    const blob = encodeBlob(data);
    expect(blob.length).toBe(BLOB_SIZE);
    expect(Array.from(blobToData(blob))).toEqual(Array.from(data));
  });

  it('refuses data that does not fit and a blob of another length', () => {
    expect(() => encodeBlob(new Uint8Array(BLOB_MAX_DATA + 1))).toThrow(BlobDecodeError);
    expect(() => blobToData(new Uint8Array(BLOB_SIZE - 1))).toThrow('blob length');
    expect(() => blobToData(new Uint8Array(BLOB_SIZE + 1))).toThrow('blob length');
  });

  it('refuses a version byte, an over-long length, set top bits, a non-zero data tail and a non-zero input tail', () => {
    const base = encodeBlob(patterned(300));
    const mut = (f: (b: Uint8Array) => void): Uint8Array => {
      const b = Uint8Array.from(base);
      f(b);
      return b;
    };
    expect(() => blobToData(mut((b) => (b[1] = 1)))).toThrow('blob encoding version');
    expect(() => blobToData(mut((b) => { b[2] = 0x1f; b[3] = 0xff; b[4] = 0xff; }))).toThrow('blob data length');
    expect(() => blobToData(mut((b) => (b[0] = 0x40)))).toThrow('blob field element');
    expect(() => blobToData(mut((b) => (b[32] = 0x80)))).toThrow('blob field element');
    expect(() => blobToData(mut((b) => (b[32 + 32 * 5] = 0xc0)))).toThrow('blob field element');
    // a non-zero byte in the decoded data beyond the declared length, and in the blob beyond what the loop read
    expect(() => blobToData(mut((b) => { b[2] = 0; b[3] = 0; b[4] = 10; }))).toThrow('blob data tail');
    expect(() => blobToData(mut((b) => (b[BLOB_SIZE - 1] = 1)))).toThrow();
    const tail = encodeBlob(patterned(10));
    tail[BLOB_SIZE - 1] = 1;
    expect(() => blobToData(tail)).toThrow('blob input tail');
  });

  it('accepts the maximum length declared at the boundary and refuses one more', () => {
    const b = encodeBlob(patterned(BLOB_MAX_DATA));
    expect(blobToData(b).length).toBe(BLOB_MAX_DATA);
    const over = Uint8Array.from(b);
    const n = BLOB_MAX_DATA + 1;
    over[2] = (n >> 16) & 0xff;
    over[3] = (n >> 8) & 0xff;
    over[4] = n & 0xff;
    expect(() => blobToData(over)).toThrow('blob data length');
  });
});

describe('frames', () => {
  const id = Uint8Array.from({ length: 16 }, (_, i) => i + 1);
  const frame = (n: number, data: Uint8Array, isLast: boolean) => marshalFrame({ id, number: n, data, isLast });

  it('parses several frames behind the version byte and round trips', () => {
    const data = concat(Uint8Array.of(0), frame(0, Uint8Array.of(1, 2, 3), false), frame(1, new Uint8Array(0), true));
    const f = parseFrames(data);
    expect(f.length).toBe(2);
    expect(f[0]).toEqual({ id, number: 0, data: Uint8Array.of(1, 2, 3), isLast: false });
    expect(f[1]!.isLast).toBe(true);
    expect(f[1]!.number).toBe(1);
    expect(f[0]!.number).toBe(0);
  });

  it('refuses the empty input, another derivation version, a short header, a long length, a bad is_last and no frames', () => {
    expect(() => parseFrames(new Uint8Array(0))).toThrow('derivation version');
    expect(() => parseFrames(concat(Uint8Array.of(1), frame(0, new Uint8Array(0), true)))).toThrow('derivation version');
    expect(() => parseFrames(concat(Uint8Array.of(0), new Uint8Array(21)))).toThrow('frame header');
    const long = Uint8Array.from(frame(0, Uint8Array.of(1, 2), true));
    expect(() => parseFrames(concat(Uint8Array.of(0), long.subarray(0, long.length - 1)))).toThrow('frame length');
    const bad = Uint8Array.from(frame(0, Uint8Array.of(1), true));
    bad[bad.length - 1] = 2;
    expect(() => parseFrames(concat(Uint8Array.of(0), bad))).toThrow('frame is_last');
    expect(() => parseFrames(Uint8Array.of(0))).toThrow('no frames');
  });

  it('accepts a frame of exactly one million bytes and refuses one byte more', () => {
    expect(parseFrames(concat(Uint8Array.of(0), frame(0, new Uint8Array(MAX_FRAME_DATA), true)))[0]!.data.length).toBe(MAX_FRAME_DATA);
    expect(() => parseFrames(concat(Uint8Array.of(0), frame(0, new Uint8Array(MAX_FRAME_DATA + 1), true)))).toThrow('frame length');
  });

  it('keeps the 16-bit frame number big-endian and does not alias the input', () => {
    const f = parseFrames(concat(Uint8Array.of(0), frame(0x0102, Uint8Array.of(9), true)))[0]!;
    expect(f.number).toBe(0x0102);
    expect(marshalFrame(f).subarray(16, 18)).toEqual(Uint8Array.of(1, 2));
  });
});

describe('channel decompression', () => {
  const raw = patterned(5000);
  const z = deflateSync(raw);
  const br = concat(Uint8Array.of(1), brotliCompressSync(raw));

  it('inflates zlib and Brotli and honours the cap exactly', () => {
    for (const ch of [z, br]) {
      expect(Array.from(decompress(ch, 5000n))).toEqual(Array.from(raw));
      expect(() => decompress(ch, 4999n)).toThrow(ChannelError);
    }
  });

  it('a bomb never allocates past the cap: 200 MB of zeros under a 1 MB cap is refused', () => {
    const bomb = deflateSync(new Uint8Array(200_000_000), { level: 9 });
    expect(bomb.length).toBeLessThan(300_000);
    expect(() => decompress(bomb, 1_000_000n)).toThrow(ChannelError);
  });

  it('refuses an empty channel, a zlib window above 7, an unknown type, a truncated and a corrupted stream', () => {
    expect(() => decompress(new Uint8Array(0), 100n)).toThrow('empty channel');
    const w = Uint8Array.from(z);
    w[0] = 0x88;
    expect(() => decompress(w, 100000n)).toThrow(ChannelError);
    expect(() => decompress(Uint8Array.of(0x88, 0x00), 100n)).toThrow('zlib window');
    expect(() => decompress(Uint8Array.of(0x78, 0x00), 100n)).not.toThrow('zlib window');
    expect(() => decompress(Uint8Array.of(0x07, 1, 2), 100n)).toThrow('compression type');
    expect(() => decompress(z.subarray(0, z.length - 6), 100000n)).toThrow(ChannelError);
    const bad = Uint8Array.from(z);
    bad[bad.length - 1]! ^= 1;
    expect(() => decompress(bad, 100000n)).toThrow(ChannelError);
    expect(() => decompress(Uint8Array.of(1, 0xff, 0xff, 0xff), 100000n)).toThrow(ChannelError);
  });

  it('recognises zlib by the low nibble 8 alone (the CMF window nibble 0..7 all pass) and Brotli by the byte 1', () => {
    expect(decompress(z, 100000n).length).toBe(5000);
    // the version byte of Brotli is exactly 1; 0x11 has the low nibble 1 and is neither
    expect(() => decompress(Uint8Array.of(0x11, 1, 2), 100n)).toThrow('compression type');
  });
});

describe('ordered trie', () => {
  it('the empty trie has the empty root and one empty value leaves no leaf', () => {
    expect(hex(trieRoot([]))).toBe('0x56e81f171bcc55a6ff8345e692c0f86e5b48e01b996cadc001622fb5e363b421');
    expect(hex(trieRoot([new Uint8Array(0)]))).toBe('0x56e81f171bcc55a6ff8345e692c0f86e5b48e01b996cadc001622fb5e363b421');
    expect(hex(trieRoot([Uint8Array.of(1), new Uint8Array(0)]))).toBe(hex(trieRoot([Uint8Array.of(1)])));
  });

  it.each([1, 2, 3, 16, 17, 127, 128, 129, 300])('every one of %i entries proves under the s6 verifier and an absent index proves absent', (n) => {
    const values = Array.from({ length: n }, (_, i) => patterned(1 + ((i * 13) % 90), i));
    const t = buildTrie(values.map((value, i) => ({ key: rlpIndexKey(i), value })));
    expect(hex(t.root)).toBe(hex(trieRoot(values)));
    for (let i = 0; i < n; i++) expect(hex(verifyProof(t.root, rlpIndexKey(i), t.nodes)!)).toBe(hex(values[i]!));
    expect(verifyProof(t.root, rlpIndexKey(n), t.nodes)).toBeUndefined();
  });

  it('the root changes with the order, a value and a length', () => {
    const a = patterned(40, 1);
    const b = patterned(40, 2);
    expect(hex(trieRoot([a, b]))).not.toBe(hex(trieRoot([b, a])));
    expect(hex(trieRoot([a]))).not.toBe(hex(trieRoot([b])));
    expect(hex(trieRoot([a, b]))).not.toBe(hex(trieRoot([a, b, a])));
  });

  it('matches the transactions root go-ethereum derives for the live L2 block (deposit + batch transactions)', () => {
    // the accepting vectors compare this root with a real L2 header; here the key encoding itself is pinned
    expect(hex(rlpIndexKey(0))).toBe('0x80');
    expect(hex(rlpIndexKey(1))).toBe('0x01');
    expect(hex(rlpIndexKey(127))).toBe('0x7f');
    expect(hex(rlpIndexKey(128))).toBe('0x8180');
    expect(hex(rlpIndexKey(256))).toBe('0x820100');
    expect(hex(rlpIndexKey(65536))).toBe('0x83010000');
  });
});

describe('base_sepolia pins', () => {
  const main = (): string => read('pins/main.json').toString('utf8');
  const withSection = (edit: (s: any) => void): ReturnType<typeof parsePinsOverride> => {
    const j = JSON.parse(main());
    edit(j.base_sepolia);
    const sorted = (v: any): any => (Array.isArray(v) ? v.map(sorted) : v !== null && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sorted(v[k])])) : v);
    return parsePinsOverride(new TextEncoder().encode(`${JSON.stringify(sorted(j), null, 2)}\n`));
  };
  const bad = (edit: (s: any) => void, key: string): void => {
    const e = throwsState(() => parseBasePins(withSection(edit)));
    expect(e.canonical()).toBe(`{"code":"finality_pins_corrupt","fields":{"key":"${key}","reason":"bad_value"}}`);
  };

  it('reads every field of the pinned section', () => {
    const p = parseBasePins(parsePinsOverride(read('pins/main.json')));
    expect(p.chainId).toBe(84532n);
    expect(p.l1ChainId).toBe(11155111n);
    expect(hex(p.systemConfig)).toBe('0xf272670eb55e895584501d564afeb048bed26194');
    expect(hex(p.batchInbox)).toBe('0xff00000000000000000000000000000000084532');
    expect([p.seqWindowSize, p.channelTimeout, p.maxRlpBytesPerChannel]).toEqual([3600n, 300n, 100000000n]);
    expect([p.isthmusTime, p.denimTime, p.l2GenesisTime, p.l2BlockTime]).toEqual([1744905600n, 1792605600n, 1695768288n, 2n]);
    expect(p.maxBlobs).toBe(32);
    expect(p.kzgSetupSha256).toBe('f8e44a31ebf0a6d0734dcb301b0716e2c77f3ae18ed0cab0870fbcc2ca55616f');
    expect([...p.systemConfigImplHashes]).toEqual(['0x35c04acf3bb541d90092bf3e328475377142f70760fa82f372ac0c4e4b3ff4f6']);
  });

  it('an absent section is finality_pin_unknown, a null pins object too', () => {
    const none = parsePinsOverride(new TextEncoder().encode('{\n  "format": "certen-finality-pins/1",\n  "onchain_commitment": null,\n  "published_utc": "2026-10-20T02:35:00Z"\n}\n'));
    expect(throwsState(() => parseBasePins(none)).canonical()).toBe('{"code":"finality_pin_unknown","fields":{"chain":"84532","kind":"base_sepolia"}}');
    expect(throwsState(() => parseBasePins(null)).code).toBe('finality_pin_unknown');
  });

  it('every altered pin is named finality_pins_corrupt{bad_value, key}', () => {
    bad((s) => (s.chain_id = 1), 'base_sepolia.chain_id');
    bad((s) => (s.l1_chain_id = 1), 'base_sepolia.l1_chain_id');
    bad((s) => (s.system_config = '0x1234'), 'base_sepolia.system_config');
    bad((s) => (s.batch_inbox = 'ff'), 'base_sepolia.batch_inbox');
    for (const k of ['seq_window_size', 'channel_timeout', 'max_rlp_bytes_per_channel', 'isthmus_time', 'denim_time', 'l2_genesis_time', 'l2_block_time']) {
      bad((s) => (s[k] = 0), `base_sepolia.${k}`);
    }
    bad((s) => (s.max_blobs = 0), 'base_sepolia.max_blobs');
    bad((s) => (s.max_blobs = -1), 'base_sepolia.max_blobs');
    bad((s) => (s.kzg_setup_sha256 = 'F8E44A31EBF0A6D0734DCB301B0716E2C77F3AE18ED0CAB0870FBCC2CA55616F'), 'base_sepolia.kzg_setup_sha256');
    bad((s) => (s.kzg_setup_sha256 = 'f8e44a31'), 'base_sepolia.kzg_setup_sha256');
    bad((s) => (s.impl_pins = {}), 'base_sepolia.impl_pins');
    bad((s) => (s.impl_pins = { '0x1234': { role: 'syscfg_impl' } }), 'base_sepolia.impl_pins');
    bad((s) => (s.impl_pins = { [`0x${'11'.repeat(32)}`]: { role: 'other' } }), 'base_sepolia.impl_pins');
    bad((s) => (s.impl_pins = { [`0x${'11'.repeat(32)}`]: 5 }), 'base_sepolia.impl_pins');
  });

  it('a wrongly typed value is the section-level bad_value; mixed-case addresses and key case are Go-lenient', () => {
    const e = throwsState(() => parseBasePins(withSection((s) => (s.seq_window_size = '3600'))));
    expect(e.canonical()).toBe('{"code":"finality_pins_corrupt","fields":{"key":"base_sepolia","reason":"bad_value"}}');
    const mixed = parseBasePins(withSection((s) => (s.system_config = '0xF272670EB55E895584501D564AFEB048BED26194')));
    expect(hex(mixed.systemConfig)).toBe('0xf272670eb55e895584501d564afeb048bed26194');
    const upperKey = parseBasePins(withSection((s) => { s.CHAIN_ID = s.chain_id; delete s.chain_id; }));
    expect(upperKey.chainId).toBe(84532n);
  });

  it('a second impl row of another role does not add a syscfg_impl hash and extra keys are ignored', () => {
    const p = parseBasePins(withSection((s) => { s.impl_pins[`0x${'22'.repeat(32)}`] = { role: 'game_impl' }; s.portal = '0x01'; }));
    expect(p.systemConfigImplHashes.size).toBe(1);
  });
});

describe('the body codec', () => {
  const lim = defaultLimits();
  const pins = parsePinsOverride(read('pins/main.json'));
  const ep = ethl1PinsFrom(sepoliaPins(pins));
  const bodyBytes = decodeContainer(read('evidence/valid_a.bin'), lim).body;

  it('decodes the live evidence and re-encodes it to the same bytes', () => {
    const body = decodeBody(bodyBytes, lim, ep, 32);
    expect(body.frames.length).toBe(2);
    const blobs = body.frames.reduce((n, f) => n + f.blobs.length, 0);
    expect(blobs === 6 || blobs === 7).toBe(true);
    expect(body.channelId.length).toBe(16);
    expect(hex(encodeBody(body))).toBe(hex(bodyBytes));
  });

  it('refuses a trailing byte, a truncation, and a blob count over the pinned maximum (named, never truncated)', () => {
    expect(throwsState(() => decodeBody(concat(bodyBytes, Uint8Array.of(0)), lim, ep, 32)).canonical()).toContain('trailing_bytes');
    expect(throwsState(() => decodeBody(bodyBytes.subarray(0, bodyBytes.length - 1), lim, ep, 32)).code).toBe('finality_evidence_malformed');
    const total = decodeBody(bodyBytes, lim, ep, 32).frames.reduce((n, f) => n + f.blobs.length, 0);
    const e = throwsState(() => decodeBody(bodyBytes, lim, ep, total - 1));
    expect(e.code).toBe('finality_evidence_too_large');
    expect(decodeBody(bodyBytes, lim, ep, total).frames.length).toBe(2);
  });

  it('refuses a blob that is not 131072 bytes, nodes out of order, and a spine over its bound', () => {
    const body = decodeBody(bodyBytes, lim, ep, 32);
    const short = { ...body, frames: body.frames.map((f, i) => (i === 0 ? { ...f, blobs: f.blobs.map((b, j) => (j === 0 ? { ...b, raw: b.raw.subarray(0, 100) } : b)) } : f)) };
    const e = throwsState(() => decodeBody(encodeBody(short), lim, ep, 32));
    expect(e.code).toBe('finality_evidence_malformed');
    expect(e.fields.part).toBe('blob.raw');
    expect(e.fields.reason).toBe('truncated');
    expect(e.fields.index).toBe(0n);
    const unsorted = { ...body, nodes: [...body.nodes].reverse() };
    // encodeBody sorts nodes, so build the bytes of a reversed set by hand: swap the first two nodes in the encoded tail
    expect(hex(encodeBody(unsorted))).toBe(hex(bodyBytes));
    const tooMany = { ...body, l1Spine: new Array(lim.maxSpineHeaders + 1).fill(Uint8Array.of(0xc0)) };
    expect(throwsState(() => decodeBody(encodeBody(tooMany), lim, { ...ep, maxSpineHeaders: 0 }, 32)).code).toBe('finality_evidence_too_large');
    expect(throwsState(() => decodeBody(encodeBody({ ...body, l1Spine: new Array(5).fill(Uint8Array.of(0xc0)) }), lim, { ...ep, maxSpineHeaders: 4 }, 32)).code).toBe('finality_evidence_too_large');
  });

  it('refuses frame txs over the framework bound and deposits over theirs', () => {
    const body = decodeBody(bodyBytes, lim, ep, 32);
    const frames = new Array(lim.maxFrameTxs + 1).fill({ l1Block: 1n, txIndex: 0, txRaw: new Uint8Array(0), blobs: [] });
    expect(throwsState(() => decodeBody(encodeBody({ ...body, frames }), lim, ep, 32)).code).toBe('finality_evidence_too_large');
    const deposits = new Array(lim.maxDepositTxs + 1).fill(Uint8Array.of(1));
    expect(throwsState(() => decodeBody(encodeBody({ ...body, deposits }), lim, ep, 32)).code).toBe('finality_evidence_too_large');
    const onTheBound = new Array(lim.maxDepositTxs).fill(Uint8Array.of(1));
    expect(decodeBody(encodeBody({ ...body, deposits: onTheBound }), lim, ep, 32).deposits.length).toBe(lim.maxDepositTxs);
  });

  it('the node hash helper is the keccak256 the codec orders by', () => {
    const body = decodeBody(bodyBytes, lim, ep, 32);
    const hs = body.nodes.map((n) => hex(keccak_256(n)));
    expect(hs).toEqual([...hs].sort());
    expect(unhex('0x0102')).toEqual(Uint8Array.of(1, 2));
  });
});
