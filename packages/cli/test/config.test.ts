import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, statSync, chmodSync, existsSync } from 'fs';
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
// state (e.g. saved keytar mocks) doesn't leak.
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
  vi.doUnmock('keytar');
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

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(c.getApiKey()).rejects.toThrowError('process.exit(1)');
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('refusing to read'));

    exitSpy.mockRestore();
    errSpy.mockRestore();
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
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(c.getApiKey()).rejects.toThrowError('process.exit(1)');
    exitSpy.mockRestore();
  });
});

describe('CLI config: keyring storage', () => {
  it('round-trips via the keyring when storage=keyring', async () => {
    vi.doMock('keytar', () => ({
      setPassword: vi.fn().mockResolvedValue(undefined),
      getPassword: vi.fn().mockResolvedValue('ck_live_FROM_KEYRING'),
      deletePassword: vi.fn().mockResolvedValue(true),
    }));
    const c = await loadConfig();
    await c.setApiKey('ck_live_setviakeyring', true);
    const raw = JSON.parse(readFileSync(CONFIG_FILE(), 'utf-8'));
    expect(raw.storage).toBe('keyring');
    expect(raw.api_key).toBeUndefined();
    const v = await c.getApiKey();
    expect(v).toBe('ck_live_FROM_KEYRING');
  });

  it('round-2 #43: persists key_prefix in config.json when storing in the keyring', async () => {
    vi.doMock('keytar', () => ({
      setPassword: vi.fn().mockResolvedValue(undefined),
      getPassword: vi.fn().mockResolvedValue('ck_live_prefixedkey'),
      deletePassword: vi.fn().mockResolvedValue(true),
    }));
    const c = await loadConfig();
    await c.setApiKey('ck_live_prefixedkey', true);
    const raw = JSON.parse(readFileSync(CONFIG_FILE(), 'utf-8'));
    expect(raw.storage).toBe('keyring');
    expect(raw.key_prefix).toBe('ck_live_pref'); // first 12 chars
    expect(raw.api_key).toBeUndefined();
  });

  it('clears key_prefix on logout', async () => {
    vi.doMock('keytar', () => ({
      setPassword: vi.fn().mockResolvedValue(undefined),
      getPassword: vi.fn().mockResolvedValue('ck_live_x'),
      deletePassword: vi.fn().mockResolvedValue(true),
    }));
    const c = await loadConfig();
    await c.setApiKey('ck_live_x_prefix', true);
    await c.clearApiKey();
    const raw = JSON.parse(readFileSync(CONFIG_FILE(), 'utf-8'));
    expect(raw.key_prefix).toBeUndefined();
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
