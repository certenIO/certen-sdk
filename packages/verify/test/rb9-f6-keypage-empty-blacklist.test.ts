import { describe, expect, it } from 'vitest';
import { baseBytes, bytesEvidenceLength } from './helpers/s3-bytes.js';

/**
 * RB9-F6 step 3, found by the Go-judged null-before-the-value corpus (test/s3-bytes-nulldup-N.test.ts, op null-then-empty-list): a key page's
 * transactionBlacklist is held by pointer (protocol.KeyPage: `TransactionBlacklist *AllowedTransactions`), and the generated binary writer writes it whenever the
 * pointer is not nil (`writer.WriteEnum(10, *v.TransactionBlacklist)`), whatever the mask. The JSON `[]` allocates the pointer with no bit set, so a page whose
 * blacklist is spelled `[]` carries the field (tag 10, value 0: two bytes, four hex digits in the evidence), a page that has no member or a null does not.
 * The verifier left a zero mask out like any zero value, so the state it hashed for such a page was not the state Go hashes.
 *
 * The evidence lengths are Go's (cmd/xtsgen judgefile at validator pv2/rb9-f6-genesis-link-required ba4b70f, on proofv2/valid.json.gz with only this member
 * changed): the evidence document counts the account's state in hex.
 */
const MEMBER = '"transactionBlacklist":["updateKeyPage","updateAccountAuth"]';
const valid = baseBytes('proofv2/valid.json.gz').toString('utf8');
const withMember = (text: string): Buffer => {
  const at = valid.indexOf(MEMBER);
  if (at < 0) throw new Error('the fixture has no transactionBlacklist');
  return Buffer.from(valid.slice(0, at) + text + valid.slice(at + MEMBER.length), 'utf8');
};

describe('a key page whose transactionBlacklist is spelled [] carries the field, as Go writes it', () => {
  it('the member as the fixture has it', () => {
    expect(bytesEvidenceLength(withMember(MEMBER))).toBe(731778);
  });
  it('one name: the field is written', () => {
    expect(bytesEvidenceLength(withMember('"transactionBlacklist":["updateKeyPage"]'))).toBe(731778);
  });
  it('[]: a non-nil pointer to the zero mask, the field is written (Go 731778)', () => {
    expect(bytesEvidenceLength(withMember('"transactionBlacklist":[]'))).toBe(731778);
  });
  it('null, then []: the pointer is allocated again, the field is written (Go 731778)', () => {
    expect(bytesEvidenceLength(withMember('"transactionBlacklist":null,"transactionBlacklist":[]'))).toBe(731778);
  });
  it('[], then null: the pointer is nil, the field is not written (Go 731774)', () => {
    expect(bytesEvidenceLength(withMember('"transactionBlacklist":[],"transactionBlacklist":null'))).toBe(731774);
  });
  it('null: the pointer is nil, the field is not written (Go 731774)', () => {
    expect(bytesEvidenceLength(withMember('"transactionBlacklist":null'))).toBe(731774);
  });
  it('no member: the field is not written (Go 731774)', () => {
    expect(bytesEvidenceLength(withMember('"x":1'))).toBe(731774);
  });
});
