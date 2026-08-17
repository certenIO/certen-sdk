import { describe, it, expect } from 'vitest';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import { CertenClient, parseMnemonicTarget, CertenError } from '../src/index.js';

/**
 * Collecting a provider-mode mnemonic.
 *
 * This endpoint had no SDK method at all, which made it the most dangerous gap on the surface: the
 * mnemonic is never returned inline, the retrieval token is consumed atomically on first read, and
 * it expires in about ten minutes. A caller who could not issue this request lost the seed for good
 * — on the one signing mode where CERTEN generates the key material rather than the customer.
 *
 * What is asserted here is mostly about NOT doing things twice. A retry is not a neutral act on a
 * one-shot endpoint: the first attempt already spent the token, so a second attempt cannot recover
 * anything and only obscures what happened.
 */

interface Req { method: string; path: string }

async function gateway(handler: (e: Req, n: number) => { status?: number; body?: unknown }) {
  const seen: Req[] = [];
  const server = http.createServer(async (req, res) => {
    for await (const _ of req) { /* drain */ }
    const entry: Req = { method: req.method ?? 'GET', path: (req.url ?? '').split('?')[0] };
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

const ID = '11111111-2222-3333-4444-555555555555';
const TOKEN = 'abcdefghijklmnopqrstuvwxyz012345';
const PHRASE = 'legal winner thank year wave sausage worth useful legal winner thank yellow';

describe('parseMnemonicTarget', () => {
  it('splits the path the create response actually hands back', () => {
    // `mnemonic_retrieval.url` is a path. A method that only took `(id, token)` would make every
    // caller split this themselves, on a string they cannot afford to get wrong.
    expect(parseMnemonicTarget(`/v1/identity/${ID}/mnemonic/${TOKEN}`))
      .toEqual({ id: ID, token: TOKEN });
  });

  it('accepts an absolute URL, in case the gateway ever returns one', () => {
    expect(parseMnemonicTarget(`https://api.certen.io/v1/identity/${ID}/mnemonic/${TOKEN}?x=1`))
      .toEqual({ id: ID, token: TOKEN });
  });

  it('takes an explicit id and token unchanged', () => {
    expect(parseMnemonicTarget(ID, TOKEN)).toEqual({ id: ID, token: TOKEN });
  });

  it('refuses anything that is not a retrieval URL', () => {
    // Guessing here would mean issuing a request that spends a one-shot token against a
    // half-parsed target. Failing before the request is the only safe answer.
    expect(() => parseMnemonicTarget('https://example.com/nope')).toThrow(CertenError);
    expect(() => parseMnemonicTarget('just-an-id')).toThrow(/not a mnemonic retrieval URL/);
  });
});

describe('identity.retrieveMnemonic', () => {
  it('issues exactly one GET to the retrieval path', async () => {
    const g = await gateway(() => ({ status: 200, body: { mnemonic: PHRASE, warning: 'Save it.' } }));
    try {
      const out = await client(g.url).identity.retrieveMnemonic(`/v1/identity/${ID}/mnemonic/${TOKEN}`);
      expect(out.mnemonic).toBe(PHRASE);
      expect(g.seen).toEqual([{ method: 'GET', path: `/v1/identity/${ID}/mnemonic/${TOKEN}` }]);
    } finally { g.close(); }
  });

  it('does not retry a consumed token', async () => {
    const g = await gateway(() => ({
      status: 404,
      body: { error: 'Not Found', code: 'NOT_FOUND', message: 'Retrieval token not found, already used, or expired' },
    }));
    try {
      await expect(client(g.url).identity.retrieveMnemonic(ID, TOKEN)).rejects.toThrow(CertenError);
      // A 404 here is terminal by construction — the token is gone. Retrying would spend requests
      // to re-learn the same fact, and on a flakier failure would consume a token that had worked.
      expect(g.seen).toHaveLength(1);
    } finally { g.close(); }
  });

  it('makes no request at all when the target cannot be parsed', async () => {
    const g = await gateway(() => ({ status: 200, body: { mnemonic: PHRASE } }));
    try {
      await expect(client(g.url).identity.retrieveMnemonic('nonsense')).rejects.toThrow(CertenError);
      expect(g.seen).toHaveLength(0);
    } finally { g.close(); }
  });
});

describe('createAndWait carries the retrieval URL', () => {
  it('does not drop mnemonic_retrieval on the way through', async () => {
    const created = {
      id: ID, adi_url: 'acc://x', book_url: null, key_page_url: null,
      status: 'provisioning', credit_balance: 0, chain_accounts: [], created_at: 'now',
      mnemonic_retrieval: { url: `/v1/identity/${ID}/mnemonic/${TOKEN}`, expires_in: 600 },
      polling: {
        first_poll_after_seconds: 0, interval_seconds: 0,
        estimated_ready_in_seconds: 0, terminal_states: ['active'],
      },
    };
    const ready = {
      id: ID, adi_url: 'acc://x', book_url: null, key_page_url: null,
      status: 'active', can_sign: true, credit_balance: 0, chain_accounts: [], created_at: 'now',
    };

    const g = await gateway((e) => (e.method === 'POST'
      ? { status: 202, body: created }
      : { status: 200, body: ready }));

    try {
      const out = await client(g.url).identity.createAndWait(
        { name: 'ops', signingMode: 'provider' } as never,
        { timeoutMs: 5_000 },
      );
      // The URL only ever appears on the create response, and this method used to throw that
      // response away — so provider mode through `createAndWait` lost the seed silently. It is a
      // safety net rather than the recommended path: the token expires in ~10 minutes and this
      // call may wait five.
      expect(out.mnemonic_retrieval?.url).toBe(`/v1/identity/${ID}/mnemonic/${TOKEN}`);
      expect(out.status).toBe('active');
    } finally { g.close(); }
  });
});
