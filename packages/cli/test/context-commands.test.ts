import { describe, it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { AddressInfo } from 'node:net';

/**
 * `certen context` and `certen use`: see the context, and set it once.
 *
 * Both are local: they read and write ~/.certen and touch the gateway only where a value is worth checking (`use identity` of a
 * UUID this machine has never seen). The cases run the built CLI as a subprocess in a throwaway HOME, in human and `--json` mode,
 * because the contract is about processes: one envelope on stdout, the human lines on stderr, and an exit code.
 *
 * `HOME` and `USERPROFILE` are both set on every spawn: `os.homedir()` reads USERPROFILE on Windows, so setting only HOME would
 * target the developer's real ~/.certen.
 */
const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'index.js');
const run = promisify(execFile);

const ID_A = '11111111-1111-4111-8111-111111111111';
const ID_B = '22222222-2222-4222-8222-222222222222';

interface Out { stdout: string; stderr: string; code: number }

function newHome(): string {
  return mkdtempSync(join(tmpdir(), 'certen-ctxcmd-'));
}

async function certen(home: string, args: string[], env: Record<string, string> = {}): Promise<Out> {
  const base: Record<string, string> = { ...(process.env as Record<string, string>), HOME: home, USERPROFILE: home, NO_PROXY: '127.0.0.1,localhost' };
  for (const k of ['CERTEN_API_KEY', 'CERTEN_API_URL', 'CERTEN_IDENTITY', 'CERTEN_KEY', 'CERTEN_CHAIN', 'CERTEN_PROFILE', 'CERTEN_ALLOW_ANY_CHAIN', 'CERTEN_ENABLED_CHAINS']) delete base[k];
  try {
    const { stdout, stderr } = await run(process.execPath, [CLI, ...args], { env: { ...base, ...env }, encoding: 'utf8' });
    return { stdout, stderr, code: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: number };
    return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', code: typeof e.code === 'number' ? e.code : -1 };
  }
}

const envelope = (o: Out): { ok: boolean; data?: any; error?: { code: string; message: string } } => {
  const t = o.stdout.trim();
  expect(t.length, `stdout was empty; stderr: ${o.stderr}`).toBeGreaterThan(0);
  expect(t.split('\n'), 'exactly one line on stdout').toHaveLength(1);
  return JSON.parse(t);
};

const configOf = (home: string): Record<string, any> => JSON.parse(readFileSync(join(home, '.certen', 'config.json'), 'utf8'));

function recordIdentities(home: string, rows: Array<{ id: string; adi_url: string; chains: string[]; name?: string }>): void {
  mkdirSync(join(home, '.certen'), { recursive: true });
  writeFileSync(join(home, '.certen', 'config.json'), JSON.stringify({ identities: rows.map((r) => ({ ...r, created_at: '2026-10-01T00:00:00Z' })) }));
}

async function gateway(handler: (req: http.IncomingMessage, res: http.ServerResponse) => void): Promise<{ url: string; paths: string[]; close: () => Promise<void> }> {
  const paths: string[] = [];
  const server = http.createServer((req, res) => {
    paths.push(`${req.method} ${(req.url ?? '').split('?')[0]}`);
    req.resume();
    req.on('end', () => handler(req, res));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    paths,
    close: () => new Promise<void>((r) => { server.closeAllConnections?.(); server.close(() => r()); }),
  };
}
const sendJson = (res: http.ServerResponse, status: number, body: unknown): void => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

describe('certen context', () => {
  it('on a fresh machine says nothing is chosen, as one envelope, with no network and no key', async () => {
    const home = newHome();
    const r = await certen(home, ['--json', 'context']);
    expect(r.code).toBe(0);
    const d = envelope(r).data;
    expect(d.profile).toBe('default');
    expect(d.profiles).toEqual(['default']);
    expect(d.identity).toBeNull();
    expect(d.key).toBeNull();
    expect(d.chain).toBeNull();
    expect(d.allow_mainnet_default).toBe(false);
    expect(d.gateway).toMatchObject({ url: 'https://gateway.kompendium.co', source: 'default' });
    expect(d.candidates).toEqual({ identity: [], key: [], chain: [] });
  });

  it('shows what is chosen and where each value came from', async () => {
    const home = newHome();
    recordIdentities(home, [{ id: ID_A, adi_url: 'acc://alpha.acme', chains: ['base-sepolia'], name: 'alpha' }]);
    expect((await certen(home, ['keys', 'generate', '--name', 'dev', '--no-passphrase'])).code).toBe(0);
    expect((await certen(home, ['use', 'chain', 'ethereum-sepolia'])).code).toBe(0);

    const r = await certen(home, ['--json', 'context'], { CERTEN_KEY: 'dev' });
    const d = envelope(r).data;
    // The profile's chain beats the identity's only linked chain, which beats nothing.
    expect(d.chain).toMatchObject({ value: 'ethereum-sepolia', source: 'profile', detail: 'profile "default"', known_testnet: true });
    // Alone on the machine, so it is the default; named by its ADI because that is what a person recognises.
    expect(d.identity).toMatchObject({ value: ID_A, source: 'single', adi_url: 'acc://alpha.acme', name: 'alpha' });
    expect(d.key).toMatchObject({ value: 'dev', source: 'env', detail: 'CERTEN_KEY' });
  });

  it('prints a readable summary in table mode, not JSON', async () => {
    const home = newHome();
    await certen(home, ['use', 'chain', 'base-sepolia']);
    const r = await certen(home, ['context']);
    expect(r.code).toBe(0);
    expect(() => JSON.parse(r.stdout.trim())).toThrow();
    const text = r.stdout + r.stderr;
    expect(text).toContain('default');
    expect(text).toContain('base-sepolia');
    expect(text).toMatch(/profile "default"/);
    expect(text).toContain('certen use identity');
  });

  it('lists the candidates when several identities are recorded and none is chosen, instead of picking one', async () => {
    const home = newHome();
    recordIdentities(home, [
      { id: ID_A, adi_url: 'acc://alpha.acme', chains: [], name: 'alpha' },
      { id: ID_B, adi_url: 'acc://beta.acme', chains: [], name: 'beta' },
    ]);
    const d = envelope(await certen(home, ['--json', 'context'])).data;
    expect(d.identity).toBeNull();
    expect(d.candidates.identity.map((c: { id: string }) => c.id)).toEqual([ID_A, ID_B]);
    const t = await certen(home, ['context']);
    expect(t.stdout + t.stderr).toMatch(/alpha[\s\S]*beta/);
  });

  it('warns that a chain that is not a known testnet will not be taken as a default by a value-moving command', async () => {
    const home = newHome();
    expect((await certen(home, ['use', 'chain', 'base'], { CERTEN_ALLOW_ANY_CHAIN: '1' })).code).toBe(0);
    const r = await certen(home, ['--json', 'context']);
    expect(envelope(r).data.chain).toMatchObject({ value: 'base', known_testnet: false });
    expect(r.stderr).toMatch(/not a known testnet/);
  });
});

describe('certen use chain / key', () => {
  it('saves a chain on the active profile and echoes what it did', async () => {
    const home = newHome();
    const r = await certen(home, ['--json', 'use', 'chain', 'base-sepolia']);
    expect(r.code).toBe(0);
    expect(envelope(r).data).toMatchObject({ profile: 'default', chain: 'base-sepolia', known_testnet: true });
    expect(configOf(home).profiles.default.chain).toBe('base-sepolia');
  });

  it('refuses an unsupported chain with the suggestion, and saves nothing', async () => {
    const home = newHome();
    const r = await certen(home, ['--json', 'use', 'chain', 'base']);
    expect(r.code).toBe(2);
    const e = envelope(r).error!;
    expect(e.code).toBe('UNSUPPORTED_CHAIN');
    expect(e.message).toContain('base-sepolia');
    expect(() => configOf(home)).toThrow();
  });

  it('saves a key only if it exists locally, and names the ones that do', async () => {
    const home = newHome();
    await certen(home, ['keys', 'generate', '--name', 'dev', '--no-passphrase']);
    const bad = await certen(home, ['--json', 'use', 'key', 'nosuch']);
    expect(bad.code).toBe(2);
    expect(envelope(bad).error).toMatchObject({ code: 'UNKNOWN_KEY' });
    expect(envelope(bad).error!.message).toContain('dev');

    const ok = await certen(home, ['--json', 'use', 'key', 'dev']);
    expect(ok.code).toBe(0);
    expect(envelope(ok).data).toMatchObject({ profile: 'default', key: 'dev' });
    expect(configOf(home).profiles.default.key).toBe('dev');
  });

  it('unsets with --unset, and refuses --unset together with a value', async () => {
    const home = newHome();
    await certen(home, ['use', 'chain', 'base-sepolia']);
    const r = await certen(home, ['--json', 'use', 'chain', '--unset']);
    expect(r.code).toBe(0);
    expect(envelope(r).data).toMatchObject({ chain: null });
    expect(configOf(home).profiles.default.chain).toBeUndefined();

    const both = await certen(home, ['--json', 'use', 'chain', 'base-sepolia', '--unset']);
    expect(both.code).toBe(2);
    const none = await certen(home, ['--json', 'use', 'chain']);
    expect(none.code).toBe(2);
    expect(envelope(none).error!.code).toBe('MISSING_VALUE');
  });
});

describe('certen use identity', () => {
  it('resolves a name from this machine\'s record and stores the UUID, with no gateway at all', async () => {
    const home = newHome();
    recordIdentities(home, [
      { id: ID_A, adi_url: 'acc://alpha.acme', chains: [], name: 'alpha' },
      { id: ID_B, adi_url: 'acc://beta.acme', chains: [], name: 'beta' },
    ]);
    const r = await certen(home, ['--json', 'use', 'identity', 'beta']);
    expect(r.code).toBe(0);
    expect(envelope(r).data).toMatchObject({ profile: 'default', identity: ID_B, adi_url: 'acc://beta.acme', verified: false });
    expect(configOf(home).profiles.default.identity).toBe(ID_B);
  });

  it('resolves an ADI URL from the record too', async () => {
    const home = newHome();
    recordIdentities(home, [{ id: ID_A, adi_url: 'acc://alpha.acme', chains: [] }]);
    const r = await certen(home, ['--json', 'use', 'identity', 'ACC://Alpha.acme/']);
    expect(envelope(r).data).toMatchObject({ identity: ID_A });
  });

  it('refuses a name that two identities answer to, listing both', async () => {
    const home = newHome();
    recordIdentities(home, [
      { id: ID_A, adi_url: 'acc://bot.acme', chains: [], name: 'bot' },
      { id: ID_B, adi_url: 'acc://bot2.acme', chains: [], name: 'bot' },
    ]);
    const r = await certen(home, ['--json', 'use', 'identity', 'bot']);
    expect(r.code).toBe(2);
    expect(envelope(r).error!.code).toBe('AMBIGUOUS_IDENTITY');
  });

  it('checks a UUID this machine has never seen against the gateway, saves it, and records it so its name works later', async () => {
    const home = newHome();
    const gw = await gateway((req, res) => {
      if ((req.url ?? '').startsWith(`/v1/identity/${ID_A}`)) return sendJson(res, 200, { id: ID_A, adi_url: 'acc://remote.acme', name: 'remote', status: 'active', chain_accounts: [{ chain_id: '84532', address: '0xabc' }] });
      sendJson(res, 404, { message: 'no' });
    });
    try {
      const r = await certen(home, ['--json', 'use', 'identity', ID_A], { CERTEN_API_KEY: 'ck_live_test', CERTEN_API_URL: gw.url });
      expect(r.code).toBe(0);
      expect(envelope(r).data).toMatchObject({ identity: ID_A, adi_url: 'acc://remote.acme', verified: true });
      expect(gw.paths).toEqual([`GET /v1/identity/${ID_A}`]);
      expect(configOf(home).profiles.default.identity).toBe(ID_A);
      // Recorded, so the ADI now resolves with no gateway.
      expect(configOf(home).identities[0]).toMatchObject({ id: ID_A, adi_url: 'acc://remote.acme', name: 'remote' });
    } finally { await gw.close(); }
  });

  it('refuses a UUID the gateway says is not an identity, and saves nothing', async () => {
    const home = newHome();
    const gw = await gateway((_req, res) => sendJson(res, 404, { message: 'not found' }));
    try {
      const r = await certen(home, ['--json', 'use', 'identity', ID_A], { CERTEN_API_KEY: 'ck_live_test', CERTEN_API_URL: gw.url });
      expect(r.code).toBe(2);
      expect(envelope(r).error!.code).toBe('IDENTITY_NOT_FOUND');
      expect(() => configOf(home)).toThrow();
    } finally { await gw.close(); }
  });

  it('saves a UUID it could not check, and says so rather than calling it verified', async () => {
    const home = newHome();
    // No credential configured and no gateway reachable: the check cannot be made.
    const r = await certen(home, ['--json', 'use', 'identity', ID_A]);
    expect(r.code).toBe(0);
    expect(envelope(r).data).toMatchObject({ identity: ID_A, verified: false });
    expect(r.stderr).toMatch(/not verified|could not be checked|unverified/i);
    expect(configOf(home).profiles.default.identity).toBe(ID_A);
  });

  it('finds the UUID of an ADI nobody recorded through the portfolio', async () => {
    const home = newHome();
    const gw = await gateway((req, res) => {
      if ((req.url ?? '').startsWith('/v1/portfolio')) return sendJson(res, 200, { identities: [{ id: ID_B, adi_url: 'acc://far.acme', status: 'active', credit_balance: 1, chains: [], pending_actions: 0 }], total_chains: 0 });
      if ((req.url ?? '').startsWith(`/v1/identity/${ID_B}`)) return sendJson(res, 200, { id: ID_B, adi_url: 'acc://far.acme', status: 'active', chain_accounts: [] });
      sendJson(res, 404, {});
    });
    try {
      const r = await certen(home, ['--json', 'use', 'identity', 'acc://far.acme'], { CERTEN_API_KEY: 'ck_live_test', CERTEN_API_URL: gw.url });
      expect(r.code).toBe(0);
      expect(envelope(r).data).toMatchObject({ identity: ID_B, adi_url: 'acc://far.acme' });
    } finally { await gw.close(); }
  });

  it('unsets the identity', async () => {
    const home = newHome();
    recordIdentities(home, [{ id: ID_A, adi_url: 'acc://alpha.acme', chains: [], name: 'alpha' }]);
    await certen(home, ['use', 'identity', 'alpha']);
    const r = await certen(home, ['--json', 'use', 'identity', '--unset']);
    expect(r.code).toBe(0);
    expect(configOf(home).profiles.default.identity).toBeUndefined();
  });
});

describe('profiles', () => {
  it('creates a profile by setting something on it, and keeps its context apart from the default\'s', async () => {
    const home = newHome();
    await certen(home, ['use', 'chain', 'base-sepolia']);
    const made = await certen(home, ['--json', 'use', 'chain', 'ethereum-sepolia', '--profile', 'testnet']);
    expect(made.code).toBe(0);
    expect(envelope(made).data).toMatchObject({ profile: 'testnet', chain: 'ethereum-sepolia' });

    const onTestnet = envelope(await certen(home, ['--json', 'context', '--profile', 'testnet'])).data;
    expect(onTestnet.profile).toBe('testnet');
    expect(onTestnet.chain.value).toBe('ethereum-sepolia');
    expect(onTestnet.profiles).toEqual(['default', 'testnet']);

    const onDefault = envelope(await certen(home, ['--json', 'context'])).data;
    expect(onDefault.chain.value).toBe('base-sepolia');
  });

  it('accepts --profile before or after the subcommand, and CERTEN_PROFILE', async () => {
    const home = newHome();
    await certen(home, ['use', 'chain', 'ethereum-sepolia', '--profile', 'testnet']);
    for (const args of [['--profile', 'testnet', '--json', 'context'], ['--json', 'context', '--profile', 'testnet'], ['--json', 'context', '--profile=testnet']]) {
      expect(envelope(await certen(home, args)).data.profile, args.join(' ')).toBe('testnet');
    }
    expect(envelope(await certen(home, ['--json', 'context'], { CERTEN_PROFILE: 'testnet' })).data.profile).toBe('testnet');
    // The flag beats the variable.
    expect(envelope(await certen(home, ['--json', 'context', '--profile', 'default'], { CERTEN_PROFILE: 'testnet' })).data.profile).toBe('default');
  });

  it('switches the saved active profile with `use profile`, and refuses one that does not exist unless asked to create it', async () => {
    const home = newHome();
    await certen(home, ['use', 'chain', 'ethereum-sepolia', '--profile', 'testnet']);
    const bad = await certen(home, ['--json', 'use', 'profile', 'nope']);
    expect(bad.code).toBe(2);
    expect(envelope(bad).error!.code).toBe('PROFILE_NOT_FOUND');
    expect(envelope(bad).error!.message).toContain('testnet');

    const sw = await certen(home, ['--json', 'use', 'profile', 'testnet']);
    expect(sw.code).toBe(0);
    expect(envelope(sw).data).toMatchObject({ active_profile: 'testnet' });
    expect(envelope(await certen(home, ['--json', 'context'])).data.profile).toBe('testnet');

    const created = await certen(home, ['--json', 'use', 'profile', 'fresh', '--create']);
    expect(created.code).toBe(0);
    expect(envelope(await certen(home, ['--json', 'context'])).data.profile).toBe('fresh');

    // Back to default removes the saved name rather than saving "default".
    await certen(home, ['use', 'profile', 'default']);
    expect(configOf(home).profile).toBeUndefined();
  });

  it('gives a profile its own gateway, which `auth status` then reports', async () => {
    const home = newHome();
    const set = await certen(home, ['--json', 'use', 'gateway', 'https://testnet.example', '--profile', 'testnet']);
    expect(set.code).toBe(0);
    expect(envelope(set).data).toMatchObject({ profile: 'testnet', gateway: 'https://testnet.example' });
    expect(envelope(await certen(home, ['--json', 'context', '--profile', 'testnet'])).data.gateway).toMatchObject({ url: 'https://testnet.example', source: 'profile' });
    expect(envelope(await certen(home, ['--json', 'auth', 'status', '--profile', 'testnet'])).data).toMatchObject({ profile: 'testnet', api_url: 'https://testnet.example' });
    expect(envelope(await certen(home, ['--json', 'auth', 'status'])).data.api_url).toMatch(/gateway\.kompendium\.co/);
  });

  it('refuses a gateway that is not an http(s) URL', async () => {
    const home = newHome();
    const r = await certen(home, ['--json', 'use', 'gateway', 'ftp://x.example']);
    expect(r.code).toBe(2);
    expect(envelope(r).error!.code).toBe('INVALID_GATEWAY_URL');
  });

  it('toggles allow-mainnet-default on the profile only, and reports it', async () => {
    const home = newHome();
    const on = await certen(home, ['--json', 'use', 'allow-mainnet-default', 'on']);
    expect(on.code).toBe(0);
    expect(envelope(on).data).toMatchObject({ profile: 'default', allow_mainnet_default: true });
    expect(envelope(await certen(home, ['--json', 'context'])).data.allow_mainnet_default).toBe(true);
    expect(envelope(await certen(home, ['--json', 'context', '--profile', 'other'])).error!.code).toBe('PROFILE_NOT_FOUND');
    const off = await certen(home, ['--json', 'use', 'allow-mainnet-default', 'off']);
    expect(envelope(off).data.allow_mainnet_default).toBe(false);
    const bad = await certen(home, ['--json', 'use', 'allow-mainnet-default', 'maybe']);
    expect(bad.code).toBe(2);
  });

  it('refuses a bad profile name in an envelope, before reading anything', async () => {
    const home = newHome();
    const r = await certen(home, ['--json', 'context', '--profile', '../escape']);
    expect(r.code).toBe(2);
    expect(envelope(r).error!.code).toBe('INVALID_PROFILE_NAME');
    const missing = await certen(home, ['--json', 'context', '--profile']);
    expect(missing.code).toBe(2);
    expect(envelope(missing).error!.code).toBe('MISSING_PROFILE_NAME');
  });

  it('keeps one profile\'s API key out of another profile\'s requests', async () => {
    const home = newHome();
    const seen: string[] = [];
    const gw = await gateway((req, res) => { seen.push(String(req.headers['x-api-key'] ?? '')); sendJson(res, 200, { currency: 'USD', available_usd: '1.000000', held_usd: '0.000000', credit_limit_usd: '0', spendable_usd: '1.000000', status: 'active' }); });
    try {
      await certen(home, ['auth', 'login', '--api-key', 'ck_live_DEFAULT_KEY', '--no-keyring', '--api-url', gw.url]);
      await certen(home, ['use', 'gateway', gw.url, '--profile', 'other']);
      // The `other` profile has a gateway but no credential of its own: it must not borrow the default profile's key.
      const r = await certen(home, ['--json', 'balance', '--profile', 'other']);
      expect(r.code).toBe(2);
      expect(envelope(r).error!.code).toBe('NO_API_KEY');
      expect(seen.filter((k) => k === 'ck_live_DEFAULT_KEY')).toHaveLength(1); // only the login's own verification request
    } finally { await gw.close(); }
  });
});

describe('--help --json lists the new surface', () => {
  it('has context, use and the global --profile', async () => {
    const home = newHome();
    const data = envelope(await certen(home, ['--json', '--help'])).data as { commands: Array<{ name: string; commands?: Array<{ name: string }> }>; options?: Array<{ name: string }> };
    const names = data.commands.map((c) => c.name);
    expect(names).toContain('context');
    expect(names).toContain('use');
    const use = data.commands.find((c) => c.name === 'use')!;
    expect((use.commands ?? []).map((c) => c.name)).toEqual(expect.arrayContaining(['identity', 'key', 'chain', 'profile', 'gateway', 'allow-mainnet-default']));
    expect(JSON.stringify(data)).toContain('profile');
  });
});
