import { describe, it, expect, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { startSetupGateway, FAKE, type SetupGateway, type SetupGatewayOptions } from './helpers/setup-gateway.js';
import { certen, envelope, newHome, readConfig, keyNames, readKeyFile } from './helpers/run-cli.js';

/**
 * `certen setup`, end to end: the real built CLI against a stateful stand-in for the gateway and an Accumulate node.
 *
 * What is pinned has a plausible wrong answer, and most are things that went wrong on the old path:
 *
 * - the signing key exists BEFORE the account, because a new account is created by that key (and the gateway verifies the signature, so a
 *   client that signed the wrong bytes is refused);
 * - running it again continues rather than repeats: one identity, one signup, no second `POST /v1/identity` (an organisation made with a key
 *   may hold one, and a second create is refused). That includes a run that was interrupted while provisioning;
 * - exit 0 means READY: a run that created everything and still cannot act (no gas) exits 1 and says what to send where;
 * - an account that cannot be reached, a credential that is rejected and a missing choice of account are different failures with different
 *   exit codes, and none of them leaves a stray key or identity behind;
 * - `--json` is one envelope on stdout whatever happened.
 *
 * Every run uses a throwaway home and drops every CERTEN_* variable of the caller; nothing reaches the network or the OS keyring.
 */

let gw: SetupGateway | undefined;
afterEach(async () => { await gw?.close(); gw = undefined; });

async function gateway(options: SetupGatewayOptions = {}): Promise<SetupGateway> {
  gw = await startSetupGateway(options);
  return gw;
}

const FAST = ['--poll-interval', '0.1'];
/** A fresh machine that makes a key and a new account without asking anything. */
const NEW_ACCOUNT = ['--yes', '--no-passphrase', '--new-account', '--org-name', 'acme', '--name', 'probe', '--no-keyring', ...FAST];

describe('a fresh machine: key first, then the account it creates, then the identity', () => {
  it('creates all three in that order and says exactly what is still missing (gas), exiting 1', async () => {
    const g = await gateway();
    const home = newHome();
    const r = await certen(['--json', 'setup', ...NEW_ACCOUNT], { home, apiUrl: g.url });

    expect(r.code, r.stderr).toBe(1);
    const e = envelope(r);
    expect(e.ok).toBe(false);
    expect(e.error!.code).toBe('NOT_READY');
    const readiness = e.error!.details.readiness;
    expect(readiness.state).toBe('blocked');
    expect(readiness.first_blocker).toMatchObject({ name: 'gas', code: 'ABSTRACT_ACCOUNT_UNFUNDED' });
    // Everything else is green: the only thing in the way is the one thing a faucet fixes, and the card says so.
    expect(readiness.checks.filter((c: any) => c.name !== 'gas').every((c: any) => c.status === 'ok')).toBe(true);
    expect(readiness.checks.map((c: any) => c.name)).toEqual(
      ['gateway', 'credential', 'signing key', 'identity', 'chain', 'key page', 'accumulate credits', 'gateway balance', 'gas'],
    );

    // The funding plan rides in the envelope, so a script can show the address and the wallet link without parsing prose.
    const funding = e.error!.details.funding;
    expect(funding).toMatchObject({
      chain: 'base-sepolia', symbol: 'ETH', address: FAKE.abstractAccount, balance: '0', minimum: '0.0001', send: '0.001', least: '0.0001', estimated: true,
      payment_uri: `ethereum:${FAKE.abstractAccount}@84532?value=1000000000000000`,
    });
    expect(e.error!.details.created).toEqual({ key: true, account: true, identity: true });

    // Order on the wire: the registry, then the signup (no credential yet), then the identity (with the credential the signup returned).
    const wire = g.paths();
    expect(wire[0]).toBe('GET /v1/chains');
    expect(wire.indexOf('POST /v1/signup')).toBeGreaterThan(wire.indexOf('GET /v1/chains'));
    expect(wire.indexOf('POST /v1/identity')).toBeGreaterThan(wire.indexOf('POST /v1/signup'));
    expect(g.calls.find((c) => c.path === '/v1/signup/challenge')!.key).toBeUndefined();
    expect(g.calls.find((c) => c.path === '/v1/signup')!.key).toBeUndefined();
    const created = g.calls.find((c) => c.method === 'POST' && c.path === '/v1/identity')!;
    expect(created.status).toBe(202);
    expect(g.state.acceptedKeys.has(created.key!)).toBe(true);
    expect(g.state.signups).toBe(1);

    // The key exists, the identity was created WITH it, and the machine now knows which is which.
    expect(keyNames(home)).toEqual(['dev']);
    expect(g.state.lastCreateBody).toMatchObject({ name: 'probe', public_key: readKeyFile(home, 'dev').publicKey, chains: ['base-sepolia'] });
    const cfg = readConfig(home);
    expect(cfg.identities).toHaveLength(1);
    expect(cfg.identities[0]).toMatchObject({ name: 'probe', adi_url: 'acc://probe.acme', chains: ['base-sepolia'] });
    expect(cfg.profiles.default).toEqual({ identity: cfg.identities[0].id, key: 'dev', chain: 'base-sepolia' });
    expect(cfg.api_key).toBe(created.key);
  });

  it('exits 0 with the context saved once the account can act', async () => {
    const g = await gateway({ fundAfterReads: 1 });
    const home = newHome();
    const r = await certen(['--json', 'setup', ...NEW_ACCOUNT], { home, apiUrl: g.url });

    expect(r.code, r.stderr).toBe(0);
    const e = envelope(r);
    expect(e.ok).toBe(true);
    expect(e.data).toMatchObject({
      ready: true, chain: 'base-sepolia', created: { key: true, account: true, identity: true },
      context: { adi_url: 'acc://probe.acme', key: 'dev', chain: 'base-sepolia' },
    });
    expect(e.data!.readiness).toMatchObject({ ready: true, state: 'ready', first_blocker: null });
    expect(e.data!.readiness.checks.every((c: any) => c.status === 'ok')).toBe(true);
    // The command printed for the person to type next works today: it names the key, because tx create never signs with a guessed one.
    expect(e.data!.next_command).toBe('certen tx create --to 0xRecipient --amount 0.0001 --sign-with dev --wait');
    expect(r.stderr).toContain('Saved as your default context');
    // Steps are the audit trail an agent reads instead of the prose.
    expect(e.data!.steps.map((s: any) => s.step)).toEqual(['gateway', 'signing key', 'sign-in', 'identity', 'context', 'readiness']);
  });

  it('puts the human card on stdout and the progress on stdout too, with --json off', async () => {
    const g = await gateway({ fundAfterReads: 1 });
    const home = newHome();
    const r = await certen(['setup', ...NEW_ACCOUNT], { home, apiUrl: g.url });
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain('Ready to transact on base-sepolia');
    expect(r.stdout).toMatch(/\[ ok \] gas\s+0xe293e95Ec1471155d977448B99B0922C2828cAcB on base-sepolia holds 0\.001 ETH/);
    expect(r.stdout).toMatch(/\[ ok \] key page\s+acc:\/\/probe\.acme\/book\/1 holds your key .*read from Accumulate \(127\.0\.0\.1:\d+\), not the gateway/);
    expect(r.stdout).toContain('1. Gateway');
    expect(r.stdout).toContain('2. Signing key  created "dev"');
    expect(r.stdout.indexOf('2. Signing key')).toBeLessThan(r.stdout.indexOf('3. Sign-in'));
  });
});

describe('running it again continues, it does not repeat', () => {
  it('a second run on a ready machine makes nothing: one signup, one identity, exit 0', async () => {
    const g = await gateway({ fundAfterReads: 1 });
    const home = newHome();
    const first = await certen(['--json', 'setup', ...NEW_ACCOUNT], { home, apiUrl: g.url });
    expect(first.code, first.stderr).toBe(0);

    const second = await certen(['--json', 'setup', '--yes', '--no-keyring', ...FAST], { home, apiUrl: g.url });
    expect(second.code, second.stderr).toBe(0);
    const e = envelope(second);
    expect(e.data!.created).toEqual({ key: false, account: false, identity: false });
    expect(e.data!.steps.filter((s: any) => ['signing key', 'sign-in', 'identity'].includes(s.step)).every((s: any) => s.status === 'skipped')).toBe(true);
    expect(g.count('POST /v1/signup')).toBe(1);
    expect(g.count('POST /v1/identity')).toBe(1);
    expect(g.state.identities).toHaveLength(1);
    expect(keyNames(home)).toEqual(['dev']);
  });

  it('a run interrupted while provisioning is picked up: the identity was recorded before the wait, so no second one is made', async () => {
    // The gateway is slow to finish: the first run's budget ends first. With one identity allowed per organisation, a rerun that created
    // another would be refused (409) and the person would be stuck with an identity nobody can find.
    const g = await gateway({ provisioningReads: 1000, fundAfterReads: 1 });
    const home = newHome();
    const first = await certen(['--json', 'setup', ...NEW_ACCOUNT, '--timeout', '0.03'], { home, apiUrl: g.url });
    expect(first.code).toBe(1);
    expect(envelope(first).error!.code).toBe('IDENTITY_WAIT_TIMEOUT');
    // Recorded, with its id, though the wait never finished.
    const recorded = readConfig(home).identities;
    expect(recorded).toHaveLength(1);
    expect(recorded[0].id).toBe(g.state.identities[0]!.id);

    // The gateway finishes at last: the rerun's first read still says provisioning, the next says active.
    g.setProvisioningReads(g.state.identities[0]!.reads + 1);
    const second = await certen(['--json', 'setup', '--yes', '--no-keyring', ...FAST], { home, apiUrl: g.url });
    expect(second.code, second.stderr).toBe(0);
    expect(g.count('POST /v1/identity')).toBe(1);
    expect(envelope(second).data!.created.identity).toBe(false);
    expect(second.stderr).toContain('acc://probe.acme is still provisioning; waiting for it (not making another)');
  });

  it('reuses the identity already recorded and never touches the cap', async () => {
    const home = newHome();
    // A key and a record of an identity that exists in the organisation: a machine that has done this before.
    const probe = await certen(['--json', 'keys', 'generate', '--name', 'dev', '--no-passphrase'], { home });
    expect(probe.code, probe.stderr).toBe(0);
    const keyHash = readKeyFile(home, 'dev').publicKeyHash as string;
    const id = '11111111-2222-4333-8444-555555555555';
    const g = await gateway({ acceptedKeys: ['ck_live_have'], existing: { id, name: 'old', adi: 'acc://old.acme', keyHash, funded: true } });
    const { writeFileSync, mkdirSync } = await import('node:fs');
    mkdirSync(join(home, '.certen'), { recursive: true });
    writeFileSync(join(home, '.certen', 'config.json'), JSON.stringify({
      identities: [{ id, adi_url: 'acc://old.acme', chains: ['base-sepolia'], created_at: '2026-10-01T00:00:00Z', name: 'old' }],
    }));

    const r = await certen(['--json', 'setup', '--yes'], { home, apiUrl: g.url, env: { CERTEN_API_KEY: 'ck_live_have' } });
    expect(r.code, r.stderr).toBe(0);
    expect(g.count('POST /v1/identity')).toBe(0);
    expect(g.count('POST /v1/signup')).toBe(0);
    expect(envelope(r).data).toMatchObject({ created: { key: false, account: false, identity: false }, context: { adi_url: 'acc://old.acme', key: 'dev' } });
    // What came from the context rather than a flag is said, so a default the person did not type never acts silently.
    expect(r.stderr).toContain('using identity acc://old.acme (the only identity recorded on this machine)');
    expect(r.stderr).toContain('using key dev (the only signing key on this machine)');
  });

  it('refuses to guess between identities: several recorded and none chosen is a usage error that lists them', async () => {
    const home = newHome();
    await certen(['--json', 'keys', 'generate', '--name', 'dev', '--no-passphrase'], { home });
    const g = await gateway({ acceptedKeys: ['ck_live_have'] });
    const { writeFileSync, mkdirSync } = await import('node:fs');
    mkdirSync(join(home, '.certen'), { recursive: true });
    writeFileSync(join(home, '.certen', 'config.json'), JSON.stringify({
      identities: [
        { id: '11111111-1111-4111-8111-111111111111', adi_url: 'acc://one.acme', chains: ['base-sepolia'], created_at: '2026-10-01T00:00:00Z', name: 'one' },
        { id: '22222222-2222-4222-8222-222222222222', adi_url: 'acc://two.acme', chains: ['base-sepolia'], created_at: '2026-10-02T00:00:00Z', name: 'two' },
      ],
    }));
    const r = await certen(['--json', 'setup', '--yes'], { home, apiUrl: g.url, env: { CERTEN_API_KEY: 'ck_live_have' } });
    expect(r.code).toBe(2);
    const e = envelope(r);
    expect(e.error!.code).toBe('AMBIGUOUS_IDENTITY');
    expect(e.error!.message).toContain('acc://one.acme');
    expect(e.error!.message).toContain('acc://two.acme');
    expect(g.count('POST /v1/identity')).toBe(0);
  });
});

describe('the identity ends in an error', () => {
  it('names the way out and does not make another, because the failed one still holds the slot', async () => {
    const g = await gateway({ finalStatus: 'error' });
    const home = newHome();
    const first = await certen(['--json', 'setup', ...NEW_ACCOUNT], { home, apiUrl: g.url });
    expect(first.code).toBe(1);
    expect(envelope(first).error!.code).toBe('IDENTITY_PROVISIONING_FAILED');

    const second = await certen(['--json', 'setup', '--yes', '--no-keyring', ...FAST], { home, apiUrl: g.url });
    expect(second.code).toBe(1);
    const e = envelope(second);
    expect(e.error!.code).toBe('IDENTITY_PROVISIONING_FAILED');
    // The command that frees the slot, spelled out with the real id: setup never retires on its own authority.
    expect(e.error!.message).toContain(`certen identity retire ${g.state.identities[0]!.id} --yes`);
    expect(g.count('POST /v1/identity')).toBe(1);
    expect(g.count('DELETE /v1/identity/' + g.state.identities[0]!.id)).toBe(0);
    expect(g.state.retired).toEqual([]);
  });
});

describe('failures that are not setup\'s to fix', () => {
  it('an unreachable gateway exits 3 before a key or anything else is made', async () => {
    const home = newHome();
    const r = await certen(['--json', 'setup', ...NEW_ACCOUNT], { home, apiUrl: 'http://127.0.0.1:1' });
    expect(r.code).toBe(3);
    expect(envelope(r).error).toMatchObject({ code: 'NETWORK_ERROR', retryable: true });
    expect(keyNames(home)).toEqual([]);
    expect(existsSync(join(home, '.certen', 'config.json'))).toBe(false);
  });

  it('a chain this CLI does not serve is a usage error after the registry was read, with no key made', async () => {
    const g = await gateway();
    const home = newHome();
    const r = await certen(['--json', 'setup', ...NEW_ACCOUNT, '--chain', 'polygon-amoy'], { home, apiUrl: g.url });
    expect(r.code).toBe(2);
    expect(g.paths()).toEqual(['GET /v1/chains']);
    expect(keyNames(home)).toEqual([]);
  });

  it('a credential the gateway rejects is not replaced: exit 1, no account or identity made', async () => {
    const g = await gateway({ acceptedKeys: ['ck_live_other'] });
    const home = newHome();
    const r = await certen(['--json', 'setup', ...NEW_ACCOUNT.filter((a) => a !== '--new-account')], { home, apiUrl: g.url, env: { CERTEN_API_KEY: 'ck_live_stale' } });
    expect(r.code).toBe(1);
    const e = envelope(r);
    expect(e.error!.code).toBe('CREDENTIAL_REJECTED');
    expect(e.error!.message).toContain('CERTEN_API_KEY was rejected');
    expect(g.count('POST /v1/signup')).toBe(0);
    expect(g.count('POST /v1/identity')).toBe(0);
  });

  it('a SAVED credential the gateway rejects needs an explicit instruction to be replaced', async () => {
    const g = await gateway({ acceptedKeys: ['ck_live_other'] });
    const home = newHome();
    const { writeFileSync, mkdirSync } = await import('node:fs');
    mkdirSync(join(home, '.certen'), { recursive: true });
    // Owner-only, as `auth login` writes it: off Windows a config file holding a key that group or world can read is refused (CONFIG_PERMISSIONS) before the key is used.
    writeFileSync(join(home, '.certen', 'config.json'), JSON.stringify({ api_key: 'ck_live_stale', storage: 'file' }), { mode: 0o600 });

    const refused = await certen(['--json', 'setup', '--yes', '--no-passphrase', '--no-keyring', ...FAST], { home, apiUrl: g.url });
    expect(refused.code).toBe(1);
    expect(envelope(refused).error!.code).toBe('CREDENTIAL_REJECTED');
    expect(g.count('POST /v1/signup')).toBe(0);

    // Said out loud, it is a request: the new account replaces it.
    const replaced = await certen(['--json', 'setup', ...NEW_ACCOUNT], { home, apiUrl: g.url });
    expect(g.count('POST /v1/signup')).toBe(1);
    expect(readConfig(home).api_key).not.toBe('ck_live_stale');
    expect([0, 1]).toContain(replaced.code);
  });

  it('with no credential, no choice of account and nobody to ask, it is a usage error that names the three ways, before anything is made', async () => {
    const g = await gateway();
    const home = newHome();
    const r = await certen(['--json', 'setup', '--yes', '--no-passphrase', ...FAST], { home, apiUrl: g.url });
    expect(r.code).toBe(2);
    const e = envelope(r);
    expect(e.error!.code).toBe('NO_API_KEY');
    for (const way of ['--existing-account', '--new-account', '--token', 'CERTEN_API_KEY']) expect(e.error!.message).toContain(way);
    // Not even the registry was asked for, and no key was left behind on the way to saying so.
    expect(g.calls).toHaveLength(0);
    expect(keyNames(home)).toEqual([]);
  });

  it('self-service switched off is said plainly, with the other ways in', async () => {
    const g = await gateway({ selfService: false });
    const home = newHome();
    const r = await certen(['--json', 'setup', ...NEW_ACCOUNT], { home, apiUrl: g.url });
    expect(r.code).toBe(1);
    const e = envelope(r);
    expect(e.error!.code).toBe('SELF_SERVICE_DISABLED');
    expect(e.error!.message).toContain('--existing-account');
    expect(g.count('POST /v1/identity')).toBe(0);
  });
});

describe('the options are checked before anything happens', () => {
  it.each([
    [['--token', 'crt_x', '--new-account'], 'CONFLICTING_OPTIONS'],
    [['--existing-account', '--new-account'], 'CONFLICTING_OPTIONS'],
    [['--existing-account', '--org-name', 'x'], 'CONFLICTING_OPTIONS'],
    [['--identity', 'x', '--name', 'y'], 'CONFLICTING_OPTIONS'],
    [['--chain', 'base-sepolia', '--chains', 'base-sepolia'], 'CONFLICTING_OPTIONS'],
    [['--amount', '1000000000000000'], 'INVALID_AMOUNT'],
    [['--gas-reserve', 'lots'], 'INVALID_AMOUNT'],
    [['--accumulate-rpc', 'ftp://x'], 'INVALID_ACCUMULATE_RPC'],
    [['--timeout', 'soon'], 'INVALID_TIMEOUT'],
    [['--funds-timeout', '0'], 'INVALID_TIMEOUT'],
  ])('%j is exit 2 (%s) with no request made', async (extra, code) => {
    const g = await gateway();
    const home = newHome();
    const r = await certen(['--json', 'setup', '--yes', ...extra], { home, apiUrl: g.url });
    expect(r.code, r.stderr).toBe(2);
    expect(envelope(r).error!.code).toBe(code);
    expect(g.calls).toHaveLength(0);
    expect(keyNames(home)).toEqual([]);
  });

  it('--yes will not store a new key unencrypted unless told to', async () => {
    const g = await gateway();
    const home = newHome();
    const refused = await certen(['--json', 'setup', '--yes', '--new-account', '--no-keyring', ...FAST], { home, apiUrl: g.url });
    expect(refused.code).toBe(2);
    expect(envelope(refused).error!.code).toBe('PASSPHRASE_REQUIRED');
    expect(keyNames(home)).toEqual([]);

    // With a passphrase from the environment the key is encrypted.
    const fine = await certen(['--json', 'setup', '--yes', '--new-account', '--no-keyring', ...FAST], { home, apiUrl: g.url, env: { CERTEN_KEY_PASSPHRASE: 'correct horse' } });
    expect(fine.code, fine.stderr).toBe(1);
    expect(readKeyFile(home, 'dev').encryption).not.toBeNull();
    // The signup nonce was signed with the encrypted key: the gateway verified it, so the passphrase was held and used once, not guessed.
    expect(g.state.signups).toBe(1);
  });

  it('a key named in the environment that is not on this machine is an error, not an instruction to make it', async () => {
    const g = await gateway();
    const home = newHome();
    const r = await certen(['--json', 'setup', '--yes', '--no-passphrase', '--new-account', ...FAST], { home, apiUrl: g.url, env: { CERTEN_KEY: 'ghost' } });
    expect(r.code).toBe(2);
    expect(envelope(r).error!.code).toBe('UNKNOWN_KEY');
    expect(keyNames(home)).toEqual([]);
  });
});

describe('the other ways to get an account', () => {
  it('a registration token creates the account without a browser or a signature, and is not redeemed twice', async () => {
    const g = await gateway({ registrationTokens: ['crt_once'], fundAfterReads: 1 });
    const home = newHome();
    const args = ['--json', 'setup', '--yes', '--no-passphrase', '--token', 'crt_once', '--org-name', 'ci', '--name', 'probe', '--no-keyring', ...FAST];
    const first = await certen(args, { home, apiUrl: g.url });
    expect(first.code, first.stderr).toBe(0);
    expect(g.count('POST /v1/registration-tokens/redeem')).toBe(1);
    expect(g.count('POST /v1/signup')).toBe(0);

    // A CI job reruns with the same arguments. The token is spent; the credential works; nothing is redeemed.
    const again = await certen(args, { home, apiUrl: g.url });
    expect(again.code, again.stderr).toBe(0);
    expect(g.count('POST /v1/registration-tokens/redeem')).toBe(1);
    expect(envelope(again).data!.steps.find((s: any) => s.step === 'sign-in').detail).toContain('the option for a new sign-in was not used');
  });

  it('an account that already exists is signed in to through the device flow, after the key, and the key is never shown', async () => {
    const g = await gateway({ fundAfterReads: 1, devicePendingPolls: 1 });
    const home = newHome();
    const r = await certen(['--json', 'setup', '--yes', '--no-passphrase', '--existing-account', '--no-browser', '--name', 'probe', '--no-keyring', ...FAST], { home, apiUrl: g.url });
    expect(r.code, r.stderr).toBe(0);
    // The code a person approves is on stderr; the key that comes back is nowhere on screen.
    expect(r.stderr).toContain('ABCD-EFGH');
    expect(r.stderr).toContain('Nothing is granted until you approve it there');
    const stored = readConfig(home).api_key as string;
    expect(stored).toMatch(/^ck_live_/);
    expect(r.stdout + r.stderr).not.toContain(stored);
    expect(g.count('POST /v1/signup')).toBe(0);
    expect(g.calls.filter((c) => c.path.startsWith('/v1/portal/device/')).length).toBeGreaterThanOrEqual(2);
    expect(g.paths().indexOf('POST /v1/portal/device')).toBeLessThan(g.paths().indexOf('POST /v1/identity'));
    expect(keyNames(home)).toEqual(['dev']);
  });

  it('a denied device code makes nothing', async () => {
    const g = await gateway({ deviceDenied: true });
    const home = newHome();
    const r = await certen(['--json', 'setup', '--yes', '--no-passphrase', '--existing-account', '--no-browser', '--no-keyring', ...FAST], { home, apiUrl: g.url });
    expect(r.code).toBe(1);
    expect(envelope(r).error!.code).toBe('DEVICE_CODE_DENIED');
    expect(g.count('POST /v1/identity')).toBe(0);
    expect(readConfig(home).api_key).toBeUndefined();
  });

  it('a gateway without device authorization falls back to a pasted key, verified before it is stored', async () => {
    const g = await gateway({ deviceUnsupported: true, acceptedKeys: ['ck_live_pasted'], fundAfterReads: 1 });
    const home = newHome();
    const r = await certen(['--json', 'setup', '--yes', '--no-passphrase', '--existing-account', '--no-browser', '--name', 'probe', '--no-keyring', ...FAST], { home, apiUrl: g.url, input: 'ck_live_pasted\n' });
    expect(r.code, r.stderr).toBe(0);
    expect(r.stderr).toContain('this gateway cannot authorize devices');
    expect(readConfig(home).api_key).toBe('ck_live_pasted');

    // A pasted key the gateway rejects is not stored.
    const home2 = newHome();
    const bad = await certen(['--json', 'setup', '--yes', '--no-passphrase', '--existing-account', '--no-browser', '--no-keyring', ...FAST], { home: home2, apiUrl: g.url, input: 'ck_live_typo\n' });
    expect(bad.code).toBe(2);
    expect(envelope(bad).error!.code).toBe('INVALID_API_KEY');
    expect(readConfig(home2).api_key).toBeUndefined();
  });
});

describe('what is in the way, when it is not gas', () => {
  it('a key page that does not hold the key blocks setup, and no amount of waiting for funds is offered', async () => {
    const g = await gateway({ keyPageLacksKey: true });
    const home = newHome();
    const r = await certen(['--json', 'setup', ...NEW_ACCOUNT, '--wait-for-funds', '--funds-timeout', '0.02'], { home, apiUrl: g.url });
    expect(r.code).toBe(1);
    const e = envelope(r);
    expect(e.error!.code).toBe('NOT_READY');
    const blocker = e.error!.details.readiness.first_blocker;
    expect(blocker).toMatchObject({ name: 'key page', status: 'fail' });
    expect(['KEY_PAGE_LACKS_KEY', 'KEY_PAGE_DISAGREES']).toContain(blocker.code);
    expect(r.stderr).not.toContain('Waiting for funds');
    // No plan is offered for a problem that funds do not fix.
    expect(e.error!.details.funding).toBeUndefined();
  });

  it('an Accumulate node that cannot be reached leaves readiness unconfirmed, never ready', async () => {
    const g = await gateway({ accumulateDown: true, fundAfterReads: 1 });
    const home = newHome();
    const r = await certen(['--json', 'setup', ...NEW_ACCOUNT], { home, apiUrl: g.url });
    expect(r.code).toBe(1);
    const e = envelope(r);
    expect(e.error!.code).toBe('NOT_CONFIRMED');
    expect(e.error!.details.readiness).toMatchObject({ ready: false, state: 'unconfirmed' });
    expect(e.error!.details.readiness.first_blocker).toMatchObject({ name: 'key page', status: 'unknown', code: 'KEY_PAGE_UNCONFIRMED' });
  });
});
