import { describe, expect, it } from 'vitest';
import { account, encodeObject, sdkEncode } from '../src/proof-v2/accumulate.js';
import { toHex } from '../src/proof-v2/bytes.js';

/**
 * Each place the verifier departs from accumulate-sdk-opendlt's own encoding is pinned to the bytes Go produced for the
 * same object (certen-validator, live Kermit state, 2026-10-04). If the SDK is fixed upstream, these keep proving the
 * verifier still matches Go.
 */
describe('Go-faithful encoding', () => {
  it('writes an empty struct as the empty-object marker 0x80, as Go does', () => {
    // A data account that inherits its authorities: its AccountAuth is empty.
    const json = { type: 'dataAccount', url: 'acc://certen-protocol.acme/billing-receipts' };
    const go =
      '010b022b6163633a2f2f63657274656e2d70726f746f636f6c2e61636d652f62696c6c696e672d7265636569707473030180';
    expect(toHex(encodeObject(account(json, 'test')))).toBe(go);
    // accumulate-sdk-opendlt >= 2.5.0 writes it the same way (test/upstream-encoder.test.ts pins that).
    expect(toHex(sdkEncode(account(json, 'test')))).toBe(go);
  });

  it("encodes a key page's transaction blacklist as Go's bitmask", () => {
    const page = (blacklist: unknown) =>
      account(
        {
          type: 'keyPage',
          keyBook: 'acc://x.acme/book',
          url: 'acc://x.acme/book/1',
          acceptThreshold: 1,
          version: 1,
          transactionBlacklist: blacklist,
        },
        'test',
      );
    // updateKeyPage is bit 1 and updateAccountAuth bit 2 (protocol/enums.yml): the mask is 0b110.
    expect(page(['updateKeyPage', 'updateAccountAuth']).transactionBlacklist).toBe(6);
    expect(page(['updateKeyPage']).transactionBlacklist).toBe(2);
    expect(() => page(['transferTokens'])).toThrow(/nknown (transaction blacklist bit|AllowedTransactionBit)/);
  });
});
