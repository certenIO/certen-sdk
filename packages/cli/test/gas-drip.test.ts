import { describe, it, expect, afterEach } from 'vitest';
import { certen, envelope } from './helpers/run-cli.js';
import { startStub, homeFor, WHO, API_KEY, type Stub, type Seen, type Reply } from './helpers/stub-gateway.js';

/**
 * `certen gas --drip`: ask the PLATFORM to send gas to an account that is short.
 *
 * `gas` without the flag is untouched (gas.test.ts). With it, the only new thing is a request that spends the platform's funds, so what is
 * pinned is the guard around it and the honesty of its answer:
 *
 * - it never spends unattended, and it spends nothing for an account that is already funded;
 * - the Idempotency-Key is printed and reusable, and the request carries no body at all (the amount and the destination are the gateway's);
 * - `sent`, `skipped` and `unconfirmed` are each said as they are, and an unconfirmed drip is not a success;
 * - off, mainnet, a limit, an unavailable sponsor or a recipient that rejects: a plain message, one request, and the manual steps as the fallback;
 * - `--wait` goes on into the existing wait for the gas.
 */

const DRIP = `/v1/identity/${WHO.id}/chain-accounts/base-sepolia/drip`;
const SENT = {
  drip_id: 'd-1', identity_id: WHO.id, chain: 'base-sepolia', chain_id: 84532, address: WHO.account, status: 'sent',
  tx_hash: `0x${'ab'.repeat(32)}`, amount: '0.01', symbol: 'ETH', explorer_url: `https://sepolia.basescan.org/tx/0x${'ab'.repeat(32)}`, note: 'sent',
};
const err = (code: string, status: number, message = `${code} happened`): Reply => ({ status, body: { error: message, code } });

let stub: Stub | undefined;
afterEach(async () => { await stub?.close(); stub = undefined; });

interface Rig {
  /** What the drip route answers. */
  drip?: Reply;
  /** The balance the account holds to begin with. Default 0. */
  balance?: string;
  /** A sent drip funds the account at once. Default true. */
  fundOnSent?: boolean;
  /** The account is funded after this many reads of the identity (what a block and an indexer do). */
  fundAfterReads?: number;
}

async function serve(rig: Rig = {}): Promise<Stub> {
  let balance = rig.balance ?? '0';
  let reads = 0;
  stub = await startStub((r: Seen) => {
    if (r.method === 'GET' && r.path === `/v1/identity/${WHO.id}`) {
      reads += 1;
      if (rig.fundAfterReads !== undefined && reads >= rig.fundAfterReads) balance = '0.01';
      return {
        body: {
          id: WHO.id, adi_url: WHO.adi, status: 'active', can_sign: true, key_page_url: WHO.keyPage, credit_balance: 500,
          chain_accounts: [{ chain_id: String(WHO.chainId), address: WHO.account, status: 'deployed' }],
          balances: [{ chain_id: WHO.chain, address: WHO.account, token: 'ETH', balance }], created_at: '2026-10-15T00:00:00Z',
        },
      };
    }
    if (r.method === 'POST' && r.path === DRIP) {
      const reply = rig.drip ?? { status: 200, body: SENT };
      if (reply.status === 200 && (reply.body as { status?: string } | undefined)?.status === 'sent' && rig.fundOnSent !== false) balance = '0.01';
      return reply;
    }
    return undefined;
  });
  return stub;
}
const drips = (s: Stub): Seen[] => s.calls().filter((r) => r.method === 'POST' && r.path === DRIP);
const everything = (r: { stdout: string; stderr: string }): string => `${r.stdout}\n${r.stderr}`;
const DRIPPING = ['gas', '--drip', '--yes'];

describe('a drip for an account that is short', () => {
  it('asks once, with no body and a key, and reports the transaction and a link', async () => {
    const g = await serve();
    const r = await certen(DRIPPING, { home: homeFor(g.url), apiUrl: g.url });
    expect(r.code, r.stderr).toBe(0);
    expect(drips(g)).toHaveLength(1);
    // The amount and the destination are the gateway's: the request carries neither.
    expect(drips(g)[0]!.raw).toBe('');
    expect(drips(g)[0]!.headers['x-api-key']).toBe(API_KEY);
    const key = String(drips(g)[0]!.headers['idempotency-key']);
    expect(key).toMatch(/^certen-[0-9a-f-]{36}$/);

    expect(r.stdout).toContain('Drip sent: 0.01 ETH to ');
    expect(r.stdout).toContain(`tx        ${SENT.tx_hash}`);
    expect(r.stdout).toContain(`explorer  ${SENT.explorer_url}`);
    expect(r.stdout).toContain(`key       ${key}`);
    expect(r.stdout).toContain('Funds arrived.');
    // What is being asked is said before it is asked, on stderr.
    expect(r.stderr).toContain(`Ask the platform to send gas to ${WHO.account} on base-sepolia`);
    expect(r.stderr).toContain('the operator\'s, set at the gateway: not yours to choose');
    // The manual steps are not shown above a request to do it for you.
    expect(r.stdout).not.toContain('Send 0.001 ETH to ');
  });

  it('--json carries the drip next to the plan, with the key', async () => {
    const g = await serve();
    const r = await certen(['--json', ...DRIPPING], { home: homeFor(g.url), apiUrl: g.url });
    expect(r.code, r.stderr).toBe(0);
    const data = envelope(r).data!;
    const key = String(drips(g)[0]!.headers['idempotency-key']);
    expect(data).toMatchObject({ funded: true, abstract_account: WHO.account, drip: { requested: true, ...SENT, idempotency_key: key } });
  });

  it('a retry with --idempotency-key sends that same key', async () => {
    const g = await serve();
    const home = homeFor(g.url);
    for (let i = 0; i < 2; i += 1) {
      const r = await certen(['--json', ...DRIPPING, '--idempotency-key', 'drip-77'], { home, apiUrl: g.url });
      // The second run finds the account funded (the stub keeps its balance), so only the first spends; both runs are told the same.
      expect(r.code, r.stderr).toBe(0);
    }
    expect(drips(g).map((d) => d.headers['idempotency-key'])).toEqual(['drip-77']);
    const fresh = await serve();
    const again = await certen(['--json', ...DRIPPING, '--idempotency-key', 'drip-77'], { home: homeFor(fresh.url), apiUrl: fresh.url });
    expect(envelope(again).data!.drip).toMatchObject({ idempotency_key: 'drip-77' });
    expect(drips(fresh)[0]!.headers['idempotency-key']).toBe('drip-77');
  }, 90_000);

  it('never prints the API key', async () => {
    const g = await serve();
    const r = await certen(DRIPPING, { home: homeFor(g.url), apiUrl: g.url });
    expect(everything(r)).not.toContain(API_KEY);
  });
});

describe('an account that is not short is not dripped', () => {
  it('a funded account costs no drip: it is reported funded, and the envelope has no drip in it', async () => {
    const g = await serve({ balance: '0.01' });
    const r = await certen(['--json', ...DRIPPING], { home: homeFor(g.url), apiUrl: g.url });
    expect(r.code, r.stderr).toBe(0);
    expect(drips(g)).toHaveLength(0);
    const data = envelope(r).data!;
    expect(data.funded).toBe(true);
    expect('drip' in data).toBe(false);
  });
});

describe('it never spends unattended', () => {
  it('with nobody at a terminal and no --yes it refuses (exit 2) before anything is read or sent', async () => {
    const g = await serve();
    const r = await certen(['gas', '--drip'], { home: homeFor(g.url), apiUrl: g.url });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('CONFIRMATION_REQUIRED');
    expect(r.stderr).toContain('spends the platform\'s funds');
    expect(g.seen).toHaveLength(0);
  });

  it('--json is not consent', async () => {
    const g = await serve();
    const r = await certen(['--json', 'gas', '--drip'], { home: homeFor(g.url), apiUrl: g.url });
    expect(r.code).toBe(2);
    expect(envelope(r).error).toMatchObject({ code: 'CONFIRMATION_REQUIRED', retryable: false });
    expect(g.seen).toHaveLength(0);
  });

  it('refuses a key the gateway would refuse, and --yes or --idempotency-key without --drip, before any request', async () => {
    const g = await serve();
    const home = homeFor(g.url);
    const badKey = await certen(['--json', ...DRIPPING, '--idempotency-key', 'has space'], { home, apiUrl: g.url });
    expect(badKey.code).toBe(2);
    expect(envelope(badKey).error).toMatchObject({ code: 'INVALID_IDEMPOTENCY_KEY' });
    for (const stray of [['--yes'], ['--idempotency-key', 'k']]) {
      const r = await certen(['--json', 'gas', ...stray], { home, apiUrl: g.url });
      expect(r.code, r.stderr).toBe(2);
      expect(envelope(r).error).toMatchObject({ code: 'CONFLICTING_FLAGS' });
    }
    expect(g.seen).toHaveLength(0);
  }, 60_000);
});

describe('what the gateway said, said as it is', () => {
  it('skipped: nothing was sent, and the account the CLI still finds short stays short (exit 1) with the manual steps', async () => {
    const g = await serve({ drip: { status: 200, body: { ...SENT, status: 'skipped', tx_hash: null, amount: null, explorer_url: null, note: 'already funded' } } });
    const home = homeFor(g.url);
    const human = await certen(DRIPPING, { home, apiUrl: g.url });
    expect(human.code).toBe(1);
    expect(human.stdout).toContain('Drip skipped: the gateway found the account already holding enough');
    expect(human.stdout).not.toContain('Drip sent');
    expect(human.stdout).toContain('Send 0.001 ETH to ');
    const json = await certen(['--json', ...DRIPPING], { home, apiUrl: g.url });
    const e = envelope(json);
    expect(e.error).toMatchObject({ code: 'ABSTRACT_ACCOUNT_UNFUNDED' });
    expect(e.error!.details).toMatchObject({ drip: { requested: true, status: 'skipped' } });
  }, 60_000);

  it('unconfirmed: not a success. Exit 1, the drip MAY have been sent, the key and the next command are given', async () => {
    const g = await serve({ drip: { status: 202, body: { ...SENT, status: 'unconfirmed', tx_hash: null } } });
    const home = homeFor(g.url);
    const json = await certen(['--json', ...DRIPPING], { home, apiUrl: g.url });
    expect(json.code).toBe(1);
    const e = envelope(json);
    expect(e.ok).toBe(false);
    expect(e.error).toMatchObject({ code: 'DRIP_UNCONFIRMED', retryable: false, next: 'certen gas --chain base-sepolia --wait' });
    expect(e.error!.message).toContain('UNCONFIRMED');
    expect(e.error!.message).toContain('MAY be on its way');
    expect(e.error!.message).toContain('Do not ask again with a new key');
    const key = String(drips(g)[0]!.headers['idempotency-key']);
    expect(e.error!.details).toMatchObject({ drip: { requested: true, status: 'unconfirmed', idempotency_key: key }, funded: false });
    expect(e.error!.message).toContain(`--idempotency-key ${key}`);

    const human = await certen(DRIPPING, { home, apiUrl: g.url });
    expect(human.code).toBe(1);
    expect(human.stdout).toContain('Drip UNCONFIRMED');
    expect(human.stdout).not.toContain('Drip sent');
    expect(human.stdout).not.toContain('Funds arrived');
    expect(human.stderr).toContain('next: certen gas --chain base-sepolia --wait');
  }, 60_000);

  it('unconfirmed with --wait goes on waiting for the gas, and ends only when it arrives', async () => {
    const g = await serve({ drip: { status: 202, body: { ...SENT, status: 'unconfirmed', tx_hash: null } }, fundAfterReads: 4 });
    const r = await certen([...DRIPPING, '--wait', '--poll-interval', '0.1'], { home: homeFor(g.url), apiUrl: g.url });
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain('Drip UNCONFIRMED');
    expect(r.stdout).toContain('Waiting to see whether the gas arrives');
    expect(r.stdout).toContain('Funds arrived.');
    expect(drips(g)).toHaveLength(1);
  });

  it('sent but not yet visible: without --wait it says the gas is not there yet (exit 1); with --wait it waits for it (exit 0)', async () => {
    const lag = await serve({ fundOnSent: false, fundAfterReads: 99 });
    const plain = await certen(['--json', ...DRIPPING], { home: homeFor(lag.url), apiUrl: lag.url });
    expect(plain.code).toBe(1);
    expect(envelope(plain).error).toMatchObject({ code: 'ABSTRACT_ACCOUNT_UNFUNDED' });
    expect(envelope(plain).error!.details).toMatchObject({ drip: { status: 'sent', tx_hash: SENT.tx_hash } });
    await lag.close(); stub = undefined;

    const slow = await serve({ fundOnSent: false, fundAfterReads: 5 });
    const waited = await certen([...DRIPPING, '--wait', '--poll-interval', '0.1'], { home: homeFor(slow.url), apiUrl: slow.url });
    expect(waited.code, waited.stderr).toBe(0);
    expect(waited.stdout).toContain('Drip sent');
    expect(waited.stdout).toContain('Funds arrived.');
    expect(drips(slow)).toHaveLength(1);
  }, 90_000);

  it('a drip that went to a different account than the one shown is called out', async () => {
    const g = await serve({ drip: { status: 200, body: { ...SENT, address: '0x2222222222222222222222222222222222222222' } } });
    const r = await certen(DRIPPING, { home: homeFor(g.url), apiUrl: g.url });
    expect(r.stderr).toContain('which is not the account shown above');
  });
});

describe('off, limited, or refused: a plain message, one request, and the manual way', () => {
  const CASES: Array<[string, Reply, boolean, RegExp]> = [
    ['DRIP_DISABLED', err('DRIP_DISABLED', 503), false, /is not switched on at this gateway.*retrying will not.*Nothing was sent/s],
    ['DRIP_TESTNET_ONLY', err('DRIP_TESTNET_ONLY', 422), false, /for testnets only, and base-sepolia is not one.*Nothing was sent/s],
    ['DRIP_LIMIT', err('DRIP_LIMIT', 429, 'already dripped within the 24h cooldown'), true, /A drip limit was reached: already dripped within the 24h cooldown.*Nothing was sent/s],
    ['DRIP_UNAVAILABLE', err('DRIP_UNAVAILABLE', 503, 'the sponsor wallet is below its floor'), true, /cannot send a drip on base-sepolia right now: the sponsor wallet is below its floor.*Nothing was sent/s],
    ['DRIP_RECIPIENT_REJECTS', err('DRIP_RECIPIENT_REJECTS', 422), false, /cannot receive a drip.*Nothing was sent.*Contact support/s],
  ];

  it.each(CASES)('%s', async (code, reply, retryable, message) => {
    const g = await serve({ drip: reply });
    const home = homeFor(g.url);
    const json = await certen(['--json', ...DRIPPING], { home, apiUrl: g.url });
    expect(json.code, json.stderr).toBe(1);
    const e = envelope(json);
    expect(e.error).toMatchObject({ code, retryable, status: reply.status });
    expect(e.error!.message).toMatch(message);
    // The envelope carries the manual route, so a script can still show the address and the link.
    expect(e.error!.details).toMatchObject({ chain: 'base-sepolia', abstract_account: WHO.account, funded: false, drip: { requested: true } });
    expect(e.error!.details!.steps).toBeTruthy();
    expect(e.error!.next).toBe(code === 'DRIP_RECIPIENT_REJECTS' ? 'certen gas --chain base-sepolia' : 'certen gas --chain base-sepolia --wait');
    // One request: a limit is a window and a switch is not a blip, so the CLI does not ask again on its own.
    expect(drips(g)).toHaveLength(1);

    const human = await certen(DRIPPING, { home, apiUrl: g.url });
    expect(human.code).toBe(1);
    expect(human.stderr).toContain(`Error [${code}]`);
    if (code !== 'DRIP_RECIPIENT_REJECTS') {
      expect(human.stdout).toContain('Send 0.001 ETH to ');
      expect(human.stdout).toContain('https://www.alchemy.com/faucets/base-sepolia');
    }
  }, 60_000);

  it('a connection that drops is exit 3, says the drip MAY have been sent, hands over the key, and shows no manual steps to mislead', async () => {
    const g = await serve({ drip: { destroy: true } });
    const r = await certen(['--json', ...DRIPPING], { home: homeFor(g.url), apiUrl: g.url });
    expect(r.code).toBe(3);
    const key = String(drips(g)[0]!.headers['idempotency-key']);
    const e = envelope(r);
    expect(e.error).toMatchObject({ code: 'NETWORK_ERROR', retryable: true });
    expect(e.error!.message).toContain('the drip may have been sent');
    expect(e.error!.message).toContain(`--idempotency-key ${key}`);
    expect(e.error!.details).toMatchObject({ idempotency_key: key, drip: { requested: true, idempotency_key: key } });
    expect(drips(g)).toHaveLength(1);
  });
});

describe('gas without --drip is what it was', () => {
  it('an unfunded account still prints the steps, exits 1, and asks for nothing', async () => {
    const g = await serve();
    const r = await certen(['gas'], { home: homeFor(g.url), apiUrl: g.url });
    expect(r.code).toBe(1);
    expect(r.stdout).toContain('Send 0.001 ETH to ');
    expect(g.calls().every((c) => c.method === 'GET')).toBe(true);
  });

  it('--drip shows up in the help, with what it spends', async () => {
    const g = await serve();
    const r = await certen(['gas', '--help'], { home: homeFor(g.url), apiUrl: g.url });
    expect(r.stdout).toContain('--drip');
    expect(r.stdout).toContain('PLATFORM');
  });
});
