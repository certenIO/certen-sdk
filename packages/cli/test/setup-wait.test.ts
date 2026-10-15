import { describe, it, expect, afterEach } from 'vitest';
import { startSetupGateway, FAKE, type SetupGateway, type SetupGatewayOptions } from './helpers/setup-gateway.js';
import { certen, envelope, newHome, readConfig } from './helpers/run-cli.js';

/**
 * Waiting for gas, from the command line.
 *
 * The wait is where setup used to end with a URL and a shrug. What is pinned:
 *
 * - it starts only when gas is the ONLY thing in the way and the gap is one that sending funds fixes; waiting for a faucet while the key page
 *   is wrong would be waiting for nothing;
 * - it asks for what the readiness check will accept, with an EIP-681 link the wallet can open, and says what it sees as it changes;
 * - it ends in one of three honest ways: the funds arrive (exit 0), the budget runs out (exit 1, nothing lost), or the person stops it;
 * - it is NOT the default where nobody is watching. A CI job that blocked for half an hour on a faucet would be a hang, so piped output and
 *   `--json` stop and say what to send, and only `--wait-for-funds` waits there.
 */

let gw: SetupGateway | undefined;
afterEach(async () => { await gw?.close(); gw = undefined; });
async function gateway(options: SetupGatewayOptions = {}): Promise<SetupGateway> {
  gw = await startSetupGateway(options);
  return gw;
}

const FAST = ['--poll-interval', '0.1'];
const NEW_ACCOUNT = ['--yes', '--no-passphrase', '--new-account', '--org-name', 'acme', '--name', 'probe', '--no-keyring', ...FAST];
const WALLET_LINK = `ethereum:${FAKE.abstractAccount}@84532?value=1000000000000000`;

describe('--wait-for-funds', () => {
  it('shows what to send and where, watches the balance change, and exits 0 when the funds arrive', async () => {
    // Reads of the identity: create 0, two to settle provisioning, one for readiness; the account is funded on the fifth.
    const g = await gateway({ fundAfterReads: 5 });
    const home = newHome();
    const r = await certen(['--json', 'setup', ...NEW_ACCOUNT, '--wait-for-funds'], { home, apiUrl: g.url });

    expect(r.code, r.stderr).toBe(0);
    const out = r.stderr; // in --json mode the progress is on stderr, the envelope on stdout
    expect(out).toContain(`Gas             ${FAKE.abstractAccount} holds 0 ETH on base-sepolia`);
    expect(out).toContain('Send 0.001 ETH to ');
    expect(out).toContain('(0.0001 ETH is the least that works; the rest saves a second trip)');
    expect(out).toContain('https://www.alchemy.com/faucets/base-sepolia');
    expect(out).toContain(WALLET_LINK);
    expect(out).toContain('Some faucets refuse a contract address');
    expect(out).toContain('Waiting for funds... (Ctrl-C to stop; run `certen setup` again to continue)');
    // Said when it changes, not on every poll.
    expect(out.match(new RegExp(`${FAKE.abstractAccount} holds 0 ETH`, 'g'))!.length).toBe(2); // once in the plan, once as the first reading
    expect(out.match(new RegExp(`${FAKE.abstractAccount} holds 0\\.001 ETH`, 'g'))!.length).toBe(1);
    expect(out).toContain('Funds arrived.');

    const e = envelope(r);
    expect(e.data).toMatchObject({ ready: true });
    expect(e.data!.steps.find((s: any) => s.step === 'gas')).toMatchObject({ status: 'waited', detail: 'funds arrived' });
    // One request per poll while it waited: the identity read, not the registry, the balance and a public node every few seconds.
    const waitPolls = g.calls.filter((c) => c.method === 'GET' && c.path.startsWith('/v1/identity/')).length;
    expect(waitPolls).toBeGreaterThanOrEqual(5);
  });

  it('stops after its budget, exits 1 with nothing lost, and the next run picks up where it was', async () => {
    const g = await gateway();
    const home = newHome();
    const first = await certen(['--json', 'setup', ...NEW_ACCOUNT, '--wait-for-funds', '--funds-timeout', '0.03'], { home, apiUrl: g.url });
    expect(first.code).toBe(1);
    const e = envelope(first);
    expect(e.error!.code).toBe('FUNDS_WAIT_TIMEOUT');
    expect(e.error!.message).toContain('Nothing is lost');
    expect(e.error!.message).toContain('certen setup');
    expect(e.error!.details.funding.payment_uri).toBe(WALLET_LINK);

    // The context was written before the wait began, so the next command (this one, `status`, `gas`) knows which account is meant.
    expect(readConfig(home).profiles.default).toMatchObject({ key: 'dev', chain: 'base-sepolia' });

    // Funds arrive while nobody was watching. Rerun: everything is skipped and it is ready.
    g.fund();
    const second = await certen(['--json', 'setup', '--yes', '--no-keyring', ...FAST], { home, apiUrl: g.url });
    expect(second.code, second.stderr).toBe(0);
    expect(envelope(second).data).toMatchObject({ ready: true, created: { key: false, account: false, identity: false } });
    expect(g.count('POST /v1/identity')).toBe(1);
    expect(g.count('POST /v1/signup')).toBe(1);
  });

  it('does not wait when the gap is not one that funds fix', async () => {
    const g = await gateway({ keyPageLacksKey: true });
    const home = newHome();
    const r = await certen(['--json', 'setup', ...NEW_ACCOUNT, '--wait-for-funds', '--funds-timeout', '5'], { home, apiUrl: g.url, timeoutMs: 30_000 });
    expect(r.code).toBe(1);
    expect(r.stderr).not.toContain('Waiting for funds');
  });
});

describe('nobody is watching', () => {
  it('piped, it does not wait: it stops, and says what to send and how to make it wait', async () => {
    const g = await gateway();
    const home = newHome();
    // No --wait-for-funds and not a terminal: this must come straight back (the default budget is half an hour).
    const r = await certen(['setup', ...NEW_ACCOUNT], { home, apiUrl: g.url, timeoutMs: 60_000 });
    expect(r.code).toBe(1);
    expect(r.stdout).toContain('Not ready on base-sepolia: gas is failing');
    expect(r.stdout).toContain(WALLET_LINK);
    expect(r.stdout).toContain('https://www.alchemy.com/faucets/base-sepolia');
    expect(r.stderr).toContain('Send the gas, then run `certen setup` again.');
    expect(r.stderr).toContain('--wait-for-funds');
    expect(r.stderr).toContain('Error [NOT_READY]');
    expect(r.stdout).not.toContain('Waiting for funds');
  });

  it('--no-wait-for-funds is honoured explicitly too', async () => {
    const g = await gateway();
    const home = newHome();
    const r = await certen(['--json', 'setup', ...NEW_ACCOUNT, '--no-wait-for-funds'], { home, apiUrl: g.url, timeoutMs: 60_000 });
    expect(r.code).toBe(1);
    expect(r.stderr).not.toContain('Waiting for funds');
    expect(envelope(r).error!.code).toBe('NOT_READY');
  });

  it('--amount makes the gas asked for cover the first send as well', async () => {
    const g = await gateway();
    const home = newHome();
    const r = await certen(['--json', 'setup', ...NEW_ACCOUNT, '--amount', '0.05'], { home, apiUrl: g.url });
    expect(r.code).toBe(1);
    const e = envelope(r);
    expect(e.error!.details.funding).toMatchObject({ minimum: '0.0501', send: '0.0501', payment_uri: `ethereum:${FAKE.abstractAccount}@84532?value=50100000000000000` });
  });
});
