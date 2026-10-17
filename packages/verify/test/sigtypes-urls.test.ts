import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { binaryBytes, binaryString, canonicalAccTxId, canonicalAccUrl, goText } from '../src/sigtypes/gourl.js';
import { readFixture } from './helpers/sigtypes.js';

/**
 * Accumulate's URL reader and writer, against Accumulate. A signature's signer and delegator URLs are strings in its binary
 * encoding that Accumulate's reader parses (and refuses the whole object over a bad one) and its writer re-emits in canonical
 * form, and that canonical spelling is what the signature's metadata hash covers. gourl.ts ports net/url's Parse and accumulate's
 * pkg/url over byte strings; this corpus is Accumulate's own url.Parse(s).String() and url.ParseTxID(s).String() on 3,077 byte
 * strings: the hand-picked cases that exercise each rule (scheme, authority, user info, ports, IPv6 literals, percent-escapes,
 * control characters, non-ASCII, queries and fragments, trailing and repeated slashes) and random byte-level mutations of them.
 * The Go program that wrote it is test/fixtures/sigtypes/urls.gen.go.txt.
 */
const raw = readFixture('urls.json');
const URLS_SHA256 = 'f2306c54a55de356493056f916050215e97aa5360c234d27db3cb233c863d4db';
interface Case {
  in: string;
  out: string | null;
}
const file = JSON.parse(raw.toString('utf8')) as { format: string; urls: Case[]; txids: Case[] };
const bin = (hex: string): string => binaryString(new Uint8Array(Buffer.from(hex, 'hex')));
const hexOf = (s: string): string => Buffer.from(binaryBytes(s)).toString('hex');

describe('Accumulate URLs, against Accumulate', () => {
  it('is the file the Go program wrote', () => {
    expect(createHash('sha256').update(raw).digest('hex')).toBe(URLS_SHA256);
    expect(file.format).toBe('certen:acc-urls:v1');
    expect(file.urls.length).toBe(3077);
    expect(file.txids.length).toBe(3077);
    // both the accepted and the refused are well represented
    expect(file.urls.filter((c) => c.out !== null).length).toBe(1398);
    expect(file.txids.filter((c) => c.out !== null).length).toBe(70);
  });

  it('parses and writes every URL as url.Parse(s).String(), and refuses every one Accumulate refuses', () => {
    const wrong: string[] = [];
    for (const c of file.urls) {
      const got = canonicalAccUrl(bin(c.in));
      const gotHex = got === undefined ? null : hexOf(got);
      if (gotHex !== c.out) wrong.push(`${JSON.stringify(Buffer.from(c.in, 'hex').toString('latin1'))}: Go ${c.out === null ? 'refuses' : JSON.stringify(Buffer.from(c.out, 'hex').toString('latin1'))}, here ${got === undefined ? 'refuses' : JSON.stringify(got)}`);
    }
    expect(wrong).toEqual([]);
  });

  it('parses and writes every transaction id as url.ParseTxID(s).String(), and refuses every one Accumulate refuses', () => {
    const wrong: string[] = [];
    for (const c of file.txids) {
      const got = canonicalAccTxId(bin(c.in));
      const gotHex = got === undefined ? null : hexOf(got);
      if (gotHex !== c.out) wrong.push(`${JSON.stringify(Buffer.from(c.in, 'hex').toString('latin1'))}: Go ${c.out === null ? 'refuses' : 'accepts'}, here ${got === undefined ? 'refuses' : 'accepts'}`);
    }
    expect(wrong).toEqual([]);
  });
});

describe('Go strings in JSON', () => {
  it('replaces each byte of an invalid UTF-8 sequence with U+FFFD, as json.Marshal does, and keeps valid UTF-8', () => {
    expect(goText(binaryString(new TextEncoder().encode('héllo ✓ 𝄞')))).toBe('héllo ✓ 𝄞');
    expect(goText('\xe3\x81')).toBe('��'); // a truncated 3-byte sequence: two bad bytes, not one
    expect(goText('a\xffb')).toBe('a�b');
    expect(goText('\xc0\xaf')).toBe('��'); // overlong
    expect(goText('\xed\xa0\x80')).toBe('���'); // a surrogate
    expect(goText('\xf4\x90\x80\x80')).toBe('����'); // above U+10FFFF
  });
});
