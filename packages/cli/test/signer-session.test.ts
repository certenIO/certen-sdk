import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

/**
 * A command that signs bytes the GATEWAY chose never uses an unlocked session.
 *
 * `keys unlock` (experimental, behind a written review) keeps a decrypted key in the OS keyring so signing stops asking for the passphrase. Every command that
 * signs a transaction still shows what it signs first, rebuilt from the gateway's bytes and matched to the request, so a session removes only the passphrase.
 * `signup --with-key` is different: it signs a 32-byte nonce the gateway picked, which no card can describe, so the passphrase prompt is the one moment a person
 * is made to notice a key is being used. Review question 5 asked whether that prompt should survive a session; it should. `setup` already never used one for
 * its signup nonce; this makes `signup --with-key` the same, with an explicit `session: false` instead of a habit.
 *
 * In-process against an in-memory keyring, a throwaway HOME and an injected clock; the real ~/.certen and the OS keyring are never touched.
 */

const HOME = mkdtempSync(join(tmpdir(), 'certen-signer-session-'));
const SWITCH = 'CERTEN_EXPERIMENTAL_KEY_UNLOCK';
const PASSPHRASE_ENV = 'CERTEN_KEY_PASSPHRASE';
const T0 = Date.UTC(2026, 9, 16, 12, 0, 0);
const MIN = 60_000;
const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');

type Keyring = import('../src/config.js').Keyring;
interface Mem extends Keyring { store: Map<string, string>; calls: { set: number; get: number; del: number } }

function memKeyring(): Mem {
  const store = new Map<string, string>();
  const calls = { set: 0, get: 0, del: 0 };
  return {
    store, calls,
    async setPassword(service, account, value) { calls.set++; store.set(`${service}/${account}`, value); },
    async getPassword(service, account) { calls.get++; return store.get(`${service}/${account}`) ?? null; },
    async deletePassword(service, account) { calls.del++; return store.delete(`${service}/${account}`); },
  };
}

let ks: typeof import('../src/keystore.js');
let su: typeof import('../src/session-unlock.js');
let signer: typeof import('../src/signer.js');
let saved: Record<string, string | undefined> = {};

beforeAll(async () => {
  vi.resetModules();
  const home = () => HOME;
  vi.doMock('node:os', async () => ({ ...(await vi.importActual<typeof import('node:os')>('node:os')), homedir: home }));
  vi.doMock('os', async () => ({ ...(await vi.importActual<typeof import('os')>('os')), homedir: home }));
  ks = await import('../src/keystore.js');
  su = await import('../src/session-unlock.js');
  signer = await import('../src/signer.js');
  ks.generateKey('dev', 'correct horse');
});
afterAll(() => {
  vi.doUnmock('node:os');
  vi.doUnmock('os');
  rmSync(HOME, { recursive: true, force: true });
});
beforeEach(() => {
  saved = { [SWITCH]: process.env[SWITCH], [PASSPHRASE_ENV]: process.env[PASSPHRASE_ENV] };
  process.env[SWITCH] = '1';
  delete process.env[PASSPHRASE_ENV]; // nothing to type and no terminal: a signer can only come from a session
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});

async function withSession(): Promise<Mem> {
  const kr = memKeyring();
  await su.unlockSession('dev', 15 * MIN, async () => 'correct horse', { keyring: kr, now: () => T0 });
  expect(kr.store.size).toBe(1);
  return kr;
}

describe('resolveSigner and an unlocked session', () => {
  it('by default a live session signs with no passphrase at all (what keeps `call` and `send` quiet)', async () => {
    const kr = await withSession();
    const s = await signer.resolveSigner('dev', { sessionOptions: { keyring: kr, now: () => T0 + MIN } });
    expect(s.sign('ab'.repeat(32))).toMatch(/^[0-9a-f]{128}$/);
  });

  it('with `session: false` the session is NOT used, and not even looked at: the passphrase is asked for', async () => {
    const kr = await withSession();
    const readsBefore = kr.calls.get;
    // Nothing to type and no terminal, so a refusal is exactly what "a session was not used" looks like.
    await expect(signer.resolveSigner('dev', { session: false, sessionOptions: { keyring: kr, now: () => T0 + MIN } }))
      .rejects.toMatchObject({ code: 'PASSPHRASE_REQUIRED', exitCode: 2 });
    expect(kr.calls.get).toBe(readsBefore);
  });

  it('with `session: false` and the passphrase supplied, it signs with that, and leaves the session exactly as it was', async () => {
    const kr = await withSession();
    process.env[PASSPHRASE_ENV] = 'correct horse';
    const before = [...kr.store.entries()];
    const s = await signer.resolveSigner('dev', { session: false, sessionOptions: { keyring: kr, now: () => T0 + MIN } });
    expect(s.sign('cd'.repeat(32))).toMatch(/^[0-9a-f]{128}$/);
    expect([...kr.store.entries()]).toEqual(before);
  });

  it('signs the same bytes either way (a session replaces only the passphrase)', async () => {
    const kr = await withSession();
    process.env[PASSPHRASE_ENV] = 'correct horse';
    const viaSession = await signer.resolveSigner('dev', { sessionOptions: { keyring: kr, now: () => T0 + MIN } });
    const viaPassphrase = await signer.resolveSigner('dev', { session: false, sessionOptions: { keyring: kr, now: () => T0 + MIN } });
    const hash = 'ef'.repeat(32);
    expect(viaSession.sign(hash)).toBe(viaPassphrase.sign(hash)); // Ed25519 is deterministic
  });
});

describe('which commands refuse a session', () => {
  const read = (f: string): string => readFileSync(join(SRC, f), 'utf8');

  it('`signup --with-key` passes `session: false` to the signer', () => {
    expect(read('commands/signup.ts')).toMatch(/resolveSigner\(opts\.withKey,\s*\{\s*session:\s*false\s*\}\)/);
  });

  it('`setup` never reaches a session at all (its signup nonce is signed with the passphrase it already holds)', () => {
    const setup = read('setup.ts');
    expect(setup).not.toMatch(/sessionSigner|resolveSigner/);
  });

  it('a session is read in exactly two places: the signer (unless told not to) and `keys sign`, which rebuilds and shows what it signs first', () => {
    const files = ['setup.ts', 'signer.ts', 'credential-flow.ts', 'command-context.ts', ...['call', 'send', 'transaction', 'governance', 'pending', 'identity', 'signup', 'keys', 'init', 'auth'].map((f) => `commands/${f}.ts`)];
    expect(files.filter((f) => /sessionSigner\(/.test(read(f)))).toEqual(['signer.ts', 'commands/keys.ts']);
  });
});
