/**
 * RB12-TS-FIX-POSTED D2: the zlib channel header. Go's zlib.NewReader (and op-node, which reads channels with it) accepts a stream whose FDICT
 * flag is set when the 4-byte dictionary id equals adler32 of the (empty) dictionary, i.e. 00000001, and refuses any other id with
 * ErrDictionary; the header checks (method 8, window at most 7, (CMF*256+FLG) % 31 == 0) are made on the header as sent. node:zlib alone
 * answers Z_NEED_DICT for every FDICT stream, so the TypeScript channel reader (baseposted/channel.ts) decides the header itself. Every expected
 * value below was obtained from Go (pkg/finality/baseposted decompress at cbb6373: the audit's probe and the fixposted differential, 2 x 16,000
 * channels) or follows from the header rule above; the Go-recorded verdicts of the FDICT classes are also carried as data in
 * test/fixtures/finality/base_zlib_fdict1 (see vectors_zlibfdict.test.ts).
 */
import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { FinalityStateError } from '../../../src/proof-v2/finality/state.js';
import { ChannelError, decompress } from '../../../src/proof-v2/finality/baseposted/channel.js';
import { verifyChannel } from '../../../src/proof-v2/finality/baseposted/verify.js';
import { concat, hex, makeSynth, utf8 } from './synth.js';

/** The channel Go zlib.NewReader and op-node read as "abc": CMF 78, FLG 20 (FDICT, FCHECK 0), DICTID 00000001, deflate "abc", adler32. */
const FDICT_ABC = '7820000000014b4c4a0600024d0127';
const unhexBytes = (h: string): Uint8Array => Uint8Array.from(Buffer.from(h, 'hex'));
const plainAbc = (): Uint8Array => Uint8Array.from(deflateSync(utf8('abc')));
const ONE = Uint8Array.of(0, 0, 0, 1);

/** z with the FDICT flag set and the 4 dictionary id bytes after the header; FCHECK is recomputed over the header with FDICT unless told not to. */
function withDict(z: Uint8Array, id: Uint8Array, fixFcheck = true): Uint8Array {
  const h = Uint8Array.of(z[0]!, z[1]! | 0x20);
  if (fixFcheck) h[1] = (h[1]! & 0xe0) | ((31 - ((((h[0]! << 8) | (h[1]! & 0xe0)) % 31))) % 31);
  return concat(h, id, z.subarray(2));
}

/** the decompressed bytes as a latin1 string, or null when the reader refuses the channel with its named error */
function accepted(ch: Uint8Array, max = 1n << 20n): string | null {
  try {
    return Buffer.from(decompress(ch, max)).toString('latin1');
  } catch (e) {
    if (e instanceof ChannelError) return null;
    throw e;
  }
}
const refused = (ch: Uint8Array, max = 1n << 20n): boolean => accepted(ch, max) === null;

describe('a zlib channel with FDICT and the empty dictionary is read as Go and op-node read it', () => {
  it('the 15-byte channel of the audit (FDICT, DICTID 00000001 = adler32 of the empty dictionary) decompresses to "abc"', () => {
    expect(unhexBytes(FDICT_ABC).length).toBe(15);
    expect(accepted(unhexBytes(FDICT_ABC))).toBe('abc');
    // and it is exactly what the helper builds from the plain channel with FLEVEL 0: the dictionary id inserted, FCHECK recomputed
    const level0 = plainAbc();
    level0[1] = level0[1]! & 0x3f;
    expect(hex(withDict(level0, ONE))).toBe(`0x${FDICT_ABC}`);
  });

  it('any other dictionary id is refused: 0, 2, byte-order swaps, all ones and every single-bit flip of the empty-dictionary id', () => {
    const ids: Uint8Array[] = [Uint8Array.of(0, 0, 0, 0), Uint8Array.of(0, 0, 0, 2), Uint8Array.of(0, 0, 1, 0), Uint8Array.of(1, 0, 0, 0), Uint8Array.of(0xff, 0xff, 0xff, 0xff)];
    for (let bit = 0; bit < 32; bit++) {
      const id = Uint8Array.from(ONE);
      id[bit >> 3]! ^= 1 << (bit & 7);
      ids.push(id);
    }
    for (const id of ids) expect(refused(withDict(plainAbc(), id)), hex(id)).toBe(true);
    expect(refused(unhexBytes('7820000000024b4c4a0600024d0127'))).toBe(true);
  });

  it('the header check is made on the header as sent: of the 32 FCHECK values exactly the one making the header a multiple of 31 is accepted, with FDICT set', () => {
    for (let f = 0; f < 32; f++) {
      const c = unhexBytes(FDICT_ABC);
      c[1] = (c[1]! & 0xe0) | f;
      const valid = ((c[0]! << 8) | c[1]!) % 31 === 0;
      expect(accepted(c), `FCHECK ${f}`).toBe(valid ? 'abc' : null);
    }
    expect(refused(withDict(plainAbc(), ONE, false))).toBe(true);
  });

  it('a truncated dictionary id is refused: the header alone, then 1, 2 and 3 bytes of the id, then the id with nothing after it, and every proper prefix', () => {
    const full = unhexBytes(FDICT_ABC);
    for (const n of [0, 1, 2, 3, 4, 5, 6]) expect(refused(full.subarray(0, 2 + n)), `${n} id bytes`).toBe(true);
    for (let n = 1; n < full.length; n++) expect(refused(full.subarray(0, n)), `prefix ${n}`).toBe(true);
    expect(accepted(full)).toBe('abc');
  });

  it('every header is judged as Go judges it: method 8, window at most 7, (CMF*256+FLG) % 31 == 0, FDICT only with the id 00000001 (CMF x FLG sweep)', () => {
    const body = plainAbc().subarray(2);
    let acceptedPlain = 0;
    let acceptedDict = 0;
    for (let cmf = 0; cmf < 256; cmf++) {
      if (cmf === 1) continue; // the Brotli channel type
      for (let flg = 0; flg < 256; flg++) {
        const dict = (flg & 0x20) !== 0;
        const headerOk = (cmf & 0x0f) === 8 && cmf >> 4 <= 7 && ((cmf << 8) | flg) % 31 === 0;
        const got = accepted(concat(Uint8Array.of(cmf, flg), dict ? ONE : new Uint8Array(0), body));
        if (got !== (headerOk ? 'abc' : null)) expect(got, `CMF ${cmf} FLG ${flg}`).toBe(headerOk ? 'abc' : null);
        if (got !== null) {
          if (dict) acceptedDict++;
          else acceptedPlain++;
        }
        if (dict && accepted(concat(Uint8Array.of(cmf, flg), Uint8Array.of(0, 0, 0, 2), body)) !== null) expect.fail(`DICTID 2 accepted: CMF ${cmf} FLG ${flg}`);
      }
    }
    // both branches (with and without the dictionary flag) were reached by accepted headers
    expect(acceptedPlain).toBeGreaterThan(0);
    expect(acceptedDict).toBeGreaterThan(0);
  });

  it('the output cap still bounds an FDICT channel exactly (3 bytes pass at 3, fail at 2) and a bomb behind an FDICT header never exceeds the cap', () => {
    const ch = unhexBytes(FDICT_ABC);
    expect(accepted(ch, 3n)).toBe('abc');
    expect(refused(ch, 2n)).toBe(true);
    expect(refused(ch, 0n)).toBe(true);
    const bomb = withDict(Uint8Array.from(deflateSync(new Uint8Array(50_000_000))), ONE);
    expect(bomb.length).toBeLessThan(100_000);
    expect(refused(bomb, 1000n)).toBe(true);
    expect(refused(bomb, 49_999_999n)).toBe(true);
    expect(accepted(bomb, 50_000_000n)?.length).toBe(50_000_000);
  });

  it('the adler-32 trailer and the deflate body are still checked behind an FDICT header; bytes after the end of the zlib stream are ignored as Go ignores them', () => {
    const base = unhexBytes(FDICT_ABC);
    const badSum = Uint8Array.from(base);
    badSum[badSum.length - 1]! ^= 1;
    expect(refused(badSum)).toBe(true);
    expect(refused(base.subarray(0, base.length - 1))).toBe(true);
    const badBody = Uint8Array.from(base);
    badBody[7]! ^= 0xff;
    expect(refused(badBody)).toBe(true);
    expect(accepted(concat(base, Uint8Array.of(1, 2, 3)))).toBe('abc');
    expect(accepted(concat(plainAbc(), Uint8Array.of(1, 2, 3)))).toBe('abc');
  });

  it('every FLEVEL value is accepted with FDICT (the compression-level bits carry no meaning)', () => {
    for (let lvl = 0; lvl < 4; lvl++) {
      const c = plainAbc();
      c[1] = (c[1]! & 0x3f) | (lvl << 6);
      expect(accepted(withDict(c, ONE)), `FLEVEL ${lvl}`).toBe('abc');
    }
  });

  it('a synthetic Base channel compressed with FDICT and the empty dictionary verifies like the plain zlib channel and names the same fields; another dictionary id is channel_malformed', () => {
    const plain = makeSynth({ compression: 'zlib', nFrames: 3 });
    const want = verifyChannel(plain.bp, plain.body, plain.covered, plain.l2, plain.head);
    const s = makeSynth({ compression: 'zlib', nFrames: 3, compressedPrefix: (c) => withDict(c, ONE) });
    expect(verifyChannel(s.bp, s.body, s.covered, s.l2, s.head).fields).toEqual(want.fields);
    const bad = makeSynth({ compression: 'zlib', nFrames: 3, compressedPrefix: (c) => withDict(c, Uint8Array.of(0, 0, 0, 2)) });
    let e: unknown;
    try {
      verifyChannel(bad.bp, bad.body, bad.covered, bad.l2, bad.head);
    } catch (x) {
      e = x;
    }
    expect(e).toBeInstanceOf(FinalityStateError);
    expect((e as FinalityStateError).code).toBe('channel_malformed');
  });
});

/** the reason of the refusal (the ChannelError's text), or null when the channel is accepted */
function reasonOf(ch: Uint8Array, max = 1n << 20n): string | null {
  try {
    decompress(ch, max);
  } catch (e) {
    if (e instanceof ChannelError) return e.message;
    throw e;
  }
  return null;
}
const HDR = 'zlib: invalid header'; // Go compress/zlib ErrHeader
const DICT = 'zlib: invalid dictionary'; // Go compress/zlib ErrDictionary
const EOF = 'unexpected EOF'; // Go io.ErrUnexpectedEOF, what zlib.NewReader answers to a channel cut inside the header or the dictionary id

describe('the header-level refusals carry the texts of Go zlib.NewReader errors (ErrHeader, ErrDictionary, io.ErrUnexpectedEOF)', () => {
  it('a channel cut inside the 2-byte header is unexpected EOF, whatever the first byte; a channel cut after a valid plain header is the inflater\'s refusal', () => {
    for (const b of [0x78, 0x08, 0x18, 0x28, 0x38, 0x48, 0x58, 0x68]) expect(reasonOf(Uint8Array.of(b)), `first byte ${b}`).toBe(EOF);
    for (const h of [[0x78, 0x01], [0x78, 0x5e], [0x78, 0x9c], [0x78, 0xda]]) expect(reasonOf(Uint8Array.from(h))?.startsWith('decompress: '), `header ${h}`).toBe(true);
  });

  it('a header that is not a multiple of 31 is invalid, with FDICT set or not, and before any cut in the dictionary id is noticed', () => {
    expect(reasonOf(Uint8Array.of(0x78, 0x00))).toBe(HDR);
    expect(reasonOf(Uint8Array.of(0x78, 0x20))).toBe(EOF); // a valid FDICT header, id missing
    expect(reasonOf(Uint8Array.of(0x78, 0x21))).toBe(HDR); // FCHECK wrong with FDICT: judged before the id is read
    expect(reasonOf(Uint8Array.of(0x78, 0x21, 0, 0))).toBe(HDR);
    expect(reasonOf(unhexBytes('7821000000014b4c4a0600024d0127'))).toBe(HDR);
    expect(reasonOf(Uint8Array.of(0x78, 0x9d, 1, 2, 3))).toBe(HDR);
  });

  it('FDICT with a valid header: a cut inside the id (2..5 bytes) is unexpected EOF, the whole id with no stream behind it is the inflater\'s refusal, another id is invalid dictionary', () => {
    const full = unhexBytes(FDICT_ABC);
    for (const n of [2, 3, 4, 5]) expect(reasonOf(full.subarray(0, n)), `${n} bytes`).toBe(EOF);
    expect(reasonOf(full.subarray(0, 6))?.startsWith('decompress: ')).toBe(true);
    for (const id of [[0, 0, 0, 2], [0, 0, 0, 0], [1, 0, 0, 0], [0xff, 0xff, 0xff, 0xff]]) {
      expect(reasonOf(concat(full.subarray(0, 2), Uint8Array.from(id), full.subarray(6))), `id ${id}`).toBe(DICT);
      expect(reasonOf(concat(full.subarray(0, 2), Uint8Array.from(id))), `id ${id}, no stream`).toBe(DICT);
    }
    // the id is judged as a whole after the cut test: a short prefix of a wrong id is a cut, not a wrong id
    expect(reasonOf(Uint8Array.of(0x78, 0x20, 0, 0, 0))).toBe(EOF);
  });

  it('a truncated FDICT stream is refused even when the byte that is missing is a zero: the stream is never padded (adler-32 of [0xff] ends in 0x00)', () => {
    const plain = Uint8Array.from(deflateSync(Uint8Array.of(0xff)));
    expect(plain[plain.length - 1]).toBe(0);
    const ch = withDict(plain, ONE);
    expect(accepted(ch)).toBe('\xff');
    expect(refused(ch.subarray(0, ch.length - 1))).toBe(true);
    expect(refused(concat(ch.subarray(0, ch.length - 1), Uint8Array.of(1)))).toBe(true);
    // and the plain stream behaves the same
    expect(refused(plain.subarray(0, plain.length - 1))).toBe(true);
  });
});
