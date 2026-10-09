import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { core, messaging } from 'accumulate-sdk-opendlt';
import { encode } from 'accumulate-sdk-opendlt/encoding';

/**
 * accumulate-sdk-opendlt 2.5.0 fixed, upstream, the four places where 2.4.0 encoded differently from the network
 * (our RB6-F17..F20, fix 841ca5d). This file asserts that THE SDK ITSELF now produces Go's bytes, with none of this
 * package's former workarounds in the path: no zero-time stripping, no empty-struct walker, no blacklist mask, no
 * hand-built nested message. It fails on 2.4.0 and passes on 2.5.2, so a downgrade, or an upstream regression, shows up
 * here by name instead of as a hash mismatch deep inside a proof.
 *
 * The expected values are Go's own output, from certen-validator@b002eab with gitlab.com/accumulatenetwork/accumulate
 * v1.4.7-0.20260926030013-e1d1db9ebb7c: protocol.UnmarshalAccountJSON / messaging.UnmarshalMessageJSON of the same JSON,
 * then MarshalBinary. The messages are taken from the committed conformance document, so they are real Kermit data.
 */
const hex = (b: Uint8Array | number[]): string => Buffer.from(b).toString('hex');
const sha256 = (b: Uint8Array | number[]): string => createHash('sha256').update(Buffer.from(b)).digest('hex');

const doc = JSON.parse(gunzipSync(readFileSync(new URL('./fixtures/proofv2/valid.json.gz', import.meta.url))).toString('utf8'));

describe('the upstream SDK encoder produces the bytes Go produces', () => {
  it('writes an empty struct as the empty-object marker 0x80', () => {
    // A data account that inherits its authorities: its AccountAuth is empty.
    const account = (core as any).Account.fromObject({ type: 'dataAccount', url: 'acc://certen-protocol.acme/billing-receipts' });
    expect(hex(encode(account))).toBe(
      '010b022b6163633a2f2f63657274656e2d70726f746f636f6c2e61636d652f62696c6c696e672d7265636569707473030180',
    );
  });

  it("encodes a key page's transaction blacklist as the bitmask", () => {
    // updateKeyPage is bit 1 and updateAccountAuth bit 2 (protocol/enums.yml), so the mask is 0b110 = 6, written as the last field.
    const page = (core as any).Account.fromObject({
      type: 'keyPage',
      keyBook: 'acc://x.acme/book',
      url: 'acc://x.acme/book/1',
      acceptThreshold: 1,
      version: 1,
      transactionBlacklist: ['updateKeyPage', 'updateAccountAuth'],
    });
    expect(hex(encode(page))).toBe('010902136163633a2f2f782e61636d652f626f6f6b2f31040108010a06');
  });

  it('omits Go\'s zero time (0001-01-01T00:00:00Z) from the binary', () => {
    // directoryAnchor.makeMajorBlockTime is the zero time in the first major block's anchor message (495 times in the document).
    const j = doc.majors[0].anchor.message;
    expect(j.transaction.body.makeMajorBlockTime).toBe('0001-01-01T00:00:00Z');
    const msg = (messaging as any).Message.fromObject(j);
    expect(sha256(encode(msg))).toBe('0e9a2f28ff1d1a89f82640ae959aa800e99abe12d5ba2ccd5a0d50021ad17989');
    expect(hex(msg.transaction.hash())).toBe('695e39de492332fd9c835baec6b3f53b7b7a6101b810c9389af5bdbf3586caa9');
  });

  it('builds and encodes a message nested in a sequenced message', () => {
    const j = doc.evidence.anchor.message;
    expect(j.type).toBe('sequenced');
    expect(j.message?.type).toBeDefined();
    const msg = (messaging as any).Message.fromObject(j);
    // The nested message is a real class, not the plain object the 2.4.0 loader fell back to.
    expect(msg.message?.constructor?.name).not.toBe('Object');
    const bytes = encode(msg);
    expect(bytes.length).toBe(178); // Go: 356 hex characters
    expect(sha256(bytes)).toBe('cdbb68d9f81650534a50a97bfebe0b72f8efdea46d3a1dbdcb8bdc35d8f3959f');
  });
});
