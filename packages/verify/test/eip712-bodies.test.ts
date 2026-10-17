import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { decodeSignature, decodeTransaction, eip712Hash, encodeNode, transactionHash, type WireNode } from '../src/sigtypes/index.js';

/**
 * The EIP-712 digest of a typedData signature over every user transaction body type, against Accumulate's own
 * protocol.EIP712Hash. The 154 shared sigtypes vectors sign one body (WriteData); this corpus is the same check across all of
 * them: for each of the 23 user body types that EIP-712 reaches (acmeFaucet ... activateProtocolVersion), 16 transactions are
 * populated reflectively from deterministic seeds - every field kind, sparse and dense, every member of the three unions
 * (DataEntry, KeyPageOperation, AccountAuthOperation) - and signed in a typedData signature wrapped in 0, 1 or 2 delegations
 * under chain id DevNet's or Kermit's. The Go program that wrote it is test/fixtures/sigtypes/eip712-bodies.gen.go.txt.
 *
 * A vector with an `error` is one Accumulate's EIP712Hash refuses (for example a body whose EIP-712 type is not registered:
 * Accumulate's Verify returns false there); the TypeScript port must refuse the same ones, not produce a digest for them.
 */
const dir = new URL('./fixtures/sigtypes/', import.meta.url);
const raw = readFileSync(new URL('eip712-bodies.json', dir));
const BODIES_SHA256 = '96d758026fec16c6ce382951ec7792d182c2cfc1890ef55207fde1789c2770d5';

interface Vector {
  id: string;
  body: string;
  transaction: string;
  txHash: string;
  signature: string;
  chainId: string;
  hash?: string;
  error?: string;
}
const file = JSON.parse(raw.toString('utf8')) as { format: string; accumulate: string; vectors: Vector[] };
const fromHex = (h: string): Uint8Array => new Uint8Array(Buffer.from(h, 'hex'));
const toHex = (b: Uint8Array): string => Buffer.from(b).toString('hex');

describe('EIP-712 over every user transaction body, against Accumulate', () => {
  it('is the file the Go program wrote', () => {
    expect(createHash('sha256').update(raw).digest('hex')).toBe(BODIES_SHA256);
    expect(file.format).toBe('certen:eip712-bodies:v1');
    expect(file.accumulate).toBe('gitlab.com/accumulatenetwork/accumulate v1.4.7-0.20260926030013-e1d1db9ebb7c');
    expect(file.vectors.length).toBe(381);
  });

  it('reaches every user body type, with digests and with refusals', () => {
    const accepted = new Set(file.vectors.filter((v) => v.hash).map((v) => v.body));
    expect([...accepted].sort()).toEqual(
      [
        'acmeFaucet', 'activateProtocolVersion', 'addCredits', 'burnCredits', 'burnTokens', 'createDataAccount', 'createIdentity', 'createKeyBook',
        'createKeyPage', 'createLiteTokenAccount', 'createToken', 'createTokenAccount', 'issueTokens', 'lockAccount', 'releaseLockedOperation',
        'sendTokens', 'setLiteAccountDelegate', 'transferCredits', 'updateAccountAuth', 'updateKey', 'updateKeyPage', 'writeData', 'writeDataTo',
      ].sort(),
    );
    expect(file.vectors.filter((v) => v.error).length).toBe(60);
    expect(new Set(file.vectors.map((v) => v.body)).has('networkMaintenance')).toBe(true);
  });

  it('reaches every member of the three unions, the factom entry and the empty struct-valued fields', () => {
    const seen = new Set<string>();
    const walk = (n: WireNode): void => {
      seen.add(n.cls);
      for (const x of n.fields.values()) for (const y of Array.isArray(x) ? x : [x]) if (typeof y === 'object' && y !== null && 'cls' in y) walk(y as WireNode);
    };
    for (const v of file.vectors) walk(decodeTransaction(fromHex(v.transaction)));
    for (const m of [
      'AccumulateDataEntry', 'DoubleHashDataEntry', 'FactomDataEntryWrapper',
      'AddKeyOperation', 'RemoveKeyOperation', 'UpdateKeyOperation', 'SetThresholdKeyPageOperation', 'UpdateAllowedKeyPageOperation',
      'SetRejectThresholdKeyPageOperation', 'SetResponseThresholdKeyPageOperation',
      'EnableAccountAuthOperation', 'DisableAccountAuthOperation', 'AddAccountAuthorityOperation', 'RemoveAccountAuthorityOperation',
      'ExpireOptions', 'HoldUntilOptions', 'HashLockOptions', 'KeySpecParams', 'TokenRecipient', 'SetLiteAccountDelegate',
    ]) {
      expect(seen.has(m), m).toBe(true);
    }
  });

  for (const v of file.vectors) {
    it(`${v.id}: ${v.hash ? 'digest ' + v.hash.slice(0, 12) : 'refused'}`, () => {
      const txn = decodeTransaction(fromHex(v.transaction));
      const sig = decodeSignature(fromHex(v.signature));
      // the decoder is faithful: re-marshalling gives the bytes it was given, and the transaction hashes as Accumulate hashes it
      expect(toHex(encodeNode(txn))).toBe(v.transaction);
      expect(toHex(encodeNode(sig))).toBe(v.signature);
      expect(toHex(transactionHash(txn))).toBe(v.txHash);
      if (v.error) {
        expect(() => eip712Hash(txn, sig), v.error).toThrow();
      } else {
        expect(toHex(eip712Hash(txn, sig))).toBe(v.hash);
      }
    });
  }
});
