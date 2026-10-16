import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * `resolveContext()`: the one place that decides which identity, which key and which chain a command runs with.
 *
 * Before it, only `init` read the identity this machine had recorded, and every other command made the person type it again. The
 * rules are in the plan (flag > env > profile > a single candidate) and so is the safety rule that matters: a value that came
 * from a default is never allowed to point a value-moving command at a mainnet. A person who typed `--chain ethereum` meant it;
 * a person whose profile says `chain: ethereum` set that up some other day and is not looking at it now.
 *
 * The resolver is synchronous and local. It reads the config and the key directory and touches no network, so every command can
 * call it first and fail on a bad invocation before anything else happens.
 */
let scratch = '';
vi.mock('os', async (orig) => ({ ...(await orig<typeof import('os')>()), homedir: () => scratch }));
vi.mock('node:os', async (orig) => ({ ...(await orig<typeof import('node:os')>()), homedir: () => scratch }));

const ID_A = '11111111-1111-4111-8111-111111111111';
const ID_B = '22222222-2222-4222-8222-222222222222';

interface Mods {
  ctx: typeof import('../src/context.js');
  cfg: typeof import('../src/config.js');
  keys: typeof import('../src/keystore.js');
  chains: typeof import('../src/chains.js');
}
async function load(): Promise<Mods> {
  return {
    ctx: await import('../src/context.js'),
    cfg: await import('../src/config.js'),
    keys: await import('../src/keystore.js'),
    chains: await import('../src/chains.js'),
  };
}

let errLines: string[] = [];
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'certen-context-'));
  for (const v of ['CERTEN_IDENTITY', 'CERTEN_KEY', 'CERTEN_CHAIN', 'CERTEN_PROFILE', 'CERTEN_API_KEY', 'CERTEN_API_URL', 'CERTEN_ALLOW_ANY_CHAIN', 'CERTEN_ENABLED_CHAINS']) {
    delete process.env[v];
  }
  vi.resetModules();
  errLines = [];
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { errLines.push(a.join(' ')); });
});

afterEach(() => {
  vi.restoreAllMocks();
  try { rmSync(scratch, { recursive: true, force: true }); } catch { /* noop */ }
});

describe('precedence: flag > env > profile > a single candidate', () => {
  it('takes the flag over everything', async () => {
    const m = await load();
    process.env.CERTEN_IDENTITY = 'from-env';
    process.env.CERTEN_KEY = 'env-key';
    process.env.CERTEN_CHAIN = 'ethereum-sepolia';
    m.cfg.updateProfile('default', { identity: 'from-profile', key: 'profile-key', chain: 'arbitrum-sepolia' });
    const c = m.ctx.resolveContext({ identity: 'from-flag', key: 'flag-key', chain: 'base-sepolia' }, {});
    expect(c.identity).toMatchObject({ value: 'from-flag', source: 'flag' });
    expect(c.key).toMatchObject({ value: 'flag-key', source: 'flag' });
    expect(c.chain).toMatchObject({ value: 'base-sepolia', source: 'flag' });
  });

  it('takes the environment over the profile', async () => {
    const m = await load();
    process.env.CERTEN_IDENTITY = 'from-env';
    process.env.CERTEN_KEY = 'env-key';
    process.env.CERTEN_CHAIN = 'ethereum-sepolia';
    m.cfg.updateProfile('default', { identity: 'from-profile', key: 'profile-key', chain: 'arbitrum-sepolia' });
    const c = m.ctx.resolveContext({}, {});
    expect(c.identity).toMatchObject({ value: 'from-env', source: 'env', detail: 'CERTEN_IDENTITY' });
    expect(c.key).toMatchObject({ value: 'env-key', source: 'env', detail: 'CERTEN_KEY' });
    expect(c.chain).toMatchObject({ value: 'ethereum-sepolia', source: 'env', detail: 'CERTEN_CHAIN' });
  });

  it('takes the profile over a single candidate, and names the profile', async () => {
    const m = await load();
    m.cfg.rememberIdentity({ id: ID_A, adi_url: 'acc://a.acme', chains: ['base-sepolia'] });
    m.keys.generateKey('only', null);
    m.cfg.updateProfile('default', { identity: ID_B, key: 'chosen', chain: 'arbitrum-sepolia' });
    const c = m.ctx.resolveContext({}, {});
    expect(c.identity).toMatchObject({ value: ID_B, source: 'profile', detail: 'profile "default"' });
    expect(c.key).toMatchObject({ value: 'chosen', source: 'profile' });
    expect(c.chain).toMatchObject({ value: 'arbitrum-sepolia', source: 'profile' });
  });

  it('runs as the profile --profile / CERTEN_PROFILE names', async () => {
    const m = await load();
    m.cfg.updateProfile('default', { chain: 'base-sepolia' });
    m.cfg.updateProfile('other', { chain: 'arbitrum-sepolia', identity: ID_B });
    m.cfg.setProfileOverride('other');
    const c = m.ctx.resolveContext({}, {});
    expect(c.profile).toBe('other');
    expect(c.chain).toMatchObject({ value: 'arbitrum-sepolia', source: 'profile', detail: 'profile "other"' });
    expect(c.identity?.value).toBe(ID_B);
  });

  it('treats an empty flag or variable as absent', async () => {
    const m = await load();
    process.env.CERTEN_CHAIN = '';
    m.cfg.updateProfile('default', { chain: 'base-sepolia' });
    const c = m.ctx.resolveContext({ chain: '' }, {});
    expect(c.chain).toMatchObject({ value: 'base-sepolia', source: 'profile' });
  });
});

describe('a single candidate is a default; several are a question, never a guess', () => {
  it('uses the only identity recorded on this machine', async () => {
    const m = await load();
    m.cfg.rememberIdentity({ id: ID_A, adi_url: 'acc://a.acme', chains: [] });
    const c = m.ctx.resolveContext({}, {});
    expect(c.identity).toMatchObject({ value: ID_A, source: 'single' });
    expect(c.identity!.detail).toMatch(/only identity/);
  });

  it('leaves the identity unresolved when two are recorded, and lists both', async () => {
    const m = await load();
    m.cfg.rememberIdentity({ id: ID_A, adi_url: 'acc://alpha.acme', chains: [], name: 'alpha' });
    m.cfg.rememberIdentity({ id: ID_B, adi_url: 'acc://beta.acme', chains: [], name: 'beta' });
    const c = m.ctx.resolveContext({}, {});
    expect(c.identity).toBeUndefined();
    expect(c.candidates.identity.map((x) => x.id)).toEqual([ID_A, ID_B]);
    try {
      m.ctx.requireIdentity(c);
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toMatchObject({ code: 'AMBIGUOUS_IDENTITY', exitCode: 2 });
      const msg = (e as Error).message;
      expect(msg).toContain('alpha');
      expect(msg).toContain('acc://alpha.acme');
      expect(msg).toContain('beta');
      expect(msg).toContain('--identity');
      expect(msg).toContain('certen use identity');
    }
  });

  it('says nothing is recorded, and what to do, when there is no identity at all', async () => {
    const m = await load();
    const c = m.ctx.resolveContext({}, {});
    expect(() => m.ctx.requireIdentity(c)).toThrowError(/No identity/);
    try { m.ctx.requireIdentity(c); } catch (e) {
      expect(e).toMatchObject({ code: 'MISSING_IDENTITY', exitCode: 2 });
      expect((e as Error).message).toContain('create one with: certen setup');
      expect((e as Error).message).not.toContain('certen init');
    }
  });

  it('uses the only local key, and lists the keys when there are several', async () => {
    const m = await load();
    m.keys.generateKey('dev', null);
    expect(m.ctx.resolveContext({}, {}).key).toMatchObject({ value: 'dev', source: 'single' });

    m.keys.generateKey('prod', null);
    const c = m.ctx.resolveContext({}, {});
    expect(c.key).toBeUndefined();
    expect(c.candidates.key).toEqual(['dev', 'prod']);
  });

  it('uses the identity\'s only recorded chain, and lists them when it has several', async () => {
    const m = await load();
    m.cfg.rememberIdentity({ id: ID_A, adi_url: 'acc://a.acme', chains: ['base-sepolia'] });
    expect(m.ctx.resolveContext({}, {}).chain).toMatchObject({ value: 'base-sepolia', source: 'single' });

    m.cfg.rememberIdentity({ id: ID_A, adi_url: 'acc://a.acme', chains: ['base-sepolia', 'ethereum-sepolia'] });
    const c = m.ctx.resolveContext({}, {});
    expect(c.chain).toBeUndefined();
    expect(c.candidates.chain).toEqual(['base-sepolia', 'ethereum-sepolia']);
    try { m.ctx.requireChain(c); } catch (e) {
      expect(e).toMatchObject({ code: 'AMBIGUOUS_CHAIN', exitCode: 2 });
      expect((e as Error).message).toContain('base-sepolia');
      expect((e as Error).message).toContain('--chain');
    }
  });

  it('reads the chain candidates of the identity that WAS resolved, not of whichever was recorded last', async () => {
    const m = await load();
    m.cfg.rememberIdentity({ id: ID_A, adi_url: 'acc://a.acme', chains: ['base-sepolia'] });
    m.cfg.rememberIdentity({ id: ID_B, adi_url: 'acc://b.acme', chains: ['ethereum-sepolia'] });
    expect(m.ctx.resolveContext({ identity: ID_A }, {}).chain?.value).toBe('base-sepolia');
    expect(m.ctx.resolveContext({ identity: ID_B }, {}).chain?.value).toBe('ethereum-sepolia');
    expect(m.ctx.resolveContext({ identity: 'acc://b.acme' }, {}).chain?.value).toBe('ethereum-sepolia');
  });

  it('says no chain is known, and how to give one, when nothing resolves', async () => {
    const m = await load();
    const c = m.ctx.resolveContext({}, {});
    try { m.ctx.requireChain(c); } catch (e) {
      expect(e).toMatchObject({ code: 'MISSING_CHAIN', exitCode: 2 });
      expect((e as Error).message).toContain('--chain');
      expect((e as Error).message).toContain('certen use chain');
    }
  });

  it('lets the requirer name the flag the user actually types', async () => {
    const m = await load();
    const c = m.ctx.resolveContext({}, {});
    try { m.ctx.requireChain(c, '--to-chain'); } catch (e) {
      expect((e as Error).message).toContain('--to-chain');
    }
  });
});

describe('a default never points a value-moving command at a mainnet', () => {
  // The rule speaks for a chain the CLI would otherwise ACCEPT, which without CERTEN_ALLOW_ANY_CHAIN is only a testnet. Someone who has
  // opted in to any chain is exactly who it exists for, so these cases run opted in. Without the opt-in a mainnet name is simply an
  // unsupported chain (see the last case below).
  beforeEach(() => { process.env.CERTEN_ALLOW_ANY_CHAIN = '1'; });

  it('refuses a profile chain that is not a known testnet on a value-moving command, naming both ways out', async () => {
    const m = await load();
    m.cfg.updateProfile('default', { chain: 'ethereum' });
    expect(() => m.ctx.resolveContext({}, { valueMoving: true })).toThrowError(/not a known testnet/);
    try { m.ctx.resolveContext({}, { valueMoving: true }); } catch (e) {
      expect(e).toMatchObject({ code: 'MAINNET_DEFAULT_REFUSED', exitCode: 2 });
      const msg = (e as Error).message;
      expect(msg).toContain('ethereum');
      expect(msg).toContain('profile "default"');
      expect(msg).toContain('--chain ethereum');
      expect(msg).toContain('allow-mainnet-default');
    }
  });

  it('refuses the same chain when it comes from the environment', async () => {
    const m = await load();
    process.env.CERTEN_CHAIN = 'base';
    expect(() => m.ctx.resolveContext({}, { valueMoving: true })).toThrowError(/CERTEN_CHAIN/);
  });

  it('accepts the same chain when the person typed it', async () => {
    const m = await load();
    m.cfg.updateProfile('default', { chain: 'ethereum' });
    const c = m.ctx.resolveContext({ chain: 'ethereum' }, { valueMoving: true });
    expect(c.chain).toMatchObject({ value: 'ethereum', source: 'flag' });
  });

  it('accepts it when the profile is explicitly marked allow_mainnet_default', async () => {
    const m = await load();
    m.cfg.updateProfile('default', { chain: 'ethereum', allow_mainnet_default: true });
    const c = m.ctx.resolveContext({}, { valueMoving: true });
    expect(c.chain).toMatchObject({ value: 'ethereum', source: 'profile' });
    expect(c.allowMainnetDefault).toBe(true);
  });

  it('does not apply to a command that moves nothing', async () => {
    const m = await load();
    m.cfg.updateProfile('default', { chain: 'ethereum' });
    expect(m.ctx.resolveContext({}, {}).chain?.value).toBe('ethereum');
    expect(m.ctx.resolveContext({}, { valueMoving: false }).chain?.value).toBe('ethereum');
  });

  it('lets a known testnet through as a default', async () => {
    const m = await load();
    m.cfg.updateProfile('default', { chain: 'base-sepolia' });
    expect(m.ctx.resolveContext({}, { valueMoving: true }).chain?.value).toBe('base-sepolia');
  });

  it('judges a chain the catalogue does not know by the registry cache\'s environment', async () => {
    const m = await load();
    m.chains.writeChainCache([
      { id: 'optimism-sepolia', chainId: 11155420, enabled: true, environment: 'testnet' },
      { id: 'optimism', chainId: 10, enabled: true, environment: 'mainnet' },
    ]);
    m.cfg.updateProfile('default', { chain: 'optimism-sepolia' });
    expect(m.ctx.resolveContext({}, { valueMoving: true }).chain?.value).toBe('optimism-sepolia');
    m.cfg.updateProfile('default', { chain: 'optimism' });
    expect(() => m.ctx.resolveContext({}, { valueMoving: true })).toThrowError(/MAINNET|not a known testnet/i);
  });

  it('treats a chain nobody can classify as not a known testnet: unknown is not ok', async () => {
    const m = await load();
    expect(m.chains.isKnownTestnet('base-sepolia')).toBe(true);
    expect(m.chains.isKnownTestnet('who-knows')).toBe(false);
    expect(m.chains.isKnownTestnet('ethereum')).toBe(false);
  });

  it('applies to a single-candidate chain too', async () => {
    const m = await load();
    m.cfg.rememberIdentity({ id: ID_A, adi_url: 'acc://a.acme', chains: ['base'] });
    expect(() => m.ctx.resolveContext({}, { valueMoving: true })).toThrowError(/not a known testnet/);
  });

  it('leaves a chain the CLI would refuse anyway to say so, naming where it came from, rather than calling a typo a mainnet', async () => {
    const m = await load();
    delete process.env.CERTEN_ALLOW_ANY_CHAIN;
    process.env.CERTEN_CHAIN = 'basee';
    try {
      m.ctx.resolveContext({}, { valueMoving: true });
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toMatchObject({ code: 'UNSUPPORTED_CHAIN', exitCode: 2 });
      expect((e as Error).message).toContain('CERTEN_CHAIN');
      expect((e as Error).message).toContain('base-sepolia');
    }
    delete process.env.CERTEN_CHAIN;
    m.cfg.updateProfile('default', { chain: 'ethereum' });
    try {
      m.ctx.resolveContext({}, { valueMoving: true });
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toMatchObject({ code: 'UNSUPPORTED_CHAIN' });
      expect((e as Error).message).toContain('profile "default"');
    }
  });
});

describe('every value that came from somewhere other than a flag is echoed on stderr', () => {
  it('says nothing for a flag', async () => {
    const m = await load();
    const c = m.ctx.resolveContext({ chain: 'base-sepolia' }, {});
    m.ctx.echoFromContext('chain', c.chain);
    expect(errLines).toEqual([]);
  });

  it('says what was used, and where it came from, for the environment, a profile and a single candidate', async () => {
    const m = await load();
    process.env.CERTEN_CHAIN = 'base-sepolia';
    m.ctx.echoFromContext('chain', m.ctx.resolveContext({}, {}).chain);
    expect(errLines.at(-1)).toBe('using chain base-sepolia (from CERTEN_CHAIN)');

    delete process.env.CERTEN_CHAIN;
    m.cfg.updateProfile('default', { key: 'dev' });
    m.ctx.echoFromContext('key', m.ctx.resolveContext({}, {}).key);
    expect(errLines.at(-1)).toBe('using key dev (from profile "default")');

    m.cfg.updateProfile('default', { key: null });
    m.cfg.rememberIdentity({ id: ID_A, adi_url: 'acc://a.acme', chains: [] });
    m.ctx.echoFromContext('identity', m.ctx.resolveContext({}, {}).identity, 'acc://a.acme');
    expect(errLines.at(-1)).toBe('using identity acc://a.acme (the only identity recorded on this machine)');
  });

  it('echoes through stderr even when stdout is a JSON envelope', async () => {
    const m = await load();
    const out = vi.spyOn(console, 'log').mockImplementation(() => {});
    process.env.CERTEN_CHAIN = 'base-sepolia';
    m.ctx.echoFromContext('chain', m.ctx.resolveContext({}, {}).chain);
    expect(out).not.toHaveBeenCalled();
    expect(errLines).toHaveLength(1);
  });
});
