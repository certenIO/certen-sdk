import { describe, it, expect } from 'vitest';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import { CertenClient, checkGas, gasFundingPlan, nativeTransferUri } from '../src/index.js';

/**
 * Telling someone how to fund an abstract account, and watching a balance until it is funded.
 *
 * The EIP-681 link is the one thing here a wallet acts on, and money sent to a wrong address is not recoverable, so every case has a
 * plausible wrong answer:
 *
 * - the value is integer wei computed with BigInt, not `0.001 * 1e18` (a float that prints `1000000000000000.1` and is refused by wallets);
 * - the address is the abstract account exactly as the gateway reported it (checksum case preserved), never re-derived;
 * - a chain this client does not know has no chain id to put in the link, so it gets no link rather than one for a guessed network;
 * - an estimate is called one: a chain with no gas estimate says there is none and asks for no number nobody measured.
 */

const ACCOUNT = '0xe293e95Ec1471155d977448B99B0922C2828cAcB';

describe('nativeTransferUri', () => {
  it('is exact wei for the chain id, with the address as given', () => {
    expect(nativeTransferUri({ chain: 'base-sepolia', address: ACCOUNT, amount: '0.001' }))
      .toBe(`ethereum:${ACCOUNT}@84532?value=1000000000000000`);
    expect(nativeTransferUri({ chain: 'ethereum-sepolia', address: ACCOUNT, amount: '0.01' }))
      .toBe(`ethereum:${ACCOUNT}@11155111?value=10000000000000000`);
  });

  it('keeps the last digit that a float would lose', () => {
    // 0.1 + 0.2 style trouble: 123456789.123456789 ETH is not representable as a double, and wei must still be exact.
    expect(nativeTransferUri({ chain: 'base-sepolia', address: ACCOUNT, amount: '123456789.123456789123456789' }))
      .toBe(`ethereum:${ACCOUNT}@84532?value=123456789123456789123456789`);
    expect(nativeTransferUri({ chain: 'base-sepolia', address: ACCOUNT, amount: '0.000000000000000001' }))
      .toBe(`ethereum:${ACCOUNT}@84532?value=1`);
  });

  it('opens the wallet at the address with no amount when none is given', () => {
    expect(nativeTransferUri({ chain: 'base-sepolia', address: ACCOUNT })).toBe(`ethereum:${ACCOUNT}@84532`);
  });

  it('accepts a numeric chain id as the gateway sometimes reports it', () => {
    expect(nativeTransferUri({ chain: '84532', address: ACCOUNT, amount: '1' })).toBe(`ethereum:${ACCOUNT}@84532?value=1000000000000000000`);
    expect(nativeTransferUri({ chain: 84532, address: ACCOUNT, amount: '1' })).toBe(`ethereum:${ACCOUNT}@84532?value=1000000000000000000`);
  });

  it('refuses to build a link it cannot make correct', () => {
    // An unknown chain has no id to put after the "@"; a link for a guessed network would send value to a place nobody chose.
    expect(nativeTransferUri({ chain: 'no-such-chain', address: ACCOUNT, amount: '1' })).toBeUndefined();
    for (const address of ['', '0x123', `0x${'g'.repeat(40)}`, ACCOUNT.slice(2), `${ACCOUNT}00`]) {
      expect(nativeTransferUri({ chain: 'base-sepolia', address, amount: '1' }), address).toBeUndefined();
    }
    // More decimals than the token has cannot be sent: rounding would change what is paid.
    expect(nativeTransferUri({ chain: 'base-sepolia', address: ACCOUNT, amount: '0.0000000000000000001' })).toBeUndefined();
    for (const amount of ['abc', '-1', '1e18', '0x10', '1,5']) {
      expect(nativeTransferUri({ chain: 'base-sepolia', address: ACCOUNT, amount }), amount).toBeUndefined();
    }
  });
});

describe('gasFundingPlan', () => {
  it('asks for ten executions\' worth by default, and says that is a suggestion', () => {
    const plan = gasFundingPlan({ chain: 'base-sepolia', address: ACCOUNT, balance: '0' })!;
    expect(plan).toMatchObject({
      chain: 'base-sepolia', symbol: 'ETH', address: ACCOUNT, balance: '0',
      // The reserve for base-sepolia is 0.0001, which is the least that clears the readiness gas check...
      minimum: '0.0001',
      // ...and ten of them is what is suggested sending, so the first few sends do not each need a faucet visit.
      suggested: '0.001',
      send: '0.001',
      least: '0.0001',
      estimated: true,
      faucet: 'https://www.alchemy.com/faucets/base-sepolia',
      paymentUri: `ethereum:${ACCOUNT}@84532?value=1000000000000000`,
    });
  });

  it('counts what is already there: it asks for the difference, not the whole', () => {
    const plan = gasFundingPlan({ chain: 'base-sepolia', address: ACCOUNT, balance: '0.00035' })!;
    expect(plan.suggested).toBe('0.001');
    expect(plan.send).toBe('0.00065');
    expect(plan.paymentUri).toBe(`ethereum:${ACCOUNT}@84532?value=650000000000000`);
    // Enough for the minimum already: nothing to send to proceed, though the suggestion still tops up.
    expect(plan.minimum).toBe('0.0001');
    expect(plan.satisfied).toBe(true);
    expect(plan.least).toBe('0');
    // And it says so, instead of telling someone who can already act that a smaller amount "is the least that works".
    expect(plan.steps[0]).toBe(`${ACCOUNT} on base-sepolia already holds 0.00035 ETH, enough to act. To top it up to 0.001 ETH, send 0.00065 ETH.`);
  });

  it('says which amount is the least and which is the suggestion, and never calls the bigger one "at least" next to the smaller', () => {
    const empty = gasFundingPlan({ chain: 'base-sepolia', address: ACCOUNT, balance: '0' })!;
    expect(empty.steps[0]).toBe(`Send 0.001 ETH to ${ACCOUNT} on base-sepolia (0.0001 ETH is the least that works; the rest saves a second trip).`);
    expect(empty.steps[0]).not.toMatch(/at least/i);

    // Something is there already but not enough: the least is what is still missing, said as "more".
    const some = gasFundingPlan({ chain: 'base-sepolia', address: ACCOUNT, balance: '0.00005' })!;
    expect(some).toMatchObject({ least: '0.00005', send: '0.00095', satisfied: false });
    expect(some.steps[0]).toBe(`Send 0.00095 ETH to ${ACCOUNT} on base-sepolia (0.00005 ETH more is the least that works; the rest saves a second trip).`);

    // When the suggestion IS the minimum (an amount to move set it), "at least" is the right word.
    const exact = gasFundingPlan({ chain: 'base-sepolia', address: ACCOUNT, balance: '0', amount: '0.05' })!;
    expect(exact.steps[0]).toBe(`Send at least 0.0501 ETH to ${ACCOUNT} on base-sepolia.`);
    expect(exact.least).toBe('0.0501');
  });

  it('is satisfied once the balance reaches the minimum, and not before', () => {
    expect(gasFundingPlan({ chain: 'base-sepolia', address: ACCOUNT, balance: '0.00009' })!.satisfied).toBe(false);
    expect(gasFundingPlan({ chain: 'base-sepolia', address: ACCOUNT, balance: '0.0001' })!.satisfied).toBe(true);
    // The balance is unknown: not satisfied. Unknown is not funded.
    expect(gasFundingPlan({ chain: 'base-sepolia', address: ACCOUNT, balance: null })!.satisfied).toBe(false);
    expect(gasFundingPlan({ chain: 'base-sepolia', address: ACCOUNT })!.satisfied).toBe(false);
  });

  it('adds the amount about to be moved to the minimum, so the link covers the transfer and its gas', () => {
    const plan = gasFundingPlan({ chain: 'base-sepolia', address: ACCOUNT, balance: '0', amount: '0.05' })!;
    expect(plan.minimum).toBe('0.0501');
    expect(plan.suggested).toBe('0.0501');
    expect(plan.send).toBe('0.0501');
    expect(plan.paymentUri).toBe(`ethereum:${ACCOUNT}@84532?value=50100000000000000`);
  });

  it('lets the caller\'s reserve replace the catalogue\'s, and `null` means none', () => {
    const own = gasFundingPlan({ chain: 'base-sepolia', address: ACCOUNT, balance: '0', reserve: '0.002' })!;
    expect(own.minimum).toBe('0.002');
    expect(own.suggested).toBe('0.02');
    const none = gasFundingPlan({ chain: 'base-sepolia', address: ACCOUNT, balance: '0', reserve: null })!;
    expect(none.minimum).toBeNull();
    expect(none.estimated).toBe(false);
  });

  it('asks for no number on a chain nobody has estimated, and says so', () => {
    const plan = gasFundingPlan({ chain: 'telcoin-adiri', address: ACCOUNT, balance: '0' })!;
    expect(plan.symbol).toBe('TEL');
    expect(plan.minimum).toBeNull();
    expect(plan.suggested).toBeNull();
    expect(plan.send).toBeNull();
    expect(plan.estimated).toBe(false);
    // No amount means the link opens the wallet at the address, and the words say there is no figure.
    expect(plan.paymentUri).toBe(`ethereum:${ACCOUNT}@2017`);
    expect(plan.steps.join(' ')).toMatch(/no estimate/i);
    // Any positive balance clears a chain with no estimate (the readiness check judges the amount alone there).
    expect(gasFundingPlan({ chain: 'telcoin-adiri', address: ACCOUNT, balance: '0.001' })!.satisfied).toBe(true);
    expect(gasFundingPlan({ chain: 'telcoin-adiri', address: ACCOUNT, balance: '0' })!.satisfied).toBe(false);
  });

  it('gives the faucet and the two-step alternative in words, without naming a command', () => {
    const plan = gasFundingPlan({ chain: 'base-sepolia', address: ACCOUNT, balance: '0' })!;
    const text = plan.steps.join('\n');
    expect(text).toContain('https://www.alchemy.com/faucets/base-sepolia');
    expect(text).toContain(ACCOUNT);
    // The alternative for a faucet that will not pay a contract address: a wallet you control, then a transfer from it.
    expect(text).toMatch(/wallet you control/i);
    expect(text).toContain('0.001 ETH');
    // The SDK does not know it is being driven by a CLI.
    expect(text).not.toMatch(/\bcerten\b/i);
    expect(plan.twoStep.length).toBe(2);
    expect(plan.twoStep[1]).toContain(ACCOUNT);
  });

  it('does not invent a plan for a chain it does not know', () => {
    expect(gasFundingPlan({ chain: 'no-such-chain', address: ACCOUNT, balance: '0' })).toBeUndefined();
  });

  it('treats an unreadable balance as unknown, not zero', () => {
    const plan = gasFundingPlan({ chain: 'base-sepolia', address: ACCOUNT, balance: 'unavailable' })!;
    expect(plan.balance).toBeNull();
    expect(plan.satisfied).toBe(false);
    // With no balance to subtract, the whole suggestion is what is asked for.
    expect(plan.send).toBe('0.001');
  });
});

// ── checkGas: the same judgement as readiness(), on its own ─────────────────────────────────────────────

const ID = '396f863c-879c-4046-8591-3f0405c5f6bd';

async function gateway(identity: (req: http.IncomingMessage, res: http.ServerResponse) => void): Promise<{ client: CertenClient; hits: string[]; close: () => Promise<void> }> {
  const hits: string[] = [];
  const server = http.createServer((req, res) => {
    hits.push(`${req.method} ${(req.url ?? '').split('?')[0]}`);
    res.setHeader('content-type', 'application/json');
    identity(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const client = new CertenClient({ apiKey: 'ck_live_test', baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, maxRetries: 0 });
  return { client, hits, close: () => new Promise<void>((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); }) };
}

const identityBody = (balance: string) => ({
  id: ID, adi_url: 'acc://probe.acme', status: 'active', can_sign: true, key_page_url: 'acc://probe.acme/book/1', credit_balance: 500,
  chain_accounts: [{ chain_id: '84532', address: ACCOUNT, status: 'deployed' }],
  balances: [{ chain_id: 'base-sepolia', address: ACCOUNT, token: 'ETH', balance }],
});

describe('checkGas', () => {
  it('reads one identity and judges it the way readiness() does', async () => {
    const g = await gateway((_req, res) => { res.end(JSON.stringify(identityBody('0.0021'))); });
    try {
      const ok = await checkGas(g.client, { identityId: ID, chain: 'base-sepolia' });
      expect(ok).toMatchObject({ name: 'gas', status: 'ok' });
      // One request: the wait loop must not cost the gateway the registry, the balance and a public Accumulate node every few seconds.
      expect(g.hits).toEqual([`GET /v1/identity/${ID}`]);
    } finally { await g.close(); }
  });

  it('fails an empty account with the funding code and the facts a poller needs', async () => {
    const g = await gateway((_req, res) => { res.end(JSON.stringify(identityBody('0'))); });
    try {
      const bad = await checkGas(g.client, { identityId: ID, chain: 'base-sepolia', amount: '0.0001' });
      expect(bad).toMatchObject({ name: 'gas', status: 'fail', code: 'ABSTRACT_ACCOUNT_UNFUNDED' });
      expect(bad.data).toMatchObject({ abstract_account: ACCOUNT, balance: '0', needed: '0.0002', symbol: 'ETH' });
    } finally { await g.close(); }
  });

  it('is unknown when the identity cannot be read, with the status so a poller can tell a bad key from a bad moment', async () => {
    const g = await gateway((_req, res) => { res.statusCode = 401; res.end(JSON.stringify({ message: 'no' })); });
    try {
      const unread = await checkGas(g.client, { identityId: ID, chain: 'base-sepolia' });
      expect(unread).toMatchObject({ name: 'gas', status: 'unknown', code: 'GAS_UNREADABLE' });
      expect(unread.data).toMatchObject({ status: 401 });
    } finally { await g.close(); }
    const down = await gateway((_req, res) => { res.statusCode = 503; res.end('{}'); });
    try {
      const unread = await checkGas(down.client, { identityId: ID, chain: 'base-sepolia' });
      expect(unread.status).toBe('unknown');
      expect(unread.data).toMatchObject({ status: 503 });
    } finally { await down.close(); }
  });

  it('refuses a malformed call', async () => {
    const g = await gateway((_req, res) => { res.end('{}'); });
    try {
      await expect(checkGas(g.client, { identityId: '', chain: 'base-sepolia' })).rejects.toMatchObject({ code: 'MISSING_IDENTITY' });
      await expect(checkGas(g.client, { identityId: ID, chain: '' })).rejects.toMatchObject({ code: 'MISSING_CHAIN' });
    } finally { await g.close(); }
  });
});
