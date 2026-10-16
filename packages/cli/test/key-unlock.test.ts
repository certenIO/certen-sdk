import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createPublicKey, verify as edVerify } from 'node:crypto';

/**
 * Keeping a key unlocked for a while (src/session-unlock.ts), at the level of the functions.
 *
 * The feature ships behind a security review and is INERT unless CERTEN_EXPERIMENTAL_KEY_UNLOCK=1, so half of what is pinned here is what it
 * does NOT do: with the switch off nothing is created, nothing is read (a planted entry is not even looked at), and nothing about signing
 * changes. The other half is that a session is a CLAIM read back from a store every process of the user shares, so each use re-checks it, and an
 * entry that fails any check is removed and the passphrase is asked for as before.
 *
 * Everything runs in-process against an in-memory keyring, a throwaway HOME (the real ~/.certen is never touched: `homedir` is mocked
 * before the key store is imported) and an injected clock. Keys are real (scrypt, so a little under a second each) and made once.
 */

const HOME = mkdtempSync(join(tmpdir(), 'certen-keyunlock-'));
const PW = 'correct horse';
const T0 = Date.UTC(2026, 9, 16, 12, 0, 0);
const MIN = 60_000;
const HOUR = 60 * MIN;
const SWITCH = 'CERTEN_EXPERIMENTAL_KEY_UNLOCK';
const HASH = 'ab'.repeat(32);

type KS = typeof import('../src/keystore.js');
type SU = typeof import('../src/session-unlock.js');
type Keyring = import('../src/config.js').Keyring;

interface Mem extends Keyring { store: Map<string, string>; calls: { set: number; get: number; del: number } }

/** An in-memory OS keyring that counts what is asked of it and can be told to fail. */
function memKeyring(fail: { set?: (account: string) => boolean; get?: (account: string) => boolean; del?: (account: string) => boolean } = {}): Mem {
  const store = new Map<string, string>();
  const calls = { set: 0, get: 0, del: 0 };
  return {
    store,
    calls,
    async setPassword(service, account, value) {
      calls.set++;
      if (fail.set?.(account)) throw new Error(`the keyring refused to store ${account}`);
      store.set(`${service}/${account}`, value);
    },
    async getPassword(service, account) {
      calls.get++;
      if (fail.get?.(account)) throw new Error('locked');
      return store.get(`${service}/${account}`) ?? null;
    },
    async deletePassword(service, account) {
      calls.del++;
      if (fail.del?.(account)) throw new Error('the store is locked');
      return store.delete(`${service}/${account}`);
    },
  };
}

let ks: KS;
let su: SU;
let saved: Record<string, string | undefined>;
let stderr: string[];

async function load(): Promise<void> {
  vi.resetModules();
  const home = () => HOME;
  vi.doMock('node:os', async () => ({ ...(await vi.importActual<typeof import('node:os')>('node:os')), homedir: home }));
  vi.doMock('os', async () => ({ ...(await vi.importActual<typeof import('os')>('os')), homedir: home }));
  ks = await import('../src/keystore.js');
  su = await import('../src/session-unlock.js');
}

beforeAll(async () => {
  await load();
  ks.generateKey('dev', PW);
  ks.generateKey('other', 'another passphrase');
  ks.generateKey('plain', null);
}, 60_000);

afterAll(() => {
  vi.doUnmock('node:os');
  vi.doUnmock('os');
  rmSync(HOME, { recursive: true, force: true });
});

beforeEach(async () => {
  saved = { [SWITCH]: process.env[SWITCH], CERTEN_KEY_PASSPHRASE: process.env.CERTEN_KEY_PASSPHRASE };
  delete process.env.CERTEN_KEY_PASSPHRASE;
  process.env[SWITCH] = '1';
  stderr = [];
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { stderr.push(a.join(' ')); });
  await load();
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});

const pw = (v: string | null) => async (): Promise<string | null> => v;
const publicKeyOf = (name: string) => createPublicKey({
  key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(ks.getKeyInfo(name).publicKey, 'hex')]), format: 'der', type: 'spki',
});
const verifies = (name: string, sigHex: string): boolean => edVerify(null, Buffer.from(HASH, 'hex'), publicKeyOf(name), Buffer.from(sigHex, 'hex'));
const entry = (kr: Mem, name: string): string | undefined => kr.store.get(`certen/unlock:${name}`);

/** Plant an entry the way a hostile or buggy process would: any content, under the account `unlock` uses. */
function plant(kr: Mem, name: string, session: Record<string, unknown>): void {
  kr.store.set(`certen/unlock:${name}`, JSON.stringify(session));
}

async function unlocked(kr: Mem, name = 'dev', ttl = 15 * MIN, now = T0): Promise<void> {
  await su.unlockSession(name, ttl, pw(name === 'dev' ? PW : 'another passphrase'), { keyring: kr, now: () => now });
}

describe('the experimental switch', () => {
  it('is on only for the exact value 1', () => {
    expect(su.keyUnlockEnabled({ [SWITCH]: '1' })).toBe(true);
    for (const v of ['0', 'true', 'yes', '', ' 1', '11', undefined]) expect(su.keyUnlockEnabled({ [SWITCH]: v }), String(v)).toBe(false);
    expect(su.keyUnlockEnabled({})).toBe(false);
  });

  it('with it off, unlock refuses by name before it asks for a passphrase or touches the keyring', async () => {
    delete process.env[SWITCH];
    const kr = memKeyring();
    const ask = vi.fn(pw(PW));
    await expect(su.unlockSession('dev', 15 * MIN, ask, { keyring: kr, now: () => T0 })).rejects.toMatchObject({
      code: 'KEY_UNLOCK_NOT_ENABLED', exitCode: 2,
      message: expect.stringMatching(/security review.*docs\/security\/keys-unlock-review\.md/s),
    });
    expect(ask).not.toHaveBeenCalled();
    expect(kr.calls).toEqual({ set: 0, get: 0, del: 0 });
  });

  it('with it off, a valid-looking entry is IGNORED: not read, not honoured, not deleted', async () => {
    const kr = memKeyring();
    await unlocked(kr);
    expect(entry(kr, 'dev')).toBeDefined();
    kr.calls.get = 0;

    delete process.env[SWITCH];
    expect(await su.sessionSigner('dev', ks.getKeyInfo('dev'), { keyring: kr, now: () => T0 + MIN })).toBeUndefined();
    expect(await su.unlockedUntil('dev', ks.getKeyInfo('dev'), { keyring: kr, now: () => T0 + MIN })).toBeNull();
    // Ignored means the store is not even asked, so a planted entry cannot be used to learn anything or to steer anything either.
    expect(kr.calls.get).toBe(0);
    expect(entry(kr, 'dev')).toBeDefined();
  });

  it('with it off, lock still wipes: a session left by an earlier run must be removable', async () => {
    const kr = memKeyring();
    await unlocked(kr);
    delete process.env[SWITCH];
    const done = await su.lockSessions(['dev'], { keyring: kr });
    expect(done).toEqual({ wiped: ['dev'], not_unlocked: [], keyring: 'ok' });
    expect(entry(kr, 'dev')).toBeUndefined();
  });
});

describe('unlocking', () => {
  it('keeps the decrypted seed, the key hash and a window; signs afterwards without a passphrase; the signature verifies', async () => {
    const kr = memKeyring();
    const done = await su.unlockSession('dev', 15 * MIN, pw(PW), { keyring: kr, now: () => T0 });
    expect(done).toMatchObject({ name: 'dev', unlocked_at: T0, expires_at: T0 + 15 * MIN, public_key_hash: ks.getKeyInfo('dev').publicKeyHash });

    const stored = JSON.parse(entry(kr, 'dev')!);
    expect(Object.keys(stored).sort()).toEqual(['expires_at', 'key_hash', 'seed', 'unlocked_at', 'v']);
    expect(stored).toMatchObject({ v: 1, key_hash: ks.getKeyInfo('dev').publicKeyHash, unlocked_at: T0, expires_at: T0 + 15 * MIN });
    expect(Buffer.from(stored.seed, 'base64')).toHaveLength(32);
    // Small enough for the Windows credential blob (about 2.5 KB) with room to spare.
    expect(entry(kr, 'dev')!.length).toBeLessThan(400);

    const signer = await su.sessionSigner('dev', ks.getKeyInfo('dev'), { keyring: kr, now: () => T0 + MIN });
    expect(signer).toBeDefined();
    const sig = signer!.sign(HASH);
    expect(verifies('dev', sig)).toBe(true);
    // Ed25519 is deterministic: the session signs exactly what the passphrase route signs.
    expect(sig).toBe(ks.signHash('dev', PW, HASH));
  });

  it('stores the key material and never the passphrase', async () => {
    const kr = memKeyring();
    await unlocked(kr);
    const raw = [...kr.store.entries()].map(([k, v]) => `${k}=${v}`).join('\n');
    expect(raw).not.toContain(PW);
    expect(Object.keys(Object.fromEntries(kr.store))).toEqual(['certen/unlock:dev']);
  });

  it('refuses a key that is not encrypted, before the passphrase and before the keyring', async () => {
    const kr = memKeyring();
    const ask = vi.fn(pw(null));
    await expect(su.unlockSession('plain', 15 * MIN, ask, { keyring: kr, now: () => T0 })).rejects.toMatchObject({ code: 'KEY_NOT_ENCRYPTED', exitCode: 2 });
    expect(ask).not.toHaveBeenCalled();
    expect(kr.calls).toEqual({ set: 0, get: 0, del: 0 });
  });

  it('an unknown key is the key store\'s own error, and nothing is asked', async () => {
    const kr = memKeyring();
    const ask = vi.fn(pw(PW));
    await expect(su.unlockSession('nope', 15 * MIN, ask, { keyring: kr })).rejects.toThrow(/No key named "nope"/);
    expect(ask).not.toHaveBeenCalled();
    expect(kr.calls.set).toBe(0);
  });

  it('refuses when no keyring can be loaded: by name, before the passphrase, and nothing is written anywhere', async () => {
    const ask = vi.fn(pw(PW));
    const before = readdirSync(join(HOME, '.certen')).sort();
    await expect(su.unlockSession('dev', 15 * MIN, ask, { keyring: null })).rejects.toMatchObject({
      code: 'KEYRING_UNAVAILABLE', exitCode: 2, message: expect.stringMatching(/never kept anywhere else/),
    });
    expect(ask).not.toHaveBeenCalled();
    // No file fallback: the only thing under ~/.certen is the key store, exactly as before.
    expect(readdirSync(join(HOME, '.certen')).sort()).toEqual(before);
    expect(before).toEqual(['keys']);
  });

  it('refuses when the keyring cannot hold a value, and says so before the passphrase is asked for', async () => {
    const ask = vi.fn(pw(PW));
    const kr = memKeyring({ set: () => true });
    await expect(su.unlockSession('dev', 15 * MIN, ask, { keyring: kr })).rejects.toMatchObject({ code: 'KEYRING_UNAVAILABLE' });
    expect(ask).not.toHaveBeenCalled();
    expect(kr.store.size).toBe(0);
  });

  it('a keyring that stores the probe but not the key leaves nothing behind and the error carries no key material', async () => {
    const kr = memKeyring({ set: (a) => a === 'unlock:dev' });
    const seed = ks.exportSeed('dev', PW);
    let caught: Error | undefined;
    try { await su.unlockSession('dev', 15 * MIN, pw(PW), { keyring: kr }); } catch (e) { caught = e as Error; }
    expect(caught).toMatchObject({ code: 'KEYRING_UNAVAILABLE' });
    expect(kr.store.size).toBe(0);
    expect(kr.calls.del).toBeGreaterThan(1); // the cleanup ran
    for (const secret of [seed.toString('base64'), seed.toString('hex')]) expect(caught!.message).not.toContain(secret);
  });

  it('scrubs the seed out of a keyring error that happens to repeat what it was given', async () => {
    const seed = ks.exportSeed('dev', PW);
    const kr = memKeyring();
    const real = kr.setPassword;
    kr.setPassword = async (s, a, v) => {
      if (a === 'unlock:dev') throw new Error(`cannot store ${v}`);
      return real(s, a, v);
    };
    let caught: Error | undefined;
    try { await su.unlockSession('dev', 15 * MIN, pw(PW), { keyring: kr }); } catch (e) { caught = e as Error; }
    expect(caught).toMatchObject({ code: 'KEYRING_UNAVAILABLE' });
    expect(caught!.message).toContain('[removed]');
    expect(caught!.message).not.toContain(seed.toString('base64'));
  });

  it('a wrong passphrase ends it with nothing in the keyring', async () => {
    const kr = memKeyring();
    await expect(su.unlockSession('dev', 15 * MIN, pw('not the passphrase'), { keyring: kr, now: () => T0 })).rejects.toMatchObject({
      code: 'WRONG_PASSPHRASE', exitCode: 1, next: 'certen keys verify dev',
    });
    expect(kr.store.size).toBe(0);
  });
});

describe('--for', () => {
  const ms = (t?: string) => su.unlockSpanMs(t);

  it('defaults to 15 minutes', () => {
    expect(ms(undefined)).toBe(15 * MIN);
    expect(su.DEFAULT_UNLOCK_MS).toBe(15 * MIN);
  });

  it('takes the usual units, and a bare number means minutes', () => {
    expect(ms('90s')).toBe(90_000);
    expect(ms('15m')).toBe(15 * MIN);
    expect(ms('1h')).toBe(HOUR);
    expect(ms('30')).toBe(30 * MIN);
    expect(ms('0.5')).toBe(30_000);
  });

  it('allows exactly the ceiling and not a second more', () => {
    expect(su.MAX_UNLOCK_MS).toBe(8 * HOUR);
    expect(ms('8h')).toBe(8 * HOUR);
    expect(ms('480m')).toBe(8 * HOUR);
    for (const over of ['481m', '9h', '2d', '28801s', '481']) {
      expect(() => ms(over), over).toThrowError(expect.objectContaining({ code: 'UNLOCK_DURATION_INVALID', exitCode: 2, message: expect.stringMatching(/at most 8h/) }));
    }
  });

  it('refuses zero, negative, words and fractions of a unit', () => {
    for (const bad of ['0', '0m', '-5', '-1h', 'abc', '', '1.5h', '1e3', '0x10', '10 minutes']) {
      expect(() => ms(bad), JSON.stringify(bad)).toThrowError(expect.objectContaining({ code: 'UNLOCK_DURATION_INVALID', exitCode: 2 }));
    }
  });
});

describe('using a session', () => {
  it('is honoured up to the last millisecond and refused AT the expiry, which also deletes it', async () => {
    const kr = memKeyring();
    await unlocked(kr, 'dev', 15 * MIN, T0);
    const info = ks.getKeyInfo('dev');

    expect(await su.sessionSigner('dev', info, { keyring: kr, now: () => T0 + 15 * MIN - 1 })).toBeDefined();
    expect(entry(kr, 'dev')).toBeDefined();

    expect(await su.sessionSigner('dev', info, { keyring: kr, now: () => T0 + 15 * MIN })).toBeUndefined();
    expect(entry(kr, 'dev')).toBeUndefined();
    expect(stderr.join('\n')).toMatch(/session for key "dev" has expired; asking for the passphrase/);
  });

  it('long after the expiry the same', async () => {
    const kr = memKeyring();
    await unlocked(kr);
    expect(await su.sessionSigner('dev', ks.getKeyInfo('dev'), { keyring: kr, now: () => T0 + 30 * HOUR })).toBeUndefined();
    expect(entry(kr, 'dev')).toBeUndefined();
  });

  it('no session is the ordinary case: undefined, quietly, and nothing is created', async () => {
    const kr = memKeyring();
    expect(await su.sessionSigner('dev', ks.getKeyInfo('dev'), { keyring: kr, now: () => T0 })).toBeUndefined();
    expect(kr.store.size).toBe(0);
    expect(stderr).toEqual([]);
  });

  it('a key that is not encrypted never reads the keyring', async () => {
    const kr = memKeyring();
    expect(await su.sessionSigner('plain', ks.getKeyInfo('plain'), { keyring: kr })).toBeUndefined();
    expect(kr.calls.get).toBe(0);
  });

  it('no keyring module, or a keyring that cannot be read, is no session rather than an error', async () => {
    expect(await su.sessionSigner('dev', ks.getKeyInfo('dev'), { keyring: null })).toBeUndefined();
    expect(await su.sessionSigner('dev', ks.getKeyInfo('dev'), { keyring: memKeyring({ get: () => true }) })).toBeUndefined();
  });

  it('a planted entry carrying ANOTHER key\'s seed under this key\'s hash signs nothing, and is removed', async () => {
    const kr = memKeyring();
    const otherSeed = ks.exportSeed('other', 'another passphrase');
    plant(kr, 'dev', {
      v: 1, key_hash: ks.getKeyInfo('dev').publicKeyHash, seed: otherSeed.toString('base64'), unlocked_at: T0, expires_at: T0 + 15 * MIN,
    });
    expect(await su.sessionSigner('dev', ks.getKeyInfo('dev'), { keyring: kr, now: () => T0 + MIN })).toBeUndefined();
    expect(entry(kr, 'dev')).toBeUndefined();
    expect(stderr.join('\n')).toMatch(/Ignored and removed an unlocked session for key "dev": it does not unlock this key/);
  });

  it('an entry made for a different key (its hash) is refused and removed', async () => {
    const kr = memKeyring();
    await unlocked(kr, 'other');
    kr.store.set('certen/unlock:dev', entry(kr, 'other')!);
    expect(await su.sessionSigner('dev', ks.getKeyInfo('dev'), { keyring: kr, now: () => T0 + MIN })).toBeUndefined();
    expect(entry(kr, 'dev')).toBeUndefined();
    expect(stderr.join('\n')).toMatch(/belongs to a different key/);
    // The entry that really was other's is untouched.
    expect(entry(kr, 'other')).toBeDefined();
  });

  it('a clock turned back past the skew refuses the entry; within the skew it is still honoured', async () => {
    const kr = memKeyring();
    await unlocked(kr);
    const info = ks.getKeyInfo('dev');
    expect(await su.sessionSigner('dev', info, { keyring: kr, now: () => T0 - 30_000 })).toBeDefined();
    expect(await su.sessionSigner('dev', info, { keyring: kr, now: () => T0 - 2 * HOUR })).toBeUndefined();
    expect(entry(kr, 'dev')).toBeUndefined();
    expect(stderr.join('\n')).toMatch(/clock has gone backwards/);
  });

  it('an expiry edited far into the future is refused: the window is not one unlock could have made', async () => {
    const kr = memKeyring();
    await unlocked(kr);
    const real = JSON.parse(entry(kr, 'dev')!);
    plant(kr, 'dev', { ...real, expires_at: T0 + 100 * HOUR });
    expect(await su.sessionSigner('dev', ks.getKeyInfo('dev'), { keyring: kr, now: () => T0 + MIN })).toBeUndefined();
    expect(entry(kr, 'dev')).toBeUndefined();
    expect(stderr.join('\n')).toMatch(/time window is not one this CLI would have set/);
  });

  it('a window that is short enough but starts in the future and ends more than a session from now is refused', async () => {
    const kr = memKeyring();
    await unlocked(kr);
    const real = JSON.parse(entry(kr, 'dev')!);
    plant(kr, 'dev', { ...real, unlocked_at: T0 + 30_000, expires_at: T0 + 30_000 + su.MAX_UNLOCK_MS });
    expect(await su.sessionSigner('dev', ks.getKeyInfo('dev'), { keyring: kr, now: () => T0 })).toBeUndefined();
    expect(entry(kr, 'dev')).toBeUndefined();
    expect(stderr.join('\n')).toMatch(/longer than a session can/);
  });

  it('refuses and removes every malformed entry without throwing', async () => {
    const info = ks.getKeyInfo('dev');
    const good = (() => ({ v: 1, key_hash: info.publicKeyHash, seed: Buffer.alloc(32, 7).toString('base64'), unlocked_at: T0, expires_at: T0 + 15 * MIN }))();
    const cases: Array<[string, string]> = [
      ['not json', 'not json at all'],
      ['null', 'null'],
      ['an array', '[]'],
      ['version 2', JSON.stringify({ ...good, v: 2 })],
      ['no seed', JSON.stringify({ ...good, seed: undefined })],
      ['a string time', JSON.stringify({ ...good, expires_at: String(T0 + 15 * MIN) })],
      ['inverted window', JSON.stringify({ ...good, expires_at: T0 - 1 })],
      ['zero-length window', JSON.stringify({ ...good, expires_at: T0 })],
      ['a seed of the wrong length', JSON.stringify({ ...good, seed: Buffer.alloc(16, 1).toString('base64') })],
      ['a seed that is not base64', JSON.stringify({ ...good, seed: '!!!!' })],
      ['a seed that derives some other key', JSON.stringify(good)],
    ];
    for (const [label, raw] of cases) {
      const kr = memKeyring();
      kr.store.set('certen/unlock:dev', raw);
      expect(await su.sessionSigner('dev', info, { keyring: kr, now: () => T0 + MIN }), label).toBeUndefined();
      expect(entry(kr, 'dev'), label).toBeUndefined();
    }
  });

  it('writes nothing about the seed to stderr, whatever it decides', async () => {
    const kr = memKeyring();
    await unlocked(kr);
    const seed = ks.exportSeed('dev', PW);
    const real = JSON.parse(entry(kr, 'dev')!);
    for (const patch of [{}, { expires_at: T0 + 1 }, { key_hash: 'ff'.repeat(32) }, { unlocked_at: T0 + 5 * HOUR }]) {
      plant(kr, 'dev', { ...real, ...patch });
      await su.sessionSigner('dev', ks.getKeyInfo('dev'), { keyring: kr, now: () => T0 + MIN });
    }
    const text = stderr.join('\n');
    for (const secret of [seed.toString('base64'), seed.toString('hex')]) expect(text).not.toContain(secret);
  });
});

describe('unlockedUntil (what `keys list` shows)', () => {
  it('is the end of the window, or null', async () => {
    const kr = memKeyring();
    const info = ks.getKeyInfo('dev');
    expect(await su.unlockedUntil('dev', info, { keyring: kr, now: () => T0 })).toBeNull();
    await unlocked(kr);
    expect(await su.unlockedUntil('dev', info, { keyring: kr, now: () => T0 + MIN })).toBe(T0 + 15 * MIN);
    expect(await su.unlockedUntil('dev', info, { keyring: kr, now: () => T0 + 15 * MIN })).toBeNull();
    expect(entry(kr, 'dev')).toBeUndefined();
  });

  it('is null for a key that is not encrypted and reads nothing', async () => {
    const kr = memKeyring();
    expect(await su.unlockedUntil('plain', ks.getKeyInfo('plain'), { keyring: kr })).toBeNull();
    expect(kr.calls.get).toBe(0);
  });

  it('sweeps an entry that does not check out, as every other reader does', async () => {
    const kr = memKeyring();
    kr.store.set('certen/unlock:dev', 'garbage');
    expect(await su.unlockedUntil('dev', ks.getKeyInfo('dev'), { keyring: kr })).toBeNull();
    expect(entry(kr, 'dev')).toBeUndefined();
  });
});

describe('locking', () => {
  it('wipes one key, is idempotent, and wipes every key with --all semantics', async () => {
    const kr = memKeyring();
    await unlocked(kr, 'dev');
    await unlocked(kr, 'other');
    expect(await su.lockSessions(['dev'], { keyring: kr })).toEqual({ wiped: ['dev'], not_unlocked: [], keyring: 'ok' });
    expect(entry(kr, 'dev')).toBeUndefined();
    expect(entry(kr, 'other')).toBeDefined();
    expect(await su.lockSessions(['dev'], { keyring: kr })).toEqual({ wiped: [], not_unlocked: ['dev'], keyring: 'ok' });
    expect(await su.lockSessions(['dev', 'other', 'plain'], { keyring: kr })).toEqual({ wiped: ['other'], not_unlocked: ['dev', 'plain'], keyring: 'ok' });
    expect(kr.store.size).toBe(0);
  });

  it('with no keyring to load there is nothing to wipe: success, and it says the keyring was unavailable', async () => {
    expect(await su.lockSessions(['dev'], { keyring: null })).toEqual({ wiped: [], not_unlocked: ['dev'], keyring: 'unavailable' });
  });

  it('a keyring that loads and then will not delete is a failure naming every key it could not confirm, after trying all of them', async () => {
    const kr = memKeyring({ del: (a) => a === 'unlock:dev' || a === 'unlock:other' });
    kr.store.set('certen/unlock:plain', '{}');
    let caught: Error | undefined;
    try { await su.lockSessions(['dev', 'other', 'plain'], { keyring: kr }); } catch (e) { caught = e as Error; }
    expect(caught).toMatchObject({ code: 'KEYRING_UNAVAILABLE', exitCode: 2 });
    expect(caught!.message).toMatch(/"dev", "other"/);
    expect(caught!.message).toContain('unlock:dev');
    expect(entry(kr, 'plain')).toBeUndefined(); // the others were still tried
  });

  it('an invalid key name is a usage error, not a lookup of a stranger\'s account', async () => {
    const kr = memKeyring();
    await expect(su.lockSessions(['../x'], { keyring: kr })).rejects.toMatchObject({ code: 'UNKNOWN_KEY', exitCode: 2 });
    expect(kr.calls.del).toBe(0);
  });
});

describe('the signer seam', () => {
  async function signerWithKeyring(kr: Mem, now: number) {
    vi.resetModules();
    vi.doMock('@napi-rs/keyring', () => ({
      AsyncEntry: class {
        private readonly a: string;
        constructor(_service: string, account: string) { this.a = account; }
        setPassword(v: string) { return kr.setPassword('certen', this.a, v); }
        getPassword() { return kr.getPassword('certen', this.a).then((v) => v ?? undefined); }
        deletePassword() { return kr.deletePassword('certen', this.a); }
      },
    }));
    const home = () => HOME;
    vi.doMock('node:os', async () => ({ ...(await vi.importActual<typeof import('node:os')>('node:os')), homedir: home }));
    vi.doMock('os', async () => ({ ...(await vi.importActual<typeof import('os')>('os')), homedir: home }));
    vi.spyOn(Date, 'now').mockReturnValue(now);
    return import('../src/signer.js');
  }

  afterEach(() => { vi.doUnmock('@napi-rs/keyring'); });

  it('resolveSigner signs with no passphrase prompt and without reading CERTEN_KEY_PASSPHRASE while the session lasts', async () => {
    const kr = memKeyring();
    await unlocked(kr);
    const { resolveSigner } = await signerWithKeyring(kr, T0 + MIN);

    // No env passphrase and no TTY: the passphrase path would fail with PASSPHRASE_REQUIRED.
    const a = await resolveSigner('dev');
    expect(a.publicKeyHash).toBe(ks.getKeyInfo('dev').publicKeyHash);
    expect(verifies('dev', a.sign(HASH))).toBe(true);

    // A WRONG env passphrase is not consulted either: the session replaces the passphrase, it does not check it.
    process.env.CERTEN_KEY_PASSPHRASE = 'definitely wrong';
    const b = await resolveSigner('dev');
    expect(b.sign(HASH)).toBe(a.sign(HASH));
  });

  it('after the expiry the passphrase is asked for again (and a wrong one fails as it always did)', async () => {
    const kr = memKeyring();
    await unlocked(kr);
    const { resolveSigner } = await signerWithKeyring(kr, T0 + 16 * MIN);
    await expect(resolveSigner('dev')).rejects.toMatchObject({ code: 'PASSPHRASE_REQUIRED' });
    expect(entry(kr, 'dev')).toBeUndefined();
    process.env.CERTEN_KEY_PASSPHRASE = 'definitely wrong';
    await expect(resolveSigner('dev')).rejects.toMatchObject({ code: 'WRONG_PASSPHRASE' });
    process.env.CERTEN_KEY_PASSPHRASE = PW;
    expect(verifies('dev', (await resolveSigner('dev')).sign(HASH))).toBe(true);
  });

  it('with the switch off, a valid session left in the keyring changes nothing: the passphrase is still asked for', async () => {
    const kr = memKeyring();
    await unlocked(kr);
    delete process.env[SWITCH];
    const { resolveSigner } = await signerWithKeyring(kr, T0 + MIN);
    await expect(resolveSigner('dev')).rejects.toMatchObject({ code: 'PASSPHRASE_REQUIRED' });
    expect(entry(kr, 'dev')).toBeDefined();
  });

  it('a planted entry cannot make resolveSigner sign with the wrong key', async () => {
    const kr = memKeyring();
    plant(kr, 'dev', {
      v: 1, key_hash: ks.getKeyInfo('dev').publicKeyHash, seed: ks.exportSeed('other', 'another passphrase').toString('base64'),
      unlocked_at: T0, expires_at: T0 + 15 * MIN,
    });
    const { resolveSigner } = await signerWithKeyring(kr, T0 + MIN);
    await expect(resolveSigner('dev')).rejects.toMatchObject({ code: 'PASSPHRASE_REQUIRED' });
    expect(entry(kr, 'dev')).toBeUndefined();
  });
});
