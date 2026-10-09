import { describe, it, expect } from 'vitest';
import { generateKeyPairSync, sign as nodeSign, createHash } from 'node:crypto';
import { verifyReceipt, canonicalJson } from '../src/verify-receipt.js';
import type { CertenClient } from '../src/client.js';

/**
 * verifyReceipt on Web Crypto + the SDK's own sha256, instead of node:crypto, so it runs in a browser too.
 * A runtime that cannot verify ed25519 reports the signature as skipped ("could not check"), never as ok.
 */
const body = { amount_usd: '1.25', kind: 'fee' };
const digest = createHash('sha256').update(canonicalJson(body)).digest('hex');
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const pubHex = (publicKey.export({ format: 'der', type: 'spki' }) as Buffer).subarray(-32).toString('hex');
const sigHex = nodeSign(null, Buffer.from(digest, 'hex'), privateKey).toString('hex');

function clientWith(over: { signature?: string; proof?: Record<string, unknown> | null } = {}): CertenClient {
  return {
    billing: {
      receipt: async () => ({ body, digest, signature: over.signature ?? sigHex, key_id: 'k1' }),
      verificationKeys: async () => ({ keys: [{ key_id: 'k1', public_key: pubHex }] }),
      receiptProof: async () => {
        if (over.proof === null) throw new Error('not in the log');
        return over.proof ?? { leaf_salt: '00', leaf_hash: '', leaf_index: 0, tree_size: 1, audit_path: [] };
      },
    },
    transparency: { head: async () => { throw new Error('no head'); } },
  } as unknown as CertenClient;
}
const status = (r: Awaited<ReturnType<typeof verifyReceipt>>, name: string) => r.checks.find((c) => c.name === name)?.status;

describe('verifyReceipt without node:crypto', () => {
  it('verifies a real ed25519 signature and the digest', async () => {
    const r = await verifyReceipt(clientWith({ proof: null }), 'r1');
    expect(status(r, 'digest')).toBe('ok');
    expect(status(r, 'signature')).toBe('ok');
  });

  it('fails a signature that does not verify', async () => {
    const bad = nodeSign(null, Buffer.from('00'.repeat(32), 'hex'), privateKey).toString('hex');
    const r = await verifyReceipt(clientWith({ signature: bad, proof: null }), 'r1');
    expect(status(r, 'signature')).toBe('failed');
    expect(r.verified).toBe(false);
  });

  it('fails (not throws) on a malformed signature', async () => {
    const r = await verifyReceipt(clientWith({ signature: 'zz', proof: null }), 'r1');
    expect(status(r, 'signature')).toBe('failed');
  });

  it('reports the signature as skipped, never ok, where the runtime has no Web Crypto ed25519', async () => {
    const real = globalThis.crypto;
    for (const fake of [
      { getRandomValues: real.getRandomValues.bind(real) },                                                   // no subtle at all
      { getRandomValues: real.getRandomValues.bind(real), subtle: { importKey: async () => { throw Object.assign(new Error('x'), { name: 'NotSupportedError' }); }, verify: async () => true } },
    ]) {
      Object.defineProperty(globalThis, 'crypto', { value: fake, configurable: true });
      try {
        const r = await verifyReceipt(clientWith({ proof: null }), 'r1');
        expect(status(r, 'signature')).toBe('skipped');
        expect(r.checks.find((c) => c.name === 'signature')?.detail).toMatch(/Could not verify the ed25519 signature/);
        expect(r.verified).toBe(false);
        expect(r.complete).toBe(false);
      } finally {
        Object.defineProperty(globalThis, 'crypto', { value: real, configurable: true });
      }
    }
  });

  it('turns malformed hex in an inclusion proof into a failed check with a reason instead of an exception', async () => {
    const r = await verifyReceipt(clientWith({ proof: { leaf_salt: 'nothex', leaf_hash: 'ab', leaf_index: 0, tree_size: 1, audit_path: [] } }), 'r1');
    expect(status(r, 'inclusion')).toBe('failed');
    expect(r.checks.find((c) => c.name === 'inclusion')?.detail).toMatch(/malformed/);
    expect(status(r, 'root')).toBe('skipped');
    expect(r.verified).toBe(false);
  });
});
