import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync, statSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { UsageError } from './errors.js';

const CONFIG_DIR = join(homedir(), '.certen');
const CONFIG_FILE = join(CONFIG_DIR, 'config.json');

export interface CliConfig {
  api_key?: string;
  api_url?: string;
  output?: 'table' | 'json';
  /** When 'keyring', api_key in this file is unused; the OS keyring is the source of truth. */
  storage?: 'file' | 'keyring';
  /**
   * Round-2 #43: when storage=keyring, the actual key isn't in this file.
   * Persist its prefix (first 12 chars) so `auth status` can still show
   * which key is selected without round-tripping through the keyring.
   */
  key_prefix?: string;
}

export function readConfig(): CliConfig {
  if (!existsSync(CONFIG_FILE)) {
    return {};
  }
  try {
    const raw = readFileSync(CONFIG_FILE, 'utf-8');
    return JSON.parse(raw) as CliConfig;
  } catch {
    return {};
  }
}

/**
 * Write the config file with 0600 perms (owner read/write only). On Windows,
 * filesystem permissions are not enforced the same way; we still call
 * chmod to flag intent.
 */
export function writeConfig(config: CliConfig): void {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true });
  }
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), { encoding: 'utf-8', mode: 0o600 });
  try {
    chmodSync(CONFIG_FILE, 0o600);
  } catch {
    // Windows or non-permission-aware FS: best effort.
  }
}

/**
 * If the config file exists with world/group read permissions, warn the
 * user and refuse to read the api_key. Forces explicit re-login under
 * 0600 perms, or env-var-only operation.
 *
 * POSIX only. This used to claim it was cross-platform, but Windows has no POSIX mode bits:
 * `chmod` is a no-op there and `statSync().mode` reports a synthesized 0666 (0444 when the
 * read-only attribute is set), so `mode & 0o077` is never 0 and this returned false for every
 * Windows user. The effect was that `certen auth login --no-keyring` wrote a key the CLI then
 * refused to read, with an error telling them to re-run the login that had just succeeded.
 * Access control on Windows is the file's ACL, inherited from the user profile directory.
 */
function configFileIsSecure(): boolean {
  if (process.platform === 'win32') return true;
  try {
    const stat = statSync(CONFIG_FILE);
    const mode = stat.mode & 0o077;
    return mode === 0;
  } catch {
    return true; // missing file is fine; we just have no key
  }
}

interface Keyring {
  setPassword(service: string, account: string, value: string): Promise<void>;
  getPassword(service: string, account: string): Promise<string | null>;
  deletePassword(service: string, account: string): Promise<boolean>;
}

async function loadKeyring(): Promise<Keyring | null> {
  try {
    const mod = await import('keytar');
    return mod as unknown as Keyring;
  } catch {
    return null;
  }
}

const KEYRING_SERVICE = 'certen';
const KEYRING_ACCOUNT = 'api_key';

/**
 * Read the API key with the following precedence:
 *   1. CERTEN_API_KEY env (always wins so CI never touches the keyring/file)
 *   2. OS keyring when storage='keyring'
 *   3. config.json (only if perms are 0600 or stricter)
 */
export async function getApiKey(): Promise<string> {
  const envKey = process.env.CERTEN_API_KEY;
  if (envKey) return envKey;

  const cfg = readConfig();
  if (cfg.storage === 'keyring') {
    const kr = await loadKeyring();
    if (kr) {
      const v = await kr.getPassword(KEYRING_SERVICE, KEYRING_ACCOUNT);
      if (v) return v;
    } else {
      throw new UsageError(
        'storage=keyring requested but `keytar` is not installed; install it or set CERTEN_API_KEY.',
        'KEYRING_UNAVAILABLE',
      );
    }
  }

  if (cfg.api_key) {
    if (!configFileIsSecure()) {
      throw new UsageError(
        'refusing to read ~/.certen/config.json — file permissions are not 0600. '
        + 'Run `certen auth login` again to fix.',
        'CONFIG_PERMISSIONS',
      );
    }
    return cfg.api_key;
  }

  throw new UsageError(
    'No API key configured. Run "certen auth login --api-key <key>" or set CERTEN_API_KEY.',
    'NO_API_KEY',
  );
}

export async function setApiKey(apiKey: string, useKeyring: boolean): Promise<void> {
  const prefix = apiKey.substring(0, 12);
  if (useKeyring) {
    const kr = await loadKeyring();
    if (!kr) {
      throw new Error('keytar is not installed; install it with `npm i keytar -g` or pass --no-keyring');
    }
    await kr.setPassword(KEYRING_SERVICE, KEYRING_ACCOUNT, apiKey);
    const cfg = readConfig();
    cfg.storage = 'keyring';
    cfg.key_prefix = prefix;
    delete cfg.api_key;
    writeConfig(cfg);
    return;
  }
  const cfg = readConfig();
  cfg.storage = 'file';
  cfg.api_key = apiKey;
  cfg.key_prefix = prefix;
  writeConfig(cfg);
}

export async function clearApiKey(): Promise<void> {
  const cfg = readConfig();
  if (cfg.storage === 'keyring') {
    const kr = await loadKeyring();
    if (kr) await kr.deletePassword(KEYRING_SERVICE, KEYRING_ACCOUNT);
  }
  delete cfg.api_key;
  delete cfg.key_prefix;
  cfg.storage = 'file';
  writeConfig(cfg);
}

/**
 * The gateway this CLI talks to when nothing else says.
 *
 * Must be a host that actually serves the API. This was `https://api.certen.io`, which resolves to the
 * Certen marketing site, so every unconfigured invocation got HTML back and the failure looked like a
 * broken CLI rather than a wrong address.
 */
export const DEFAULT_API_URL = 'https://gateway.kompendium.co';

export function getApiUrl(): string {
  const envUrl = process.env.CERTEN_API_URL;
  if (envUrl) return envUrl;

  const cfg = readConfig();
  return cfg.api_url ?? DEFAULT_API_URL;
}

export function getOutputFormat(): 'table' | 'json' {
  const cfg = readConfig();
  return cfg.output ?? 'table';
}
