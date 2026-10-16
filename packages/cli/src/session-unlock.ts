import { loadKeyring, KEYRING_SERVICE, type Keyring } from './config.js';
import { exportSeed, keyFromSeed, getKeyInfo, assertValidName, type KeyInfo } from './keystore.js';
import { parseSpanMs } from './duration.js';
import { CliError, UsageError, EXIT } from './errors.js';
import { keyArg } from './next-step.js';
import { hint } from './output.js';

/**
 * A key that stays unlocked for a while (`certen keys unlock dev --for 15m`).
 *
 * Every command that signs asks for the key's passphrase, and a person doing five sends in a row types it five times. An unlocked session
 * trades a bounded window of exposure for that typing: the DECRYPTED key is kept in the OS keyring with an expiry, `certen keys lock` wipes
 * it, and until then signing commands do not prompt.
 *
 * THIS SHIPS BEHIND A SECURITY REVIEW (docs/security/keys-unlock-review.md; PLAN W7, HARNESS §4). It is complete, tested and INERT: nothing
 * here creates or reads a session unless `CERTEN_EXPERIMENTAL_KEY_UNLOCK=1`. One function, `keyUnlockEnabled()`, gates both halves, so with
 * the switch off a keyring entry somebody planted is never even read. `keys lock` is the one thing that works either way, because wiping is
 * always safe. Making it default-on, after the review is signed, is a one-line change to `keyUnlockEnabled()`.
 *
 * WHAT IS STORED. The 32-byte Ed25519 seed (base64), the hash of the public key it belongs to, and two absolute times. Not the passphrase: a
 * person reuses a passphrase, a seed unlocks exactly one key. Under service `certen`, account `unlock:<key name>`, as one small JSON string (the
 * Windows credential blob is about 2.5 KB; this is about 200 bytes).
 *
 * WHAT IS TRUSTED WHEN IT IS READ BACK: nothing. The keyring is shared with every process the user runs, so an entry is a claim, and it is
 * checked on every use (see `sessionSigner`): version, key hash, a sane and unexpired window, no clock that has gone backwards, and finally that
 * the seed DERIVES the public key in the key file. An entry that fails any check is deleted and the normal passphrase path runs, so a planted
 * entry can make a command ask for the passphrase and can never make one sign with the wrong key.
 *
 * EXPIRY IS ENFORCED ON USE. There is no daemon. An entry past its time is never honoured and is deleted by the next command that looks at it
 * (any signing command, `keys list`, `keys lock`), but its bytes sit in the keyring until then. The review says so; `keys lock` is how to be sure.
 */

export const UNLOCK_ENV = 'CERTEN_EXPERIMENTAL_KEY_UNLOCK';
export const REVIEW_DOC = 'docs/security/keys-unlock-review.md';

/** The default and the ceiling of a session. A ceiling because a window nobody can shrink is the main risk of the feature (review §6). */
export const DEFAULT_UNLOCK_MS = 15 * 60_000;
export const MAX_UNLOCK_MS = 8 * 3_600_000;
/** How far into the future an entry's `unlocked_at` may be before the clock is judged to have been turned back. */
const CLOCK_SKEW_MS = 60_000;

const PROBE_ACCOUNT = 'unlock-probe';
const accountFor = (name: string): string => `unlock:${name}`;

/** Is the experimental switch on? The only place that decides, for creating a session and for reading one. */
export function keyUnlockEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[UNLOCK_ENV] === '1';
}

export function assertUnlockEnabled(): void {
  if (keyUnlockEnabled()) return;
  throw new UsageError(
    'Keeping a key unlocked ships behind a security review and is not enabled in this release '
    + `(${REVIEW_DOC}). Nothing was unlocked. Signing commands ask for the passphrase, or read CERTEN_KEY_PASSPHRASE.`,
    'KEY_UNLOCK_NOT_ENABLED',
  );
}

/** `--for`: a positive duration, a bare number meaning minutes, never more than the ceiling. */
export function unlockSpanMs(text: string | undefined): number {
  if (text === undefined) return DEFAULT_UNLOCK_MS;
  const ms = parseSpanMs(text, 'minutes', '--for', 'UNLOCK_DURATION_INVALID');
  if (ms > MAX_UNLOCK_MS) {
    throw new UsageError(
      `--for "${text}" is longer than a key may stay unlocked: at most ${MAX_UNLOCK_MS / 3_600_000}h. Unlock it again when it expires.`,
      'UNLOCK_DURATION_INVALID',
    );
  }
  return ms;
}

interface Session {
  v: 1;
  key_hash: string;
  seed: string;
  unlocked_at: number;
  expires_at: number;
}

export interface SessionOptions {
  /** Epoch milliseconds. Injected so a test can stand on either side of an expiry without waiting. */
  now?: () => number;
  /** A keyring to use instead of the OS one; `null` means none is available. */
  keyring?: Keyring | null;
}

async function openKeyring(opts: SessionOptions): Promise<Keyring | null> {
  return opts.keyring !== undefined ? opts.keyring : loadKeyring();
}

/** Text with every secret in it blanked: a keyring error is shown to a person, and none of them should ever be able to carry a key. */
function scrub(text: string, secrets: string[]): string {
  return secrets.reduce((t, s) => (s.length > 0 ? t.split(s).join('[removed]') : t), text);
}

const unavailable = (why: string): UsageError => new UsageError(
  `The OS keyring cannot hold an unlocked key here (${why}). Nothing was unlocked, and it is never kept anywhere else, so this machine keeps asking `
  + 'for the passphrase.',
  'KEYRING_UNAVAILABLE',
);

/**
 * Prove the keyring works BEFORE the passphrase is asked for: write a value that is not a secret, read it back, delete it. A person who types a
 * passphrase and is then told there is nowhere to keep the result has been asked for a secret for nothing.
 */
async function probe(keyring: Keyring): Promise<void> {
  try {
    await keyring.setPassword(KEYRING_SERVICE, PROBE_ACCOUNT, 'ok');
    const back = await keyring.getPassword(KEYRING_SERVICE, PROBE_ACCOUNT);
    if (back !== 'ok') throw new Error('it did not return what was written');
  } catch (e) {
    try { await keyring.deletePassword(KEYRING_SERVICE, PROBE_ACCOUNT); } catch { /* the probe holds nothing secret */ }
    throw unavailable(e instanceof Error ? e.message : String(e));
  }
  try { await keyring.deletePassword(KEYRING_SERVICE, PROBE_ACCOUNT); } catch { /* nothing secret was left in it */ }
}

export interface UnlockResult {
  name: string;
  public_key_hash: string;
  unlocked_at: number;
  expires_at: number;
}

/**
 * Decrypt a key and keep the result in the OS keyring until `now + ttl`.
 *
 * The order is the point. Everything that can refuse does so before the passphrase is read: the switch, an unknown key, a key with nothing to
 * unlock, a keyring that does not work. A wrong passphrase ends the command with nothing written. The seed exists in this function only
 * between the decryption and the write, and is zeroed after.
 */
export async function unlockSession(
  name: string,
  ttlMs: number,
  getPassphrase: (info: KeyInfo) => Promise<string | null>,
  opts: SessionOptions = {},
): Promise<UnlockResult> {
  assertUnlockEnabled();
  const now = opts.now ?? Date.now;
  const info = getKeyInfo(name);
  if (!info.encrypted) {
    throw new UsageError(
      `Key "${name}" is stored unencrypted, so signing with it never asks for a passphrase: there is nothing to unlock.`,
      'KEY_NOT_ENCRYPTED',
    );
  }
  const keyring = await openKeyring(opts);
  if (!keyring) throw unavailable('the keyring module (`@napi-rs/keyring`) could not be loaded');
  await probe(keyring);

  const passphrase = await getPassphrase(info);
  let seed: Buffer;
  try {
    seed = exportSeed(name, passphrase);
  } catch (err) {
    // Typed key-store errors (WRONG_PASSPHRASE, PASSPHRASE_REQUIRED, KEY_FILE_*) pass through as they are; see signer.ts.
    if (err instanceof CliError) throw err;
    throw new CliError(
      err instanceof Error ? err.message : String(err), 'WRONG_PASSPHRASE', EXIT.FAILED, false, undefined, `certen keys verify ${keyArg(name)}`,
    );
  }

  const unlockedAt = now();
  const session: Session = { v: 1, key_hash: info.publicKeyHash, seed: seed.toString('base64'), unlocked_at: unlockedAt, expires_at: unlockedAt + ttlMs };
  const secrets = [session.seed, seed.toString('hex')];
  try {
    await keyring.setPassword(KEYRING_SERVICE, accountFor(name), JSON.stringify(session));
  } catch (e) {
    // A write that failed may still have left something; the caller was told nothing is unlocked, so make that true.
    try { await keyring.deletePassword(KEYRING_SERVICE, accountFor(name)); } catch { /* nothing more can be done */ }
    throw unavailable(scrub(e instanceof Error ? e.message : String(e), secrets));
  } finally {
    seed.fill(0);
  }
  return { name, public_key_hash: info.publicKeyHash, unlocked_at: unlockedAt, expires_at: session.expires_at };
}

type Judged =
  | { ok: true; session: Session }
  | { ok: false; why: 'unreadable' | 'version' | 'wrong-key' | 'window' | 'expired' | 'clock' | 'too-long' };

/** Everything that can be said about an entry without deriving anything from its seed. */
function judge(raw: string, info: KeyInfo, now: number): Judged {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return { ok: false, why: 'unreadable' }; }
  if (parsed === null || typeof parsed !== 'object') return { ok: false, why: 'unreadable' };
  const s = parsed as Partial<Session>;
  if (s.v !== 1) return { ok: false, why: 'version' };
  if (typeof s.key_hash !== 'string' || typeof s.seed !== 'string'
    || typeof s.unlocked_at !== 'number' || typeof s.expires_at !== 'number'
    || !Number.isFinite(s.unlocked_at) || !Number.isFinite(s.expires_at)) return { ok: false, why: 'unreadable' };
  if (s.key_hash !== info.publicKeyHash) return { ok: false, why: 'wrong-key' };
  // The window an entry claims for itself must be one `unlock` could have made.
  if (s.expires_at <= s.unlocked_at || s.expires_at - s.unlocked_at > MAX_UNLOCK_MS) return { ok: false, why: 'window' };
  // Unlocked "in the future": the clock was turned back (or the entry was written by something with a different one). Either way the window
  // cannot be measured, so it is not honoured.
  if (s.unlocked_at > now + CLOCK_SKEW_MS) return { ok: false, why: 'clock' };
  if (now >= s.expires_at) return { ok: false, why: 'expired' };
  // Expires further from now than a session can last: edited, or the clock moved. The same reasoning.
  if (s.expires_at - now > MAX_UNLOCK_MS) return { ok: false, why: 'too-long' };
  return { ok: true, session: s as Session };
}

const REASONS: Record<string, string> = {
  expired: 'it has expired',
  unreadable: 'it could not be read',
  version: 'it is not a format this CLI wrote',
  'wrong-key': 'it belongs to a different key',
  window: 'its time window is not one this CLI would have set',
  clock: 'the clock has gone backwards since it was made',
  'too-long': 'it claims to last longer than a session can',
  'derives-other-key': 'it does not unlock this key',
};

async function readEntry(keyring: Keyring, name: string): Promise<string | null> {
  try { return (await keyring.getPassword(KEYRING_SERVICE, accountFor(name))) ?? null; } catch { return null; }
}

async function discard(keyring: Keyring, name: string): Promise<void> {
  try { await keyring.deletePassword(KEYRING_SERVICE, accountFor(name)); } catch { /* it stays unhonoured either way */ }
}

/**
 * The signer for a key that is currently unlocked, or undefined (the caller then asks for the passphrase, as it always did).
 *
 * With the switch off this returns at once and does not load the keyring module, let alone read it. A session is never an error: a missing
 * one is the ordinary case, an expired one says so once on stderr, and one that does not check out is removed and named, because that is the
 * only trace a planted entry leaves.
 */
export async function sessionSigner(
  name: string,
  info: KeyInfo,
  opts: SessionOptions = {},
): Promise<{ sign: (hashHex: string) => string } | undefined> {
  if (!keyUnlockEnabled()) return undefined;
  if (!info.encrypted) return undefined;
  const keyring = await openKeyring(opts);
  if (!keyring) return undefined;
  const raw = await readEntry(keyring, name);
  if (raw === null) return undefined;

  const now = (opts.now ?? Date.now)();
  const judged = judge(raw, info, now);
  if (!judged.ok) {
    await discard(keyring, name);
    hint(judged.why === 'expired'
      ? `The unlocked session for key "${name}" has expired; asking for the passphrase.`
      : `Ignored and removed an unlocked session for key "${name}": ${REASONS[judged.why]}.`);
    return undefined;
  }

  let seed: Buffer;
  try { seed = Buffer.from(judged.session.seed, 'base64'); } catch { seed = Buffer.alloc(0); }
  try {
    // The check that makes a planted entry harmless: the seed must DERIVE the public key in the key file. A different key's seed, or noise, signs nothing.
    const key = keyFromSeed(seed);
    if (key.publicKey !== info.publicKey) {
      await discard(keyring, name);
      hint(`Ignored and removed an unlocked session for key "${name}": ${REASONS['derives-other-key']}.`);
      return undefined;
    }
    return { sign: key.sign };
  } catch {
    await discard(keyring, name);
    hint(`Ignored and removed an unlocked session for key "${name}": ${REASONS.unreadable}.`);
    return undefined;
  } finally {
    seed.fill(0);
  }
}

/**
 * When a key's session ends (epoch ms), or null. For `keys list`, which shows metadata and never touches key material: it judges the entry's
 * claims and does not look at the seed. An entry that fails is swept, as everywhere. Null with the switch off, without reading anything.
 */
export async function unlockedUntil(name: string, info: KeyInfo, opts: SessionOptions = {}): Promise<number | null> {
  if (!keyUnlockEnabled() || !info.encrypted) return null;
  const keyring = await openKeyring(opts);
  if (!keyring) return null;
  const raw = await readEntry(keyring, name);
  if (raw === null) return null;
  const judged = judge(raw, info, (opts.now ?? Date.now)());
  if (!judged.ok) {
    await discard(keyring, name);
    return null;
  }
  return judged.session.expires_at;
}

export interface LockResult {
  /** Entries that existed and were removed. */
  wiped: string[];
  /** Keys that had no session. */
  not_unlocked: string[];
  /** `unavailable`: no OS keyring can be loaded here, so no session can exist to wipe. */
  keyring: 'ok' | 'unavailable';
}

/**
 * Wipe the sessions of the named keys. Works with the switch off: a session left by an earlier run, or by a build where it was on, must be
 * removable by a build where it is not.
 *
 * A keyring that cannot be LOADED is not a failure: `unlock` cannot create a session without it, so there is nothing here to wipe, and it is
 * said so. A keyring that loads and then REFUSES to delete is a failure (exit 2): a person told "locked" must be right, so every name is
 * tried and the ones that could not be confirmed are listed.
 */
export async function lockSessions(names: string[], opts: SessionOptions = {}): Promise<LockResult> {
  for (const name of names) {
    try { assertValidName(name); } catch (err) {
      throw new UsageError(err instanceof Error ? err.message : String(err), 'UNKNOWN_KEY');
    }
  }
  const keyring = await openKeyring(opts);
  if (!keyring) return { wiped: [], not_unlocked: [...names], keyring: 'unavailable' };

  const wiped: string[] = [];
  const absent: string[] = [];
  const failed: string[] = [];
  for (const name of names) {
    try {
      (await keyring.deletePassword(KEYRING_SERVICE, accountFor(name)) ? wiped : absent).push(name);
    } catch {
      failed.push(name);
    }
  }
  if (failed.length > 0) {
    throw new UsageError(
      `The OS keyring would not confirm that ${failed.length === 1 ? 'the session for key' : 'the sessions for keys'} ${failed.map((n) => `"${n}"`).join(', ')} `
      + `${failed.length === 1 ? 'was' : 'were'} removed, so ${failed.length === 1 ? 'it' : 'they'} may still be unlocked. Remove the "${KEYRING_SERVICE}" entr`
      + `${failed.length === 1 ? 'y' : 'ies'} ${failed.map((n) => `"${accountFor(n)}"`).join(', ')} from your OS keyring yourself.`,
      'KEYRING_UNAVAILABLE',
    );
  }
  return { wiped, not_unlocked: absent, keyring: 'ok' };
}
