import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startSetupGateway, FAKE, type SetupGateway, type SetupGatewayOptions } from './helpers/setup-gateway.js';
import type { Prompter } from '../src/prompt.js';
import type { SetupIo, SetupOptions } from '../src/setup.js';

/**
 * The parts of `certen setup` that exist because a person is at a terminal: the questions, and the offer to retire a failed identity.
 *
 * Driven in-process with a scripted prompter, because a test cannot sit at a TTY. The scripted prompter answers from a queue and records
 * every question, so each case can assert both what was asked and what was done with the answer. The real prompter has its own tests.
 *
 * What is pinned is what a wrong guess would cost:
 * - the kind of account is asked BEFORE a key is made, so a person who gives no answer leaves nothing behind, and is never guessed (creating
 *   an organisation is not something to do on an Enter);
 * - retiring a failed identity is offered and done only on a yes: it frees the one slot an organisation made with a key has, and is a decision;
 * - Ctrl-C while waiting for funds stops cleanly, and the listener for it is gone afterwards (a listener that stays removes node's default).
 */

let scratch = '';
vi.mock('os', async (orig) => ({ ...(await orig<typeof import('os')>()), homedir: () => scratch }));
vi.mock('node:os', async (orig) => ({ ...(await orig<typeof import('node:os')>()), homedir: () => scratch }));

let gw: SetupGateway | undefined;
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'certen-interactive-'));
  for (const v of Object.keys(process.env)) if (v.startsWith('CERTEN_')) delete process.env[v];
  vi.resetModules();
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await gw?.close();
  gw = undefined;
  try { rmSync(scratch, { recursive: true, force: true }); } catch { /* noop */ }
});

async function gateway(options: SetupGatewayOptions = {}): Promise<SetupGateway> {
  gw = await startSetupGateway(options);
  process.env.CERTEN_API_URL = gw.url;
  return gw;
}

type Answer = string | boolean | undefined;
function scripted(answers: Answer[]): Prompter & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    interactive: true,
    async ask(q, fallback) { asked.push(q); const a = answers.shift(); return typeof a === 'string' ? a : fallback; },
    async confirm(q, d) { asked.push(q); const a = answers.shift(); return typeof a === 'boolean' ? a : d; },
    async choose(q) { asked.push(q); const a = answers.shift(); return typeof a === 'string' ? a : undefined; },
  };
}

const options = (over: Partial<SetupOptions> = {}): SetupOptions => ({
  yes: false, noPassphrase: true, keyring: false, browser: false, provisioning: { timeoutMs: 20_000, intervalMs: 20 }, pollIntervalGiven: true,
  funds: { timeoutMs: 20_000, intervalMs: 20 }, ...over,
});
const io = (prompter: Prompter, over: Partial<SetupIo> = {}): SetupIo => ({ interactive: true, prompter, say: () => undefined, note: () => undefined, ...over });

async function load() {
  return {
    setup: await import('../src/setup.js'),
    keys: await import('../src/keystore.js'),
    cfg: await import('../src/config.js'),
  };
}

describe('which kind of account', () => {
  it('is asked before the key is made, and a person who gives no answer leaves nothing behind', async () => {
    await gateway();
    const m = await load();
    const p = scripted([undefined]);
    await expect(m.setup.runSetup(options(), io(p))).rejects.toMatchObject({ code: 'NO_API_KEY' });
    expect(p.asked).toHaveLength(1);
    expect(p.asked[0]).toContain('no API key is configured');
    expect(m.keys.listKeys()).toEqual([]);
    expect(gw!.calls).toHaveLength(0);
  });

  it('"new" creates the account with the key, and the key had been made first', async () => {
    const g = await gateway({ fundAfterReads: 1 });
    const m = await load();
    const p = scripted(['new', 'dev', 'mine']);
    const out = await m.setup.runSetup(options(), io(p));
    expect(out.state).toBe('ready');
    expect(p.asked.map((q) => q.trim().split(/\s{2,}/)[0])).toEqual(['Sign-in', '2. Signing key', '4. Identity']);
    expect(g.state.signups).toBe(1);
    expect(g.state.lastCreateBody).toMatchObject({ name: 'mine' });
    expect(out.created).toEqual({ key: true, account: true, identity: true });
  });

  it('"existing" runs the device flow and does not sign up', async () => {
    const g = await gateway({ fundAfterReads: 1, devicePendingPolls: 0 });
    const m = await load();
    const out = await m.setup.runSetup(options(), io(scripted(['existing', 'dev', 'mine'])));
    expect(out.state).toBe('ready');
    expect(g.state.signups).toBe(0);
    expect(g.count('POST /v1/portal/device')).toBe(1);
  });

  it('a saved key the gateway rejects is replaced only if the person agrees', async () => {
    const g = await gateway({ acceptedKeys: ['ck_live_other'], fundAfterReads: 1 });
    const m = await load();
    mkdirSync(join(scratch, '.certen'), { recursive: true });
    // Owner-only, as `auth login` writes it: off Windows a config file holding a key that group or world can read is refused (CONFIG_PERMISSIONS) before the key is used.
    writeFileSync(join(scratch, '.certen', 'config.json'), JSON.stringify({ api_key: 'ck_live_stale', storage: 'file' }), { mode: 0o600 });

    // Questions, in order: the name of the new key, then whether to replace the saved key.
    const declined = scripted(['dev', false]);
    await expect(m.setup.runSetup(options(), io(declined))).rejects.toMatchObject({ code: 'CREDENTIAL_REJECTED' });
    expect(g.state.signups).toBe(0);
    expect(declined.asked.some((q) => q.includes('was rejected'))).toBe(true);

    // The key now exists, so: replace the saved key (yes), which kind of account, the identity's name.
    const agreed = scripted([true, 'new', 'mine']);
    const out = await m.setup.runSetup(options(), io(agreed));
    expect(out.state).toBe('ready');
    expect(g.state.signups).toBe(1);
    expect(m.cfg.readConfig().api_key).not.toBe('ck_live_stale');
  });
});

describe('the questions that have a default', () => {
  it('asks which key when several are on the machine and none is chosen, and uses the answer', async () => {
    await gateway({ acceptedKeys: ['ck_live_have'], fundAfterReads: 1 });
    process.env.CERTEN_API_KEY = 'ck_live_have';
    const m = await load();
    m.keys.generateKey('alpha', null);
    m.keys.generateKey('beta', null);
    const p = scripted(['beta', 'mine']);
    const out = await m.setup.runSetup(options(), io(p));
    expect(out.context.key).toBe('beta');
    expect(p.asked[0]).toContain('which one to use');
    expect(out.created.key).toBe(false);
  });

  it('without a person to ask, several keys are a usage error that lists them', async () => {
    await gateway({ acceptedKeys: ['ck_live_have'] });
    process.env.CERTEN_API_KEY = 'ck_live_have';
    const m = await load();
    m.keys.generateKey('alpha', null);
    m.keys.generateKey('beta', null);
    await expect(m.setup.runSetup(options({ yes: true }), io(scripted([]), { interactive: false }))).rejects.toMatchObject({ code: 'AMBIGUOUS_KEY' });
  });
});

describe('an identity that failed to provision', () => {
  async function failedOnce(): Promise<{ m: Awaited<ReturnType<typeof load>>; g: SetupGateway }> {
    const g = await gateway({ finalStatus: 'error' });
    const m = await load();
    await expect(m.setup.runSetup(options(), io(scripted(['new', 'dev', 'broken'])))).rejects.toMatchObject({ code: 'IDENTITY_PROVISIONING_FAILED' });
    g.setFinalStatus('active');
    g.fund();
    return { m, g };
  }

  it('is retired and replaced when the person says yes, and only then', async () => {
    const { m, g } = await failedOnce();
    const failed = g.state.identities[0]!.id;
    const p = scripted([true, 'fresh']);
    const out = await m.setup.runSetup(options(), io(p));
    expect(p.asked[0]).toContain('failed to provision');
    expect(p.asked[0]).toContain('the key page could not be created');
    expect(g.state.retired).toEqual([failed]);
    expect(g.count('POST /v1/identity')).toBe(2);
    expect(out.state).toBe('ready');
    expect(out.created.identity).toBe(true);
    // The old record is gone from this machine, and the new identity is the context.
    expect(m.cfg.recordedIdentities().map((r) => r.id)).toEqual([g.state.identities[1]!.id]);
    expect(m.cfg.readProfile().identity).toBe(g.state.identities[1]!.id);
  });

  it('is left alone when the person says no', async () => {
    const { m, g } = await failedOnce();
    await expect(m.setup.runSetup(options(), io(scripted([false])))).rejects.toMatchObject({
      code: 'IDENTITY_PROVISIONING_FAILED',
      message: expect.stringContaining(`certen identity retire ${g.state.identities[0]!.id} --yes`),
    });
    expect(g.state.retired).toEqual([]);
    expect(g.count('POST /v1/identity')).toBe(1);
  });

  it('is never retired by --yes, which is not a decision about someone\'s identity', async () => {
    const { m, g } = await failedOnce();
    const p = scripted([true]);
    await expect(m.setup.runSetup(options({ yes: true }), io(p))).rejects.toMatchObject({ code: 'IDENTITY_PROVISIONING_FAILED' });
    expect(p.asked).toEqual([]);
    expect(g.state.retired).toEqual([]);
  });
});

describe('Ctrl-C while waiting for funds', () => {
  it('stops cleanly with the setup saved, and removes its listener', async () => {
    const g = await gateway({ capOneIdentity: true });
    const m = await load();
    const controller = new AbortController();
    const dispose = vi.fn();
    const interrupt = vi.fn(() => { setTimeout(() => controller.abort(), 150); return { signal: controller.signal, dispose }; });

    const out = await m.setup.runSetup(options({ yes: true, account: 'new' }), io(scripted([]), { interrupt }));
    expect(out.state).toBe('interrupted');
    expect(out.ready).toBe(false);
    expect(interrupt).toHaveBeenCalledTimes(1);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(out.steps.find((s) => s.step === 'gas')).toMatchObject({ status: 'waited', detail: 'stopped while waiting for funds' });
    // Saved before the wait: the next command knows which account is meant.
    expect(m.cfg.readProfile()).toMatchObject({ identity: g.state.identities[0]!.id, key: 'dev', chain: 'base-sepolia' });
    expect(out.funding?.paymentUri).toBe(`ethereum:${FAKE.abstractAccount}@84532?value=1000000000000000`);
  });

  it('is only ever listened for around the wait: a run that does not wait never asks for it', async () => {
    await gateway();
    const m = await load();
    const interrupt = vi.fn();
    const out = await m.setup.runSetup(options({ waitForFunds: false, yes: true, account: 'new' }), io(scripted([]), { interrupt }));
    expect(out.state).toBe('blocked');
    expect(interrupt).not.toHaveBeenCalled();
  });

  it('removes its listener even when the wait throws', async () => {
    const g = await gateway({ capOneIdentity: true });
    const m = await load();
    // A key the gateway stops accepting mid-wait: the wait throws, and the listener must still go.
    const dispose = vi.fn();
    const interrupt = vi.fn(() => {
      setTimeout(() => g.state.acceptedKeys.clear(), 100);
      return { signal: new AbortController().signal, dispose };
    });
    await expect(m.setup.runSetup(options({ yes: true, account: 'new' }), io(scripted([]), { interrupt }))).rejects.toMatchObject({ code: 'CREDENTIAL_REJECTED' });
    expect(dispose).toHaveBeenCalledTimes(1);
  });
});

describe('waitableGas: when waiting for a faucet is worth starting', () => {
  const check = (name: string, status: string, extra: Record<string, unknown> = {}) => ({ name, status, detail: '', ...extra });
  const readiness = (checks: any[], account: string | null = FAKE.abstractAccount) => ({
    ready: false, state: 'blocked', first_blocker: null, checks, context: { abstract_account: account },
  }) as any;
  const ok = ['gateway', 'credential', 'identity', 'chain', 'key page', 'accumulate credits', 'gateway balance'].map((n) => check(n, 'ok'));

  it('is the case only when every other check passes and the gas gap is one that funds fix', async () => {
    const { setup } = await load();
    for (const code of ['ABSTRACT_ACCOUNT_UNFUNDED', 'ABSTRACT_ACCOUNT_UNDERFUNDED']) {
      expect(setup.waitableGas(readiness([...ok, check('gas', 'fail', { code })]))).toMatchObject({ address: FAKE.abstractAccount });
    }
    // A fresh account may not be indexed for a minute: the next poll may see it.
    expect(setup.waitableGas(readiness([...ok, check('gas', 'unknown', { data: { reading: 'no-balances' } })]))).toBeDefined();
  });

  it('is not the case when something else is wrong, however empty the account is', async () => {
    const { setup } = await load();
    const gas = check('gas', 'fail', { code: 'ABSTRACT_ACCOUNT_UNFUNDED' });
    expect(setup.waitableGas(readiness([...ok.slice(0, 4), check('key page', 'fail', { code: 'KEY_PAGE_LACKS_KEY' }), ...ok.slice(5), gas]))).toBeUndefined();
    expect(setup.waitableGas(readiness([...ok.slice(0, 5), check('accumulate credits', 'unknown'), ...ok.slice(6), gas]))).toBeUndefined();
  });

  it('is not the case when sending funds cannot fix the gap', async () => {
    const { setup } = await load();
    for (const reading of ['native-not-reported', 'unknown-native', 'unreadable']) {
      expect(setup.waitableGas(readiness([...ok, check('gas', 'unknown', { data: { reading } })])), reading).toBeUndefined();
    }
    expect(setup.waitableGas(readiness([...ok, check('gas', 'fail', { code: 'SOMETHING_ELSE' })]))).toBeUndefined();
  });

  it('needs an address to send to', async () => {
    const { setup } = await load();
    expect(setup.waitableGas(readiness([...ok, check('gas', 'fail', { code: 'ABSTRACT_ACCOUNT_UNFUNDED' })], null))).toBeUndefined();
  });
});
