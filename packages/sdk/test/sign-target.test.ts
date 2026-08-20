import { describe, it, expect } from 'vitest';
import { resolveSignTarget } from '../src/sign-target.js';
import { CertenError } from '../src/errors.js';

const HASH = 'a'.repeat(63) + 'b';
const UPPER = HASH.toUpperCase();

describe('resolveSignTarget', () => {
  const ok: Array<[string, string, { type: string; targetId: string }]> = [
    ['inbox id (UUID)', 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
      { type: 'pending_action', targetId: 'f47ac10b-58cc-4372-a567-0e02b2c3d479' }],
    ['UUID with uppercase', 'F47AC10B-58CC-4372-A567-0E02B2C3D479',
      { type: 'pending_action', targetId: 'F47AC10B-58CC-4372-A567-0E02B2C3D479' }],
    ['64 lowercase hex', HASH, { type: 'pending_tx', targetId: HASH }],
    ['64 UPPERCASE hex', UPPER, { type: 'pending_tx', targetId: HASH }],
    ['0x-prefixed hash', `0x${HASH}`, { type: 'pending_tx', targetId: HASH }],
    ['TxID', `acc://${HASH}@certen-x.acme/enrollments`, { type: 'pending_tx', targetId: HASH }],
    ['TxID with no account', `acc://${HASH}@`, { type: 'pending_tx', targetId: HASH }],
    ['TxID with uppercase hash', `acc://${UPPER}@certen-x.acme/enrollments`,
      { type: 'pending_tx', targetId: HASH }],
    ['surrounding whitespace', `  ${HASH}  `, { type: 'pending_tx', targetId: HASH }],
  ];

  for (const [name, input, expected] of ok) {
    it(`resolves ${name}`, () => {
      expect(resolveSignTarget(input)).toEqual(expected);
    });
  }

  const bad: Array<[string, string]> = [
    ['63 hex', 'a'.repeat(63)],
    ['65 hex', 'a'.repeat(65)],
    ['non-hex of the right length', 'z'.repeat(64)],
    // An account URL is not a TxID. Accepting one would send a key page URL as a transaction hash.
    ['an account URL', 'acc://alice.acme/book'],
    ['a TxID whose hash is short', `acc://${'a'.repeat(63)}@alice.acme`],
    ['empty', ''],
    ['whitespace only', '   '],
    ['a UUID missing a group', 'f47ac10b-58cc-4372-0e02b2c3d479'],
  ];

  for (const [name, input] of bad) {
    it(`rejects ${name}`, () => {
      expect(() => resolveSignTarget(input)).toThrow(CertenError);
      try {
        resolveSignTarget(input);
      } catch (err) {
        expect((err as CertenError).code).toBe('INVALID_SIGN_TARGET');
        // The message must name every accepted form — a caller who guessed wrong needs to see the
        // whole menu, not just that their guess failed.
        const msg = (err as Error).message;
        expect(msg).toContain('UUID');
        expect(msg).toContain('64-character transaction hash');
        expect(msg).toContain('0x');
        expect(msg).toContain('acc://<hash>@<account>');
      }
    });
  }

  it('never resolves to the transaction type', () => {
    // `transaction` is rejected by the gateway; no user string should reach it.
    for (const [, input] of ok) {
      expect(['pending_action', 'pending_tx']).toContain(resolveSignTarget(input).type);
    }
  });
});
