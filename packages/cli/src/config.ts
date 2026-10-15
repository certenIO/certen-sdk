import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync, statSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { UsageError } from './errors.js';

const CONFIG_DIR = join(homedir(), '.certen');
const CONFIG_FILE = join(CONFIG_DIR, 'config.json');

/** The profile every config has always been: its credential and gateway stay at the top level of config.json. */
export const DEFAULT_PROFILE = 'default';
const PROFILE_ENV_VAR = 'CERTEN_PROFILE';
/**
 * Profile names become a JSON key, a keyring account (`api_key:<name>`) and an argument on a command line, so the alphabet is
 * small on purpose. A name like `../x` or `a b` is refused before it can become any of them.
 */
const PROFILE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;

/**
 * One named setup: a gateway, the context to use on it, and the credential for it.
 *
 * **The credential is per profile because the gateway is.** A profile names its own gateway URL, so a key shared across profiles
 * would be sent to whichever host the active profile points at. A named profile therefore never falls back to the default
 * profile's key; it has its own, or it has none.
 *
 * For the `default` profile only `identity`, `key`, `chain` and `allow_mainnet_default` live here. Its gateway URL and credential
 * stay at the top level of the file, where every existing config already has them, so adding profiles migrates nothing.
 */
export interface ProfileSettings {
  /** The identity commands act as when none is given: a UUID, an `acc://` ADI URL or an alias (`certen use identity` stores the UUID). */
  identity?: string;
  /** The local signing key a command that signs uses when none is named. */
  key?: string;
  /** The chain commands target when none is given. Never a mainnet unless `allow_mainnet_default` says so. */
  chain?: string;
  api_url?: string;
  /** Permit a chain that is not a known testnet to come from this profile as a default on a value-moving command. */
  allow_mainnet_default?: boolean;
  /** Credential, named profiles only. */
  api_key?: string;
  storage?: 'file' | 'keyring';
  key_prefix?: string;
}

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
  /**
   * Identities this machine created, most recent last.
   *
   * The gateway has no identity collection route, and `/v1/portfolio` — the only cross-identity
   * view — keys on ADI URL and does not return the UUID that every other command takes. So an id
   * that is not written down when it is minted is unrecoverable: `certen identity create` printed
   * it once, and after that the only copy was the user's scrollback.
   *
   * That is what made `init` unable to be idempotent in a useful way. It could see that
   * identities existed and still had nothing to put after `--identity`.
   *
   * `name` is the name the identity was created with. It is what `--identity <alias>` matches, together with the label of the ADI
   * (`acc://jason-dev.acme` → `jason-dev`). Records written before it existed have none, and match on the ADI label alone.
   */
  identities?: Array<{ id: string; adi_url: string; chains: string[]; created_at: string; name?: string }>;
  /** The saved active profile. Absent means `default`. `--profile` and `CERTEN_PROFILE` override it. */
  profile?: string;
  profiles?: Record<string, ProfileSettings>;
}

/**
 * Record an identity this machine created.
 *
 * Deduplicated on id, and appended rather than replaced, so creating a second identity does not
 * make the first unfindable.
 */
export function rememberIdentity(entry: { id: string; adi_url: string; chains: string[]; name?: string }): void {
  const cfg = readConfig();
  const identities = (cfg.identities ?? []).filter((i) => i.id !== entry.id);
  identities.push({ ...entry, created_at: new Date().toISOString() });
  cfg.identities = identities;
  writeConfig(cfg);
}

/** The most recently created identity on this machine, if any. */
export function lastIdentity(): { id: string; adi_url: string; chains: string[] } | undefined {
  const all = readConfig().identities ?? [];
  return all.length > 0 ? all[all.length - 1] : undefined;
}

/** Every identity this machine has recorded, oldest first. */
export function recordedIdentities(): NonNullable<CliConfig['identities']> {
  return [...(readConfig().identities ?? [])];
}

/**
 * Drop a retired identity from the local record.
 *
 * Without this, `certen init` would keep offering to reuse an identity the gateway no longer
 * tracks. It recovers on its own — the lookup 404s and it creates a fresh one — but silently
 * doing the right thing after an avoidable round trip is worse than not recording a dead id.
 */
export function forgetIdentity(id: string): void {
  const cfg = readConfig();
  if (!cfg.identities?.some((i) => i.id === id)) return;
  cfg.identities = cfg.identities.filter((i) => i.id !== id);
  writeConfig(cfg);
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

// ── profiles ────────────────────────────────────────────────────────────────────────────────────

let profileOverride: string | undefined;

export function assertProfileName(name: string): string {
  if (!PROFILE_NAME_RE.test(name)) {
    throw new UsageError(
      `"${name}" is not a valid profile name: use 1 to 32 letters, digits, "-" or "_", starting with a letter or a digit.`,
      'INVALID_PROFILE_NAME',
    );
  }
  return name;
}

/** The profile `--profile` named on this command line, or undefined to clear it. Validated here, once, before anything uses it. */
export function setProfileOverride(name: string | undefined): void {
  profileOverride = name === undefined ? undefined : assertProfileName(name);
}

/**
 * The profile this invocation runs as: `--profile`, then `CERTEN_PROFILE`, then the saved active profile, then `default`.
 *
 * A name that arrives from the environment or the file is validated like one from the command line: it is about to become a
 * keyring account.
 */
export function activeProfile(): string {
  const fromEnv = process.env[PROFILE_ENV_VAR];
  const name = profileOverride ?? (fromEnv ? fromEnv : undefined) ?? readConfig().profile ?? DEFAULT_PROFILE;
  return assertProfileName(name);
}

export function profileExists(name: string): boolean {
  return name === DEFAULT_PROFILE || Boolean(readConfig().profiles?.[name]);
}

/** `default` first, then the rest by name. */
export function listProfiles(): string[] {
  const named = Object.keys(readConfig().profiles ?? {}).filter((n) => n !== DEFAULT_PROFILE).sort();
  return [DEFAULT_PROFILE, ...named];
}

/** A usage error naming the profiles that do exist, for a command that must not run as a profile nobody made. */
export function assertProfileKnown(name: string): void {
  if (profileExists(name)) return;
  throw new UsageError(
    `There is no profile "${name}". Profiles: ${listProfiles().join(', ')}. `
    + `Create it by setting something on it, for example: certen use chain base-sepolia --profile ${name}`,
    'PROFILE_NOT_FOUND',
  );
}

/** What a profile says about context and gateway (never its credential). Does not create the config file. */
export function readProfile(name: string = activeProfile()): Pick<ProfileSettings, 'identity' | 'key' | 'chain' | 'api_url' | 'allow_mainnet_default'> {
  const cfg = readConfig();
  const p = cfg.profiles?.[name] ?? {};
  return {
    ...(p.identity !== undefined ? { identity: p.identity } : {}),
    ...(p.key !== undefined ? { key: p.key } : {}),
    ...(p.chain !== undefined ? { chain: p.chain } : {}),
    ...(name === DEFAULT_PROFILE
      ? (cfg.api_url !== undefined ? { api_url: cfg.api_url } : {})
      : (p.api_url !== undefined ? { api_url: p.api_url } : {})),
    ...(p.allow_mainnet_default !== undefined ? { allow_mainnet_default: p.allow_mainnet_default } : {}),
  };
}

type ProfilePatch = {
  [K in 'identity' | 'key' | 'chain' | 'api_url']?: string | null;
} & { allow_mainnet_default?: boolean | null };

/**
 * Set (or, with `null`, unset) settings on a profile, creating it if it is new. `undefined` leaves a setting alone.
 *
 * The default profile's gateway URL is written where it has always lived, at the top level.
 */
export function updateProfile(name: string, patch: ProfilePatch): void {
  assertProfileName(name);
  if (typeof patch.api_url === 'string') validateGatewayUrl(patch.api_url);
  const cfg = readConfig();
  const profiles = { ...(cfg.profiles ?? {}) };
  const current: ProfileSettings = { ...(profiles[name] ?? {}) };

  for (const key of ['identity', 'key', 'chain', 'allow_mainnet_default'] as const) {
    const v = patch[key];
    if (v === undefined) continue;
    if (v === null) delete current[key];
    else (current as Record<string, unknown>)[key] = v;
  }

  if (patch.api_url !== undefined) {
    if (name === DEFAULT_PROFILE) {
      if (patch.api_url === null) delete cfg.api_url;
      else cfg.api_url = patch.api_url;
    } else if (patch.api_url === null) {
      delete current.api_url;
    } else {
      current.api_url = patch.api_url;
    }
  }

  // The default profile exists without an entry, and its URL and credential live at the top level, so an empty entry for it says
  // nothing. A NAMED profile with nothing set is still a profile: an empty entry is how one is created.
  if (name === DEFAULT_PROFILE && Object.keys(current).length === 0) delete profiles[name];
  else profiles[name] = current;
  if (Object.keys(profiles).length === 0) delete cfg.profiles;
  else cfg.profiles = profiles;
  writeConfig(cfg);
}

function validateGatewayUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new UsageError(`"${url}" is not a URL. Give the gateway's address, for example https://gateway.kompendium.co`, 'INVALID_GATEWAY_URL');
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new UsageError(`"${url}" is not an http(s) URL. Give the gateway's address, for example https://gateway.kompendium.co`, 'INVALID_GATEWAY_URL');
  }
}

/** Make `name` the saved active profile. It has to exist: switching to a typo would silently run as nobody. */
export function setActiveProfile(name: string): void {
  assertProfileName(name);
  assertProfileKnown(name);
  const cfg = readConfig();
  if (name === DEFAULT_PROFILE) delete cfg.profile;
  else cfg.profile = name;
  writeConfig(cfg);
}

// ── credentials ─────────────────────────────────────────────────────────────────────────────────

type Credential = { storage?: 'file' | 'keyring'; api_key?: string; key_prefix?: string };

function credentialOf(cfg: CliConfig, profile: string): Credential {
  if (profile === DEFAULT_PROFILE) return { storage: cfg.storage, api_key: cfg.api_key, key_prefix: cfg.key_prefix };
  const p = cfg.profiles?.[profile] ?? {};
  return { storage: p.storage, api_key: p.api_key, key_prefix: p.key_prefix };
}

/** Replace a profile's credential fields in `cfg` (in memory). A `null` field is removed. */
function putCredential(cfg: CliConfig, profile: string, next: { [K in keyof Credential]?: Credential[K] | null }): void {
  const target: Record<string, unknown> = profile === DEFAULT_PROFILE
    ? (cfg as Record<string, unknown>)
    : (((cfg.profiles ??= {})[profile] ??= {}) as Record<string, unknown>);
  for (const [k, v] of Object.entries(next)) {
    if (v === null) delete target[k];
    else if (v !== undefined) target[k] = v;
  }
}

/** What is stored for a profile, without ever reading the secret: for `auth status`, `whoami` and the device flow. */
export function credentialInfo(profile: string = activeProfile()): { storage?: 'file' | 'keyring'; key_prefix?: string; has_file_key: boolean } {
  const c = credentialOf(readConfig(), profile);
  // A file credential written by hand, or by an older CLI, may carry no saved prefix: the first 12 characters of the key are
  // what `auth status` has always shown, and they are a lookup field, not the secret.
  const prefix = c.key_prefix ?? (c.api_key ? c.api_key.substring(0, 12) : undefined);
  return { storage: c.storage, key_prefix: prefix, has_file_key: Boolean(c.api_key) };
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

/**
 * The OS keyring through @napi-rs/keyring, an optional dependency with prebuilt binaries for Windows, macOS and Linux
 * (it replaced the archived keytar). A missing module, or one whose native binary does not load on this platform, is
 * null here, and callers refuse by name (KEYRING_UNAVAILABLE) rather than falling back to a file.
 */
async function loadKeyring(): Promise<Keyring | null> {
  try {
    const mod = await import('@napi-rs/keyring');
    return {
      setPassword: (service, account, value) => new mod.AsyncEntry(service, account).setPassword(value),
      getPassword: async (service, account) => (await new mod.AsyncEntry(service, account).getPassword()) ?? null,
      deletePassword: (service, account) => new mod.AsyncEntry(service, account).deletePassword(),
    };
  } catch {
    return null;
  }
}

const KEYRING_SERVICE = 'certen';
/** `api_key` for the default profile, exactly as before; `api_key:<profile>` for a named one. */
const keyringAccount = (profile: string): string => (profile === DEFAULT_PROFILE ? 'api_key' : `api_key:${profile}`);

/**
 * Read the API key with the following precedence:
 *   1. CERTEN_API_KEY env (always wins so CI never touches the keyring/file)
 *   2. OS keyring when the profile's storage='keyring'
 *   3. config.json (only if perms are 0600 or stricter)
 *
 * Of the PROFILE'S OWN credential: a named profile never reads the default profile's key, because that key belongs to another
 * gateway.
 */
export async function getApiKey(profile: string = activeProfile()): Promise<string> {
  const envKey = process.env.CERTEN_API_KEY;
  if (envKey) return envKey;

  assertProfileKnown(profile);
  const cfg = readConfig();
  const cred = credentialOf(cfg, profile);
  if (cred.storage === 'keyring') {
    const kr = await loadKeyring();
    if (kr) {
      let v: string | null;
      try {
        v = await kr.getPassword(KEYRING_SERVICE, keyringAccount(profile));
      } catch (e) {
        throw new UsageError(
          `storage=keyring but the OS keyring could not be read (${e instanceof Error ? e.message : String(e)}); set CERTEN_API_KEY, or run "certen auth login --no-keyring".`,
          'KEYRING_UNAVAILABLE',
        );
      }
      if (v) return v;
    } else {
      throw new UsageError(
        'storage=keyring requested but the OS keyring module (`@napi-rs/keyring`) could not be loaded; reinstall the CLI with its optional dependencies or set CERTEN_API_KEY.',
        'KEYRING_UNAVAILABLE',
      );
    }
  }

  if (cred.api_key) {
    if (!configFileIsSecure()) {
      throw new UsageError(
        'refusing to read ~/.certen/config.json — file permissions are not 0600. '
        + 'Run `certen auth login` again to fix.',
        'CONFIG_PERMISSIONS',
      );
    }
    return cred.api_key;
  }

  if (profile !== DEFAULT_PROFILE) {
    throw new UsageError(
      `No API key configured for profile "${profile}". Run "certen auth login --api-key <key> --profile ${profile}" or set CERTEN_API_KEY. `
      + 'A profile does not use another profile\'s key: it belongs to a different gateway.',
      'NO_API_KEY',
    );
  }
  throw new UsageError(
    'No API key configured. Run "certen auth login --api-key <key>" or set CERTEN_API_KEY.',
    'NO_API_KEY',
  );
}

export async function setApiKey(apiKey: string, useKeyring: boolean, profile: string = activeProfile()): Promise<void> {
  assertProfileName(profile);
  const prefix = apiKey.substring(0, 12);
  if (useKeyring) {
    const kr = await loadKeyring();
    if (!kr) {
      throw new Error('the OS keyring module (`@napi-rs/keyring`) could not be loaded; reinstall the CLI with its optional dependencies or pass --no-keyring');
    }
    try {
      await kr.setPassword(KEYRING_SERVICE, keyringAccount(profile), apiKey);
    } catch (e) {
      // A platform with no usable keyring (a headless Linux box with no secret service) says so here. The key is not written
      // anywhere else: a file is a different, weaker store and the user chooses it with --no-keyring.
      throw new Error(`the OS keyring refused the key (${e instanceof Error ? e.message : String(e)}); pass --no-keyring to store it in ~/.certen/config.json at 0600, or set CERTEN_API_KEY`);
    }
    const cfg = readConfig();
    putCredential(cfg, profile, { storage: 'keyring', key_prefix: prefix, api_key: null });
    writeConfig(cfg);
    return;
  }
  const cfg = readConfig();
  putCredential(cfg, profile, { storage: 'file', api_key: apiKey, key_prefix: prefix });
  writeConfig(cfg);
}

export async function clearApiKey(profile: string = activeProfile()): Promise<void> {
  assertProfileKnown(profile);
  const cfg = readConfig();
  if (credentialOf(cfg, profile).storage === 'keyring') {
    // The key lives in the OS keyring, so logging out means deleting it there. If the keyring cannot be reached, say so and leave the
    // configuration as it is rather than reporting a logout that left the key behind.
    const kr = await loadKeyring();
    if (!kr) {
      throw new UsageError(
        'storage=keyring but the OS keyring module (`@napi-rs/keyring`) could not be loaded, so the saved key cannot be removed from it; reinstall the CLI with its optional dependencies, or delete the "certen" credential from your OS keyring yourself and then ~/.certen/config.json.',
        'KEYRING_UNAVAILABLE',
      );
    }
    try {
      await kr.deletePassword(KEYRING_SERVICE, keyringAccount(profile));
    } catch (e) {
      throw new UsageError(
        `storage=keyring but the saved key could not be removed from the OS keyring (${e instanceof Error ? e.message : String(e)}); remove the "certen" credential yourself, then ~/.certen/config.json.`,
        'KEYRING_UNAVAILABLE',
      );
    }
  }
  putCredential(cfg, profile, { api_key: null, key_prefix: null, storage: 'file' });
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

/**
 * `CERTEN_API_URL`, then the active profile's own URL, then the top-level URL, then the default.
 *
 * A named profile without a URL of its own uses the top-level one: that is a convenience for the address only. Its credential
 * is its own (see {@link getApiKey}).
 */
export function getApiUrl(): string {
  const envUrl = process.env.CERTEN_API_URL;
  if (envUrl) return envUrl;

  const cfg = readConfig();
  const profile = activeProfile();
  const own = profile === DEFAULT_PROFILE ? undefined : cfg.profiles?.[profile]?.api_url;
  return own ?? cfg.api_url ?? DEFAULT_API_URL;
}

/**
 * Where a human goes to do the things a machine key cannot — register a payer wallet, invite a
 * teammate, revoke a key.
 *
 * Derived from the API URL rather than hardcoded, so a self-hosted gateway points at its own
 * portal instead of at ours. `CERTEN_PORTAL_URL` overrides for a deployment that serves the two
 * from different hosts.
 *
 * This exists because the funding hint printed the literal string "/portal" as an instruction — a
 * bare path with no host, which is not somewhere anyone can go. The 402 handler had it right all
 * along by reading `portal_url` off the error; there was simply nothing equivalent for the paths
 * that have no error to read it from.
 */
export function getPortalUrl(): string {
  const envUrl = process.env.CERTEN_PORTAL_URL;
  if (envUrl) return envUrl;
  return `${getApiUrl().replace(/\/+$/, '')}/portal`;
}

export function getOutputFormat(): 'table' | 'json' {
  const cfg = readConfig();
  return cfg.output ?? 'table';
}
