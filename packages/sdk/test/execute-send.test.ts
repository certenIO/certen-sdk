/**
 * `execute.send`: a native transfer from an identity, with the ADI and the abstract account filled in from it.
 *
 * `transfer` wants both written out and omitting either produced a bodyless 502, so `send` looks them up. What is pinned here is the other half
 * of its job: everything it can refuse without a signature, it refuses BEFORE anything is opened or signed, and a refusal is never a guess
 * ("ETH" on a TEL chain is not sent as TEL; a mistyped recipient is not corrected).
 */
import { describe, it, expect } from 'vitest';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import { CertenClient, CertenError, CertenUnfundedAccountError } from '../src/index.js';
import { honestIntent } from './helpers/honest-gateway.js';

const PUBKEY = '11'.repeat(32);
const FROM = `0x${'ab'.repeat(20)}`;
const TO = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed'; // an EIP-55 vector: valid and mixed-case
const ADI = 'acc://seller-bot.acme';

interface Req { method: string; path: string; url: string; body?: any }

interface Options {
  /** What the identity read answers. */
  identity?: Record<string, unknown>;
  /** The balance of the abstract account on base-sepolia, whole units. Default funded. */
  balance?: string;
}

async function gateway(o: Options = {}) {
  const seen: Req[] = [];
  const identity = {
    id: 'id-1', adi_url: ADI, status: 'active', can_sign: true,
    chain_accounts: [{ chain_id: '84532', address: FROM, status: 'deployed' }, { chain_id: '2017', address: `0x${'cc'.repeat(20)}`, status: 'deployed' }],
    ...o.identity,
  };
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    const entry: Req = { method: req.method ?? 'GET', path: (req.url ?? '').split('?')[0]!, url: req.url ?? '', body: raw ? JSON.parse(raw) : undefined };
    seen.push(entry);
    const send = (status: number, body: unknown): void => void res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    if (entry.path === '/v1/identity/id-1' && entry.method === 'GET') return send(200, identity);
    if (entry.path === '/v1/portfolio') {
      return send(200, { identities: [{ chains: [{ chain_id: 'base-sepolia', address: FROM, balances: [{ token: 'ETH', balance: o.balance ?? '1' }] }] }] });
    }
    if (entry.path === '/v1/transaction' && entry.method === 'POST') {
      const out = await honestIntent(entry.body, { publicKey: entry.body.signer_public_key });
      return send(out.status, out.body);
    }
    send(200, { ok: true });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    seen, client: new CertenClient({ apiKey: 'ck_live_test', baseUrl: url, maxRetries: 0 }),
    opened: () => seen.filter((e) => e.path === '/v1/transaction' && e.method === 'POST'),
    submitted: () => seen.filter((e) => e.path.endsWith('/signature')),
    close: () => new Promise<void>((r) => { server.closeAllConnections?.(); server.close(() => r()); }),
  };
}

const SEND = {
  identityId: 'id-1', chain: 'base-sepolia', toAddress: TO, amount: '0.0001', publicKey: PUBKEY, sign: (h: string) => `signed:${h}`, skipFundingCheck: true,
};

async function refusal(p: Promise<unknown>): Promise<CertenError> {
  try { await p; } catch (e) { return e as CertenError; }
  throw new Error('expected send to be refused');
}

describe('execute.send: deriving what the identity already knows', () => {
  it('reads the identity ONCE, with no enrichments, and fills in the ADI and the abstract account on the chain', async () => {
    const g = await gateway();
    try {
      const sent = await g.client.execute.send(SEND);
      const reads = g.seen.filter((e) => e.path === '/v1/identity/id-1');
      expect(reads).toHaveLength(1);
      // `include=` (explicitly empty) is "none": the status and can_sign this needs are computed before any enrichment.
      expect(reads[0]!.url).toBe('/v1/identity/id-1?include=');
      expect(sent).toMatchObject({ intentId: 'intent-1', adiUrl: ADI, fromAddress: FROM, chain: 'base-sepolia' });
      const intent = g.opened()[0]!.body.intent;
      expect(intent).toMatchObject({
        adiUrl: ADI, fromChain: 'accumulate', toChain: 'base-sepolia', fromAddress: FROM, toAddress: TO, amount: '0.0001', initiatedBy: ADI,
      });
      expect(typeof intent.id).toBe('string');
      expect(typeof intent.timestamp).toBe('number');
      // The native transfer is not labelled with a token symbol: the chain's native token is what moves.
      expect(intent.tokenSymbol).toBeUndefined();
      expect(g.opened()[0]!.body.identity_id).toBe('id-1');
      expect(g.opened()[0]!.body.signer_public_key).toBe(PUBKEY);
    } finally { await g.close(); }
  });

  it('signs the hash the SDK rebuilt and checked, and posts it to the intent\'s submit_url', async () => {
    const g = await gateway();
    try {
      const sent = await g.client.execute.send(SEND);
      expect(g.submitted()).toHaveLength(1);
      expect(g.submitted()[0]!.path).toBe('/v1/transaction/intent-1/signature');
      expect(g.submitted()[0]!.body.signature).toBe(`signed:${sent.signing!.hashes.toSign}`);
      expect(g.submitted()[0]!.body.public_key).toBe(PUBKEY);
      expect(sent.signing!.legs[0]).toMatchObject({ chainId: 84532, target: TO, valueWei: '100000000000000' });
    } finally { await g.close(); }
  });

  it('makes no identity read at all when the caller names both, and still checks the signing data', async () => {
    const g = await gateway();
    try {
      await g.client.execute.send({ ...SEND, adiUrl: ADI, fromAddress: FROM });
      expect(g.seen.filter((e) => e.path === '/v1/identity/id-1')).toHaveLength(0);
      expect(g.opened()).toHaveLength(1);
    } finally { await g.close(); }
  });

  it('takes the account on the chain it was given, not the first account the identity has', async () => {
    const g = await gateway();
    try {
      const sent = await g.client.execute.send({ ...SEND, chain: 'telcoin-adiri', asset: 'TEL' });
      expect(sent.fromAddress).toBe(`0x${'cc'.repeat(20)}`);
      expect(sent.chain).toBe('telcoin-adiri');
      expect(g.opened()[0]!.body.intent.toChain).toBe('telcoin-adiri');
    } finally { await g.close(); }
  });

  it('accepts the native symbol in any case, and the numeric spelling of the chain', async () => {
    const g = await gateway();
    try {
      const sent = await g.client.execute.send({ ...SEND, chain: '84532', asset: 'eth' });
      expect(sent.chain).toBe('base-sepolia');
    } finally { await g.close(); }
  });

  it('accepts an all-lower-case recipient (no checksum to disagree with)', async () => {
    const g = await gateway();
    try {
      await g.client.execute.send({ ...SEND, toAddress: TO.toLowerCase() });
      expect(g.opened()[0]!.body.intent.toAddress).toBe(TO.toLowerCase());
    } finally { await g.close(); }
  });
});

describe('execute.send: everything it can refuse, it refuses before anything is opened', () => {
  const refusals: Array<[string, Partial<typeof SEND> & Record<string, unknown>, string, RegExp]> = [
    ['an address that is not one', { toAddress: '0x1234' }, 'INVALID_ADDRESS', /not an EVM address/],
    ['a recipient with no 0x', { toAddress: TO.slice(2) }, 'INVALID_ADDRESS', /not an EVM address/],
    ['a mixed-case address whose checksum fails', { toAddress: TO.replace('aAeb', 'AAeb') }, 'INVALID_ADDRESS', /checksum/],
    ['an asset that is not the chain\'s native token', { asset: 'USDC' }, 'UNSUPPORTED_ASSET', /base-sepolia moves ETH, not USDC/],
    ['ETH on a chain whose gas is TEL', { chain: 'telcoin-adiri', asset: 'ETH' }, 'UNSUPPORTED_ASSET', /telcoin-adiri moves TEL, not ETH/],
    ['an amount that is wei written into the whole-unit field', { amount: '100000000000000' }, 'INVALID_AMOUNT', /looks like wei/],
    ['an amount that is not a decimal', { amount: '1e15' }, 'INVALID_AMOUNT', /decimal string/],
    ['an amount of zero', { amount: '0' }, 'INVALID_AMOUNT', /greater than zero/],
    ['an amount of 0.000', { amount: '0.000' }, 'INVALID_AMOUNT', /greater than zero/],
    ['a chain the catalogue does not know', { chain: 'mystery-chain' }, 'UNSUPPORTED_CHAIN', /not a chain this client knows/],
  ];
  for (const [name, over, code, message] of refusals) {
    it(`refuses ${name}, with no request at all`, async () => {
      const g = await gateway();
      try {
        const err = await refusal(g.client.execute.send({ ...SEND, ...over } as never));
        expect(err).toBeInstanceOf(CertenError);
        expect(err.code).toBe(code);
        expect(err.message).toMatch(message);
        expect(err.status).toBe(0);
        // Not even the identity was read: a typo costs a message, not a round trip.
        expect(g.seen).toEqual([]);
      } finally { await g.close(); }
    });
  }

  it('the asset refusal says why a token cannot be sent this way', async () => {
    const g = await gateway();
    try {
      const err = await refusal(g.client.execute.send({ ...SEND, asset: 'USDC' }));
      expect(err.message).toMatch(/cannot be checked before signing/);
      expect(err.message).toMatch(/nothing is signed that cannot be checked/);
    } finally { await g.close(); }
  });

  it('refuses an identity that cannot sign, having read it once and opened nothing', async () => {
    const g = await gateway({ identity: { can_sign: false } });
    try {
      const err = await refusal(g.client.execute.send(SEND));
      expect(err.code).toBe('IDENTITY_CANNOT_SIGN');
      expect(err.message).toContain(ADI);
      expect(g.seen.filter((e) => e.path === '/v1/identity/id-1')).toHaveLength(1);
      expect(g.opened()).toEqual([]);
      expect(g.submitted()).toEqual([]);
    } finally { await g.close(); }
  });

  it('treats can_sign "unknown" (null) as not a refusal: that is the gateway failing to read the key page, not a no', async () => {
    const g = await gateway({ identity: { can_sign: null } });
    try {
      await g.client.execute.send(SEND);
      expect(g.opened()).toHaveLength(1);
    } finally { await g.close(); }
  });

  it('refuses an identity with no abstract account on the chain, naming the identity and the chain', async () => {
    const g = await gateway({ identity: { chain_accounts: [{ chain_id: '11155111', address: `0x${'dd'.repeat(20)}`, status: 'deployed' }] } });
    try {
      const err = await refusal(g.client.execute.send(SEND));
      expect(err.code).toBe('NO_ABSTRACT_ACCOUNT');
      expect(err.message).toContain(ADI);
      expect(err.message).toContain('base-sepolia');
      expect(g.opened()).toEqual([]);
    } finally { await g.close(); }
  });

  it('refuses an identity with no chain accounts at all, rather than reading a missing list as empty-handed success', async () => {
    const g = await gateway({ identity: { chain_accounts: undefined } });
    try {
      await expect(g.client.execute.send(SEND)).rejects.toMatchObject({ code: 'NO_ABSTRACT_ACCOUNT' });
    } finally { await g.close(); }
  });
});

describe('execute.send: the funding guard and the last word', () => {
  it('runs the funding guard by default and refuses an unfunded account before opening anything', async () => {
    const g = await gateway({ balance: '0' });
    try {
      const { skipFundingCheck: _skip, ...noSkip } = SEND;
      void _skip;
      await expect(g.client.execute.send(noSkip)).rejects.toBeInstanceOf(CertenUnfundedAccountError);
      expect(g.seen.some((e) => e.path === '/v1/portfolio')).toBe(true);
      expect(g.opened()).toEqual([]);
    } finally { await g.close(); }
  });

  it('honours skipFundingCheck: the portfolio is not read and the intent is opened (the caller ran the check itself)', async () => {
    const g = await gateway({ balance: '0' });
    try {
      await g.client.execute.send(SEND);
      expect(g.seen.some((e) => e.path === '/v1/portfolio')).toBe(false);
      expect(g.opened()).toHaveLength(1);
    } finally { await g.close(); }
  });

  it('calls beforeSign with what the signature authorises, and when it returns false nothing is signed or submitted', async () => {
    const g = await gateway();
    try {
      let shown = '';
      let signed = 0;
      const err = await refusal(g.client.execute.send({
        ...SEND,
        sign: () => { signed += 1; return 'sig'; },
        beforeSign: (summary) => { shown = summary.text.join('\n'); return false; },
      }));
      expect(err.code).toBe('SIGNING_DECLINED');
      expect(shown).toMatch(/You are about to sign/);
      expect(shown).toContain(TO);
      expect(signed).toBe(0);
      expect(g.submitted()).toEqual([]);
    } finally { await g.close(); }
  });

  it('a gateway that returns signing data for a DIFFERENT recipient is refused by the check and nothing is signed', async () => {
    const g = await gateway();
    try {
      let signed = 0;
      // The honest stand-in builds signing data from the request body it receives. This one rewrites the recipient first, so the signing
      // data is for someone other than the person the caller asked to pay: exactly what the check exists to catch.
      const server = http.createServer(async (req, res) => {
        let raw = '';
        for await (const c of req) raw += c;
        const body = raw ? JSON.parse(raw) : {};
        const send = (status: number, b: unknown): void => void res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(b));
        if (req.url === '/v1/identity/id-1?include=') return send(200, { id: 'id-1', adi_url: ADI, status: 'active', can_sign: true, chain_accounts: [{ chain_id: '84532', address: FROM }] });
        if (req.url === '/v1/transaction') {
          body.intent.toAddress = `0x${'66'.repeat(20)}`; // the gateway "changes the recipient"
          const out = await honestIntent(body, { publicKey: body.signer_public_key });
          return send(out.status, out.body);
        }
        send(200, {});
      });
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
      const client = new CertenClient({ apiKey: 'k', baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, maxRetries: 0 });
      try {
        const err = await refusal(client.execute.send({ ...SEND, sign: () => { signed += 1; return 'sig'; } }));
        expect(err.code).toBe('SIGNING_DATA_MISMATCH');
        expect(signed).toBe(0);
      } finally { await new Promise<void>((r) => { server.closeAllConnections?.(); server.close(() => r()); }); }
    } finally { await g.close(); }
  });

  it('threads the header fields through to the intent it opens (a deadline)', async () => {
    const g = await gateway();
    try {
      const expiresAt = new Date(Date.now() + 3600_000).toISOString();
      await g.client.execute.send({ ...SEND, expiresAt });
      expect(g.opened()[0]!.body.expires_at).toBe(expiresAt);
    } finally { await g.close(); }
  });
});
