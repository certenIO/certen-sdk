import { describe, expect, it } from 'vitest';
import { baseBytes, bytesEvidenceLength, judgeBytes } from './helpers/s3-bytes.js';

/**
 * RB9-F6 step 3, review V-Q D1: a duplicated "transactionBlacklist" key. protocol.KeyPage holds the member as `*AllowedTransactions`, and
 * AllowedTransactions.UnmarshalJSON (accumulate v1.4.7-0.20260926030013-e1d1db9ebb7c protocol/access_control.go:93-103) does `v.Set(bit)` for each bit named
 * onto the pointer it is given: it never clears. So the occurrences of the key OR their bits together onto one pointer; a JSON null sets the pointer to nil, and the
 * first list after a null allocates a fresh, empty one; any list, even `[]`, leaves the pointer allocated, and a page whose pointer is allocated carries tag 10
 * in its state (see rb9-f6-keypage-empty-blacklist.test.ts). The verifier replaced the mask with the last list instead.
 *
 * The document is the real Kermit capture (unmodified it is refused certify_link_missing{genesis}, after its five page receipts verified), whose pages[4] (book/2)
 * carries `["updateKeyPage","updateAccountAuth"]`. A page whose state is the one the receipt proves passes the page check and the document reaches the link
 * refusal; any other state is refused at the page. The verdicts and the evidence lengths (the length counts the account's state in hex, so it shows whether tag 10
 * was written: 119974 with, 119970 without) are Go's (cmd/xtsgen judgefile at validator pv2/rb9-f6-genesis-link-required c93f5ac); the member is replaced by the
 * text named, nothing else is changed.
 */
const REAL = 'go-written/real-bvn1-billing-receipts.portable.json.gz';
const MEMBER = '"transactionBlacklist":["updateKeyPage","updateAccountAuth"]';
const A = '"updateKeyPage"';
const B = '"updateAccountAuth"';
const key = (v: string, name = 'transactionBlacklist'): string => `"${name}":${v}`;
const LINK = 'certify_link_missing{genesis}';
const PAGE = "page: acc://certen-protocol.acme/book/2: the receipt does not start at the state's hash";

const real = baseBytes(REAL).toString('utf8');
const withMember = (text: string): Buffer => {
  const at = real.indexOf(MEMBER);
  if (at < 0) throw new Error('the real document has no transactionBlacklist');
  return Buffer.from(real.slice(0, at) + text + real.slice(at + MEMBER.length), 'utf8');
};

const cases: [string, string, string, number][] = [
  ['the member as the capture has it', MEMBER, LINK, 119974],
  ['[A,B] then []: [] adds no bit', `${MEMBER},${key('[]')}`, LINK, 119974],
  ['[A] then [B]: the bits are ORed', `${key(`[${A}]`)},${key(`[${B}]`)}`, LINK, 119974],
  ['[] then [A,B]', `${key('[]')},${MEMBER}`, LINK, 119974],
  ['[A,B] then [A]', `${MEMBER},${key(`[${A}]`)}`, LINK, 119974],
  ['[A] then [A,B]', `${key(`[${A}]`)},${MEMBER}`, LINK, 119974],
  ['null then [A,B]: the pointer is allocated again', `${key('null')},${MEMBER}`, LINK, 119974],
  ['null, [A], [B]: allocated by the first list, ORed by the second', `${key('null')},${key(`[${A}]`)},${key(`[${B}]`)}`, LINK, 119974],
  ['the key in upper case adds to the same pointer', `${key(`[${A}]`)},${key(`[${B}]`, 'TRANSACTIONBLACKLIST')}`, LINK, 119974],
  ['[A,B] then null: the pointer is nil, tag 10 is not written', `${MEMBER},${key('null')}`, PAGE, 119970],
  ['[A], null, [B]: the null cleared A, only B is left', `${key(`[${A}]`)},${key('null')},${key(`[${B}]`)}`, PAGE, 119974],
  ['[] then []: an allocated pointer with no bit, tag 10 is written but the state is not the proven one', `${key('[]')},${key('[]')}`, PAGE, 119974],
];

describe('a duplicated transactionBlacklist key ORs its bits onto one pointer, as AllowedTransactions.UnmarshalJSON does', () => {
  for (const [name, text, want, evLen] of cases) {
    it(name, () => {
      const doc = withMember(text);
      const j = judgeBytes(doc);
      expect(j.v).toBe('plain');
      expect((j as { message: string }).message.startsWith(want), (j as { message: string }).message).toBe(true);
      expect(bytesEvidenceLength(doc)).toBe(evLen);
    });
  }
});

/**
 * The same rule seen from the other side: a page whose JSON carries `"transactionBlacklist":[]` while the state its receipt proves has no tag 10 was verified by
 * c94d780 (the zero mask was dropped) and is refused now, as Go refuses it. pages[3] of the capture is book/1, which has no blacklist. (A document Go builds never
 * has `[]` there: AllowedTransactions.Unpack returns a nil slice for a zero mask, which marshals as null.)
 */
describe('[] injected into a page that has no blacklist', () => {
  it('is refused at the page: the state it describes is not the proven one (Go evidence length 119978)', () => {
    const backslash = String.fromCharCode(92);
    const pages = real.indexOf('"pages":[');
    const account = real.indexOf('"account":{', real.indexOf('"url":"acc://certen-protocol.acme/book/1"', pages));
    let depth = 0;
    let end = -1;
    for (let p = account + 11; p < real.length && end < 0; p++) {
      const c = real[p]!;
      if (c === '"') {
        for (p++; real[p] !== '"'; p++) if (real[p] === backslash) p++;
      } else if (c === '{') depth++;
      else if (c === '}') {
        if (depth === 0) end = p;
        else depth--;
      }
    }
    expect(end).toBeGreaterThan(account);
    const doc = Buffer.from(real.slice(0, end) + ',"transactionBlacklist":[]' + real.slice(end), 'utf8');
    const j = judgeBytes(doc);
    expect(j.v).toBe('plain');
    expect((j as { message: string }).message.startsWith("page: acc://certen-protocol.acme/book/1: the receipt does not start at the state's hash")).toBe(true);
    expect(bytesEvidenceLength(doc)).toBe(119978);
  });
});
