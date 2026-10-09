import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, statSync, chmodSync, existsSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// Redirect homedir() to a per-test scratch directory so the real
// ~/.certen/config.json is never touched.
let scratch = '';
vi.mock('os', async (orig) => {
  const real = await orig<typeof import('os')>();
  return { ...real, homedir: () => scratch };
});

// Single import path; we reset the module registry between tests so
// state (e.g. saved keyring mocks) doesn't leak.
async function loadConfig(): Promise<typeof import('../src/config.js')> {
  return import('../src/config.js');
}

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'certen-cli-test-'));
  delete process.env.CERTEN_API_KEY;
  delete process.env.CERTEN_API_URL;
  vi.resetModules();
});

afterEach(() => {
  try { rmSync(scratch, { recursive: true, force: true }); } catch { /* noop */ }
  vi.doUnmock('@napi-rs/keyring');
});

const CONFIG_FILE = () => join(scratch, '.certen', 'config.json');

describe('CLI config: file storage', () => {
  it('writes ~/.certen/config.json with 0600 mode', async () => {
    const c = await loadConfig();
    await c.setApiKey('ck_live_secret', false);
    expect(existsSync(CONFIG_FILE())).toBe(true);
    if (process.platform !== 'win32') {
      const st = statSync(CONFIG_FILE());
      expect((st.mode & 0o077)).toBe(0);
    }
    const raw = JSON.parse(readFileSync(CONFIG_FILE(), 'utf-8'));
    expect(raw.api_key).toBe('ck_live_secret');
    expect(raw.storage).toBe('file');
  });

  it('refuses to read api_key when the file mode is world-readable (POSIX only)', async () => {
    if (process.platform === 'win32') return;
    const c = await loadConfig();
    await c.setApiKey('ck_live_secret', false);
    chmodSync(CONFIG_FILE(), 0o644);

    // Throws rather than calling process.exit: the thrown UsageError is what lets the top-level
    // handler emit a JSON envelope and exit 2. Calling process.exit here would bypass both.
    await expect(c.getApiKey()).rejects.toMatchObject({
      code: 'CONFIG_PERMISSIONS',
      exitCode: 2,
    });
    await expect(c.getApiKey()).rejects.toThrowError(/refusing to read/);
  });

  it('CERTEN_API_KEY env wins over the config file', async () => {
    const c = await loadConfig();
    await c.setApiKey('ck_live_FROM_FILE', false);
    process.env.CERTEN_API_KEY = 'ck_live_FROM_ENV';
    const v = await c.getApiKey();
    expect(v).toBe('ck_live_FROM_ENV');
  });

  it('clearApiKey removes the api_key field', async () => {
    const c = await loadConfig();
    await c.setApiKey('ck_live_x', false);
    await c.clearApiKey();
    const raw = JSON.parse(readFileSync(CONFIG_FILE(), 'utf-8'));
    expect(raw.api_key).toBeUndefined();
  });

  it('errors if no key is configured anywhere', async () => {
    const c = await loadConfig();
    // A usage error (exit 2), not a failed operation (exit 1): nothing was ever sent, and the fix
    // is to configure a key rather than to retry.
    await expect(c.getApiKey()).rejects.toMatchObject({
      code: 'NO_API_KEY',
      exitCode: 2,
    });
  });
});

/** An in-memory stand-in for @napi-rs/keyring's AsyncEntry, keyed by service and account like the OS store. */
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

describe('CLI config: keyring storage', () => {
  it('stores in, reads from and deletes from the OS keyring when storage=keyring', async () => {
    const kr = memoryKeyring();
    vi.doMock('@napi-rs/keyring', () => kr);
    const c = await loadConfig();
    await c.setApiKey('ck_live_setviakeyring', true);
    expect(kr.store.get('certen/api_key')).toBe('ck_live_setviakeyring');
    const raw = JSON.parse(readFileSync(CONFIG_FILE(), 'utf-8'));
    expect(raw.storage).toBe('keyring');
    expect(raw.api_key).toBeUndefined();
    expect(await c.getApiKey()).toBe('ck_live_setviakeyring');
    await c.clearApiKey();
    expect(kr.store.size).toBe(0);
  });

  it('round-2 #43: persists key_prefix in config.json when storing in the keyring', async () => {
    vi.doMock('@napi-rs/keyring', () => memoryKeyring());
    const c = await loadConfig();
    await c.setApiKey('ck_live_prefixedkey', true);
    const raw = JSON.parse(readFileSync(CONFIG_FILE(), 'utf-8'));
    expect(raw.storage).toBe('keyring');
    expect(raw.key_prefix).toBe('ck_live_pref'); // first 12 chars
    expect(raw.api_key).toBeUndefined();
  });

  it('clears key_prefix on logout', async () => {
    vi.doMock('@napi-rs/keyring', () => memoryKeyring());
    const c = await loadConfig();
    await c.setApiKey('ck_live_x_prefix', true);
    await c.clearApiKey();
    const raw = JSON.parse(readFileSync(CONFIG_FILE(), 'utf-8'));
    expect(raw.key_prefix).toBeUndefined();
  });

  it('refuses by name, and never falls back to a file, when the keyring module cannot load', async () => {
    vi.doMock('@napi-rs/keyring', () => { throw new Error('native binary missing'); });
    const c = await loadConfig();
    await expect(c.setApiKey('ck_live_nokeyring', true)).rejects.toThrow(/@napi-rs\/keyring.*could not be loaded.*--no-keyring/);
    expect(existsSync(CONFIG_FILE())).toBe(false);

    // A config already pointing at the keyring cannot be satisfied from a file either.
    mkdirSync(join(scratch, '.certen'), { recursive: true });
    writeFileSync(CONFIG_FILE(), JSON.stringify({ storage: 'keyring', api_key: 'ck_live_stale_in_file' }));
    await expect(c.getApiKey()).rejects.toMatchObject({ code: 'KEYRING_UNAVAILABLE' });
  });

  it('names what to do, and writes nothing else, when the platform keyring itself refuses', async () => {
    class Refusing { async setPassword(): Promise<void> { throw new Error("Couldn't access platform storage: PermissionDenied"); } async getPassword(): Promise<string | undefined> { throw new Error('no secret service'); } async deletePassword(): Promise<boolean> { return false; } }
    vi.doMock('@napi-rs/keyring', () => ({ AsyncEntry: Refusing }));
    const c = await loadConfig();
    await expect(c.setApiKey('ck_live_headless', true)).rejects.toThrow(/OS keyring refused the key \(Couldn't access platform storage: PermissionDenied\).*--no-keyring.*CERTEN_API_KEY/);
    expect(existsSync(CONFIG_FILE())).toBe(false);
    mkdirSync(join(scratch, '.certen'), { recursive: true });
    writeFileSync(CONFIG_FILE(), JSON.stringify({ storage: 'keyring' }));
    await expect(c.getApiKey()).rejects.toMatchObject({ code: 'KEYRING_UNAVAILABLE', message: expect.stringMatching(/could not be read \(no secret service\)/) });
  });

  it('declares the maintained module, not the archived keytar, and loads it on this platform', async () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8'));
    expect(pkg.optionalDependencies?.['@napi-rs/keyring']).toMatch(/^\d+\.\d+\.\d+$/);
    expect(JSON.stringify(pkg)).not.toMatch(/keytar/);
    const real = await import('@napi-rs/keyring');
    expect(typeof real.AsyncEntry).toBe('function');
    expect(() => new real.AsyncEntry('certen-test-no-io', 'api_key')).not.toThrow();
  });
});

describe('CLI getApiUrl', () => {
  it('defaults to the gateway host', async () => {
    const c = await loadConfig();
    expect(c.getApiUrl()).toBe('https://gateway.kompendium.co');
  });

  /**
   * The default must be a host that serves the API.
   *
   * It was `https://api.certen.io`, which resolves — to the Certen marketing site. Every unconfigured
   * invocation got HTML back, and the failure read as a broken CLI rather than a wrong address. A hostname
   * assertion alone would not have caught that (the old value was a perfectly well-formed URL), so this
   * names the specific wrong answer as well.
   */
  it('does not default to the marketing site', async () => {
    const c = await loadConfig();
    expect(c.getApiUrl()).not.toContain('api.certen.io');
  });

  it('CERTEN_API_URL env wins', async () => {
    process.env.CERTEN_API_URL = 'https://staging.example.com';
    const c = await loadConfig();
    expect(c.getApiUrl()).toBe('https://staging.example.com');
  });
});
