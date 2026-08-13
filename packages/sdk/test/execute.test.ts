/**
 * The proof-gated execution flow.
 *
 * These helpers absorbed logic that had been hand-rolled twice — once in the CARP escrow adapter, once in
 * the example scripts — so the tests here encode the mistakes both versions could have made. Most of them
 * cost money or trust when they regress, which is why they are asserted rather than assumed.
 */
import { describe, it, expect } from 'vitest';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import { CertenClient } from '../src/index.js';

const HASH = 'ab'.repeat(32);
const PUBKEY = '11'.repeat(32);

/** A gateway stand-in that records requests and replies per a handler. */
async function gateway(handler: (e: Req, n: number) => { status?: number; body?: unknown }) {
  const seen: Req[] = [];
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    const entry: Req = {
      method: req.method ?? 'GET',
      path: (req.url ?? '').split('?')[0],
      headers: req.headers as Record<string, string>,
      body: raw ? JSON.parse(raw) : undefined,
    };
    seen.push(entry);
    const out = handler(entry, seen.length);
    res.writeHead(out.status ?? 200, { 'content-type': 'application/json' }).end(JSON.stringify(out.body ?? {}));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  return { seen, url: `http://127.0.0.1:${port}`, close: () => server.close() };
}
interface Req { method: string; path: string; headers: Record<string, string>; body?: any }

const opened = {
  status: 201,
  body: {
    intent_id: 'intent-1',
    signing_mode: 'external',
    signing_data: { hash_to_sign: HASH, transaction_hash: 'cd'.repeat(32) },
    submit_url: '/v1/transaction/intent-1/signature',
  },
};
const okFlow = (e: Req) => (e.path === '/v1/transaction' && e.method === 'POST' ? opened : { body: { ok: true } });

const clientFor = (url: string) => new CertenClient({ apiKey: 'ck_live_test', baseUrl: url, maxRetries: 0 });

/**
 * The request that OPENED the intent.
 *
 * Found by shape rather than by index: a value-moving call now reads the portfolio first, to refuse
 * an intent from an abstract account known to hold no gas. Indexing into `seen` assumed that check
 * did not exist, and would break again the next time anything is added ahead of the POST.
 */
const openReq = (g: { seen: Req[] }): Req =>
  g.seen.find((e) => e.path === '/v1/transaction' && e.method === 'POST')!;

/** The request that SUBMITTED the signature, found the same way and for the same reason. */
const submitReq = (g: { seen: Req[] }): Req =>
  g.seen.find((e) => e.path.endsWith('/signature') && e.method === 'POST')!;

const CALL = {
  identityId: 'id-1',
  adiUrl: 'acc://seller-bot.acme',
  fromAddress: '0xAbstract',
  chain: 'ethereum-sepolia',
  chainId: 11155111,
  publicKey: PUBKEY,
  sign: (h: string) => `signed:${h}`,
};

describe('execute.contractCall', () => {
  it('opens the intent, signs what came back, and posts it to submit_url', async () => {
    const g = await gateway(okFlow);
    try {
      const out = await clientFor(g.url).execute.contractCall({
        ...CALL,
        contractCall: { target: '0xESCROBOT', functionSignature: 'confirm(bytes32)', args: ['0xabc'] },
      });
      expect(out.intentId).toBe('intent-1');
      expect(out.accumTxHash).toBe('cd'.repeat(32));

      const [open, submit] = g.seen;
      expect(open.body.intent.legs[0].contractCall.functionSignature).toBe('confirm(bytes32)');
      expect(submit.path).toBe('/v1/transaction/intent-1/signature');
      expect(submit.body.signature).toBe(`signed:${HASH}`);
      expect(submit.body.public_key).toBe(PUBKEY);
    } finally { g.close(); }
  });

  /** A leg whose amount disagrees with the call's value sends the wrong wei — and the proof proves it. */
  it('keeps the leg amount and the call value identical on a payable call', async () => {
    const g = await gateway(okFlow);
    try {
      await clientFor(g.url).execute.contractCall({
        ...CALL,
        contractCall: { target: '0xE', functionSignature: 'buy(bytes32)', args: ['0xa'], value: '1500000000000000' },
      });
      const leg = openReq(g).body.intent.legs[0];
      expect(leg.amount).toBe('1500000000000000');
      expect(leg.contractCall.value).toBe('1500000000000000');
    } finally { g.close(); }
  });

  it('always sends an Idempotency-Key, generated when not supplied', async () => {
    const g = await gateway(okFlow);
    try {
      await clientFor(g.url).execute.contractCall({
        ...CALL, contractCall: { target: '0xE', functionSignature: 'x()' },
      });
      expect(openReq(g).headers['idempotency-key']).toMatch(/.+/);
    } finally { g.close(); }
  });

  it('honors a caller-supplied idempotency key', async () => {
    const g = await gateway(okFlow);
    try {
      await clientFor(g.url).execute.contractCall({
        ...CALL, idempotencyKey: 'mine-1', contractCall: { target: '0xE', functionSignature: 'x()' },
      });
      expect(openReq(g).headers['idempotency-key']).toBe('mine-1');
    } finally { g.close(); }
  });

  it('nominates a seat and a key page when given them', async () => {
    const g = await gateway(okFlow);
    try {
      await clientFor(g.url).execute.contractCall({
        ...CALL,
        signerPublicKey: '22'.repeat(32),
        signerKeyPage: 'acc://panel.acme/book/2',
        contractCall: { target: '0xE', functionSignature: 'x()' },
      });
      expect(openReq(g).body.signer_public_key).toBe('22'.repeat(32));
      expect(openReq(g).body.signer_key_page).toBe('acc://panel.acme/book/2');
      // The signature must come from the nominated seat, not the default key.
      expect(g.seen[1].body.public_key).toBe('22'.repeat(32));
    } finally { g.close(); }
  });

  /**
   * Provider mode means the gateway holds a key. This flow's premise is that it does not, so a reply with
   * no signing data must fail loudly — continuing would let the caller believe they authorized something
   * they never signed.
   */
  it('refuses a provider-mode response rather than reporting success', async () => {
    const g = await gateway(() => ({ status: 201, body: { intent_id: 'i-2', signing_mode: 'provider', tx_hash: '0xdead' } }));
    try {
      await expect(clientFor(g.url).execute.contractCall({
        ...CALL, contractCall: { target: '0xE', functionSignature: 'x()' },
      })).rejects.toThrow(/requires external mode/);
    } finally { g.close(); }
  });
});

describe('execute.transfer', () => {
  it('sends the simple intent shape and signs it', async () => {
    const g = await gateway(okFlow);
    try {
      await clientFor(g.url).execute.transfer({
        identityId: 'id-1', adiUrl: 'acc://org.acme', fromChain: 'accumulate', toChain: 'ethereum-sepolia',
        fromAddress: 'acc://org.acme', toAddress: '0xBe00', amount: '4000', tokenSymbol: 'ETH',
        publicKey: PUBKEY, sign: (h) => `signed:${h}`,
      });
      expect(openReq(g).body.intent).toMatchObject({ toAddress: '0xBe00', amount: '4000' });
      expect(submitReq(g).body.signature).toBe(`signed:${HASH}`);
    } finally { g.close(); }
  });

  it('keeps the amount a string so wei past 2^53 is not rounded', async () => {
    const g = await gateway(okFlow);
    try {
      const huge = '90071992547409910000';
      await clientFor(g.url).execute.transfer({
        identityId: 'id-1', adiUrl: 'acc://org.acme', fromChain: 'accumulate', toChain: 'eth', fromAddress: 'a', toAddress: 'b',
        amount: huge, publicKey: PUBKEY, sign: () => 'sig',
      });
      expect(openReq(g).body.intent.amount).toBe(huge);
    } finally { g.close(); }
  });

  it('sends intent.adiUrl — omitting it crashed the upstream native-transfer path', async () => {
    // Regression for certenIO/accumulate-api-bridge#1. That code reads `intent.adiUrl.replace(...)`
    // with no null check, so an intent without it threw a TypeError upstream and came back as a
    // bodyless 502 — indistinguishable from the gateway being down. A mock that accepts any body
    // cannot see this, which is why it was only caught against the live gateway.
    const g = await gateway(okFlow);
    try {
      await clientFor(g.url).execute.transfer({
        identityId: 'id-1', adiUrl: 'acc://seller.acme', fromChain: 'ethereum-sepolia',
        toChain: 'ethereum-sepolia', fromAddress: '0xA', toAddress: '0xB', amount: '1',
        publicKey: PUBKEY, sign: () => 'sig',
      });
      expect(openReq(g).body.intent.adiUrl).toBe('acc://seller.acme');
    } finally { g.close(); }
  });
});

describe('execute.cosign', () => {
  const signFlow = (e: Req) => e.path === '/v1/sign'
    ? { status: 201, body: { sign_request_id: 'sr-1', signing_data: { data_for_signature: HASH }, submit_url: '/v1/sign/sr-1/signature' } }
    : { body: { signature_count: 2, is_ready: true } };

  it('defaults the vote to "approve" — lowercase, not "accept", not a number', async () => {
    const g = await gateway(signFlow);
    try {
      const out = await clientFor(g.url).execute.cosign({
        accumTxHash: 'ef'.repeat(32), identity: 'acc://panel.acme',
        signerUrl: 'acc://panel.acme/book/1', publicKey: PUBKEY, sign: (h) => `signed:${h}`,
      });
      expect(g.seen[0].body.vote).toBe('approve');
      expect(g.seen[0].body.type).toBe('pending_tx');
      expect(submitReq(g).body.signature).toBe(`signed:${HASH}`);
      expect(out).toMatchObject({ is_ready: true });
    } finally { g.close(); }
  });

  it('passes an explicit reject through', async () => {
    const g = await gateway(signFlow);
    try {
      await clientFor(g.url).execute.cosign({
        accumTxHash: 'ef'.repeat(32), identity: 'acc://p.acme', signerUrl: 'acc://p.acme/book/1',
        publicKey: PUBKEY, sign: () => 'sig', vote: 'reject',
      });
      expect(g.seen[0].body.vote).toBe('reject');
    } finally { g.close(); }
  });

  it('fails clearly when no signing data comes back', async () => {
    const g = await gateway(() => ({ status: 201, body: { sign_request_id: 'sr-1' } }));
    try {
      await expect(clientFor(g.url).execute.cosign({
        accumTxHash: 'ef'.repeat(32), identity: 'a', signerUrl: 'b', publicKey: PUBKEY, sign: () => 's',
      })).rejects.toThrow(/no signing data/);
    } finally { g.close(); }
  });
});

describe('execute.wait', () => {
  it('resolves on a terminal success', async () => {
    const g = await gateway(() => ({ body: { status: 'completed', proof_id: 'p-1' } }));
    try {
      const out = await clientFor(g.url).execute.wait('i-1', { intervalMs: 1 });
      expect((out as { status: string }).status).toBe('completed');
    } finally { g.close(); }
  });

  it('throws with the gateway\'s reason on a terminal failure', async () => {
    const g = await gateway(() => ({ body: { status: 'failed', error_message: 'reverted' } }));
    try {
      await expect(clientFor(g.url).execute.wait('i-1', { intervalMs: 1 })).rejects.toThrow(/failed: reverted/);
    } finally { g.close(); }
  });

  /** A timeout is neither outcome — the intent may still complete. Say that distinctly. */
  it('reports a timeout as a timeout, not as either outcome', async () => {
    const g = await gateway(() => ({ body: { status: 'submitted' } }));
    try {
      await expect(clientFor(g.url).execute.wait('i-1', { timeoutMs: 30, intervalMs: 1 }))
        .rejects.toThrow(/still submitted after/);
    } finally { g.close(); }
  });

  it('reports progress through onPoll', async () => {
    let n = 0;
    const g = await gateway(() => (++n < 2 ? { body: { status: 'submitted' } } : { body: { status: 'completed' } }));
    try {
      const seen: string[] = [];
      await clientFor(g.url).execute.wait('i-1', {
        intervalMs: 1,
        onPoll: (tx) => seen.push((tx as unknown as { status: string }).status),
      });
      expect(seen).toEqual(['submitted', 'completed']);
    } finally { g.close(); }
  });
});

describe('execute.proof', () => {
  it('returns the Certen proof when the intent carries a proof_id', async () => {
    const g = await gateway((e) => e.path.startsWith('/v1/transaction')
      ? { body: { status: 'completed', proof_id: 'p-9' } }
      : { body: { artifact: 'yes' } });
    try {
      const out = await clientFor(g.url).execute.proof('i-1');
      expect(out.kind).toBe('certen-proof');
    } finally { g.close(); }
  });

  /** Governance and authorization transactions have no cross-chain proof_id but DO have a merkle receipt.
   *  Without this fallback a proof lookup returns empty and looks like a bug. */
  it('falls back to the Accumulate receipt when there is no proof_id', async () => {
    const g = await gateway((e) => e.path.startsWith('/v1/transaction')
      ? { body: { status: 'delivered', accum_tx_hash: 'cd'.repeat(32) } }
      : { body: { receipt: 'merkle' } });
    try {
      const out = await clientFor(g.url).execute.proof('i-1');
      expect(out.kind).toBe('accumulate-receipt');
      expect(g.seen.some((s) => s.path === `/v1/proof/tx/${'cd'.repeat(32)}/receipt`)).toBe(true);
    } finally { g.close(); }
  });

  it('says so plainly when there is neither', async () => {
    const g = await gateway(() => ({ body: { status: 'completed' } }));
    try {
      await expect(clientFor(g.url).execute.proof('i-1')).rejects.toThrow(/neither a proof_id nor/);
    } finally { g.close(); }
  });
});

describe('the key never reaches the SDK', () => {
  it('takes a signing function and nothing key-shaped', async () => {
    const g = await gateway(okFlow);
    try {
      let sawOnlyTheHash = true;
      await clientFor(g.url).execute.contractCall({
        ...CALL,
        sign: (h) => { if (h !== HASH) sawOnlyTheHash = false; return 'sig'; },
        contractCall: { target: '0xE', functionSignature: 'x()' },
      });
      expect(sawOnlyTheHash).toBe(true);
      // Nothing resembling a private key is ever put on the wire.
      const wire = JSON.stringify(g.seen);
      expect(wire).not.toContain('secretKey');
      expect(wire).not.toContain('privateKey');
    } finally { g.close(); }
  });
});
