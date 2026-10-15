import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { startSetupGateway, FAKE, type SetupGateway } from './helpers/setup-gateway.js';
import { certen, envelope, newHome, readConfig } from './helpers/run-cli.js';

/**
 * `certen gas`: what the abstract account needs, where to get it, and when it has arrived.
 *
 * `fund` tops up the ORGANIZATION's balance at the gateway. This is the other thing that has been called funding: the native token the
 * identity's account on a chain spends to execute, for which there was a URL and nothing else. What is pinned:
 *
 * - the plan is exact (integer wei in the link, the address as the gateway reported it) and is the same plan `setup` shows;
 * - exit 0 only when the account has enough, so a script can branch on it; the whole plan rides in the envelope either way;
 * - it signs nothing and asks for no key: `--from-wallet` prints a transfer for a wallet YOU control;
 * - a wait ends honestly, and a gap that funds cannot fix is not waited on.
 */

let g: SetupGateway;
let home: string;
beforeEach(async () => {
  g = await startSetupGateway();
  home = newHome();
  // A machine that has been through setup: a key, an account, an identity and a saved context. Unfunded.
  const r = await certen(['--json', 'setup', '--yes', '--no-passphrase', '--new-account', '--org-name', 'acme', '--name', 'probe', '--no-keyring', '--poll-interval', '0.1'], { home, apiUrl: g.url });
  expect(r.code, r.stderr).toBe(1); // not ready: no gas
  g.calls.length = 0;
});
afterEach(async () => { await g.close(); });

const WALLET_LINK = `ethereum:${FAKE.abstractAccount}@84532?value=1000000000000000`;

describe('an unfunded account', () => {
  it('prints the account, what it holds, what to send, the faucet and a wallet link, and exits 1', async () => {
    const r = await certen(['gas'], { home, apiUrl: g.url });
    expect(r.code).toBe(1);
    expect(r.stdout).toContain('Gas on base-sepolia');
    expect(r.stdout).toContain(`account   ${FAKE.abstractAccount}   (abstract account of acc://probe.acme)`);
    expect(r.stdout).toContain('holds     0 ETH');
    expect(r.stdout).toContain('Send 0.001 ETH to ');
    expect(r.stdout).toContain('(0.0001 ETH is the least that works; the rest saves a second trip)');
    expect(r.stdout).toContain('https://www.alchemy.com/faucets/base-sepolia');
    expect(r.stdout).toContain(WALLET_LINK);
    expect(r.stdout).toContain('planning figures, not a quote');
    // What came from the context is said, so a default the person did not type never acts silently.
    expect(r.stderr).toContain('using chain base-sepolia (from profile "default")');
    expect(r.stderr).toContain('using identity acc://probe.acme (from profile "default")');
    expect(r.stderr).toContain('Error [ABSTRACT_ACCOUNT_UNFUNDED]');
    expect(r.stderr).toContain('certen gas --wait');
  });

  it('carries the whole plan in the envelope, whatever the exit code', async () => {
    const r = await certen(['--json', 'gas'], { home, apiUrl: g.url });
    expect(r.code).toBe(1);
    const e = envelope(r);
    expect(e.ok).toBe(false);
    expect(e.error!.code).toBe('ABSTRACT_ACCOUNT_UNFUNDED');
    expect(e.error!.details).toMatchObject({
      chain: 'base-sepolia', abstract_account: FAKE.abstractAccount, symbol: 'ETH', balance: '0', minimum: '0.0001', suggested: '0.001', send: '0.001', least: '0.0001',
      funded: false, estimated: true, faucet: 'https://www.alchemy.com/faucets/base-sepolia', payment_uri: WALLET_LINK,
    });
    expect(e.error!.details.wallet_steps).toHaveLength(2);
    expect(e.error!.details.check).toMatchObject({ name: 'gas', status: 'fail', code: 'ABSTRACT_ACCOUNT_UNFUNDED' });
  });

  it('--amount adds what is about to be moved, so the link covers the transfer and its gas', async () => {
    const r = await certen(['--json', 'gas', '--amount', '0.05'], { home, apiUrl: g.url });
    const d = envelope(r).error!.details;
    expect(d).toMatchObject({ minimum: '0.0501', send: '0.0501', payment_uri: `ethereum:${FAKE.abstractAccount}@84532?value=50100000000000000` });
  });

  it('--gas-reserve replaces the catalogue\'s estimate, and "none" removes it', async () => {
    const own = envelope(await certen(['--json', 'gas', '--gas-reserve', '0.002'], { home, apiUrl: g.url })).error!.details;
    expect(own).toMatchObject({ minimum: '0.002', suggested: '0.02' });
    const none = envelope(await certen(['--json', 'gas', '--gas-reserve', 'none'], { home, apiUrl: g.url })).error!.details;
    expect(none).toMatchObject({ minimum: null, estimated: false });
  });

  it('--from-wallet prints the two-step route for a faucet that refuses a contract address, and signs nothing', async () => {
    const r = await certen(['gas', '--from-wallet'], { home, apiUrl: g.url });
    expect(r.code).toBe(1);
    expect(r.stdout).toContain('Some faucets refuse a contract address, and this account is one.');
    expect(r.stdout).toContain('send the gas to a wallet you control first');
    expect(r.stdout).toContain(`Then, from that wallet, send 0.001 ETH to ${FAKE.abstractAccount} on base-sepolia`);
    expect(r.stdout).toContain(WALLET_LINK);
    // The two-step route is the point of this flag; the faucet line is not repeated under it.
    expect(r.stdout).not.toContain('Testnet gas is free from the faucet');
    // It asked for no key, no passphrase and no signature: nothing but reads reached the gateway.
    expect(g.calls.every((c) => c.method === 'GET')).toBe(true);
  });
});

describe('a funded account', () => {
  it('exits 0 and says how much it holds', async () => {
    g.fund();
    const r = await certen(['--json', 'gas'], { home, apiUrl: g.url });
    expect(r.code, r.stderr).toBe(0);
    const e = envelope(r);
    expect(e.ok).toBe(true);
    expect(e.data).toMatchObject({ funded: true, balance: '0.001', abstract_account: FAKE.abstractAccount, check: { status: 'ok' } });
  });

  it('a funded account that cannot cover the amount is still short, and says by how much', async () => {
    g.fund();
    const r = await certen(['--json', 'gas', '--amount', '0.01'], { home, apiUrl: g.url });
    expect(r.code).toBe(1);
    expect(envelope(r).error).toMatchObject({ code: 'ABSTRACT_ACCOUNT_UNDERFUNDED' });
    expect(envelope(r).error!.details).toMatchObject({ balance: '0.001', minimum: '0.0101', funded: false, send: '0.0091' });
  });
});

describe('--wait', () => {
  it('returns the moment the gas arrives, exit 0', async () => {
    g.fundAfterMoreReads(3);
    const r = await certen(['gas', '--wait', '--poll-interval', '0.1'], { home, apiUrl: g.url });
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain('Waiting for funds... (Ctrl-C to stop; run `certen gas --wait` again to continue)');
    expect(r.stdout).toContain('holds 0 ETH');
    expect(r.stdout).toContain('holds 0.001 ETH');
    expect(r.stdout).toContain('Funds arrived.');
  });

  it('gives up after its budget and says so, exit 1', async () => {
    const r = await certen(['--json', 'gas', '--wait', '--poll-interval', '0.1', '--timeout', '0.03'], { home, apiUrl: g.url });
    expect(r.code).toBe(1);
    const e = envelope(r);
    expect(e.error!.code).toBe('FUNDS_WAIT_TIMEOUT');
    expect(e.error!.details).toMatchObject({ timed_out: true, funded: false, payment_uri: WALLET_LINK });
  });

  it('on an account that is already funded it does not wait at all', async () => {
    g.fund();
    const r = await certen(['gas', '--wait', '--timeout', '5'], { home, apiUrl: g.url, timeoutMs: 30_000 });
    expect(r.code).toBe(0);
    expect(r.stdout).not.toContain('Waiting for funds');
  });
});

describe('what it refuses', () => {
  it('a chain the identity has no account on: there is nowhere to send gas, and it says how to link one', async () => {
    const r = await certen(['--json', 'gas', '--chain', 'ethereum-sepolia'], { home, apiUrl: g.url });
    expect(r.code).toBe(1);
    const e = envelope(r);
    expect(e.error!.code).toBe('CHAIN_NOT_LINKED');
    expect(e.error!.message).toContain('certen identity link-chain');
  });

  it.each([
    [['--amount', '1000000000000000'], 'INVALID_AMOUNT'],
    [['--gas-reserve', 'lots'], 'INVALID_AMOUNT'],
    [['--chain', 'not-a-chain'], 'UNSUPPORTED_CHAIN'],
    [['--timeout', 'soon'], 'INVALID_TIMEOUT'],
  ])('%j is exit 2 (%s) before any request', async (extra, code) => {
    const r = await certen(['--json', 'gas', ...extra], { home, apiUrl: g.url });
    expect(r.code, r.stderr).toBe(2);
    expect(envelope(r).error!.code).toBe(code);
    expect(g.calls).toHaveLength(0);
  });

  it('an unreachable gateway is exit 3', async () => {
    const r = await certen(['--json', 'gas'], { home, apiUrl: 'http://127.0.0.1:1' });
    expect(r.code).toBe(3);
    expect(envelope(r).error!.code).toBe('NETWORK_ERROR');
  });

  it('a rejected key is said, not mistaken for an empty account', async () => {
    const cfg = readConfig(home);
    expect(cfg.api_key).toBeDefined();
    g.state.acceptedKeys.clear();
    const r = await certen(['--json', 'gas'], { home, apiUrl: g.url });
    expect(r.code).toBe(1);
    expect(envelope(r).error!.code).toBe('CREDENTIAL_REJECTED');
  });
});
