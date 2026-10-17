import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CliError, EXIT, UsageError } from '../src/errors.js';

/**
 * Every error the key store raises is typed.
 *
 * They used to be bare `Error`s, which the top-level handler could only call `UNKNOWN_ERROR` and exit `1` for: `keys show nope`, an invalid key name, a key
 * that already exists and "passphrases did not match" were indistinguishable, by code or by exit, from a rejected request. Phase 5 left them alone because
 * typing them changes an exit code, which the contract says must never happen quietly. This is the loud version: the exit code follows the contract's own
 * definitions (2 = the invocation was wrong, including naming a key that is not there, as `certen use key nope` has always done; 1 = the operation did not
 * succeed, including a key file that exists and cannot be used), and the messages are exactly what they were, so nothing a person reads moves.
 *
 * Two layers: the key store in-process (the class, the code, the exit and the message of each situation), and the built CLI (the envelope, the exit code
 * and the `next` a caller actually gets).
 */

let tmpHome = '';
beforeEach(() => { tmpHome = mkdtempSync(join(tmpdir(), 'certen-keyerr-')); });
afterEach(() => {
  vi.doUnmock('node:os');
  vi.doUnmock('os');
  vi.doUnmock('fs');
  vi.restoreAllMocks();
  rmSync(tmpHome, { recursive: true, force: true });
});

async function load(opts: { statMode?: number } = {}) {
  vi.resetModules();
  const home = () => tmpHome;
  vi.doMock('node:os', async () => ({ ...(await vi.importActual<typeof import('node:os')>('node:os')), homedir: home }));
  vi.doMock('os', async () => ({ ...(await vi.importActual<typeof import('os')>('os')), homedir: home }));
  if (opts.statMode !== undefined) {
    // POSIX modes cannot be set on this filesystem on Windows, so the permission check is exercised by saying what stat reports.
    vi.doMock('fs', async () => {
      const actual = await vi.importActual<typeof import('fs')>('fs');
      return { ...actual, statSync: (p: string) => ({ ...actual.statSync(p), mode: opts.statMode! }) };
    });
  }
  return { ks: await import('../src/keystore.js'), signer: await import('../src/signer.js') };
}

const caught = (fn: () => unknown): CliError => {
  try { fn(); } catch (e) { return e as CliError; }
  throw new Error('expected the call to throw');
};
const caughtAsync = async (fn: () => Promise<unknown>): Promise<CliError> => {
  try { await fn(); } catch (e) { return e as CliError; }
  throw new Error('expected the call to throw');
};
const keyFile = (name: string): string => join(tmpHome, '.certen', 'keys', `${name}.json`);
/**
 * How a test plants a damaged or unusual key file. The key store refuses a key file that group or world can read BEFORE it looks inside, on every platform but
 * Windows (which has no POSIX modes), so a fixture written with the process's default mode (0644 under the usual umask 022) is `KEY_FILE_INSECURE`, never the
 * `KEY_FILE_CORRUPT` or `KEY_FILE_UNSUPPORTED` the test is about. These pass on Windows and fail on Linux unless the file is owner-only, as the CLI writes its own.
 */
const OWNER_ONLY = { encoding: 'utf-8', mode: 0o600 } as const;

describe('the key store raises typed errors', () => {
  it('an invalid key name is a usage error (INVALID_KEY_NAME, exit 2), and the message is what it was', async () => {
    const { ks } = await load();
    for (const bad of ['', '../x', 'a/b', '-lead', 'x'.repeat(65), 'sp ace']) {
      const e = caught(() => ks.assertValidName(bad));
      expect(e.name, bad).toBe('UsageError');
      expect(e.code, bad).toBe('INVALID_KEY_NAME');
      expect(e.exitCode, bad).toBe(EXIT.USAGE);
      expect(e.message, bad).toMatch(/^Invalid key name ".*"\. Use 1-64 characters: letters, digits, hyphen, underscore; must start with a letter or digit\.$/s);
    }
  });

  it('a key that is not there is UNKNOWN_KEY (exit 2), the code `certen use key` already uses, from every door', async () => {
    const { ks, signer } = await load();
    for (const f of [() => ks.getKeyInfo('nope'), () => ks.readKeyFile('nope'), () => ks.deleteKey('nope'), () => ks.isEncrypted('nope'), () => ks.unlockKey('nope', null)]) {
      const e = caught(f);
      expect(e.name).toBe('UsageError');
      expect(e.code).toBe('UNKNOWN_KEY');
      expect(e.exitCode).toBe(EXIT.USAGE);
      expect(e.message).toMatch(/^No key named "nope"\./);
    }
    // And through the signer, which used to be the one place a missing key surfaced mid-command.
    const viaSigner = await caughtAsync(() => signer.resolveSigner('nope'));
    expect(viaSigner.code).toBe('UNKNOWN_KEY');
    expect(viaSigner.exitCode).toBe(EXIT.USAGE);
  });

  it('the missing-key message still tells the person what to do next (keys list, keys generate)', async () => {
    const { ks } = await load();
    expect(caught(() => ks.getKeyInfo('dev')).message).toBe('No key named "dev". Run `certen keys list` to see what you have, or `certen keys generate --name dev`.');
  });

  it('generating over an existing name is KEY_EXISTS (exit 2), naming the file', async () => {
    const { ks } = await load();
    ks.generateKey('dev', null);
    const e = caught(() => ks.generateKey('dev', null));
    expect(e.name).toBe('UsageError');
    expect(e.code).toBe('KEY_EXISTS');
    expect(e.exitCode).toBe(EXIT.USAGE);
    expect(e.message).toContain(`Key "dev" already exists at ${keyFile('dev')}`);
  });

  it('an encrypted key with no passphrase is PASSPHRASE_REQUIRED (exit 2) and carries the key, not "wrong passphrase"', async () => {
    const { ks } = await load();
    ks.generateKey('locked', 'pw');
    const e = caught(() => ks.unlockKey('locked', null));
    expect(e.code).toBe('PASSPHRASE_REQUIRED');
    expect(e.exitCode).toBe(EXIT.USAGE);
    expect(e.message).toMatch(/is encrypted — a passphrase is required/);
    expect(e.details).toEqual({ key: 'locked' });
  });

  it('a wrong passphrase is WRONG_PASSPHRASE (exit 1, not retryable) and carries the key, so `next` can name `keys verify <key>`', async () => {
    const { ks } = await load();
    ks.generateKey('dev', 'right');
    for (const f of [() => ks.unlockKey('dev', 'wrong'), () => ks.signHash('dev', 'wrong', 'ab'.repeat(32)), () => ks.exportSeed('dev', 'wrong')]) {
      const e = caught(f);
      expect(e.name).toBe('CliError');
      expect(e.code).toBe('WRONG_PASSPHRASE');
      expect(e.exitCode).toBe(EXIT.FAILED);
      expect(e.retryable).toBe(false);
      expect(e.details).toEqual({ key: 'dev' });
      expect(e.message).toMatch(/Could not decrypt key "dev" — wrong passphrase, or the file has been modified/);
    }
  });

  it('a hash that is not even-length hex is INVALID_HASH (exit 2)', async () => {
    const { ks } = await load();
    ks.generateKey('dev', null);
    for (const f of [() => ks.signHash('dev', null, 'nothex'), () => ks.signHash('dev', null, 'abc'), () => ks.unlockKey('dev', null).sign('zz')]) {
      const e = caught(f);
      expect(e.code).toBe('INVALID_HASH');
      expect(e.exitCode).toBe(EXIT.USAGE);
      expect(e.message).toMatch(/--hash must be an even-length hex string/);
    }
  });

  it('a key file that is not JSON is KEY_FILE_CORRUPT (exit 1), naming the file, and `keys list` still lists the others', async () => {
    const { ks } = await load();
    ks.generateKey('good', null);
    writeFileSync(keyFile('bad'), '{ this is not json', OWNER_ONLY);
    writeFileSync(keyFile('empty'), 'null', OWNER_ONLY);
    for (const name of ['bad', 'empty']) {
      const e = caught(() => ks.getKeyInfo(name));
      expect(e.code, name).toBe('KEY_FILE_CORRUPT');
      expect(e.exitCode, name).toBe(EXIT.FAILED);
      expect(e.message, name).toContain(keyFile(name));
      expect(e.message, name).not.toMatch(/Unexpected token|SyntaxError/);
    }
    expect(ks.listKeys().map((k) => k.name)).toEqual(['good']);
  });

  it('an unsupported version or algorithm is KEY_FILE_UNSUPPORTED (exit 1), and so is a key that is not a plain Ed25519 seed', async () => {
    const { ks } = await load();
    ks.generateKey('dev', null);
    const stored = JSON.parse(readFileSync(keyFile('dev'), 'utf-8'));
    writeFileSync(keyFile('v9'), JSON.stringify({ ...stored, name: 'v9', version: 9 }), OWNER_ONLY);
    writeFileSync(keyFile('rsa'), JSON.stringify({ ...stored, name: 'rsa', algorithm: 'rsa' }), OWNER_ONLY);
    writeFileSync(keyFile('odd'), JSON.stringify({ ...stored, name: 'odd', privateKey: 'aabbcc' }), OWNER_ONLY);
    expect(caught(() => ks.getKeyInfo('v9'))).toMatchObject({ code: 'KEY_FILE_UNSUPPORTED', exitCode: EXIT.FAILED });
    expect(caught(() => ks.getKeyInfo('v9')).message).toMatch(/has unsupported version 9 \(this CLI understands 1\)/);
    expect(caught(() => ks.getKeyInfo('rsa'))).toMatchObject({ code: 'KEY_FILE_UNSUPPORTED', exitCode: EXIT.FAILED });
    expect(caught(() => ks.exportSeed('odd', null))).toMatchObject({ code: 'KEY_FILE_UNSUPPORTED', exitCode: EXIT.FAILED, details: { key: 'odd' } });
  });

  it('a key file other people can read is KEY_FILE_INSECURE (exit 1) on a POSIX platform, and says how to fix it', async () => {
    const original = Object.getOwnPropertyDescriptor(process, 'platform')!;
    try {
      Object.defineProperty(process, 'platform', { value: 'linux' });
      const { ks } = await load({ statMode: 0o100644 });
      ks.generateKey('dev', null);
      const e = caught(() => ks.getKeyInfo('dev'));
      expect(e.code).toBe('KEY_FILE_INSECURE');
      expect(e.exitCode).toBe(EXIT.FAILED);
      expect(e.message).toMatch(/^Refusing to read .* — permissions are not 0600\. Run: chmod 600 /);
    } finally {
      Object.defineProperty(process, 'platform', original);
    }
  });

  it('every message the key store can raise is unchanged by being typed', async () => {
    // Pinned elsewhere too (keystore.test.ts, keystore-unlock.test.ts, send.test.ts); asserted once more here so a retype cannot reword anything.
    const { ks } = await load();
    ks.generateKey('dev', 'pw');
    expect(caught(() => ks.unlockKey('dev', 'x')).message).toBe('Could not decrypt key "dev" — wrong passphrase, or the file has been modified.');
    expect(caught(() => ks.unlockKey('dev', null)).message).toBe('Key "dev" is encrypted — a passphrase is required.');
    expect(caught(() => ks.deleteKey('zzz')).message).toBe('No key named "zzz".');
  });
});

describe('the wrappers no longer relabel what they did not cause', () => {
  it('resolveSigner: a key that needs a passphrase when none can be asked for is PASSPHRASE_REQUIRED, never "wrong passphrase"', async () => {
    const { ks, signer } = await load();
    ks.generateKey('locked', 'pw');
    const prior = process.env.CERTEN_KEY_PASSPHRASE;
    delete process.env.CERTEN_KEY_PASSPHRASE;
    try {
      const e = await caughtAsync(() => signer.resolveSigner('locked'));
      expect(e.code).toBe('PASSPHRASE_REQUIRED');
      expect(e.exitCode).toBe(EXIT.USAGE);
    } finally {
      if (prior !== undefined) process.env.CERTEN_KEY_PASSPHRASE = prior;
    }
  });

  it('resolveSigner: a wrong passphrase stays WRONG_PASSPHRASE (exit 1) with `next` naming keys verify for that key', async () => {
    const { ks, signer } = await load();
    ks.generateKey('dev', 'right');
    process.env.CERTEN_KEY_PASSPHRASE = 'wrong';
    try {
      const e = await caughtAsync(() => signer.resolveSigner('dev'));
      expect(e.code).toBe('WRONG_PASSPHRASE');
      expect(e.exitCode).toBe(EXIT.FAILED);
      const { nextStepFor } = await import('../src/next-step.js');
      expect(nextStepFor(e, ['send'])).toBe('certen keys verify dev');
    } finally {
      delete process.env.CERTEN_KEY_PASSPHRASE;
    }
  });
});

// ── the built CLI ──────────────────────────────────────────────────────────────────────────────────

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'index.js');
let cliHome = '';

function certen(args: string[], env: Record<string, string> = {}): { stdout: string; stderr: string; code: number } {
  const base: NodeJS.ProcessEnv = { ...process.env, HOME: cliHome, USERPROFILE: cliHome, NO_PROXY: '*', ...env };
  for (const k of ['CERTEN_API_KEY', 'CERTEN_API_URL', 'CERTEN_KEY_PASSPHRASE', 'CERTEN_PROFILE', 'CERTEN_EXPERIMENTAL_KEY_UNLOCK']) if (!(k in env)) delete base[k];
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...args], { env: base, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { stdout, stderr: '', code: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; status?: number };
    return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', code: e.status ?? -1 };
  }
}
const errorOf = (r: { stdout: string }): { code: string; message: string; retryable: boolean; next: string } => {
  const env = JSON.parse(r.stdout.trim());
  expect(env.ok).toBe(false);
  return env.error;
};

describe('the built CLI: exit codes, envelopes and `next` for key-store failures', () => {
  beforeEach(() => {
    if (!existsSync(CLI)) throw new Error(`built CLI not found at ${CLI} — run \`node scripts/build-all.mjs\` before the CLI suite`);
    cliHome = mkdtempSync(join(tmpdir(), 'certen-keyerr-cli-'));
  });
  afterEach(() => { rmSync(cliHome, { recursive: true, force: true }); });

  it('keys show/verify/delete on a missing key: exit 2, UNKNOWN_KEY, next is `certen keys list`', () => {
    for (const args of [['keys', 'show', 'nope'], ['keys', 'verify', 'nope'], ['keys', 'delete', 'nope', '--yes']]) {
      const r = certen(['--json', ...args]);
      expect(r.code, args.join(' ')).toBe(2);
      const e = errorOf(r);
      expect(e.code, args.join(' ')).toBe('UNKNOWN_KEY');
      expect(e.retryable).toBe(false);
      expect(e.next).toBe('certen keys list');
      expect(e.message).toMatch(/^No key named "nope"\./);
    }
  });

  it('keys generate with a name that is not a valid file name: exit 2, INVALID_KEY_NAME, next is the command\'s help', () => {
    const r = certen(['--json', 'keys', 'generate', '--name', '../escape', '--no-passphrase']);
    expect(r.code).toBe(2);
    const e = errorOf(r);
    expect(e.code).toBe('INVALID_KEY_NAME');
    expect(e.next).toBe('certen keys generate --help');
    expect(existsSync(join(cliHome, '.certen', 'keys'))).toBe(false); // nothing was written, nor a directory made to hold it
  });

  it('keys generate over an existing name: exit 2, KEY_EXISTS, the first key is untouched', () => {
    expect(certen(['--json', 'keys', 'generate', '--name', 'dev', '--no-passphrase']).code).toBe(0);
    const before = readFileSync(join(cliHome, '.certen', 'keys', 'dev.json'), 'utf-8');
    const r = certen(['--json', 'keys', 'generate', '--name', 'dev', '--no-passphrase']);
    expect(r.code).toBe(2);
    expect(errorOf(r)).toMatchObject({ code: 'KEY_EXISTS', next: 'certen keys list' });
    expect(readFileSync(join(cliHome, '.certen', 'keys', 'dev.json'), 'utf-8')).toBe(before);
  });

  it('a corrupt key file: exit 1, KEY_FILE_CORRUPT (the operation failed; the invocation was fine), next is `certen keys path`', () => {
    mkdirSync(join(cliHome, '.certen', 'keys'), { recursive: true });
    writeFileSync(join(cliHome, '.certen', 'keys', 'bad.json'), '{ not json', OWNER_ONLY);
    const r = certen(['--json', 'keys', 'show', 'bad']);
    expect(r.code).toBe(1);
    expect(errorOf(r)).toMatchObject({ code: 'KEY_FILE_CORRUPT', retryable: false, next: 'certen keys path' });
  });

  it('keys verify with the wrong passphrase: exit 1, WRONG_PASSPHRASE, next is `certen keys verify dev`', () => {
    expect(certen(['--json', 'keys', 'generate', '--name', 'dev'], { CERTEN_KEY_PASSPHRASE: 'right' }).code).toBe(0);
    const r = certen(['--json', 'keys', 'verify', 'dev'], { CERTEN_KEY_PASSPHRASE: 'wrong' });
    expect(r.code).toBe(1);
    expect(errorOf(r)).toMatchObject({ code: 'WRONG_PASSPHRASE', retryable: false, next: 'certen keys verify dev' });
    const ok = certen(['--json', 'keys', 'verify', 'dev'], { CERTEN_KEY_PASSPHRASE: 'right' });
    expect(ok.code).toBe(0);
  });

  it('table mode: the human error names the code and ends with `next:`, and stdout stays empty', () => {
    const r = certen(['keys', 'show', 'nope']);
    expect(r.code).toBe(2);
    expect(r.stdout.trim()).toBe('');
    expect(r.stderr).toContain('Error [UNKNOWN_KEY]: No key named "nope".');
    expect(r.stderr.trimEnd().split('\n').pop()).toBe('  next: certen keys list');
  });
});
