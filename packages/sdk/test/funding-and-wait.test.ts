import { describe, it, expect } from 'vitest';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import { CertenClient, CertenUnfundedAccountError, CertenFundingUnverifiableError } from '../src/index.js';

/**
 * Two protections the CLI had first, moved into the SDK so an SDK caller gets them too.
 *
 * **The funding guard.** An intent that moves value from an empty abstract account is accepted,
 * signed and submitted — every call returns success — and then parks at `anchoring` forever,
 * because the execution leg cannot run on chain. No response says so. Refusing before submitting is
 * the only point at which anyone finds out.
 *
 * **`createAndWait`.** `create()` returns 202 and provisioning continues, so its response says
 * nothing about whether the identity works. `can_sign` has THREE values and each means something
 * different; conflating `null` with `false`, or either with "ready", produces an identity that
 * fails at the last step of every later flow.
 */

interface Req { method: string; path: string; body?: any }

async function gateway(handler: (e: Req, n: number) => { status?: number; body?: unknown }) {
  const seen: Req[] = [];
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    const entry: Req = {
      method: req.method ?? 'GET',
      path: (req.url ?? '').split('?')[0],
      body: raw ? JSON.parse(raw) : undefined,
    };
    seen.push(entry);
    const out = handler(entry, seen.length);
    res.writeHead(out.status ?? 200, { 'content-type': 'application/json' })
      .end(JSON.stringify(out.body ?? {}));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return {
    seen,
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => server.close(),
  };
}

const client = (url: string) => new CertenClient({ apiKey: 'ck_live_test', baseUrl: url, maxRetries: 0 });

const HASH = 'ab'.repeat(32);
const PUBKEY = '11'.repeat(32);
const OPENED = {
  status: 201,
  body: {
    intent_id: 'intent-1',
    signing_mode: 'external',
    signing_data: { hash_to_sign: HASH },
    submit_url: '/v1/transaction/intent-1/signature',
  },
};

/** A portfolio where the identity's account on `chainId` holds `balance`. */
function portfolio(chainId: string, balance: string): unknown {
  return {
    identities: [{
      adi_url: 'acc://org.acme',
      status: 'active',
      credit_balance: 500,
      chains: [{ chain_id: chainId, address: '0xAbs', deployed: true, balances: [{ token: 'ETH', balance }] }],
      pending_actions: 0,
    }],
    total_chains: 1,
  };
}

const TRANSFER = {
  identityId: 'id-1',
  adiUrl: 'acc://org.acme',
  fromChain: 'accumulate',
  toChain: 'ethereum-sepolia',
  fromAddress: 'acc://org.acme',
  toAddress: '0xBe00',
  amount: '4000',
  publicKey: PUBKEY,
  sign: (h: string) => `signed:${h}`,
};

function opened(over: (e: Req) => { status?: number; body?: unknown } | null) {
  return (e: Req) => over(e) ?? (e.path === '/v1/transaction' && e.method === 'POST' ? OPENED : { body: { ok: true } });
}

describe('the funding guard refuses before anything is submitted', () => {
  it('throws on a positively observed zero balance, and opens no intent', async () => {
    const g = await gateway(opened((e) => (e.path === '/v1/portfolio' ? { body: portfolio('ethereum-sepolia', '0') } : null)));
    try {
      await expect(client(g.url).execute.transfer(TRANSFER))
        .rejects.toBeInstanceOf(CertenUnfundedAccountError);
      // The point of running before the POST: nothing reached the gateway.
      expect(g.seen.some((e) => e.path === '/v1/transaction')).toBe(false);
    } finally { g.close(); }
  });

  it('names the address and the chain, and says what would have happened', async () => {
    const g = await gateway(opened((e) => (e.path === '/v1/portfolio' ? { body: portfolio('ethereum-sepolia', '0') } : null)));
    try {
      const err = await client(g.url).execute.transfer(TRANSFER).catch((e: unknown) => e as CertenUnfundedAccountError);
      expect(err.address).toBe('0xAbs');
      expect(err.chain).toBe('ethereum-sepolia');
      expect(err.message).toMatch(/anchoring/);
      // Funding is a human act. Retrying changes nothing, and saying otherwise would send an
      // automated caller into a loop against a condition that cannot resolve itself.
      expect(err.isRetryable).toBe(false);
    } finally { g.close(); }
  });

  it('matches a NUMERIC chain_id against a slug — the two spellings the gateway mixes', async () => {
    // Without normalizing, this account is never found and the guard silently does nothing on
    // exactly the entries it was written to protect.
    const g = await gateway(opened((e) => (e.path === '/v1/portfolio' ? { body: portfolio('11155111', '0') } : null)));
    try {
      await expect(client(g.url).execute.transfer(TRANSFER))
        .rejects.toBeInstanceOf(CertenUnfundedAccountError);
    } finally { g.close(); }
  });

  it('allows the transfer when the account has a balance', async () => {
    const g = await gateway(opened((e) => (e.path === '/v1/portfolio' ? { body: portfolio('ethereum-sepolia', '1000') } : null)));
    try {
      const out = await client(g.url).execute.transfer(TRANSFER);
      expect(out.intentId).toBe('intent-1');
    } finally { g.close(); }
  });

  it('does NOT block when the balance cannot be read — a guard must not become a gate', async () => {
    // Blocking on missing data would break legitimate work every time the portfolio view lagged,
    // which is a worse failure than the one being prevented.
    const g = await gateway(opened((e) => (e.path === '/v1/portfolio' ? { status: 500, body: {} } : null)));
    try {
      const out = await client(g.url).execute.transfer(TRANSFER);
      expect(out.intentId).toBe('intent-1');
    } finally { g.close(); }
  });

  it('does not block when the identity has no account on that chain', async () => {
    const g = await gateway(opened((e) => (e.path === '/v1/portfolio' ? { body: portfolio('base-sepolia', '0') } : null)));
    try {
      const out = await client(g.url).execute.transfer(TRANSFER);
      expect(out.intentId).toBe('intent-1');
    } finally { g.close(); }
  });

  it('skipFundingCheck submits anyway, and skips the lookup entirely', async () => {
    const g = await gateway(opened((e) => (e.path === '/v1/portfolio' ? { body: portfolio('ethereum-sepolia', '0') } : null)));
    try {
      const out = await client(g.url).execute.transfer({ ...TRANSFER, skipFundingCheck: true });
      expect(out.intentId).toBe('intent-1');
      expect(g.seen.some((e) => e.path === '/v1/portfolio')).toBe(false);
    } finally { g.close(); }
  });

  it('does not apply to a contract call that forwards no value', async () => {
    // A read-shaped call is unaffected by an empty account, so checking would refuse work that
    // succeeds — and would cost a portfolio round trip on every call.
    const g = await gateway(opened((e) => (e.path === '/v1/portfolio' ? { body: portfolio('ethereum-sepolia', '0') } : null)));
    try {
      const out = await client(g.url).execute.contractCall({
        identityId: 'id-1',
        adiUrl: 'acc://org.acme',
        fromAddress: '0xAbs',
        chain: 'ethereum-sepolia',
        contractCall: { target: '0xE', functionSignature: 'confirm(bytes32)', args: ['0x00'] },
        publicKey: PUBKEY,
        sign: (h) => `signed:${h}`,
      });
      expect(out.intentId).toBe('intent-1');
      expect(g.seen.some((e) => e.path === '/v1/portfolio')).toBe(false);
    } finally { g.close(); }
  });

  it('DOES apply to a payable contract call', async () => {
    const g = await gateway(opened((e) => (e.path === '/v1/portfolio' ? { body: portfolio('ethereum-sepolia', '0') } : null)));
    try {
      await expect(client(g.url).execute.contractCall({
        identityId: 'id-1',
        adiUrl: 'acc://org.acme',
        fromAddress: '0xAbs',
        chain: 'ethereum-sepolia',
        contractCall: { target: '0xE', functionSignature: 'deposit()', value: '1000' },
        publicKey: PUBKEY,
        sign: (h) => `signed:${h}`,
      })).rejects.toBeInstanceOf(CertenUnfundedAccountError);
    } finally { g.close(); }
  });
});

describe('identity.createAndWait', () => {
  const ID = 'id-9';
  function identity(over: Record<string, unknown>): unknown {
    // Flat since the 2026-08 break — the identity is no longer nested under an `identity` key.
    return {
      id: ID,
      adi_url: 'acc://mybot.acme',
      book_url: null,
      key_page_url: null,
      status: 'provisioning',
      can_sign: null,
      credit_balance: 500,
      chain_accounts: [],
      created_at: '2026-01-01T00:00:00Z',
      ...over,
    };
  }

  it('polls until the identity is active AND can sign', async () => {
    let gets = 0;
    const g = await gateway((e) => {
      if (e.method === 'POST') return { status: 202, body: identity({}) };
      gets += 1;
      if (gets === 1) return { body: identity({ status: 'provisioning' }) };
      // Active but unreadable key page — the state a naive check accepts.
      if (gets === 2) return { body: identity({ status: 'active', can_sign: null }) };
      return { body: identity({ status: 'active', can_sign: true }) };
    });
    try {
      const identityOut = await client(g.url).identity.createAndWait(
        { name: 'mybot', publicKeyHash: 'a'.repeat(64) },
        { intervalMs: 5 },
      );
      expect(identityOut.status).toBe('active');
      expect(identityOut.can_sign).toBe(true);
    } finally { g.close(); }
  });

  it('throws when provisioning finishes but the identity cannot sign', async () => {
    const g = await gateway((e) => (e.method === 'POST'
      ? { status: 202, body: identity({}) }
      : { body: identity({ status: 'active', can_sign: false }) }));
    try {
      await expect(client(g.url).identity.createAndWait(
        { name: 'mybot', publicKeyHash: 'a'.repeat(64) },
        { intervalMs: 5, timeoutMs: 500 },
      )).rejects.toThrow(/cannot sign/);
    } finally { g.close(); }
  });

  it('never rounds can_sign: null up to ready', async () => {
    const g = await gateway((e) => (e.method === 'POST'
      ? { status: 202, body: identity({}) }
      : { body: identity({ status: 'active', can_sign: null }) }));
    try {
      await expect(client(g.url).identity.createAndWait(
        { name: 'mybot', publicKeyHash: 'a'.repeat(64) },
        { intervalMs: 5, timeoutMs: 150 },
      )).rejects.toThrow(/could not be determined/);
    } finally { g.close(); }
  });

  it('reports a provisioning error with the reason the gateway gave', async () => {
    const g = await gateway((e) => (e.method === 'POST'
      ? { status: 202, body: identity({}) }
      : { body: identity({ status: 'error', can_sign: null, error_message: 'sponsor key unavailable' }) }));
    try {
      await expect(client(g.url).identity.createAndWait(
        { name: 'mybot', publicKeyHash: 'a'.repeat(64) },
        { intervalMs: 5, timeoutMs: 500 },
      )).rejects.toThrow(/sponsor key unavailable/);
    } finally { g.close(); }
  });

  it('treats a timeout as neither success nor failure', async () => {
    const g = await gateway((e) => (e.method === 'POST'
      ? { status: 202, body: identity({}) }
      : { body: identity({ status: 'provisioning' }) }));
    try {
      await expect(client(g.url).identity.createAndWait(
        { name: 'mybot', publicKeyHash: 'a'.repeat(64) },
        { intervalMs: 5, timeoutMs: 120 },
      )).rejects.toThrow(/may yet finish/);
    } finally { g.close(); }
  });

  it('surfaces each poll, so a caller can report progress', async () => {
    const seenStatuses: string[] = [];
    let gets = 0;
    const g = await gateway((e) => {
      if (e.method === 'POST') return { status: 202, body: identity({}) };
      gets += 1;
      return gets === 1
        ? { body: identity({ status: 'provisioning' }) }
        : { body: identity({ status: 'active', can_sign: true }) };
    });
    try {
      await client(g.url).identity.createAndWait(
        { name: 'mybot', publicKeyHash: 'a'.repeat(64) },
        { intervalMs: 5, onPoll: (i) => seenStatuses.push(i.status) },
      );
      expect(seenStatuses).toEqual(['provisioning', 'active']);
    } finally { g.close(); }
  });
});

/** A portfolio where the identity's account on `chainId` holds `balance` of `token`. */
function portfolioWith(chainId: string, token: string, balance: string): unknown {
  return {
    identities: [{
      adi_url: 'acc://org.acme', status: 'active', credit_balance: 500, pending_actions: 0,
      chains: [{ chain_id: chainId, address: '0xAbs', deployed: true, balances: [{ token, balance }] }],
    }],
    total_chains: 1,
  };
}

const onPortfolio = (body: unknown) => opened((e) => (e.path === '/v1/portfolio' ? { body } : null));

describe('the funding guard reads each chain\'s OWN gas token (it used to look only for ETH)', () => {
  const TO_ADIRI = { ...TRANSFER, toChain: 'telcoin-adiri' };

  it('refuses an empty TEL account on 2017 — before, no ETH row was found and the intent went through', async () => {
    const g = await gateway(onPortfolio(portfolioWith('2017', 'TEL', '0')));
    try {
      const err = await client(g.url).execute.transfer(TO_ADIRI).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(CertenUnfundedAccountError);
      expect((err as CertenUnfundedAccountError).chain).toBe('telcoin-adiri');
      expect(g.seen.some((e) => e.path === '/v1/transaction')).toBe(false);
    } finally { g.close(); }
  });

  it('allows a funded TEL account on 2017', async () => {
    const g = await gateway(onPortfolio(portfolioWith('telcoin-adiri', 'TEL', '2.5')));
    try {
      expect((await client(g.url).execute.transfer(TO_ADIRI)).intentId).toBe('intent-1');
    } finally { g.close(); }
  });

  it('refuses by name when 2017 reports only an ETH row: that is not its gas', async () => {
    // A gateway whose balance reader labels every EVM chain ETH. Reading that number as TEL gas
    // would be reading the wrong thing; passing silently is the old failure.
    const g = await gateway(onPortfolio(portfolioWith('2017', 'ETH', '5')));
    try {
      const err = await client(g.url).execute.transfer(TO_ADIRI).catch((e: unknown) => e as CertenFundingUnverifiableError);
      expect(err).toBeInstanceOf(CertenFundingUnverifiableError);
      expect(err.code).toBe('ABSTRACT_ACCOUNT_FUNDING_UNVERIFIABLE');
      expect(err.reason).toBe('native-not-reported');
      expect(err.message).toMatch(/gas token is TEL/);
      expect(err.isRetryable).toBe(false);
      expect(g.seen.some((e) => e.path === '/v1/transaction')).toBe(false);
    } finally { g.close(); }
  });

  it('refuses by name, before any request, on a chain whose gas token is unknown', async () => {
    const g = await gateway(onPortfolio(portfolioWith('solana-devnet', 'SOL', '9')));
    try {
      const err = await client(g.url).execute.transfer({ ...TRANSFER, toChain: 'solana-devnet' })
        .catch((e: unknown) => e as CertenFundingUnverifiableError);
      expect(err).toBeInstanceOf(CertenFundingUnverifiableError);
      expect(err.reason).toBe('unknown-native');
      expect(err.chain).toBe('solana-devnet');
      expect(err.message).toMatch(/skipFundingCheck/);
      expect(g.seen).toHaveLength(0);
    } finally { g.close(); }
  });

  it('refuses by name when the gateway could not read the balance (was: "holds no gas", which was not known)', async () => {
    const g = await gateway(onPortfolio(portfolioWith('ethereum-sepolia', '', 'unavailable')));
    try {
      const err = await client(g.url).execute.transfer(TRANSFER).catch((e: unknown) => e as CertenFundingUnverifiableError);
      expect(err).toBeInstanceOf(CertenFundingUnverifiableError);
      expect(err.reason).toBe('unreadable');
      expect(err.isRetryable).toBe(true);
    } finally { g.close(); }
  });

  it('skipFundingCheck still bypasses it, deliberately', async () => {
    const g = await gateway(onPortfolio(portfolioWith('2017', 'TEL', '0')));
    try {
      expect((await client(g.url).execute.transfer({ ...TO_ADIRI, skipFundingCheck: true })).intentId).toBe('intent-1');
    } finally { g.close(); }
  });

  it('leaves the live chains as they were: ETH zero refused, ETH funded allowed, numeric id matched', async () => {
    for (const [chainId, toChain] of [['ethereum-sepolia', 'ethereum-sepolia'], ['84532', 'base-sepolia'], ['421614', 'arbitrum-sepolia']]) {
      const empty = await gateway(onPortfolio(portfolioWith(chainId, 'ETH', '0')));
      try {
        await expect(client(empty.url).execute.transfer({ ...TRANSFER, toChain })).rejects.toBeInstanceOf(CertenUnfundedAccountError);
      } finally { empty.close(); }
      const funded = await gateway(onPortfolio(portfolioWith(chainId, 'ETH', '1')));
      try {
        expect((await client(funded.url).execute.transfer({ ...TRANSFER, toChain })).intentId).toBe('intent-1');
      } finally { funded.close(); }
    }
  });
});
