import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { messageHash, sequencedMessage, SPINE_SIGNATURE_TYPES, verifySignature } from '../src/proof-v2/accumulate.js';
import { toHex, VerifyError } from '../src/proof-v2/bytes.js';

/**
 * The key signatures a Directory anchor may carry, against Go: certen-validator cmd/netrecordvectors builds a Directory anchor,
 * signs it with each type the spine accepts, and records both the bytes and Go's own `KeySignature.Verify` verdict. The
 * message hash must be the one Go computed, and the verdict the one Go reached, for the valid signature and for each tamper.
 */
const { vectors } = JSON.parse(readFileSync(new URL('./fixtures/keysignatures.json', import.meta.url), 'utf8')) as {
  vectors: { name: string; type: string; message: unknown; messageHash: string; signature: Record<string, unknown>; valid: boolean }[];
};

describe('key signatures, against Go', () => {
  it('covers every type the spine accepts, valid and tampered', () => {
    expect([...new Set(vectors.map((v) => v.type))].sort()).toEqual([...SPINE_SIGNATURE_TYPES].sort());
    expect(vectors.filter((v) => v.valid).length).toBe(SPINE_SIGNATURE_TYPES.length);
    expect(vectors.filter((v) => !v.valid).length).toBe(SPINE_SIGNATURE_TYPES.length * 2);
  });

  for (const v of vectors) {
    it(`${v.name}: the message hashes as Go hashes it, and Go's verdict (${v.valid}) is reproduced`, () => {
      const hash = messageHash(sequencedMessage(v.message, 'anchor'));
      expect(toHex(hash)).toBe(v.messageHash);
      expect(verifySignature(v.signature, hash, v.name)).toBe(v.valid);
    });
  }

  it('refuses a key signature type the spine does not accept, by name', () => {
    const v = vectors[0];
    expect(() => verifySignature({ ...v.signature, type: 'btc' }, new Uint8Array(32), 'x')).toThrow(VerifyError);
    expect(() => verifySignature({ ...v.signature, type: 'btc' }, new Uint8Array(32), 'x')).toThrow(/signature_type_unsupported/);
  });
});
