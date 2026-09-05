/**
 * CertenAgent: the composition an autonomous agent needs, with the mistakes each hand-rolled
 * version made pinned as tests — the wrong ADI on a transfer, a token amount in whole units, a
 * governance op created but never signed, a share link minted before the proof exists.
 */
import { describe, it, expect } from 'vitest';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import { createPublicKey, verify } from 'node:crypto';
import { CertenClient, CertenAgent, ed25519Signer } from '../src/index.js';

interface Req { method: string; path: string; body?: any }
async function gateway(handler: (e: Req, n: number) => { status?: number; body?: unknown }) {
  const seen: Req[] = [];
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    const entry: Req = { method: req.method ?? 'GET', path: (req.url ?? '').split('?')[0], body: raw ? JSON.parse(raw) : undefined };
    seen.push(entry);
    const out = handler(entry, seen.length);
    res.writeHead(out.status ?? 200, { 'content-type': 'application/json' }).end(JSON.stringify(out.body ?? {}));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { seen, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => server.close() };
}
const clientFor = (url: string) => new CertenClient({ apiKey: 'ck_live_test', baseUrl: url, maxRetries: 0 });
const HASH = 'ab'.repeat(32);
const STATE = { identityId: 'id-1', adiUrl: 'acc://bot.acme', keyPageUrl: 'acc://bot.acme/book/1', accounts: { 'base-sepolia': '0xACC0' } };

describe('ed25519Signer', () => {
  it('derives the public key and its sha256 from a seed, and signs raw bytes verifiably', () => {
    const s = ed25519Signer('11'.repeat(32));
    expect(s.publicKey).toMatch(/^[0-9a-f]{64}$/);
    expect(s.publicKeyHash).toMatch(/^[0-9a-f]{64}$/);
    const sig = s.sign(HASH) as string;
    expect(sig).toMatch(/^[0-9a-f]{128}$/);
    const spki = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(s.publicKey, 'hex')]);
    const pub = createPublicKey({ key: spki, format: 'der', type: 'spki' });
    expect(verify(null, Buffer.from(HASH, 'hex'), pub, Buffer.from(sig, 'hex'))).toBe(true);
    expect(ed25519Signer('11'.repeat(32)).publicKey).toBe(s.publicKey);
  });
  it('generates a fresh key and hands back the seed to persist', () => {
    const a = ed25519Signer();
    expect(a.seedHex).toMatch(/^[0-9a-f]{64}$/);
    expect(ed25519Signer(a.seedHex).publicKey).toBe(a.publicKey);
  });
});

describe('CertenAgent', () => {
  const signer = ed25519Signer('22'.repeat(32));

  it('provisions an identity bound to its key and waits for every requested account', async () => {
    let polls = 0;
    const g = await gateway((e) => {
      if (e.path === '/v1/identity' && e.method === 'POST') return { status: 201, body: { id: 'id-9', adi_url: 'acc://bot9.acme', key_page_url: 'acc://bot9.acme/book/1', status: 'creating', chain_accounts: [] } };
      if (e.path === '/v1/identity/id-9') {
        polls++;
        return { body: { id: 'id-9', adi_url: 'acc://bot9.acme', key_page_url: 'acc://bot9.acme/book/1', status: 'active', can_sign: true,
          chain_accounts: polls < 2 ? [] : [{ chain_id: 'base-sepolia', address: '0xB' }, { chain_id: 'arbitrum-sepolia', address: '0xA' }] } };
      }
      return { body: {} };
    });
    try {
      const agent = new CertenAgent(clientFor(g.url), signer);
      const state = await agent.provision({ name: 'bot9', chains: ['base-sepolia', 'arbitrum-sepolia'], timeoutMs: 60_000, pollIntervalMs: 50 });
      const create = g.seen.find((e) => e.path === '/v1/identity' && e.method === 'POST')!;
      expect(create.body).toMatchObject({ name: 'bot9', public_key: signer.publicKey, public_key_hash: signer.publicKeyHash, chains: ['base-sepolia', 'arbitrum-sepolia'] });
      expect(state.accounts).toEqual({ 'base-sepolia': '0xB', 'arbitrum-sepolia': '0xA' });
      expect(agent.account('base-sepolia')).toBe('0xB');
    } finally { g.close(); }
  }, 30_000);

  it('links a second chain with one PATCH and no new identity', async () => {
    const g = await gateway((e) => {
      if (e.method === 'PATCH') return { body: { id: 'id-1', adi_url: 'acc://bot.acme', chain_accounts: [{ chain_id: 'base-sepolia', address: '0xACC0' }, { chain_id: 'arbitrum-sepolia', address: '0xARB' }] } };
      return { body: {} };
    });
    try {
      const agent = new CertenAgent(clientFor(g.url), signer, { ...STATE, accounts: { ...STATE.accounts } });
      expect(await agent.linkChain('arbitrum-sepolia')).toBe('0xARB');
      const patch = g.seen.find((e) => e.method === 'PATCH')!;
      expect(patch.path).toBe('/v1/identity/id-1');
      expect(patch.body).toMatchObject({ link_chains: ['arbitrum-sepolia'] });
      expect(g.seen.filter((e) => e.path === '/v1/identity' && e.method === 'POST')).toHaveLength(0);
    } finally { g.close(); }
  });

  it('refuses to act on a chain it has no account on, before any request', async () => {
    const g = await gateway(() => ({ body: {} }));
    try {
      const agent = new CertenAgent(clientFor(g.url), signer, STATE);
      await expect(agent.transfer({ chain: 'ethereum-sepolia', to: '0xB', amount: '0.001' })).rejects.toThrow(/no account on ethereum-sepolia/);
      expect(g.seen).toHaveLength(0);
    } finally { g.close(); }
  });

  const opened = { status: 201, body: { intent_id: 'intent-1', signing_mode: 'external', signing_data: { hash_to_sign: HASH }, submit_url: '/v1/transaction/intent-1/signature' } };

  it('transfers from its own account with its ADI on the intent, and signs', async () => {
    const g = await gateway((e) => (e.path === '/v1/transaction' && e.method === 'POST' ? opened : { body: { ok: true } }));
    try {
      const agent = new CertenAgent(clientFor(g.url), signer, STATE);
      await agent.transfer({ chain: 'base-sepolia', to: '0xBEEF', amount: '0.001', skipFundingCheck: true });
      const open = g.seen.find((e) => e.path === '/v1/transaction' && e.method === 'POST')!;
      expect(open.body.intent).toMatchObject({ adiUrl: 'acc://bot.acme', fromAddress: '0xACC0', toAddress: '0xBEEF', amount: '0.001', fromChain: 'base-sepolia' });
      const sig = g.seen.find((e) => e.path === '/v1/transaction/intent-1/signature')!;
      expect(sig.body.signature).toMatch(/^[0-9a-f]{128}$/);
      expect(sig.body.public_key).toBe(signer.publicKey);
    } finally { g.close(); }
  });

  it('moves a token as a proof-gated transfer(to, amount) on the token contract, gated on the Transfer event', async () => {
    const g = await gateway((e) => (e.path === '/v1/transaction' && e.method === 'POST' ? opened : { body: { ok: true } }));
    try {
      const agent = new CertenAgent(clientFor(g.url), signer, STATE);
      await agent.token({ chain: 'base-sepolia', token: '0xUSDC', to: '0xBEEF', amount: '1000000', skipFundingCheck: true });
      const open = g.seen.find((e) => e.path === '/v1/transaction' && e.method === 'POST')!;
      const leg = open.body.intent.legs[0];
      expect(leg.contractCall).toMatchObject({ target: '0xUSDC', functionSignature: 'transfer(address,uint256)', args: ['0xBEEF', '1000000'], value: '0' });
      expect(leg.contractCall.expectedEvents[0].topic0).toBe('0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef');
      await expect(agent.token({ chain: 'base-sepolia', token: '0xUSDC', to: '0xBEEF', amount: '1.5' })).rejects.toThrow(/base units/);
    } finally { g.close(); }
  });

  it('names a policy signer as a required authority, and signs the governance op it created', async () => {
    const g = await gateway((e) => {
      if (e.path === '/v1/governance' && e.method === 'POST') return { status: 201, body: { governance_op_id: 'gov-1', status: 'pending_signature', signing_data: { hash_to_sign: HASH } } };
      return { body: { ok: true } };
    });
    try {
      const agent = new CertenAgent(clientFor(g.url), signer, STATE);
      await agent.governance.requireSigner('acc://owner-policy.acme/book');
      const create = g.seen.find((e) => e.path === '/v1/governance' && e.method === 'POST')!;
      expect(create.body).toMatchObject({ identity: 'acc://bot.acme', operations: [{ type: 'add_authority', authority_url: 'acc://owner-policy.acme/book' }], signer_public_key: signer.publicKey });
      const sig = g.seen.find((e) => e.path === '/v1/governance/gov-1/signature')!;
      expect(sig.body.public_key).toBe(signer.publicKey);
      expect(sig.body.signature).toMatch(/^[0-9a-f]{128}$/);
    } finally { g.close(); }
  });

  it('requireSigner({ account: "book" }) names the authority on the key book, so key-page changes face it too', async () => {
    const g = await gateway((e) => {
      if (e.path === '/v1/governance' && e.method === 'POST') return { status: 201, body: { governance_op_id: 'gov-2', status: 'pending_signature', signing_data: { hash_to_sign: HASH } } };
      return { body: { ok: true } };
    });
    try {
      const agent = new CertenAgent(clientFor(g.url), signer, STATE);
      await agent.governance.requireSigner('acc://owner-policy.acme/book', { account: 'book' });
      await agent.governance.releaseSigner('acc://owner-policy.acme/book', { account: 'acc://bot.acme/vault' });
      const ops = g.seen.filter((e) => e.path === '/v1/governance' && e.method === 'POST').map((e) => e.body.operations[0]);
      expect(ops[0]).toEqual({ type: 'add_authority', authority_url: 'acc://owner-policy.acme/book', account_url: 'acc://bot.acme/book' });
      expect(ops[1]).toEqual({ type: 'remove_authority', authority_url: 'acc://owner-policy.acme/book', account_url: 'acc://bot.acme/vault' });
    } finally { g.close(); }
  });

  it('adds a seat and sets a threshold through the same signed path', async () => {
    const g = await gateway((e) => (e.path === '/v1/governance' && e.method === 'POST'
      ? { status: 201, body: { governance_op_id: 'gov-2', status: 'pending_signature', signing_data: { hash_to_sign: HASH } } } : { body: {} }));
    try {
      const agent = new CertenAgent(clientFor(g.url), signer, STATE);
      await agent.governance.addSeat('cc'.repeat(32));
      await agent.governance.setThreshold(2);
      const ops = g.seen.filter((e) => e.path === '/v1/governance' && e.method === 'POST').map((e) => e.body.operations[0]);
      expect(ops).toEqual([{ type: 'add_key', public_key_hash: 'cc'.repeat(32) }, { type: 'set_threshold', threshold: 2 }]);
      expect(g.seen.filter((e) => e.path === '/v1/governance/gov-2/signature')).toHaveLength(2);
    } finally { g.close(); }
  });

  it('will not mint a share link before the proof artifact exists', async () => {
    const g = await gateway((e) => {
      if (e.path === '/v1/transaction/intent-1') return { body: { intent_id: 'intent-1', status: 'completed', accum_tx_hash: 'acc://' + 'ee'.repeat(32) + '@bot.acme/data' } };
      if (e.path.endsWith('/receipt')) return { body: { anchored: true } };
      return { body: {} };
    });
    try {
      const agent = new CertenAgent(clientFor(g.url), signer, STATE);
      await expect(agent.share('intent-1')).rejects.toThrow(/no proof artifact yet/);
      expect(g.seen.filter((e) => e.path.endsWith('/share'))).toHaveLength(0);
    } finally { g.close(); }
  });
});
