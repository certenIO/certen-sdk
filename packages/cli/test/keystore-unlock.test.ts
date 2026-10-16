import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * Unlocking a key once, when it is opened.
 *
 * `signHash` derives the file key and decrypts on every call: about a second of scrypt each time, and a WRONG passphrase surfaced only when
 * the signature was made, after the intent was open and a person had read the card and said yes, as an untyped error. `resolveSigner` now
 * unlocks once, so the failure comes first and costs nothing, is typed (`WRONG_PASSPHRASE`), and the signing afterwards is instant.
 */
let tmpHome = '';
beforeEach(() => { tmpHome = mkdtempSync(join(tmpdir(), 'certen-unlock-')); });
afterEach(() => {
  vi.doUnmock('node:os');
  vi.doUnmock('os');
  vi.restoreAllMocks();
  rmSync(tmpHome, { recursive: true, force: true });
});

async function load() {
  vi.resetModules();
  const home = () => tmpHome;
  vi.doMock('node:os', async () => ({ ...(await vi.importActual<typeof import('node:os')>('node:os')), homedir: home }));
  vi.doMock('os', async () => ({ ...(await vi.importActual<typeof import('os')>('os')), homedir: home }));
  return { ks: await import('../src/keystore.js'), signer: await import('../src/signer.js') };
}

describe('unlockKey', () => {
  it('signs exactly what signHash signs, from one derivation', async () => {
    const { ks } = await load();
    ks.generateKey('dev', 'pw');
    const hash = 'ab'.repeat(32);
    const unlocked = ks.unlockKey('dev', 'pw');
    // Ed25519 is deterministic: the same bytes, the same signature, whichever route made it.
    expect(unlocked.sign(hash)).toBe(ks.signHash('dev', 'pw', hash));
    expect(unlocked.sign(`0x${hash.toUpperCase()}`)).toBe(unlocked.sign(hash));
  });

  it('signs the BYTES of the hash, not its text', async () => {
    const { ks } = await load();
    ks.generateKey('dev', null);
    const unlocked = ks.unlockKey('dev', null);
    expect(unlocked.sign('aa')).not.toBe(unlocked.sign('6161'));
  });

  it('refuses a wrong passphrase at once, without revealing which part failed', async () => {
    const { ks } = await load();
    ks.generateKey('dev', 'right');
    expect(() => ks.unlockKey('dev', 'wrong')).toThrow(/Could not decrypt key "dev" — wrong passphrase, or the file has been modified/);
  });

  it('still refuses an encrypted key with no passphrase, and an unencrypted key needs none', async () => {
    const { ks } = await load();
    ks.generateKey('locked', 'pw');
    ks.generateKey('open', null);
    expect(() => ks.unlockKey('locked', null)).toThrow(/is encrypted — a passphrase is required/);
    expect(() => ks.unlockKey('open', null)).not.toThrow();
  });

  it('keeps the hash validation: a malformed hash is refused when signing, not when unlocking', async () => {
    const { ks } = await load();
    ks.generateKey('dev', null);
    const unlocked = ks.unlockKey('dev', null);
    expect(() => unlocked.sign('nothex')).toThrow(/even-length hex/);
    expect(() => unlocked.sign('abc')).toThrow(/even-length hex/);
  });
});

describe('resolveSigner', () => {
  it('a wrong passphrase ends it as WRONG_PASSPHRASE (exit 1), before anything is opened or signed', async () => {
    const { ks, signer } = await load();
    ks.generateKey('dev', 'right');
    process.env.CERTEN_KEY_PASSPHRASE = 'wrong';
    try {
      await expect(signer.resolveSigner('dev')).rejects.toMatchObject({ code: 'WRONG_PASSPHRASE', exitCode: 1 });
    } finally {
      delete process.env.CERTEN_KEY_PASSPHRASE;
    }
  });

  it('the right passphrase gives a signer that signs without deriving the key again', async () => {
    const { ks, signer } = await load();
    const info = ks.generateKey('dev', 'right');
    process.env.CERTEN_KEY_PASSPHRASE = 'right';
    try {
      const s = await signer.resolveSigner('dev');
      expect(s.publicKey).toBe(info.publicKey);
      expect(s.publicKeyHash).toBe(info.publicKeyHash);
      const started = Date.now();
      const sig = s.sign('cd'.repeat(32));
      // scrypt at these parameters is ~1 second; a signature from the held key is not. (A bound far above any signature and far below a derivation.)
      expect(Date.now() - started).toBeLessThan(500);
      expect(sig).toBe(ks.signHash('dev', 'right', 'cd'.repeat(32)));
    } finally {
      delete process.env.CERTEN_KEY_PASSPHRASE;
    }
  });
});
