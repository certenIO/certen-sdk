import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * Profiles: a named gateway URL + context + credential.
 *
 * The property that matters most is not that a profile can be selected. It is that **a profile's API key is never sent to
 * another profile's gateway**. A profile has its own gateway URL, so a key shared across profiles would be handed to whichever
 * host the active profile names. That is why credentials are namespaced by profile, and why a named profile never falls back to
 * the default profile's key.
 *
 * The `default` profile is the config the CLI has always had: its credential and gateway stay at the top level of config.json,
 * so nothing is migrated and nobody who has never heard of profiles sees a difference.
 */
let scratch = '';
vi.mock('os', async (orig) => {
  const real = await orig<typeof import('os')>();
  return { ...real, homedir: () => scratch };
});
vi.mock('node:os', async (orig) => {
  const real = await orig<typeof import('node:os')>();
  return { ...real, homedir: () => scratch };
});

async function loadConfig(): Promise<typeof import('../src/config.js')> {
  return import('../src/config.js');
}

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'certen-profiles-'));
  delete process.env.CERTEN_API_KEY;
  delete process.env.CERTEN_API_URL;
  delete process.env.CERTEN_PROFILE;
  vi.resetModules();
});

afterEach(() => {
  try { rmSync(scratch, { recursive: true, force: true }); } catch { /* noop */ }
  vi.doUnmock('@napi-rs/keyring');
});

const CONFIG_FILE = () => join(scratch, '.certen', 'config.json');
const raw = () => JSON.parse(readFileSync(CONFIG_FILE(), 'utf-8')) as Record<string, any>;

function memoryKeyring(): { AsyncEntry: new (service: string, account: string) => unknown; store: Map<string, string> } {
  const store = new Map<string, string>();
  class AsyncEntry {
    private readonly k: string;
    constructor(service: string, account: string) { this.k = `${service}/${account}`; }
    async setPassword(v: string): Promise<void> { store.set(this.k, v); }
    async getPassword(): Promise<string | undefined> { return store.get(this.k); }
    async deletePassword(): Promise<boolean> { return store.delete(this.k); }
  }
  return { AsyncEntry, store };
}

describe('which profile is active', () => {
  it('is `default` when nothing says otherwise', async () => {
    const c = await loadConfig();
    expect(c.DEFAULT_PROFILE).toBe('default');
    expect(c.activeProfile()).toBe('default');
  });

  it('follows --profile > CERTEN_PROFILE > the saved active profile > default', async () => {
    const c = await loadConfig();
    c.updateProfile('saved', { chain: 'base-sepolia' });
    c.updateProfile('fromenv', { chain: 'base-sepolia' });
    c.updateProfile('fromflag', { chain: 'base-sepolia' });
    c.setActiveProfile('saved');
    expect(c.activeProfile()).toBe('saved');

    process.env.CERTEN_PROFILE = 'fromenv';
    expect(c.activeProfile()).toBe('fromenv');

    c.setProfileOverride('fromflag');
    expect(c.activeProfile()).toBe('fromflag');

    c.setProfileOverride(undefined);
    expect(c.activeProfile()).toBe('fromenv');
  });

  it.each(['', '../escape', 'a b', 'x'.repeat(33), '-leading', 'semi;colon', 'acc://x'])(
    'refuses the profile name %j before it can become a key, a path or a keyring account',
    async (name) => {
      const c = await loadConfig();
      expect(() => c.setProfileOverride(name)).toThrowError(/profile name/i);
      try { c.setProfileOverride(name); } catch (e) { expect((e as { code: string }).code).toBe('INVALID_PROFILE_NAME'); }
    },
  );

  it('refuses a profile that does not exist, naming the ones that do and how to make one', async () => {
    const c = await loadConfig();
    c.updateProfile('testnet', { chain: 'base-sepolia' });
    await expect(c.getApiKey('nope')).rejects.toMatchObject({ code: 'PROFILE_NOT_FOUND', exitCode: 2 });
    try {
      await c.getApiKey('nope');
    } catch (e) {
      const m = (e as Error).message;
      expect(m).toContain('nope');
      expect(m).toContain('default');
      expect(m).toContain('testnet');
      expect(m).toContain('certen use');
      // The saved active profile can be the one that vanished (a hand-edited config): the way back is named.
      expect(m).toContain('certen use profile default');
    }
  });

  it('lists `default` first, then the rest in order', async () => {
    const c = await loadConfig();
    c.updateProfile('zeta', { chain: 'base-sepolia' });
    c.updateProfile('alpha', { chain: 'base-sepolia' });
    expect(c.listProfiles()).toEqual(['default', 'alpha', 'zeta']);
    expect(c.profileExists('default')).toBe(true);
    expect(c.profileExists('alpha')).toBe(true);
    expect(c.profileExists('missing')).toBe(false);
  });
});

describe('profile settings', () => {
  it('stores identity, key, chain, gateway and the mainnet switch per profile, and unsets with null', async () => {
    const c = await loadConfig();
    c.updateProfile('testnet', { identity: 'id-1', key: 'dev', chain: 'base-sepolia', api_url: 'https://t.example', allow_mainnet_default: false });
    expect(c.readProfile('testnet')).toMatchObject({ identity: 'id-1', key: 'dev', chain: 'base-sepolia', api_url: 'https://t.example', allow_mainnet_default: false });
    c.updateProfile('testnet', { identity: null, allow_mainnet_default: null });
    const after = c.readProfile('testnet');
    expect(after.identity).toBeUndefined();
    expect(after.allow_mainnet_default).toBeUndefined();
    expect(after.key).toBe('dev');
  });

  it('keeps the default profile\'s gateway URL where it has always been: the top level', async () => {
    const c = await loadConfig();
    c.updateProfile('default', { api_url: 'https://old.example', chain: 'base-sepolia' });
    expect(raw().api_url).toBe('https://old.example');
    expect(raw().profiles.default.chain).toBe('base-sepolia');
    expect(raw().profiles.default.api_url).toBeUndefined();
    expect(c.readProfile('default').api_url).toBe('https://old.example');
  });

  it('does not write an empty default profile just because its gateway URL (which lives at the top level) changed', async () => {
    const c = await loadConfig();
    c.updateProfile('default', { api_url: 'https://only-the-url.example' });
    expect(raw()).toEqual({ api_url: 'https://only-the-url.example' });
    // A NAMED profile with nothing set is still a profile: that is how one is created.
    c.updateProfile('fresh', {});
    expect(raw().profiles).toEqual({ fresh: {} });
    expect(c.profileExists('fresh')).toBe(true);
  });

  it('writes nothing the old CLI cannot ignore: unknown top-level keys are additive', async () => {
    const c = await loadConfig();
    await c.setApiKey('ck_live_default', false);
    c.updateProfile('testnet', { chain: 'base-sepolia' });
    const r = raw();
    expect(r.api_key).toBe('ck_live_default');
    expect(r.storage).toBe('file');
    expect(Object.keys(r).sort()).toEqual(['api_key', 'key_prefix', 'profiles', 'storage'].sort());
  });

  it('refuses a gateway URL that is not http(s)', async () => {
    const c = await loadConfig();
    expect(() => c.updateProfile('testnet', { api_url: 'ftp://x' })).toThrowError(/http/);
    expect(() => c.updateProfile('testnet', { api_url: 'not a url' })).toThrowError(/URL/);
  });
});

describe('credentials are per profile', () => {
  it('stores a named profile\'s key inside that profile and leaves the default\'s untouched', async () => {
    const c = await loadConfig();
    await c.setApiKey('ck_live_DEFAULT', false);
    await c.setApiKey('ck_live_TESTNET', false, 'testnet');
    expect(raw().api_key).toBe('ck_live_DEFAULT');
    expect(raw().profiles.testnet.api_key).toBe('ck_live_TESTNET');
    expect(raw().profiles.testnet.storage).toBe('file');
    expect(await c.getApiKey()).toBe('ck_live_DEFAULT');
    expect(await c.getApiKey('testnet')).toBe('ck_live_TESTNET');
  });

  it('uses the ACTIVE profile when none is named', async () => {
    const c = await loadConfig();
    await c.setApiKey('ck_live_DEFAULT', false);
    await c.setApiKey('ck_live_TESTNET', false, 'testnet');
    c.setProfileOverride('testnet');
    expect(await c.getApiKey()).toBe('ck_live_TESTNET');
  });

  it('never falls back to the default profile\'s key: that key belongs to another gateway', async () => {
    const c = await loadConfig();
    await c.setApiKey('ck_live_DEFAULT', false);
    c.updateProfile('other', { api_url: 'https://other.example' });
    await expect(c.getApiKey('other')).rejects.toMatchObject({ code: 'NO_API_KEY', exitCode: 2 });
    await expect(c.getApiKey('other')).rejects.toThrowError(/profile "other"/);
  });

  it('CERTEN_API_KEY still wins over every profile', async () => {
    const c = await loadConfig();
    await c.setApiKey('ck_live_TESTNET', false, 'testnet');
    process.env.CERTEN_API_KEY = 'ck_live_ENV';
    expect(await c.getApiKey('testnet')).toBe('ck_live_ENV');
    expect(await c.getApiKey()).toBe('ck_live_ENV');
  });

  it('clears only the named profile\'s credential', async () => {
    const c = await loadConfig();
    await c.setApiKey('ck_live_DEFAULT', false);
    await c.setApiKey('ck_live_TESTNET', false, 'testnet');
    await c.clearApiKey('testnet');
    expect(raw().api_key).toBe('ck_live_DEFAULT');
    expect(raw().profiles.testnet.api_key).toBeUndefined();
    await expect(c.getApiKey('testnet')).rejects.toMatchObject({ code: 'NO_API_KEY' });
  });

  it('namespaces the OS keyring account: `api_key` for default, `api_key:<profile>` for a named one', async () => {
    const kr = memoryKeyring();
    vi.doMock('@napi-rs/keyring', () => kr);
    const c = await loadConfig();
    await c.setApiKey('ck_live_DEFAULT', true);
    await c.setApiKey('ck_live_TESTNET', true, 'testnet');
    expect(kr.store.get('certen/api_key')).toBe('ck_live_DEFAULT');
    expect(kr.store.get('certen/api_key:testnet')).toBe('ck_live_TESTNET');
    expect(raw().profiles.testnet.storage).toBe('keyring');
    expect(raw().profiles.testnet.api_key).toBeUndefined();
    expect(raw().profiles.testnet.key_prefix).toBe('ck_live_TEST');
    expect(await c.getApiKey('testnet')).toBe('ck_live_TESTNET');
    await c.clearApiKey('testnet');
    expect(kr.store.has('certen/api_key:testnet')).toBe(false);
    expect(kr.store.get('certen/api_key')).toBe('ck_live_DEFAULT');
  });

  it('reports the active profile\'s storage and prefix for status commands', async () => {
    vi.doMock('@napi-rs/keyring', () => memoryKeyring());
    const c = await loadConfig();
    await c.setApiKey('ck_live_DEFAULT', false);
    await c.setApiKey('ck_live_TESTNET', true, 'testnet');
    expect(c.credentialInfo('default')).toMatchObject({ storage: 'file', key_prefix: 'ck_live_DEFA', has_file_key: true });
    expect(c.credentialInfo('testnet')).toMatchObject({ storage: 'keyring', key_prefix: 'ck_live_TEST', has_file_key: false });
    expect(c.credentialInfo('nobody')).toMatchObject({ storage: undefined, has_file_key: false });
  });

  it('holds the same 0600 permission rule for a profile\'s file credential', async () => {
    if (process.platform === 'win32') return;
    const c = await loadConfig();
    await c.setApiKey('ck_live_TESTNET', false, 'testnet');
    chmodSync(CONFIG_FILE(), 0o644);
    await expect(c.getApiKey('testnet')).rejects.toMatchObject({ code: 'CONFIG_PERMISSIONS' });
  });
});

describe('the gateway URL is per profile', () => {
  it('follows CERTEN_API_URL > the profile\'s URL > the top-level URL > the default', async () => {
    const c = await loadConfig();
    expect(c.getApiUrl()).toBe(c.DEFAULT_API_URL);

    c.updateProfile('default', { api_url: 'https://top.example' });
    expect(c.getApiUrl()).toBe('https://top.example');

    c.updateProfile('testnet', { api_url: 'https://testnet.example' });
    c.setProfileOverride('testnet');
    expect(c.getApiUrl()).toBe('https://testnet.example');

    process.env.CERTEN_API_URL = 'https://env.example';
    expect(c.getApiUrl()).toBe('https://env.example');
  });

  it('lets a named profile without its own URL use the top-level one, but never its credential', async () => {
    const c = await loadConfig();
    c.updateProfile('default', { api_url: 'https://top.example' });
    c.updateProfile('bare', { chain: 'base-sepolia' });
    c.setProfileOverride('bare');
    expect(c.getApiUrl()).toBe('https://top.example');
  });
});

describe('no config file, no surprise', () => {
  it('reading profiles does not create the config file', async () => {
    const c = await loadConfig();
    c.listProfiles();
    c.readProfile('default');
    c.activeProfile();
    expect(existsSync(CONFIG_FILE())).toBe(false);
  });
});
