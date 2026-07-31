import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, createPublicKey, verify as edVerify } from 'node:crypto';

/**
 * The keystore writes to ~/.certen/keys, so every test here redirects homedir() to a temp
 * directory. The module reads homedir at import time, which is why the mock is installed before
 * the dynamic import rather than with a top-level `vi.mock` — the latter would run after the
 * constant is already frozen.
 */
let tmpHome: string;

async function loadKeystore(): Promise<typeof import('../src/keystore.js')> {
  vi.resetModules();
  vi.doMock('node:os', async () => {
    const actual = await vi.importActual<typeof import('node:os')>('node:os');
    return { ...actual, homedir: () => tmpHome, default: { ...actual, homedir: () => tmpHome } };
  });
  vi.doMock('os', async () => {
    const actual = await vi.importActual<typeof import('os')>('os');
    return { ...actual, homedir: () => tmpHome, default: { ...actual, homedir: () => tmpHome } };
  });
  return import('../src/keystore.js');
}

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'certen-keystore-'));
});

afterEach(() => {
  vi.doUnmock('node:os');
  vi.doUnmock('os');
  rmSync(tmpHome, { recursive: true, force: true });
});

describe('keystore', () => {
  it('generates a key whose hash is sha256 of the RAW public key', async () => {
    const ks = await loadKeystore();
    const info = ks.generateKey('dev', 'correct horse battery staple');

    expect(info.publicKey).toMatch(/^[0-9a-f]{64}$/);
    expect(info.publicKeyHash).toMatch(/^[0-9a-f]{64}$/);
    // This is the contract the gateway enforces: public_key_hash must be sha256 of the raw
    // 32-byte Ed25519 key, not of its hex spelling and not of the SPKI DER. Verified against a
    // live key page on 2026-07-31; if this ever changes, identity creation silently binds the
    // wrong hash and the identity cannot sign.
    const expected = createHash('sha256').update(Buffer.from(info.publicKey, 'hex')).digest('hex');
    expect(info.publicKeyHash).toBe(expected);
  });

  it('produces a signature the public key verifies, over the hash BYTES', async () => {
    const ks = await loadKeystore();
    const info = ks.generateKey('dev', 'pw');
    const hash = 'a'.repeat(64);

    const sigHex = ks.signHash('dev', 'pw', hash);
    expect(sigHex).toMatch(/^[0-9a-f]{128}$/);

    const pub = createPublicKey({
      key: Buffer.concat([
        Buffer.from('302a300506032b6570032100', 'hex'),
        Buffer.from(info.publicKey, 'hex'),
      ]),
      format: 'der',
      type: 'spki',
    });

    // Signed over the decoded bytes...
    expect(edVerify(null, Buffer.from(hash, 'hex'), pub, Buffer.from(sigHex, 'hex'))).toBe(true);
    // ...and NOT over the ASCII of the hex string, which is the classic way to produce a
    // well-formed signature the gateway rejects.
    expect(edVerify(null, Buffer.from(hash, 'utf-8'), pub, Buffer.from(sigHex, 'hex'))).toBe(false);
  });

  it('accepts a 0x prefix and mixed case on the hash', async () => {
    const ks = await loadKeystore();
    ks.generateKey('dev', 'pw');
    const plain = ks.signHash('dev', 'pw', 'ab'.repeat(32));
    expect(ks.signHash('dev', 'pw', `0x${'AB'.repeat(32)}`)).toBe(plain);
  });

  it('rejects a non-hex or odd-length hash rather than signing garbage', async () => {
    const ks = await loadKeystore();
    ks.generateKey('dev', 'pw');
    expect(() => ks.signHash('dev', 'pw', 'nothex')).toThrow(/even-length hex/);
    expect(() => ks.signHash('dev', 'pw', 'abc')).toThrow(/even-length hex/);
  });

  it('refuses the wrong passphrase without revealing which part failed', async () => {
    const ks = await loadKeystore();
    ks.generateKey('dev', 'right');
    expect(() => ks.signHash('dev', 'wrong', 'aa')).toThrow(/wrong passphrase, or the file has been modified/);
  });

  it('never stores the private key in the clear when a passphrase is given', async () => {
    const ks = await loadKeystore();
    const info = ks.generateKey('dev', 'pw');
    const raw = readFileSync(ks.keyPath('dev'), 'utf-8');
    const parsed = JSON.parse(raw);

    expect(parsed.encryption).not.toBeNull();
    expect(parsed.encryption.kdf).toBe('scrypt');
    // The public half is expected in the file; the private half must not be recoverable from it.
    expect(raw).toContain(info.publicKey);
    expect(ks.getKeyInfo('dev').encrypted).toBe(true);
  });

  it('stores unencrypted only when explicitly asked', async () => {
    const ks = await loadKeystore();
    ks.generateKey('plain', null);
    expect(ks.getKeyInfo('plain').encrypted).toBe(false);
    // No passphrase needed to sign, which is the whole point of the escape hatch.
    expect(ks.signHash('plain', null, 'aa')).toMatch(/^[0-9a-f]{128}$/);
  });

  it('will not overwrite an existing key', async () => {
    const ks = await loadKeystore();
    ks.generateKey('dev', 'pw');
    expect(() => ks.generateKey('dev', 'other')).toThrow(/already exists/);
  });

  it('rejects names that could escape the keys directory', async () => {
    const ks = await loadKeystore();
    for (const bad of ['../evil', 'a/b', '.hidden', '', 'x'.repeat(65), 'has space']) {
      expect(() => ks.assertValidName(bad), bad).toThrow(/Invalid key name/);
    }
  });

  it('self-test passes for a good key', async () => {
    const ks = await loadKeystore();
    ks.generateKey('dev', 'pw');
    expect(ks.selfTest('dev', 'pw')).toBe(true);
  });

  it('lists keys without needing any passphrase, and survives a corrupt file', async () => {
    const ks = await loadKeystore();
    ks.generateKey('alpha', 'pw');
    ks.generateKey('beta', null);
    writeFileSync(join(tmpHome, '.certen', 'keys', 'broken.json'), 'not json', { mode: 0o600 });

    const names = ks.listKeys().map((k) => k.name);
    expect(names).toEqual(['alpha', 'beta']);
  });

  it('deletes a key', async () => {
    const ks = await loadKeystore();
    ks.generateKey('dev', 'pw');
    const path = ks.keyPath('dev');
    expect(existsSync(path)).toBe(true);
    ks.deleteKey('dev');
    expect(existsSync(path)).toBe(false);
  });

  it('gives an actionable error for a key that does not exist', async () => {
    const ks = await loadKeystore();
    expect(() => ks.getKeyInfo('nope')).toThrow(/certen keys generate --name nope/);
  });
});
