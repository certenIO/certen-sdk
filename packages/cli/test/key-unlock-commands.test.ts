import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * `certen keys unlock`, `keys lock` and `keys list` (the experimental key-unlock feature), driven through the real command tree in-process.
 *
 * What is pinned here is the contract a person or a script sees: the exit codes, the one envelope on stdout in `--json` mode, the `next` line
 * after each refusal, that the switch gates everything except `lock`, and that no output ever carries the key or the passphrase. The function-level
 * rules (what makes an entry valid) are in key-unlock.test.ts.
 *
 * In-process against an in-memory keyring and a throwaway HOME (`homedir` is mocked before anything is imported), so no real credential store or
 * ~/.certen is touched. `process.exitCode` is reset around every run because `keys verify` sets it and `run()` reads it.
 */

const HOME = mkdtempSync(join(tmpdir(), 'certen-keyunlock-cmd-'));
const PW = 'correct horse';
const OTHER_PW = 'another passphrase';
const SWITCH = 'CERTEN_EXPERIMENTAL_KEY_UNLOCK';

const store = new Map<string, string>();
let saved: Record<string, string | undefined>;
let seeds: string[] = [];

interface Out { code: number; stdout: string; stderr: string }

function installKeyring(mode: 'ok' | 'missing' = 'ok'): void {
  if (mode === 'missing') {
    vi.doMock('@napi-rs/keyring', () => { throw new Error('native binary missing'); });
    return;
  }
  vi.doMock('@napi-rs/keyring', () => ({
    AsyncEntry: class {
      private readonly k: string;
      constructor(service: string, account: string) { this.k = `${service}/${account}`; }
      async setPassword(v: string): Promise<void> { store.set(this.k, v); }
      async getPassword(): Promise<string | undefined> { return store.get(this.k); }
      async deletePassword(): Promise<boolean> { return store.delete(this.k); }
    },
  }));
}

async function exec(args: string[], env: Record<string, string | undefined> = {}, keyring: 'ok' | 'missing' = 'ok'): Promise<Out> {
  vi.resetModules();
  const home = () => HOME;
  vi.doMock('node:os', async () => ({ ...(await vi.importActual<typeof import('node:os')>('node:os')), homedir: home }));
  vi.doMock('os', async () => ({ ...(await vi.importActual<typeof import('os')>('os')), homedir: home }));
  installKeyring(keyring);
  // Per-run variables are put back afterwards: a run that unsets the switch must not leave it unset for the next one.
  const restore = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(env)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }

  const out: string[] = [];
  const err: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { out.push(a.join(' ')); });
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { err.push(a.join(' ')); });
  vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => { out.push(String(chunk)); return true; }) as typeof process.stdout.write);
  process.exitCode = undefined;
  const { run } = await import('../src/index.js');
  const code = await run(['node', 'certen', ...args]);
  process.exitCode = undefined;
  vi.restoreAllMocks();
  for (const [k, v] of Object.entries(restore)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  return { code, stdout: out.join('\n'), stderr: err.join('\n') };
}

const envelope = (o: Out): { ok: boolean; data?: any; error?: { code: string; message: string; next?: string } } => {
  const lines = o.stdout.split('\n').filter((l) => l.trim().length > 0);
  expect(lines, `stdout should be exactly one line.\nstdout: ${o.stdout}\nstderr: ${o.stderr}`).toHaveLength(1);
  return JSON.parse(lines[0]!);
};

/** Nothing a command prints may carry the key, in any spelling, or either passphrase. */
function expectNoSecrets(...outs: Out[]): void {
  for (const o of outs) {
    for (const s of [...seeds, PW, OTHER_PW]) {
      expect(o.stdout, 'stdout').not.toContain(s);
      expect(o.stderr, 'stderr').not.toContain(s);
    }
  }
}

beforeAll(async () => {
  vi.resetModules();
  const home = () => HOME;
  vi.doMock('node:os', async () => ({ ...(await vi.importActual<typeof import('node:os')>('node:os')), homedir: home }));
  vi.doMock('os', async () => ({ ...(await vi.importActual<typeof import('os')>('os')), homedir: home }));
  const ks = await import('../src/keystore.js');
  ks.generateKey('dev', PW);
  ks.generateKey('other', OTHER_PW);
  ks.generateKey('plain', null);
  seeds = [];
  for (const [name, pass] of [['dev', PW], ['other', OTHER_PW]] as const) {
    const seed = ks.exportSeed(name, pass);
    seeds.push(seed.toString('base64'), seed.toString('hex'));
  }
}, 60_000);

afterAll(() => {
  vi.doUnmock('node:os');
  vi.doUnmock('os');
  rmSync(HOME, { recursive: true, force: true });
});

beforeEach(() => {
  saved = { [SWITCH]: process.env[SWITCH], CERTEN_KEY_PASSPHRASE: process.env.CERTEN_KEY_PASSPHRASE, CERTEN_API_KEY: process.env.CERTEN_API_KEY };
  process.env[SWITCH] = '1';
  process.env.CERTEN_KEY_PASSPHRASE = PW;
  delete process.env.CERTEN_API_KEY;
  store.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.doUnmock('@napi-rs/keyring');
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});

describe('certen keys unlock', () => {
  it('--json: one envelope with the window, a reminder on stderr, the key in the keyring, and no secret in any output', async () => {
    const before = Date.now();
    const r = await exec(['--json', 'keys', 'unlock', 'dev', '--for', '1h']);
    expect(r.code).toBe(0);
    const env = envelope(r);
    expect(env.ok).toBe(true);
    expect(Object.keys(env.data).sort()).toEqual(['for_seconds', 'name', 'public_key_hash', 'unlocked_until']);
    expect(env.data).toMatchObject({ name: 'dev', for_seconds: 3600 });
    const until = Date.parse(env.data.unlocked_until);
    expect(until).toBeGreaterThanOrEqual(before + 3_600_000);
    expect(until).toBeLessThanOrEqual(Date.now() + 3_600_000);
    expect(env.data.unlocked_until).toMatch(/^\d{4}-\d\d-\d\dT.*Z$/);
    expect(r.stderr).toMatch(/certen keys lock dev/);
    expect([...store.keys()]).toEqual(['certen/unlock:dev']);
    expectNoSecrets(r);
  });

  it('human mode prints the same facts as a table and the reminder', async () => {
    const r = await exec(['keys', 'unlock', 'dev']);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/unlocked_until/);
    expect(r.stdout).toMatch(/for_seconds\s+900/); // the default: fifteen minutes
    expect(r.stderr).toMatch(/Wipe it sooner with: certen keys lock dev/);
    expectNoSecrets(r);
  });

  it('with the switch off it is refused by name, exit 2, nothing unlocked, and the next command is the keys help', async () => {
    const r = await exec(['--json', 'keys', 'unlock', 'dev'], { [SWITCH]: undefined });
    expect(r.code).toBe(2);
    const env = envelope(r);
    expect(env.ok).toBe(false);
    expect(env.error).toMatchObject({ code: 'KEY_UNLOCK_NOT_ENABLED', next: 'certen keys --help' });
    expect(env.error!.message).toMatch(/security review/);
    expect(store.size).toBe(0);
    expectNoSecrets(r);
  });

  it('a switch that is not exactly 1 is off', async () => {
    for (const v of ['true', '0', 'yes']) {
      const r = await exec(['--json', 'keys', 'unlock', 'dev'], { [SWITCH]: v });
      expect(r.code, v).toBe(2);
      expect(envelope(r).error!.code, v).toBe('KEY_UNLOCK_NOT_ENABLED');
    }
    expect(store.size).toBe(0);
  });

  it('refuses a length over the ceiling, or nonsense, with exit 2 and the unlock help as the next step', async () => {
    for (const bad of ['9h', '2d', '0', 'soon', '-3m']) {
      const r = await exec(['--json', 'keys', 'unlock', 'dev', '--for', bad]);
      expect(r.code, bad).toBe(2);
      expect(envelope(r).error, bad).toMatchObject({ code: 'UNLOCK_DURATION_INVALID', next: 'certen keys unlock --help' });
    }
    expect(store.size).toBe(0);
  });

  it('says there is nothing to unlock for a key that is not encrypted', async () => {
    const r = await exec(['--json', 'keys', 'unlock', 'plain']);
    expect(r.code).toBe(2);
    expect(envelope(r).error).toMatchObject({ code: 'KEY_NOT_ENCRYPTED', next: 'certen keys list' });
    expect(store.size).toBe(0);
  });

  it('an unknown key is the key store\'s own error', async () => {
    const r = await exec(['--json', 'keys', 'unlock', 'nope']);
    expect(envelope(r).error!.message).toMatch(/No key named "nope"/);
    expect(store.size).toBe(0);
  });

  it('with no usable keyring it refuses by name (exit 2), writes no file, and the next step is the unlock help', async () => {
    const r = await exec(['--json', 'keys', 'unlock', 'dev'], {}, 'missing');
    expect(r.code).toBe(2);
    expect(envelope(r).error).toMatchObject({ code: 'KEYRING_UNAVAILABLE', next: 'certen keys unlock --help' });
    expect(store.size).toBe(0);
    expectNoSecrets(r);
  });

  it('a wrong passphrase fails (exit 1) with nothing in the keyring, naming the command that checks the passphrase', async () => {
    const r = await exec(['--json', 'keys', 'unlock', 'dev'], { CERTEN_KEY_PASSPHRASE: 'zzz-not-it-zzz' });
    expect(r.code).toBe(1);
    expect(envelope(r).error).toMatchObject({ code: 'WRONG_PASSPHRASE', next: 'certen keys verify dev' });
    expect(store.size).toBe(0);
    // What was typed is not echoed back.
    expect(r.stdout + r.stderr).not.toContain('zzz-not-it-zzz');
  });

  it('without a passphrase and without a terminal it asks for neither and keeps nothing', async () => {
    const r = await exec(['--json', 'keys', 'unlock', 'dev'], { CERTEN_KEY_PASSPHRASE: undefined });
    expect(r.code).toBe(2);
    expect(envelope(r).error!.code).toBe('PASSPHRASE_REQUIRED');
    expect(store.size).toBe(0);
  });
});

describe('certen keys lock', () => {
  it('needs a name or --all, and not both', async () => {
    const none = await exec(['--json', 'keys', 'lock']);
    expect(none.code).toBe(2);
    expect(envelope(none).error).toMatchObject({ code: 'LOCK_TARGET_REQUIRED', next: 'certen keys list' });

    const both = await exec(['--json', 'keys', 'lock', 'dev', '--all']);
    expect(both.code).toBe(2);
    expect(envelope(both).error).toMatchObject({ code: 'CONFLICTING_OPTIONS', next: 'certen keys lock --help' });
  });

  it('wipes one key, says so, and is idempotent', async () => {
    await exec(['--json', 'keys', 'unlock', 'dev']);
    expect(store.size).toBe(1);

    const first = await exec(['--json', 'keys', 'lock', 'dev']);
    expect(first.code).toBe(0);
    expect(envelope(first).data).toEqual({ locked: ['dev'], not_unlocked: [], keyring: 'ok' });
    expect(first.stderr).toMatch(/Locked: dev\. Signing asks for the passphrase again/);
    expect(store.size).toBe(0);

    const again = await exec(['--json', 'keys', 'lock', 'dev']);
    expect(again.code).toBe(0);
    expect(envelope(again).data).toEqual({ locked: [], not_unlocked: ['dev'], keyring: 'ok' });
    expect(again.stderr).toMatch(/Nothing was unlocked: dev/);
  });

  it('--all wipes every key that has a session and reports the rest', async () => {
    await exec(['--json', 'keys', 'unlock', 'dev']);
    await exec(['--json', 'keys', 'unlock', 'other'], { CERTEN_KEY_PASSPHRASE: OTHER_PW });
    expect(store.size).toBe(2);
    const r = await exec(['--json', 'keys', 'lock', '--all']);
    expect(r.code).toBe(0);
    const data = envelope(r).data;
    expect([...data.locked].sort()).toEqual(['dev', 'other']);
    expect(data.not_unlocked).toEqual(['plain']);
    expect(store.size).toBe(0);
  });

  it('works with the switch off', async () => {
    await exec(['--json', 'keys', 'unlock', 'dev']);
    const r = await exec(['--json', 'keys', 'lock', 'dev'], { [SWITCH]: undefined });
    expect(r.code).toBe(0);
    expect(envelope(r).data.locked).toEqual(['dev']);
    expect(store.size).toBe(0);
  });

  it('with no keyring to load it succeeds and says it could not have been unlocked', async () => {
    const r = await exec(['--json', 'keys', 'lock', 'dev'], {}, 'missing');
    expect(r.code).toBe(0);
    expect(envelope(r).data).toEqual({ locked: [], not_unlocked: ['dev'], keyring: 'unavailable' });
    expect(r.stderr).toMatch(/No OS keyring can be loaded here/);
  });
});

describe('certen keys list', () => {
  const rowsOf = (o: Out): Array<Record<string, unknown>> => envelope(o).data;

  it('with the switch off is exactly what it always was: four fields, no unlocked_until, the keyring never consulted', async () => {
    store.set('certen/unlock:dev', '{"planted":true}');
    const r = await exec(['--json', 'keys', 'list'], { [SWITCH]: undefined });
    expect(r.code).toBe(0);
    const rows = rowsOf(r);
    expect(rows.map((x) => x.name)).toEqual(['dev', 'other', 'plain']);
    for (const row of rows) expect(Object.keys(row)).toEqual(['name', 'public_key_hash', 'encrypted', 'created_at']);
    expect(store.get('certen/unlock:dev')).toBe('{"planted":true}'); // not read, so not swept
  });

  it('with the switch on, shows when each session ends (null where there is none)', async () => {
    await exec(['--json', 'keys', 'unlock', 'dev', '--for', '30m']);
    const r = await exec(['--json', 'keys', 'list']);
    const byName = Object.fromEntries(rowsOf(r).map((x) => [x.name as string, x]));
    expect(Object.keys(byName.dev!)).toEqual(['name', 'public_key_hash', 'encrypted', 'created_at', 'unlocked_until']);
    const until = Date.parse(byName.dev!.unlocked_until as string);
    expect(until).toBeGreaterThan(Date.now() + 29 * 60_000);
    expect(until).toBeLessThanOrEqual(Date.now() + 30 * 60_000);
    expect(byName.other!.unlocked_until).toBeNull();
    expect(byName.plain!.unlocked_until).toBeNull();
    expectNoSecrets(r);
  });

  it('human mode adds the column only with the switch on', async () => {
    const off = await exec(['keys', 'list'], { [SWITCH]: undefined });
    expect(off.stdout).not.toMatch(/UNLOCKED_UNTIL/);
    const on = await exec(['keys', 'list']);
    expect(on.stdout).toMatch(/UNLOCKED_UNTIL/);
  });

  it('sweeps an entry that does not check out rather than reporting it', async () => {
    store.set('certen/unlock:dev', 'garbage');
    const r = await exec(['--json', 'keys', 'list']);
    expect(rowsOf(r).find((x) => x.name === 'dev')!.unlocked_until).toBeNull();
    expect(store.has('certen/unlock:dev')).toBe(false);
  });
});

describe('certen keys delete', () => {
  it('with the switch on, takes the key\'s unlocked session with it: a deleted key must not stay usable from the keyring', async () => {
    const gen = await exec(['--json', 'keys', 'generate', '--name', 'doomed']);
    expect(gen.code).toBe(0);
    expect((await exec(['--json', 'keys', 'unlock', 'doomed'])).code).toBe(0);
    expect(store.has('certen/unlock:doomed')).toBe(true);

    const del = await exec(['--json', 'keys', 'delete', 'doomed', '--yes']);
    expect(del.code).toBe(0);
    expect(del.stderr).toMatch(/Also locked the unlocked session for "doomed"/);
    expect(store.has('certen/unlock:doomed')).toBe(false);
  });

  it('with the switch off it does not ask the keyring anything (it is exactly the command it was)', async () => {
    await exec(['--json', 'keys', 'generate', '--name', 'doomed2']);
    store.set('certen/unlock:doomed2', '{"left":"behind"}');
    const del = await exec(['--json', 'keys', 'delete', 'doomed2', '--yes'], { [SWITCH]: undefined });
    expect(del.code).toBe(0);
    expect(del.stderr).not.toMatch(/locked/i);
    // `keys lock --all` is the way to clear what an earlier run left; it works with the switch off.
    expect(store.has('certen/unlock:doomed2')).toBe(true);
  });
});

describe('what the session does not touch', () => {
  it('`keys verify` still asks for the passphrase: it exists to test the passphrase, which a session would skip', async () => {
    await exec(['--json', 'keys', 'unlock', 'dev']);
    const r = await exec(['--json', 'keys', 'verify', 'dev'], { CERTEN_KEY_PASSPHRASE: undefined });
    expect(r.code).toBe(2);
    expect(envelope(r).error!.code).toBe('PASSPHRASE_REQUIRED');
    // ... and with the passphrase it checks the key as it always did.
    const ok = await exec(['--json', 'keys', 'verify', 'dev']);
    expect(ok.code).toBe(0);
    expect(envelope(ok).data).toMatchObject({ name: 'dev', ok: true });
  });

  it('--help --json lists both commands with their options', async () => {
    const r = await exec(['--json', '--help']);
    const tree = JSON.parse(r.stdout.trim()).data;
    const keys = tree.commands.find((c: any) => c.name === 'keys');
    const unlock = keys.commands.find((c: any) => c.name === 'unlock');
    const lock = keys.commands.find((c: any) => c.name === 'lock');
    expect(unlock.options.map((o: any) => o.flags)).toEqual(['--for <duration>']);
    expect(lock.options.map((o: any) => o.flags)).toEqual(['--all']);
    expect(unlock.arguments).toEqual([expect.objectContaining({ name: 'name', required: true })]);
    expect(lock.arguments).toEqual([expect.objectContaining({ name: 'name', required: false })]);
  });
});
